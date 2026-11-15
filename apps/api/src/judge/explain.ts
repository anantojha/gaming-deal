// Deterministic two-line explanation built only from the judge's own evidence.
// Used (a) when the model spend cap is reached, (b) when the model call fails, and
// (c) as the default text. The model-written version (step 5) replaces it when available.

import type { JudgeResult, Verdict } from "./types.ts";

export const VERDICT_LABEL: Record<Verdict, string> = {
  buy_now: "Buy now",
  good: "Good deal",
  wait: "Wait",
  skip: "Skip",
};

const DEFAULT_NEXT: Record<Verdict, string> = {
  buy_now: "This is at or near the best price seen.",
  good: "A fair price, though it has been lower.",
  wait: "A better price has been seen before and may return.",
  skip: "There is no reason to buy at this price.",
};

export function fallbackExplanation(r: JudgeResult): string {
  const [first, ...rest] = r.evidence;
  const line1 = `${VERDICT_LABEL[r.verdict]}: ${first ? first.text : "There isn't enough data to judge this price."}`;
  const line2 = rest.slice(0, 2).map((e) => e.text).join(" ") || DEFAULT_NEXT[r.verdict];
  return `${line1}\n${line2}`;
}
