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

// V2a corrección NEXO (24-sep-2026): recuento de la última carga REAL de
// candidatas (no de cada findStayByPhone, que puede servir desde caché) —
// permite comprobar contra Cloudbeds de verdad, SIN exponer a nadie ningún
// nombre ni teléfono, que guestPhone/rooms[] están llegando de verdad. null
// hasta que se haga la primera carga (arranque o primera búsqueda real).
let scan = null;

function healthSnapshot() {
  return {
    matches: counters.matches,
    misses: counters.misses,
    errors: counters.errors,
    lastAt: counters.lastAt,
    scan: scan ? { ...scan } : null,
  };
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
      // Corrección de NEXO (24-sep-2026): el rooms[] a nivel de RESERVA solo
      // viene si se pide explícitamente includeAllRooms=true (si no, hay que
      // sacar la habitación del huésped — ver roomsOf/guestRoomLabels).
      includeAllRooms: true,
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

  // V2a corrección NEXO: recuento de esta carga real — SOLO números, nunca
  // nombres ni teléfonos — para poder comprobar en /health, contra Cloudbeds
  // de verdad, que guestPhone/rooms realmente llegan (ver healthSnapshot()).
  scan = {
    at: new Date().toISOString(),
    reservations: reservations.length,
    withPhone: reservations.filter(r => reservationPhones(r).length > 0).length,
    withRoom: reservations.filter(r => { const rm = roomsOf(r); return !!(rm && rm.length); }).length,
  };

  return reservations;
}

/**
 * Calienta la caché de candidatas al arrancar el servidor, en segundo plano.
 * No se llama desde ningún handler HTTP: solo sirve para que /health →
 * guestLookup.scan tenga datos cuanto antes tras un despliegue, sin esperar
 * a la primera llamada real. Nunca lanza ni bloquea el arranque — un fallo
 * aquí se loguea y ya está (se reintentará solo con la siguiente búsqueda
 * real, que vuelve a intentar fetchCandidates si la caché sigue vacía).
 */
async function warmCache() {
  try {
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const tomorrowISO = addDaysISO(todayISO, 1);
    await fetchCandidates(todayISO, tomorrowISO);
    console.log('[guest-lookup] Caché calentada al arrancar');
  } catch (err) {
    console.error('[guest-lookup] Calentamiento de caché al arrancar falló (no bloquea el arranque):', err.message);
  }
}

// ─── Extracción de campos de una reserva ──────────────────────────────────
// Corrección de NEXO (24-sep-2026) contra la doc oficial de Cloudbeds:
// guestList con includeGuestsDetails=true es un OBJETO indexado por guestID
// ("a map of guest IDs to guest objects"), NO un array. La versión anterior
// (`Array.isArray(r.guestList) ? r.guestList : []`) devolvía SIEMPRE []
// contra la API real → nunca encontraba un teléfono. Se admiten ambas formas
// (objeto real; array por si alguna respuesta ya lo diera así) sin romper.
function guestListOf(r) {
  if (Array.isArray(r.guestList)) return r.guestList;
  if (r.guestList && typeof r.guestList === 'object') return Object.values(r.guestList);
  return [];
}

// El huésped principal de la reserva (isMainGuest), o el primero de la
// lista si ninguno lo trae marcado — para elegir DE QUIÉN es el nombre que
// se dice/escribe, no para decidir si hay coincidencia de teléfono (eso
// mira a TODOS los huéspedes, sea principal o no: "si coincide el teléfono
// de otro huésped de la misma reserva, sigue siendo esa reserva").
function mainGuestOf(r) {
  const list = guestListOf(r);
  if (!list.length) return null;
  return list.find(g => g && g.isMainGuest) || list[0];
}

// Cloudbeds no documenta de forma estable un único nombre de campo para el
// teléfono a nivel de RESERVA (de hecho, según la doc, ahí no vienen) — se
// mantiene esa lectura por si acaso, pero la fuente real con
// includeGuestsDetails=true es guestList[].guestPhone / guestCellPhone de
// cada huésped.
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
  const g = mainGuestOf(r);
  if (g && g.guestFirstName) return g.guestFirstName;
  const full = r.guestName || (g && g.guestName) || '';
  return full.split(' ')[0] || null;
}

function fullNameOf(r) {
  if (r.guestName) return r.guestName;
  const combo = `${r.guestFirstName || ''} ${r.guestLastName || ''}`.trim();
  if (combo) return combo;
  const g = mainGuestOf(r);
  if (g) {
    if (g.guestName) return g.guestName;
    const gCombo = `${g.guestFirstName || ''} ${g.guestLastName || ''}`.trim();
    if (gCombo) return gCombo;
  }
  return null;
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

// Etiquetas de una lista de "habitaciones" (nivel reserva o el rooms[] de un
// huésped): prueba roomName/roomTypeName/roomID/roomNumber en ese orden.
function roomLabelsFromArray(arr, keys) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => x && keys.map(k => x[k]).find(Boolean))
    .filter(Boolean)
    .map(String);
}

// Las habitaciones de un huésped concreto: su propio rooms[] si lo trae
// (más granular), si no un campo suelto (roomName / assignedRoom /
// roomTypeName / roomID). `unassignedRooms` NUNCA se usa aquí a propósito:
// significa tipo de habitación pedido pero SIN habitación concreta todavía,
// justo lo contrario de "asignada".
function guestRoomLabels(g) {
  if (!g) return [];
  const fromArray = roomLabelsFromArray(g.rooms, ['roomName', 'roomTypeName', 'roomID']);
  if (fromArray.length) return fromArray;
  const single = g.roomName || g.assignedRoom || g.roomTypeName || g.roomID;
  return single ? [String(single)] : [];
}

// Habitación(es) asignadas, si Cloudbeds las da. Corrección de NEXO
// (24-sep-2026): `rooms[]` a nivel de RESERVA (roomID/roomName/roomTypeID/
// roomTypeName/subReservationID) solo llega si la consulta pide
// includeAllRooms=true (ver fetchAllPages) — es la fuente más fiable cuando
// está. Si no viene, se usan las de cada huésped de guestList (su propio
// rooms[], o si no, roomName/assignedRoom/...). Como último recurso, el
// roomID/roomNumber suelto a nivel de reserva que ya asumía
// getReservationsByDate en src/cloudbeds.js (listado simple, sin
// includeAllRooms). Si ninguno trae nada, null — nunca se inventa una
// habitación.
function roomsOf(r) {
  const reservationLevel = roomLabelsFromArray(r.rooms, ['roomName', 'roomTypeName', 'roomID', 'roomNumber']);
  if (reservationLevel.length) return dedupe(reservationLevel);

  const guestLevel = [];
  for (const g of guestListOf(r)) guestLevel.push(...guestRoomLabels(g));
  if (guestLevel.length) return dedupe(guestLevel);

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

module.exports = { findStayByPhone, normalizePhone, phonesMatch, healthSnapshot, warmCache };
