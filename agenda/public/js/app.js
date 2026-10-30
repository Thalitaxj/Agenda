// =============================================================================
// Painel do profissional — AgendaAí
// Agenda (dia/semana/mês), serviços, horários, clientes, perfil.
// =============================================================================
import { supabase, IS_CONFIGURED } from "./supabaseClient.js";
import {
  toast, setLoading, esc, formatBRL, formatTimeBR, formatDateBR,
  formatDateTimeFull, isoDateLocal, STATUS_LABEL, waLink,
} from "./lib/ui.js";
import { computeFreeSlots } from "./lib/scheduling.js";

if (!IS_CONFIGURED) {
  document.getElementById("config-banner")?.classList.remove("hidden");
}

// --- Estado ----------------------------------------------------------------
const state = {
  user: null,
  profile: null,
  services: [],
  availability: [],
  blocks: [],
  appointments: [],
  clients: [],
  today: [],                 // agendamentos de HOJE (usado no dashboard)
  upcoming: [],              // confirmados nos próximos dias (lembretes)
  allAppointments: [],       // todos os agendamentos (histórico de clientes)
  clientNotes: [],           // anotações particulares por cliente
  attFilter: "all",         // filtro de confirmação de presença na agenda
  clientFilters: { q: "", lastVisit: "all", service: "all", future: "all", sort: "recent" },
  returnDays: 30,            // período da seção "precisam retornar"
  agendaRange: "day",       // day | week | month
  cursor: new Date(),        // data de referência da agenda
  reportPeriod: "day",      // day | month | year | custom (aba Relatório)
  reportCursor: new Date(),  // data de referência do relatório
  reportCustom: { from: null, to: null }, // intervalo do período personalizado
  reportData: [],            // agendamentos do período do relatório
};

const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DOW_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// --- Boot ------------------------------------------------------------------
(async function boot() {
  if (!IS_CONFIGURED) {
    document.querySelector("main").innerHTML =
      '<div class="empty" style="margin-top:30px">Configure o Supabase para usar o painel. Veja SETUP.md.</div>';
    return;
  }
  const { data } = await supabase.auth.getSession();
  if (!data.session) { window.location.href = "./index.html"; return; }
  state.user = data.session.user;

  await loadProfile();
  await Promise.all([loadServices(), loadAvailability(), loadBlocks(), loadClients(), loadClientNotes()]);
  await Promise.all([loadAppointments(), loadToday(), loadUpcomingConfirmed(), loadAllAppointments()]);

  bindNav();
  bindProfileForm();
  bindAgendaControls();
  bindGlobalButtons();
  bindDashboard();
  bindReport();

  renderAll();
})();

// Carrega os agendamentos de HOJE (independente do cursor da agenda)
async function loadToday() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);
  const { data } = await supabase.from("appointments")
    .select("*").eq("profile_id", state.user.id)
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString())
    .order("starts_at");
  state.today = data || [];
}

// =============================================================================
// Carregamento de dados
// =============================================================================
async function loadProfile() {
  const { data: profile, error } = await supabase
    .from("profiles").select("*").eq("id", state.user.id).maybeSingle();
  if (error || !profile) { toast("Erro ao carregar perfil.", "error"); return; }
  state.profile = profile;
}

async function loadServices() {
  const { data } = await supabase.from("services")
    .select("*").eq("profile_id", state.user.id).order("created_at");
  state.services = data || [];
}

async function loadAvailability() {
  const { data } = await supabase.from("availability")
    .select("*").eq("profile_id", state.user.id).order("weekday").order("start_time");
  state.availability = data || [];
}

async function loadBlocks() {
  const { data } = await supabase.from("time_blocks")
    .select("*").eq("profile_id", state.user.id)
    .gte("ends_at", new Date().toISOString()).order("starts_at");
  state.blocks = data || [];
}

async function loadClients() {
  const { data } = await supabase.from("clients")
    .select("*").eq("profile_id", state.user.id).order("name");
  state.clients = data || [];
}

// Todos os agendamentos do profissional (base do histórico e da fidelização).
async function loadAllAppointments() {
  const { data } = await supabase.from("appointments")
    .select("*").eq("profile_id", state.user.id).order("starts_at", { ascending: false });
  state.allAppointments = data || [];
}

// Anotações particulares (coleção própria, restrita ao profissional).
async function loadClientNotes() {
  const { data } = await supabase.from("client_notes")
    .select("*").eq("profile_id", state.user.id).order("created_at", { ascending: false });
  state.clientNotes = data || [];
}

async function loadAppointments() {
  const [from, to] = currentRangeBounds();
  const { data } = await supabase.from("appointments")
    .select("*").eq("profile_id", state.user.id)
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString())
    .order("starts_at");
  state.appointments = data || [];
}

// =============================================================================
// DASHBOARD INTELIGENTE
// =============================================================================
function bindDashboard() {
  document.getElementById("dash-new-appt")?.addEventListener("click", () => openApptModal());
  document.getElementById("dash-new-appt-2")?.addEventListener("click", () => openApptModal());
  document.getElementById("dash-block")?.addEventListener("click", () => openBlockModal());
  document.getElementById("dash-add-client")?.addEventListener("click", () => openClientModal());
  document.getElementById("dash-share")?.addEventListener("click", shareLink);
  document.getElementById("dash-full-agenda")?.addEventListener("click", () => {
    // leva para a aba Agenda
    document.querySelector('#tabs .tab[data-view="agenda"]')?.click();
  });
}

// Mapa de serviços por id (para preço/duração em agendamentos)
function serviceById(id) { return state.services.find((s) => s.id === id) || null; }

// Preço de um agendamento: usa o preço atual do serviço (snapshot não guarda preço)
function apptPrice(a) {
  const svc = serviceById(a.service_id);
  return svc ? svc.price_cents : 0;
}

function renderDashboard() {
  renderGreeting();
  renderModeBanner();
  renderDashCards();
  renderReminders();
  renderDashToday();
}

// Atualiza o texto do toggle de confirmação (no Perfil).
function updateConfirmModeText(isAuto) {
  const title = document.getElementById("confirm-mode-title");
  const desc = document.getElementById("confirm-mode-desc");
  if (!title || !desc) return;
  if (isAuto) {
    title.textContent = "Confirmação automática";
    desc.textContent = "Os agendamentos entram já confirmados quando o horário está livre.";
  } else {
    title.textContent = "Aprovação manual";
    desc.textContent = 'Os pedidos entram como "Solicitado" e você confirma cada um.';
  }
}

// Banner no topo do Dashboard mostrando o modo de confirmação ativo.
function renderModeBanner() {
  const host = document.getElementById("mode-banner");
  if (!host) return;
  const isAuto = state.profile?.confirm_mode === "auto";
  host.className = "mode-banner " + (isAuto ? "is-auto" : "is-manual");
  host.innerHTML = `
    <span class="mode-banner__dot"></span>
    <span>${isAuto
      ? "Confirmação <strong>automática</strong>: novos agendamentos já entram confirmados."
      : "Confirmação <strong>manual</strong>: você aprova cada pedido."}</span>
    <button class="mode-banner__link" id="mode-banner-switch" type="button">
      ${isAuto ? "Mudar para manual" : "Ativar automática"}
    </button>`;
  document.getElementById("mode-banner-switch")?.addEventListener("click", toggleConfirmMode);
}

// Alterna o modo de confirmação direto pelo banner do Dashboard.
async function toggleConfirmMode() {
  const novo = state.profile?.confirm_mode === "auto" ? "manual" : "auto";
  const { error } = await supabase.from("profiles").update({ confirm_mode: novo }).eq("id", state.user.id);
  if (error) { toast("Não foi possível alterar: " + error.message, "error"); return; }
  state.profile.confirm_mode = novo;
  renderModeBanner();
  // mantém o toggle do Perfil em sincronia
  const chk = document.getElementById("p-confirm-mode");
  if (chk) { chk.checked = (novo === "auto"); updateConfirmModeText(novo === "auto"); }
  toast(novo === "auto" ? "Confirmação automática ativada." : "Confirmação manual ativada.", "success");
}

// --- Config de lembretes (horas antes), vinda do perfil -------------------
function reminderHours() {
  const h1 = Number(state.profile?.reminder1_hours) || 24;
  const h2 = Number(state.profile?.reminder2_hours) || 3;
  return { h1, h2 };
}

// Janela de agendamentos confirmados próximos do horário cujo lembrete
// está "na hora" e ainda não foi enviado. Olha hoje + próximos dias.
async function loadUpcomingConfirmed() {
  const from = new Date();
  const to = new Date(from); to.setDate(to.getDate() + 3); // janela de 3 dias
  const { data } = await supabase.from("appointments")
    .select("*").eq("profile_id", state.user.id)
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString())
    .order("starts_at");
  state.upcoming = (data || []).filter((a) => a.status === "confirmed");
}

function reminderBaseUrl() {
  const { origin, pathname } = window.location;
  const dir = pathname.replace(/\/[^/]*$/, "/");
  return `${origin}${dir}responder.html`;
}

function reminderMessage(a) {
  const p = state.profile;
  const link = `${reminderBaseUrl()}?t=${encodeURIComponent(a.public_token)}`;
  const ehHoje = isoDateLocal(a.starts_at) === isoDateLocal(new Date());
  const quando = ehHoje ? `hoje às ${formatTimeBR(a.starts_at)}` : formatDateTimeFull(a.starts_at);
  const linhas = [
    `Olá ${a.client_name}! Passando para lembrar do seu horário com ${p.full_name || "nós"}.`,
    `Serviço: ${a.service_name}`,
    `Quando: ${quando}`,
  ];
  if (p.address) linhas.push(`Local: ${p.address}`);
  linhas.push("");
  linhas.push(`Confirme sua presença, cancele ou peça reagendamento aqui: ${link}`);
  return linhas.join("\n");
}

// Marca o lembrete como enviado (evita duplicado) ao abrir o WhatsApp.
async function markReminderSent(a, kind) {
  const field = kind === "24h" ? "reminder_24h_sent_at" : "reminder_short_sent_at";
  await supabase.from("appointments").update({ [field]: new Date().toISOString() }).eq("id", a.id);
  a[field] = new Date().toISOString();
}

