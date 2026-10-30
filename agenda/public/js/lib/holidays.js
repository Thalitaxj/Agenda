// =============================================================================
// Feriados nacionais brasileiros — cálculo automático por ano.
//
// Inclui os feriados FIXOS e os MÓVEIS (que dependem da Páscoa:
// Carnaval, Sexta-feira Santa, Corpus Christi). Usado para bloquear
// automaticamente a agenda nesses dias, sem o profissional cadastrar um a um.
//
// Observação: feriados estaduais/municipais NÃO entram aqui (variam por cidade).
// O profissional pode bloquear esses manualmente em "Folgas e bloqueios".
// =============================================================================

// Domingo de Páscoa (algoritmo de Gauss/Meeus) para um dado ano.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = março, 4 = abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Retorna um Map { 'YYYY-MM-DD' -> 'Nome do feriado' } para o ano dado.
export function holidaysForYear(year) {
  const map = new Map();

  // --- Fixos ---
  const fixos = [
    ["01-01", "Confraternização Universal"],
    ["04-21", "Tiradentes"],
    ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência do Brasil"],
    ["10-12", "Nossa Senhora Aparecida"],
    ["11-02", "Finados"],
    ["11-15", "Proclamação da República"],
    ["11-20", "Consciência Negra"], // feriado nacional desde 2024
    ["12-25", "Natal"],
  ];
  for (const [md, nome] of fixos) map.set(`${year}-${md}`, nome);

  // --- Móveis (relativos ao Domingo de Páscoa) ---
  const easter = easterSunday(year);
  map.set(iso(addDays(easter, -47)), "Carnaval");          // terça de carnaval
  map.set(iso(addDays(easter, -48)), "Carnaval");          // segunda de carnaval
  map.set(iso(addDays(easter, -2)), "Sexta-feira Santa");  // sexta da paixão
  map.set(iso(addDays(easter, 60)), "Corpus Christi");     // quinta de Corpus Christi

  return map;
}

// É feriado nacional? Recebe um Date. Retorna o nome do feriado ou null.
// Faz cache por ano para não recalcular toda hora.
const _cache = new Map();
export function holidayName(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  if (!_cache.has(year)) _cache.set(year, holidaysForYear(year));
  const key = iso(d);
  return _cache.get(year).get(key) || null;
}

export function isHoliday(date) {
  return holidayName(date) !== null;
}
