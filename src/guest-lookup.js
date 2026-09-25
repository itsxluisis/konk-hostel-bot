// src/guest-lookup.js
// V2a (24-sep-2026, docs/plan-mejora-voz-sep-2026.md): reconoce a quien llama
// por el teléfono con el que llama, cruzándolo contra las llegadas de
// hoy/mañana y los huéspedes alojados hoy en Cloudbeds. SOLO sirve para
// personalizar la atención (get_current_date) y para avisar mejor al equipo
// (report_incident) — no sustituye a Vikey, no usa su API, y no abre ningún
// canal de contacto nuevo.
//
// Cualquier fallo de Cloudbeds (red, auth, timeout, success:false, forma
// inesperada) se traga aquí: se loguea y se devuelve null/[]. Las tools que
// llaman a este módulo nunca deben romperse por esto (ver server.js).
//
// Corrección de NEXO (auditor, 24-sep-2026): si el teléfono coincide con
// varias reservas del MISMO rango (empate real, p. ej. dos llegadas de
// hoy), findStayByPhone() devuelve null (ambigüedad = no revelar nada) y
// findStaysByPhone() (nueva, usada por report_incident) lista TODAS las
// empatadas, como mucho 3, en orden determinista (fecha de entrada, luego
// id de reserva) — nunca según el orden de respuesta de Cloudbeds. El tope
// de 2,5s frente a Cloudbeds (Promise.race) vive en server.js, en ambas
// tools; findStaysByPhone/findStayByPhone en sí no tienen temporizador
// propio.
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
// nameMatches (28-sep-2026, dato de Luis): desde esa fecha Booking deja de
// mandar el teléfono del huésped y es el 72-83 % de las reservas del Konk
// — cuenta cuántas veces report_incident encontró la reserva por NOMBRE en
// vez de por teléfono (ver resolveIncidentStay/resolveNameMatches).
const counters = { matches: 0, misses: 0, errors: 0, nameMatches: 0, lastAt: null };

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
    nameMatches: counters.nameMatches,
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
// V2a corrección NEXO (auditor, 24-sep-2026): promesa en vuelo compartida —
// mismo patrón que refreshPromise en getToken() de src/cloudbeds.js. Si dos
// llamadas coinciden con la caché fría o recién vencida para el MISMO
// todayISO (p. ej. get_current_date y report_incident casi a la vez), la
// segunda espera a la primera en vez de repaginar Cloudbeds por su cuenta.
let inFlight = null; // { key, promise } | null

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
  if (inFlight && inFlight.key === cacheKey) {
    return inFlight.promise;
  }

  const promise = (async () => {
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
    // nombres ni teléfonos — para poder comprobar en /health, contra
    // Cloudbeds de verdad, que guestPhone/rooms realmente llegan (ver
    // healthSnapshot()).
    scan = {
      at: new Date().toISOString(),
      reservations: reservations.length,
      withPhone: reservations.filter(r => reservationPhones(r).length > 0).length,
      withRoom: reservations.filter(r => { const rm = roomsOf(r); return !!(rm && rm.length); }).length,
    };

    return reservations;
  })();

  inFlight = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    // Solo se borra si sigue siendo LA MISMA promesa (por si, entre medias,
    // otra llamada ya la sustituyó — no debería pasar con esta clave, pero
    // es la misma cautela que usa refreshPromise en cloudbeds.js).
    if (inFlight && inFlight.promise === promise) inFlight = null;
  }
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