function renderReminders() {
  const host = document.getElementById("reminders-list");
  if (!host) return;
  const list = state.upcoming || [];
  const now = Date.now();
  const { h1, h2 } = reminderHours();

  // Para cada agendamento, decide qual lembrete está "devido" e ainda não enviado.
  const due = [];
  for (const a of list) {
    const start = new Date(a.starts_at).getTime();
    const hoursTo = (start - now) / 3600000;
    if (hoursTo <= 0) continue;
    // 1º lembrete: quando falta <= h1 e ainda não enviado
    if (hoursTo <= h1 && !a.reminder_24h_sent_at) { due.push({ a, kind: "24h", label: `~${h1}h antes` }); continue; }
    // 2º lembrete: quando falta <= h2 e ainda não enviado
    if (hoursTo <= h2 && !a.reminder_short_sent_at) { due.push({ a, kind: "short", label: `~${h2}h antes` }); }
  }

  // guarda os lembretes devidos para o botão "Enviar todos"
  state.dueReminders = due;
  const sendAllBtn = document.getElementById("send-all-reminders");

  if (due.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum lembrete pendente no momento. ✓</div>`;
    if (sendAllBtn) sendAllBtn.classList.add("hidden");
    return;
  }

  if (sendAllBtn) {
    sendAllBtn.classList.remove("hidden");
    sendAllBtn.textContent = `Enviar todos (${due.length})`;
  }

  host.innerHTML = due.map(({ a, label }) => `
    <div class="appt">
      <div class="appt__time"><div class="h">${formatTimeBR(a.starts_at)}</div><div class="d">${new Date(a.starts_at).toLocaleDateString("pt-BR")}</div></div>
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${esc(a.client_name)}</span>
          <span class="badge badge--requested">${esc(label)}</span>
        </div>
        <div class="appt__meta">${esc(a.service_name)} · ${esc(a.client_phone)}</div>
        <div class="appt__actions">
          <button class="btn btn--wa btn--sm" data-rem="${a.id}">Enviar no WhatsApp</button>
        </div>
      </div>
    </div>`).join("");

  host.querySelectorAll("[data-rem]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const item = due.find((d) => d.a.id === btn.dataset.rem);
      if (!item) return;
      window.open(waLink(item.a.client_phone, reminderMessage(item.a)), "_blank");
      await markReminderSent(item.a, item.kind);
      renderReminders();
      toast("Lembrete aberto no WhatsApp. Marcado como enviado.", "success");
    }));
}

// Abre os lembretes do dia em sequência, com um pequeno intervalo entre eles
// para o navegador não bloquear as abas. Cada aba já vem com a mensagem pronta.
let sendingAll = false;
async function sendAllReminders() {
  if (sendingAll) return;
  const due = (state.dueReminders || []).slice();
  if (due.length === 0) { toast("Nenhum lembrete pendente.", "info"); return; }
  if (!confirm(`Abrir ${due.length} conversa(s) do WhatsApp, uma a uma? Você confirma o envio em cada uma.`)) return;

  sendingAll = true;
  const btn = document.getElementById("send-all-reminders");
  const restore = setLoading(btn, true, "Abrindo...");
  try {
    for (const item of due) {
      window.open(waLink(item.a.client_phone, reminderMessage(item.a)), "_blank");
      await markReminderSent(item.a, item.kind);
      // intervalo curto entre aberturas (evita bloqueio de pop-up)
      await new Promise((r) => setTimeout(r, 700));
    }
    toast(`${due.length} lembrete(s) aberto(s) no WhatsApp.`, "success");
    renderReminders();
  } finally {
    sendingAll = false;
    restore();
  }
}

function renderGreeting() {
  const host = document.getElementById("dash-greeting");
  if (!host) return;
  const now = new Date();
  const h = now.getHours();
  const saud = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  const nome = (state.profile?.full_name || "").trim() || "profissional";
  const dataStr = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  host.innerHTML = `
    <h2>${saud}, ${esc(nome)} 👋</h2>
    <p>${esc(dataStr)}</p>`;
}

// Horários livres de HOJE, considerando agenda, duração dos serviços,
// folgas e bloqueios. Usa o mesmo motor de cálculo da página pública.
function freeSlotsTodayCount() {
  if (state.services.length === 0 || state.availability.length === 0) return 0;
  const activeServices = state.services.filter((s) => s.active);
  if (activeServices.length === 0) return 0;
  // usa a MENOR duração entre os serviços ativos (horários que cabem ao menos 1 serviço)
  const minDur = Math.min(...activeServices.map((s) => s.duration_minutes));

  const day = new Date(); day.setHours(0, 0, 0, 0);
  const from = new Date(day);
  const to = new Date(day); to.setDate(to.getDate() + 1);

  // ocupados: agendamentos solicitados/confirmados de hoje + bloqueios de hoje
  const busy = [];
  for (const a of state.today) {
    if (a.status === "requested" || a.status === "confirmed")
      busy.push({ starts_at: a.starts_at, ends_at: a.ends_at });
  }
  for (const b of state.blocks) {
    if (new Date(b.starts_at) < to && new Date(b.ends_at) > from)
      busy.push({ starts_at: b.starts_at, ends_at: b.ends_at });
  }

  return computeFreeSlots({
    day, durationMin: minDur,
    availability: state.availability, busy, now: new Date(),
    bufferMin: state.profile?.buffer_minutes || 0,
    blockHolidays: !state.profile?.work_holidays,
  }).length;
}

function renderDashCards() {
  const host = document.getElementById("dash-cards");
  if (!host) return;

  const notCancelled = state.today.filter((a) => a.status !== "cancelled");
  const counts = { requested: 0, confirmed: 0, completed: 0, cancelled: 0 };
  for (const a of state.today) counts[a.status] = (counts[a.status] || 0) + 1;

  // próximo cliente: próximo agendamento futuro de hoje (confirmado ou solicitado)
  const now = Date.now();
  const next = state.today
    .filter((a) => (a.status === "confirmed" || a.status === "requested") && new Date(a.starts_at).getTime() >= now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];

  // faturamento
  const previsto = state.today
    .filter((a) => a.status === "confirmed" || a.status === "requested")
    .reduce((sum, a) => sum + apptPrice(a), 0);
  const recebido = state.today
    .filter((a) => a.status === "completed")
    .reduce((sum, a) => sum + apptPrice(a), 0);

  const freeCount = freeSlotsTodayCount();

  const cards = [];

  // 1. Agendamentos de hoje + status
  cards.push(`
    <div class="dash-card">
      <div class="dash-card__head"><span class="dash-card__icon">🗓️</span> Agendamentos de hoje</div>
      <div class="dash-card__num">${notCancelled.length}</div>
      <div class="dash-status-line">
        <span class="badge badge--requested">${counts.requested} solicitado(s)</span>
        <span class="badge badge--confirmed">${counts.confirmed} confirmado(s)</span>
        <span class="badge badge--completed">${counts.completed} concluído(s)</span>
      </div>
    </div>`);

  // 2. Próximo cliente
  if (next) {
    const svc = serviceById(next.service_id);
    const msg = `Olá ${next.client_name}! Sobre seu agendamento de ${next.service_name} às ${formatTimeBR(next.starts_at)}.`;
    cards.push(`
      <div class="dash-card">
        <div class="dash-card__head"><span class="dash-card__icon">⏭️</span> Próximo cliente</div>
        <div class="dash-next">
          <div class="dash-next__time">${formatTimeBR(next.starts_at)}</div>
          <div>
            <div style="font-weight:700">${esc(next.client_name)}</div>
            <div class="dash-card__sub">${esc(next.service_name)}${svc ? " · " + formatBRL(svc.price_cents) : ""}</div>
          </div>
        </div>
        <div class="dash-card__row">
          <button class="btn btn--wa btn--sm" data-wa-next="1">WhatsApp</button>
        </div>
      </div>`);
  } else {
    cards.push(`
      <div class="dash-card">
        <div class="dash-card__head"><span class="dash-card__icon">⏭️</span> Próximo cliente</div>
        <div class="dash-card__num" style="font-size:1.1rem;font-weight:700">Nada por agora</div>
        <div class="dash-card__sub">Sem próximos atendimentos hoje.</div>
      </div>`);
  }

  // 3. Pedidos aguardando confirmação + ações rápidas
  const pending = state.today.filter((a) => a.status === "requested")
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  cards.push(`
    <div class="dash-card">
      <div class="dash-card__head"><span class="dash-card__icon">⏳</span> Aguardando confirmação</div>
      <div class="dash-card__num">${pending.length}</div>
      ${pending.length
        ? pending.slice(0, 3).map((a) => `
          <div class="spread" style="gap:8px">
            <span class="dash-card__sub">${formatTimeBR(a.starts_at)} · ${esc(a.client_name)}</span>
            <span style="display:flex;gap:4px">
              <button class="btn btn--wa btn--sm" data-action="confirm" data-id="${a.id}">✓</button>
              <button class="btn btn--danger btn--sm" data-action="cancel" data-id="${a.id}">✕</button>
            </span>
          </div>`).join("")
        : `<div class="dash-card__sub">Nenhum pedido pendente.</div>`}
    </div>`);

  // 4. Horários livres hoje
  cards.push(`
    <div class="dash-card">
      <div class="dash-card__head"><span class="dash-card__icon">🕒</span> Horários livres hoje</div>
      <div class="dash-card__num">${freeCount}</div>
      <div class="dash-card__sub">${state.availability.length ? "Calculado com agenda, folgas e bloqueios." : "Defina seus horários de atendimento."}</div>
    </div>`);

  // 5. Faturamento (previsto vs recebido) — clicável para ver o detalhamento
  cards.push(`
    <div class="dash-card dash-card--clickable" data-revenue="1" role="button" tabindex="0">
      <div class="dash-card__head"><span class="dash-card__icon">💰</span> Faturamento de hoje</div>
      <div class="dash-card__num">${formatBRL(previsto)}</div>
      <div class="dash-card__sub">previsto (solicitado + confirmado)</div>
      <div style="font-weight:700;margin-top:4px">${formatBRL(recebido)} <span class="dash-card__sub" style="font-weight:400">recebido (concluído)</span></div>
      <div class="dash-card__link">🔎 Ver detalhamento</div>
    </div>`);

  // 6. Confirmação de presença — considera confirmados de hoje + próximos dias
  const presencePool = [
    ...state.today.filter((a) => a.status === "confirmed"),
    ...(state.upcoming || []),
  ];
  // de-duplica por id
  const seen = new Set();
  const pool = presencePool.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  const attConfirmed = pool.filter((a) => a.attendance === "confirmed").length;
  const attPending = pool.filter((a) => a.attendance !== "confirmed" && a.attendance !== "declined").length;
  const reschedule = pool.filter((a) => a.reschedule_requested).length;
  const cancelledToday = state.today.filter((a) => a.status === "cancelled").length;
  cards.push(`
    <div class="dash-card">
      <div class="dash-card__head"><span class="dash-card__icon">✅</span> Confirmação de presença</div>
      <div class="dash-card__num">${attConfirmed}</div>
      <div class="dash-card__sub">confirmaram presença</div>
      <div class="dash-status-line" style="margin-top:4px">
        <span class="badge badge--requested">${attPending} sem resposta</span>
        ${reschedule ? `<span class="badge badge--requested">${reschedule} reagendamento(s)</span>` : ""}
        ${cancelledToday ? `<span class="badge badge--cancelled">${cancelledToday} cancelado(s) hoje</span>` : ""}
      </div>
    </div>`);

  host.innerHTML = cards.join("");

  // listeners dos cards
  const waNextBtn = host.querySelector("[data-wa-next]");
  if (waNextBtn && next) {
    waNextBtn.addEventListener("click", () => {
      const msg = `Olá ${next.client_name}! Sobre seu agendamento de ${next.service_name} às ${formatTimeBR(next.starts_at)}.`;
      window.open(waLink(next.client_phone, msg), "_blank");
    });
  }
  host.querySelectorAll("[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => handleApptAction(btn.dataset.action, btn.dataset.id)));

  // card de faturamento → abre detalhamento
  const revCard = host.querySelector("[data-revenue]");
  if (revCard) {
    const open = () => openRevenueDetails();
    revCard.addEventListener("click", open);
    revCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
}

// Modal com o detalhamento do faturamento de hoje:
// mostra exatamente quais agendamentos compõem o "previsto" e o "recebido".
function openRevenueDetails() {
  const previstoItems = state.today
    .filter((a) => a.status === "confirmed" || a.status === "requested")
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const recebidoItems = state.today
    .filter((a) => a.status === "completed")
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  const sum = (list) => list.reduce((s, a) => s + apptPrice(a), 0);

  const linha = (a) => `
    <div class="spread" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <span>
        <strong>${formatTimeBR(a.starts_at)}</strong> · ${esc(a.client_name)}
        <span class="dash-card__sub">— ${esc(a.service_name)}</span>
        <span class="badge badge--${a.status}" style="margin-left:4px">${STATUS_LABEL[a.status]}</span>
      </span>
      <strong>${formatBRL(apptPrice(a))}</strong>
    </div>`;

  const bloco = (titulo, desc, list) => `
    <div class="card" style="box-shadow:none">
      <div class="spread">
        <h3 class="mb-0" style="font-size:1rem">${titulo}</h3>
        <strong>${formatBRL(sum(list))}</strong>
      </div>
      <p class="help" style="margin-top:2px">${desc}</p>
      ${list.length ? list.map(linha).join("") : `<div class="dash-card__sub">Nenhum agendamento neste grupo.</div>`}
    </div>`;

  openModal(`
    <h2 class="mb-0">Faturamento de hoje — detalhamento</h2>
    <p class="help">Os preços vêm do valor atual de cada serviço cadastrado.</p>
    ${bloco("Previsto", "Agendamentos <strong>solicitados</strong> e <strong>confirmados</strong> — ainda não concluídos.", previstoItems)}
    ${bloco("Recebido", "Agendamentos marcados como <strong>concluídos</strong> (atendimento realizado).", recebidoItems)}
    <p class="help" style="margin-top:10px">Agendamentos <strong>cancelados</strong> não entram em nenhum dos totais.</p>
  `);
}

function renderDashToday() {
  const host = document.getElementById("dash-today");
  if (!host) return;
  const items = state.today.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  if (items.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum atendimento hoje. Aproveite para divulgar seu link!</div>`;
    return;
  }
  host.innerHTML = items.map((a) => {
    const svc = serviceById(a.service_id);
    const start = new Date(a.starts_at);
    return `
    <div class="appt">
      <div class="appt__time">
        <div class="h">${formatTimeBR(start)}</div>
      </div>
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${esc(a.client_name)}</span>
          <span class="badge badge--${a.status}">${STATUS_LABEL[a.status]}</span>
        </div>
        <div class="appt__meta">${esc(a.service_name)}${svc ? " · " + formatBRL(svc.price_cents) : ""} · ${esc(a.client_phone)}</div>
        <div class="appt__actions">
          ${a.status === "requested" ? `<button class="btn btn--wa btn--sm" data-action="confirm" data-id="${a.id}">Confirmar</button>` : ""}
          ${a.status === "confirmed" ? `<button class="btn btn--ghost btn--sm" data-action="complete" data-id="${a.id}">Concluir</button>` : ""}
          ${a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--ghost btn--sm" data-action="reschedule" data-id="${a.id}">Reagendar</button>` : ""}
          ${a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--danger btn--sm" data-action="cancel" data-id="${a.id}">Cancelar</button>` : ""}
          <button class="btn btn--wa btn--sm" data-action="whatsapp" data-id="${a.id}">WhatsApp</button>
        </div>
      </div>
    </div>`;
  }).join("");
  host.querySelectorAll("[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => handleApptAction(btn.dataset.action, btn.dataset.id)));
}

// Modal de novo cliente (atalho do dashboard)
function openClientModal() {
  openModal(`
    <h2 class="mb-0">Adicionar cliente</h2>
    <form id="cl-form" style="margin-top:14px">
      <div class="field"><label>Nome</label><input class="input" id="cl-name" required></div>
      <div class="field"><label>WhatsApp (com DDD)</label><input class="input" id="cl-phone" placeholder="5511999999999" required></div>
      <div class="field"><label>Observações</label><textarea class="textarea" id="cl-notes"></textarea></div>
      <button class="btn btn--primary btn--block" id="cl-submit" type="submit">Salvar cliente</button>
    </form>
  `);
  document.getElementById("cl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("cl-submit");
    const restore = setLoading(btn, true, "Salvando...");
    try {
      const phone = document.getElementById("cl-phone").value.replace(/\D/g, "");
      if (phone.length < 10) { toast("Informe um WhatsApp válido com DDD.", "error"); return; }
      const payload = {
        profile_id: state.user.id,
        name: document.getElementById("cl-name").value.trim(),
        phone,
        notes: document.getElementById("cl-notes").value.trim(),
      };
      const { error } = await supabase.from("clients").insert(payload);
      if (error) {
        toast(/duplicate|unique/i.test(error.message) ? "Já existe um cliente com esse telefone." : "Erro: " + error.message, "error");
        return;
      }
      toast("Cliente salvo.", "success");
      closeModal();
      await loadClients();
      renderClients();
      renderDashboard();
    } finally {
      restore();
    }
  });
}

// =============================================================================
// Navegação entre abas
// =============================================================================
function bindNav() {
  document.querySelectorAll("#tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const view = tab.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
      document.getElementById(`view-${view}`).classList.remove("hidden");
      if (view === "report") loadAndRenderReport();
    });
  });
}

function bindGlobalButtons() {
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "./index.html";
  });
  document.getElementById("btn-share")?.addEventListener("click", shareLink);
  document.getElementById("btn-new-service")?.addEventListener("click", () => openServiceModal());
  document.getElementById("btn-new-appt")?.addEventListener("click", () => openApptModal());
  document.getElementById("btn-new-block")?.addEventListener("click", () => openBlockModal());
  document.getElementById("nav-share")?.addEventListener("click", shareLink);
  document.getElementById("nav-public")?.addEventListener("click", () => window.open(publicUrl(), "_blank", "noopener"));
  document.getElementById("send-all-reminders")?.addEventListener("click", sendAllReminders);
  bindClientFilters();
  bindSidebar();
}

// --- Sidebar: drawer mobile, collapse desktop, fechar ao navegar ----------
function bindSidebar() {
  const shell = document.getElementById("app-shell");
  const openDrawer = () => shell?.classList.add("is-drawer-open");
  const closeDrawer = () => shell?.classList.remove("is-drawer-open");

  document.getElementById("menu-toggle")?.addEventListener("click", openDrawer);
  document.getElementById("sidebar-backdrop")?.addEventListener("click", closeDrawer);
  document.getElementById("sidebar-collapse")?.addEventListener("click", () =>
    shell?.classList.toggle("is-collapsed"));

  // fecha o drawer ao escolher um item (mobile)
  document.querySelectorAll("#tabs .nav-item").forEach((n) =>
    n.addEventListener("click", closeDrawer));
}

function shareLink() {
  const url = publicUrl();
  if (navigator.share) {
    navigator.share({ title: "AgendaAí", text: "Agende comigo:", url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
    toast("Link copiado: " + url, "success");
  }
}

function publicUrl() {
  // Monta o link a partir do DIRETÓRIO atual, para funcionar tanto com URL
  // "app.html" quanto com URL limpa "/app" (alguns servidores omitem .html).
  const { origin, pathname } = window.location;
  const dir = pathname.replace(/\/[^/]*$/, "/"); // remove o último segmento (app, app.html...)
  const slug = encodeURIComponent(state.profile?.slug || "");
  return `${origin}${dir}agendar.html?slug=${slug}`;
}

// =============================================================================
// Render geral
// =============================================================================
function renderAll() {
  renderDashboard();
  renderStats();
  renderAgenda();
  renderServices();
  renderAvailability();
  renderBlocks();
  renderClients();
  renderProfile();
}

// --- Estatísticas ----------------------------------------------------------
function renderStats() {
  const today = state.appointments.filter((a) => isToday(a.starts_at) && a.status !== "cancelled");
  const confirmed = today.filter((a) => a.status === "confirmed").length;
  const requested = state.appointments.filter((a) => a.status === "requested").length;
  const host = document.getElementById("stats");
  host.innerHTML = `
    <div class="stat"><div class="stat__num">${today.length}</div><div class="stat__label">Hoje</div></div>
    <div class="stat"><div class="stat__num">${confirmed}</div><div class="stat__label">Confirmados hoje</div></div>
    <div class="stat"><div class="stat__num">${requested}</div><div class="stat__label">Pedidos pendentes</div></div>
    <div class="stat"><div class="stat__num">${state.clients.length}</div><div class="stat__label">Clientes</div></div>`;
}

// =============================================================================
// AGENDA
// =============================================================================
function bindAgendaControls() {
  document.querySelectorAll("[data-range]").forEach((b) => {
    b.addEventListener("click", async () => {
      document.querySelectorAll("[data-range]").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      state.agendaRange = b.dataset.range;
      await loadAppointments();
      renderAgenda();
    });
  });
  document.getElementById("nav-prev")?.addEventListener("click", () => shiftRange(-1));
  document.getElementById("nav-next")?.addEventListener("click", () => shiftRange(1));
  document.getElementById("att-filter")?.addEventListener("change", (e) => {
    state.attFilter = e.target.value;
    renderAgenda();
  });
  // Seletor de calendário: pula direto para a data escolhida
  document.getElementById("agenda-jump")?.addEventListener("change", async (e) => {
    if (!e.target.value) return;
    state.cursor = new Date(e.target.value + "T12:00:00");
    await loadAppointments();
    renderAgenda();
  });
  document.getElementById("agenda-today")?.addEventListener("click", async () => {
    state.cursor = new Date();
    await loadAppointments();
    renderAgenda();
  });
}

async function shiftRange(dir) {
  const c = new Date(state.cursor);
  if (state.agendaRange === "day") c.setDate(c.getDate() + dir);
  else if (state.agendaRange === "week") c.setDate(c.getDate() + 7 * dir);
  else c.setMonth(c.getMonth() + dir);
  state.cursor = c;
  await loadAppointments();
  renderAgenda();
}

function currentRangeBounds() {
  const c = new Date(state.cursor);
  c.setHours(0, 0, 0, 0);
  if (state.agendaRange === "day") {
    const to = new Date(c); to.setDate(to.getDate() + 1);
    return [c, to];
  }
  if (state.agendaRange === "week") {
    const from = new Date(c); from.setDate(from.getDate() - from.getDay());
    const to = new Date(from); to.setDate(to.getDate() + 7);
    return [from, to];
  }
  const from = new Date(c.getFullYear(), c.getMonth(), 1);
  const to = new Date(c.getFullYear(), c.getMonth() + 1, 1);
  return [from, to];
}

function renderAgenda() {
  const [from, to] = currentRangeBounds();
  // sincroniza o seletor de calendário com a data atual da agenda
  const jump = document.getElementById("agenda-jump");
  if (jump) jump.value = isoDateLocal(state.cursor);
  const label = document.getElementById("range-label");
  if (state.agendaRange === "day") label.textContent = formatDateTimeFull(from).split(",")[0] + ", " + from.toLocaleDateString("pt-BR");
  else if (state.agendaRange === "week") label.textContent = `${from.toLocaleDateString("pt-BR")} – ${new Date(to - 1).toLocaleDateString("pt-BR")}`;
  else label.textContent = from.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const host = document.getElementById("agenda-list");
  let items = state.appointments.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  // filtro por confirmação de presença
  const f = state.attFilter;
  if (f === "confirmed") items = items.filter((a) => a.attendance === "confirmed");
  else if (f === "pending") items = items.filter((a) => (a.attendance ?? "pending") === "pending" && a.status !== "cancelled" && a.status !== "completed");
  else if (f === "declined") items = items.filter((a) => a.attendance === "declined" || a.status === "cancelled");
  else if (f === "reschedule") items = items.filter((a) => a.reschedule_requested);

  if (items.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum agendamento ${f === "all" ? "neste período" : "para este filtro"}.</div>`;
    return;
  }

  // agrupa por dia
  const groups = {};
  for (const a of items) {
    const key = isoDateLocal(a.starts_at);
    (groups[key] ||= []).push(a);
  }
  host.innerHTML = Object.entries(groups).map(([key, list]) => {
    const d = new Date(key + "T12:00:00");
    const head = state.agendaRange === "day" ? "" :
      `<h4 style="margin:16px 0 8px">${DOW_FULL[d.getDay()]}, ${d.toLocaleDateString("pt-BR")}</h4>`;
    return head + list.map(apptCard).join("");
  }).join("");

  host.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleApptAction(btn.dataset.action, btn.dataset.id));
  });
}

