import { createApp } from "../src/app.ts";

const app = createApp();
const port = parseInt(Deno.env.get("PORT") ?? "8000");

const server = Deno.serve({ port }, (req) =>
  app.fetch(req, {
    API_KEY: Deno.env.get("API_KEY") ?? "",
    DATABASE_URL: Deno.env.get("DATABASE_URL") ?? "",
    TZ_OFFSET: Deno.env.get("TZ_OFFSET"),
  })
);

setInterval(async () => {
  try {
    await fetch(`http://localhost:${port}/wake/tick`);
  } catch (e) {
    console.error("[wake] internal tick failed:", e);
  }
}, 60_000);

setTimeout(async () => {
  try {
    await fetch(`http://localhost:${port}/wake/tick`);
    console.log("[wake] initial tick done");
  } catch (e) {
    console.error("[wake] initial tick failed:", e);
  }
}, 3_000);
