// src/stay-dates.js
// Normaliza checkin/checkout de una estancia ANTES de consultar disponibilidad.
//
// V1.2 (24-sep-2026, docs/plan-mejora-voz-sep-2026.md): un huésped real pidió
// "entrar mañana y salir el domingo" y gpt-4o-mini llamó a get_current_date y
// get_availability EN PARALELO, mandando checkin_date/checkout_date de hace
// varios años (fechas inventadas, no un año mal escrito). Cloudbeds contesta
// success:false ("startDate should be greater than today") y eso se oía como
// un error técnico + disparaba una alerta a Telegram, aunque el huésped
// pedía una fecha futura real. Corregir la fecha nosotros mismos (p. ej. "el
// mismo mes/día del año que viene") puede dar una fecha tan falsa como la
// original si lo que falló fue el cálculo entero, no solo el año — así que
// NINGÚN checkin pasado se corrige solo: se rechaza y se le pide al MODELO
// que recalcule con un calendario real (ver server.js, POST
// /vapi/get-availability), sin decirle al huésped que hubo un error.
//
// Funciones PURAS: no tocan el reloj (reciben "hoy" ya calculado por quien
// llama, en Europe/Madrid) ni la red — así se pueden testear sin mocks.
'use strict';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Años que se prueban buscando "la siguiente aparición del mismo mes/día ≥
// hoy" (nextOccurrence, ver normalizeStayDates — es solo una pista para el
// modelo, nunca se usa para llamar a Cloudbeds). Un checkin pasado puede
// venir de hace varios años (fecha inventada, no solo un año mal calculado),
// así que se prueba un margen generoso en vez de solo 1-2 años.
const MAX_YEAR_ATTEMPTS = 8;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Valida formato YYYY-MM-DD Y que sea una fecha de calendario real (rechaza
// 2026-02-30 o 2026-13-01: `new Date(...)` los "normalizaría" sin avisar,
// justo el tipo de fallo silencioso que esta guarda quiere evitar).
function parseISODate(str) {
  if (typeof str !== 'string') return null;
  const m = ISO_RE.exec(str);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  return { year, month, day };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toISO({ year, month, day }) { return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`; }

// Mismo mes/día que `parts` pero en `year`. El 29 de febrero pasa al 28 si
// `year` no es bisiesto (ese año el 29 de febrero no existe).
function sameMonthDayInYear(parts, year) {
  const day = (parts.month === 2 && parts.day === 29 && !isLeapYear(year)) ? 28 : parts.day;
  return toISO({ year, month: parts.month, day });
}

// Siguiente fecha ≥ todayISO con el mismo mes/día que `parts`, o null si no
// se encuentra en MAX_YEAR_ATTEMPTS años (no debería pasar con una fecha
// real de una llamada).
function nextOccurrenceOnOrAfter(parts, todayISO) {
  for (let attempt = 1; attempt <= MAX_YEAR_ATTEMPTS; attempt++) {
    const candidate = sameMonthDayInYear(parts, parts.year + attempt);
    if (candidate >= todayISO) return candidate;
  }
  return null;
}

const SPOKEN_DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SPOKEN_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "<día de la semana> <día> de <mes>", con " de <año>" si withYear:true.
// `iso` debe ser ya válido (formato + calendario) — se usa solo sobre
// fechas que este mismo módulo ha validado o generado.
function spokenDate(iso, { withYear = false } = {}) {
  const p = parseISODate(iso);
  const utcDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const base = `${SPOKEN_DIAS[utcDate.getUTCDay()]} ${p.day} de ${SPOKEN_MESES[p.month - 1]}`;
  return withYear ? `${base} de ${p.year}` : base;
}

// Calendario de hoy a +`days` días, una línea por día, mismo formato de
// entrada que /vapi/get-current-date ("<día semana> <día> de <mes> = ISO
// (etiqueta)"). Construido aparte (no reutiliza esa ruta) para no arriesgar
// el texto que devuelve get_current_date hoy, que no se toca.
function buildForwardCalendar(todayISO, days) {
  const p = parseISODate(todayISO);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const lines = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = toISO({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    const label = i === 0 ? 'hoy' : i === 1 ? 'mañana' : i === 2 ? 'pasado mañana' : `en ${i} días`;
    lines.push(`${SPOKEN_DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${SPOKEN_MESES[d.getUTCMonth()]} = ${iso} (${label})`);
  }
  return lines.join(', ');
}

/**
 * Normaliza checkin/checkout antes de consultar disponibilidad.
 *
 * @param {string} checkin   'YYYY-MM-DD' tal y como lo mandó la tool.
 * @param {string} checkout  'YYYY-MM-DD' tal y como lo mandó la tool.
 * @param {string} todayISO  'YYYY-MM-DD' de hoy en Europe/Madrid — lo calcula
 *                            quien llama (esta función no toca el reloj).
 * @returns {{ok:boolean, checkin?:string, checkout?:string, reason?:string, nextOccurrence?:string|null}}
 *   - formato inválido (fecha ausente, con patrón distinto de YYYY-MM-DD, o
 *     que no existe en el calendario) → { ok:false, reason:'formato' }
 *   - checkin >= hoy → válido, sin tocar: { ok:true, checkin, checkout }
 *   - checkin < hoy (CUALQUIER fecha pasada, sin excepción) → NO se corrige:
 *     { ok:false, reason:'pasada', nextOccurrence } — nextOccurrence es la
 *     siguiente vez que cae ese mismo mes/día (o null si no se encontró),
 *     solo como pista para que el modelo recalcule; nunca se usa para
 *     llamar a Cloudbeds.
 */
function normalizeStayDates(checkin, checkout, todayISO) {
  const inP = parseISODate(checkin);
  const outP = parseISODate(checkout);
  const todayP = parseISODate(todayISO);
  if (!inP || !outP || !todayP) {
    return { ok: false, reason: 'formato' };
  }

  // Hoy es un checkin válido (la regla de las 22:30 se aplica después, sobre
  // las fechas ya normalizadas) — igual que cualquier fecha futura.
  if (checkin >= todayISO) {
    return { ok: true, checkin, checkout };
  }

  return { ok: false, reason: 'pasada', nextOccurrence: nextOccurrenceOnOrAfter(inP, todayISO) };
}

module.exports = { normalizeStayDates, spokenDate, buildForwardCalendar };