// Badge de confirmação de presença (separado do status do agendamento)
function attendanceBadge(a) {
  if (a.status === "cancelled" || a.status === "completed") return "";
  if (a.attendance === "confirmed") return `<span class="badge badge--confirmed">Presença ✓</span>`;
  if (a.attendance === "declined") return `<span class="badge badge--cancelled">Recusou</span>`;
  return `<span class="badge badge--requested">Sem resposta</span>`;
}

// Badge do sinal/entrada (none | pending | paid)
function depositBadge(a) {
  const valor = a.deposit_cents ? ` ${formatBRL(a.deposit_cents)}` : "";
  if (a.deposit_status === "pending") return ` <span class="badge badge--requested">Aguardando sinal${valor}</span>`;
  if (a.deposit_status === "paid") return ` <span class="badge badge--confirmed">Sinal pago${valor}</span>`;
  return "";
}

// Destaque discreto: confirmado, próximo (< 24h) e ainda sem resposta do cliente
function needsAttention(a) {
  if (a.status !== "confirmed") return false;
  if (a.attendance === "confirmed") return false;
  const hoursTo = (new Date(a.starts_at).getTime() - Date.now()) / 3600000;
  return hoursTo > 0 && hoursTo <= 24;
}

function apptCard(a) {
  const start = new Date(a.starts_at);
  const attention = needsAttention(a);
  return `
  <div class="appt ${attention ? "appt--attention" : ""}">
    <div class="appt__time">
      <div class="h">${formatTimeBR(start)}</div>
      <div class="d">${DOW[start.getDay()]} ${start.getDate()}/${start.getMonth() + 1}</div>
    </div>
    <div class="appt__body">
      <div class="spread">
        <span class="appt__name">${esc(a.client_name)}</span>
        <span class="badge badge--${a.status}">${STATUS_LABEL[a.status]}</span>
      </div>
      <div class="appt__meta">${esc(a.service_name)} · ${esc(a.client_phone)}</div>
      <div style="margin-top:4px">${attendanceBadge(a)}${depositBadge(a)}${a.reschedule_requested ? ' <span class="badge badge--requested">Pediu reagendamento</span>' : ""}</div>
      ${a.attendance === "confirmed" && a.attendance_at ? `<div class="appt__meta">Confirmou em ${formatDateTimeFull(a.attendance_at)}</div>` : ""}
      ${a.notes ? `<div class="appt__meta">📝 ${esc(a.notes)}</div>` : ""}
      <div class="appt__actions">
        ${a.deposit_status === "pending" && a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--wa btn--sm" data-action="deposit" data-id="${a.id}">Sinal recebido</button>` : ""}
        ${a.status === "requested" ? `<button class="btn btn--wa btn--sm" data-action="confirm" data-id="${a.id}">Confirmar</button>` : ""}
        ${a.status === "confirmed" ? `<button class="btn btn--ghost btn--sm" data-action="complete" data-id="${a.id}">Concluir</button>` : ""}
        ${a.status === "confirmed" ? `<button class="btn btn--ghost btn--sm" data-action="noshow" data-id="${a.id}">Faltou</button>` : ""}
        ${a.status === "confirmed" ? `<button class="btn btn--wa btn--sm" data-action="remind" data-id="${a.id}">Lembrete</button>` : ""}
        ${a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--ghost btn--sm" data-action="sendlink" data-id="${a.id}">Enviar link</button>` : ""}
        ${a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--ghost btn--sm" data-action="reschedule" data-id="${a.id}">Reagendar</button>` : ""}
        ${a.status !== "cancelled" && a.status !== "completed" ? `<button class="btn btn--danger btn--sm" data-action="cancel" data-id="${a.id}">Cancelar</button>` : ""}
        <button class="btn btn--wa btn--sm" data-action="whatsapp" data-id="${a.id}">WhatsApp</button>
      </div>
    </div>
  </div>`;
}

async function handleApptAction(action, id) {
  const appt = state.appointments.find((a) => a.id === id)
    || state.today.find((a) => a.id === id);
  if (!appt) return;

  if (action === "whatsapp") {
    const msg = `Olá ${appt.client_name}! Sobre seu agendamento de ${appt.service_name} em ${formatDateTimeFull(appt.starts_at)}.`;
    window.open(waLink(appt.client_phone, msg), "_blank");
    return;
  }
  if (action === "remind") {
    // envia lembrete manual com o link seguro de confirmação
    window.open(waLink(appt.client_phone, reminderMessage(appt)), "_blank");
    const hoursTo = (new Date(appt.starts_at).getTime() - Date.now()) / 3600000;
    await markReminderSent(appt, hoursTo <= reminderHours().h2 ? "short" : "24h");
    toast("Lembrete aberto no WhatsApp.", "success");
    return;
  }
  if (action === "sendlink") {
    // envia ao cliente o link para confirmar presença, cancelar ou reagendar
    const link = `${reminderBaseUrl()}?t=${encodeURIComponent(appt.public_token)}`;
    const msg = `Olá ${appt.client_name}! Sobre seu agendamento de ${appt.service_name} em ${formatDateTimeFull(appt.starts_at)}. ` +
      `Se precisar confirmar presença, cancelar ou reagendar, é só acessar: ${link}`;
    window.open(waLink(appt.client_phone, msg), "_blank");
    toast("Link enviado pelo WhatsApp.", "success");
    return;
  }
  if (action === "reschedule") { openApptModal(appt); return; }

  // Sinal recebido: marca deposit_status = 'paid' (não altera o status do agendamento).
  if (action === "deposit") {
    if (!confirm("Confirmar que o sinal deste cliente foi recebido?")) return;
    const { error } = await supabase.from("appointments")
      .update({ deposit_status: "paid" }).eq("id", id);
    if (error) { toast("Não foi possível registrar o sinal: " + error.message, "error"); return; }
    toast("Sinal registrado como recebido.", "success");
    await Promise.all([loadAppointments(), loadToday(), loadUpcomingConfirmed(), loadAllAppointments()]);
    renderAgenda(); renderStats(); renderDashboard(); renderClients();
    return;
  }

  const newStatus = { confirm: "confirmed", complete: "completed", cancel: "cancelled", noshow: "no_show" }[action];
  if (!newStatus) return;

  if (action === "cancel" && !confirm("Cancelar este agendamento?")) return;
  if (action === "noshow" && !confirm("Marcar que o cliente FALTOU a este atendimento?")) return;

  const { error } = await supabase.from("appointments")
    .update({ status: newStatus }).eq("id", id);
  if (error) {
    // provável conflito de constraint ao confirmar
    if (newStatus === "confirmed" && /overlap|exclusion|conflict/i.test(error.message)) {
      toast("Já existe outro agendamento confirmado neste horário.", "error");
    } else {
      toast("Não foi possível atualizar: " + error.message, "error");
    }
    return;
  }
  toast(`Agendamento ${STATUS_LABEL[newStatus].toLowerCase()}.`, "success");
  await Promise.all([loadAppointments(), loadToday(), loadUpcomingConfirmed(), loadAllAppointments()]);
  renderAgenda();
  renderStats();
  renderDashboard();
  renderClients();
}

// =============================================================================
// SERVIÇOS
// =============================================================================
function renderServices() {
  const host = document.getElementById("services-list");
  const limitEl = document.getElementById("service-limit");
  limitEl.textContent = `${state.services.length} serviço(s) cadastrado(s).`;

  if (state.services.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum serviço ainda. Cadastre o primeiro.</div>`;
    return;
  }
  host.innerHTML = state.services.map((s) => `
    <div class="appt">
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${esc(s.name)} ${s.active ? "" : '<span class="badge badge--cancelled">inativo</span>'}</span>
          <span class="service-opt__price">${formatBRL(s.price_cents)}</span>
        </div>
        <div class="appt__meta">${s.duration_minutes} min</div>
        <div class="appt__actions">
          <button class="btn btn--ghost btn--sm" data-edit="${s.id}">Editar</button>
          <button class="btn btn--danger btn--sm" data-del="${s.id}">Excluir</button>
        </div>
      </div>
    </div>`).join("");

  host.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openServiceModal(state.services.find((s) => s.id === b.dataset.edit))));
  host.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteService(b.dataset.del)));
}

