import { createHash } from "node:crypto";
import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientMetadataError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { accessProfilesFor, type AccessProfile, type Configuration } from "./config.js";
import { Storage } from "./storage.js";
import { BrowserAuthorization } from "./auth/browser.js";
import {
  checkResource,
  equal,
  redirectIdentity,
  scopes,
  validateClient,
} from "./auth/policy.js";

export class GoogleTasksOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(
    readonly store: Storage,
    readonly c: Configuration,
    readonly browser: BrowserAuthorization,
    readonly profile: AccessProfile = accessProfilesFor(c)[0],
  ) {
    this.clientsStore = {
      getClient: (id) => store.getClient(id),
      registerClient: (metadata) => {
        const client = metadata as OAuthClientInformationFull;
        validateClient(client);
        if (client.client_secret)
          client.client_secret_expires_at =
            Math.floor(browser.now() / 1000) + 90 * 86400;
        try {
          store.saveClient(client);
        } catch {
          throw new InvalidClientMetadataError(
            "Client registration capacity or storage unavailable",
          );
        }
        return client;
      },
    };
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    await this.browser.authorize(client, params, res, this.profile);
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
  ): Promise<string> {
    const code = this.browser.code(value);
    if (!code || code.clientId !== client.client_id ||
      code.resource !== this.profile.resource || code.issuer !== this.profile.issuer)
      throw new InvalidGrantError("Invalid or expired code");
    return code.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
    verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.browser.code(value);
    this.browser.codes.delete(value);
    checkResource(resource, this.profile.resource);
    if (
      !code ||
      code.resource !== this.profile.resource ||
      code.issuer !== this.profile.issuer ||
      code.clientId !== client.client_id ||
      redirect !== code.redirect ||
      !verifier ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !equal(
        createHash("sha256").update(verifier).digest("base64url"),
        code.challenge,
      )
    )
      throw new InvalidGrantError("Invalid authorization code or callback");
    try {
      return this.store.issueGrant(
        client.client_id,
        redirectIdentity(code.redirect),
        this.profile.resource,
        code.revision,
      );
    } catch {
      throw new InvalidGrantError("Authorization no longer valid");
    }
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    value: string,
    requestedScopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    scopes(requestedScopes, false);
    checkResource(resource, this.profile.resource);
    const result = this.store.rotate(
      value,
      client.client_id,
      this.profile.resource,
    );
    if (!result)
      throw new InvalidGrantError(
        "Invalid refresh token; reconnect to authorize",
      );
    return result;
  }
  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const entry = this.store.accessToken(value, this.profile.resource);
    if (!entry) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token: value,
      clientId: entry.grant.clientId,
      scopes: entry.grant.scopes,
      expiresAt: entry.expiresAt,
      resource: new URL(this.profile.resource),
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.store.revokeToken(request.token, client.client_id, this.profile.resource);
  }
}
