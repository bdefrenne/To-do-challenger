/*
  POST /api/telegram/link
    Mint a one-time link code for the logged-in user and return a t.me
    deep link. The user taps it, Telegram opens the bot with /start <code>,
    and the bot binds that chat to this user (see ../route.ts handleStart).
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { issueLinkCode } from "@/lib/db/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (_req: NextRequest, { userId }: AuthedCtx) => {
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  if (!bot) return error("Telegram bot is not configured (TELEGRAM_BOT_USERNAME).", 503);
  const code = await issueLinkCode(userId);
  return json({ url: `https://t.me/${bot}?start=${code}`, expiresInMinutes: 15 });
});
