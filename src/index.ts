#!/usr/bin/env node
import { assertConfig, config } from "./config.js";
import { createApp } from "./app.js";
import { storage } from "./storage.js";
import { command } from "./setup.js";

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    await command(process.argv.slice(2));
    return;
  }
  assertConfig();
  storage.acquire();
  try {
    if (config.ownerSub) storage.pinOwner(config.ownerSub);
    if (!storage.snapshot().owner)
      throw new Error(
        "Owner setup required: stop the service and run g-tasks-mcp setup",
      );
    const app = createApp();
    const server = app.listen(config.port, config.host, () =>
      console.log(
        `Google Tasks MCP: ${config.baseUrl}/mcp (bind ${config.host})`,
      ),
    );
    server.once("error", () => {
      storage.release();
      console.error("Could not bind HTTP listener");
      process.exitCode = 1;
    });
    const shutdown = () => {
      server.close(() => storage.release());
      server.closeAllConnections();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (err) {
    storage.release();
    throw err;
  }
}
void main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Startup failed");
  process.exitCode = 1;
});