function openServiceModal(svc = null) {
  openModal(`
    <h2 class="mb-0">${svc ? "Editar" : "Novo"} serviço</h2>
    <form id="svc-form" style="margin-top:14px">
      <div class="field"><label>Nome</label><input class="input" id="s-name" value="${esc(svc?.name || "")}" required></div>
      <div class="field"><label>Descrição (opcional)</label><textarea class="textarea" id="s-desc" placeholder="Ex: inclui lavagem e finalização">${esc(svc?.description || "")}</textarea>
        <div class="help">Aparece na página pública abaixo do nome do serviço.</div>
      </div>
      <div class="row">
        <div class="field"><label>Duração (min)</label><input class="input" id="s-dur" type="number" min="5" step="5" value="${svc?.duration_minutes || 30}" required></div>
        <div class="field"><label>Preço (R$)</label><input class="input" id="s-price" type="number" min="0" step="0.01" value="${svc ? (svc.price_cents / 100).toFixed(2) : "0.00"}"></div>
      </div>
      <div class="field"><label>URL da imagem (opcional)</label><input class="input" id="s-image" value="${esc(svc?.image_url || "")}" placeholder="https://...">
        <div class="help">Aparece na sua página pública ao lado do serviço.</div>
      </div>
      <div class="field"><label><input type="checkbox" id="s-active" ${svc ? (svc.active ? "checked" : "") : "checked"}> Ativo (visível na página pública)</label></div>
      <button class="btn btn--primary btn--block" id="s-submit" type="submit">${svc ? "Salvar" : "Criar"}</button>
    </form>
  `);
  document.getElementById("svc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("s-submit");
    const restore = setLoading(btn, true, "Salvando...");
    const payload = {
      profile_id: state.user.id,
      name: document.getElementById("s-name").value.trim(),
      description: document.getElementById("s-desc").value.trim(),
      duration_minutes: parseInt(document.getElementById("s-dur").value, 10),
      price_cents: Math.round(parseFloat(document.getElementById("s-price").value || "0") * 100),
      image_url: document.getElementById("s-image").value.trim(),
      active: document.getElementById("s-active").checked,
    };
    const q = svc
      ? supabase.from("services").update(payload).eq("id", svc.id)
      : supabase.from("services").insert(payload);
    const { error } = await q;
    restore();
    if (error) { toast("Erro: " + error.message, "error"); return; }
    toast("Serviço salvo.", "success");
    closeModal();
    await loadServices();
    renderServices();
  });
}

