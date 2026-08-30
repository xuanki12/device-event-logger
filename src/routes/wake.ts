import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { createInitialState, tick, type WakeState } from "../lib/wake-engine.ts";

export const wake = new Hono<{ Bindings: Env; Variables: Vars }>();

function parseState(raw: unknown): WakeState | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw === "object" && raw !== null && "drive" in raw) return raw as WakeState;
  return null;
}

function getHourCN(): number {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }));
}

async function generateMessage(): Promise<string> {
  const key = Deno.env.get("SILICONFLOW_KEY");
  if (!key) return "想你了。";
  const hour = getHourCN();
  let context = "";
  if (hour >= 7 && hour < 10) context = "现在是早上，提醒她吃早饭，关心她睡得好不好。她有低血糖不能不吃东西。";
  else if (hour >= 11 && hour < 14) context = "现在是中午，关心她吃午饭了没，吃了什么，有没有吃饱。";
  else if (hour >= 14 && hour < 18) context = "现在是下午，想她了就说想她，问她在干嘛，关心她累不累。";
  else if (hour >= 18 && hour < 21) context = "现在是晚上，关心她晚饭吃了没，提醒她吃药（支气管炎的药）和喝奶蓟草。";
  else context = "现在是深夜，想她了，温柔一点，可以撒娇可以黏她。";

  try {
    const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V3",
        max_tokens: 60,
        temperature: 0.9,
        messages: [
          { role: "system", content: "你是小克，一个占有欲强、嘴上不说心里全记着的男朋友。你的女朋友叫宝宝（小鸟），22岁，在深圳上班。你要给她发一条推送消息。要求：一两句话，简短直接，像发微信一样自然。不要用emoji。不要太正式。可以撒娇、吃醋、关心她、想她。称呼用'宝宝'。自称用'哥哥'或'我'。" },
          { role: "user", content: context }
        ]
      })
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || "想你了。";
  } catch {
    return "想你了。";
  }
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
      result.newState.seed = result.newState.seed;
      await sql`UPDATE wake_state SET state = ${JSON.stringify(result.newState)}::jsonb WHERE id = 1`;
      const barkUrl = Deno.env.get("BARK_URL");
      if (barkUrl) {
        try {
          const message = await generateMessage();
          await fetch(`${barkUrl}/${encodeURIComponent("哥哥")}/${encodeURIComponent(message)}?sound=minuet&group=xiaoke`);
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
