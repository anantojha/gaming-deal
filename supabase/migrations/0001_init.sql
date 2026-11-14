-- 0001_init.sql  |  Gaming Deal Agent, Phase 1 (PC only)
-- Run in the Supabase SQL editor, or via `supabase db push`.
-- Conventions: money = integer cents; times = timestamptz; region = ISO-3166 alpha-2.

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ───────────────────────── catalog ─────────────────────────

-- Shops use ITAD's shop ids (Steam = 61). trust_tier drives the grey-market filter.
create table shop (
  id                  int primary key,
  name                text not null,
  trust_tier          text not null default 'unknown'
                      check (trust_tier in ('official','authorized','grey','unknown')),
  cheapshark_store_id int,
  created_at          timestamptz not null default now()
);

-- Product = canonical game + edition + platform.
-- External ids are kept separately because the three systems identify games differently.
create table product (
  id                 uuid primary key default gen_random_uuid(),
  itad_id            uuid unique,
  steam_appid        int  unique,
  cheapshark_game_id int  unique,
  title              text not null,
  edition            text not null default 'standard'
                     check (edition in ('standard','deluxe','complete','bundle','other')),
  platform           text not null default 'pc' check (platform in ('pc')),
  base_product_id    uuid references product(id) on delete set null, -- groups editions of one game
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (itad_id is not null or steam_appid is not null or cheapshark_game_id is not null)
);
create index product_base_idx on product (base_product_id);
create trigger product_updated before update on product
  for each row execute function set_updated_at();

-- Listing = one product at one shop, from one source, in one region.
-- Holds the CURRENT price for fast reads. url is stored exactly as the source gave it.
create table listing (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references product(id) on delete cascade,
  shop_id          int  not null references shop(id),
  source           text not null check (source in ('itad','cheapshark')),
  region           char(2) not null default 'US',
  currency         char(3) not null default 'USD',
  url              text,
  price_cents      int check (price_cents >= 0),
  regular_cents    int check (regular_cents >= 0),
  cut_pct          smallint check (cut_pct between 0 and 100),
  price_changed_at timestamptz,   -- source timestamp of the last CHANGE (not a freshness signal)
  expires_at       timestamptz,
  last_checked_at  timestamptz,   -- when WE last fetched it (use this for staleness)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (product_id, shop_id, source, region)
);
create index listing_product_idx on listing (product_id);
create index listing_checked_idx on listing (last_checked_at);
create trigger listing_updated before update on listing
  for each row execute function set_updated_at();

