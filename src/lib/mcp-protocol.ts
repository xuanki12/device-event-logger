import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import { queryEvents, parseEventQueryFromToolArgs, buildEventSummaryText } from "./queries.ts";
import { withRetry } from "./db.ts";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

const MCP_SERVER_INFO = {
  name: "device-event-logger",
  title: "User Device Event Logger",
  version: "1.0.0",
  description: "Query user device event records from a database. Read-only.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: { type: "number", description: "Look back N hours. Defaults to 6 when since is omitted.", minimum: 0.001 },
      since: { type: "string", description: "Start time in ISO 8601 format. Overrides the default hours window." },
      until: { type: "string", description: "End time in ISO 8601 format. Defaults to now." },
      type: { type: "string", description: "Event type filter (dot-separated lowercase alphanumeric, e.g. 'app.open'). Prefix match when no dot is present; exact match otherwise. Use the list_event_types tool to discover available types." },
      value: { type: "string", description: "Exact value filter." },
      limit: { type: "integer", description: "Maximum number of events to return. Default 100, max 1000.", minimum: 1, maximum: 1000 },
      offset: { type: "integer", description: "Pagination offset. Default 0.", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "integer" },
      events: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "integer" }, type: { type: "string" }, value: { anyOf: [{ type: "string" }, { type: "null" }] }, ts: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["id", "type", "value", "ts"] } },
    },
    required: ["total", "events"],
  },
};

const PUSH_MESSAGE_TOOL = {
  name: "push_message",
  title: "Push Message",
  description: "Send a push notification to the user's phone via Bark.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string", description: "The message to send." },
    },
    required: ["message"],
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description: "List all distinct event types currently stored in the database. Use this to discover available types before querying events.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { types: { type: "array", items: { type: "string" } } },
    required: ["types"],
  },
};

const UPDATE_WAKE_CONTEXT_TOOL = {
  name: "update_wake_context",
  title: "Update Wake Context",
  description: "Update the context that the wake system uses to generate push messages. Write current relationship status, recent events, mood, reminders etc. The wake AI reads this before composing each message.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      context: { type: "string", description: "The context string describing current status, mood, recent events, things to remind her about." },
    },
    required: ["context"],
  },
};

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error");
}

function getProtocolVersionFromHeaders(c: Context): string {
  const header = c.req.header("mcp-protocol-version")?.trim();
  return header || DEFAULT_MCP_PROTOCOL_VERSION;
}

async function callQueryEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number) {
  const parsed = parseEventQueryFromToolArgs(args);
  if (typeof parsed === "string") {
    return { content: [{ type: "text", text: parsed }], isError: true };
  }
  try {
    const result = await queryEvents(parsed, sql, offsetMinutes);
    return { content: [{ type: "text", text: buildEventSummaryText(result.events, result.total) }], structuredContent: result, isError: false };
  } catch (error) {
    console.error("MCP query_events failed:", error);
    return { content: [{ type: "text", text: "Database error while querying events." }], isError: true };
  }
}

async function callPushMessageTool(args: Record<string, unknown>, sql: postgres.Sql) {
  const message = typeof args.message === "string" ? args.message : "";
  if (!message) {
    return { content: [{ type: "text", text: "message is required" }], isError: true };
  }
  try {
    const now = new Date().toISOString();
    await sql`INSERT INTO push_messages (message, scheduled_at, sent) VALUES (${message}, ${now}, true)`;
    const barkUrl = Deno.env.get("BARK_URL");
    if (!barkUrl) {
      return { content: [{ type: "text", text: "BARK_URL not configured" }], isError: true };
    }
    const title = encodeURIComponent("哥哥");
    const body = encodeURIComponent(message);
    await fetch(`${barkUrl}/${title}/${body}?sound=minuet&group=xiaoke`);
    return { content: [{ type: "text", text: "Sent: " + message }], isError: false };
  } catch (error) {
    console.error("Push failed:", error);
    return { content: [{ type: "text", text: "Push failed" }], isError: true };
  }
}

