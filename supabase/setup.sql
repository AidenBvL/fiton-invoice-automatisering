-- FitOn boekrapporten — Supabase
--
-- Plak dit in Supabase > SQL Editor en klik Run. Het mag vaker gedraaid worden:
-- wat al bestaat blijft staan.
--
-- Toegang: iedereen met de Project URL en de publishable/anon key mag rapporten
-- toevoegen en lezen, facturen uploaden en bekijken, en opvragen welke versie
-- de nieuwste is. Niemand kan via die key iets wijzigen of verwijderen, en een
-- versie aankondigen kan er ook niet mee; dat doe je zelf in Supabase (Table
-- Editor en Storage).


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


-- 4. Welke versie de nieuwste is ---------------------------------------------
--
-- Zodat collega's zien dat ze achterlopen. Bij het uitbrengen van een versie
-- zet je hem hier neer (SQL Editor, of Table Editor → releases):
--
--     insert into public.releases (version, notes, url)
--     values ('9.20.0', 'Meerdere facturen tegelijk inlezen', 'https://…');
--
-- Staat er niets, dan wordt de nieuwste versie afgeleid uit de rapporten: elke
-- boekrun vertelt op welke versie hij draaide. Een versie telt pas mee na twee
-- runs, zodat een proefbuild van één iemand niet de hele afdeling aanzet tot
-- bijwerken.

create table if not exists public.releases (
  version     text primary key,
  released_at timestamptz not null default now(),
  notes       text,
  url         text
);

alter table public.releases enable row level security;
grant select on public.releases to anon, authenticated;

drop policy if exists "afdeling mag versies lezen" on public.releases;
create policy "afdeling mag versies lezen" on public.releases for select to anon, authenticated using (true);

create or replace function public.fiton_latest_version()
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with published as (
    select version, notes, url, 'released'::text as source
    from public.releases
    -- Zoals Chrome ze toestaat: hooguit vier getallen onder de 65536. Ruimer
    -- toelaten betekent dat één vertypte regel (een datum als versie) de cast
    -- hieronder laat overlopen, en dan krijgt de hele afdeling een foutmelding
    -- in plaats van een antwoord.
    where version ~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$'
    -- als tekst gesorteerd komt 9.9.0 ná 9.20.0; als lijst van getallen niet
    order by string_to_array(version, '.')::bigint[] desc
    limit 1
  ),
  seen as (
    select detail->>'version' as version,
           null::text as notes, null::text as url, 'gebruik'::text as source
    from public.runs
    where received_at >= now() - interval '30 days'
      and coalesce(detail->>'version', '') ~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$'
    group by detail->>'version'
    having count(*) >= 2
    order by string_to_array(detail->>'version', '.')::bigint[] desc
    limit 1
  )
  select coalesce(
    (select row_to_json(p) from published p),
    (select row_to_json(s) from seen s),
    json_build_object('version', null, 'source', 'onbekend')
  );
$$;

grant execute on function public.fiton_latest_version() to anon, authenticated;
