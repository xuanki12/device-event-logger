import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { withRetry } from "../lib/db.ts";

const push = new Hono<{ Bindings: Env; Variables: Vars }>();

push.post("/schedule", async (c) => {
  const sql = c.var.sql;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const { content, delay_minutes } = body as Record<string, unknown>;
  if (!content || typeof content !== "string") {
    return c.json({ error: "Missing content" }, 400);
  }
  const delay = typeof delay_minutes === "number" ? delay_minutes : 0;
  const sendAt = new Date(Date.now() + delay * 60000).toISOString();
  try {
    await withRetry(() =>
      sql`INSERT INTO push_messages (content, send_at, sent) VALUES (${content}, ${sendAt}, false)`
    );
    return c.json({ ok: true, send_at: sendAt });
  } catch (e) {
    console.error("DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

push.get("/pending", async (c) => {
  const sql = c.var.sql;
  try {
    const rows = await sql`SELECT * FROM push_messages WHERE sent = false ORDER BY send_at`;
    return c.json({ messages: rows });
  } catch (e) {
    console.error("DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

export { push };
