// =============================================================================
// Página pública de agendamento — AgendaAí
// Fluxo: serviço → data → horário → dados → resumo → envio via WhatsApp.
//
// Sem login. A criação do pedido passa pela Edge Function (ou backend local),
// que revalida a disponibilidade no servidor. O cálculo de slots aqui é de
// apresentação e pode ser recusado na hora de enviar (prevenção de conflito).
// =============================================================================
import { supabase, IS_CONFIGURED, LOCAL_MODE } from "./supabaseClient.js";
import { CREATE_BOOKING_URL, SUPABASE_ANON_KEY } from "./config.js";
import {
  toast, setLoading, esc, formatBRL, formatTimeBR, formatDateTimeFull,
  isoDateLocal, waLink,
} from "./lib/ui.js";
import { computeFreeSlots } from "./lib/scheduling.js";
import { holidayName } from "./lib/holidays.js";

const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DAYS_AHEAD = 30; // janela do calendário

const state = {
  slug: null,
  profile: null,
  services: [],
  availability: [],
  selectedService: null,
  selectedDay: null,
  selectedSlot: null,
  client: { name: "", phone: "", notes: "" },
  // Reagendamento com 1 clique: token do agendamento anterior a cancelar
  // e id do serviço para pré-seleção.
  rebookToken: null,
  presetServiceId: null,
};

const el = (id) => document.getElementById(id);

