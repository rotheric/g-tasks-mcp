import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Auth } from "googleapis";
import { config } from "./config.js";
import {
  equal,
  hashToken,
  randomToken,
  validateClient,
} from "./auth/policy.js";

const lockSchema = z
  .object({ pid: z.number().int().positive(), token: z.string().min(1) })
  .strict();
const integer = z.number().int().nonnegative();
const clientSchema = z
  .object({
    client_id: z.string(),
    redirect_uris: z.array(z.string()),
    token_endpoint_auth_method: z.enum(["none", "client_secret_post"]),
    client_secret: z.string().optional(),
    client_secret_expires_at: integer.optional(),
  })
  .passthrough()
  .superRefine((client, ctx) => {
    const confidential =
      client.token_endpoint_auth_method === "client_secret_post";
    if (
      confidential
        ? !/^[a-f0-9]{64}$/.test(client.client_secret ?? "") ||
          !client.client_secret_expires_at
        : client.client_secret !== undefined ||
          client.client_secret_expires_at !== undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid client authentication state",
      });
    try {
      validateClient(client as OAuthClientInformationFull);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid client metadata",
      });
    }
  });
const grantSchema = z.object({
  clientId: z.string(),
  owner: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  redirect: z.string(),
  generation: integer,
  revision: integer,
  expiresAt: integer,
  active: z.boolean(),
});
const accessSchema = z.object({ grantId: z.string(), expiresAt: integer });
const refreshSchema = z.object({ grantId: z.string(), used: z.boolean() });
const accountSchema = z.object({
  sub: z.string(),
  credentials: z.record(z.unknown()),
  revision: integer,
});
const stateSchema = z
  .object({
    version: z.literal(2),
    owner: z.string().nullable(),
    generation: integer,
    account: accountSchema.nullable(),
    clients: z.record(clientSchema),
    revisions: z.record(integer),
    approvals: z.record(z.boolean()),
    grants: z.record(grantSchema),
    access: z.record(accessSchema),
    refresh: z.record(refreshSchema),
  })
  .strict();
export type State = z.infer<typeof stateSchema>;
export type Grant = z.infer<typeof grantSchema>;
export interface Revision {
  generation: number;
  credential: number;
  client: number;
}
const empty = (): State => ({
  version: 2,
  owner: null,
  generation: 0,
  account: null,
  clients: {},
  revisions: {},
  approvals: {},
  grants: {},
  access: {},
  refresh: {},
});
export interface StorageOptions {
  now?: () => number;
  beforeRename?: () => void;
  afterRename?: () => void;
}