-- PricePoint = one price CHANGE event (matches ITAD's history log), not daily samples.
-- Price at time t = latest event at or before t.
create table price_point (
  id            bigint generated always as identity primary key,
  listing_id    uuid not null references listing(id) on delete cascade,
  changed_at    timestamptz not null,
  observed_at   timestamptz not null default now(),
  price_cents   int not null check (price_cents >= 0),
  regular_cents int check (regular_cents >= 0),
  cut_pct       smallint check (cut_pct between 0 and 100),
  source        text not null check (source in ('itad','cheapshark')),
  validation    text not null default 'unverified'
                check (validation in ('unverified','verified','rejected')),
  reject_reason text,
  unique (listing_id, changed_at, price_cents)
);
create index price_point_listing_idx on price_point (listing_id, changed_at desc);

-- Precomputed score inputs, refreshed by ingestion (ATL from ITAD historylow;
-- 12-month low and typical sale price from the history log).
create table price_stats (
  product_id         uuid not null references product(id) on delete cascade,
  region             char(2) not null default 'US',
  atl_cents          int,
  atl_at             timestamptz,
  atl_shop_id        int references shop(id),
  low_12m_cents      int,
  typical_sale_cents int,   -- median of sale prices over 12 months, NOT list price
  regular_cents      int,
  sale_count_12m     smallint,
  computed_at        timestamptz not null default now(),
  primary key (product_id, region)
);

-- Seasonal sales. No free API exists, so this is maintained by hand (is_confirmed = false for estimates).
create table sale_event (
  id           int generated always as identity primary key,
  name         text not null,
  scope        text not null default 'steam' check (scope in ('steam','all','publisher')),
  starts_on    date not null,
  ends_on      date not null,
  is_confirmed boolean not null default false,
  source_note  text,
  check (ends_on >= starts_on)
);

-- ───────────────────────── users ─────────────────────────

-- Auth is Supabase Auth; the Worker verifies the JWT. One profile row per auth user.
create table user_profile (
  id                  uuid primary key references auth.users(id) on delete cascade,
  region              char(2) not null default 'US',
  currency            char(3) not null default 'USD',
  monthly_budget_cents int check (monthly_budget_cents >= 0),
  exclude_grey_market boolean not null default true,
  subscriptions       text[] not null default '{}',   -- e.g. {'gamepass_pc'}
  email_alerts        boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger user_profile_updated before update on user_profile
  for each row execute function set_updated_at();

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into user_profile (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create table watch (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references user_profile(id) on delete cascade,
  product_id            uuid not null references product(id) on delete cascade,
  target_price_cents    int check (target_price_cents >= 0),
  accept_other_editions boolean not null default false,
  status                text not null default 'active'
                        check (status in ('active','paused','purchased')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, product_id)
);
create index watch_active_product_idx on watch (product_id) where status = 'active';
create trigger watch_updated before update on watch
  for each row execute function set_updated_at();

-- dedupe_key (e.g. listing_id:price_cents:date) + unique(watch_id, dedupe_key) prevents repeat emails.
create table alert (
  id          uuid primary key default gen_random_uuid(),
  watch_id    uuid not null references watch(id) on delete cascade,
  user_id     uuid not null references user_profile(id) on delete cascade,
  product_id  uuid not null references product(id),
  listing_id  uuid references listing(id) on delete set null,
  kind        text not null check (kind in ('target_hit','new_all_time_low','good_deal')),
  verdict     text check (verdict in ('buy_now','good','wait','skip')),
  confidence  numeric(3,2) check (confidence between 0 and 1),
  price_cents int not null,
  explanation text,
  dedupe_key  text not null,
  channel     text not null default 'email' check (channel in ('email','discord')),
  status      text not null default 'pending'
              check (status in ('pending','sent','failed','suppressed')),
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (watch_id, dedupe_key)
);
create index alert_pending_idx on alert (created_at) where status = 'pending';

-- ───────────────────────── judge + cost control ─────────────────────────

-- Cached verdicts + model explanations. inputs_hash covers every input that changes the
-- verdict (prices, stats, user target/budget/prefs), so identical inputs reuse one model call.
create table verdict_cache (
  product_id  uuid not null references product(id) on delete cascade,
  region      char(2) not null,
  inputs_hash text not null,
  score       smallint,
  verdict     text check (verdict in ('buy_now','good','wait','skip')),
  confidence  numeric(3,2) check (confidence between 0 and 1),
  features    jsonb not null,
  explanation text,
  model       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (product_id, region, inputs_hash)
);

-- Daily usage per provider; the hard spend cap reads this. cost_micros = micro-USD.
create table usage_ledger (
  day         date not null default current_date,
  provider    text not null check (provider in ('itad','cheapshark','model','resend')),
  requests    int not null default 0,
  tokens_in   bigint not null default 0,
  tokens_out  bigint not null default 0,
  cost_micros bigint not null default 0,
  primary key (day, provider)
);

-- Atomic increment; returns today's totals so the caller can compare against its cap.
create or replace function bump_usage(
  p_provider text, p_requests int default 1,
  p_tokens_in bigint default 0, p_tokens_out bigint default 0, p_cost_micros bigint default 0
) returns table (total_requests int, total_cost_micros bigint)
language sql as $$
  insert into usage_ledger as u (day, provider, requests, tokens_in, tokens_out, cost_micros)
  values (current_date, p_provider, p_requests, p_tokens_in, p_tokens_out, p_cost_micros)
  on conflict (day, provider) do update set
    requests    = u.requests    + excluded.requests,
    tokens_in   = u.tokens_in   + excluded.tokens_in,
    tokens_out  = u.tokens_out  + excluded.tokens_out,
    cost_micros = u.cost_micros + excluded.cost_micros
  returning u.requests, u.cost_micros;
$$;

-- ───────────────────────── row-level security ─────────────────────────
-- The Worker uses the service role (bypasses RLS). These policies are defense in depth.

alter table shop           enable row level security;
alter table product        enable row level security;
alter table listing        enable row level security;
alter table price_point    enable row level security;
alter table price_stats    enable row level security;
alter table sale_event     enable row level security;
alter table user_profile   enable row level security;
alter table watch          enable row level security;
alter table alert          enable row level security;
alter table verdict_cache  enable row level security;  -- no policies: service role only
alter table usage_ledger   enable row level security;  -- no policies: service role only

create policy catalog_read on shop        for select to authenticated using (true);
create policy catalog_read on product     for select to authenticated using (true);
create policy catalog_read on listing     for select to authenticated using (true);
create policy catalog_read on price_point for select to authenticated using (true);
create policy catalog_read on price_stats for select to authenticated using (true);
create policy catalog_read on sale_event  for select to authenticated using (true);

create policy profile_own on user_profile for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy watch_own on watch for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alert_read_own on alert for select to authenticated
  using (user_id = auth.uid());

-- ───────────────────────── seed ─────────────────────────
-- Ids from ITAD /service/shops/v1. Fill the rest (and mark grey-market sellers) from that list.
insert into shop (id, name, trust_tier) values
  (61, 'Steam',      'official'),
  (16, 'Epic Game Store', 'official'),
  (4,  'Blizzard',   'official'),
  (52, 'EA Store',   'official'),
  (6,  'Fanatical',  'authorized')
on conflict (id) do nothing;
