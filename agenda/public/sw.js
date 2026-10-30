// =============================================================================
// Service Worker — AgendaAí (PWA)
//
// Estratégia:
//   * App shell (HTML/CSS/JS/imagens da própria origem): pré-cacheado.
//   * Navegação (documentos HTML): network-first — busca a versão nova quando
//     online e cai no cache quando offline.
//   * Demais estáticos da MESMA origem: stale-while-revalidate (rápido e
//     atualiza em segundo plano).
//   * Requisições a OUTRAS origens (ex.: API do Supabase, Google Fonts):
//     passam direto para a rede, sem cache — dados dinâmicos nunca são servidos
//     de cache para não mostrar informação velha.
//
// Para forçar atualização do cache, aumente a versão em CACHE_VERSION.
// =============================================================================

const CACHE_VERSION = "agendaai-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.html",
  "./agendar.html",
  "./responder.html",
  "./reset.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/booking.js",
  "./js/config.js",
  "./js/localBackend.js",
  "./js/reset.js",
  "./js/responder.js",
  "./js/supabaseClient.js",
  "./js/lib/holidays.js",
  "./js/lib/scheduling.js",
  "./js/lib/ui.js",
  "./img/logo.svg",
  "./img/logo-mark.svg",
  "./img/icon-maskable.svg",
  "./img/cover-default.svg",
  "./img/service-placeholder.svg",
];

// Instala: pré-cacheia o app shell. Ignora falhas pontuais de itens.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// Ativa: remove caches de versões antigas.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Só tratamos GET. POST/PUT (ex.: Edge Functions) passam direto.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Requisições a outras origens (Supabase, fontes, CDNs): rede direta.
  if (url.origin !== self.location.origin) return;

  // Navegação de página (HTML): network-first com fallback ao cache.
  const isNavigation = req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");
  if (isNavigation) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Demais estáticos da mesma origem: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // último recurso: página inicial do cache
    const fallback = await cache.match("./index.html");
    if (fallback) return fallback;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}