async function deleteService(id) {
  if (!confirm("Excluir este serviço?")) return;
  const { error } = await supabase.from("services").delete().eq("id", id);
  if (error) { toast("Erro: " + error.message, "error"); return; }
  toast("Serviço excluído.", "success");
  await loadServices();
  renderServices();
}

// =============================================================================
// HORÁRIOS (availability) + BLOQUEIOS
// =============================================================================
function renderAvailability() {
  const host = document.getElementById("availability-list");
  host.innerHTML = DOW_FULL.map((name, wd) => {
    const windows = state.availability.filter((a) => a.weekday === wd);
    const chips = windows.map((w) => `
      <span class="badge badge--confirmed" style="margin:2px">
        ${w.start_time.slice(0, 5)}–${w.end_time.slice(0, 5)}
        <a href="#" data-del-av="${w.id}" style="color:inherit;font-weight:800">✕</a>
      </span>`).join(" ") || '<span class="muted small">Fechado</span>';
    return `
      <div class="spread" style="padding:10px 0;border-bottom:1px solid var(--border)">
        <strong style="min-width:92px">${name}</strong>
        <div style="flex:1">${chips}</div>
        <button class="btn btn--ghost btn--sm" data-add-av="${wd}">+ janela</button>
      </div>`;
  }).join("");

  host.querySelectorAll("[data-add-av]").forEach((b) =>
    b.addEventListener("click", () => openAvailabilityModal(parseInt(b.dataset.addAv, 10))));
  host.querySelectorAll("[data-del-av]").forEach((b) =>
    b.addEventListener("click", (e) => { e.preventDefault(); deleteAvailability(b.dataset.delAv); }));
}

function openAvailabilityModal(weekday) {
  openModal(`
    <h2 class="mb-0">Janela de atendimento — ${DOW_FULL[weekday]}</h2>
    <form id="av-form" style="margin-top:14px">
      <div class="row">
        <div class="field"><label>Início</label><input class="input" id="av-start" type="time" value="09:00" required></div>
        <div class="field"><label>Fim</label><input class="input" id="av-end" type="time" value="18:00" required></div>
      </div>
      <button class="btn btn--primary btn--block" type="submit">Adicionar</button>
    </form>
  `);
  document.getElementById("av-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const start = document.getElementById("av-start").value;
    const end = document.getElementById("av-end").value;
    if (end <= start) { toast("O fim deve ser depois do início.", "error"); return; }
    const { error } = await supabase.from("availability").insert({
      profile_id: state.user.id, weekday, start_time: start, end_time: end,
    });
    if (error) { toast("Erro: " + error.message, "error"); return; }
    closeModal();
    await loadAvailability();
    renderAvailability();
  });
}

async function deleteAvailability(id) {
  const { error } = await supabase.from("availability").delete().eq("id", id);
  if (error) { toast("Erro: " + error.message, "error"); return; }
  await loadAvailability();
  renderAvailability();
}

