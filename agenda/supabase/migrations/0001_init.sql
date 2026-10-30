-- =============================================================================
-- AgendaAí — Schema inicial
-- PostgreSQL / Supabase
--
-- Contém:
--   * Tabelas: profiles, services, availability, time_blocks,
--              clients, appointments
--   * Enum de status de agendamento
--   * Row Level Security (RLS) por profissional (dono dos dados)
--   * Acesso público controlado para a página de agendamento
--   * Constraint que impede dois agendamentos CONFIRMADOS no mesmo horário
--   * Funções auxiliares usadas pela Edge Function
-- =============================================================================

-- Extensões -------------------------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists btree_gist;       -- exclusão por intervalo de tempo

-- =============================================================================
-- Enum de status
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_status') then
    create type appointment_status as enum ('requested', 'confirmed', 'completed', 'cancelled');
  end if;
end$$;

-- =============================================================================
-- Perfil do profissional (1:1 com auth.users)
-- =============================================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  slug        text unique not null,              -- usado no link público /agendar?slug=...
  full_name   text not null default '',
  description text default '',
  phone       text default '',                   -- E.164 sem '+', ex: 5511999999999 (para wa.me)
  address     text default '',
  avatar_url  text default '',
  cover_url   text default '',                   -- imagem de capa da página pública
  instagram   text default '',                   -- usuário do Instagram (sem @)
  gallery     jsonb not null default '[]'::jsonb,-- galeria de trabalhos (URLs)
  timezone    text not null default 'America/Sao_Paulo',
  reminder1_hours integer not null default 24,   -- 1º lembrete (horas antes)
  reminder2_hours integer not null default 3,    -- 2º lembrete (horas antes)
  confirm_mode    text not null default 'manual', -- 'manual' | 'auto'
  buffer_minutes  integer not null default 0,    -- intervalo entre atendimentos
  work_holidays   boolean not null default false,-- atende em feriados nacionais?
  require_deposit boolean not null default false,-- exige sinal/entrada para garantir o horário?
  deposit_cents   integer not null default 0,    -- valor do sinal (centavos)
  pix_key         text default '',               -- chave Pix para receber o sinal
  deposit_policy  text default '',               -- regra do sinal mostrada ao cliente
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =============================================================================
-- Serviços oferecidos
-- =============================================================================
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  name             text not null,
  description      text default '',
  duration_minutes integer not null check (duration_minutes > 0 and duration_minutes <= 1440),
  price_cents      integer not null default 0 check (price_cents >= 0),
  image_url        text default '',
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
create index if not exists services_profile_idx on public.services(profile_id);

-- =============================================================================
-- Disponibilidade semanal (dias/horários de atendimento)
-- weekday: 0 = domingo ... 6 = sábado  (compatível com JS getDay())
-- =============================================================================
create table if not exists public.availability (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  check (end_time > start_time)
);
create index if not exists availability_profile_idx on public.availability(profile_id);

-- =============================================================================
-- Bloqueios / folgas / pausas pontuais (intervalos absolutos)
-- =============================================================================
create table if not exists public.time_blocks (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text default '',
  check (ends_at > starts_at)
);
create index if not exists time_blocks_profile_idx on public.time_blocks(profile_id);

-- =============================================================================
-- Clientes (dados restritos ao profissional dono)
-- =============================================================================
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  phone       text not null,                     -- WhatsApp do cliente
  notes       text default '',
  created_at  timestamptz not null default now(),
  unique (profile_id, phone)
);
create index if not exists clients_profile_idx on public.clients(profile_id);

