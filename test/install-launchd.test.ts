import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = fs.readFileSync(path.join(root, "scripts/install-launchd.cjs"), "utf8");
async function install(states: Array<{ status: number; stderr?: string }>) {
  const calls: string[][] = [];
  const messages: string[] = [];
  let time = 0, writes = 0, delays = 0;
  const processStub = { platform: "darwin", argv: [], execPath: "/opt/homebrew/bin/node",
    getuid: () => 501, exitCode: 0, exit(code: number) { throw new Error(`exit ${code}`); } };
  await vm.runInNewContext(source, {
    __dirname: path.join(root, "scripts"), process: processStub, Date: { now: () => time },
    console: { log() {}, error(message: string) { messages.push(message); } },
    require(name: string) {
      if (name === "node:fs") return {
        readFileSync: fs.readFileSync, mkdirSync() {}, writeFileSync() { writes++; },
      };
      if (name === "node:os") return { homedir: () => "/Users/test" };
      if (name === "node:path") return path;
      if (name === "node:timers/promises") return { async setTimeout(ms: number) { time += ms; delays++; } };
      if (name === "node:child_process") return {
        spawnSync(command: string, args: string[]) {
          calls.push([command, ...args]);
          if (args[0] === "print") return states.length > 1 ? states.shift()! : states[0];
          return { status: 0 };
        },
      };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { calls, messages, delays, writes, exitCode: processStub.exitCode };
}

test("launchd replacement waits for asynchronous bootout before bootstrap", async () => {
  const result = await install([{ status: 0 }, { status: 0 }, { status: 0 }, { status: 113 }]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.delays, 2);
  const bootout = result.calls.findIndex((c) => c[1] === "bootout");
  const bootstrap = result.calls.findIndex((c) => c[1] === "bootstrap");
  assert.ok(bootout >= 0 && bootstrap > bootout);
  assert.equal(result.calls.slice(bootout + 1, bootstrap).filter((c) => c[1] === "print").length, 3);
  assert.equal(result.writes, 1);
});

test("first install accepts missing service and enables it before bootstrap", async () => {
  const result = await install([{ status: 3, stderr: "Bad request. Could not find service" }]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.delays, 0);
  assert.ok(!result.calls.some((c) => c[1] === "bootout"));
  const enable = result.calls.findIndex((c) => c[1] === "enable");
  assert.ok(enable >= 0 && enable < result.calls.findIndex((c) => c[1] === "bootstrap"));
});

test("failed service lookup and unload timeout never bootstrap a replacement", async () => {
  for (const states of [[{ status: 1, stderr: "Permission denied" }], [{ status: 0 }],
    [{ status: 0 }, { status: 1, stderr: "Permission denied" }]]) {
    const result = await install(states);
    assert.equal(result.exitCode, 1);
    assert.equal(result.writes, 0);
    assert.ok(!result.calls.some((c) => c[1] === "bootstrap"));
    assert.match(result.messages.join("\n"), /Permission denied|Timed out/);
  }
});
