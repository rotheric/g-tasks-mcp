import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "../src/storage.js";
import { hashToken } from "../src/auth/policy.js";

function fixture() {
  let time = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-store-"));
  const options = {
    now: () => time,
    beforeRename: () => {},
    afterRename: () => {},
  };
  const s = new Storage(dir, options);
  s.acquire();
  s.pinOwner("owner");
  s.saveClient({
    client_id: "client",
    redirect_uris: ["http://127.0.0.1/cb"],
    token_endpoint_auth_method: "none",
  });
  s.provision(
    "owner",
    { refresh_token: "google" },
    s.revision("client"),
    "client",
  );
  s.approve("client", "http://127.0.0.1/cb", "https://mcp.example/mcp");
  return {
    s,
    dir,
    options,
    advance: (n: number) => {
      time += n;
    },
    cleanup: () => {
      s.release();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const issue = (s: Storage) =>
  s.issueGrant(
    "client",
    "http://127.0.0.1/cb",
    "https://mcp.example/mcp",
    s.revision("client"),
  );

test("private atomic state and exclusive writer survive restart; corrupt state fails closed", () => {
  const f = fixture();
  try {
    const token = issue(f.s);
    assert.equal(fs.statSync(f.s.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
    assert.throws(() => new Storage(f.dir).acquire(), /locked/);
    assert.throws(() => new Storage(f.dir).recoverLock(), /alive/);
    f.s.release();
    f.s.acquire();
    assert.ok(f.s.accessToken(token.access_token, "https://mcp.example/mcp"));
    f.s.release();
    fs.writeFileSync(f.s.file, "invalid");
    assert.throws(() => f.s.acquire());
  } finally {
    f.cleanup();
  }
});

for (const operation of ["provision", "disconnect", "rotation"] as const)
  for (const boundary of ["before", "after"] as const)
    test(`fault injection ${operation} ${boundary} replacement selects complete state`, () => {
      const f = fixture();
      try {
        const tokens = issue(f.s),
          before = f.s.snapshot();
        const perform = () => {
          if (operation === "provision")
            f.s.provision(
              "owner",
              { refresh_token: "replacement" },
              f.s.revision("client"),
              "client",
            );
          else if (operation === "disconnect") f.s.clearGoogleTokens();
          else
            f.s.rotate(
              tokens.refresh_token,
              "client",
              "https://mcp.example/mcp",
            );
        };
        f.options[boundary === "before" ? "beforeRename" : "afterRename"] =
          () => {
            throw new Error("injected crash");
          };
        assert.throws(perform, /injected/);
        f.options.beforeRename = () => {};
        f.options.afterRename = () => {};
        f.s.release();
        f.s.acquire();
        const actual = f.s.snapshot();
        if (boundary === "before") assert.deepEqual(actual, before);
        else if (operation === "disconnect") {
          assert.equal(actual.account, null);
          assert.equal(actual.generation, before.generation + 1);
        } else if (operation === "provision")
          assert.equal(
            actual.account?.credentials.refresh_token,
            "replacement",
          );
        else
          assert.equal(
            actual.refresh[hashToken(tokens.refresh_token)].used,
            true,
          );
      } finally {
        f.cleanup();
      }
    });

test("legacy migration quarantines credentials, discards sessions, and can resume disconnected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtasks-migration-"));
  const s = new Storage(dir);
  try {
    fs.writeFileSync(
      path.join(dir, "google-tokens.json"),
      JSON.stringify({ refresh_token: "legacy" }),
    );
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify({ accessTokens: { legacy: { clientId: "x" } } }),
    );
    assert.throws(() => s.acquire(), /migrate/);
    s.migrate("owner");
    assert.equal(s.readGoogleTokens(), null);
    assert.equal(s.accessToken("legacy", "https://mcp.example/mcp"), undefined);
    assert.ok(
      fs.existsSync(path.join(dir, "legacy-quarantine/google-tokens.json")),
    );
    s.release();
    s.migrate();
    assert.equal(s.snapshot().owner, "owner");
    assert.equal(s.readGoogleTokens(), null);
  } finally {
    s.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh replay and spent-token revocation invalidate only their grant", () => {
  const f = fixture();
  try {
    const a = issue(f.s),
      b = issue(f.s),
      next = f.s.rotate(a.refresh_token, "client", "https://mcp.example/mcp")!;
    assert.ok(next);
    const retired = issue(f.s);
    f.s.revokeToken(retired.refresh_token, "client");
    issue(f.s); // Reclaims unrelated retired state without losing active replay evidence.
    assert.ok(f.s.snapshot().refresh[hashToken(a.refresh_token)].used);
    assert.equal(
      f.s.rotate(a.refresh_token, "client", "https://mcp.example/mcp"),
      undefined,
    );
    assert.equal(
      f.s.accessToken(next.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    assert.ok(f.s.accessToken(b.access_token, "https://mcp.example/mcp"));
  } finally {
    f.cleanup();
  }
});

test("generation and credential revisions protect reconnect from stale success and terminal failure", () => {
  const f = fixture();
  try {
    const old = f.s.snapshot(),
      expected = f.s.revision("client"),
      token = issue(f.s);
    f.s.clearGoogleTokens();
    f.s.provision(
      "owner",
      { refresh_token: "new" },
      f.s.revision("client"),
      "client",
    );
    f.s.mergeGoogleTokens(
      { refresh_token: "stale" },
      old.generation,
      old.account!.revision,
    );
    f.s.clearGoogleTokens({
      generation: old.generation,
      revision: old.account!.revision,
    });
    assert.equal(f.s.readGoogleTokens()?.refresh_token, "new");
    assert.throws(
      () =>
        f.s.provision("owner", { refresh_token: "late" }, expected, "client"),
      /Stale/,
    );
    assert.equal(
      f.s.accessToken(token.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    f.s.approve("client", "http://127.0.0.1/cb", "https://mcp.example/mcp");
    assert.ok(issue(f.s).access_token);
  } finally {
    f.cleanup();
  }
});

test("expiry boundaries and replay history capacity fail closed without dropping evidence", () => {
  const f = fixture();
  try {
    const token = issue(f.s);
    f.advance(3600 * 1000);
    assert.equal(
      f.s.accessToken(token.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    const refreshed = f.s.rotate(
      token.refresh_token,
      "client",
      "https://mcp.example/mcp",
    )!;
    assert.ok(refreshed);
    const grantId =
      f.s.snapshot().refresh[hashToken(refreshed.refresh_token)].grantId;
    f.s.update((s) => {
      for (let i = 0; i < 1000; i++)
        s.refresh[hashToken("spent-" + i)] = { grantId, used: true };
    });
    assert.equal(
      f.s.rotate(refreshed.refresh_token, "client", "https://mcp.example/mcp"),
      undefined,
    );
    assert.equal(
      f.s.accessToken(refreshed.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    const replacement = issue(f.s);
    assert.ok(replacement.access_token);
    assert.equal(
      f.s.accessToken(refreshed.access_token, "https://mcp.example/mcp"),
      undefined,
    );
    assert.equal(
      f.s.rotate(refreshed.refresh_token, "client", "https://mcp.example/mcp"),
      undefined,
    );
  } finally {
    f.cleanup();
  }
});

test("a committed Google refresh protects newer credentials from older refresh events and terminal failures", () => {
  const f = fixture();
  try {
    const before = f.s.snapshot();
    f.s.mergeGoogleTokens(
      { access_token: "new-access" },
      before.generation,
      before.account!.revision,
    );
    assert.equal(
      f.s.snapshot().account!.revision,
      before.account!.revision + 1,
    );
    f.s.mergeGoogleTokens(
      { access_token: "stale-access" },
      before.generation,
      before.account!.revision,
    );
    f.s.clearGoogleTokens({
      generation: before.generation,
      revision: before.account!.revision,
    });
    assert.equal(f.s.readGoogleTokens()?.access_token, "new-access");
    assert.equal(f.s.readGoogleTokens()?.refresh_token, "google");
  } finally {
    f.cleanup();
  }
});

test("confidential-client semantic corruption fails closed on reload", () => {
  for (const corrupt of ["missing", "plaintext", "expiry", "public-secret"]) {
    const f = fixture();
    try {
      f.s.saveClient({
        client_id: "confidential",
        redirect_uris: ["https://client.example/cb"],
        token_endpoint_auth_method: "client_secret_post",
        client_secret: "secret",
        client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      const state = f.s.snapshot();
      const client = state.clients.confidential;
      if (corrupt === "missing") delete client.client_secret;
      if (corrupt === "plaintext") client.client_secret = "secret";
      if (corrupt === "expiry") delete client.client_secret_expires_at;
      if (corrupt === "public-secret")
        client.token_endpoint_auth_method = "none";
      f.s.release();
      fs.writeFileSync(f.s.file, JSON.stringify(state));
      assert.throws(() => f.s.acquire());
    } finally {
      f.cleanup();
    }
  }
});

for (const boundary of ["before", "after"] as const)
  test(`legacy migration ${boundary} replacement preserves only unapproved supported registrations`, () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gtasks-migration-fault-"),
    );
    const options = { beforeRename: () => {}, afterRename: () => {} };
    const s = new Storage(dir, options);
    try {
      fs.writeFileSync(
        path.join(dir, "clients.json"),
        JSON.stringify({
          public: {
            client_id: "public",
            redirect_uris: ["http://127.0.0.1/cb"],
            token_endpoint_auth_method: "none",
          },
          private: {
            client_id: "private",
            redirect_uris: ["https://client.example/cb"],
            token_endpoint_auth_method: "client_secret_post",
            client_secret: "legacy-secret",
            client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
          unsafe: {
            client_id: "unsafe",
            redirect_uris: ["http://remote.example/cb"],
            token_endpoint_auth_method: "none",
          },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "google-tokens.json"),
        JSON.stringify({ refresh_token: "legacy" }),
      );
      options[boundary === "before" ? "beforeRename" : "afterRename"] = () => {
        throw new Error("migration crash");
      };
      assert.throws(() => s.migrate("owner"), /migration crash/);
      options.beforeRename = () => {};
      options.afterRename = () => {};
      if (boundary === "before") assert.equal(fs.existsSync(s.file), false);
      s.migrate("owner");
      assert.ok(s.getClient("public"));
      assert.equal(s.getClient("unsafe"), undefined);
      assert.equal(
        s.getClient("private")!.client_secret,
        hashToken("legacy-secret"),
      );
      assert.deepEqual(s.snapshot().approvals, {});
      assert.deepEqual(s.snapshot().grants, {});
      assert.equal(s.readGoogleTokens(), null);
      assert.throws(() =>
        s.issueGrant(
          "public",
          "http://127.0.0.1/cb",
          "https://mcp.example/mcp",
          s.revision("public"),
        ),
      );
    } finally {
      s.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test("private last-known-good backup never automatically replaces corrupt primary state", () => {
  const f = fixture();
  try {
    const before = f.s.snapshot();
    f.s.clearGoogleTokens();
    const backup = path.join(f.dir, "state-v2.backup.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), before);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    f.s.release();
    fs.writeFileSync(f.s.file, "corrupt");
    assert.throws(() => f.s.acquire());
    assert.equal(fs.readFileSync(f.s.file, "utf8"), "corrupt");
  } finally {
    f.cleanup();
  }
});

for (const retirement of ["token", "client", "disconnect"])
  test(`retired ${retirement} grants free capacity for fresh authorization and remain invalid after reload`, () => {
    const f = fixture();
    try {
      const old: ReturnType<typeof issue>[] = [];
      for (let i = 0; i < 105; i++) {
        const tokens = issue(f.s);
        old.push(tokens);
        if (retirement === "token")
          f.s.revokeToken(tokens.refresh_token, "client");
        else if (retirement === "client") {
          f.s.revokeClient("client");
          f.s.approve(
            "client",
            "http://127.0.0.1/cb",
            "https://mcp.example/mcp",
          );
        } else {
          f.s.clearGoogleTokens();
          f.s.provision(
            "owner",
            { refresh_token: "fresh-google" },
            f.s.revision("client"),
            "client",
          );
          f.s.approve(
            "client",
            "http://127.0.0.1/cb",
            "https://mcp.example/mcp",
          );
        }
      }
      const fresh = issue(f.s);
      assert.equal(Object.keys(f.s.snapshot().grants).length, 1);
      assert.equal(Object.keys(f.s.snapshot().refresh).length, 1);
      f.s.release();
      f.s.acquire();
      for (const token of old) {
        assert.equal(
          f.s.accessToken(token.access_token, "https://mcp.example/mcp"),
          undefined,
        );
        assert.equal(
          f.s.rotate(token.refresh_token, "client", "https://mcp.example/mcp"),
          undefined,
        );
      }
      assert.ok(f.s.accessToken(fresh.access_token, "https://mcp.example/mcp"));
    } finally {
      f.cleanup();
    }
  });
