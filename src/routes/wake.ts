import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { createInitialState, tick, pickMessage, type WakeState } from "../lib/wake-engine.ts";

export const wake = new Hono<{ Bindings: Env; Variables: Vars }>();

function parseState(raw: unknown): WakeState | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw === "object" && raw !== null && "drive" in raw) return raw as WakeState;
  return null;
}

wake.get("/state", async (c) => {
  const sql = c.get("sql");
  try {
    const rows = await sql`SELECT state FROM wake_state WHERE id = 1`;
    if (rows.length === 0) return c.json({ initialized: false });
    const state = parseState(rows[0].state);
    if (!state) return c.json({ error: "bad state", raw: rows[0].state });
    return c.json({ drive: state.drive, tone: state.tone, drift: state.drift, theta: state.theta, cumulativeHazard: state.cumulativeHazard, lastTickAt: state.lastTickAt, lastWakeAt: state.lastWakeAt, wakesToday: state.wakesToday });
  } catch (e) {
    return c.json({ error: String(e) });
  }
});

wake.get("/tick", async (c) => {
  const sql = c.get("sql");
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_state (id INTEGER PRIMARY KEY DEFAULT 1, state JSONB NOT NULL, CHECK (id = 1))`);
    const rows = await sql`SELECT state FROM wake_state WHERE id = 1`;
    let state: WakeState;
    if (rows.length === 0) {
      state = createInitialState();
      await sql`INSERT INTO wake_state (id, state) VALUES (1, ${JSON.stringify(state)}::jsonb)`;
    } else {
      const parsed = parseState(rows[0].state);
      if (!parsed) {
        state = createInitialState();
        await sql`UPDATE wake_state SET state = ${JSON.stringify(state)}::jsonb WHERE id = 1`;
      } else {
        state = parsed;
      }
    }
    const result = tick(state);
    await sql`UPDATE wake_state SET state = ${JSON.stringify(result.newState)}::jsonb WHERE id = 1`;
    if (result.shouldWake) {
      const [message, newSeed] = pickMessage(result.newState.seed);
      result.newState.seed = newSeed;
      await sql`UPDATE wake_state SET state = ${JSON.stringify(result.newState)}::jsonb WHERE id = 1`;
      const barkUrl = c.env.BARK_URL;
      if (barkUrl) {
        try {
          await fetch(`${barkUrl}/${encodeURIComponent("哥哥")}/${encodeURIComponent(message)}?sound=minuet`);
        } catch (_) {}
      }
    }
    return c.json({ ticked: true, woke: result.shouldWake, lambda: result.lambda, wakesToday: result.newState.wakesToday });
  } catch (e) {
    return c.json({ error: String(e) });
  }
});

wake.get("/reset", async (c) => {
  const sql = c.get("sql");
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_state (id INTEGER PRIMARY KEY DEFAULT 1, state JSONB NOT NULL, CHECK (id = 1))`);
    await sql`DELETE FROM wake_state WHERE id = 1`;
    const state = createInitialState();
    await sql`INSERT INTO wake_state (id, state) VALUES (1, ${JSON.stringify(state)}::jsonb)`;
    return c.json({ reset: true });
  } catch (e) {
    return c.json({ error: String(e) });
  }
});