function renderBlocks() {
  const host = document.getElementById("blocks-list");
  if (state.blocks.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum bloqueio futuro.</div>`;
    return;
  }
  host.innerHTML = state.blocks.map((b) => `
    <div class="appt">
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${formatDateTimeFull(b.starts_at)}</span>
          <button class="btn btn--danger btn--sm" data-del-block="${b.id}">Remover</button>
        </div>
        <div class="appt__meta">até ${formatDateTimeFull(b.ends_at)} ${b.reason ? "· " + esc(b.reason) : ""}</div>
      </div>
    </div>`).join("");
  host.querySelectorAll("[data-del-block]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { error } = await supabase.from("time_blocks").delete().eq("id", b.dataset.delBlock);
      if (error) { toast("Erro: " + error.message, "error"); return; }
      await loadBlocks();
      renderBlocks();
    }));
}

function openBlockModal() {
  const today = isoDateLocal(new Date());
  openModal(`
    <h2 class="mb-0">Novo bloqueio / folga</h2>
    <form id="bk-form" style="margin-top:14px">
      <div class="field"><label>Início</label><input class="input" id="bk-start" type="datetime-local" value="${today}T12:00" required></div>
      <div class="field"><label>Fim</label><input class="input" id="bk-end" type="datetime-local" value="${today}T13:00" required></div>
      <div class="field"><label>Motivo (opcional)</label><input class="input" id="bk-reason" placeholder="Almoço, feriado..."></div>
      <button class="btn btn--primary btn--block" type="submit">Bloquear horário</button>
    </form>
  `);
  document.getElementById("bk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const start = new Date(document.getElementById("bk-start").value);
    const end = new Date(document.getElementById("bk-end").value);
    if (end <= start) { toast("O fim deve ser depois do início.", "error"); return; }
    const { error } = await supabase.from("time_blocks").insert({
      profile_id: state.user.id,
      starts_at: start.toISOString(), ends_at: end.toISOString(),
      reason: document.getElementById("bk-reason").value.trim(),
    });
    if (error) { toast("Erro: " + error.message, "error"); return; }
    closeModal();
    await loadBlocks();
    renderBlocks();
    renderDashboard();
  });
}

// =============================================================================
// CLIENTES
// =============================================================================
// --- Métricas por cliente (dados reais) ------------------------------------
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

// Agendamentos de um cliente: casa por client_id OU por telefone (robusto,
// pois agendamentos manuais nem sempre têm client_id).
function appointmentsOfClient(c) {
  const phone = onlyDigits(c.phone);
  return state.allAppointments.filter((a) =>
    (a.client_id && a.client_id === c.id) || (phone && onlyDigits(a.client_phone) === phone));
}

function clientMetrics(c) {
  const appts = appointmentsOfClient(c);
  const now = Date.now();
  const completed = appts.filter((a) => a.status === "completed");
  const noShows = appts.filter((a) => a.status === "no_show");
  // Taxa de falta: faltas sobre o total com desfecho (concluídos + faltas).
  const finishedCount = completed.length + noShows.length;
  const noShowRate = finishedCount ? Math.round((noShows.length / finishedCount) * 100) : 0;
  // última visita concluída (passado)
  const lastVisit = completed
    .map((a) => new Date(a.starts_at))
    .sort((x, y) => y - x)[0] || null;
  // próximo agendamento (futuro, não cancelado/concluído)
  const next = appts
    .filter((a) => (a.status === "confirmed" || a.status === "requested") && new Date(a.starts_at).getTime() >= now)
    .sort((x, y) => new Date(x.starts_at) - new Date(y.starts_at))[0] || null;
  // serviços mais usados (entre concluídos)
  const svcCount = {};
  for (const a of completed) svcCount[a.service_name] = (svcCount[a.service_name] || 0) + 1;
  const topServices = Object.entries(svcCount).sort((a, b) => b[1] - a[1]).map(([n, q]) => ({ name: n, count: q }));
  // total gasto: só concluídos, preço atual do serviço (dado confiável quando o serviço existe)
  let totalCents = 0, priceReliable = true;
  for (const a of completed) {
    const svc = serviceById(a.service_id);
    if (svc) totalCents += svc.price_cents; else priceReliable = false;
  }
  return {
    appts, completed, lastVisit, next, topServices, totalCents, priceReliable,
    completedCount: completed.length,
    noShowCount: noShows.length, noShowRate, finishedCount,
  };
}

function daysSince(date) {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

// =============================================================================
// CLIENTES — indicadores de fidelização
// =============================================================================
function renderClientStats() {
  const host = document.getElementById("client-stats");
  if (!host) return;
  const total = state.clients.length;
  let withFuture = 0, recent = 0, noRecent = 0;
  const svcCount = {};
  const gaps = []; // intervalos entre visitas concluídas (para frequência média)

  for (const c of state.clients) {
    const m = clientMetrics(c);
    if (m.next) withFuture++;
    const d = daysSince(m.lastVisit);
    if (d <= 30) recent++;
    if (!m.next && d > 30) noRecent++;
    for (const s of m.topServices) svcCount[s.name] = (svcCount[s.name] || 0) + s.count;
    // frequência: diferenças entre visitas concluídas consecutivas
    const dates = m.completed.map((a) => new Date(a.starts_at).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400000);
  }
  const topSvc = Object.entries(svcCount).sort((a, b) => b[1] - a[1])[0];
  const avgFreq = gaps.length >= 1 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  host.innerHTML = `
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">👥</span> Clientes</div>
      <div class="dash-card__num">${total}</div><div class="dash-card__sub">cadastrados</div></div>
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">🔁</span> Retornaram (30d)</div>
      <div class="dash-card__num">${recent}</div><div class="dash-card__sub">visita concluída recente</div></div>
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">⏰</span> Sem visita recente</div>
      <div class="dash-card__num">${noRecent}</div><div class="dash-card__sub">+30d e sem agendamento</div></div>
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">📅</span> Com agendamento futuro</div>
      <div class="dash-card__num">${withFuture}</div><div class="dash-card__sub">já têm próximo horário</div></div>
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">⭐</span> Serviço mais usado</div>
      <div class="dash-card__num" style="font-size:1.1rem">${topSvc ? esc(topSvc[0]) : "—"}</div>
      <div class="dash-card__sub">${topSvc ? topSvc[1] + " atendimento(s)" : "sem dados"}</div></div>
    <div class="dash-card"><div class="dash-card__head"><span class="dash-card__icon">📈</span> Frequência média</div>
      <div class="dash-card__num">${avgFreq != null ? avgFreq + "d" : "—"}</div>
      <div class="dash-card__sub">${avgFreq != null ? "entre visitas concluídas" : "dados insuficientes"}</div></div>`;
}

// Preenche o filtro de serviços com os serviços reais
function fillServiceFilter() {
  const sel = document.getElementById("filter-service");
  if (!sel) return;
  const current = sel.value;
  const names = state.services.map((s) => s.name);
  sel.innerHTML = `<option value="all">Todos</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  sel.value = names.includes(current) ? current : "all";
}

// =============================================================================
// CLIENTES — seção "precisam retornar"
// =============================================================================
function renderReturnList() {
  const host = document.getElementById("return-list");
  if (!host) return;
  const days = state.returnDays;

  const rows = state.clients.map((c) => ({ c, m: clientMetrics(c) }))
    .filter(({ m }) => !m.next && m.lastVisit && daysSince(m.lastVisit) > days)
    .sort((a, b) => a.m.lastVisit - b.m.lastVisit); // mais antigos primeiro

  if (rows.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum cliente para retornar nesse período. 👍</div>`;
    return;
  }

  host.innerHTML = rows.map(({ c, m }) => {
    const last = m.completed[0]; // mais recente concluído
    return `
    <div class="appt">
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${esc(c.name)}</span>
          <span class="badge badge--requested">${daysSince(m.lastVisit)} dias</span>
        </div>
        <div class="appt__meta">Último: ${esc(last ? last.service_name : "—")} · ${m.lastVisit ? formatDateTimeFull(m.lastVisit) : "—"}</div>
        <div class="appt__actions">
          <button class="btn btn--wa btn--sm" data-invite="${c.id}">Convidar para voltar</button>
          <button class="btn btn--ghost btn--sm" data-profile="${c.id}">Ver perfil</button>
        </div>
      </div>
    </div>`;
  }).join("");

  host.querySelectorAll("[data-invite]").forEach((b) =>
    b.addEventListener("click", () => openInviteModal(b.dataset.invite)));
  host.querySelectorAll("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => openClientProfile(b.dataset.profile)));
}

// =============================================================================
// CLIENTES — lista com busca/filtros/ordenação
// =============================================================================
function renderClients() {
  renderClientStats();
  fillServiceFilter();
  renderReturnList();

  const host = document.getElementById("clients-list");
  const f = state.clientFilters;
  const q = (document.getElementById("client-search")?.value || "").toLowerCase().trim();

  let rows = state.clients.map((c) => ({ c, m: clientMetrics(c) }));

  // busca
  if (q) rows = rows.filter(({ c }) => c.name.toLowerCase().includes(q) || onlyDigits(c.phone).includes(onlyDigits(q)));
  // última visita
  if (f.lastVisit === "never") rows = rows.filter(({ m }) => !m.lastVisit);
  else if (f.lastVisit !== "all") rows = rows.filter(({ m }) => m.lastVisit && daysSince(m.lastVisit) > Number(f.lastVisit));
  // serviço mais usado
  if (f.service !== "all") rows = rows.filter(({ m }) => m.topServices[0] && m.topServices[0].name === f.service);
  // agendamento futuro
  if (f.future === "with") rows = rows.filter(({ m }) => m.next);
  else if (f.future === "without") rows = rows.filter(({ m }) => !m.next);
  // ordenação
  if (f.sort === "name") rows.sort((a, b) => a.c.name.localeCompare(b.c.name, "pt-BR"));
  else {
    rows.sort((a, b) => {
      const av = a.m.lastVisit ? new Date(a.m.lastVisit).getTime() : 0;
      const bv = b.m.lastVisit ? new Date(b.m.lastVisit).getTime() : 0;
      return f.sort === "oldest" ? av - bv : bv - av;
    });
  }

  if (rows.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum cliente ${q || f.lastVisit !== "all" || f.service !== "all" || f.future !== "all" ? "para este filtro" : "cadastrado"}.</div>`;
    return;
  }

  host.innerHTML = rows.map(({ c, m }) => `
    <div class="appt">
      <div class="appt__body">
        <div class="spread">
          <span class="appt__name">${esc(c.name)}</span>
          ${m.next ? '<span class="badge badge--confirmed">Tem agendamento</span>'
            : m.lastVisit ? `<span class="badge badge--completed">Última: ${daysSince(m.lastVisit)}d</span>`
            : '<span class="badge badge--requested">Nunca visitou</span>'}
        </div>
        <div class="appt__meta">${esc(c.phone)} · ${m.completedCount} atendimento(s) concluído(s)</div>
        <div class="appt__actions">
          <button class="btn btn--ghost btn--sm" data-profile="${c.id}">Perfil</button>
          <button class="btn btn--wa btn--sm" data-invite="${c.id}">Convidar</button>
        </div>
      </div>
    </div>`).join("");

  host.querySelectorAll("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => openClientProfile(b.dataset.profile)));
  host.querySelectorAll("[data-invite]").forEach((b) =>
    b.addEventListener("click", () => openInviteModal(b.dataset.invite)));
}

function bindClientFilters() {
  const f = state.clientFilters;
  document.getElementById("client-search")?.addEventListener("input", renderClients);
  document.getElementById("filter-lastvisit")?.addEventListener("change", (e) => { f.lastVisit = e.target.value; renderClients(); });
  document.getElementById("filter-service")?.addEventListener("change", (e) => { f.service = e.target.value; renderClients(); });
  document.getElementById("filter-future")?.addEventListener("change", (e) => { f.future = e.target.value; renderClients(); });
  document.getElementById("filter-sort")?.addEventListener("change", (e) => { f.sort = e.target.value; renderClients(); });
  document.getElementById("return-period")?.addEventListener("change", (e) => { state.returnDays = Number(e.target.value); renderReturnList(); });
  document.getElementById("clients-new")?.addEventListener("click", () => openClientModal());
}

// =============================================================================
// CLIENTES — perfil completo + anotações
// =============================================================================
function openClientProfile(clientId) {
  const c = state.clients.find((x) => x.id === clientId);
  if (!c) return;
  const m = clientMetrics(c);
  const notes = state.clientNotes.filter((n) => n.client_id === clientId);

  const topSvcHtml = m.topServices.length
    ? m.topServices.slice(0, 3).map((s) => `<span class="badge badge--completed" style="margin:2px">${esc(s.name)} (${s.count})</span>`).join(" ")
    : '<span class="muted small">—</span>';

  const histHtml = m.appts.length
    ? m.appts.map((a) => {
        const svc = serviceById(a.service_id);
        return `<div class="spread" style="padding:7px 0;border-bottom:1px solid var(--border)">
          <span><strong>${new Date(a.starts_at).toLocaleDateString("pt-BR")}</strong> ${formatTimeBR(a.starts_at)} · ${esc(a.service_name)}
          <span class="badge badge--${a.status}">${STATUS_LABEL[a.status]}</span></span>
          <strong>${svc ? formatBRL(svc.price_cents) : "—"}</strong></div>`;
      }).join("")
    : '<div class="empty">Sem agendamentos.</div>';

  openModal(`
    <h2 class="mb-0">${esc(c.name)}</h2>
    <p class="muted small">${esc(c.phone)}</p>
    <div class="dash-actions" style="grid-template-columns:1fr 1fr;margin-bottom:12px">
      <button class="btn btn--wa btn--sm" id="cp-wa">WhatsApp</button>
      <button class="btn btn--wa btn--sm" id="cp-invite">Convidar para voltar</button>
    </div>

    <div class="summary" style="margin-bottom:14px">
      <div class="summary__row"><span>Última visita concluída</span><strong>${m.lastVisit ? formatDateTimeFull(m.lastVisit) : "—"}</strong></div>
      <div class="summary__row"><span>Próximo agendamento</span><strong>${m.next ? formatDateTimeFull(m.next.starts_at) : "—"}</strong></div>
      <div class="summary__row"><span>Atendimentos concluídos</span><strong>${m.completedCount}</strong></div>
      <div class="summary__row"><span>Faltas (no-show)</span><strong>${m.noShowCount}</strong></div>
      <div class="summary__row"><span>Taxa de falta</span><strong class="${m.noShowRate >= 30 ? "text-danger" : ""}">${m.finishedCount ? m.noShowRate + "%" : "—"}${m.finishedCount ? ` <span class="muted small">(${m.noShowCount} de ${m.finishedCount})</span>` : ""}</strong></div>
      <div class="summary__row"><span>Total gasto</span><strong>${m.completedCount ? (m.priceReliable ? formatBRL(m.totalCents) : "~" + formatBRL(m.totalCents)) : "—"}</strong></div>
    </div>
    ${m.noShowRate >= 30 && m.finishedCount >= 2 ? `<div class="notice" style="margin-bottom:14px">⚠️ Este cliente falta com frequência (${m.noShowRate}%). Considere pedir confirmação antecipada.</div>` : ""}
    <div class="field"><label class="small">Serviços mais utilizados</label><div>${topSvcHtml}</div></div>

    <h3 style="font-size:1rem;margin:14px 0 6px">Anotações particulares</h3>
    <p class="help">Visível só para você. Não aparece na página pública.</p>
    <form id="note-form" style="margin-bottom:10px">
      <textarea class="textarea" id="note-text" placeholder="Ex: prefere corte na tesoura, alérgico a X..."></textarea>
      <button class="btn btn--primary btn--sm" type="submit" style="margin-top:6px">Adicionar anotação</button>
    </form>
    <div id="notes-list">${renderNotesHtml(notes)}</div>

    <h3 style="font-size:1rem;margin:16px 0 6px">Histórico</h3>
    <div>${histHtml}</div>
  `);

  document.getElementById("cp-wa").addEventListener("click", () =>
    window.open(waLink(c.phone, `Olá ${c.name}!`), "_blank"));
  document.getElementById("cp-invite").addEventListener("click", () => openInviteModal(clientId));

  document.getElementById("note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = document.getElementById("note-text").value.trim();
    if (!text) return;
    const { error } = await supabase.from("client_notes").insert({
      profile_id: state.user.id, client_id: clientId, text,
    });
    if (error) { toast("Erro ao salvar anotação.", "error"); return; }
    await loadClientNotes();
    document.getElementById("note-text").value = "";
    document.getElementById("notes-list").innerHTML = renderNotesHtml(state.clientNotes.filter((n) => n.client_id === clientId));
    bindNoteActions(clientId);
    toast("Anotação salva.", "success");
  });
  bindNoteActions(clientId);
}

function renderNotesHtml(notes) {
  if (!notes.length) return `<div class="dash-card__sub">Nenhuma anotação ainda.</div>`;
  return notes.map((n) => `
    <div class="appt" data-note="${n.id}">
      <div class="appt__body">
        <div class="appt__meta" style="color:var(--text)">${esc(n.text)}</div>
        <div class="dash-card__sub">Criada em ${formatDateTimeFull(n.created_at)}${n.updated_at && n.updated_at !== n.created_at ? " · editada em " + formatDateTimeFull(n.updated_at) : ""}</div>
        <div class="appt__actions">
          <button class="btn btn--ghost btn--sm" data-note-edit="${n.id}">Editar</button>
          <button class="btn btn--danger btn--sm" data-note-del="${n.id}">Excluir</button>
        </div>
      </div>
    </div>`).join("");
}

function bindNoteActions(clientId) {
  const refresh = () => {
    document.getElementById("notes-list").innerHTML = renderNotesHtml(state.clientNotes.filter((n) => n.client_id === clientId));
    bindNoteActions(clientId);
  };
  document.querySelectorAll("[data-note-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Excluir esta anotação?")) return;
      const { error } = await supabase.from("client_notes").delete().eq("id", b.dataset.noteDel);
      if (error) { toast("Erro ao excluir.", "error"); return; }
      await loadClientNotes(); refresh(); toast("Anotação excluída.", "success");
    }));
  document.querySelectorAll("[data-note-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const n = state.clientNotes.find((x) => x.id === b.dataset.noteEdit);
      if (!n) return;
      const novo = prompt("Editar anotação:", n.text);
      if (novo == null) return;
      const text = novo.trim();
      if (!text) return;
      supabase.from("client_notes").update({ text, updated_at: new Date().toISOString() }).eq("id", n.id)
        .then(async ({ error }) => {
          if (error) { toast("Erro ao editar.", "error"); return; }
          await loadClientNotes(); refresh(); toast("Anotação atualizada.", "success");
        });
    }));
}

