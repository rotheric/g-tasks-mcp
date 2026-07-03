import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { exchangeGoogleCode, googleAuthUrl, hasWorkingGoogleAuth, resetGoogleClient } from './google.js';
import { storage } from './storage.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; clients refresh silently
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuthorization {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedAuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * OAuth authorization server for MCP clients, with Google as the upstream
 * identity provider. MCP clients register dynamically and complete a
 * standard PKCE flow against this server; behind the scenes the user is sent
 * through Google consent exactly once, after which new client connections
 * are authorized instantly from the stored refresh token.
 */
export class GoogleTasksOAuthProvider implements OAuthServerProvider {
  private readonly pendingAuths = new Map<string, PendingAuthorization>();
  private readonly authCodes = new Map<string, IssuedAuthCode>();

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => storage.getClient(clientId),
    registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
      // The SDK's registration handler has already generated client_id.
      const info = client as OAuthClientInformationFull;
      storage.saveClient(info);
      return info;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prunePending();
    const pendingId = token();
    this.pendingAuths.set(pendingId, { clientId: client.client_id, params, createdAt: Date.now() });

    if (await hasWorkingGoogleAuth()) {
      // Google account already connected — authorize instantly, no consent screen.
      res.redirect(this.completePendingAuth(pendingId));
      return;
    }
    res.redirect(googleAuthUrl(pendingId));
  }

  /** GET /oauth/google/callback — Google redirects here after consent. */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const pending = state ? this.pendingAuths.get(state) : undefined;

    if (!pending) {
      res.status(400).send('Unknown or expired authorization request. Please reconnect from your MCP client.');
      return;
    }

    if (!code) {
      // User denied consent (or Google returned an error) — relay to the client.
      this.pendingAuths.delete(state!);
      const url = new URL(pending.params.redirectUri);
      url.searchParams.set('error', typeof req.query.error === 'string' ? req.query.error : 'access_denied');
      if (pending.params.state) url.searchParams.set('state', pending.params.state);
      res.redirect(url.toString());
      return;
    }

    try {
      const tokens = await exchangeGoogleCode(code);
      storage.mergeGoogleTokens(tokens);
      resetGoogleClient();
    } catch (err) {
      res
        .status(502)
        .send(`Failed to exchange the Google authorization code: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    res.redirect(this.completePendingAuth(state!));
  }

  /** Issue our own authorization code and build the client redirect URL. */
  private completePendingAuth(pendingId: string): string {
    const pending = this.pendingAuths.get(pendingId);
    if (!pending) throw new Error('Pending authorization not found');
    this.pendingAuths.delete(pendingId);

    const code = token();
    this.authCodes.set(code, {
      clientId: pending.clientId,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: pending.params.scopes ?? [],
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('code', code);
    if (pending.params.state) url.searchParams.set('state', pending.params.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.authCodes.delete(authorizationCode);

    const accessToken = token();
    const refreshToken = token();
    storage.saveSession(accessToken, refreshToken, client.client_id, entry.scopes, ACCESS_TOKEN_TTL_SECONDS);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: entry.scopes.join(' ') || undefined,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const entry = storage.getRefreshToken(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const grantedScopes = scopes?.length ? scopes : entry.scopes;
    const accessToken = token();
    storage.addAccessToken(accessToken, client.client_id, grantedScopes, ACCESS_TOKEN_TTL_SECONDS);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grantedScopes.join(' ') || undefined,
    };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const entry = storage.getAccessToken(accessToken);
    if (!entry || entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    if (!storage.readGoogleTokens()) {
      // Google connection was severed (revoked/cleared) — force a full re-auth.
      throw new InvalidTokenError('Google account is no longer connected');
    }
    return {
      token: accessToken,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    storage.revokeToken(request.token);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingAuths) {
      if (now - pending.createdAt > PENDING_TTL_MS) this.pendingAuths.delete(id);
    }
    for (const [code, entry] of this.authCodes) {
      if (entry.expiresAt < now) this.authCodes.delete(code);
    }
  }
}
