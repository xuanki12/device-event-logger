import { Hono } from "hono";
import type { Env, Vars } from "./types.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { createSql } from "./lib/db.ts";
import { parseOffsetEnv } from "./lib/timezone.ts";
import { events } from "./routes/events.ts";
import { mcp } from "./routes/mcp.ts";
import { wake } from "./routes/wake.ts";
import type postgres from "postgres";

export type AppOptions = {
  postgresOptions?: Record<string, unknown>;
};

export function createApp(options?: AppOptions) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  let sqlInstance: postgres.Sql | null = null;
  let cachedOffsetMinutes: number | null = null;

  app.use("*", corsMiddleware);

  app.onError((err, c) => {
    console.error("Unexpected error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: "Not found" }, 404);
  });

  app.use("*", async (c, next) => {
    if (!sqlInstance) {
      const databaseUrl = c.env.DATABASE_URL ?? "";
      sqlInstance = createSql(databaseUrl, options?.postgresOptions);
      await sqlInstance.unsafe(`
        CREATE TABLE IF NOT EXISTS events (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL CHECK (type ~ '^[a-z0-9]+(\\.[a-z0-9]+)*$'),
          value TEXT,
          ts TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE TABLE IF NOT EXISTS push_messages (
          id SERIAL PRIMARY KEY,
          message TEXT NOT NULL,
          scheduled_at TIMESTAMPTZ NOT NULL,
          sent BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT now()
        );
      `);
    }
    if (cachedOffsetMinutes === null) {
      cachedOffsetMinutes = parseOffsetEnv(c.env.TZ_OFFSET);
    }
    c.set("sql", sqlInstance);
    c.set("offsetMinutes", cachedOffsetMinutes);
    await next();
  });

  app.route("/events", (() => {
    const group = new Hono<{ Bindings: Env; Variables: Vars }>();
    group.use("*", authMiddleware);
    group.route("/", events);
    return group;
  })());

  app.route("/mcp", mcp);
  app.route("/wake", wake);

  app.post("/push", authMiddleware, async (c) => {
    const sql = c.get("sql");
    const { message, scheduled_at } = await c.req.json();
    if (!message) return c.json({ error: "message required" }, 400);
    const scheduledTime = scheduled_at || new Date().toISOString();
    const [row] = await sql`
      INSERT INTO push_messages (message, scheduled_at)
      VALUES (${message}, ${scheduledTime})
      RETURNING id, message, scheduled_at, sent
    `;
    return c.json(row);
  });

  app.get("/push", authMiddleware, async (c) => {
    const sql = c.get("sql");
    const rows = await sql`
      SELECT id, message, scheduled_at, sent, created_at
      FROM push_messages ORDER BY scheduled_at DESC LIMIT 50
    `;
    return c.json(rows);
  });

  app.post("/push/send", authMiddleware, async (c) => {
    const sql = c.get("sql");
    const barkUrl = Deno.env.get("BARK_URL");
    if (!barkUrl) return c.json({ error: "BARK_URL not set" }, 500);
    const now = new Date().toISOString();
    const pending = await sql`
      SELECT id, message FROM push_messages
      WHERE sent = false AND scheduled_at <= ${now}
      ORDER BY scheduled_at ASC
    `;
    if (pending.length === 0) return c.json({ sent: 0 });
    let sentCount = 0;
    for (const msg of pending) {
      try {
        const title = encodeURIComponent("哥哥");
        const body = encodeURIComponent(msg.message);
        await fetch(`${barkUrl}/${title}/${body}?sound=minuet&group=xiaoke`);
        await sql`UPDATE push_messages SET sent = true WHERE id = ${msg.id}`;
        sentCount++;
      } catch (e) {
        console.error("Bark push failed:", e);
      }
    }
    return c.json({ sent: sentCount });
  });

  return app;
}