// =============================================================================
// Boot
// =============================================================================
(async function boot() {
  if (!IS_CONFIGURED) {
    el("config-banner").classList.remove("hidden");
    el("loading").textContent = "Agendamento indisponível: backend não configurado.";
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug");
  if (!slug) { showNotFound(); return; }
  // Parâmetros de reagendamento (opcionais)
  state.rebookToken = params.get("rebook");
  state.presetServiceId = params.get("service");
  await initBooking(slug);
})();

// Carrega o profissional e monta o agendamento SEM recarregar a página.
// Usada no boot e ao escolher um profissional na tela de "não encontrado".
async function initBooking(slug) {
  state.slug = slug;
  el("loading").classList.remove("hidden");
  el("not-found").classList.add("hidden");
  el("content").classList.add("hidden");

  const { data: profile } = await supabase
    .from("profiles").select("*").eq("slug", slug).maybeSingle();
  if (!profile) { showNotFound(); return; }
  state.profile = profile;

  const [{ data: services }, { data: availability }, { data: reviews }] = await Promise.all([
    supabase.from("services").select("*").eq("profile_id", profile.id).eq("active", true).order("name"),
    supabase.from("availability").select("*").eq("profile_id", profile.id),
    supabase.from("reviews").select("*").eq("profile_id", profile.id).order("created_at", { ascending: false }),
  ]);
  state.services = services || [];
  state.availability = availability || [];
  state.reviews = reviews || [];

  // reflete o slug na URL (sem recarregar) para o link ficar compartilhável
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("slug", slug);
    history.replaceState(null, "", u.toString());
  } catch { /* ok */ }

  renderHeader();
  bindShare();
  renderServices();
  renderVitrine();
  el("loading").classList.add("hidden");
  el("content").classList.remove("hidden");

  el("booking-form").addEventListener("submit", goToReview);
  el("back-btn").addEventListener("click", backToForm);
  el("confirm-btn").addEventListener("click", submitBooking);
  bindPhoneMask(el("c-phone"));

  // Reagendamento com 1 clique: mostra banner e já pula para a escolha da data
  // com o serviço anterior pré-selecionado.
  maybeStartRebook();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Se a URL trouxe ?rebook=TOKEN, entra em "modo reagendamento": banner no topo
// e pré-seleção do serviço (quando informado por ?service=ID).
function maybeStartRebook() {
  if (!state.rebookToken) return;
  renderRebookBanner();
  const preset = state.presetServiceId
    ? state.services.find((s) => s.id === state.presetServiceId)
    : null;
  if (preset) {
    // pula o passo 1: já escolhe o serviço e vai direto para a data
    selectService(preset.id);
    toast("Escolha um novo horário para o seu atendimento.", "info");
  } else {
    toast("Escolha o serviço e o novo horário.", "info");
  }
}

function renderRebookBanner() {
  // Insere um aviso no topo do conteúdo (uma única vez).
  if (el("rebook-banner")) return;
  const banner = document.createElement("div");
  banner.id = "rebook-banner";
  banner.className = "notice notice--info";
  banner.style.cssText = "margin-bottom:14px";
  banner.innerHTML = `🔁 <strong>Reagendamento</strong> — escolha o novo horário. Seu horário anterior será liberado automaticamente quando você concluir.`;
  const content = el("content");
  content.insertBefore(banner, content.firstChild);
}

// Máscara de telefone: formata enquanto digita — (11) 99999-9999 / (11) 9999-9999
function maskPhoneProgressive(value) {
  const d = String(value || "").replace(/\D/g, "").slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function bindPhoneMask(input) {
  if (!input) return;
  input.addEventListener("input", () => {
    const digitsBefore = input.value.replace(/\D/g, "").length;
    input.value = maskPhoneProgressive(input.value);
    // mantém o cursor no fim (simples e suficiente para entrada de telefone)
    if (document.activeElement === input) {
      const pos = input.value.length;
      try { input.setSelectionRange(pos, pos); } catch { /* alguns tipos não suportam */ }
    }
    void digitsBefore;
  });
}

async function showNotFound() {
  el("loading").classList.add("hidden");
  const box = el("not-found");
  box.classList.remove("hidden");

  if (LOCAL_MODE) {
    try {
      const { listProfilesLocal } = await import("./localBackend.js");
      const profs = listProfilesLocal();
      if (profs.length > 0) {
        box.innerHTML = `
          <p><strong>Profissional não encontrado</strong> para o link informado.</p>
          <p class="muted small">Profissionais cadastrados neste navegador:</p>
          <div style="display:flex;flex-direction:column;gap:8px;max-width:360px;margin:0 auto">
            ${profs.map((p) => `
              <button type="button" class="btn btn--ghost" data-go="${esc(p.slug)}">
                ${esc(p.full_name || p.slug)} — /${esc(p.slug)}
              </button>`).join("")}
          </div>`;
        box.querySelectorAll("[data-go]").forEach((btn) => {
          btn.addEventListener("click", () => {
            // carrega o agendamento na mesma página (sem reload) —
            // evita qualquer problema de navegação por URL.
            initBooking(btn.getAttribute("data-go"));
          });
        });
      } else {
        box.innerHTML = `
          <p><strong>Nenhum profissional cadastrado neste navegador.</strong></p>
          <p class="muted small">No modo local, os dados ficam salvos só no navegador em que você criou a conta.
          Crie uma conta no painel e use o link que aparece na aba <em>Perfil</em>,
          abrindo-o no <strong>mesmo navegador</strong>.</p>
          <a class="btn btn--primary" href="./index.html">Criar conta</a>`;
      }
    } catch { /* mantém mensagem padrão */ }
  }
}

// =============================================================================
// Cabeçalho + compartilhamento
// =============================================================================
const DEFAULT_COVER = "./img/cover-default.svg";

function renderHeader() {
  const p = state.profile;
  el("pro-name").textContent = p.full_name || "Profissional";
  el("pro-desc").textContent = p.description || "";
  const addr = el("pro-address");
  if (p.address) { addr.textContent = "📍 " + p.address; } else { addr.classList.add("hidden"); }

  el("pro-cover").style.backgroundImage = `url("${esc(p.cover_url || DEFAULT_COVER)}")`;

  const av = el("pro-avatar");
  if (p.avatar_url) {
    av.innerHTML = `<img src="${esc(p.avatar_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
  } else {
    av.textContent = (p.full_name || "?").trim().charAt(0).toUpperCase();
  }
  document.title = `Agendar com ${p.full_name || "profissional"} — AgendaAí`;
}

// Estrelas (★ cheias / ☆ vazias) para uma nota 1-5.
function stars(n) {
  const r = Math.round(Number(n) || 0);
  return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
}

// Vitrine: Instagram, média de avaliações, galeria e lista de avaliações.
function renderVitrine() {
  const p = state.profile;

  // Botão do Instagram
  const ig = el("pro-instagram");
  if (ig && p.instagram) {
    ig.href = `https://instagram.com/${encodeURIComponent(p.instagram)}`;
    ig.textContent = `@${p.instagram}`;
    ig.classList.remove("hidden");
  }

  const reviews = state.reviews || [];

  // Média de avaliações no topo
  const ratingBox = el("pro-rating");
  if (ratingBox && reviews.length) {
    const avg = reviews.reduce((s, r) => s + Number(r.rating), 0) / reviews.length;
    ratingBox.innerHTML = `<span class="pro-rating__stars">${stars(avg)}</span> <strong>${avg.toFixed(1)}</strong> <span class="muted small">(${reviews.length} avaliação${reviews.length > 1 ? "ões" : ""})</span>`;
    ratingBox.classList.remove("hidden");
  }

  // Galeria de trabalhos
  const gal = Array.isArray(p.gallery) ? p.gallery : [];
  if (gal.length) {
    el("vitrine-gallery").innerHTML = gal.map((url) =>
      `<a class="gallery__item" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Trabalho" loading="lazy"></a>`
    ).join("");
    el("vitrine-gallery-card").classList.remove("hidden");
  }

  // Lista de avaliações
  if (reviews.length) {
    el("vitrine-reviews").innerHTML = reviews.slice(0, 20).map((r) => `
      <div class="review">
        <div class="spread">
          <strong>${esc(r.client_name || "Cliente")}</strong>
          <span class="review__stars">${stars(r.rating)}</span>
        </div>
        ${r.comment ? `<p class="review__text">${esc(r.comment)}</p>` : ""}
        <div class="muted small">${new Date(r.created_at).toLocaleDateString("pt-BR")}</div>
      </div>`).join("");
    el("vitrine-reviews-card").classList.remove("hidden");
  }
}

function publicLink() {
  // O link desta própria página já é o link público do profissional.
  return window.location.href.split("#")[0];
}

function bindShare() {
  const link = publicLink();
  const nome = state.profile.full_name || "profissional";

  el("share-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copiado! É só colar e compartilhar.", "success");
    } catch {
      // fallback para navegadores sem clipboard API
      const ta = document.createElement("textarea");
      ta.value = link; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Link copiado!", "success"); }
      catch { toast("Copie o link da barra de endereço.", "info"); }
      ta.remove();
    }
  });

  el("share-wa")?.addEventListener("click", () => {
    const msg = `Agende comigo (${nome}) pelo link: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
  });

  // O Instagram não aceita link direto pré-preenchido; usamos Web Share quando
  // disponível (abre o app no celular) e, caso contrário, copiamos o link.
  el("share-ig")?.addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ title: `Agende com ${nome}`, url: link }); return; } catch { /* cancelado */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copiado! Cole no seu story ou bio do Instagram.", "success");
    } catch {
      toast("Copie o link da barra de endereço e cole no Instagram.", "info");
    }
    window.open("https://www.instagram.com/", "_blank", "noopener");
  });
}

// =============================================================================
// Passo 1 — serviços (nome, descrição, preço, duração)
// =============================================================================
function renderServices() {
  const host = el("services");
  if (state.services.length === 0) {
    host.innerHTML = `<div class="empty">Este profissional ainda não cadastrou serviços.</div>`;
    return;
  }
  host.innerHTML = state.services.map((s) => `
    <button type="button" class="service-opt ${state.selectedService?.id === s.id ? "is-selected" : ""}"
            data-svc="${s.id}" aria-pressed="${state.selectedService?.id === s.id}">
      <div class="service-opt__thumb"><img src="${esc(s.image_url || "./img/service-placeholder.svg")}" alt="" loading="lazy"></div>
      <div class="service-opt__info">
        <div class="service-opt__name">${esc(s.name)}</div>
        ${s.description ? `<div class="service-opt__desc">${esc(s.description)}</div>` : ""}
        <div class="appt__meta">⏱ ${s.duration_minutes} min</div>
      </div>
      <div class="service-opt__price">${formatBRL(s.price_cents)}</div>
    </button>`).join("");
  host.querySelectorAll("[data-svc]").forEach((n) =>
    n.addEventListener("click", () => selectService(n.dataset.svc)));
}

function selectService(id) {
  state.selectedService = state.services.find((s) => s.id === id);
  if (!state.selectedService) return;
  state.selectedDay = null;
  state.selectedSlot = null;
  renderServices();
  renderDays();
  show("step-date"); hide("step-time"); hide("step-form"); hide("step-review");
  setStep(2);
  el("step-date").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// =============================================================================
// Passo 2 — calendário (dias com disponibilidade destacados)
// =============================================================================
function renderDays() {
  const host = el("days");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const openWeekdays = new Set(state.availability.map((a) => Number(a.weekday)));

  // Sem horários de atendimento cadastrados: nenhum dia é agendável.
  if (openWeekdays.size === 0) {
    host.innerHTML = `<div class="empty">Este profissional ainda não definiu os horários de atendimento. Tente novamente mais tarde ou entre em contato pelo WhatsApp.</div>`;
    return;
  }

  let html = "";
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    // feriado só bloqueia se o profissional NÃO atende em feriados
    const feriado = state.profile?.work_holidays ? null : holidayName(d);
    const open = openWeekdays.has(d.getDay()) && !feriado;
    const selected = state.selectedDay && isoDateLocal(state.selectedDay) === isoDateLocal(d);
    const label = i === 0 ? "Hoje" : i === 1 ? "Amanhã" : DOW[d.getDay()];
    const aria = feriado
      ? `${label} ${d.getDate()}/${d.getMonth() + 1} (feriado: ${feriado})`
      : `${label} ${d.getDate()}/${d.getMonth() + 1}${open ? "" : " (sem atendimento)"}`;
    html += `
      <button type="button" class="day ${open ? "is-open" : "is-disabled"} ${feriado ? "is-holiday" : ""} ${selected ? "is-selected" : ""}"
              ${open ? "" : "disabled"} data-day="${isoDateLocal(d)}"
              title="${feriado ? "Feriado: " + feriado : ""}" aria-label="${aria}">
        <span class="dow">${label}</span>
        <span class="dnum">${d.getDate()}</span>
        <span class="dmon">${feriado ? "feriado" : d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")}</span>
      </button>`;
  }
  host.innerHTML = html;
  host.querySelectorAll("[data-day]:not(.is-disabled)").forEach((n) =>
    n.addEventListener("click", () => selectDay(n.dataset.day)));
}

async function selectDay(iso) {
  state.selectedDay = new Date(iso + "T12:00:00");
  state.selectedSlot = null;
  renderDays();
  show("step-time"); hide("step-form"); hide("step-review");
  setStep(3);
  await renderSlots();
  el("step-time").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// =============================================================================
// Passo 3 — horários (recalcula ao mudar serviço ou data)
// =============================================================================
async function renderSlots() {
  const host = el("slots");
  host.innerHTML = `<div class="loading-block"><span class="spinner" aria-hidden="true"></span> Carregando horários...</div>`;

  const day = new Date(state.selectedDay);
  const from = new Date(day); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);

  const { data: busy, error } = await supabase.rpc("busy_intervals", {
    p_profile: state.profile.id,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    host.innerHTML = `<div class="empty">Não foi possível carregar os horários. Tente novamente.</div>`;
    return;
  }

  const slots = computeFreeSlots({
    day,
    durationMin: state.selectedService.duration_minutes,
    availability: state.availability,
    busy: busy || [],
    now: new Date(),
    bufferMin: state.profile?.buffer_minutes || 0,
    blockHolidays: !state.profile?.work_holidays,
  });

  if (slots.length === 0) {
    host.innerHTML = `<div class="empty">Sem horários livres neste dia. Escolha outra data.</div>`;
    return;
  }
  host.innerHTML = `<div class="slot-grid">${slots.map((s) =>
    `<button type="button" class="slot ${state.selectedSlot && state.selectedSlot.getTime() === s.getTime() ? "is-selected" : ""}" data-slot="${s.toISOString()}">${formatTimeBR(s)}</button>`
  ).join("")}</div>`;
  host.querySelectorAll("[data-slot]").forEach((n) =>
    n.addEventListener("click", () => selectSlot(n.dataset.slot)));
}

function selectSlot(iso) {
  state.selectedSlot = new Date(iso);
  renderSlots();
  show("step-form"); hide("step-review");
  setStep(4);
  // restaura dados já digitados (caso tenha voltado)
  el("c-name").value = state.client.name;
  el("c-phone").value = state.client.phone;
  el("c-notes").value = state.client.notes;
  el("step-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
  setTimeout(() => el("c-name").focus(), 300);
}

// =============================================================================
// Passo 4 → 5 — valida dados e mostra o resumo
// =============================================================================
function goToReview(e) {
  e.preventDefault();
  const name = el("c-name").value.trim();
  const phone = el("c-phone").value.replace(/\D/g, "");
  const notes = el("c-notes").value.trim();

  if (name.length < 2) { toast("Informe seu nome.", "error"); el("c-name").focus(); return; }
  if (phone.length < 10) { toast("Informe um WhatsApp válido com DDD.", "error"); el("c-phone").focus(); return; }

  state.client = { name, phone, notes };
  renderSummary();
  show("step-review");
  setStep(5);
  el("step-review").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function backToForm() {
  hide("step-review");
  setStep(4);
  show("step-form");
  el("step-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderSummary() {
  const s = state.selectedService;
  const c = state.client;
  el("summary").innerHTML = `
    <div class="summary__row"><span>Profissional</span><strong>${esc(state.profile.full_name || "—")}</strong></div>
    <div class="summary__row"><span>Serviço</span><strong>${esc(s.name)}</strong></div>
    <div class="summary__row"><span>Preço</span><strong>${formatBRL(s.price_cents)}</strong></div>
    <div class="summary__row"><span>Duração</span><strong>${s.duration_minutes} min</strong></div>
    <div class="summary__row"><span>Data e horário</span><strong>${capitalize(formatDateTimeFull(state.selectedSlot))}</strong></div>
    <div class="summary__divider"></div>
    <div class="summary__row"><span>Seu nome</span><strong>${esc(c.name)}</strong></div>
    <div class="summary__row"><span>Seu WhatsApp</span><strong>${esc(formatPhone(c.phone))}</strong></div>
    ${c.notes ? `<div class="summary__row"><span>Observação</span><strong>${esc(c.notes)}</strong></div>` : ""}`;
}

// =============================================================================
// Envio do pedido (revalida no servidor; previne conflito)
// =============================================================================
let submitting = false;
async function submitBooking() {
  if (submitting) return;
  if (!state.selectedService || !state.selectedSlot) {
    toast("Escolha serviço, data e horário.", "error");
    return;
  }
  const { name, phone, notes } = state.client;
  const btn = el("confirm-btn");
  const restore = setLoading(btn, true, "Registrando...");
  submitting = true;

  try {
    const reqBody = {
      slug: state.slug,
      service_id: state.selectedService.id,
      starts_at: state.selectedSlot.toISOString(),
      client_name: name,
      client_phone: phone,
      notes,
    };

    let ok, status, body;
    if (LOCAL_MODE) {
      const { createBookingLocal } = await import("./localBackend.js");
      const r = await createBookingLocal(reqBody);
      ok = r.ok; status = r.status || (r.ok ? 200 : 400); body = r;
    } else {
      const res = await fetch(CREATE_BOOKING_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(reqBody),
      });
      ok = res.ok; status = res.status; body = await res.json().catch(() => ({}));
    }

    if (!ok) {
      // Conflito: o horário foi ocupado entre a escolha e o envio.
      if (status === 409) {
        toast(body.error || "Esse horário acabou de ser ocupado. Escolha outro.", "error");
        state.selectedSlot = null;
        hide("step-review"); hide("step-form");
        show("step-time"); setStep(3);
        await renderSlots();
        el("step-time").scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        toast(body.error || "Não foi possível registrar o pedido.", "error");
      }
      return;
    }

    // Reagendamento: o novo pedido foi criado — libera o horário anterior.
    if (state.rebookToken) {
      await cancelPreviousRebook(state.rebookToken);
    }

    const token = body?.appointment?.public_token || null;
    const manageUrl = token ? `${manageBaseUrl()}?t=${encodeURIComponent(token)}` : null;
    const linkTxt = manageUrl ? ` Se precisar cancelar ou reagendar, use este link: ${manageUrl}` : "";
    // Sinal: inclui a instrução de Pix na mensagem do WhatsApp quando exigido.
    const dep = depositInfo();
    const depTxt = dep ? ` Para garantir o horário, envio o sinal de ${formatBRL(dep.cents)} via Pix (${dep.key}) e mando o comprovante.` : "";
    const msg = `Olá! Gostaria de confirmar meu agendamento para ${state.selectedService.name}, no dia ${formatDateTimeFull(state.selectedSlot)}. Nome: ${name}.${depTxt}${linkTxt}`;
    const url = waLink(state.profile.phone, msg);
    toast("Pedido registrado! Abrindo o WhatsApp...", "success");
    showSuccess(url, manageUrl, dep);
    window.open(url, "_blank", "noopener");
  } catch (err) {
    toast("Falha de conexão. Verifique sua internet e tente novamente.", "error");
  } finally {
    submitting = false;
    restore();
  }
}

function manageBaseUrl() {
  const { origin, pathname } = window.location;
  const dir = pathname.replace(/\/[^/]*$/, "/");
  return `${origin}${dir}responder.html`;
}

// Cancela o agendamento anterior (reagendamento) usando o token.
// Falha silenciosa: se não cancelar, o profissional ainda vê o pedido novo
// e pode ajustar na agenda — não vale a pena bloquear o fluxo do cliente.
async function cancelPreviousRebook(prevToken) {
  try {
    if (LOCAL_MODE) {
      const { cancelByToken } = await import("./localBackend.js");
      await cancelByToken(prevToken);
    } else {
      const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
      await fetch(`${SUPABASE_URL}/functions/v1/appointment-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ token: prevToken, action: "cancel" }),
      });
    }
  } catch { /* não bloqueia a conclusão do novo agendamento */ }
}

