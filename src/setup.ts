import { createSetupBrowser } from "./auth/setup-browser.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Server } from "node:http";
import { assertConfig, config } from "./config.js";
import { storage } from "./storage.js";
import { googlePort } from "./auth/google-identity.js";

export async function command(args: string[]): Promise<void> {
  const [name, action, id] = args;
  if (name === "lock-recover") {
    storage.recoverLock();
    console.log("Recovered absent writer lock.");
    return;
  }
  if (name === "migrate") storage.migrate(config.ownerSub || undefined);
  else storage.acquire();
  try {
    if (name === "migrate") {
      console.log(
        "Migrated to disconnected v2 state. Run setup, then start and reconnect clients.",
      );
      return;
    }
    if (name === "clients") {
      if (action === "list")
        console.log(
          Object.values(storage.snapshot().clients)
            .map((c) => `${c.client_id}  ${c.client_name ?? "Unnamed client"}`)
            .join("\n"),
        );
      else if (action === "revoke" && id) {
        storage.revokeClient(id);
        console.log("Client grants revoked.");
      } else if (action === "remove" && id) {
        storage.removeClient(id);
        console.log("Client removed.");
      } else
        throw new Error(
          "Usage: clients list | clients revoke ID | clients remove ID",
        );
      return;
    }
    if (name === "disconnect") {
      storage.clearGoogleTokens();
      console.log("Disconnected account and invalidated grants.");
      return;
    }
    if (name !== "setup")
      throw new Error(
        "Commands: setup, migrate, clients, disconnect, lock-recover",
      );
    assertConfig();
    if (config.ownerSub) {
      storage.pinOwner(config.ownerSub);
      console.log("Pinned configured owner subject.");
      return;
    }
    if (!stdin.isTTY || !stdout.isTTY)
      throw new Error(
        "Interactive terminal required for owner confirmation; or provide independently verified OWNER_GOOGLE_SUB",
      );
    await enroll();
  } finally {
    storage.release();
  }
}
async function enroll(): Promise<void> {
  const url = new URL(config.setupUrl),
    flow = createSetupBrowser(config, googlePort());
  const { app, entry, result, fail } = flow;
  let server: Server | undefined;
  const timer = setTimeout(
    () => fail(new Error("Setup expired")),
    10 * 60 * 1000,
  );
  const abort = () => fail(new Error("Setup cancelled"));
  process.once("SIGINT", abort);
  try {
    await new Promise<void>((resolve, reject) => {
      server = app.listen(Number(url.port || 80), "127.0.0.1", resolve);
      server.once("error", reject);
    });
    console.log(`Open in the host browser: ${url.origin}/setup?key=${entry}`);
    const identity = await result;
    console.log(
      `Google account: ${identity.email ?? "(email unavailable)"}\nSubject: ${identity.sub}`,
    );
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      if (
        (
          await terminal.question("Pin this account as owner? Type yes: ")
        ).trim() !== "yes"
      )
        throw new Error("Owner not confirmed");
      storage.pinOwner(identity.sub);
      console.log(
        "Owner pinned. Start the server and connect a client to authorize Tasks.",
      );
    } finally {
      terminal.close();
    }
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", abort);
    server?.close();
    server?.closeAllConnections();
  }
}
