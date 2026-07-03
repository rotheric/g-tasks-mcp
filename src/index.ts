import { assertConfig, config } from './config.js';
import { createApp } from './app.js';
import { storage } from './storage.js';

assertConfig();

const app = createApp();
const mcpUrl = new URL('/mcp', config.baseUrl);

app.listen(config.port, () => {
  const connected = storage.readGoogleTokens() !== null;
  console.log(`Google Tasks MCP server listening on ${config.baseUrl}`);
  console.log(`  MCP endpoint:     ${mcpUrl.href}`);
  console.log(`  Google account:   ${connected ? 'connected' : 'not connected yet (browser consent on first use)'}`);
  console.log(`  Token storage:    ${config.dataDir}`);
  console.log('');
  console.log('Connect from Claude Code:');
  console.log(`  claude mcp add --transport http google-tasks ${mcpUrl.href}`);
});
