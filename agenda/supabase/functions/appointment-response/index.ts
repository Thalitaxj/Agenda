// =============================================================================
// Edge Function: appointment-response
//
// Resposta do cliente via LINK SEGURO (token), sem login:
//   action = "get"       -> retorna o agendamento + dados públicos do profissional
//   action = "confirm"   -> confirma presença (registra data/hora)
//   action = "cancel"    -> cancela o agendamento (libera o horário)
//   action = "reschedule"-> marca pedido de reagendamento
//
// Usa a SERVICE ROLE KEY (nunca exposta ao navegador) e valida o token.
// Equivalente às funções do backend local getAppointmentByToken etc.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Método não permitido" }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }

  const { token, action } = payload ?? {};
  if (!token || !action) return json({ ok: false, error: "Parâmetros ausentes." }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Busca o agendamento pelo token
  const { data: appt, error: aErr } = await supabase
    .from("appointments")
    .select("*")
    .eq("public_token", token)
    .maybeSingle();
  if (aErr) return json({ ok: false, error: "Erro ao buscar agendamento." }, 500);
  if (!appt) return json({ ok: false, error: "Agendamento não encontrado." }, 404);

  const now = new Date().toISOString();

  if (action === "get") {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name, address, phone, slug")
      .eq("id", appt.profile_id)
      .maybeSingle();
    // Já existe avaliação para este agendamento?
    const { data: rev } = await supabase
      .from("reviews")
      .select("id")
      .eq("appointment_id", appt.id)
      .maybeSingle();
    return json({
      ok: true,
      appointment: {
        id: appt.id, service_id: appt.service_id, service_name: appt.service_name,
        starts_at: appt.starts_at,
        ends_at: appt.ends_at, status: appt.status, attendance: appt.attendance,
        attendance_at: appt.attendance_at, reschedule_requested: appt.reschedule_requested,
        client_name: appt.client_name, has_review: !!rev,
      },
      profile: {
        full_name: prof?.full_name || "Profissional", address: prof?.address || "",
        phone: prof?.phone || "", slug: prof?.slug || "",
      },
    });
  }

  // Avaliação: só é permitida quando o atendimento está CONCLUÍDO.
  if (action === "review") {
    if (appt.status !== "completed")
      return json({ ok: false, error: "A avaliação fica disponível após o atendimento ser concluído." }, 409);
    const rating = Math.round(Number(payload?.rating));
    const comment = String(payload?.comment ?? "").slice(0, 500);
    if (!(rating >= 1 && rating <= 5))
      return json({ ok: false, error: "Escolha uma nota de 1 a 5." }, 400);
    const { error } = await supabase.from("reviews").insert({
      profile_id: appt.profile_id,
      appointment_id: appt.id,
      client_name: appt.client_name,
      rating,
      comment,
    });
    if (error) {
      // Violação da constraint unique(appointment_id) => já foi avaliado
      if ((error as any).code === "23505" || /duplicate|unique/i.test(error.message || ""))
        return json({ ok: false, error: "Este atendimento já foi avaliado.", already: true }, 409);
      return json({ ok: false, error: "Não foi possível enviar a avaliação." }, 500);
    }
    return json({ ok: true });
  }

  if (appt.status === "cancelled" && action !== "get")
    return json({ ok: false, error: "Este agendamento foi cancelado." }, 409);
  if (appt.status === "completed" && action !== "get")
    return json({ ok: false, error: "Este atendimento já foi concluído." }, 409);

  if (action === "confirm") {
    if (appt.attendance === "confirmed") return json({ ok: true, already: true });
    const { error } = await supabase.from("appointments")
      .update({ attendance: "confirmed", attendance_at: now, reschedule_requested: false, updated_at: now })
      .eq("id", appt.id);
    if (error) return json({ ok: false, error: "Não foi possível confirmar." }, 500);
    return json({ ok: true });
  }

  if (action === "cancel") {
    const { error } = await supabase.from("appointments")
      .update({ status: "cancelled", attendance: "declined", attendance_at: now, updated_at: now })
      .eq("id", appt.id);
    if (error) return json({ ok: false, error: "Não foi possível cancelar." }, 500);
    return json({ ok: true });
  }

  if (action === "reschedule") {
    const { error } = await supabase.from("appointments")
      .update({ reschedule_requested: true, updated_at: now })
      .eq("id", appt.id);
    if (error) return json({ ok: false, error: "Não foi possível solicitar." }, 500);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Ação inválida." }, 400);
});
