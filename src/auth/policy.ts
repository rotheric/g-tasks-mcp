import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  InvalidRequestError,
  InvalidScopeError,
  InvalidClientMetadataError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { MCP_SCOPE } from "../config.js";

export const randomToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function validRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      value.length <= 2048 &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export function redirectIdentity(value: string): string {
  const u = new URL(value);
  if (u.protocol === "http:" && u.hostname === "127.0.0.1") u.port = "";
  return u.href;
}
export function redirectMatches(
  requested: string,
  registered: string,
): boolean {
  if (!validRedirect(requested) || !validRedirect(registered)) return false;
  if (requested === registered) return true;
  const a = new URL(requested);
  const b = new URL(registered);
  return (
    a.protocol === "http:" &&
    a.hostname === "127.0.0.1" &&
    b.protocol === "http:" &&
    b.hostname === a.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}
export function validateClient(client: OAuthClientInformationFull): void {
  if (
    !client.redirect_uris.length ||
    client.redirect_uris.length > 8 ||
    !client.redirect_uris.every(validRedirect)
  )
    throw new InvalidClientMetadataError(
      "Use HTTPS or supported loopback callbacks without fragments or credentials",
    );
  if (
    !["none", "client_secret_post"].includes(
      client.token_endpoint_auth_method ?? "",
    )
  )
    throw new InvalidClientMetadataError(
      "Explicit token_endpoint_auth_method must be none or client_secret_post",
    );
  if (
    (client.client_name?.length ?? 0) > 120 ||
    JSON.stringify(client).length > 8192
  )
    throw new InvalidClientMetadataError("Client metadata too large");
}
export function scopes(requested?: string[], defaultOmitted = true): string[] {
  if (!requested || (requested.length === 0 && defaultOmitted))
    return [MCP_SCOPE];
  if (requested.length !== 1 || requested[0] !== MCP_SCOPE)
    throw new InvalidScopeError("Only tasks scope is supported");
  return [MCP_SCOPE];
}
export function checkResource(
  requested: URL | undefined,
  canonical: string,
): void {
  if (requested && requested.href !== canonical)
    throw new InvalidRequestError("Unsupported MCP resource");
}
