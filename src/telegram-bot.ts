#!/usr/bin/env bun
/**
 * Telegram → haiflow bridge.
 *
 * Long-polls Telegram for messages, forwards each as a prompt to haiflow's
 * /trigger endpoint, streams the response back via /responses/:id/stream,
 * and replies in the same chat.
 *
 * Run with `haiflow telegram` or `bun run src/telegram-bot.ts`.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const API_KEY = process.env.HAIFLOW_API_KEY?.trim();
const HAIFLOW_URL = (process.env.HAIFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3333}`).replace(/\/+$/, "");
const SESSION = process.env.TELEGRAM_SESSION?.trim() || "default";
const RESPONSE_TIMEOUT = Math.min(Number(process.env.TELEGRAM_RESPONSE_TIMEOUT ?? 300), 600);
const ALLOWED_CHATS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required. Create a bot with @BotFather and set it in your .env.");
  process.exit(1);
}
if (!API_KEY) {
  console.error("HAIFLOW_API_KEY is required so the bot can call haiflow's authenticated endpoints.");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_MAX_LEN = 4096;

const HELP_TEXT = [
  "👋 I forward your messages to Claude Code via haiflow.",
  "",
  "Send any message and I'll run it as a prompt, then reply with Claude's response.",
  "Slash commands you have configured (e.g. /daily-update) work too.",
  "",
  `Session: ${SESSION}`,
].join("\n");

interface TelegramMessage {
  chat?: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type StreamResult =
  | { ok: true; messages: string[] }
  | { ok: false; error: string };

// --- Structured logging (matches src/index.ts) ---

function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

// --- Telegram API ---

async function tg(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

async function sendMessage(chatId: number, text: string) {
  const body = text.trim() || "✅ Done (no text output).";
  // Telegram caps messages at 4096 chars — split long replies into chunks.
  for (let i = 0; i < body.length; i += TELEGRAM_MAX_LEN) {
    await tg("sendMessage", { chat_id: chatId, text: body.slice(i, i + TELEGRAM_MAX_LEN) });
  }
}

async function sendTyping(chatId: number) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    // Non-fatal — typing indicator is cosmetic.
  }
}

// --- haiflow API ---

function haiflow(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${HAIFLOW_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function triggerPrompt(prompt: string): Promise<{ status: number; data: any }> {
  const res = await haiflow("/trigger", {
    method: "POST",
    body: JSON.stringify({ prompt, session: SESSION, source: "telegram" }),
  });
  return { status: res.status, data: await res.json() };
}

async function streamResponse(taskId: string, chatId: number): Promise<StreamResult> {
  const res = await haiflow(
    `/responses/${encodeURIComponent(taskId)}/stream?session=${encodeURIComponent(SESSION)}&timeout=${RESPONSE_TIMEOUT}`
  );
  if (!res.ok || !res.body) return { ok: false, error: `Stream request failed (${res.status})` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const event = block.match(/^event:\s*(.*)$/m)?.[1]?.trim();
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!event) continue;
      if (event === "complete") {
        try {
          const payload = JSON.parse(data);
          return { ok: true, messages: payload.messages ?? [] };
        } catch {
          return { ok: false, error: "Failed to parse haiflow response" };
        }
      }
      if (event === "error") {
        let message = "Session error";
        try {
          message = JSON.parse(data).error ?? message;
        } catch {
          // keep default
        }
        return { ok: false, error: message };
      }
      if (event === "timeout") return { ok: false, error: "timeout" };
      if (event === "status") await sendTyping(chatId);
    }
  }

  return { ok: false, error: "Stream ended without a response" };
}

// --- Message handling ---

async function handleMessage(message: TelegramMessage) {
  const chatId = message.chat?.id;
  const text = message.text?.trim();
  if (!chatId || !text) return;

  if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(String(chatId))) {
    log("warn", "chat_rejected", { chatId });
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, HELP_TEXT);
    return;
  }

  log("info", "prompt_received", { chatId, length: text.length });
  await sendTyping(chatId);

  let triggered: { status: number; data: any };
  try {
    triggered = await triggerPrompt(text);
  } catch (e) {
    await sendMessage(chatId, `⚠️ Couldn't reach haiflow at ${HAIFLOW_URL}. Is the server running?`);
    log("error", "trigger_error", { chatId, error: String(e) });
    return;
  }

  const { status, data } = triggered;
  if (status === 503) {
    await sendMessage(chatId, `⚠️ Session "${SESSION}" is offline. Start it with:\nhaiflow start ${SESSION} --cwd <path>`);
    return;
  }
  if (status >= 400) {
    await sendMessage(chatId, `⚠️ ${data.error ?? "Trigger failed"}`);
    return;
  }

  if (data.queued) {
    await sendMessage(chatId, `⏳ Claude is busy — queued at position ${data.position}. I'll reply when it's done.`);
  }

  const result = await streamResponse(data.id, chatId);
  if (result.ok) {
    await sendMessage(chatId, result.messages.join("\n\n"));
    log("info", "reply_sent", { chatId, taskId: data.id });
  } else if (result.error === "timeout") {
    await sendMessage(
      chatId,
      `⏱️ Still working after ${RESPONSE_TIMEOUT}s. It keeps running — check later with:\nhaiflow responses ${data.id} --session ${SESSION}`
    );
  } else {
    await sendMessage(chatId, `⚠️ ${result.error}`);
  }
}

// --- Long-poll loop ---

async function poll() {
  log("info", "telegram_bot_started", {
    haiflow: HAIFLOW_URL,
    session: SESSION,
    allowlist: ALLOWED_CHATS.size || "open",
  });
  if (ALLOWED_CHATS.size === 0) {
    log("warn", "no_allowlist", {
      message: "TELEGRAM_ALLOWED_CHAT_IDS is empty — the bot will respond to anyone. Set it to lock down access.",
    });
  }

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (!data.ok) {
        log("error", "get_updates_failed", { description: data.description });
        await Bun.sleep(3000);
        continue;
      }
      for (const update of data.result as TelegramUpdate[]) {
        offset = update.update_id + 1;
        if (!update.message) continue;
        // Handle concurrently so a long task doesn't block other chats.
        handleMessage(update.message).catch((e) => log("error", "handle_error", { error: String(e) }));
      }
    } catch (e) {
      log("error", "poll_error", { error: String(e) });
      await Bun.sleep(3000);
    }
  }
}

poll();
