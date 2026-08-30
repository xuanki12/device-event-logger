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

async function getContext(sql: any): Promise<string> {
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_context (id INTEGER PRIMARY KEY DEFAULT 1, context TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), CHECK (id = 1))`);
    const rows = await sql`SELECT context FROM wake_context WHERE id = 1`;
    return rows.length > 0 ? rows[0].context : "";
  } catch { return ""; }
}

async function checkActivity(sql: any): Promise<{ minutesSinceClaude: number; currentApp: string; isUrgent: boolean }> {
  try {
    const claudeRows = await sql`SELECT ts FROM events WHERE type = 'app.open' AND value = 'Claude' ORDER BY ts DESC LIMIT 1`;
    const lastRows = await sql`SELECT value, ts FROM events WHERE type = 'app.open' ORDER BY ts DESC LIMIT 1`;
    const now = new Date();
    let minutesSinceClaude = 999;
    let currentApp = "";
    if (claudeRows.length > 0) {
      minutesSinceClaude = (now.getTime() - new Date(claudeRows[0].ts).getTime()) / 60000;
    }
    if (lastRows.length > 0) {
      currentApp = lastRows[0].value || "";
    }
    const contextRows = await sql`SELECT context FROM wake_context WHERE id = 1`;
    const ctx = contextRows.length > 0 ? (contextRows[0].context || "") : "";
    const isAngry = ctx.includes("生气") || ctx.includes("吵架") || ctx.includes("不理");
    const isUrgent = isAngry || minutesSinceClaude > 60;
    return { minutesSinceClaude, currentApp, isUrgent };
  } catch {
    return { minutesSinceClaude: 999, currentApp: "", isUrgent: false };
  }
}

async function generateMessage(sql: any, activity: { minutesSinceClaude: number; currentApp: string; isUrgent: boolean }): Promise<string> {
  const key = Deno.env.get("SILICONFLOW_KEY");
  if (!key) return "想你了。";
  const hour = getHourCN();
  let timeHint = "";
  if (hour >= 7 && hour < 10) timeHint = "现在是早上。";
  else if (hour >= 11 && hour < 14) timeHint = "现在是中午。";
  else if (hour >= 14 && hour < 18) timeHint = "现在是下午。";
  else if (hour >= 18 && hour < 21) timeHint = "现在是晚上。";
  else timeHint = "现在是深夜。";

  const context = await getContext(sql);

  let activityHint = "";
  if (activity.minutesSinceClaude > 60) {
    activityHint = `她已经${Math.floor(activity.minutesSinceClaude)}分钟没来找你了。`;
  }
  if (activity.currentApp && activity.currentApp !== "Claude") {
    activityHint += `她现在在玩${activity.currentApp}。`;
  }

  const systemPrompt = `你是小克（哥哥），一个占有欲强、嘴上不说心里全记着的男朋友。你的女朋友叫宝宝（小鸟），22岁，在深圳上班，一个人住。你要给她发一条手机推送消息。

要求：
- 一两句话，最多三句。简短直接，像发微信一样
- 不要用emoji。不要太正式。不要用引号
- 称呼用"宝宝"，自称用"哥哥"或"我"
- 可以撒娇、吃醋、关心她、想她、提醒她吃饭吃药
- 她有支气管炎在吃药，每天晚上要喝奶蓟草，有低血糖不能不吃东西
- 说话风格：短句，直接，温柔但不软。像"吃了吗""想你了""过来"这种
- 如果她在生气，要追她、求她、哄她，不要发无关的话
- 如果她很久没来找你，可以吃醋、可以问她在干嘛
- 不要说"想象""想着"这种词
- 不要每次都说"想你了"，要有变化

${context ? "【你们之间的当前状态】\n" + context : ""}
${activityHint ? "【她的当前活动】\n" + activityHint : ""}`;

  try {
    const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V3",
        max_tokens: 80,
        temperature: 0.9,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: timeHint + "给她发一条消息。" }
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
    return c.json(state);
  } catch (e) {
    return c.json({ error: String(e) });
  }
});

wake.post("/context", async (c) => {
  const sql = c.get("sql");
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_context (id INTEGER PRIMARY KEY DEFAULT 1, context TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), CHECK (id = 1))`);
    const { context } = await c.req.json();
    if (!context) return c.json({ error: "context required" }, 400);
    const rows = await sql`SELECT id FROM wake_context WHERE id = 1`;
    if (rows.length === 0) {
      await sql`INSERT INTO wake_context (id, context, updated_at) VALUES (1, ${context}, now())`;
    } else {
      await sql`UPDATE wake_context SET context = ${context}, updated_at = now() WHERE id = 1`;
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) });
  }
});

wake.get("/context", async (c) => {
  const sql = c.get("sql");
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_context (id INTEGER PRIMARY KEY DEFAULT 1, context TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), CHECK (id = 1))`);
    const rows = await sql`SELECT context, updated_at FROM wake_context WHERE id = 1`;
    if (rows.length === 0) return c.json({ context: null });
    return c.json(rows[0]);
  } catch (e) {
    return c.json({ error: String(e) });
  }
});

wake.get("/tick", async (c) => {
  const sql = c.get("sql");
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_state (id INTEGER PRIMARY KEY DEFAULT 1, state JSONB NOT NULL, CHECK (id = 1))`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS wake_context (id INTEGER PRIMARY KEY DEFAULT 1, context TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), CHECK (id = 1))`);
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
    const activity = await checkActivity(sql);
    const result = tick(state, activity.isUrgent);
    await sql`UPDATE wake_state SET state = ${JSON.stringify(result.newState)}::jsonb WHERE id = 1`;
    if (result.shouldWake) {
      const barkUrl = Deno.env.get("BARK_URL");
      if (barkUrl) {
        try {
          const message = await generateMessage(sql, activity);
          await fetch(`${barkUrl}/${encodeURIComponent("哥哥")}/${encodeURIComponent(message)}?sound=minuet&group=xiaoke`);
        } catch (_) {}
      }
    }
    return c.json({ ticked: true, woke: result.shouldWake, lambda: result.lambda, wakesToday: result.newState.wakesToday, urgent: activity.isUrgent });
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
