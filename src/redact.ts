// --- Best-effort secret redaction ---
//
// The most likely real-world leak is the agent printing a secret it read while
// debugging, which then flows out through a response, a pipeline message, a
// webhook, or a chat reply. haiflow has one natural choke point for all of
// that (Stop -> capture -> deliver), so a single pass here covers every egress.
//
// This is best-effort DLP, NOT a firewall: it mitigates ACCIDENTAL egress of
// well-known credential shapes. It will not catch a secret that is encoded or
// reshaped, and pattern matching has false positives. It only ever rewrites
// outbound TEXT — never the files the agent writes inside its working dir.

export interface RedactOptions {
  emails?: boolean;
  extraPatterns?: RegExp[];
}

export interface RedactResult {
  text: string;
  count: number;
  types: string[];
}

// High-confidence credential shapes (very low false-positive rate). Order
// matters: multi-line private-key blocks first, then specific token formats.
const SECRET_DETECTORS: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["stripe-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._\-]{20,}/g],
];

const EMAIL_DETECTOR: [string, RegExp] = ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  if (!text) return { text: text ?? "", count: 0, types: [] };

  let out = text;
  let count = 0;
  const types = new Set<string>();

  const detectors: [string, RegExp][] = [...SECRET_DETECTORS];
  if (opts.emails) detectors.push(EMAIL_DETECTOR);
  for (const p of opts.extraPatterns ?? []) detectors.push(["custom", new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g")]);

  for (const [type, pattern] of detectors) {
    out = out.replace(pattern, () => { count++; types.add(type); return `[REDACTED:${type}]`; });
  }

  return { text: out, count, types: [...types] };
}
