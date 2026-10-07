import { createHash } from "node:crypto";
import type { tasks_v1 } from "googleapis";

export type Task = tasks_v1.Schema$Task;
export interface RecordTask {
  listId: string;
  task: Task;
  embeddingHash: string;
  metadataHash: string;
  pointIds: string[];
}
export const FORMAT = "title-notes-paragraph-v2";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const taskKey = (listId: string, id: string): string => JSON.stringify([listId, id]);
export function pointId(key: string, chunk: number): string {
  const h = hash([key, chunk]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Preserve source text, breaking oversized paragraphs on Unicode character boundaries.
export function chunks(task: Task): string[] {
  const prefix = `Title: ${task.title ?? ""}\nNotes: `;
  const paragraphs = (task.notes ?? "").split(/(?<=\n\n)/u);
  const bodies: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const chars = Array.from(paragraph);
    while (chars.length) {
      const available = 1800 - Array.from(current).length;
      current += chars.splice(0, available).join("");
      if (Array.from(current).length === 1800) {
        bodies.push(current);
        current = "";
      }
    }
    if (current && Array.from(current).length >= 900) {
      bodies.push(current);
      current = "";
    }
  }
  if (current || !bodies.length) bodies.push(current);
  return bodies.map((body) => prefix + body);
}
export function fingerprints(task: Task, model: string): { embeddingHash: string; metadataHash: string } {
  return {
    embeddingHash: hash([FORMAT, model, task.title ?? "", task.notes ?? ""]),
    metadataHash: hash(task),
  };
}
export interface SearchInput {
  query: string;
  tasklistIds?: string[];
  includeCompleted?: boolean;
  dueMin?: string;
  dueMax?: string;
  limit?: number;
}
export function eligible(record: Pick<RecordTask, "listId" | "task">, input: SearchInput): boolean {
  const t = record.task;
  return !t.deleted &&
    (!input.tasklistIds || input.tasklistIds.includes(record.listId)) &&
    (input.includeCompleted || t.status !== "completed") &&
    (!input.dueMin || (!!t.due && Date.parse(t.due) >= Date.parse(input.dueMin))) &&
    (!input.dueMax || (!!t.due && Date.parse(t.due) < Date.parse(input.dueMax)));
}
export function lexicalScore(task: Task, query: string): number {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  if (!terms.length) return 0;
  const title = (task.title ?? "").toLocaleLowerCase();
  const notes = (task.notes ?? "").toLocaleLowerCase();
  return terms.reduce((score, term) => score + (title.includes(term) ? 3 : 0) + (notes.includes(term) ? 1 : 0), 0) /
    terms.length;
}
export function passage(task: Task, query: string): string {
  return chunks(task).sort((a, b) => lexicalScore({ notes: b }, query) - lexicalScore({ notes: a }, query))[0];
}
