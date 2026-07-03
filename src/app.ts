import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config, MCP_SCOPE } from './config.js';
import { GoogleTasksOAuthProvider } from './provider.js';
import { registerTools } from './tools.js';

export function createApp(): express.Express {
  const app = express();
  const provider = new GoogleTasksOAuthProvider();
  const mcpUrl = new URL('/mcp', config.baseUrl);

  // OAuth endpoints: /authorize, /token, /register, /revoke + discovery metadata.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.baseUrl),
      scopesSupported: [MCP_SCOPE],
      resourceName: 'Google Tasks',
      resourceServerUrl: mcpUrl,
    })
  );

  // Google redirects back here after the user grants (or denies) consent.
  app.get('/oauth/google/callback', (req, res) => void provider.handleGoogleCallback(req, res));

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: a fresh server+transport per request, no sessions.
  app.post('/mcp', bearerAuth, express.json(), async (req: Request, res: Response) => {
    const server = new McpServer({ name: 'google-tasks', version: '0.1.0' });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Error handling MCP request:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  };
  app.get('/mcp', bearerAuth, methodNotAllowed);
  app.delete('/mcp', bearerAuth, methodNotAllowed);

  return app;
}
