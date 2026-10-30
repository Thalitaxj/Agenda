// =============================================================================
// Redefinição de senha — AgendaAí
// Acessada pelo link enviado por e-mail (Supabase cria uma sessão de
// recuperação ao abrir esta página). Define a nova senha com updateUser.
// =============================================================================
import { supabase, IS_CONFIGURED } from "./supabaseClient.js";
import { toast, setLoading } from "./lib/ui.js";

const card = document.getElementById("reset-card");
const invalid = document.getElementById("reset-invalid");

(async function boot() {
  if (!IS_CONFIGURED) {
    document.getElementById("reset-sub").textContent = "Backend não configurado.";
    return;
  }
  // O Supabase processa o token da URL e cria uma sessão de recuperação.
  // Damos um instante para isso acontecer e então checamos a sessão.
  let hasSession = false;
  try {
    const { data } = await supabase.auth.getSession();
    hasSession = Boolean(data.session);
    if (!hasSession) {
      // aguarda o evento PASSWORD_RECOVERY (link recém-aberto)
      await new Promise((resolve) => {
        const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
          if (session) { hasSession = true; sub.subscription.unsubscribe(); resolve(); }
        });
        setTimeout(resolve, 2500);
      });
    }
  } catch { /* ignore */ }

  if (!hasSession) {
    card.classList.add("hidden");
    invalid.classList.remove("hidden");
  }
})();

document.getElementById("reset-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = document.getElementById("r-pass").value;
  const p2 = document.getElementById("r-pass2").value;
  if (p1.length < 6) { toast("A senha precisa ter ao menos 6 caracteres.", "error"); return; }
  if (p1 !== p2) { toast("As senhas não coincidem.", "error"); return; }

  const btn = document.getElementById("r-submit");
  const restore = setLoading(btn, true, "Salvando...");
  try {
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) throw error;
    toast("Senha redefinida! Redirecionando...", "success");
    setTimeout(() => (window.location.href = "./app.html"), 1200);
  } catch (err) {
    const m = (err?.message || "").toLowerCase();
    if (m.includes("session")) toast("Link expirado. Peça um novo link de recuperação.", "error");
    else toast("Não foi possível redefinir: " + (err?.message || ""), "error");
  } finally {
    restore();
  }
});
