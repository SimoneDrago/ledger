-- Planning: persone, banca ore annuale e voci del calendario.
-- Esegui una volta nel SQL Editor di Supabase. Stessa protezione delle altre tabelle: solo utenti loggati.
create table if not exists public.plan_persone (
  id text primary key,
  nome text not null,
  colore text not null default '#6366f1',
  ore_giorno numeric(4,2) not null default 8 check (ore_giorno > 0 and ore_giorno <= 24),
  ordine integer not null default 0,
  updated_at timestamptz default now()
);
create table if not exists public.plan_banche (
  persona_id text not null references public.plan_persone(id) on delete cascade,
  anno integer not null,
  ferie_ore numeric(7,2) not null default 0 check (ferie_ore >= 0),
  permessi_ore numeric(7,2) not null default 0 check (permessi_ore >= 0),
  updated_at timestamptz default now(),
  primary key (persona_id, anno)
);
create table if not exists public.plan_voci (
  id text primary key,
  persona_id text not null references public.plan_persone(id) on delete cascade,
  data date not null,
  tipo text not null check (tipo in ('ferie','permessi')),
  ore numeric(4,2) not null check (ore > 0),
  updated_at timestamptz default now(),
  unique (persona_id, data, tipo)
);
create index if not exists plan_voci_persona_data on public.plan_voci (persona_id, data);

alter table public.plan_persone enable row level security;
alter table public.plan_banche enable row level security;
alter table public.plan_voci enable row level security;
create policy "solo utenti loggati" on public.plan_persone for all to authenticated using (true) with check (true);
create policy "solo utenti loggati" on public.plan_banche for all to authenticated using (true) with check (true);
create policy "solo utenti loggati" on public.plan_voci for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.plan_persone, public.plan_banche, public.plan_voci to authenticated;
revoke all on public.plan_persone, public.plan_banche, public.plan_voci from anon;