// Orden determinista para desempatar varias reservas en el MISMO rango
// (mismo nivel de prioridad: p. ej. dos que llegan hoy) — corrección de
// NEXO (auditor, 24-sep-2026): antes el orden dependía de en qué orden
// respondía Cloudbeds (inserción en el Map de fetchCandidates), no
// determinista. Por fecha de entrada y, si coincide, por id de reserva
// (como texto, orden estable y reproducible).
function compareForOrder(a, b) {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  const idA = String(a.reservationID ?? '');
  const idB = String(b.reservationID ?? '');
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

// Tope de reservas empatadas que se listan a report_incident — un aviso con
// una lista larga deja de ser legible para el equipo.
const MAX_TIE_CANDIDATES = 3;

/**
 * Núcleo compartido de la búsqueda: candidatas cuyo teléfono coincide,
 * recortadas al RANGO GANADOR (rankOf más bajo: llega-hoy > alojado >
 * llega-mañana) y ordenadas de forma determinista (compareForOrder) — nunca
 * por el orden en que respondió Cloudbeds. Nunca lanza: cualquier fallo de
 * Cloudbeds se loguea, cuenta en errors, y se trata como "sin candidatas".
 * Actualiza los contadores de /health UNA vez por llamada (independiente de
 * si el resultado acaba siendo ambiguo o no: "matches" cuenta que SÍ se
 * encontró alguna reserva para ese teléfono).
 *
 * @returns {Promise<Array>} reservas crudas de Cloudbeds del rango ganador
 *   (0, 1 o varias si hay empate), NUNCA más de las que de verdad empatan.
 */
async function resolveWinningMatches(phone, todayISO) {
  if (!phone || typeof todayISO !== 'string') return [];
  const normalizedCaller = normalizePhone(phone);
  if (!normalizedCaller) return [];

  try {
    const tomorrowISO = addDaysISO(todayISO, 1);
    const candidates = await fetchCandidates(todayISO, tomorrowISO);

    const matches = candidates.filter(r =>
      reservationPhones(r).some(p => phonesMatch(p, normalizedCaller))
    );

    counters.lastAt = new Date().toISOString();
    if (!matches.length) {
      counters.misses++;
      return [];
    }
    counters.matches++;

    const bestRank = matches.reduce((min, r) => Math.min(min, rankOf(r, todayISO)), Infinity);
    const winning = matches
      .filter(r => rankOf(r, todayISO) === bestRank)
      .sort(compareForOrder);

    if (winning.length > 1) {
      console.log(`[guest-lookup] ${winning.length} coincidencias EMPATADAS en el mismo rango para el mismo teléfono (orden determinista por entrada/id)`);
    }
    return winning;
  } catch (err) {
    counters.errors++;
    counters.lastAt = new Date().toISOString();
    console.error('[guest-lookup] Error consultando Cloudbeds:', err.message);
    return [];
  }
}

/**
 * Busca la estancia (llegada hoy/mañana o alojado hoy) cuyo teléfono
 * coincide con `phone`. Nunca lanza: cualquier fallo de Cloudbeds se
 * loguea en consola y devuelve null, sin avisar a Telegram, para no romper
 * la tool de Vapi que la llama (ver docs/plan-mejora-voz-sep-2026.md, V2a).
 *
 * Corrección de NEXO (auditor, 24-sep-2026): si el teléfono coincide con
 * MÁS DE UNA reserva del mismo rango (empate real, p. ej. dos llegadas de
 * hoy), devuelve null a propósito — la ambigüedad no se resuelve inventando
 * un orden, se trata como "no se puede revelar de forma segura" (para eso
 * está findStaysByPhone, que sí lista todas las empatadas).
 *
 * @param {string} phone     Teléfono de quien llama, tal cual lo manda Vapi.
 * @param {string} todayISO  'YYYY-MM-DD' de hoy en Europe/Madrid.
 * @returns {Promise<object|null>}
 */
async function findStayByPhone(phone, todayISO) {
  const winning = await resolveWinningMatches(phone, todayISO);
  if (winning.length !== 1) return null;
  return toStay(winning[0]);
}

/**
 * Como findStayByPhone, pero pensada para report_incident: en vez de exigir
 * una única reserva inequívoca, devuelve TODAS las del rango ganador
 * (incluido el empate), como mucho `max` (por defecto MAX_TIE_CANDIDATES),
 * en el mismo orden determinista. Array vacío si no hay ninguna coincidencia
 * o si Cloudbeds falla (nunca lanza).
 *
 * @param {string} phone
 * @param {string} todayISO
 * @param {{max?: number}} [opts]
 * @returns {Promise<Array<object>>}
 */
async function findStaysByPhone(phone, todayISO, { max = MAX_TIE_CANDIDATES } = {}) {
  const winning = await resolveWinningMatches(phone, todayISO);
  return winning.slice(0, max).map(toStay);
}

// ─── Búsqueda por nombre (28-sep-2026: Booking deja de mandar el teléfono) ─
// Dato de Luis: desde el 28-sep-2026 Booking (72-83 % de las reservas del
// Konk) deja de enviar el teléfono del huésped en la llamada — la
// coincidencia por teléfono fallará casi siempre a partir de esa fecha.
// report_incident (NUNCA get_current_date: al empezar la llamada aún no se
// ha pedido el nombre) intenta entonces por NOMBRE (args.guest_name, que el
// bot ya pregunta antes de llamar a la tool) entre las MISMAS candidatas
// (mismo fetchCandidates, mismo caché — sin repaginar Cloudbeds aparte).
const NAME_TOKEN_MIN_LEN = 3;

// minúsculas, sin tildes/diacríticos, sin signos — solo letras/dígitos y
// espacios; NFD + quitar marcas combinantes es el método estándar en JS
// para quitar acentos sin tabla propia.
function normalizeNameForMatch(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(s) {
  const n = normalizeNameForMatch(s);
  return n ? n.split(' ') : [];
}

// Todos los tokens de nombre de una reserva: guestName de la reserva +
// guestFirstName/guestLastName/guestName de TODOS los huéspedes de
// guestList (sea o no isMainGuest — cualquiera de ellos identifica la
// reserva igual de bien a efectos de nombre).
function reservationNameTokens(r) {
  const tokens = new Set();
  const addAll = (s) => tokensOf(s).forEach(t => tokens.add(t));
  addAll(r.guestName);
  for (const g of guestListOf(r)) {
    addAll(g.guestFirstName);
    addAll(g.guestLastName);
    addAll(g.guestName);
  }
  return tokens;
}

// Exige al menos un token de 3+ letras del nombre de quien llama que
// coincida con algún token de la reserva y, si el nombre de quien llama
// trae más de un token significativo (se asume: primero = nombre de pila,
// resto = apellido/s), que al menos uno de esos tokens "de apellido"
// coincida también — un solo nombre de pila suelto (sin apellido) NO basta
// por sí solo si el que llama SÍ dio apellido y ese apellido no aparece.
function callerNameMatches(callerTokens, reservationTokens) {
  const significant = callerTokens.filter(t => t.length >= NAME_TOKEN_MIN_LEN);
  if (!significant.length) return false;
  if (!significant.some(t => reservationTokens.has(t))) return false;
  const apellidoTokens = significant.slice(1);
  if (apellidoTokens.length && !apellidoTokens.some(t => reservationTokens.has(t))) return false;
  return true;
}

// Candidatas (incluye TODOS los rangos: llega hoy/mañana y alojados — a
// diferencia de resolveWinningMatches, aquí no se recorta a un solo rango
// "ganador": el nombre no tiene ese concepto de prioridad por fecha) cuyo
// nombre coincide con `guestName`. Orden determinista (mismo criterio que
// las coincidencias por teléfono). Nunca lanza: cualquier fallo de
// Cloudbeds se loguea y se trata como "sin candidatas".
async function resolveNameMatches(guestName, todayISO) {
  if (!guestName || typeof guestName !== 'string' || typeof todayISO !== 'string') return [];
  const callerTokens = tokensOf(guestName);
  if (!callerTokens.some(t => t.length >= NAME_TOKEN_MIN_LEN)) return [];

  try {
    const tomorrowISO = addDaysISO(todayISO, 1);
    const candidates = await fetchCandidates(todayISO, tomorrowISO);
    return candidates
      .filter(r => callerNameMatches(callerTokens, reservationNameTokens(r)))
      .sort(compareForOrder);
  } catch (err) {
    counters.errors++;
    counters.lastAt = new Date().toISOString();
    console.error('[guest-lookup] Error consultando Cloudbeds (búsqueda por nombre):', err.message);
    return [];
  }
}

/**
 * Resolución completa para report_incident: primero por teléfono (igual
 * que findStayByPhone/findStaysByPhone); SOLO si no hay teléfono o el
 * teléfono no encuentra NINGUNA reserva, intenta por nombre entre las
 * mismas candidatas. Nunca lanza. El tope de 2,5s frente a Cloudbeds
 * (withGuestLookupTimeout en server.js) envuelve esta función ENTERA — el
 * intento por nombre nunca añade un segundo plazo de 2,5s, comparte el
 * mismo (en la práctica, al reutilizar la caché de fetchCandidates, el
 * intento por nombre no vuelve a tocar la red salvo que el intento por
 * teléfono ya hubiera fallado).
 *
 * @param {string} phone
 * @param {string} guestName  args.guest_name tal cual lo manda la tool (sin
 *   el "no indicado" por defecto que pone server.js para el aviso).
 * @param {string} todayISO
 * @returns {Promise<{source: 'phone'|'name'|'none', stay: object|null, tied: object[]}>}
 *   `stay` solo si hay EXACTAMENTE una reserva definitiva (por teléfono o
 *   por nombre); `tied` con 2 o más candidatas ambiguas (máx.
 *   MAX_TIE_CANDIDATES), sea por empate de teléfono o por nombre ambiguo.
 */
async function resolveIncidentStay(phone, guestName, todayISO) {
  const phoneWinning = await resolveWinningMatches(phone, todayISO);
  if (phoneWinning.length === 1) {
    return { source: 'phone', stay: toStay(phoneWinning[0]), tied: [] };
  }
  if (phoneWinning.length > 1) {
    return { source: 'phone', stay: null, tied: phoneWinning.slice(0, MAX_TIE_CANDIDATES).map(toStay) };
  }

  // phoneWinning.length === 0: sin teléfono, o teléfono sin ninguna
  // coincidencia — se intenta por nombre.
  const nameMatches = await resolveNameMatches(guestName, todayISO);
  if (nameMatches.length === 1) {
    counters.nameMatches++;
    counters.lastAt = new Date().toISOString();
    return { source: 'name', stay: toStay(nameMatches[0]), tied: [] };
  }
  if (nameMatches.length > 1) {
    return { source: 'name', stay: null, tied: nameMatches.slice(0, MAX_TIE_CANDIDATES).map(toStay) };
  }
  return { source: 'none', stay: null, tied: [] };
}

module.exports = {
  findStayByPhone, findStaysByPhone, resolveIncidentStay,
  normalizePhone, phonesMatch, healthSnapshot, warmCache,
};
