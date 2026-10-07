import { google, type Auth } from "googleapis";
import { config, type Configuration } from "./config.js";
import { storage, Storage } from "./storage.js";

let clients = new WeakMap<
  Storage,
  { client: Auth.OAuth2Client; generation: number; revision: number }
>();
export function getAuthorizedGoogleClient(
  store: Storage = storage,
  c: Configuration = config,
): Auth.OAuth2Client {
  const s = store.snapshot();
  let cached = clients.get(store);
  if (!s.account || s.account.sub !== s.owner)
    throw new Error("No Google account connected");
  const revision = s.account.revision;
  if (
    !cached ||
    cached.generation !== s.generation ||
    cached.revision !== revision
  ) {
    const client = new google.auth.OAuth2(
      c.googleClientId,
      c.googleClientSecret,
      `${c.baseUrl}/oauth/google/callback`,
    );
    client.setCredentials(s.account.credentials as Auth.Credentials);
    client.on("tokens", (t) =>
      store.mergeGoogleTokens(t, s.generation, revision),
    );
    cached = { client, generation: s.generation, revision };
    clients.set(store, cached);
  }
  return cached.client;
}
export function resetGoogleClient(store: Storage = storage): void {
  clients.delete(store);
}

export function isGoogleAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 401 || /invalid_grant|invalid_credentials|No Google account connected/i.test(message);
}

export function invalidateGoogleAuthorization(
  store: Storage,
  expected: { generation: number; revision: number },
): void {
  store.clearGoogleTokens(expected);
  resetGoogleClient(store);
}
