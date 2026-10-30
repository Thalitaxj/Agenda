// =============================================================================
// Página de resposta do cliente (link seguro) — AgendaAí
// O cliente confirma presença, cancela ou pede reagendamento, sem login.
// Acesso via token: responder.html?t=TOKEN
//
// Modo local: usa funções do localBackend (validação por token).
// Modo Supabase: chamaria uma Edge Function equivalente (service role).
// =============================================================================
import { IS_CONFIGURED, LOCAL_MODE } from "./supabaseClient.js";
import { toast, setLoading, esc, formatBRL, formatDateTimeFull } from "./lib/ui.js";

const el = (id) => document.getElementById(id);
let token = null;
let data = null;

(async function boot() {
  if (!IS_CONFIGURED) {
    el("loading").textContent = "Indisponível: backend não configurado.";
    return;
  }
  token = new URLSearchParams(window.location.search).get("t");
  if (!token) { showNotFound(); return; }
  await load();
})();

function showNotFound() {
  el("loading").classList.add("hidden");
  el("not-found").classList.remove("hidden");
}

// Mapa: nome da função local -> action da Edge Function remota
const ACTION_MAP = {
  getAppointmentByToken: "get",
  confirmAttendanceByToken: "confirm",
  cancelByToken: "cancel",
  requestRescheduleByToken: "reschedule",
  submitReviewByToken: "review",
};

async function api(fn, token, extra = {}) {
  if (LOCAL_MODE) {
    const mod = await import("./localBackend.js");
    // submitReviewByToken recebe (token, rating, comment); as demais só (token)
    if (fn === "submitReviewByToken") return mod[fn](token, extra.rating, extra.comment);
    return mod[fn](token);
  }
  // Modo Supabase: chama a Edge Function 'appointment-response'.
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/appointment-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ token, action: ACTION_MAP[fn], ...extra }),
  });
  return res.json();
}

async function load() {
  const res = await api("getAppointmentByToken", token);
  if (!res.ok) { showNotFound(); return; }
  data = res;
  renderSummary();
  reflectState();
  el("loading").classList.add("hidden");
  el("content").classList.remove("hidden");

  el("btn-confirm").addEventListener("click", onConfirm);
  el("btn-cancel").addEventListener("click", onCancel);
  el("btn-reschedule").addEventListener("click", onReschedule);
}

function renderSummary() {
  const a = data.appointment;
  const p = data.profile;
  el("summary").innerHTML = `
    <div class="summary__row"><span>Profissional</span><strong>${esc(p.full_name)}</strong></div>
    <div class="summary__row"><span>Serviço</span><strong>${esc(a.service_name)}</strong></div>
    <div class="summary__row"><span>Data e horário</span><strong>${capitalize(formatDateTimeFull(a.starts_at))}</strong></div>
    ${p.address ? `<div class="summary__row"><span>Endereço</span><strong>${esc(p.address)}</strong></div>` : ""}
    <div class="summary__row"><span>Cliente</span><strong>${esc(a.client_name)}</strong></div>`;
}

// Mostra o estado atual (já cancelado/concluído/confirmado) e esconde ações quando não cabem.
function reflectState() {
  const a = data.appointment;
  const stateBox = el("att-state");
  const actions = el("actions");

  if (a.status === "cancelled") {
    stateBox.className = "notice";
    stateBox.innerHTML = "Este agendamento está <strong>cancelado</strong>.";
    stateBox.classList.remove("hidden");
    actions.classList.add("hidden");
    return;
  }
  if (a.status === "completed") {
    stateBox.className = "notice";
    stateBox.style.cssText = "background:#e3f8ec;color:#117a3e;border-color:#b7e9c9";
    stateBox.innerHTML = "✓ Este atendimento foi <strong>concluído</strong>. Obrigado pela visita!";
    stateBox.classList.remove("hidden");
    actions.classList.add("hidden");
    if (a.has_review) {
      showReviewThanks();
    } else {
      renderReviewForm();
    }
    return;
  }
  if (a.attendance === "confirmed") {
    stateBox.className = "notice";
    stateBox.style.cssText = "background:#e3f8ec;color:#117a3e;border-color:#b7e9c9";
    stateBox.innerHTML = "✓ Presença <strong>confirmada</strong>. Obrigado!";
    stateBox.classList.remove("hidden");
    // mantém opções de cancelar/reagendar, mas esconde o confirmar
    el("btn-confirm").classList.add("hidden");
  }
  if (a.reschedule_requested) {
    const n = document.createElement("div");
    n.className = "help";
    n.textContent = "Você já solicitou reagendamento. Aguarde o contato do profissional.";
    actions.appendChild(n);
  }
}

async function onConfirm() {
  const restore = setLoading(el("btn-confirm"), true, "Confirmando...");
  try {
    const r = await api("confirmAttendanceByToken", token);
    if (!r.ok) { toast(r.error || "Não foi possível confirmar.", "error"); return; }
    showResult("success", "Presença confirmada! 🎉",
      "Obrigado por confirmar. O profissional já verá sua confirmação na agenda.");
  } catch (e) {
    toast("Falha ao confirmar. Tente novamente.", "error");
  } finally { restore(); }
}

