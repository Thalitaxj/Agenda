-- =============================================================================
-- Migração 0002 — Melhorias 7, 10 e 11
--
--   * Melhoria 7  — avaliações de clientes + Instagram + galeria de trabalhos
--   * Melhoria 10 — status de falta (no-show)
--   * Melhoria 11 — sinal / entrada via Pix (manual)
--
-- Como aplicar no Supabase (SQL Editor):
--   1. Rode o BLOCO 1 inteiro (pode ser tudo de uma vez). É idempotente.
--   2. Rode o BLOCO 2 SOZINHO, numa execução separada. O comando
--      'ALTER TYPE ... ADD VALUE' não pode rodar junto de outras queries
--      na mesma transação, por isso fica isolado no fim.
-- =============================================================================


-- =============================================================================
-- BLOCO 1 — rode tudo de uma vez
-- =============================================================================

-- ---- Melhoria 7: avaliações + Instagram + galeria ---------------------------
alter table public.profiles add column if not exists instagram text default '';
alter table public.profiles add column if not exists gallery jsonb not null default '[]'::jsonb;

-- Avaliações: vinculadas a um agendamento concluído; 1 avaliação por agendamento.
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

-- RLS: leitura pública (vitrine). A inserção acontece só pela Edge Function
-- (service role), que valida "concluído" e evita duplicidade.
alter table public.reviews enable row level security;
drop policy if exists reviews_public_read on public.reviews;
create policy reviews_public_read on public.reviews for select using (true);

-- ---- Melhoria 11: sinal / entrada (Pix manual) ------------------------------
-- No perfil: se exige sinal, valor, chave Pix e a regra mostrada ao cliente.
alter table public.profiles add column if not exists require_deposit boolean not null default false;
alter table public.profiles add column if not exists deposit_cents integer not null default 0;
alter table public.profiles add column if not exists pix_key text default '';
alter table public.profiles add column if not exists deposit_policy text default '';

-- No agendamento: estado do sinal (none | pending | paid) e valor cobrado.
alter table public.appointments add column if not exists deposit_status text not null default 'none';
alter table public.appointments add column if not exists deposit_cents integer not null default 0;


-- =============================================================================
-- BLOCO 2 — rode SOZINHO, numa execução separada
-- (selecione apenas a linha abaixo e execute)
--
-- Melhoria 10: adiciona o valor 'no_show' ao enum de status do agendamento.
-- =============================================================================
alter type public.appointment_status add value if not exists 'no_show';
