// =============================================================================
// Autenticação (landing index.html): login e cadastro de profissionais.
// =============================================================================
import { supabase, IS_CONFIGURED } from "./supabaseClient.js";
import { toast, setLoading, esc } from "./lib/ui.js";

// Banner de configuração ausente
if (!IS_CONFIGURED) {
  document.getElementById("config-banner")?.classList.remove("hidden");
}

// Se já estiver logado, vai direto para o painel
(async () => {
  if (!IS_CONFIGURED) return;
  const { data } = await supabase.auth.getSession();
  if (data.session) window.location.href = "./app.html";
})();

const modal = document.getElementById("auth-modal");
const form = document.getElementById("auth-form");
const title = document.getElementById("auth-title");
const subtitle = document.getElementById("auth-subtitle");
const submitBtn = document.getElementById("auth-submit");
const switchLink = document.getElementById("auth-switch");
const switchText = document.getElementById("auth-switch-text");
const fieldName = document.getElementById("field-name");
const fieldSlug = document.getElementById("field-slug");
const slugInput = document.getElementById("f-slug");
const slugPreview = document.getElementById("slug-preview");

let mode = "login"; // 'login' | 'signup'

function slugify(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function openModal(nextMode = "login") {
  setMode(nextMode);
  modal.classList.remove("hidden");
}
function closeModal() { modal.classList.add("hidden"); }

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  title.textContent = signup ? "Criar conta" : "Entrar";
  subtitle.textContent = signup
    ? "Crie sua conta grátis e comece a receber agendamentos."
    : "Acesse seu painel para gerenciar a agenda.";
  submitBtn.textContent = signup ? "Criar conta grátis" : "Entrar";
  fieldName.classList.toggle("hidden", !signup);
  fieldSlug.classList.toggle("hidden", !signup);
  switchText.textContent = signup ? "Já tem conta?" : "Ainda não tem conta?";
  switchLink.textContent = signup ? "Entrar" : "Criar conta grátis";
  document.getElementById("f-password").autocomplete = signup ? "new-password" : "current-password";
  // "Esqueci minha senha" só faz sentido no login
  document.getElementById("forgot-row")?.classList.toggle("hidden", signup);
}

// Listeners de abertura
document.getElementById("btn-open-auth")?.addEventListener("click", () => openModal("login"));
document.getElementById("btn-open-auth-2")?.addEventListener("click", () => openModal("login"));
document.getElementById("btn-hero-cta")?.addEventListener("click", () => openModal("signup"));
document.getElementById("btn-cta-final")?.addEventListener("click", () => openModal("signup"));
document.getElementById("auth-close")?.addEventListener("click", closeModal);
modal?.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

switchLink?.addEventListener("click", (e) => {
  e.preventDefault();
  setMode(mode === "login" ? "signup" : "login");
});

// Esqueci minha senha → envia e-mail com link de redefinição
document.getElementById("auth-forgot")?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!IS_CONFIGURED) {
    toast("Configure o Supabase para usar a recuperação de senha.", "error");
    return;
  }
  const email = document.getElementById("f-email").value.trim();
  if (!email) {
    toast("Digite seu e-mail no campo acima e clique de novo.", "info");
    document.getElementById("f-email").focus();
    return;
  }
  const link = document.getElementById("auth-forgot");
  const restore = setLoading(link, true, "Enviando...");
  try {
    // redireciona o usuário para a página de nova senha após clicar no e-mail
    const base = window.location.href.replace(/index\.html.*$|\/$/, "");
    const redirectTo = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, "")}reset.html`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    toast("Enviamos um link de redefinição para o seu e-mail.", "success");
  } catch (err) {
    toast(traduzErro(err?.message), "error");
  } finally {
    restore();
  }
});

slugInput?.addEventListener("input", () => {
  const v = slugify(slugInput.value);
  slugPreview.textContent = v || "seu-link";
});
document.getElementById("f-name")?.addEventListener("input", (e) => {
  if (!slugInput.value) slugPreview.textContent = slugify(e.target.value) || "seu-link";
});

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!IS_CONFIGURED) {
    toast("Configure o Supabase em public/js/config.js (veja SETUP.md).", "error");
    return;
  }
  const email = document.getElementById("f-email").value.trim();
  const password = document.getElementById("f-password").value;
  const restore = setLoading(submitBtn, true, mode === "signup" ? "Criando..." : "Entrando...");

  try {
    if (mode === "signup") {
      const fullName = document.getElementById("f-name").value.trim();
      const slug = slugify(slugInput.value) || slugify(fullName);
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: fullName, slug } },
      });
      if (error) throw error;
      if (data.session) {
        window.location.href = "./app.html";
      } else {
        toast("Conta criada! Verifique seu e-mail para confirmar o acesso.", "success");
        setMode("login");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.href = "./app.html";
    }
  } catch (err) {
    toast(traduzErro(err?.message), "error");
  } finally {
    restore();
  }
});

function traduzErro(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou senha incorretos.";
  if (m.includes("already registered") || m.includes("already been registered")) return "Este e-mail já tem conta. Faça login.";
  if (m.includes("email not confirmed")) return "Confirme seu e-mail antes de entrar.";
  if (m.includes("password")) return "Senha inválida (mínimo 6 caracteres).";
  return msg || "Algo deu errado. Tente novamente.";
}
