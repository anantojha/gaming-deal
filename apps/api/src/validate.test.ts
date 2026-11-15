import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePrice, type ValidationInput } from "../src/ingest/validate.ts";

const NOW = Date.parse("2026-11-14T20:00:00Z");
const fresh = "2026-11-14T18:00:00Z"; // 2h old crawl

const base: ValidationInput = {
  priceCents: 499, regularCents: 999, cut: 50,
  previousPriceCents: 999, allTimeLowCents: 99,
  sourceCheckedAt: fresh, csPriceAtShopCents: null, repeatConfirmedAt: null,
};
const v = (over: Partial<ValidationInput>) => validatePrice({ ...base, ...over }, NOW);

test("ordinary mid-size sale from a fresh source is verified without a second reading", () => {
  const r = v({ priceCents: 749, cut: 25, previousPriceCents: 999 });
  assert.equal(r.status, "verified");
  assert.equal(r.isBigDrop, false);
});

test("hard rejects: negative, above ceiling, above regular, inconsistent cut", () => {
  assert.equal(v({ priceCents: -1 }).status, "rejected");
  assert.deepEqual(v({ priceCents: 150_000, regularCents: 200_000, cut: 25 }).reasons, ["price_above_ceiling"]);
  assert.deepEqual(v({ priceCents: 1200 }).reasons, ["price_above_regular"]);
  assert.deepEqual(v({ priceCents: 499, cut: 90 }).reasons, ["cut_mismatch"]); // says 90%, math says 50%
});

test("a big drop with no second reading is held, not alerted", () => {
  const r = v({ priceCents: 99, cut: 90 });
  assert.equal(r.status, "unverified");
  assert.equal(r.needsRecheck, true);
  assert.ok(r.reasons.includes("no_corroboration"));
});

test("a big drop is verified when CheapShark agrees at the same store (within tolerance)", () => {
  const r = v({ priceCents: 199, cut: 80, csPriceAtShopCents: 199 });
  assert.equal(r.status, "verified");
  assert.ok(r.reasons.includes("corroborated_by_cs"));
  assert.equal(v({ priceCents: 199, cut: 80, csPriceAtShopCents: 225 }).status, "verified"); // within 50¢
});

test("a big drop is held when CheapShark disagrees, even with a repeat reading", () => {
  const r = v({ priceCents: 199, cut: 80, csPriceAtShopCents: 999, repeatConfirmedAt: "2026-11-14T19:00:00Z" });
  assert.equal(r.status, "unverified");
  assert.ok(r.reasons.includes("cs_disagrees"));
});

test("a repeat reading counts only after the minimum gap", () => {
  const tooSoon = v({ priceCents: 199, cut: 80, repeatConfirmedAt: "2026-11-14T19:50:00Z" }); // 10 min
  assert.equal(tooSoon.status, "unverified");
  const ok = v({ priceCents: 199, cut: 80, repeatConfirmedAt: "2026-11-14T19:00:00Z" }); // 60 min
  assert.equal(ok.status, "verified");
  assert.ok(ok.reasons.includes("corroborated_by_repeat"));
});

test("a price below the all-time low always needs corroboration", () => {
  const r = v({ priceCents: 49, regularCents: 59, cut: 17, previousPriceCents: 59, allTimeLowCents: 99 });
  assert.equal(r.isBigDrop, true);
  assert.equal(r.status, "unverified");
});

test("a free (0¢) price needs corroboration", () => {
  const r = v({ priceCents: 0, cut: 100 });
  assert.equal(r.isBigDrop, true);
  assert.equal(r.status, "unverified");
});

test("a stale source is held even for a small drop; unknown crawl time counts as stale", () => {
  const old = v({ priceCents: 749, cut: 25, sourceCheckedAt: "2026-11-13T00:00:00Z" });
  assert.equal(old.status, "unverified");
  assert.ok(old.reasons.includes("stale_source"));
  assert.equal(v({ priceCents: 749, cut: 25, sourceCheckedAt: null }).status, "unverified");
});

test("regular price of 0 or unknown skips the cut check instead of dividing by zero", () => {
  assert.equal(v({ regularCents: 0, cut: 0, priceCents: 499, previousPriceCents: null }).status, "verified");
  assert.equal(v({ regularCents: null, cut: null, priceCents: 499, previousPriceCents: null }).status, "verified");
});

test("a sale that merely returns to the old price is not a drop", () => {
  const r = v({ priceCents: 999, regularCents: 999, cut: 0, previousPriceCents: 199 });
  assert.equal(r.isBigDrop, false);
  assert.equal(r.status, "verified");
});
