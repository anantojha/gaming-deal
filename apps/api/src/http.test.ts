import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, HttpClient, HttpError, RateLimitedError, parseRetryAfter } from "../src/sources/http.ts";

function harness(responses: Array<Response | Error>, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const client = new HttpClient({
    provider: "test",
    userAgent: "TestAgent/1.0 (me@example.com)",
    minIntervalMs: 1000,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { client, sleeps, calls, advance: (ms: number) => { t += ms; } };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers });

test("sends the User-Agent and parses JSON", async () => {
  const h = harness([json({ ok: 1 })]);
  assert.deepEqual(await h.client.getJson("https://x.test/a"), { ok: 1 });
  assert.equal((h.calls[0].init.headers as Record<string, string>)["User-Agent"], "TestAgent/1.0 (me@example.com)");
});

test("spaces consecutive requests by minIntervalMs", async () => {
  const h = harness([json(1), json(2), json(3)]);
  await h.client.getJson("https://x.test/1");
  await h.client.getJson("https://x.test/2");
  await h.client.getJson("https://x.test/3");
  assert.deepEqual(h.sleeps, [1000, 1000]); // first is immediate
});

test("429 trips the breaker: later calls fail fast without touching the network", async () => {
  const h = harness([json({}, 429, { "Retry-After": "120" })]);
  await assert.rejects(h.client.getJson("https://x.test/a"), (e: unknown) => e instanceof RateLimitedError && e.retryAfterMs === 120_000);
  assert.equal(h.client.isBlocked(), true);
  await assert.rejects(h.client.getJson("https://x.test/b"), RateLimitedError);
  assert.equal(h.calls.length, 1);
  h.advance(121_000);
  assert.equal(h.client.isBlocked(), false);
});

test("retries 5xx with backoff, then succeeds", async () => {
  const h = harness([json({}, 503), json({}, 502), json({ ok: true })]);
  assert.deepEqual(await h.client.getJson("https://x.test/a"), { ok: true });
  assert.equal(h.calls.length, 3);
});

test("gives up after maxRetries on 5xx", async () => {
  const h = harness([json({}, 500), json({}, 500), json({}, 500)]);
  await assert.rejects(h.client.getJson("https://x.test/a"), (e: unknown) => e instanceof HttpError && e.status === 500);
});

test("does not retry other 4xx, and the error never contains request headers", async () => {
  const h = harness([new Response("bad key", { status: 403 })]);
  await assert.rejects(
    h.client.getJson("https://x.test/a", { headers: { "ITAD-API-Key": "SECRET123" } }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && !e.message.includes("SECRET123"),
  );
  assert.equal(h.calls.length, 1);
});

test("budget hook can stop requests before they are sent", async () => {
  let allowed = 2;
  const h = harness([json(1), json(2), json(3)], { reserve: async () => allowed-- > 0 });
  await h.client.getJson("https://x.test/1");
  await h.client.getJson("https://x.test/2");
  await assert.rejects(h.client.getJson("https://x.test/3"), BudgetExceededError);
  assert.equal(h.calls.length, 2);
});

test("POST bodies are JSON-encoded with a content type", async () => {
  const h = harness([json([])]);
  await h.client.getJson("https://x.test/p", { method: "POST", body: ["a", "b"] });
  assert.equal(h.calls[0].init.body, '["a","b"]');
  assert.equal((h.calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("Retry-After: seconds, HTTP date, junk, and the 1h cap", () => {
  assert.equal(parseRetryAfter("30", 0), 30_000);
  assert.equal(parseRetryAfter(null, 0), 60_000);
  assert.equal(parseRetryAfter("soon", 0), 60_000);
  assert.equal(parseRetryAfter("999999", 0), 3_600_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10_000);
});