// =============================================================================
// CLIENTES — convite para voltar (WhatsApp com mensagem editável)
// =============================================================================
function openInviteModal(clientId) {
  const c = state.clients.find((x) => x.id === clientId);
  if (!c) return;
  const nomePro = state.profile?.full_name || "nós";
  const link = publicUrl();
  const defaultMsg =
    `Olá, ${c.name}! Tudo bem? Faz um tempinho desde seu último atendimento. ` +
    `Se quiser agendar novamente, confira os horários disponíveis aqui: ${link}. ` +
    `Será um prazer receber você!`;

  openModal(`
    <h2 class="mb-0">Convidar ${esc(c.name)} para voltar</h2>
    <p class="help">Edite a mensagem se quiser. Ao enviar, o WhatsApp abre com o texto pronto — o envio depende de você.</p>
    <div class="field"><label>Mensagem</label><textarea class="textarea" id="invite-text" style="min-height:140px">${esc(defaultMsg)}</textarea></div>
    <button class="btn btn--wa btn--block btn--lg" id="invite-send" type="button">Abrir WhatsApp</button>
  `);
  document.getElementById("invite-send").addEventListener("click", () => {
    const msg = document.getElementById("invite-text").value;
    window.open(waLink(c.phone, msg), "_blank");
    closeModal();
    toast("WhatsApp aberto com o convite.", "success");
  });
}

// =============================================================================
// NOVO / REAGENDAR agendamento (manual, pelo painel)
// =============================================================================
function openApptModal(existing = null) {
  if (state.services.length === 0) {
    toast("Cadastre um serviço antes de agendar.", "error");
    return;
  }
  const svcOptions = state.services.filter((s) => s.active || existing?.service_id === s.id)
    .map((s) => `<option value="${s.id}" ${existing?.service_id === s.id ? "selected" : ""}>${esc(s.name)} (${s.duration_minutes}min)</option>`).join("");
  const dateVal = existing ? isoDateLocal(existing.starts_at) : isoDateLocal(new Date());
  const timeVal = existing ? formatTimeBR(existing.starts_at) : "09:00";

  openModal(`
    <h2 class="mb-0">${existing ? "Reagendar" : "Novo agendamento"}</h2>
    <form id="ap-form" style="margin-top:14px">
      <div class="field"><label>Cliente</label><input class="input" id="ap-name" value="${esc(existing?.client_name || "")}" required></div>
      <div class="field"><label>WhatsApp</label><input class="input" id="ap-phone" value="${esc(existing?.client_phone || "")}" placeholder="5511999999999" required></div>
      <div class="field"><label>Serviço</label><select class="select" id="ap-svc">${svcOptions}</select></div>
      <div class="row">
        <div class="field"><label>Data</label><input class="input" id="ap-date" type="date" value="${dateVal}" required></div>
        <div class="field"><label>Hora</label><input class="input" id="ap-time" type="time" value="${timeVal}" required></div>
      </div>
      <div class="field"><label>Status</label>
        <select class="select" id="ap-status">
          <option value="confirmed" ${existing?.status === "confirmed" ? "selected" : ""}>Confirmado</option>
          <option value="requested" ${!existing || existing?.status === "requested" ? "selected" : ""}>Solicitado</option>
        </select>
      </div>
      <div class="field"><label>Observações</label><textarea class="textarea" id="ap-notes">${esc(existing?.notes || "")}</textarea></div>
      <button class="btn btn--primary btn--block" id="ap-submit" type="submit">${existing ? "Salvar" : "Agendar"}</button>
    </form>
  `);

  document.getElementById("ap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("ap-submit");
    const restore = setLoading(btn, true, "Salvando...");
    try {
      const svc = state.services.find((s) => s.id === document.getElementById("ap-svc").value);
      const date = document.getElementById("ap-date").value;
      const time = document.getElementById("ap-time").value;
      const start = new Date(`${date}T${time}`);
      const end = new Date(start.getTime() + svc.duration_minutes * 60000);
      const status = document.getElementById("ap-status").value;

      const payload = {
        profile_id: state.user.id,
        service_id: svc.id,
        client_name: document.getElementById("ap-name").value.trim(),
        client_phone: document.getElementById("ap-phone").value.replace(/\D/g, ""),
        service_name: svc.name,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        status,
        source: "manual",
        notes: document.getElementById("ap-notes").value.trim(),
      };

      const q = existing
        ? supabase.from("appointments").update(payload).eq("id", existing.id)
        : supabase.from("appointments").insert(payload);
      const { error } = await q;
      if (error) {
        if (/overlap|exclusion|conflict/i.test(error.message)) {
          toast("Conflito: já há um agendamento confirmado neste horário.", "error");
        } else {
          toast("Erro: " + error.message, "error");
        }
        return;
      }
      toast("Agendamento salvo.", "success");
      closeModal();
      await Promise.all([loadAppointments(), loadToday(), loadUpcomingConfirmed(), loadClients(), loadAllAppointments()]);
      renderAgenda(); renderStats(); renderClients(); renderDashboard();
    } finally {
      restore();
    }
  });
}

// =============================================================================
// RELATÓRIO DE FATURAMENTO (Dia / Mês / Ano)
// =============================================================================
function bindReport() {
  document.querySelectorAll("[data-period]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-period]").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      state.reportPeriod = b.dataset.period;
      state.reportCursor = new Date(); // volta ao período atual ao trocar a granularidade
      toggleReportMode();
      if (state.reportPeriod === "custom") initCustomDefaults();
      loadAndRenderReport();
    });
  });
  document.getElementById("rep-prev")?.addEventListener("click", () => shiftReport(-1));
  document.getElementById("rep-next")?.addEventListener("click", () => shiftReport(1));

  // Seletor de calendário: pula direto para a data escolhida (dia/mês/ano).
  document.getElementById("rep-jump")?.addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.reportCursor = new Date(e.target.value + "T12:00:00");
    loadAndRenderReport();
  });

  // Período personalizado: intervalo entre duas datas.
  document.getElementById("rep-from")?.addEventListener("change", (e) => {
    state.reportCustom.from = e.target.value || null;
    loadAndRenderReport();
  });
  document.getElementById("rep-to")?.addEventListener("change", (e) => {
    state.reportCustom.to = e.target.value || null;
    loadAndRenderReport();
  });
}

// Alterna entre a navegação dia/mês/ano e os campos de intervalo personalizado.
function toggleReportMode() {
  const custom = state.reportPeriod === "custom";
  document.getElementById("rep-nav")?.classList.toggle("hidden", custom);
  document.getElementById("rep-custom")?.classList.toggle("hidden", !custom);
}

// Preenche o intervalo padrão do "Período" (mês corrente) se ainda vazio.
function initCustomDefaults() {
  const now = new Date();
  if (!state.reportCustom.from) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    state.reportCustom.from = isoDateLocal(first);
  }
  if (!state.reportCustom.to) state.reportCustom.to = isoDateLocal(now);
  const f = document.getElementById("rep-from");
  const t = document.getElementById("rep-to");
  if (f) f.value = state.reportCustom.from;
  if (t) t.value = state.reportCustom.to;
}

function shiftReport(dir) {
  const c = new Date(state.reportCursor);
  if (state.reportPeriod === "day") c.setDate(c.getDate() + dir);
  else if (state.reportPeriod === "month") c.setMonth(c.getMonth() + dir);
  else c.setFullYear(c.getFullYear() + dir);
  state.reportCursor = c;
  loadAndRenderReport();
}

function reportBounds() {
  if (state.reportPeriod === "custom") {
    const f = state.reportCustom.from ? new Date(state.reportCustom.from + "T00:00:00") : new Date(0);
    // 'to' é exclusivo: soma 1 dia à data final para incluí-la inteira
    let t;
    if (state.reportCustom.to) { t = new Date(state.reportCustom.to + "T00:00:00"); t.setDate(t.getDate() + 1); }
    else { t = new Date(); t.setFullYear(t.getFullYear() + 1); }
    return [f, t];
  }
  const c = new Date(state.reportCursor);
  c.setHours(0, 0, 0, 0);
  if (state.reportPeriod === "day") {
    const to = new Date(c); to.setDate(to.getDate() + 1);
    return [c, to];
  }
  if (state.reportPeriod === "month") {
    const from = new Date(c.getFullYear(), c.getMonth(), 1);
    const to = new Date(c.getFullYear(), c.getMonth() + 1, 1);
    return [from, to];
  }
  const from = new Date(c.getFullYear(), 0, 1);
  const to = new Date(c.getFullYear() + 1, 0, 1);
  return [from, to];
}

function reportLabel() {
  if (state.reportPeriod === "custom") {
    const f = state.reportCustom.from ? new Date(state.reportCustom.from + "T12:00:00").toLocaleDateString("pt-BR") : "início";
    const t = state.reportCustom.to ? new Date(state.reportCustom.to + "T12:00:00").toLocaleDateString("pt-BR") : "hoje";
    return `${f} – ${t}`;
  }
  const c = new Date(state.reportCursor);
  if (state.reportPeriod === "day")
    return c.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  if (state.reportPeriod === "month")
    return c.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return String(c.getFullYear());
}

async function loadAndRenderReport() {
  const label = document.getElementById("rep-label");
  if (label) label.textContent = reportLabel();
  // sincroniza o seletor de calendário com o cursor atual
  const jump = document.getElementById("rep-jump");
  if (jump && state.reportPeriod !== "custom") jump.value = isoDateLocal(state.reportCursor);
  const detail = document.getElementById("rep-detail");
  if (detail) detail.innerHTML = `<div class="loading-block">Carregando...</div>`;

  const [from, to] = reportBounds();
  const { data } = await supabase.from("appointments")
    .select("*").eq("profile_id", state.user.id)
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString())
    .order("starts_at");
  state.reportData = data || [];
  renderReport();
}

