// probe-apis.mjs: Step 1 smoke test for CheapShark + IsThereAnyDeal (ITAD)
// Node 20+. Run:  ITAD_API_KEY=your_key node probe-apis.mjs
// Purpose: confirm access, see real response shapes, and capture rate-limit headers.
// Endpoint shapes for ITAD are taken from its OpenAPI docs; verify against the output.

const UA = "GamingDealAgent/0.1 (contact: YOUR_EMAIL_HERE)"; // CheapShark requires a descriptive UA
const CS = "https://www.cheapshark.com/api/1.0";
const ITAD = "https://api.isthereanydeal.com";
const KEY = process.env.ITAD_API_KEY;
const APPID = process.env.STEAM_APPID ?? "620"; // Portal 2
const COUNTRY = process.env.COUNTRY ?? "US";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(label, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const limitHeaders = Object.fromEntries(
    [...res.headers].filter(([k]) => /rate|limit|retry/i.test(k))
  );
  console.log(`\n=== ${label}\n${res.status} ${init.method ?? "GET"} ${url}`);
  console.log("rate-limit headers:", limitHeaders);
  console.log(JSON.stringify(body, null, 2).slice(0, 900));
  if (res.status === 429) {
    console.log("!! 429: stop and respect Retry-After before continuing");
    process.exit(1);
  }
  return { res, body };
}

const itadHeaders = { "ITAD-API-Key": KEY ?? "", "Content-Type": "application/json" };

// ---------- CheapShark (no key; be gentle: 1 call/sec) ----------
await call("CheapShark: stores", `${CS}/stores`);
await sleep(1000);
await call("CheapShark: game by Steam appid", `${CS}/games?steamAppID=${APPID}`);
await sleep(1000);
await call("CheapShark: Steam deals sample", `${CS}/deals?storeID=1&pageSize=5&sortBy=Savings`);

// ---------- ITAD ----------
if (!KEY) {
  console.log("\nITAD_API_KEY not set. Register an app at https://isthereanydeal.com/apps/my/ and re-run.");
  process.exit(0);
}

const lookup = await call("ITAD: lookup by Steam appid", `${ITAD}/games/lookup/v1?appid=${APPID}`, { headers: itadHeaders });
const gid = lookup.body?.game?.id;
if (!gid) {
  console.log("\nNo game id found; check the lookup response shape above.");
  process.exit(1);
}

const since = new Date(Date.now() - 365 * 864e5).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const post = (path, body) => ({ method: "POST", headers: itadHeaders, body: JSON.stringify(body) });

await call("ITAD: price overview", `${ITAD}/games/overview/v2?country=${COUNTRY}`, post("", [gid]));
await call("ITAD: history low (all-time)", `${ITAD}/games/historylow/v1?country=${COUNTRY}`, post("", [gid]));
await call("ITAD: history log (12 months)", `${ITAD}/games/history/v2?id=${gid}&country=${COUNTRY}&since=${encodeURIComponent(since)}`, { headers: itadHeaders });
await call("ITAD: subscriptions (Game Pass etc.)", `${ITAD}/games/subs/v1?country=${COUNTRY}`, post("", [gid]));
await call("ITAD: shops list", `${ITAD}/service/shops/v1?country=${COUNTRY}`, { headers: itadHeaders });

console.log("\nDone. Save these outputs to fixtures/ for the score tests (step 4).");
