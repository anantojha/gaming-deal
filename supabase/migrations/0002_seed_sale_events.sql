-- 0002_seed_sale_events.sql: Steam storewide seasonal sales (maintained by hand).
-- Checked 2026-11-14 against Valve's Steamworks schedule as reported by SteamDB and others.
-- Dates are whole days; real sales start/end 10:00 Pacific. Revisit when Valve publishes more.
-- Note: no Steam Black Friday event appears on the published 2026 calendar (Valve ran one in
-- 2025), but other stores and publishers may still discount around it.

alter table sale_event add constraint sale_event_name_key unique (name);

insert into sale_event (name, scope, starts_on, ends_on, is_confirmed, source_note) values
  ('Steam Autumn Sale 2026', 'steam', '2026-10-01', '2026-10-08', true,  'Valve Steamworks schedule (past)'),
  ('Steam Winter Sale 2026', 'steam', '2026-12-17', '2027-01-04', true,  'Valve Steamworks schedule; matches SteamDB'),
  ('Steam Spring Sale 2027', 'steam', '2027-03-18', '2027-03-25', false, 'Single secondary source; verify when Valve confirms'),
  ('Steam Summer Sale 2027', 'steam', '2027-06-24', '2027-07-08', false, 'Single secondary source; verify when Valve confirms')
on conflict (name) do nothing;
