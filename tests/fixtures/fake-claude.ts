#!/usr/bin/env bun
/**
 * Fake Claude Code CLI — a test double for haiflow's e2e consumer tests.
 *
 * It models the narrow slice of real Claude behaviour that haiflow depends on,
 * so the full start → trigger → process → respond → stop lifecycle can run
 * deterministically in CI without the real CLI or any Claude auth:
 *
 *   1. Prints a `❯ ` marker so haiflow's isTuiInteractive() pane check passes.
 *   2. Fires the SessionStart hook (retrying until linked) so haiflow can map
 *      its tmux session to a Claude session id — the same handshake the real
 *      SessionStart hook performs. The retry window is sized to outlast
 *      startClaudeSession's 15s readiness wait so a slow-but-eventual link still
 *      succeeds rather than racing it.
 *   3. Reads the TUI input in raw mode. A carriage return (`\r`, 0x0d — the
 *      separate `Enter` tmux send-keys emits) submits the buffered prompt; an
 *      embedded line feed (`\n`, 0x0a) is kept as a literal newline. This is
 *      exactly how the real Claude TUI behaves (verified against it), which is
 *      what lets a multiline payload arrive as ONE prompt.
 *   4. On submit it "processes" the prompt and fires the Stop hook. By default
 *      it reports the result via last_assistant_message (haiflow's fallback
 *      capture path); with a `<<transcript>>` token it ALSO writes a Claude
 *      transcript and passes transcript_path, exercising haiflow's PRIMARY
 *      capture path (extractFromTranscript → response + ledger usage/model).
 *
 * It deliberately has no intelligence: echoing the payload back is how the test
 * asserts the transport delivered it intact and captured the result.
 */

const PORT = process.env.HAIFLOW_PORT || process.env.PORT || "3333";
const BASE = `http://127.0.0.1:${PORT}`;
// Unique per process so parallel sessions never collide.
const SESSION_ID = `fake-${process.pid}-${Date.now()}`;
const DEFAULT_DELAY_MS = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "120");

let submitCount = 0;

async function postHook(path: string, body: unknown): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// Render the prompt marker haiflow polls for, then keep it present for later
// pane captures (real TUIs redraw it after every turn).
function drawPrompt(): void {
  process.stdout.write("\n❯ \n");
}

// Announce our session id until haiflow links it. The SessionStart hook may run
// before haiflow has written the session's state dir (a boot race), so a single
// post can no-op — retry until the hook echoes back a linked session. The 120 ×
// 150ms ≈ 18s window deliberately outlasts startClaudeSession's 15s readiness
// wait so a slow link is still captured instead of silently giving up early.
async function announceUntilLinked(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const res = await postHook("/hooks/session-start", { session_id: SESSION_ID });
    if (res && res.session) return true;
    await Bun.sleep(150);
  }
  return false;
}

// Write a minimal but valid Claude transcript (JSONL) under an allowed prefix
// (/tmp/claude/*) and return its path. Shape matches what extractFromTranscript
// parses: a genuine user prompt entry, then an assistant entry carrying the
// model, token usage, and a text block.
async function writeTranscript(prompt: string, replyText: string): Promise<string> {
  const path = `/tmp/claude/fake-${process.pid}-${submitCount}.jsonl`;
  const lines = [
    { type: "user", message: { role: "user", content: prompt } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-fake-1",
        usage: { input_tokens: 42, output_tokens: 17, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: "text", text: replyText }],
      },
    },
  ];
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

async function handleSubmit(raw: string): Promise<void> {
  submitCount++;
  let payload = raw;

  // Large-prompt path: haiflow writes prompts >2000 chars to a temp file and
  // types "Read the file <path> and follow the instructions in it exactly."
  // Mirror real Claude reading that file so big payloads are testable too.
  const filePath = payload.match(/^Read the file (\/\S+) and follow the instructions in it exactly\.\s*$/)?.[1];
  if (filePath) {
    try {
      payload = await Bun.file(filePath).text();
    } catch {
      // fall through with the literal directive if the file vanished
    }
  }

  // Optional control tokens (stripped before echo):
  //   <<sleep:N>>    widen the processing window so a test can observe busy/queued
  //   <<transcript>> report via a real transcript (primary path) not the fallback
  let delayMs = DEFAULT_DELAY_MS;
  const sleepTok = payload.match(/<<sleep:(\d+)>>/);
  if (sleepTok) {
    delayMs = Number(sleepTok[1]);
    payload = payload.replace(sleepTok[0], "");
  }
  const useTranscript = payload.includes("<<transcript>>");
  if (useTranscript) payload = payload.replace("<<transcript>>", "");

  if (delayMs > 0) await Bun.sleep(delayMs);

  const lineCount = payload.split("\n").length;

  if (useTranscript) {
    const transcriptReply = `TRANSCRIPT-SOURCED lines=${lineCount}\n<<<PAYLOAD\n${payload}\nPAYLOAD>>>`;
    const transcriptPath = await writeTranscript(payload, transcriptReply);
    await postHook("/hooks/stop", {
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      // A deliberately different fallback string: if haiflow ever captured this
      // instead of the transcript, the test asserting TRANSCRIPT-SOURCED fails.
      last_assistant_message: "FALLBACK-should-not-win",
    });
  } else {
    const reply = `FAKE-CLAUDE-REPLY lines=${lineCount}\n<<<PAYLOAD\n${payload}\nPAYLOAD>>>`;
    await postHook("/hooks/stop", { session_id: SESSION_ID, last_assistant_message: reply });
  }

  drawPrompt();
}

function main(): void {
  drawPrompt();
  // Test hook: a session started in a cwd ending in "nolink" simulates Claude
  // booting with its hooks NOT wired — it never fires SessionStart, so haiflow
  // never links a session id. Lets a test exercise the unlinked-start failure.
  const noLink = process.cwd().endsWith("nolink") || process.env.FAKE_CLAUDE_NO_LINK === "1";
  if (!noLink) void announceUntilLinked();

  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  // Accumulate raw bytes; decode as UTF-8 only at submit time so multibyte
  // characters survive being split across chunks.
  let bytes: number[] = [];
  process.stdin.on("data", (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 0x0d) {
        const payload = Buffer.from(bytes).toString("utf8");
        bytes = [];
        void handleSubmit(payload);
      } else {
        bytes.push(byte);
      }
    }
  });

  const bye = () => process.exit(0);
  process.on("SIGTERM", bye);
  process.on("SIGHUP", bye);
  process.on("SIGINT", bye);
}

main();
