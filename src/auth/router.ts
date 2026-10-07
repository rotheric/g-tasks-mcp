import express from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { MCP_SCOPE } from "../config.js";
import type { GoogleTasksOAuthProvider } from "../provider.js";
import { redirectMatches } from "./policy.js";

/** Metadata uses configured profiles; only browser authorization uses the Mac origin. */
export function oauthRouter(
  provider: GoogleTasksOAuthProvider,
  browserOrigin: string,
): express.Router {
  const router = express.Router(), profile = provider.profile;
  router.use("/.well-known/oauth-authorization-server", metadataHandler({
    issuer: profile.issuer,
    authorization_endpoint: new URL(profile.authorizationPath, browserOrigin).href,
    token_endpoint: new URL("/token", profile.origin).href,
    registration_endpoint: new URL("/register", profile.origin).href,
    revocation_endpoint: new URL("/revoke", profile.origin).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_SCOPE],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
  }));
  router.use("/.well-known/oauth-protected-resource/mcp", metadataHandler({
    resource: profile.resource,
    authorization_servers: [profile.issuer],
    scopes_supported: [MCP_SCOPE],
    resource_name: "Google Tasks",
  }));
  // Use SDK handlers directly so the opt-in local HTTP VM profile does not
  // require a process-wide insecure-issuer override for the SDK metadata router.
  router.use("/token", tokenHandler({ provider }));
  router.use("/register", clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  router.use("/revoke", revocationHandler({ provider }));
  return router;
}

export function browserAuthorizationRouter(
  provider: GoogleTasksOAuthProvider,
): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const input = req.method === "POST" ? req.body : req.query;
    const client = typeof input.client_id === "string"
      ? provider.store.getClient(input.client_id) : undefined;
    if (client && typeof input.redirect_uri === "string" &&
      !client.redirect_uris.some((uri) => redirectMatches(input.redirect_uri, uri))) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const redirect = res.redirect.bind(res);
    res.redirect = ((a: number | string, b?: string) => {
      const target = typeof a === "string" ? a : b!;
      if (client && /^https?:\/\//.test(target)) {
        const u = new URL(target);
        const callback = new URL(typeof input.redirect_uri === "string"
          ? input.redirect_uri : client.redirect_uris[0]);
        // Add the fixed profile issuer to SDK error callbacks, never Google URLs.
        if (u.searchParams.has("error") && u.origin === callback.origin &&
          u.pathname === callback.pathname) {
          u.searchParams.set("iss", provider.profile.issuer);
          if (typeof input.state === "string") u.searchParams.set("state", input.state);
          return redirect(typeof a === "number" ? a : 302, u.href);
        }
      }
      return redirect(typeof a === "number" ? a : 302, target);
    }) as typeof res.redirect;
    next();
  });
  router.use(authorizationHandler({ provider }));
  return router;
}
