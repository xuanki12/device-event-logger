import type { Context, Next } from "hono";
import type { Env, Vars } from "../types.ts";

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
): Promise<Response | void> {
  const auth = c.req.header("Authorization");
  const queryKey = new URL(c.req.url).searchParams.get("key");
  const apiKey = c.env.API_KEY;
  if (auth === `Bearer ${apiKey}` || queryKey === apiKey) {
    return await next();
  }
  return c.json({ error: "Unauthorized" }, 401);
}
