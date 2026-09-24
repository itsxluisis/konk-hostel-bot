// src/guest-lookup.js
// V2a (24-sep-2026, docs/plan-mejora-voz-sep-2026.md): reconoce a quien llama
// por el teléfono con el que llama, cruzándolo contra las llegadas de
// hoy/mañana y los huéspedes alojados hoy en Cloudbeds. SOLO sirve para
// personalizar la atención (get_current_date) y para avisar mejor al equipo
// (report_incident) — no sustituye a Vikey, no usa su API, y no abre ningún
// canal de contacto nuevo.
//
// Cualquier fallo de Cloudbeds (red, auth, timeout, success:false, forma
// inesperada) se traga aquí: se loguea y se devuelve null. Las tools que
// llaman a este módulo nunca deben romperse por esto (ver server.js).
'use strict';

const { api } = require('./cloudbeds');

// ─── Normalización y comparación de teléfonos ─────────────────────────────
// Reglas (orden fijado por el plan): 1) quita espacios/guiones/paréntesis/
// puntos; 2) '00' inicial → '+'; 3) 9 dígitos españoles que empiezan por
// 6/7/8/9, sin prefijo → '+34' delante. Números de otros países (+351, +44…)
// se dejan tal cual tras el paso 1.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^[6789]\d{8}$/.test(s)) s = '+34' + s;
  return s;
}

function digitsOnly(s) {
  return (s || '').replace(/\D/g, '');
}

// Dígitos antes de los últimos 9 ("código de país"), solo si el número
// normalizado empieza por '+' y tiene más de 9 dígitos en total. Si no hay
// info de país en alguno de los dos lados, la comparación de prefijo se
// omite (no es un veto, es una comprobación EXTRA cuando ambos lo traen).
function countryPrefixOf(normalized) {
  if (!normalized || normalized[0] !== '+') return null;
  const digits = digitsOnly(normalized);
  if (digits.length <= 9) return null;
  return digits.slice(0, digits.length - 9);
}

// Compara dos teléfonos (en cualquier formato de entrada) por los últimos 9
// dígitos y, si ambos traen prefijo de país reconocible, también por ese
// prefijo — evita cruzar dos números de países distintos que compartan por
// casualidad los mismos 9 dígitos finales.
function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  const da = digitsOnly(na);
  const db = digitsOnly(nb);
  if (da.length < 9 || db.length < 9) return false;
  if (da.slice(-9) !== db.slice(-9)) return false;
  const pa = countryPrefixOf(na);
  const pb = countryPrefixOf(nb);
  if (pa && pb && pa !== pb) return false;
  return true;
}

// ─── Fechas (puro: recibe todayISO ya calculado, no toca el reloj) ────────
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Contadores para /health (solo números y fecha — nunca datos de huésped) ─
const counters = { matches: 0, misses: 0, errors: 0, lastAt: null };

function healthSnapshot() {
  return { matches: counters.matches, misses: counters.misses, errors: counters.errors, lastAt: counters.lastAt };
}

// ─── Caché en memoria de 3 minutos para el listado de candidatas ──────────
// Una misma llamada puede disparar dos tool calls (get_current_date y luego
// report_incident): sin caché, cada una repagina Cloudbeds entero. La clave
// incluye todayISO para no servir datos de otro día si el proceso lleva
// varios días arriba.
const CACHE_TTL_MS = 3 * 60 * 1000;
let cache = { key: null, at: 0, reservations: null };

