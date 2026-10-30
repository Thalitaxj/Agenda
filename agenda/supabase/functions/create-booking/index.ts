// =============================================================================
// Edge Function: create-booking
//
// Cria um PEDIDO de agendamento (status 'requested') vindo da página pública.
// Toda a validação de disponibilidade é feita AQUI, no servidor:
//   1. Serviço existe, está ativo e pertence ao profissional
//   2. O horário cai dentro da disponibilidade semanal do profissional
//   3. Não há bloqueio/folga cobrindo o horário
//   4. Não há agendamento confirmado OU pedido pendente sobrepondo o horário
//
// Usa a SERVICE ROLE KEY (nunca exposta ao navegador) para contornar o RLS
// de forma controlada. A constraint de exclusão do banco é a última linha
// de defesa contra corrida/duplicidade de horários confirmados.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Normaliza telefone para dígitos (formato wa.me)
function normalizePhone(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const { slug, service_id, starts_at, client_name, client_phone, notes } = payload ?? {};

  // --- Validação de entrada -------------------------------------------------
  if (!slug || !service_id || !starts_at || !client_name || !client_phone) {
    return json({ error: "Campos obrigatórios ausentes." }, 400);
  }
  const phone = normalizePhone(client_phone);
  if (phone.length < 10) {
    return json({ error: "Telefone inválido." }, 400);
  }
  const start = new Date(starts_at);
  if (isNaN(start.getTime())) {
    return json({ error: "Data/horário inválido." }, 400);
  }
  if (start.getTime() < Date.now() - 60_000) {
    return json({ error: "Não é possível agendar no passado." }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // --- Profissional ---------------------------------------------------------
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("id, timezone, confirm_mode, buffer_minutes, require_deposit, deposit_cents")
    .eq("slug", slug)
    .maybeSingle();
  if (pErr) return json({ error: "Erro ao buscar profissional." }, 500);
  if (!profile) return json({ error: "Profissional não encontrado." }, 404);

  // --- Serviço (ativo e do profissional) ------------------------------------
  const { data: service, error: sErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, active, profile_id")
    .eq("id", service_id)
    .maybeSingle();
  if (sErr) return json({ error: "Erro ao buscar serviço." }, 500);
  if (!service || service.profile_id !== profile.id || !service.active) {
    return json({ error: "Serviço indisponível." }, 400);
  }

  const end = new Date(start.getTime() + service.duration_minutes * 60_000);

  // --- Dentro da disponibilidade semanal? -----------------------------------
  // Calcula o weekday e os minutos do dia no fuso do profissional.
  const tz = profile.timezone || "America/Sao_Paulo";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(start);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[parts.find((p) => p.type === "weekday")!.value];
  const startMin =
    parseInt(parts.find((p) => p.type === "hour")!.value, 10) * 60 +
    parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  const endMin = startMin + service.duration_minutes;

  const { data: avail } = await supabase
    .from("availability")
    .select("start_time, end_time")
    .eq("profile_id", profile.id)
    .eq("weekday", weekday);

  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const fitsWindow = (avail ?? []).some(
    (a) => startMin >= toMin(a.start_time) && endMin <= toMin(a.end_time),
  );
  if (!fitsWindow) {
    return json({ error: "Horário fora do atendimento do profissional." }, 409);
  }

  // --- Conflito com ocupados (confirmados, pedidos pendentes e bloqueios) ---
  // Considera o intervalo entre atendimentos (buffer) configurado no perfil.
  const bufferMs = (Number(profile.buffer_minutes) || 0) * 60_000;
  const { data: busy, error: bErr } = await supabase.rpc("busy_intervals", {
    p_profile: profile.id,
    p_from: new Date(start.getTime() - bufferMs).toISOString(),
    p_to: new Date(end.getTime() + bufferMs).toISOString(),
  });
  if (bErr) return json({ error: "Erro ao validar disponibilidade." }, 500);
  if ((busy ?? []).length > 0) {
    return json({ error: "Este horário acabou de ser ocupado. Escolha outro." }, 409);
  }

  // --- Cliente (upsert por profissional+telefone) ---------------------------
  let clientId: string | null = null;
  const { data: existing } = await supabase
    .from("clients")
    .select("id")
    .eq("profile_id", profile.id)
    .eq("phone", phone)
    .maybeSingle();
  if (existing) {
    clientId = existing.id;
  } else {
    const { data: created } = await supabase
      .from("clients")
      .insert({ profile_id: profile.id, name: client_name, phone })
      .select("id")
      .maybeSingle();
    clientId = created?.id ?? null;
  }

  // --- Cria o agendamento ---------------------------------------------------
  // Modo de confirmação do profissional: 'auto' entra como confirmed (sujeito
  // à constraint anti-sobreposição), 'manual' entra como requested.
  const autoConfirm = profile.confirm_mode === "auto";
  // Sinal: se o profissional exige, grava o agendamento com sinal pendente.
  const needsDeposit = Boolean(profile.require_deposit) && Number(profile.deposit_cents) > 0;
  const { data: appt, error: aErr } = await supabase
    .from("appointments")
    .insert({
      profile_id: profile.id,
      service_id: service.id,
      client_id: clientId,
      client_name,
      client_phone: phone,
      service_name: service.name,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      status: autoConfirm ? "confirmed" : "requested",
      source: "public",
      notes: notes ?? "",
      deposit_status: needsDeposit ? "pending" : "none",
      deposit_cents: needsDeposit ? Number(profile.deposit_cents) : 0,
    })
    .select("id, starts_at, ends_at, status, public_token")
    .maybeSingle();

  if (aErr) {
    // Violação da constraint de exclusão = horário confirmado conflitante (corrida).
    if (/exclusion|overlap|conflict|23P01/i.test(aErr.message || "")) {
      return json({ error: "Este horário acabou de ser ocupado. Escolha outro." }, 409);
    }
    return json({ error: "Não foi possível registrar o pedido. Tente novamente." }, 500);
  }

  return json({
    ok: true,
    appointment: appt,
    message: "Pedido registrado. Finalize a confirmação pelo WhatsApp.",
  });
});
