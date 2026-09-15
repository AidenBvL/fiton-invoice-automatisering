-- FitOn boekrapporten — Supabase
--
-- Plak dit in Supabase > SQL Editor en klik Run. Het mag vaker gedraaid worden:
-- wat al bestaat blijft staan.
--
-- Toegang: iedereen met de Project URL en de publishable/anon key mag rapporten
-- toevoegen en lezen, en facturen uploaden en bekijken. Niemand kan via die key
-- iets wijzigen of verwijderen; dat doe je zelf in Supabase (Table Editor en
-- Storage).


-- 1. De rapporten ------------------------------------------------------------

create table if not exists public.runs (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),
  booked_at    timestamptz,
  "user"       text,
  machine      text,
  invoice_no   text,
  creditor     text,
  creditor_seq text,
  shipment     text,
  container    text,
  outcome      text,
  lines_total  int,
  lines_booked int,
  amount       numeric(12,2),
  avg_ms       int,
  message      text,
  detail       jsonb not null default '{}'::jsonb,
  doc_path     text
);

alter table public.runs add column if not exists doc_name text;

-- Het resultaat van een run, één keer vastgelegd: alles geboekt, een deel, of niets.
alter table public.runs add column if not exists status text generated always as (
  case
    when outcome = 'done' then 'done'
    when coalesce(lines_booked, 0) > 0 then 'partial'
    else 'failed'
  end
) stored;

create index if not exists runs_received on public.runs (received_at desc);
create index if not exists runs_invoice  on public.runs (invoice_no);
create index if not exists runs_user     on public.runs ("user");

alter table public.runs enable row level security;
grant select, insert on public.runs to anon, authenticated;

drop policy if exists "afdeling mag lezen"     on public.runs;
drop policy if exists "afdeling mag toevoegen" on public.runs;
create policy "afdeling mag lezen"     on public.runs for select to anon, authenticated using (true);
create policy "afdeling mag toevoegen" on public.runs for insert to anon, authenticated with check (true);


-- 2. Kengetallen voor het dashboard ------------------------------------------

create or replace function public.fiton_stats()
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'since',     (extract(epoch from now() - interval '30 days') * 1000)::bigint,
    'runs',      count(*),
    'done',      count(*) filter (where status = 'done'),
    'partial',   count(*) filter (where status = 'partial'),
    'failed',    count(*) filter (where status = 'failed'),
    'amount',    coalesce(round(sum(amount) filter (where status = 'done'), 2), 0),
    'userCount', count(distinct nullif("user", '')),
    'users', (
      select coalesce(json_agg(u order by u.last desc), '[]'::json)
      from (
        select "user", count(*) as runs, max(received_at) as last
        from public.runs
        where coalesce("user", '') <> ''
        group by "user"
      ) u
    )
  )
  from public.runs
  where received_at >= now() - interval '30 days';
$$;

grant execute on function public.fiton_stats() to anon, authenticated;


-- 3. De facturen (PDF) --------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('facturen', 'facturen', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "afdeling mag facturen uploaden" on storage.objects;
drop policy if exists "afdeling mag facturen lezen"    on storage.objects;
create policy "afdeling mag facturen uploaden" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'facturen');
create policy "afdeling mag facturen lezen" on storage.objects
  for select to anon, authenticated using (bucket_id = 'facturen');
