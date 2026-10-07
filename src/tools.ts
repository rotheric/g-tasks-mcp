import { z } from "zod";
import { google, tasks_v1 } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthorizedGoogleClient, resetGoogleClient, isGoogleAuthError, invalidateGoogleAuthorization } from "./google.js";
import { storage, Storage } from "./storage.js";
import { config, type Configuration } from "./config.js";
import { searchFor, type SearchService, type Change } from "./search/service.js";
import { SearchError } from "./search/ports.js";

export interface ToolDependencies {
  search?: SearchService;
  tasks?: () => tasks_v1.Tasks;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function slimTaskList(list: tasks_v1.Schema$TaskList) {
  return { id: list.id, title: list.title, updated: list.updated };
}

function slimTask(task: tasks_v1.Schema$Task) {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes ?? undefined,
    status: task.status,
    due: task.due ?? undefined,
    completed: task.completed ?? undefined,
    parent: task.parent ?? undefined,
    position: task.position,
  };
}

const tasklistId = z
  .string()
  .default("@default")
  .describe("Task list ID. Defaults to '@default', the user's primary list.");

const dueDescription =
  "Due date as an RFC 3339 timestamp, e.g. 2026-07-04T00:00:00Z. Google Tasks only records the date portion.";

export function registerTools(
  server: McpServer,
  store: Storage = storage,
  c: Configuration = config,
  dependencies: ToolDependencies = {},
): void {
  const search = dependencies.search ?? searchFor(store, c);
  async function mutate<T>(operation: () => Promise<T>, change?: (result: T) => Change): Promise<T> {
    return search ? search.mutate(operation, change) : operation();
  }
  function tasksApi(): tasks_v1.Tasks {
    if (dependencies.tasks) return dependencies.tasks();
    return google.tasks({
      version: "v1",
      timeout: 30000,
      auth: getAuthorizedGoogleClient(store, c),
    });
  }

  async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
    const snapshot = store.snapshot();
    const expected = snapshot.account
      ? { generation: snapshot.generation, revision: snapshot.account.revision }
      : undefined;
    try {
      return ok(await fn());
    } catch (err) {
      if (isGoogleAuthError(err)) {
        if (expected) invalidateGoogleAuthorization(store, expected);
        else resetGoogleClient(store);
        return {
          content: [
            {
              type: "text",
              text: "Google authorization expired or was revoked. Reconnect this MCP server to sign in again.",
            },
          ],
          isError: true,
        };
      }
      if (err instanceof SearchError) return {
        content: [{ type: "text", text: err.details
          ? JSON.stringify({ error: err.message, ...err.details }) : err.message }], isError: true,
      };
      return {
        content: [
          {
            type: "text",
            text: "Google Tasks API request failed. Retry later.",
          },
        ],
        isError: true,
      };
    }
  }

  server.registerTool(
    "search_tasks",
    {
      title: "Search tasks",
      description: "Search task titles and notes by meaning and keywords across all lists. Returns current matching tasks without fetching the whole inventory to the client. Search index must be enabled; results report index freshness and candidate limits.",
      inputSchema: {
        query: z.string().trim().min(1).max(4000),
        tasklistIds: z.array(z.string().min(1)).min(1).max(100).optional()
          .describe("Restrict to explicit task list IDs; omit to search all lists."),
        includeCompleted: z.boolean().default(false),
        dueMin: z.string().datetime({ offset: true }).optional(),
        dueMax: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (input) => run(async () => {
      if (!search) throw new SearchError("Task search is disabled. Configure SEARCH_ENABLED and the embedding/Qdrant endpoints.");
      return search.search(input);
    }),
  );
  server.registerTool(
    "sync_search_index",
    {
      title: "Synchronize task search index",
      description: "Reconcile all Google Tasks into the search index, reusing unchanged embeddings. Runs inside the server alongside normal task operations.",
      inputSchema: {},
    },
    async () => run(async () => {
      if (!search) throw new SearchError("Task search is disabled.");
      return search.sync();
    }),
  );
  server.registerTool(
    "rebuild_search_index",
    {
      title: "Rebuild task search index",
      description: "Rebuild the derived task search index from all Google Tasks. Does not change Google tasks or unrelated Qdrant collections. Requires enabled search.",
      inputSchema: {},
    },
    async () => run(async () => {
      if (!search) throw new SearchError("Task search is disabled.");
      return search.sync(true);
    }),
  );

  server.registerTool(
    "list_task_lists",
    {
      title: "List task lists",
      description: "List all of the user's Google Tasks task lists.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const res = await tasksApi().tasklists.list({ maxResults: 100 });
        return (res.data.items ?? []).map(slimTaskList);
      }),
  );

  server.registerTool(
    "create_task_list",
    {
      title: "Create task list",
      description: "Create a new task list.",
      inputSchema: { title: z.string().describe("Title of the new task list") },
    },
    async ({ title }) =>
      run(async () => {
        const res = await mutate(() => tasksApi().tasklists.insert({
          requestBody: { title },
        }));
        return slimTaskList(res.data);
      }),
  );

  server.registerTool(
    "delete_task_list",
    {
      title: "Delete task list",
      description:
        "Delete a task list, including all tasks in it. This cannot be undone.",
      inputSchema: {
        tasklistId: z.string().describe("ID of the task list to delete"),
      },
    },
    async ({ tasklistId: id }) =>
      run(async () => {
        await mutate(() => tasksApi().tasklists.delete({ tasklist: id }),
          () => ({ listId: id, deletedList: true }));
        return { deleted: id };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks in a task list. By default only pending (not completed) tasks are returned.",
      inputSchema: {
        tasklistId,
        showCompleted: z
          .boolean()
          .default(false)
          .describe("Include completed tasks"),
        dueMin: z
          .string()
          .optional()
          .describe("Only tasks due on/after this RFC 3339 timestamp"),
        dueMax: z
          .string()
          .optional()
          .describe("Only tasks due before this RFC 3339 timestamp"),
        maxResults: z.number().int().min(1).max(100).default(100),
      },
    },
    async ({ tasklistId: id, showCompleted, dueMin, dueMax, maxResults }) =>
      run(async () => {
        const res = await tasksApi().tasks.list({
          tasklist: id,
          showCompleted,
          showHidden: showCompleted,
          dueMin,
          dueMax,
          maxResults,
        });
        return (res.data.items ?? []).map(slimTask);
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get a single task by ID.",
      inputSchema: {
        tasklistId,
        taskId: z.string().describe("ID of the task"),
      },
    },
    async ({ tasklistId: id, taskId }) =>
      run(async () => {
        const res = await tasksApi().tasks.get({ tasklist: id, task: taskId });
        return slimTask(res.data);
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a new task in a task list.",
      inputSchema: {
        tasklistId,
        title: z.string().describe("Task title"),
        notes: z.string().optional().describe("Free-form notes/details"),
        due: z.string().optional().describe(dueDescription),
        parent: z
          .string()
          .optional()
          .describe("Parent task ID, to create this task as a subtask"),
      },
    },
    async ({ tasklistId: id, title, notes, due, parent }) =>
      run(async () => {
        const res = await mutate(() => tasksApi().tasks.insert({
          tasklist: id,
          parent,
          requestBody: { title, notes, due },
        }), (r) => ({ listId: id, task: r.data }));
        return slimTask(res.data);
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update fields of an existing task. Only the provided fields are changed.",
      inputSchema: {
        tasklistId,
        taskId: z.string().describe("ID of the task to update"),
        title: z.string().optional(),
        notes: z.string().optional(),
        due: z.string().optional().describe(dueDescription),
        status: z
          .enum(["needsAction", "completed"])
          .optional()
          .describe("Task status"),
      },
    },
    async ({ tasklistId: id, taskId, title, notes, due, status }) =>
      run(async () => {
        const res = await mutate(() => tasksApi().tasks.patch({
          tasklist: id,
          task: taskId,
          requestBody: { title, notes, due, status },
        }), (r) => ({ listId: id, task: r.data }));
        return slimTask(res.data);
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as completed.",
      inputSchema: {
        tasklistId,
        taskId: z.string().describe("ID of the task to complete"),
      },
    },
    async ({ tasklistId: id, taskId }) =>
      run(async () => {
        const res = await mutate(() => tasksApi().tasks.patch({
          tasklist: id,
          task: taskId,
          requestBody: { status: "completed" },
        }), (r) => ({ listId: id, task: r.data }));
        return slimTask(res.data);
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a task. This cannot be undone.",
      inputSchema: {
        tasklistId,
        taskId: z.string().describe("ID of the task to delete"),
      },
    },
    async ({ tasklistId: id, taskId }) =>
      run(async () => {
        await mutate(() => tasksApi().tasks.delete({ tasklist: id, task: taskId }),
          () => ({ listId: id, deletedId: taskId }));
        return { deleted: taskId };
      }),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description:
        "Reorder a task or change its parent (make it a subtask or top-level task).",
      inputSchema: {
        tasklistId,
        taskId: z.string().describe("ID of the task to move"),
        parent: z
          .string()
          .optional()
          .describe("New parent task ID; omit to make it a top-level task"),
        previous: z
          .string()
          .optional()
          .describe(
            "Sibling task ID to place this task after; omit to move it first",
          ),
      },
    },
    async ({ tasklistId: id, taskId, parent, previous }) =>
      run(async () => {
        const res = await mutate(() => tasksApi().tasks.move({
          tasklist: id,
          task: taskId,
          parent,
          previous,
        }), (r) => ({ listId: id, task: r.data }));
        return slimTask(res.data);
      }),
  );

  server.registerTool(
    "clear_completed_tasks",
    {
      title: "Clear completed tasks",
      description:
        "Hide all completed tasks in a task list (they remain in Google Tasks history).",
      inputSchema: { tasklistId },
    },
    async ({ tasklistId: id }) =>
      run(async () => {
        await mutate(() => tasksApi().tasks.clear({ tasklist: id }));
        return { cleared: id };
      }),
  );
}
