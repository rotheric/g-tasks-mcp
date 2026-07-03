import fs from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Auth } from 'googleapis';
import { config } from './config.js';

type Credentials = Auth.Credentials;

interface AccessTokenEntry {
  clientId: string;
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
}

interface RefreshTokenEntry {
  clientId: string;
  scopes: string[];
}

interface SessionData {
  accessTokens: Record<string, AccessTokenEntry>;
  refreshTokens: Record<string, RefreshTokenEntry>;
}

class JsonFile<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T
  ) {}

  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as T;
    } catch {
      return this.fallback();
    }
  }

  write(value: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  delete(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}

/**
 * File-backed persistence under DATA_DIR (default ~/.g-tasks-mcp).
 * Single-user by design: one Google account's tokens shared by all MCP sessions.
 */
class Storage {
  private readonly clientsFile = new JsonFile<Record<string, OAuthClientInformationFull>>(
    path.join(config.dataDir, 'clients.json'),
    () => ({})
  );
  private readonly sessionsFile = new JsonFile<SessionData>(path.join(config.dataDir, 'sessions.json'), () => ({
    accessTokens: {},
    refreshTokens: {},
  }));
  private readonly googleTokensFile = new JsonFile<Credentials | null>(
    path.join(config.dataDir, 'google-tokens.json'),
    () => null
  );

  // ---- Registered MCP clients (dynamic client registration) ----

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clientsFile.read()[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    const clients = this.clientsFile.read();
    clients[client.client_id] = client;
    this.clientsFile.write(clients);
  }

  // ---- MCP access/refresh tokens issued by this server ----

  saveSession(accessToken: string, refreshToken: string, clientId: string, scopes: string[], ttlSeconds: number): void {
    const sessions = this.pruned();
    sessions.accessTokens[accessToken] = {
      clientId,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    sessions.refreshTokens[refreshToken] = { clientId, scopes };
    this.sessionsFile.write(sessions);
  }

  getAccessToken(token: string): AccessTokenEntry | undefined {
    return this.sessionsFile.read().accessTokens[token];
  }

  getRefreshToken(token: string): RefreshTokenEntry | undefined {
    return this.sessionsFile.read().refreshTokens[token];
  }

  addAccessToken(accessToken: string, clientId: string, scopes: string[], ttlSeconds: number): void {
    const sessions = this.pruned();
    sessions.accessTokens[accessToken] = {
      clientId,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    this.sessionsFile.write(sessions);
  }

  revokeToken(token: string): void {
    const sessions = this.sessionsFile.read();
    delete sessions.accessTokens[token];
    delete sessions.refreshTokens[token];
    this.sessionsFile.write(sessions);
  }

  private pruned(): SessionData {
    const sessions = this.sessionsFile.read();
    const now = Math.floor(Date.now() / 1000);
    for (const [token, entry] of Object.entries(sessions.accessTokens)) {
      if (entry.expiresAt < now) delete sessions.accessTokens[token];
    }
    return sessions;
  }

  // ---- Google OAuth tokens (the single user's account) ----

  readGoogleTokens(): Credentials | null {
    return this.googleTokensFile.read();
  }

  writeGoogleTokens(tokens: Credentials): void {
    this.googleTokensFile.write(tokens);
  }

  /** Merge refreshed tokens; Google omits refresh_token on refresh responses. */
  mergeGoogleTokens(tokens: Credentials): void {
    const existing = this.readGoogleTokens() ?? {};
    this.googleTokensFile.write({ ...existing, ...tokens });
  }

  clearGoogleTokens(): void {
    this.googleTokensFile.delete();
  }
}

export const storage = new Storage();
