import { resolve } from "path";
import { realpathSync, statSync } from "fs";

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
  let candidate = resolved;
  // If the path exists, resolve symlinks to the real target and require a
  // regular file. This defeats a symlink planted under the allowlist that
  // points outside it (e.g. /tmp/claude/x -> /etc/passwd, since /tmp is
  // world-writable). resolve() alone normalises `..` but does NOT follow links.
  try {
    const real = realpathSync(resolved);
    if (!statSync(real).isFile()) return false;
    candidate = real;
  } catch {
    // Non-existent / unstattable: fall back to the pure path policy below so a
    // not-yet-written transcript under an allowed prefix is still permitted.
  }
  return TRANSCRIPT_PREFIXES.some((prefix) => {
    if (candidate.startsWith(prefix + "/")) return true;
    // The prefix itself may be a symlink (e.g. macOS /tmp -> /private/tmp), so
    // also compare against its real path when it exists.
    try {
      return candidate.startsWith(realpathSync(prefix) + "/");
    } catch {
      return false;
    }
  });
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

// --- Rate limiting ---

export interface RateWindow {
  count: number;
  windowStart: number;
}

// Fixed-window rate limit. Mutates `state` for `key` and returns whether the
// request is allowed, plus seconds until the window resets when blocked. A
// limit <= 0 disables it (always allowed). Pure given `now`, so it's testable.
export function checkRateLimit(
  state: Map<string, RateWindow>,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0 };
  const w = state.get(key);
  if (!w || now - w.windowStart >= windowMs) {
    state.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (w.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.windowStart + windowMs - now) / 1000)) };
  }
  w.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// --- Template rendering ---

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
