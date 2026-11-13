create table public.config (
  id text primary key default 'conti',
  dati jsonb not null,
  updated_at timestamptz default now()
);
create table public.ops (
  id text primary key,
  data date not null,
  voce text not null,
  conto text not null check (conto in ('c1','c2','comune')),
  tipo text not null check (tipo in ('entrata','uscita')),
  importo numeric(12,2) not null check (importo > 0),
  categoria text,
  ordine integer default 0,
  updated_at timestamptz default now(),
  check (conto <> 'comune' or tipo = 'uscita')
);
alter table public.ops enable row level security;
alter table public.config enable row level security;
create policy "solo utenti loggati" on public.ops
  for all to authenticated using (true) with check (true);
create policy "solo utenti loggati" on public.config
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.ops, public.config to authenticated;
revoke all on public.ops, public.config from anon;