/** One writer and one durable replacement for both account and authorization state. */
export class Storage {
  readonly file: string;
  private state?: State;
  private lockToken?: string;
  private now: () => number;
  constructor(
    readonly dataDir: string,
    private options: StorageOptions = {},
  ) {
    this.file = path.join(dataDir, "state-v2.json");
    this.now = options.now ?? Date.now;
  }
  private safe(file: string, directory = false): void {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()))
      throw new Error("Unsafe storage path");
    if (st.uid !== process.getuid?.())
      throw new Error("Storage must be owned by the current user");
    fs.chmodSync(file, directory ? 0o700 : 0o600);
  }
  acquire(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.safe(this.dataDir, true);
    const lock = path.join(this.dataDir, ".writer-lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new Error(
        "DATA_DIR is locked. Stop the server; inspect and recover a stale lock explicitly.",
      );
    }
    const token = randomToken();
    try {
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, token }),
        { flag: "wx", mode: 0o600 },
      );
      this.lockToken = token;
    } catch (err) {
      fs.rmSync(lock, { recursive: true, force: true });
      throw err;
    }
    try {
      this.load();
    } catch (err) {
      this.release();
      throw err;
    }
  }
  release(): void {
    if (!this.lockToken) return;
    const lock = path.join(this.dataDir, ".writer-lock");
    const owner = this.readPersisted(path.join(lock, "owner.json"), lockSchema);
    if (owner.token !== this.lockToken)
      throw new Error("Storage lock ownership changed");
    fs.rmSync(lock, { recursive: true });
    this.lockToken = undefined;
    this.state = undefined;
  }
  recoverLock(): void {
    const lock = path.join(this.dataDir, ".writer-lock");
    this.safe(lock, true);
    const file = path.join(lock, "owner.json");
    this.safe(file);
    const owner = this.readPersisted(file, lockSchema);
    if (!Number.isInteger(owner.pid) || owner.pid < 1)
      throw new Error("Invalid lock; manual recovery required");
    try {
      process.kill(owner.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        fs.rmSync(lock, { recursive: true });
        return;
      }
      throw new Error("Cannot establish that lock owner is absent");
    }
    throw new Error("Lock owner is alive; refusing recovery");
  }
  private readPersisted<T>(file: string, schema: z.ZodType<T>): T {
    try {
      return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      throw new Error(
        "Private storage is unreadable or corrupt. Stop the service and recover explicitly.",
      );
    }
  }
  private load(): void {
    if (fs.existsSync(this.file)) {
      this.safe(this.file);
      this.state = this.readPersisted(this.file, stateSchema);
    } else {
      if (
        ["google-tokens.json", "sessions.json", "clients.json"].some((n) =>
          fs.existsSync(path.join(this.dataDir, n)),
        )
      )
        throw new Error(
          "Legacy state found. Run migrate with the service stopped.",
        );
      this.state = empty();
    }
  }
  snapshot(): State {
    if (!this.state || !this.lockToken)
      throw new Error("Storage writer lock is required");
    return structuredClone(this.state);
  }
  update(fn: (draft: State) => void): void {
    const draft = this.snapshot();
    fn(draft);
    stateSchema.parse(draft);
    const serialized = JSON.stringify(draft);
    const committedState = stateSchema.parse(JSON.parse(serialized));
    const tmp = path.join(this.dataDir, `.state-${randomToken()}.tmp`);
    let committed = false;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, serialized);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.options.beforeRename?.();
      if (fs.existsSync(this.file)) {
        this.safe(this.file);
        const backup = path.join(this.dataDir, "state-v2.backup.json");
        if (fs.existsSync(backup)) this.safe(backup);
        const backupTmp = path.join(
          this.dataDir,
          `.backup-${randomToken()}.tmp`,
        );
        try {
          const backupFd = fs.openSync(backupTmp, "wx", 0o600);
          try {
            fs.writeFileSync(backupFd, JSON.stringify(this.snapshot()));
            fs.fsyncSync(backupFd);
          } finally {
            fs.closeSync(backupFd);
          }
          fs.renameSync(backupTmp, backup);
        } finally {
          fs.rmSync(backupTmp, { force: true });
        }
      }
      fs.renameSync(tmp, this.file);
      committed = true;
      this.state = committedState;
      const dir = fs.openSync(this.dataDir, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
      this.options.afterRename?.();
    } finally {
      if (!committed) fs.rmSync(tmp, { force: true });
    }
  }
  /** Migration never trusts an identity-less legacy credential or grants. */
  migrate(owner?: string): void {
    // Acquire without loading legacy records; the old state is backed up verbatim.
    const legacy = ["google-tokens.json", "sessions.json", "clients.json"];
    const staged: string[] = [];
    const backup = path.join(this.dataDir, "legacy-quarantine");
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.safe(this.dataDir, true);
    if (fs.existsSync(this.file)) {
      this.acquire();
      return;
    }
    // A durable v2 migration marker is the state file itself. Never move originals
    // until the v2 commit; interrupted backup leaves old runtime stopped and closed.
    const lock = path.join(this.dataDir, ".writer-lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new Error("Stop the service before migration");
    }
    const token = randomToken();
    fs.writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token }),
      { flag: "wx", mode: 0o600 },
    );
    this.lockToken = token;
    try {
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      this.safe(backup, true);
      for (const name of legacy) {
        const file = path.join(this.dataDir, name);
        if (fs.existsSync(file)) {
          this.safe(file);
          const destination = path.join(backup, name);
          if (!fs.existsSync(destination))
            fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
          this.safe(destination);
          staged.push(file);
        }
      }
      this.state = empty();
      if (owner) this.state.owner = owner;
      const legacyClients = path.join(this.dataDir, "clients.json");
      if (fs.existsSync(legacyClients)) {
        const records = this.readPersisted(
          legacyClients,
          z.record(z.unknown()),
        );
        for (const [id, value] of Object.entries(records)) {
          if (Object.keys(this.state.clients).length >= 100) break;
          try {
            const client = value as OAuthClientInformationFull;
            if (client.client_id !== id) continue;
            validateClient(client);
            const imported = {
              ...client,
              client_secret: client.client_secret
                ? hashToken(client.client_secret)
                : undefined,
            };
            this.state.clients[id] = clientSchema.parse(imported);
          } catch {
            /* Unsupported registrations must register again. */
          }
        }
      }
      this.update(() => {});
      for (const file of staged) fs.rmSync(file);
    } catch (err) {
      this.release();
      throw err;
    }
  }
  pinOwner(sub: string): void {
    if (!sub) throw new Error("Owner subject required");
    this.update((s) => {
      if (s.owner && s.owner !== sub) throw new Error("Owner conflict");
      s.owner = sub;
    });
  }
  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.snapshot().clients[id] as
      | OAuthClientInformationFull
      | undefined;
  }
  saveClient(client: OAuthClientInformationFull): void {
    this.update((s) => {
      if (Object.keys(s.clients).length >= 100)
        throw new Error(
          "Client capacity reached; use stopped-service administration to remove clients",
        );
      s.clients[client.client_id] = {
        ...client,
        token_endpoint_auth_method: client.token_endpoint_auth_method as
          | "none"
          | "client_secret_post",
        client_secret: client.client_secret
          ? hashToken(client.client_secret)
          : undefined,
      };
    });
  }
  verifySecret(id: string, secret: string): boolean {
    const c = this.getClient(id);
    return (
      !!c?.client_secret &&
      (c.client_secret_expires_at ?? 0) > Math.floor(this.now() / 1000) &&
      equal(hashToken(secret), c.client_secret)
    );
  }
  revision(clientId: string): Revision {
    const s = this.snapshot();
    return {
      generation: s.generation,
      credential: s.account?.revision ?? 0,
      client: s.revisions[clientId] ?? 0,
    };
  }
  isCurrent(r: Revision, clientId: string): boolean {
    const n = this.revision(clientId);
    return (
      n.generation === r.generation &&
      n.credential === r.credential &&
      n.client === r.client
    );
  }
  provision(
    sub: string,
    credentials: Auth.Credentials,
    expected: Revision,
    clientId: string,
    approval?: { redirect: string; resource: string },
  ): void {
    this.update((s) => {
      if (
        !this.isCurrent(expected, clientId) ||
        sub !== s.owner ||
        !credentials.refresh_token
      )
        throw new Error("Stale or invalid account provisioning");
      s.account = {
        sub,
        credentials: { ...credentials },
        revision: (s.account?.revision ?? 0) + 1,
      };
      if (approval)
        s.approvals[
          this.approvalKey(clientId, approval.redirect, approval.resource)
        ] = true;
    });
  }
  readGoogleTokens(): Auth.Credentials | null {
    return (this.snapshot().account?.credentials as Auth.Credentials) ?? null;
  }
  mergeGoogleTokens(
    tokens: Auth.Credentials,
    generation: number,
    revision: number,
  ): void {
    this.update((s) => {
      if (s.generation !== generation || s.account?.revision !== revision)
        return;
      s.account.credentials = { ...s.account.credentials, ...tokens };
      s.account.revision++;
    });
  }
  clearGoogleTokens(expected?: { generation: number; revision: number }): void {
    this.update((s) => {
      if (
        expected &&
        (s.generation !== expected.generation ||
          s.account?.revision !== expected.revision)
      )
        return;
      s.generation++;
      s.account = null;
      s.approvals = {};
      for (const g of Object.values(s.grants)) g.active = false;
    });
  }
  revokeClient(id: string): void {
    this.update((s) => {
      s.revisions[id] = (s.revisions[id] ?? 0) + 1;
      for (const g of Object.values(s.grants))
        if (g.clientId === id) g.active = false;
      for (const key of Object.keys(s.approvals))
        if (key.startsWith(id + "|")) delete s.approvals[key];
    });
  }
  removeClient(id: string): void {
    this.revokeClient(id);
    this.update((s) => {
      delete s.clients[id];
    });
  }
  approvalKey(id: string, redirect: string, resource: string): string {
    return `${id}|${redirect}|${resource}`;
  }
  approved(id: string, redirect: string, resource: string): boolean {
    return !!this.snapshot().approvals[
      this.approvalKey(id, redirect, resource)
    ];
  }
  approve(id: string, redirect: string, resource: string): void {
    this.update((s) => {
      s.approvals[this.approvalKey(id, redirect, resource)] = true;
    });
  }
  private prune(s: State): void {
    const now = Math.floor(this.now() / 1000);
    // Retired families never reactivate; active families retain spent-token history.
    for (const [id, g] of Object.entries(s.grants))
      if (!g.active || g.expiresAt <= now) delete s.grants[id];
    for (const [h, t] of Object.entries(s.access))
      if (t.expiresAt <= now || !s.grants[t.grantId]) delete s.access[h];
    for (const [h, t] of Object.entries(s.refresh))
      if (!s.grants[t.grantId]) delete s.refresh[h];
  }
  issueGrant(
    clientId: string,
    redirect: string,
    resource: string,
    expected: Revision,
  ): {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: "bearer";
    scope: string;
  } {
    const access = randomToken(),
      refresh = randomToken(),
      grantId = randomToken(),
      now = Math.floor(this.now() / 1000);
    this.update((s) => {
      this.prune(s);
      if (
        !this.isCurrent(expected, clientId) ||
        !s.account ||
        s.account.sub !== s.owner ||
        !this.approved(clientId, redirect, resource)
      )
        throw new Error("Grant is no longer authorized");
      if (
        Object.keys(s.grants).length >= 100 ||
        Object.keys(s.refresh).length >= 10000
      )
        throw new Error("Authorization capacity reached");
      s.grants[grantId] = {
        clientId,
        owner: s.owner!,
        resource,
        scopes: ["tasks"],
        redirect,
        generation: s.generation,
        revision: expected.client,
        expiresAt: now + 90 * 86400,
        active: true,
      };
      s.access[hashToken(access)] = { grantId, expiresAt: now + 3600 };
      s.refresh[hashToken(refresh)] = { grantId, used: false };
    });
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "bearer",
      scope: "tasks",
    };
  }
  private validGrant(
    s: State,
    id: string,
    clientId?: string,
  ): Grant | undefined {
    const g = s.grants[id];
    const now = Math.floor(this.now() / 1000);
    if (
      !g ||
      !g.active ||
      g.expiresAt <= now ||
      g.owner !== s.owner ||
      g.generation !== s.generation ||
      g.revision !== (s.revisions[g.clientId] ?? 0) ||
      (clientId && g.clientId !== clientId) ||
      !s.account ||
      s.account.sub !== s.owner
    )
      return;
    return g;
  }
  accessToken(
    value: string,
    resource: string,
  ): { grant: Grant; expiresAt: number } | undefined {
    const s = this.snapshot(),
      t = s.access[hashToken(value)];
    if (!t || t.expiresAt <= Math.floor(this.now() / 1000)) return;
    const g = this.validGrant(s, t.grantId);
    if (!g || g.resource !== resource) return;
    return { grant: g, expiresAt: Math.min(t.expiresAt, g.expiresAt) };
  }
  rotate(
    value: string,
    clientId: string,
    resource: string,
  ): ReturnType<Storage["issueGrant"]> | undefined {
    const next = randomToken(),
      access = randomToken(),
      now = Math.floor(this.now() / 1000);
    let ttl = 0,
      ok = false;
    this.update((s) => {
      this.prune(s);
      const entry = s.refresh[hashToken(value)];
      if (!entry) return;
      const g = this.validGrant(s, entry.grantId, clientId);
      if (!g || g.resource !== resource) return;
      if (entry.used) {
        g.active = false;
        return;
      }
      if (
        Object.values(s.refresh).filter((t) => t.grantId === entry.grantId)
          .length >= 1000 ||
        Object.keys(s.refresh).length >= 10000
      ) {
        g.active = false;
        return;
      }
      entry.used = true;
      ttl = Math.min(3600, g.expiresAt - now);
      s.refresh[hashToken(next)] = { grantId: entry.grantId, used: false };
      s.access[hashToken(access)] = {
        grantId: entry.grantId,
        expiresAt: now + ttl,
      };
      ok = true;
    });
    return ok
      ? {
          access_token: access,
          refresh_token: next,
          expires_in: ttl,
          token_type: "bearer",
          scope: "tasks",
        }
      : undefined;
  }
  revokeToken(value: string, clientId: string): void {
    this.update((s) => {
      const h = hashToken(value),
        r = s.refresh[h],
        a = s.access[h],
        id = r?.grantId ?? a?.grantId;
      if (!id || s.grants[id]?.clientId !== clientId) return;
      if (r) s.grants[id].active = false;
      else delete s.access[h];
    });
  }
}
export const storage = new Storage(config.dataDir);