async function onCancel() {
  if (!confirm("Tem certeza que deseja cancelar este agendamento?")) return;
  const restore = setLoading(el("btn-cancel"), true, "Cancelando...");
  try {
    const r = await api("cancelByToken", token);
    if (!r.ok) { toast(r.error || "Não foi possível cancelar.", "error"); return; }
    showResult("info", "Agendamento cancelado",
      "Seu horário foi liberado. Se quiser, fale com o profissional para marcar outro dia.");
  } catch (e) {
    toast("Falha ao cancelar. Tente novamente.", "error");
  } finally { restore(); }
}

async function onReschedule() {
  const restore = setLoading(el("btn-reschedule"), true, "Abrindo...");
  try {
    const r = await api("requestRescheduleByToken", token);
    if (!r.ok) { toast(r.error || "Não foi possível solicitar.", "error"); return; }
    // Reagendamento com 1 clique: já leva o cliente à escolha de novo horário,
    // com serviço pré-selecionado e o agendamento atual referenciado (rebook),
    // para que o antigo seja cancelado ao concluir o novo.
    const bookUrl = buildRebookUrl();
    // Redireciona direto — fluxo mais fluido (sem telas intermediárias).
    window.location.href = bookUrl;
  } catch (e) {
    toast("Falha ao solicitar. Tente novamente.", "error");
    restore();
  }
}

// Monta a URL de reagendamento: agendar.html?slug=...&rebook=TOKEN&service=ID
function buildRebookUrl() {
  const a = data.appointment;
  const slug = data.profile.slug;
  const dir = window.location.pathname.replace(/\/[^/]*$/, "/");
  const u = new URL(`${window.location.origin}${dir}agendar.html`);
  u.searchParams.set("slug", slug);
  u.searchParams.set("rebook", token);
  if (a.service_id) u.searchParams.set("service", a.service_id);
  return u.toString();
}

function showResult(kind, title, msg, linkUrl) {
  el("actions").classList.add("hidden");
  el("att-state").classList.add("hidden");
  const box = el("result");
  box.classList.remove("hidden");
  box.innerHTML = `
    <div style="text-align:center;padding:10px 0">
      <div class="avatar avatar--lg" style="margin:0 auto 12px;background:${kind === "success" ? "var(--wa)" : "var(--surface-2)"};color:${kind === "success" ? "#06331b" : "var(--text)"}">
        ${kind === "success" ? "✓" : "ℹ"}
      </div>
      <h2 style="font-size:1.2rem">${esc(title)}</h2>
      <p class="muted">${esc(msg)}</p>
      ${linkUrl ? `<a class="btn btn--wa btn--block btn--lg" href="${esc(linkUrl)}">Escolher novo horário</a>` : ""}
    </div>`;
}

// --- Avaliação do cliente (só quando o atendimento está concluído) ----------
let reviewRating = 0;

function renderReviewForm() {
  const box = el("review-form");
  box.classList.remove("hidden");
  const stars = el("review-stars");
  // 5 estrelas clicáveis
  stars.innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="rating-input__star" data-n="${n}" aria-label="${n} estrela${n > 1 ? "s" : ""}">★</button>`
  ).join("");
  stars.querySelectorAll(".rating-input__star").forEach((btn) => {
    btn.addEventListener("click", () => setRating(Number(btn.dataset.n)));
    btn.addEventListener("mouseenter", () => paintStars(Number(btn.dataset.n)));
    btn.addEventListener("mouseleave", () => paintStars(reviewRating));
  });
  el("btn-review").addEventListener("click", onSubmitReview);
}

function setRating(n) { reviewRating = n; paintStars(n); }

function paintStars(n) {
  el("review-stars").querySelectorAll(".rating-input__star").forEach((b) => {
    b.classList.toggle("is-on", Number(b.dataset.n) <= n);
  });
}

function showReviewThanks() {
  const box = el("review-form");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="help" style="text-align:center;margin:0">⭐ Você já avaliou este atendimento. Obrigado pelo feedback!</p>`;
}

async function onSubmitReview() {
  if (!(reviewRating >= 1 && reviewRating <= 5)) {
    toast("Escolha uma nota de 1 a 5 estrelas.", "error");
    return;
  }
  const comment = el("review-comment").value.trim();
  const restore = setLoading(el("btn-review"), true, "Enviando...");
  try {
    const r = await api("submitReviewByToken", token, { rating: reviewRating, comment });
    if (!r.ok) {
      toast(r.error || "Não foi possível enviar sua avaliação.", "error");
      return;
    }
    el("review-form").innerHTML =
      `<div style="text-align:center;padding:6px 0">
        <h2 style="font-size:1.1rem;margin:0 0 4px">Avaliação enviada! ⭐</h2>
        <p class="muted" style="margin:0">Muito obrigado por compartilhar sua experiência.</p>
      </div>`;
  } catch (e) {
    toast("Falha ao enviar. Tente novamente.", "error");
  } finally { restore(); }
}

function capitalize(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