-- =============================================================================
-- Anotações particulares do profissional sobre cada cliente (privadas)
-- =============================================================================
create table if not exists public.client_notes (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  text        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists client_notes_client_idx on public.client_notes(client_id);

-- =============================================================================
-- Avaliações de clientes (nota + comentário)
-- Vinculadas a um agendamento concluído; 1 avaliação por agendamento.
-- =============================================================================
create table if not exists public.reviews (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  client_name    text not null default '',
  rating         smallint not null check (rating between 1 and 5),
  comment        text default '',
  created_at     timestamptz not null default now()
);
create index if not exists reviews_profile_idx on public.reviews(profile_id);

-- =============================================================================
-- Agendamentos
-- =============================================================================
create table if not exists public.appointments (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  service_id    uuid references public.services(id) on delete set null,
  client_id     uuid references public.clients(id) on delete set null,
  client_name   text not null,                   -- desnormalizado (pedido público)
  client_phone  text not null,
  service_name  text not null,                   -- snapshot no momento do pedido
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        appointment_status not null default 'requested',
  source        text not null default 'public',  -- 'public' | 'manual'
  notes         text default '',
  -- Confirmação de presença (separada do status) + lembretes + token seguro
  attendance            text not null default 'pending',  -- pending | confirmed | declined
  attendance_at         timestamptz,
  reschedule_requested  boolean not null default false,
  reminder_24h_sent_at  timestamptz,
  reminder_short_sent_at timestamptz,
  -- Sinal / entrada (reduz no-show): none | pending | paid
  deposit_status        text not null default 'none',
  deposit_cents         integer not null default 0,
  public_token          text unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists appointments_profile_idx on public.appointments(profile_id);
create index if not exists appointments_starts_idx  on public.appointments(profile_id, starts_at);

-- -----------------------------------------------------------------------------
-- REGRA DE NEGÓCIO CRÍTICA:
-- Impedir dois agendamentos CONFIRMADOS que se sobreponham para o mesmo
-- profissional. Pedidos 'requested' podem coexistir (ainda não aceitos);
-- 'cancelled' e 'completed' não travam a agenda.
-- -----------------------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_no_overlap;
alter table public.appointments
  add constraint appointments_no_overlap
  exclude using gist (
    profile_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (status = 'confirmed');

-- updated_at automático ------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists trg_appointments_touch on public.appointments;
create trigger trg_appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- Criação automática de profile ao registrar usuário
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base_slug text;
  final_slug text;
  n int := 0;
begin
  base_slug := regexp_replace(lower(coalesce(new.raw_user_meta_data->>'slug',
                                              split_part(new.email, '@', 1))),
                              '[^a-z0-9]+', '-', 'g');
  base_slug := trim(both '-' from base_slug);
  if base_slug = '' then base_slug := 'pro'; end if;
  final_slug := base_slug;
  while exists (select 1 from public.profiles where slug = final_slug) loop
    n := n + 1;
    final_slug := base_slug || '-' || n;
  end loop;

  insert into public.profiles (id, slug, full_name)
  values (new.id, final_slug, coalesce(new.raw_user_meta_data->>'full_name', ''));

  -- Horários de atendimento padrão (Segunda a Sexta, 09:00–18:00).
  -- O profissional pode editar/remover depois no painel.
  insert into public.availability (profile_id, weekday, start_time, end_time)
  values
    (new.id, 1, '09:00', '18:00'),
    (new.id, 2, '09:00', '18:00'),
    (new.id, 3, '09:00', '18:00'),
    (new.id, 4, '09:00', '18:00'),
    (new.id, 5, '09:00', '18:00');

  return new;
end$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.profiles     enable row level security;
alter table public.services     enable row level security;
alter table public.availability enable row level security;
alter table public.time_blocks  enable row level security;
alter table public.clients      enable row level security;
alter table public.appointments enable row level security;
alter table public.reviews      enable row level security;

-- reviews: leitura pública (vitrine). Inserção só via Edge Function (service role),
-- que valida que o agendamento está concluído e evita duplicidade.
drop policy if exists reviews_public_read on public.reviews;
create policy reviews_public_read on public.reviews for select using (true);

-- profiles: dono gerencia o seu; leitura pública (necessária para a página de agendamento)
drop policy if exists profiles_public_read on public.profiles;
create policy profiles_public_read on public.profiles for select using (true);

drop policy if exists profiles_owner_update on public.profiles;
create policy profiles_owner_update on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_owner_insert on public.profiles;
create policy profiles_owner_insert on public.profiles for insert
  with check (auth.uid() = id);

-- services: dono gerencia tudo; leitura pública só de serviços ativos
drop policy if exists services_owner_all on public.services;
create policy services_owner_all on public.services for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

drop policy if exists services_public_read on public.services;
create policy services_public_read on public.services for select
  using (active = true);

-- availability: dono gerencia; leitura pública (para calcular horários livres)
drop policy if exists availability_owner_all on public.availability;
create policy availability_owner_all on public.availability for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

drop policy if exists availability_public_read on public.availability;
create policy availability_public_read on public.availability for select using (true);

-- time_blocks: dono gerencia; leitura pública (para não ofertar horário bloqueado)
drop policy if exists time_blocks_owner_all on public.time_blocks;
create policy time_blocks_owner_all on public.time_blocks for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

drop policy if exists time_blocks_public_read on public.time_blocks;
create policy time_blocks_public_read on public.time_blocks for select using (true);

-- clients: estritamente do dono (dados sensíveis, SEM leitura pública)
drop policy if exists clients_owner_all on public.clients;
create policy clients_owner_all on public.clients for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- client_notes: estritamente do dono (anotações privadas, SEM leitura pública)
alter table public.client_notes enable row level security;
drop policy if exists client_notes_owner_all on public.client_notes;
create policy client_notes_owner_all on public.client_notes for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- appointments: dono gerencia tudo. O público NÃO insere direto na tabela:
-- a criação de pedidos passa obrigatoriamente pela Edge Function (service role),
-- que valida disponibilidade no servidor.
drop policy if exists appointments_owner_all on public.appointments;
create policy appointments_owner_all on public.appointments for all
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- =============================================================================
-- Função pública de leitura de horários OCUPADOS de um dia
-- Retorna intervalos que travam a agenda (confirmados) + pedidos pendentes,
-- para a página pública calcular slots livres SEM expor dados de clientes.
-- =============================================================================
create or replace function public.busy_intervals(p_profile uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz, status appointment_status)
language sql stable security definer set search_path = public as $$
  select a.starts_at, a.ends_at, a.status
  from public.appointments a
  where a.profile_id = p_profile
    and a.status in ('requested', 'confirmed')
    and a.starts_at < p_to
    and a.ends_at   > p_from
  union all
  select b.starts_at, b.ends_at, 'confirmed'::appointment_status
  from public.time_blocks b
  where b.profile_id = p_profile
    and b.starts_at < p_to
    and b.ends_at   > p_from;
$$;

grant execute on function public.busy_intervals(uuid, timestamptz, timestamptz) to anon, authenticated;