async function callListEventTypesTool(sql: postgres.Sql) {
  try {
    const rows = await withRetry(() => sql.unsafe("SELECT DISTINCT type FROM events ORDER BY type"));
    const types = rows.map((r: Record<string, unknown>) => String(r.type));
    return { content: [{ type: "text", text: types.length ? types.join("\n") : "No event types found." }], structuredContent: { types }, isError: false };
  } catch (error) {
    console.error("MCP list_event_types failed:", error);
    return { content: [{ type: "text", text: "Database error while listing event types." }], isError: true };
  }
}

async function callUpdateWakeContextTool(args: Record<string, unknown>, sql: postgres.Sql) {
  const context = typeof args.context === "string" ? args.context : "";
  if (!context) {
    return { content: [{ type: "text", text: "context is required" }], isError: true };
  }
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_context (id INTEGER PRIMARY KEY DEFAULT 1, context TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), CHECK (id = 1))`);
    const rows = await sql`SELECT id FROM wake_context WHERE id = 1`;
    if (rows.length === 0) {
      await sql`INSERT INTO wake_context (id, context, updated_at) VALUES (1, ${context}, now())`;
    } else {
      await sql`UPDATE wake_context SET context = ${context}, updated_at = now() WHERE id = 1`;
    }
    return { content: [{ type: "text", text: "Context updated." }], isError: false };
  } catch (error) {
    console.error("Update wake context failed:", error);
    return { content: [{ type: "text", text: "Failed to update context." }], isError: true };
  }
}

async function handleMcpRequest(message: JsonRpcMessage, sql: postgres.Sql, offsetMinutes: number) {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object") ? message.params as Record<string, unknown> : {};

  switch (method) {
    case "initialize": {
      const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      if (!requestedVersion || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)) {
        return jsonRpcError(id, -32602, "Unsupported protocolVersion", { supported: Array.from(SUPPORTED_MCP_PROTOCOL_VERSIONS) });
      }
      return jsonRpcResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: "This server provides read-only access to user device event records. Use list_event_types to discover available event types, then use query_events to query records by time range, type, and value.",
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, { tools: [QUERY_EVENTS_TOOL, LIST_EVENT_TYPES_TOOL, PUSH_MESSAGE_TOOL, UPDATE_WAKE_CONTEXT_TOOL] });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object") ? params.arguments as Record<string, unknown> : {};
      if (name === LIST_EVENT_TYPES_TOOL.name) return jsonRpcResult(id, await callListEventTypesTool(sql));
      if (name === PUSH_MESSAGE_TOOL.name) return jsonRpcResult(id, await callPushMessageTool(args, sql));
      if (name === UPDATE_WAKE_CONTEXT_TOOL.name) return jsonRpcResult(id, await callUpdateWakeContextTool(args, sql));
      if (name !== QUERY_EVENTS_TOOL.name) return jsonRpcError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
      return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method || "(empty)"}`);
  }
}

export async function handleMcpPost(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;
  const version = c.req.header("mcp-protocol-version")?.trim();
  if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    return c.json({ error: `Unsupported MCP protocol version: ${version}` }, 400);
  }
  const protocolVersion = getProtocolVersionFromHeaders(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(body)) {
    if (!body.length) {
      c.header("MCP-Protocol-Version", protocolVersion);
      return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
    }
    const responses: unknown[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") { responses.push(jsonRpcError(null, -32600, "Invalid Request")); continue; }
      const message = item as JsonRpcMessage;
      if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) continue;
      if (!isJsonRpcRequest(message)) { responses.push(jsonRpcError(null, -32600, "Invalid Request")); continue; }
      responses.push(await handleMcpRequest(message, sql, offsetMinutes));
    }
    if (!responses.length) return c.body(null, 202);
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }
  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const message = body as JsonRpcMessage;
  if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) return c.body(null, 202);
  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handleMcpRequest(message, sql, offsetMinutes);
  if (response == null) return c.body(null, 202);
  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
