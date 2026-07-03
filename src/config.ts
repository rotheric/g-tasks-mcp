import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

const port = parseInt(process.env.PORT ?? '3789', 10);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  dataDir: process.env.DATA_DIR ?? path.join(os.homedir(), '.g-tasks-mcp'),
};

/** Scope requested from Google (full read/write access to Google Tasks). */
export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

/** Scope this server advertises to MCP clients. */
export const MCP_SCOPE = 'tasks';

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.googleClientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(', ')}\n\n` +
        'Copy .env.example to .env and follow the "Google Cloud setup" section of the README\n' +
        'to create an OAuth client for the Google Tasks API.'
    );
    process.exit(1);
  }
}
