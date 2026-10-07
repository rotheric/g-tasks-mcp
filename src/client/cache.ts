import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OAuthClientInformationFullSchema, OAuthTokensSchema, type OAuthClientInformationFull, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export type ClientState = { client?: OAuthClientInformationFull; tokens?: OAuthTokens };
const schema = { parse(value: unknown): ClientState {
  const raw = z.object({ client: z.unknown().optional(), tokens: z.unknown().optional() }).strict().parse(value);
  return { client: raw.client === undefined ? undefined : OAuthClientInformationFullSchema.parse(raw.client),
    tokens: raw.tokens === undefined ? undefined : OAuthTokensSchema.parse(raw.tokens) };
} };
export class ClientCache {
  state: ClientState = {};
  private readonly file: string;
  private readonly lock: string;
  private held = false;
  constructor(private readonly dir: string, resource: string) {
    this.file = path.join(dir, `${createHash("sha256").update(resource).digest("hex")}.json`);
    this.lock = this.file + ".lock";
  }
  private safe(file: string, directory = false): void {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o077) ||
        (process.getuid && s.uid !== process.getuid())) throw new Error("Unsafe MCP CLI cache permissions.");
  }
  acquire(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.safe(this.dir, true);
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
    catch { throw new Error("MCP CLI cache is locked. Another embeddings command may be running; remove its .lock directory only after it has stopped."); }
    this.held = true;
    try {
      if (fs.existsSync(this.file)) {
        this.safe(this.file);
        this.state = schema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      }
    } catch {
      this.release();
      throw new Error("MCP CLI cache is unreadable or unsafe. Repair or remove its JSON file before retrying.");
    }
  }
  save(): void {
    if (!this.held) throw new Error("MCP CLI cache lock required.");
    const tmp = this.file + `.${randomUUID()}.tmp`;
    try {
      if (fs.existsSync(this.file)) this.safe(this.file);
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(schema.parse(this.state))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      const fdDir = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  release(): void {
    if (this.held) { fs.rmdirSync(this.lock); this.held = false; }
  }
}
