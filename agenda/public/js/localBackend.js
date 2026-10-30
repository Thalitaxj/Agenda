// =============================================================================
// Backend LOCAL (sem servidor / sem internet) — AgendaAí
//
// Imita a parte da API do Supabase que o frontend usa, persistindo tudo no
// localStorage do navegador. Serve para rodar e testar o app 100% local.
//
// Cobre:
//   * auth: getSession, onAuthStateChange, signUp, signInWithPassword, signOut
//   * from(tabela): select().eq().gte().lt().order().maybeSingle() + insert/update/delete
//   * rpc("busy_intervals")
//   * createBookingLocal(): equivalente à Edge Function (validação no "servidor")
//
// Limitações (por ser local): sem multiusuário real entre máquinas, dados
// apenas neste navegador, "senha" guardada localmente só para simular login.
// NÃO use este modo em produção.
// =============================================================================

const DB_KEY = "agendazap_db_v1";
const SESSION_KEY = "agendazap_session_v1";

// ---- Persistência -----------------------------------------------------------
function emptyDB() {
  return {
    users: [],         // { id, email, password, user_metadata }
    profiles: [],
    services: [],
    availability: [],
    time_blocks: [],
    clients: [],
    appointments: [],
    client_notes: [],
    reviews: [],
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) { const db = emptyDB(); saveDB(db); return db; }
    const db = JSON.parse(raw);
    // garante que novas coleções existam
    const base = emptyDB();
    for (const k of Object.keys(base)) if (!db[k]) db[k] = base[k];
    return db;
  } catch {
    const db = emptyDB(); saveDB(db); return db;
  }
}
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---- Sessão -----------------------------------------------------------------
function getSessionUser() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { userId } = JSON.parse(raw);
    const db = loadDB();
    const u = db.users.find((x) => x.id === userId);
    return u ? publicUser(u) : null;
  } catch { return null; }
}
function setSession(userId) { localStorage.setItem(SESSION_KEY, JSON.stringify({ userId })); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function publicUser(u) { return { id: u.id, email: u.email, user_metadata: u.user_metadata || {} }; }

const authListeners = [];
function emitAuth(event) {
  const user = getSessionUser();
  const session = user ? { user } : null;
  authListeners.forEach((cb) => { try { cb(event, session); } catch {} });
}

// ---- Query builder encadeável (imita PostgREST) -----------------------------
class Query {
  constructor(table) {
    this.table = table;
    this._filters = [];      // {col, op, val}
    this._order = [];        // {col, asc}
    this._op = "select";
    this._payload = null;
    this._single = false;
  }
  select() { this._op = this._op === "select" ? "select" : this._op; return this; }
  insert(payload) { this._op = "insert"; this._payload = payload; return this; }
  update(payload) { this._op = "update"; this._payload = payload; return this; }
  delete() { this._op = "delete"; return this; }

  eq(col, val) { this._filters.push({ col, op: "eq", val }); return this; }
  gte(col, val) { this._filters.push({ col, op: "gte", val }); return this; }
  lt(col, val) { this._filters.push({ col, op: "lt", val }); return this; }
  order(col, opts = {}) { this._order.push({ col, asc: opts.ascending !== false }); return this; }
  maybeSingle() { this._single = true; return this._run(); }

  // torna "thenable": permite await direto no builder
  then(resolve, reject) { return this._run().then(resolve, reject); }

  _match(row) {
    return this._filters.every((f) => {
      const v = row[f.col];
      if (f.op === "eq") return v === f.val;
      if (f.op === "gte") return v >= f.val;
      if (f.op === "lt") return v < f.val;
      return true;
    });
  }

  async _run() {
    const db = loadDB();
    const table = db[this.table] || (db[this.table] = []);
    try {
      if (this._op === "select") {
        let rows = table.filter((r) => this._match(r));
        for (const o of this._order.slice().reverse()) {
          rows.sort((a, b) => {
            const av = a[o.col], bv = b[o.col];
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (o.asc ? 1 : -1);
          });
        }
        if (this._single) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }

      if (this._op === "insert") {
        const items = Array.isArray(this._payload) ? this._payload : [this._payload];
        const inserted = [];
        for (const it of items) {
          const row = withDefaults(this.table, it);
          const err = enforceConstraints(db, this.table, row, null);
          if (err) return { data: null, error: err };
          table.push(row);
          inserted.push(row);
        }
        saveDB(db);
        if (this._single) return { data: inserted[0] || null, error: null };
        return { data: inserted, error: null };
      }

      if (this._op === "update") {
        const targets = table.filter((r) => this._match(r));
        for (const r of targets) {
          const candidate = { ...r, ...this._payload, updated_at: new Date().toISOString() };
          const err = enforceConstraints(db, this.table, candidate, r.id);
          if (err) return { data: null, error: err };
        }
        targets.forEach((r) => Object.assign(r, this._payload, { updated_at: new Date().toISOString() }));
        saveDB(db);
        if (this._single) return { data: targets[0] || null, error: null };
        return { data: targets, error: null };
      }

      if (this._op === "delete") {
        const keep = table.filter((r) => !this._match(r));
        db[this.table] = keep;
        saveDB(db);
        return { data: null, error: null };
      }
    } catch (e) {
      return { data: null, error: { message: e.message || "Erro local" } };
    }
  }
}

function withDefaults(table, it) {
  const now = new Date().toISOString();
  const row = { ...it };
  if (table !== "profiles" && !row.id) row.id = uuid();
  if (["services", "clients", "appointments"].includes(table) && !row.created_at) row.created_at = now;
  if (table === "appointments") {
    row.created_at ||= now; row.updated_at ||= now; row.status ||= "requested";
    // Confirmação de presença (separada do status do agendamento)
    if (row.attendance === undefined) row.attendance = "pending"; // pending | confirmed | declined
    if (row.attendance_at === undefined) row.attendance_at = null;
    if (row.reschedule_requested === undefined) row.reschedule_requested = false;
    if (row.reminder_24h_sent_at === undefined) row.reminder_24h_sent_at = null;
    if (row.reminder_short_sent_at === undefined) row.reminder_short_sent_at = null;
    // Sinal / entrada (none | pending | paid)
    if (row.deposit_status === undefined) row.deposit_status = "none";
    if (row.deposit_cents === undefined) row.deposit_cents = 0;
    // Token seguro para o link de resposta do cliente
    if (!row.public_token) row.public_token = (uuid() + uuid()).replace(/-/g, "");
  }
  if (table === "profiles") { row.created_at ||= now; row.updated_at ||= now; }
  if (table === "services" && row.active === undefined) row.active = true;
  if (table === "client_notes") { row.created_at ||= now; row.updated_at ||= now; }
  if (table === "reviews") { row.created_at ||= now; }
  return row;
}

// Imita constraints do Postgres relevantes:
//  * profiles.slug único
//  * clients (profile_id, phone) único
//  * appointments: sem sobreposição entre CONFIRMADOS do mesmo profissional
function enforceConstraints(db, table, row, ignoreId) {
  if (table === "profiles") {
    const dup = db.profiles.find((p) => p.slug === row.slug && p.id !== (ignoreId ?? row.id));
    if (dup) return { message: "duplicate key value violates unique constraint (slug)" };
  }
  if (table === "clients") {
    const dup = db.clients.find((c) => c.profile_id === row.profile_id && c.phone === row.phone && c.id !== ignoreId);
    if (dup) return { message: "duplicate key (profile_id, phone)" };
  }
  if (table === "appointments" && row.status === "confirmed") {
    const s = new Date(row.starts_at).getTime();
    const e = new Date(row.ends_at).getTime();
    const clash = db.appointments.find((a) =>
      a.id !== ignoreId &&
      a.profile_id === row.profile_id &&
      a.status === "confirmed" &&
      new Date(a.starts_at).getTime() < e &&
      new Date(a.ends_at).getTime() > s);
    if (clash) return { message: "appointments_no_overlap exclusion constraint" };
  }
  return null;
}

// ---- RPC: busy_intervals ----------------------------------------------------
function busyIntervals({ p_profile, p_from, p_to }) {
  const db = loadDB();
  const from = new Date(p_from).getTime();
  const to = new Date(p_to).getTime();
  const out = [];
  for (const a of db.appointments) {
    if (a.profile_id !== p_profile) continue;
    if (!["requested", "confirmed"].includes(a.status)) continue;
    if (new Date(a.starts_at).getTime() < to && new Date(a.ends_at).getTime() > from)
      out.push({ starts_at: a.starts_at, ends_at: a.ends_at, status: a.status });
  }
  for (const b of db.time_blocks) {
    if (b.profile_id !== p_profile) continue;
    if (new Date(b.starts_at).getTime() < to && new Date(b.ends_at).getTime() > from)
      out.push({ starts_at: b.starts_at, ends_at: b.ends_at, status: "confirmed" });
  }
  return out;
}

// ---- Edge Function local: create-booking ------------------------------------
// Mesmas validações de servidor da Edge Function real.
export async function createBookingLocal(payload) {
  const db = loadDB();
  const { slug, service_id, starts_at, client_name, client_phone, notes } = payload || {};
  if (!slug || !service_id || !starts_at || !client_name || !client_phone)
    return { ok: false, status: 400, error: "Campos obrigatórios ausentes." };

  const phone = String(client_phone).replace(/\D/g, "");
  if (phone.length < 10) return { ok: false, status: 400, error: "Telefone inválido." };

  const start = new Date(starts_at);
  if (isNaN(start.getTime())) return { ok: false, status: 400, error: "Data/horário inválido." };
  if (start.getTime() < Date.now() - 60000) return { ok: false, status: 400, error: "Não é possível agendar no passado." };

  const profile = db.profiles.find((p) => p.slug === slug);
  if (!profile) return { ok: false, status: 404, error: "Profissional não encontrado." };

  const service = db.services.find((s) => s.id === service_id);
  if (!service || service.profile_id !== profile.id || !service.active)
    return { ok: false, status: 400, error: "Serviço indisponível." };

  const end = new Date(start.getTime() + service.duration_minutes * 60000);

  // janela de atendimento
  const weekday = start.getDay();
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = startMin + service.duration_minutes;
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
  const fits = db.availability.some((a) =>
    a.profile_id === profile.id && Number(a.weekday) === weekday &&
    startMin >= toMin(a.start_time) && endMin <= toMin(a.end_time));
  if (!fits) return { ok: false, status: 409, error: "Horário fora do atendimento do profissional." };

  // conflito — considera o intervalo entre atendimentos (buffer) do profissional
  const buffer = (Number(profile.buffer_minutes) || 0) * 60000;
  const checkFrom = new Date(start.getTime() - buffer);
  const checkTo = new Date(end.getTime() + buffer);
  const busy = busyIntervals({ p_profile: profile.id, p_from: checkFrom.toISOString(), p_to: checkTo.toISOString() });
  if (busy.length > 0) return { ok: false, status: 409, error: "Este horário acabou de ser ocupado. Escolha outro." };

  // cliente (upsert)
  let client = db.clients.find((c) => c.profile_id === profile.id && c.phone === phone);
  if (!client) {
    client = withDefaults("clients", { profile_id: profile.id, name: client_name, phone });
    db.clients.push(client);
  }

  // Modo de confirmação: automático (confirmed) ou manual (requested).
  const autoConfirm = profile.confirm_mode === "auto";
  // Sinal: se o profissional exige, o agendamento nasce com sinal pendente.
  const needsDeposit = Boolean(profile.require_deposit) && Number(profile.deposit_cents) > 0;
  const appt = withDefaults("appointments", {
    profile_id: profile.id,
    service_id: service.id,
    client_id: client.id,
    client_name,
    client_phone: phone,
    service_name: service.name,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    status: autoConfirm ? "confirmed" : "requested",
    source: "public",
    notes: notes || "",
    deposit_status: needsDeposit ? "pending" : "none",
    deposit_cents: needsDeposit ? Number(profile.deposit_cents) : 0,
  });
  // Revalida a constraint anti-sobreposição (confirmados). Se falhar, recusa.
  const cErr = enforceConstraints(db, "appointments", appt, null);
  if (cErr) return { ok: false, status: 409, error: "Este horário acabou de ser ocupado. Escolha outro." };
  db.appointments.push(appt);
  saveDB(db);

  return { ok: true, appointment: { id: appt.id, starts_at: appt.starts_at, ends_at: appt.ends_at, status: appt.status, public_token: appt.public_token } };
}

// ---- Objeto compatível com o supabase client -------------------------------
export const localSupabase = {
  auth: {
    async getSession() {
      const user = getSessionUser();
      return { data: { session: user ? { user } : null }, error: null };
    },
    onAuthStateChange(cb) {
      authListeners.push(cb);
      return { data: { subscription: { unsubscribe() {
        const i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1);
      } } } };
    },
    async signUp({ email, password, options }) {
      const db = loadDB();
      email = String(email || "").trim().toLowerCase();
      if (db.users.some((u) => u.email === email))
        return { data: { session: null, user: null }, error: { message: "User already registered" } };
      if (!password || password.length < 6)
        return { data: { session: null, user: null }, error: { message: "Password should be at least 6 characters" } };

      const id = uuid();
      const meta = options?.data || {};
      db.users.push({ id, email, password, user_metadata: meta });

      // cria profile com slug único (equivalente ao trigger handle_new_user)
      let base = slugify(meta.slug || email.split("@")[0]) || "pro";
      let finalSlug = base, n = 0;
      while (db.profiles.some((p) => p.slug === finalSlug)) { n++; finalSlug = `${base}-${n}`; }
      db.profiles.push(withDefaults("profiles", {
        id, slug: finalSlug, full_name: meta.full_name || "",
        description: "", phone: "", address: "", avatar_url: "",
        timezone: "America/Sao_Paulo",
      }));
      saveDB(db);

      // no modo local, já abre a sessão (sem confirmação de e-mail)
      setSession(id);
      emitAuth("SIGNED_IN");
      const user = getSessionUser();
      return { data: { session: { user }, user }, error: null };
    },
    async signInWithPassword({ email, password }) {
      const db = loadDB();
      email = String(email || "").trim().toLowerCase();
      const u = db.users.find((x) => x.email === email);
      if (!u || u.password !== password)
        return { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
      setSession(u.id);
      emitAuth("SIGNED_IN");
      const user = getSessionUser();
      return { data: { session: { user }, user }, error: null };
    },
    async signOut() { clearSession(); emitAuth("SIGNED_OUT"); return { error: null }; },

    // Recuperação de senha (modo local: sem envio de e-mail real).
    async resetPasswordForEmail(email) {
      const db = loadDB();
      email = String(email || "").trim().toLowerCase();
      if (!db.users.some((u) => u.email === email))
        return { data: null, error: { message: "Usuário não encontrado." } };
      // No modo local não há e-mail; a redefinição direta não é suportada com segurança.
      return { data: {}, error: { message: "Recuperação por e-mail só funciona com o Supabase configurado." } };
    },
    // Atualiza a senha do usuário logado (usada na página de reset).
    async updateUser({ password }) {
      const user = getSessionUser();
      if (!user) return { data: null, error: { message: "Sem sessão." } };
      const db = loadDB();
      const u = db.users.find((x) => x.id === user.id);
      if (u && password) { u.password = password; saveDB(db); }
      return { data: { user }, error: null };
    },
  },

  from(table) { return new Query(table); },

  async rpc(fn, args) {
    if (fn === "busy_intervals") return { data: busyIntervals(args), error: null };
    return { data: null, error: { message: `rpc ${fn} não implementada no modo local` } };
  },
};

// ---- Diagnóstico: lista os profissionais existentes neste navegador --------
export function listProfilesLocal() {
  const db = loadDB();
  return (db.profiles || []).map((p) => ({ slug: p.slug, full_name: p.full_name }));
}

// =============================================================================
// Resposta do cliente via LINK SEGURO (token) — sem login
// Usado por responder.html. No Supabase real, isto vira uma Edge Function
// equivalente (service role), validando o token.
// =============================================================================

// Busca o agendamento + dados públicos do profissional por token.
export async function getAppointmentByToken(token) {
  const db = loadDB();
  const appt = (db.appointments || []).find((a) => a.public_token === token);
  if (!appt) return { ok: false, error: "Agendamento não encontrado." };
  const prof = db.profiles.find((p) => p.id === appt.profile_id) || {};
  const hasReview = (db.reviews || []).some((x) => x.appointment_id === appt.id);
  return {
    ok: true,
    appointment: {
      id: appt.id,
      service_id: appt.service_id,
      service_name: appt.service_name,
      starts_at: appt.starts_at,
      ends_at: appt.ends_at,
      status: appt.status,
      attendance: appt.attendance,
      attendance_at: appt.attendance_at,
      reschedule_requested: appt.reschedule_requested,
      client_name: appt.client_name,
      has_review: hasReview,
    },
    profile: {
      full_name: prof.full_name || "Profissional",
      address: prof.address || "",
      phone: prof.phone || "",
      slug: prof.slug || "",
    },
  };
}

// Cliente confirma presença.
export async function confirmAttendanceByToken(token) {
  const db = loadDB();
  const appt = (db.appointments || []).find((a) => a.public_token === token);
  if (!appt) return { ok: false, error: "Agendamento não encontrado." };
  if (appt.status === "cancelled") return { ok: false, error: "Este agendamento foi cancelado." };
  if (appt.status === "completed") return { ok: false, error: "Este atendimento já foi concluído." };
  if (appt.attendance === "confirmed") return { ok: true, already: true };
  appt.attendance = "confirmed";
  appt.attendance_at = new Date().toISOString();
  appt.reschedule_requested = false;
  appt.updated_at = new Date().toISOString();
  saveDB(db);
  return { ok: true };
}

// Cliente solicita cancelamento → libera o horário (status cancelled).
export async function cancelByToken(token) {
  const db = loadDB();
  const appt = (db.appointments || []).find((a) => a.public_token === token);
  if (!appt) return { ok: false, error: "Agendamento não encontrado." };
  if (appt.status === "cancelled") return { ok: true, already: true };
  if (appt.status === "completed") return { ok: false, error: "Este atendimento já foi concluído." };
  appt.status = "cancelled";
  appt.attendance = "declined";
  appt.attendance_at = new Date().toISOString();
  appt.updated_at = new Date().toISOString();
  saveDB(db);
  return { ok: true };
}

// Cliente solicita reagendamento → marca a flag (depende de aprovação do profissional).
export async function requestRescheduleByToken(token) {
  const db = loadDB();
  const appt = (db.appointments || []).find((a) => a.public_token === token);
  if (!appt) return { ok: false, error: "Agendamento não encontrado." };
  if (appt.status === "cancelled") return { ok: false, error: "Este agendamento foi cancelado." };
  if (appt.status === "completed") return { ok: false, error: "Este atendimento já foi concluído." };
  appt.reschedule_requested = true;
  appt.updated_at = new Date().toISOString();
  saveDB(db);
  return { ok: true };
}

// Cliente avalia (nota + comentário) — só se o agendamento estiver CONCLUÍDO
// e ainda não houver avaliação para ele (1 por agendamento).
export async function submitReviewByToken(token, rating, comment) {
  const db = loadDB();
  const appt = (db.appointments || []).find((a) => a.public_token === token);
  if (!appt) return { ok: false, error: "Agendamento não encontrado." };
  if (appt.status !== "completed") return { ok: false, error: "A avaliação fica disponível após o atendimento ser concluído." };
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5)) return { ok: false, error: "Escolha uma nota de 1 a 5." };
  if ((db.reviews || []).some((x) => x.appointment_id === appt.id))
    return { ok: false, error: "Este atendimento já foi avaliado.", already: true };
  db.reviews = db.reviews || [];
  db.reviews.push(withDefaults("reviews", {
    profile_id: appt.profile_id, appointment_id: appt.id,
    client_name: appt.client_name, rating: r, comment: String(comment || "").slice(0, 500),
  }));
  saveDB(db);
  return { ok: true };
}
