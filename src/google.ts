import { google, Auth } from 'googleapis';
import { config, GOOGLE_TASKS_SCOPE } from './config.js';

type Credentials = Auth.Credentials;
type OAuth2Client = Auth.OAuth2Client;
import { storage } from './storage.js';

export function newGoogleOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    `${config.baseUrl}/oauth/google/callback`
  );
}

export function googleAuthUrl(state: string): string {
  // prompt=consent guarantees a refresh_token is issued even on re-consent.
  return newGoogleOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GOOGLE_TASKS_SCOPE],
    state,
  });
}

export async function exchangeGoogleCode(code: string): Promise<Credentials> {
  const { tokens } = await newGoogleOAuthClient().getToken(code);
  return tokens;
}

let cachedClient: OAuth2Client | null = null;

/**
 * OAuth2 client loaded with the stored Google tokens. google-auth-library
 * refreshes the access token automatically; refreshed tokens are persisted
 * via the 'tokens' event.
 */
export function getAuthorizedGoogleClient(): OAuth2Client {
  const tokens = storage.readGoogleTokens();
  if (!tokens || (!tokens.refresh_token && !tokens.access_token)) {
    throw new Error('No Google account connected. Reconnect the MCP server to sign in.');
  }
  if (!cachedClient) {
    cachedClient = newGoogleOAuthClient();
    cachedClient.on('tokens', t => storage.mergeGoogleTokens(t));
    cachedClient.setCredentials(tokens);
  }
  return cachedClient;
}

/** Drop the cached client, e.g. after tokens were cleared or replaced. */
export function resetGoogleClient(): void {
  cachedClient = null;
}

/**
 * True if we hold a refresh token that still works. Used to skip the Google
 * consent screen entirely when a new MCP client connects to an already
 * authorized server.
 */
export async function hasWorkingGoogleAuth(): Promise<boolean> {
  const tokens = storage.readGoogleTokens();
  if (!tokens?.refresh_token) return false;
  try {
    await getAuthorizedGoogleClient().getAccessToken();
    return true;
  } catch {
    return false;
  }
}
