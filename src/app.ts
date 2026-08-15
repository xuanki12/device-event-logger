import { Hono } from "hono";
import type { Env, Vars } from "./types.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { createSql } from "./lib/db.ts";
import { parseOffsetEnv } from "./lib/timezone.ts";
import { events } from "./routes/events.ts";
import { mcp } from "./routes/mcp.ts";
import { push } from "./push.ts";
import type postgres from "postgres";

export type AppOptions = {
    postgresOptions?: Record<string, unknown>;
};

export function createApp(options?: AppOptions) {
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();

    let sqlInstance: postgres.Sql | null = null;
    let cachedOffsetMinutes: number | null = null;
    let pushTimerStarted = false;

    // CORS
    app.use("*", corsMiddleware);

    // Global error handler
    app.onError((err, c) => {
        console.error("Unexpected error:", err);
        return c.json({ error: "Internal server error" }, 500);
    });

    // 404 handler
    app.notFound((c) => {
        return c.json({ error: "Not found" }, 404);
    });

    // DB + timezone injection
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
                    content TEXT NOT NULL,
                    send_at TIMESTAMPTZ NOT NULL,
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

        if (!pushTimerStarted && sqlInstance) {
            pushTimerStarted = true;
            startPushTimer(sqlInstance, c.env.BARK_URL ?? "");
        }

        await next();
    });

    // Routes
    app.route("/events", (() => {
        const group = new Hono<{ Bindings: Env; Variables: Vars }>();
        group.use("*", authMiddleware);
        group.route("/", events);
        return group;
    })());

    app.route("/mcp", mcp);
    app.route("/push", push);

    return app;
}

function startPushTimer(sql: postgres.Sql, barkUrl: string) {
    if (!barkUrl) {
        console.log("BARK_URL not set, push disabled");
        return;
    }
    console.log("Push timer started");
    setInterval(async () => {
        try {
            const now = new Date().toISOString();
            const rows = await sql`
                SELECT id, content FROM push_messages
                WHERE sent = false AND send_at <= ${now}
                ORDER BY send_at LIMIT 5
            `;
            for (const row of rows) {
                try {
                    const encoded = encodeURIComponent(row.content);
                    const resp = await fetch(`${barkUrl}/${encoded}`);
                    if (resp.ok) {
                        await sql`UPDATE push_messages SET sent = true WHERE id = ${row.id}`;
                        console.log(`Pushed: ${row.content}`);
                    }
                } catch (e) {
                    console.error("Push failed:", e);
                }
            }
        } catch (e) {
            console.error("Push timer error:", e);
        }
    }, 60000);
}
