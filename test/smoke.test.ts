import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Configure the environment before the app modules load their config.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-mcp-test-'));
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.DATA_DIR = dataDir;
process.env.PORT = '3789';

const { createApp } = await import('../src/app.js');

let server: Server;
let base: string;

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

before(async () => {
  const app = createApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('serves OAuth discovery metadata', async () => {
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  const prmBody = await prm.json();
  assert.ok(String(prmBody.resource).endsWith('/mcp'));
  assert.deepEqual(prmBody.scopes_supported, ['tasks']);

  const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(as.status, 200);
  const asBody = await as.json();
  assert.ok(asBody.authorization_endpoint.endsWith('/authorize'));
  assert.ok(asBody.token_endpoint.endsWith('/token'));
  assert.ok(asBody.registration_endpoint.endsWith('/register'));
  assert.deepEqual(asBody.code_challenge_methods_supported, ['S256']);
});

test('unauthenticated /mcp returns 401 with a WWW-Authenticate challenge', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /Bearer/);
  assert.match(challenge, /resource_metadata=/);
});

async function registerClient(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'smoke-test',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id);
  return body.client_id as string;
}

test('dynamic registration + authorize redirects to Google consent', async () => {
  const clientId = await registerClient();
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', 'http://127.0.0.1:9999/callback');
  url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'test-state');

  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location') ?? '');
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('scope'), 'https://www.googleapis.com/auth/tasks');
  assert.equal(location.searchParams.get('access_type'), 'offline');
  assert.ok(location.searchParams.get('state'));
});

test('refresh token grant issues an access token that lists all tools', async () => {
  const clientId = await registerClient();

  // Seed the state a completed Google consent would have left behind.
  fs.writeFileSync(
    path.join(dataDir, 'google-tokens.json'),
    JSON.stringify({ refresh_token: 'seeded-refresh', access_token: 'seeded-access' })
  );
  fs.writeFileSync(
    path.join(dataDir, 'sessions.json'),
    JSON.stringify({
      accessTokens: {},
      refreshTokens: { 'seeded-mcp-refresh': { clientId, scopes: ['tasks'] } },
    })
  );

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'seeded-mcp-refresh',
      client_id: clientId,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.ok(tokens.access_token);
  assert.equal(tokens.token_type, 'bearer');

  const listRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
  });
  assert.equal(listRes.status, 200);
  const text = await listRes.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(dataLine, `no SSE data line in response: ${text}`);
  const body = JSON.parse(dataLine.slice('data: '.length));
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    'clear_completed_tasks',
    'complete_task',
    'create_task',
    'create_task_list',
    'delete_task',
    'delete_task_list',
    'get_task',
    'list_task_lists',
    'list_tasks',
    'move_task',
    'update_task',
  ]);
});
