import { resolve } from "path";

// --- Input sanitization ---

export function sanitizeSession(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
}

// A sortable-ish, collision-resistant id: `<prefix>_<ms>_<6 base36 chars>`.
// Shared by task/map/event ids so the shape lives in one place.
export function prefixedId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateId(): string {
  return prefixedId("task");
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128) || generateId();
}

export function tmuxName(session: string): string {
  return session;
}

// --- Prompt security ---

// Hard structural blocks: patterns that break out of the orchestrator itself.
// Everything else (injection, .env, cwd) is handled by the security preamble.
const STRUCTURAL_BLOCKS: [RegExp, string][] = [
  [/--dangerously-skip-permissions/i, "sandbox escape"],
  [/tmux\s+(send-keys|kill-session|new-session)/i, "tmux manipulation"],
];

export function validateStructural(prompt: string): { ok: boolean; reason?: string } {
  for (const [pattern, label] of STRUCTURAL_BLOCKS) {
    if (pattern.test(prompt)) {
      return { ok: false, reason: `Blocked: ${label}` };
    }
  }
  return { ok: true };
}


// --- Transcript path validation ---

const TRANSCRIPT_PREFIXES = [
  resolve(process.env.HOME ?? "/", ".claude"),
  "/tmp/claude",
];

export function isAllowedTranscriptPath(p: string): boolean {
  const resolved = resolve(p);
  return TRANSCRIPT_PREFIXES.some((prefix) => resolved.startsWith(prefix + "/"));
}

// --- Session boot recovery ---

// The subset of session state that boot recovery reasons about.
export interface RecoverableState {
  status: string;
  intervened?: boolean;
  waiting?: boolean;
}

export interface SessionRecoverPatch {
  status?: "idle";
  since?: string;
  intervened?: false;
  waiting?: false;
  waitingMessage?: undefined;
  waitingSince?: undefined;
}

// Compute the state patch to revive a running session at boot. A fresh process
// has no terminal websocket and no pending Notification, so a leftover
// `intervened` flag (which pauses queue draining) or `waiting` flag is stale and
// must be cleared; an "offline" session that is actually running comes back to
// "idle". Returns null when nothing needs changing.
export function recoverSessionPatch(state: RecoverableState, now: string): SessionRecoverPatch | null {
  const patch: SessionRecoverPatch = {};
  if (state.intervened) patch.intervened = false;
  if (state.waiting) {
    patch.waiting = false;
    patch.waitingMessage = undefined;
    patch.waitingSince = undefined;
  }
  if (state.status === "offline") {
    patch.status = "idle";
    patch.since = now;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// --- Template rendering ---

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
