// =============================================================================
// Helpers de UI: toasts, formatação, loading em botões, escape de HTML.
// =============================================================================

/** Escapa texto para interpolar com segurança em innerHTML. */
export function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Toast simples no canto inferior. tipo: 'success' | 'error' | 'info' */
export function toast(message, tipo = "info") {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast--${tipo}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast--show"));
  setTimeout(() => {
    el.classList.remove("toast--show");
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

/** Coloca um botão em estado de carregando e retorna função para restaurar. */
export function setLoading(btn, loading, loadingText = "Aguarde...") {
  if (!btn) return () => {};
  if (loading) {
    btn.dataset._label = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${loadingText}`;
    return () => setLoading(btn, false);
  }
  btn.disabled = false;
  btn.classList.remove("is-loading");
  if (btn.dataset._label) btn.innerHTML = btn.dataset._label;
  return () => {};
}

// --- Formatação -------------------------------------------------------------

export function formatBRL(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency", currency: "BRL",
  });
}

export function formatDateBR(date) {
  return new Date(date).toLocaleDateString("pt-BR", {
    weekday: "short", day: "2-digit", month: "2-digit",
  });
}

export function formatTimeBR(date) {
  return new Date(date).toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit",
  });
}

export function formatDateTimeFull(date) {
  return new Date(date).toLocaleString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
}

/** 'YYYY-MM-DD' no fuso local (sem UTC shift). */
export function isoDateLocal(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const STATUS_LABEL = {
  requested: "Solicitado",
  confirmed: "Confirmado",
  completed: "Concluído",
  cancelled: "Cancelado",
  no_show: "Faltou",
};

/** Monta link wa.me com mensagem pré-preenchida. phone: só dígitos. */
export function waLink(phone, message) {
  const digits = String(phone || "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
