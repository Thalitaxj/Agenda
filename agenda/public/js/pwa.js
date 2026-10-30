// =============================================================================
// Registro do Service Worker (PWA) — AgendaAí
// Incluído em todas as páginas. Registra o SW de forma não bloqueante e
// silenciosa: se o navegador não suportar ou falhar, o site segue normal.
// =============================================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Caminho relativo à própria página — funciona em subdiretórios (Netlify).
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* registro opcional: ignora falhas silenciosamente */
    });
  });
}