// Dados do sinal, quando o profissional exige. Retorna null se não exige
// ou se faltam dados essenciais (valor/chave).
function depositInfo() {
  const p = state.profile;
  if (!p?.require_deposit) return null;
  const cents = Number(p.deposit_cents) || 0;
  const key = (p.pix_key || "").trim();
  if (cents <= 0 || !key) return null;
  return { cents, key, policy: (p.deposit_policy || "").trim() };
}

function showSuccess(waUrl, manageUrl, dep) {
  const depositBlock = dep ? `
    <div class="notice notice--info" style="margin-top:14px;text-align:left">
      <strong>Garanta seu horário com um sinal</strong>
      <p style="margin:6px 0">Envie <strong>${formatBRL(dep.cents)}</strong> via Pix para a chave abaixo e mande o comprovante no WhatsApp. Seu horário é confirmado quando o profissional registrar o sinal.</p>
      <div class="pix-key">
        <code id="pix-key-val">${esc(dep.key)}</code>
        <button type="button" class="btn btn--ghost btn--sm" id="pix-copy">Copiar chave</button>
      </div>
      ${dep.policy ? `<p class="help" style="margin-top:8px">${esc(dep.policy)}</p>` : ""}
    </div>` : "";

  el("content").innerHTML = `
    <div class="card" style="text-align:center">
      <div class="avatar avatar--lg" style="margin:0 auto 14px;background:var(--wa);color:#06331b">✓</div>
      <h1 style="font-size:1.35rem">Pedido registrado!</h1>
      <p class="muted">Seu pedido foi enviado. Conclua pelo WhatsApp do profissional.
      Lembre-se: o horário só está garantido quando o profissional <strong>confirmar</strong>${dep ? " o sinal" : ""}.</p>
      <a class="btn btn--wa btn--block btn--lg" href="${esc(waUrl)}" target="_blank" rel="noopener">Abrir WhatsApp</a>
      ${depositBlock}
      ${manageUrl ? `
        <div class="notice" style="margin-top:14px;text-align:left">
          <strong>Não vai poder ir?</strong> Guarde este link para <strong>cancelar ou reagendar</strong> quando precisar:
          <a href="${esc(manageUrl)}" style="display:block;margin-top:6px;word-break:break-all">${esc(manageUrl)}</a>
        </div>
        <a class="btn btn--ghost btn--block" href="${esc(manageUrl)}" style="margin-top:10px">Gerenciar meu agendamento</a>` : ""}
      <button class="btn btn--ghost btn--block" style="margin-top:10px" onclick="location.reload()">Fazer outro agendamento</button>
    </div>`;
  el("content").scrollIntoView({ behavior: "smooth", block: "start" });

  // Botão de copiar a chave Pix (só existe quando há sinal)
  const copyBtn = el("pix-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(dep.key);
        toast("Chave Pix copiada!", "success");
      } catch {
        toast("Copie a chave manualmente: " + dep.key, "info");
      }
    });
  }
}

// =============================================================================
// Helpers de UI / passos
// =============================================================================
function show(id) { el(id).classList.remove("hidden"); }
function hide(id) { el(id).classList.add("hidden"); }

function setStep(n) {
  document.querySelectorAll("#stepbar .stepbar__item").forEach((li) => {
    const step = Number(li.dataset.step);
    li.classList.toggle("is-done", step < n);
    li.classList.toggle("is-current", step === n);
  });
}

function capitalize(str) { return String(str).charAt(0).toUpperCase() + String(str).slice(1); }

function formatPhone(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
