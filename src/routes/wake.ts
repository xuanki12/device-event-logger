import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { createInitialState, tick, pickMessage, type WakeState } from "../lib/wake-engine.ts";

export const wake = new Hono<{ Bindings: Env; Variables: Vars }>();

function parseState(raw: unknown): WakeState | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw as WakeState;
}

wake.get("/state", async (c) => {
  const sql = c.get("sql");
  const rows = await sql`SELECT state FROM wake_state WHERE id = 1`;
  if (rows.length === 0) return c.json({ initialized: false });
  const state = parseState(rows[0].state);
  if (!state) return c.json({ error: "invalid state" });
  return c.json({
    drive: state.drive.toFixed(3), tone: state.tone.toFixed(3),
    drift: state.drift.toFixed(3), theta: state.theta.toFixed(3),
    cumulativeHazard: state.cumulativeHazard.toFixed(3),
    lastTickAt: state.lastTickAt, lastWakeAt: state.lastWakeAt,
    wakesToday: state.wakesToday,
  });
});

wake.get("/tick", async (c) => {
  const sql = c.get("sql");
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS wake_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      state JSONB NOT NULL,
      CHECK (id = 1)
    )
  `);
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
        const pushUrl = `${barkUrl}/${encodeURIComponent("哥哥")}/${encodeURIComponent(message)}?sound=minuet`;
        await fetch(pushUrl);
        console.log(`[wake] pushed: "${message}" λ=${result.lambda.toFixed(2)}`);
      } catch (e) {
        console.error("[wake] push failed:", e);
      }
    }
  }

  return c.json({
    ticked: true, woke: result.shouldWake,
    lambda: result.lambda.toFixed(3),
    drive: result.newState.drive.toFixed(3),
    tone: result.newState.tone.toFixed(3),
    drift: result.newState.drift.toFixed(3),
    H: result.newState.cumulativeHazard.toFixed(3),
    theta: result.newState.theta.toFixed(3),
    wakesToday: result.newState.wakesToday,
  });
});

wake.post("/reset", async (c) => {
  const sql = c.get("sql");
  const state = createInitialState();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS wake_state (
      id INTEGER PRIMARY KEY DEFAULT 1, state JSONB NOT NULL, CHECK (id = 1)
    )
  `);
  await sql`DELETE FROM wake_state WHERE id = 1`;
  await sql`INSERT INTO wake_state (id, state) VALUES (1, ${JSON.stringify(state)}::jsonb)`;
  return c.json({ reset: true, state });
});
