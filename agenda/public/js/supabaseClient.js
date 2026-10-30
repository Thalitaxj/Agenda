// =============================================================================
// Cliente de dados do AgendaAí.
//   * LOCAL_MODE = true  -> backend local (localStorage), sem internet
//   * caso contrário     -> cliente Supabase real (via CDN)
// Exporta `supabase` (ou null se nada configurado) e flags.
// =============================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED, LOCAL_MODE } from "./config.js";

let supabase = null;

if (LOCAL_MODE) {
  const { localSupabase } = await import("./localBackend.js");
  supabase = localSupabase;
} else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export { supabase, IS_CONFIGURED, LOCAL_MODE };