function renderReport() {
  const items = state.reportData;
  const prevItems = items.filter((a) => a.status === "confirmed" || a.status === "requested");
  const recItems = items.filter((a) => a.status === "completed");
  const cancItems = items.filter((a) => a.status === "cancelled");
  const sum = (list) => list.reduce((s, a) => s + apptPrice(a), 0);

  const previsto = sum(prevItems);
  const recebido = sum(recItems);
  const total = previsto + recebido;
  const ticket = recItems.length ? Math.round(recebido / recItems.length) : 0;

  // Cards resumo
  const cards = document.getElementById("rep-cards");
  if (cards) {
    cards.innerHTML = `
      <div class="dash-card">
        <div class="dash-card__head"><span class="dash-card__icon">💰</span> Recebido</div>
        <div class="dash-card__num">${formatBRL(recebido)}</div>
        <div class="dash-card__sub">${recItems.length} atendimento(s) concluído(s)</div>
      </div>
      <div class="dash-card">
        <div class="dash-card__head"><span class="dash-card__icon">📈</span> Previsto</div>
        <div class="dash-card__num">${formatBRL(previsto)}</div>
        <div class="dash-card__sub">${prevItems.length} agendamento(s) em aberto</div>
      </div>
      <div class="dash-card">
        <div class="dash-card__head"><span class="dash-card__icon">🧾</span> Ticket médio</div>
        <div class="dash-card__num">${formatBRL(ticket)}</div>
        <div class="dash-card__sub">por atendimento concluído</div>
      </div>`;
  }

  // Horários mais procurados (sempre renderiza, mesmo sem dados)
  renderPeaks(items);

  // Detalhamento
  const host = document.getElementById("rep-detail");
  if (!host) return;
  if (items.length === 0) {
    host.innerHTML = `<div class="empty">Nenhum agendamento neste período.</div>`;
    return;
  }

  const linha = (a) => `
    <div class="spread" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <span>
        <strong>${new Date(a.starts_at).toLocaleDateString("pt-BR")} ${formatTimeBR(a.starts_at)}</strong>
        · ${esc(a.client_name)}
        <span class="dash-card__sub">— ${esc(a.service_name)}</span>
        <span class="badge badge--${a.status}" style="margin-left:4px">${STATUS_LABEL[a.status]}</span>
      </span>
      <strong>${formatBRL(apptPrice(a))}</strong>
    </div>`;

  const bloco = (titulo, desc, list) => list.length ? `
    <div class="card" style="box-shadow:none">
      <div class="spread">
        <h3 class="mb-0" style="font-size:1rem">${titulo}</h3>
        <strong>${formatBRL(sum(list))}</strong>
      </div>
      <p class="help" style="margin-top:2px">${desc}</p>
      ${list.map(linha).join("")}
    </div>` : "";

  host.innerHTML = `
    <div class="spread" style="margin-bottom:10px">
      <span class="muted">Total em aberto + recebido</span>
      <strong style="font-size:1.1rem">${formatBRL(total)}</strong>
    </div>
    ${bloco("Recebido", "Atendimentos <strong>concluídos</strong>.", recItems)}
    ${bloco("Previsto", "Agendamentos <strong>solicitados</strong> e <strong>confirmados</strong>.", prevItems)}
    ${cancItems.length ? `<p class="help">${cancItems.length} cancelado(s) no período — não somados.</p>` : ""}`;
}

// Horários mais procurados: dia da semana e faixa de horário com mais demanda.
// Considera agendamentos não cancelados (solicitados, confirmados, concluídos).
// Reusa a constante global DOW_FULL (nomes dos dias da semana).
function renderPeaks(items) {
  const host = document.getElementById("rep-peaks");
  if (!host) return;

  const valid = (items || []).filter((a) => a.status !== "cancelled");
  if (valid.length === 0) {
    host.innerHTML = `<div class="empty">Ainda não há agendamentos suficientes neste período para mostrar seus melhores horários.</div>`;
    return;
  }

  // Contagem por dia da semana (0-6) e por hora cheia (0-23)
  const byDow = new Array(7).fill(0);
  const byHour = {}; // hora -> contagem
  for (const a of valid) {
    const d = new Date(a.starts_at);
    byDow[d.getDay()]++;
    const h = d.getHours();
    byHour[h] = (byHour[h] || 0) + 1;
  }

  // Dia mais forte
  const maxDow = Math.max(...byDow);
  const bestDays = DOW_FULL.map((name, i) => ({ name, n: byDow[i] }))
    .filter((x) => x.n === maxDow && x.n > 0).map((x) => x.name);

  // Top 3 faixas de horário
  const hoursSorted = Object.keys(byHour).map(Number)
    .map((h) => ({ h, n: byHour[h] }))
    .sort((a, b) => b.n - a.n || a.h - b.h);
  const maxHourCount = hoursSorted.length ? hoursSorted[0].n : 0;
  const top3 = hoursSorted.slice(0, 3);

  const fmtHour = (h) => `${String(h).padStart(2, "0")}h–${String((h + 1) % 24).padStart(2, "0")}h`;

  // Barras por dia da semana
  const dowBars = DOW_FULL.map((name, i) => {
    const n = byDow[i];
    const pct = maxDow ? Math.round((n / maxDow) * 100) : 0;
    const strong = n === maxDow && n > 0;
    return `
      <div class="peak-row">
        <span class="peak-row__label">${name.slice(0, 3)}</span>
        <span class="peak-bar"><span class="peak-bar__fill ${strong ? "is-top" : ""}" style="width:${pct}%"></span></span>
        <span class="peak-row__val">${n}</span>
      </div>`;
  }).join("");

  // Barras por faixa de horário (top 3)
  const hourBars = top3.map(({ h, n }) => {
    const pct = maxHourCount ? Math.round((n / maxHourCount) * 100) : 0;
    return `
      <div class="peak-row">
        <span class="peak-row__label">${fmtHour(h)}</span>
        <span class="peak-bar"><span class="peak-bar__fill is-top" style="width:${pct}%"></span></span>
        <span class="peak-row__val">${n}</span>
      </div>`;
  }).join("");

  const diaTxt = bestDays.length
    ? `<strong>${bestDays.join(" e ")}</strong>`
    : "—";
  const horaTxt = top3.length
    ? `<strong>${fmtHour(top3[0].h)}</strong>`
    : "—";

  host.innerHTML = `
    <div class="notice notice--info" style="margin-bottom:14px">
      💡 Seu dia mais procurado é ${diaTxt} e o horário de pico é ${horaTxt}.
    </div>
    <div class="peaks-grid">
      <div>
        <h3 style="font-size:.95rem;margin:0 0 8px">Por dia da semana</h3>
        ${dowBars}
      </div>
      <div>
        <h3 style="font-size:.95rem;margin:0 0 8px">Faixas de horário em alta</h3>
        ${hourBars}
      </div>
    </div>`;
}

// =============================================================================
// PERFIL
// =============================================================================
function renderProfile() {
  const p = state.profile;
  if (!p) return;
  document.getElementById("p-name").value = p.full_name || "";
  document.getElementById("p-slug").value = p.slug || "";
  document.getElementById("p-phone").value = p.phone || "";
  document.getElementById("p-address").value = p.address || "";
  document.getElementById("p-avatar").value = p.avatar_url || "";
  document.getElementById("p-cover").value = p.cover_url || "";
  document.getElementById("p-desc").value = p.description || "";
  document.getElementById("p-instagram").value = p.instagram || "";
  document.getElementById("p-gallery").value = Array.isArray(p.gallery) ? p.gallery.join("\n") : "";
  document.getElementById("p-rem1").value = p.reminder1_hours || 24;
  document.getElementById("p-rem2").value = p.reminder2_hours || 3;
  const confirmAuto = (p.confirm_mode === "auto");
  document.getElementById("p-confirm-mode").checked = confirmAuto;
  updateConfirmModeText(confirmAuto);
  document.getElementById("p-buffer").value = p.buffer_minutes || 0;
  document.getElementById("p-work-holidays").checked = Boolean(p.work_holidays);

  // Sinal / entrada
  const reqDep = Boolean(p.require_deposit);
  document.getElementById("p-require-deposit").checked = reqDep;
  document.getElementById("p-deposit").value = p.deposit_cents ? (p.deposit_cents / 100).toFixed(2) : "";
  document.getElementById("p-pix-key").value = p.pix_key || "";
  document.getElementById("p-deposit-policy").value = p.deposit_policy || "";
  toggleDepositFields(reqDep);

  const link = document.getElementById("p-link");
  link.href = publicUrl(); link.textContent = publicUrl();

  // atualiza o bloco de usuário na sidebar
  const sbName = document.getElementById("sidebar-user-name");
  const sbAv = document.getElementById("sidebar-avatar");
  if (sbName) sbName.textContent = p.full_name || "Profissional";
  if (sbAv) {
    if (p.avatar_url) sbAv.innerHTML = `<img src="${esc(p.avatar_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else sbAv.textContent = (p.full_name || "?").trim().charAt(0).toUpperCase();
  }
}

// Mostra/esconde os campos de sinal conforme o toggle "Exigir sinal".
function toggleDepositFields(on) {
  document.getElementById("deposit-fields")?.classList.toggle("hidden", !on);
}

function bindProfileForm() {
  // Atualiza o texto do toggle de confirmação em tempo real
  document.getElementById("p-confirm-mode")?.addEventListener("change", (e) => {
    updateConfirmModeText(e.target.checked);
  });
  // Mostra/esconde os campos de sinal ao marcar "Exigir sinal"
  document.getElementById("p-require-deposit")?.addEventListener("change", (e) => {
    toggleDepositFields(e.target.checked);
  });

  document.getElementById("profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const restore = setLoading(btn, true, "Salvando...");
    const slug = document.getElementById("p-slug").value.trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const payload = {
      full_name: document.getElementById("p-name").value.trim(),
      slug,
      phone: document.getElementById("p-phone").value.replace(/\D/g, ""),
      address: document.getElementById("p-address").value.trim(),
      avatar_url: document.getElementById("p-avatar").value.trim(),
      cover_url: document.getElementById("p-cover").value.trim(),
      description: document.getElementById("p-desc").value.trim(),
      instagram: document.getElementById("p-instagram").value.trim().replace(/^@/, ""),
      gallery: document.getElementById("p-gallery").value.split("\n").map((s) => s.trim()).filter(Boolean),
      reminder1_hours: parseInt(document.getElementById("p-rem1").value, 10) || 24,
      reminder2_hours: parseInt(document.getElementById("p-rem2").value, 10) || 3,
      confirm_mode: document.getElementById("p-confirm-mode").checked ? "auto" : "manual",
      buffer_minutes: parseInt(document.getElementById("p-buffer").value, 10) || 0,
      work_holidays: document.getElementById("p-work-holidays").checked,
      require_deposit: document.getElementById("p-require-deposit").checked,
      deposit_cents: Math.round((parseFloat(document.getElementById("p-deposit").value.replace(",", ".")) || 0) * 100),
      pix_key: document.getElementById("p-pix-key").value.trim(),
      deposit_policy: document.getElementById("p-deposit-policy").value.trim(),
    };
    const { error } = await supabase.from("profiles").update(payload).eq("id", state.user.id);
    restore();
    if (error) {
      toast(/duplicate|unique/i.test(error.message) ? "Esse link já está em uso. Escolha outro." : "Erro: " + error.message, "error");
      return;
    }
    toast("Perfil salvo.", "success");
    state.profile = { ...state.profile, ...payload };
    renderProfile();
    renderModeBanner();
  });
}

// =============================================================================
// Helpers de modal
// =============================================================================
function openModal(html) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">
    <div style="text-align:right"><button class="btn btn--ghost btn--sm" id="modal-close">Fechar</button></div>
    ${html}
  </div></div>`;
  const backdrop = root.querySelector(".modal-backdrop");
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  document.getElementById("modal-close").addEventListener("click", closeModal);
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

// --- util ---
function isToday(ts) { return isoDateLocal(ts) === isoDateLocal(new Date()); }
