// =============================================================================
// Cálculo de horários livres (slots) para um dia.
//
// É usado no frontend para EXIBIR opções ao cliente. A validação definitiva
// acontece no servidor (Edge Function + constraint do banco) — este cálculo
// é de apresentação e pode ser recusado na hora de salvar.
// =============================================================================
import { SLOT_STEP_MINUTES } from "../config.js";
import { isHoliday } from "./holidays.js";

/**
 * Gera os horários de início disponíveis para um dia.
 *
 * @param {Object}   params
 * @param {Date}     params.day            Dia desejado (hora ignorada).
 * @param {number}   params.durationMin    Duração do serviço em minutos.
 * @param {Array}    params.availability    [{weekday, start_time:'HH:MM:SS', end_time}]
 * @param {Array}    params.busy            [{starts_at, ends_at}] intervalos ocupados
 * @param {number}   [params.stepMin]       Granularidade (default: config).
 * @param {Date}     [params.now]           Referência de "agora" (para não ofertar passado).
 * @returns {Date[]} horários de início livres, ordenados.
 */
export function computeFreeSlots({ day, durationMin, availability, busy, stepMin = SLOT_STEP_MINUTES, now = new Date(), bufferMin = 0, blockHolidays = true }) {
  // Feriado nacional bloqueia o dia automaticamente.
  if (blockHolidays && isHoliday(day)) return [];

  const weekday = day.getDay();
  const windows = (availability || []).filter((a) => Number(a.weekday) === weekday);
  if (windows.length === 0) return [];

  // Intervalo entre atendimentos: cada ocupado "cresce" bufferMin para cada lado,
  // garantindo folga antes e depois do horário escolhido.
  const bufferMs = Math.max(0, Number(bufferMin) || 0) * 60_000;
  const busyRanges = (busy || []).map((b) => [
    new Date(b.starts_at).getTime() - bufferMs,
    new Date(b.ends_at).getTime() + bufferMs,
  ]);

  const toMinutes = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  };

  const slots = [];
  const durMs = durationMin * 60_000;

  for (const w of windows) {
    const wStart = toMinutes(w.start_time);
    const wEnd = toMinutes(w.end_time);

    for (let min = wStart; min + durationMin <= wEnd; min += stepMin) {
      const start = new Date(day);
      start.setHours(0, 0, 0, 0);
      start.setMinutes(min);
      const startMs = start.getTime();
      const endMs = startMs + durMs;

      // não ofertar horário no passado (margem de 1 min)
      if (startMs < now.getTime() - 60_000) continue;

      // checar sobreposição com qualquer intervalo ocupado (já com buffer)
      const overlaps = busyRanges.some(([bs, be]) => startMs < be && endMs > bs);
      if (!overlaps) slots.push(start);
    }
  }

  // ordena e remove duplicados (caso haja janelas sobrepostas)
  const seen = new Set();
  return slots
    .sort((a, b) => a - b)
    .filter((d) => {
      const k = d.getTime();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
