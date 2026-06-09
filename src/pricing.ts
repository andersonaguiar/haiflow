import type { TaskUsage } from "./ledger";

// --- "Would-have-cost" pricing ---
//
// haiflow runs on a flat Claude Code subscription, so a task costs nothing
// per-token. This table lets us show the equivalent API cost a per-token
// caller would have paid for the same work — the savings the tool exists to
// deliver. Prices are public Anthropic API list prices in USD per million
// tokens (MTok) and WILL drift; treat the output as an estimate, not a bill.
// Override via a prices.json in HAIFLOW_DATA_DIR is intentionally out of scope
// here — keep one maintained table.

interface ModelPrice {
  input: number;       // per MTok
  output: number;      // per MTok
  cacheWrite: number;  // per MTok (cache creation)
  cacheRead: number;   // per MTok (cache hit)
}

const PER_MTOK = {
  opus:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
} satisfies Record<string, ModelPrice>;

const DEFAULT_PRICE = PER_MTOK.sonnet;

export function priceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const m = model.toLowerCase();
  if (m.includes("opus")) return PER_MTOK.opus;
  if (m.includes("haiku")) return PER_MTOK.haiku;
  if (m.includes("sonnet")) return PER_MTOK.sonnet;
  return DEFAULT_PRICE;
}

// Equivalent API dollar cost for a task's token usage. Returns USD.
export function estimateSavings(usage: TaskUsage | null | undefined, model: string | null | undefined): number {
  if (!usage) return 0;
  const p = priceForModel(model);
  const cost =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