async function fetchAllPages(params) {
  const out = [];
  const pageSize = 100;
  // Guarda-raíl: un hostel pequeño nunca tiene cientos de páginas de
  // llegadas/alojados de un solo día; evita un bucle infinito si Cloudbeds
  // devolviera siempre página llena.
  for (let page = 1; page <= 50; page++) {
    const r = await api('GET', '/getReservations', {
      ...params,
      includeGuestsDetails: true,
      pageNumber: page,
      pageSize,
    });
    if (r && r.success === false) {
      throw new Error(`getReservations success:false — ${r.message || 'sin detalle'}`);
    }
    const data = r && Array.isArray(r.data) ? r.data : [];
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

// El filtro de fechas de Cloudbeds no es de fiar (docs/encargado.md, "F1 no
// se fía del filtro de fechas": checkOutFrom/checkOutTo devuelven reservas
// que no lo cumplen). Los parámetros de abajo solo acotan la primera pasada
// para no traer toda la base; la verdad siempre se recalcula aquí con
// startDate/endDate tal y como los devuelve Cloudbeds.
async function fetchCandidates(todayISO, tomorrowISO) {
  const cacheKey = `${todayISO}|${tomorrowISO}`;
  const now = Date.now();
  if (cache.key === cacheKey && (now - cache.at) < CACHE_TTL_MS) {
    return cache.reservations;
  }

  const [arrivalsRaw, inHouseRaw] = await Promise.all([
    fetchAllPages({ checkInFrom: todayISO, checkInTo: tomorrowISO }),
    fetchAllPages({ checkInTo: todayISO, checkOutFrom: todayISO }),
  ]);

  const arrivals = arrivalsRaw.filter(r => r.startDate === todayISO || r.startDate === tomorrowISO);
  const inHouse = inHouseRaw.filter(r => r.startDate <= todayISO && r.endDate > todayISO);

  const byId = new Map();
  for (const r of [...arrivals, ...inHouse]) {
    if (r && r.reservationID != null && !byId.has(r.reservationID)) byId.set(r.reservationID, r);
  }
  // Sin canceladas ni no-show (mismos valores de status que ya usa src/vigilante.js).
  const reservations = Array.from(byId.values())
    .filter(r => !['canceled', 'no_show'].includes(r.status));

  cache = { key: cacheKey, at: now, reservations };
  return reservations;
}

// ─── Extracción de campos de una reserva ──────────────────────────────────
function guestListOf(r) {
  return Array.isArray(r.guestList) ? r.guestList : [];
}

// Cloudbeds no documenta de forma estable un único nombre de campo para el
// teléfono; con includeGuestsDetails=true los datos de cada huésped viven en
// guestList[]. Se prueban las variantes vistas en su API pública, tanto a
// nivel de reserva como de cada huésped de la lista — si ninguna existe,
// simplemente no hay teléfono con el que comparar (no es un error).
const PHONE_KEYS = ['guestPhone', 'guestCellPhone', 'phone', 'cellPhone'];
function reservationPhones(r) {
  const phones = [];
  for (const key of PHONE_KEYS) if (r[key]) phones.push(r[key]);
  for (const g of guestListOf(r)) {
    for (const key of PHONE_KEYS) if (g[key]) phones.push(g[key]);
  }
  return phones;
}

function firstNameOf(r) {
  if (r.guestFirstName) return r.guestFirstName;
  const g = guestListOf(r)[0];
  if (g && g.guestFirstName) return g.guestFirstName;
  const full = r.guestName || '';
  return full.split(' ')[0] || null;
}

function fullNameOf(r) {
  if (r.guestName) return r.guestName;
  const combo = `${r.guestFirstName || ''} ${r.guestLastName || ''}`.trim();
  if (combo) return combo;
  const g = guestListOf(r)[0];
  if (g) {
    const gCombo = `${g.guestFirstName || ''} ${g.guestLastName || ''}`.trim();
    if (gCombo) return gCombo;
  }
  return null;
}

// Habitación(es) asignadas, si Cloudbeds las da. Puede venir un array
// `rooms` (varias habitaciones/camas) o, como ya asume getReservationsByDate
// en src/cloudbeds.js, solo roomID/roomNumber sueltos. Si no hay ninguno de
// los dos, null — nunca se inventa una habitación.
function roomsOf(r) {
  if (Array.isArray(r.rooms) && r.rooms.length) {
    const names = r.rooms
      .map(x => x && (x.roomName || x.roomTypeName || x.roomID || x.roomNumber))
      .filter(Boolean)
      .map(String);
    if (names.length) return names;
  }
  const single = r.roomID || r.roomNumber;
  return single ? [String(single)] : null;
}

// Prioridad al desempatar varias coincidencias: llega hoy > ya alojado >
// llega mañana (el único otro caso posible dado lo que se pide a Cloudbeds).
function rankOf(r, todayISO) {
  if (r.startDate === todayISO) return 0;
  if (r.startDate < todayISO && r.endDate > todayISO) return 1;
  return 2;
}

function toStay(r) {
  const adults = Number(r.adults);
  const children = Number(r.children);
  return {
    firstName: firstNameOf(r),
    fullName: fullNameOf(r),
    reservationId: r.reservationID != null ? String(r.reservationID) : null,
    checkin: r.startDate || null,
    checkout: r.endDate || null,
    rooms: roomsOf(r),
    channel: r.sourceName || null,
    status: r.status || null,
    guests: adults > 0 ? adults + (children > 0 ? children : 0) : null,
  };
}

/**
 * Busca la estancia (llegada hoy/mañana o alojado hoy) cuyo teléfono
 * coincide con `phone`. Nunca lanza: cualquier fallo de Cloudbeds se
 * loguea en consola y devuelve null, sin avisar a Telegram, para no romper
 * la tool de Vapi que la llama (ver docs/plan-mejora-voz-sep-2026.md, V2a).
 *
 * @param {string} phone     Teléfono de quien llama, tal cual lo manda Vapi.
 * @param {string} todayISO  'YYYY-MM-DD' de hoy en Europe/Madrid.
 * @returns {Promise<object|null>}
 */
async function findStayByPhone(phone, todayISO) {
  if (!phone || typeof todayISO !== 'string') return null;
  const normalizedCaller = normalizePhone(phone);
  if (!normalizedCaller) return null;

  try {
    const tomorrowISO = addDaysISO(todayISO, 1);
    const candidates = await fetchCandidates(todayISO, tomorrowISO);

    const matches = candidates.filter(r =>
      reservationPhones(r).some(p => phonesMatch(p, normalizedCaller))
    );

    counters.lastAt = new Date().toISOString();
    if (!matches.length) {
      counters.misses++;
      return null;
    }
    counters.matches++;
    if (matches.length > 1) {
      console.log(`[guest-lookup] ${matches.length} coincidencias para el mismo teléfono — prioridad llega-hoy > alojado > llega-mañana`);
    }
    matches.sort((a, b) => rankOf(a, todayISO) - rankOf(b, todayISO));
    return toStay(matches[0]);
  } catch (err) {
    counters.errors++;
    counters.lastAt = new Date().toISOString();
    console.error('[guest-lookup] Error consultando Cloudbeds:', err.message);
    return null;
  }
}

module.exports = { findStayByPhone, normalizePhone, phonesMatch, healthSnapshot };
