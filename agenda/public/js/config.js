// =============================================================================
// Configuração pública do AgendaAí.
// Preencha com os dados do SEU projeto Supabase (veja SETUP.md).
// Estas chaves são PÚBLICAS por natureza (a anon key respeita o RLS).
// NUNCA coloque a service_role key aqui.
// =============================================================================

// -----------------------------------------------------------------------------
// MODO LOCAL
// Quando true, o app roda 100% no navegador (localStorage), SEM Supabase e SEM
// internet. Ótimo para testar tudo localmente. Coloque false quando for usar um
// Supabase real (preencha SUPABASE_URL e SUPABASE_ANON_KEY abaixo).
// -----------------------------------------------------------------------------
export const LOCAL_MODE = false;

export const SUPABASE_URL = "https://bilkczxxwnecrslbpbdi.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpbGtjenh4d25lY3JzbGJwYmRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwMTEyODMsImV4cCI6MjEwODU4NzI4M30.1qr66Tr6firI11CYz-nE32A2-f2nLswx5yTK_mCvxqI";

// Derivada automaticamente — não precisa editar.
export const CREATE_BOOKING_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/create-booking`
  : "";

// Em modo local o app está "configurado" (usa o backend local).
export const IS_CONFIGURED = LOCAL_MODE || Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Configurações de agenda
export const SLOT_STEP_MINUTES = 15; // granularidade dos horários ofertados
