import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RecordTask } from "./text.js";
import { SearchError } from "./ports.js";

export interface Manifest {
  version: 1;
  installation: string;
  identity: string;
  fingerprint: string;
  epoch: number;
  collection: string;
  dimension: number;
  dirty: boolean;
  complete: boolean;
  lastFullSync: string | null;
  records: Record<string, RecordTask>;
  orphanIds: string[];
}
const schema = z.object({
  version: z.literal(1), installation: z.string().uuid(), identity: z.string(), fingerprint: z.string(),
  epoch: z.number().int().nonnegative(), collection: z.string(), dimension: z.number().int().nonnegative(),
  dirty: z.boolean(), complete: z.boolean(), lastFullSync: z.string().datetime().nullable(),
  records: z.record(z.object({ listId: z.string(), task: z.object({ id: z.string() }).passthrough(),
    embeddingHash: z.string(), metadataHash: z.string(), pointIds: z.array(z.string()) })), orphanIds: z.array(z.string()),
});
export class ManifestFile {
  private readonly file: string;
  constructor(private readonly dir: string) { this.file = path.join(dir, "search-index.json"); }
  private safe(file: string): void {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new SearchError("Unsafe search manifest. Repair file permissions before retrying.");
  }
  read(): Manifest | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    this.safe(this.file);
    try { return schema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) as Manifest; }
    catch { throw new SearchError("Search manifest is corrupt. Stop the service, remove search-index.json and restart to rebuild."); }
  }
  write(manifest: Manifest): void {
    const tmp = path.join(this.dir, `.search-${randomUUID()}.tmp`);
    try {
      if (fs.existsSync(this.file)) this.safe(this.file);
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(manifest)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      const dir = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { throw new SearchError("Cannot persist search recovery state. Retry after repairing private storage."); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
}
