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
//
// Corrección del auditor (28-sep-2026, segunda vuelta): el primer diseño
// comparaba "cualquier token significativo" contra un totum revolutum de
// tokens de la reserva, sin exigir nunca que el NOMBRE DE PILA coincidiera
// — "Carlos del Bosque" colaba como coincidencia de la reserva "Ana del
// Valle" (solo comparten la partícula "del") y "Pedro Gil Ruiz" con "Marta
// Gil Soto" (solo comparten "Gil", un apellido cualquiera). Rediseño: el
// nombre de pila (primer token significativo de quien llama) tiene que
// coincidir SIEMPRE con el nombre de pila de un huésped concreto; solo
// entonces, si quien llama dio apellido, se comprueba el apellido de ESE
// MISMO huésped. Nunca basta con una palabra suelta compartida, sea cual
// sea, ni con coincidir solo por apellido.
const NAME_TOKEN_MIN_LEN = 2;

// Partículas de nombres/apellidos compuestos: por sí solas no identifican a
// nadie (medio mundo comparte "del"/"de"/"la" en un apellido compuesto).
const NAME_PARTICLES = new Set([
  'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e',
  'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'san', 'santa',
]);

// Tokens "significativos" de un nombre: minúsculas, sin tildes/diacríticos
// (NFD + quitar marcas combinantes, método estándar en JS sin tabla
// propia). Se descarta CUALQUIER trozo que en el original llevara un punto
// (inicial tipo "A." o "Ma." — una abreviatura no identifica a nadie por sí
// sola, tenga la longitud que tenga tras quitarle el punto), cualquier
// signo suelto, los tokens de menos de NAME_TOKEN_MIN_LEN letras, y las
// partículas de NAME_PARTICLES.
function significantNameTokens(s) {
  if (typeof s !== 'string') return [];
  const lower = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return lower
    .split(/\s+/)
    .filter(Boolean)
    .filter(piece => !piece.includes('.')) // inicial con punto ("A.", "Ma."): fuera, sea cual sea su longitud
    .map(piece => piece.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= NAME_TOKEN_MIN_LEN)
    .filter(t => !NAME_PARTICLES.has(t));
}

// Nombre de pila (primer token significativo) de un huésped/pseudo-huésped:
// guestFirstName si lo trae, si no el primer token significativo de
// guestName.
function firstNameTokenOf(g) {
  if (g.guestFirstName) {
    const t = significantNameTokens(g.guestFirstName);
    if (t.length) return t[0];
  }
  if (g.guestName) {
    const t = significantNameTokens(g.guestName);
    if (t.length) return t[0];
  }
  return null;
}

// Tokens de apellido de un huésped/pseudo-huésped: guestLastName si lo
// trae, si no el resto de tokens significativos de guestName (todos menos
// el primero, que ya se cuenta como nombre de pila).
function lastNameTokensOf(g) {
  if (g.guestLastName) return significantNameTokens(g.guestLastName);
  if (g.guestName) return significantNameTokens(g.guestName).slice(1);
  return [];
}

// Todos los "huéspedes" a comprobar de una reserva: cada huésped real de
// guestList (sea o no isMainGuest) MÁS un pseudo-huésped a partir del
// guestName de la RESERVA (si lo trae) — el guestName de la reserva no
// siempre coincide exactamente con ningún huésped de guestList.
function nameCandidatesOf(r) {
  const list = guestListOf(r).slice();
  if (r.guestName) list.push({ guestFirstName: null, guestLastName: null, guestName: r.guestName });
  return list;
}

// 'strong': el nombre de pila de quien llama coincide con el de algún
// huésped Y (si quien llama dio apellido) al menos un apellido dado
// coincide con el apellido de ESE MISMO huésped. 'weak': quien llama SOLO
// dio nombre de pila (sin apellido que comprobar) y coincide con el nombre
// de pila de algún huésped. null si ninguno. El nombre de pila es SIEMPRE
// obligatorio: nunca se compara solo por apellido.
function reservationMatchKind(r, callerFirst, callerLastTokens, hasSurname) {
  for (const g of nameCandidatesOf(r)) {
    const gFirst = firstNameTokenOf(g);
    if (!gFirst || gFirst !== callerFirst) continue;
    if (!hasSurname) return 'weak';
    const gLast = lastNameTokensOf(g);
    if (callerLastTokens.some(t => gLast.includes(t))) return 'strong';
  }
  return null;
}

// Candidatas (incluye TODOS los rangos: llega hoy/mañana y alojados — a
// diferencia de resolveWinningMatches, aquí no se recorta a un solo rango
// "ganador": el nombre no tiene ese concepto de prioridad por fecha) cuyo
// nombre coincide con `guestName`, separadas en fuertes (nombre + apellido)
// y débiles (solo nombre de pila, porque quien llama no dio apellido).
// Orden determinista (mismo criterio que las coincidencias por teléfono).
// Nunca lanza: cualquier fallo de Cloudbeds se loguea y se trata como "sin
// candidatas".
async function resolveNameMatches(guestName, todayISO) {
  if (!guestName || typeof guestName !== 'string' || typeof todayISO !== 'string') {
    return { strong: [], weak: [] };
  }
  const callerTokens = significantNameTokens(guestName);
  if (!callerTokens.length) return { strong: [], weak: [] };
  const callerFirst = callerTokens[0];
  const callerLastTokens = callerTokens.slice(1);
  const hasSurname = callerLastTokens.length > 0;

  try {
    const tomorrowISO = addDaysISO(todayISO, 1);
    const candidates = await fetchCandidates(todayISO, tomorrowISO);
    const strong = [];
    const weak = [];
    for (const r of candidates) {
      const kind = reservationMatchKind(r, callerFirst, callerLastTokens, hasSurname);
      if (kind === 'strong') strong.push(r);
      else if (kind === 'weak') weak.push(r);
    }
    strong.sort(compareForOrder);
    weak.sort(compareForOrder);
    return { strong, weak };
  } catch (err) {
    counters.errors++;
    counters.lastAt = new Date().toISOString();
    console.error('[guest-lookup] Error consultando Cloudbeds (búsqueda por nombre):', err.message);
    return { strong: [], weak: [] };
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
 * Dos niveles de confianza por nombre (corrección del auditor, 28-sep-2026
 * segunda vuelta):
 *  - 'name-strong': nombre de pila Y apellido coinciden con el mismo
 *    huésped. Única → se usa y SÍ cuenta para la urgencia. Varias → "varias
 *    posibles" (hasta MAX_TIE_CANDIDATES), sin urgencia.
 *  - 'name-weak': quien llama solo dio el nombre de pila (sin apellido) y
 *    coincide con el de un único huésped. Se usa, pero NUNCA cuenta para
 *    la urgencia (evidencia demasiado débil). Si coincide con más de un
 *    huésped, es demasiado débil incluso para listar "varias posibles": se
 *    trata como si no hubiera ninguna coincidencia.
 *
 * @param {string} phone
 * @param {string} guestName  args.guest_name tal cual lo manda la tool (sin
 *   el "no indicado" por defecto que pone server.js para el aviso).
 * @param {string} todayISO
 * @returns {Promise<{source:'phone'|'name-strong'|'name-weak'|'none', stay:object|null, tied:object[]}>}
 *   `stay` solo si hay EXACTAMENTE una reserva definitiva; `tied` con 2 o
 *   más candidatas ambiguas (máx. MAX_TIE_CANDIDATES), sea por empate de
 *   teléfono o por nombre fuerte ambiguo (el débil ambiguo no se lista).
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
  const { strong, weak } = await resolveNameMatches(guestName, todayISO);
  if (strong.length === 1) {
    counters.nameMatches++;
    counters.lastAt = new Date().toISOString();
    return { source: 'name-strong', stay: toStay(strong[0]), tied: [] };
  }
  if (strong.length > 1) {
    return { source: 'name-strong', stay: null, tied: strong.slice(0, MAX_TIE_CANDIDATES).map(toStay) };
  }
  if (weak.length === 1) {
    counters.nameMatches++;
    counters.lastAt = new Date().toISOString();
    return { source: 'name-weak', stay: toStay(weak[0]), tied: [] };
  }
  // weak.length === 0 (nada) o > 1 (ambiguo Y débil: demasiado poco fiable
  // para listar "varias posibles" — se trata como sin coincidencia).
  return { source: 'none', stay: null, tied: [] };
}

module.exports = {
  findStayByPhone, findStaysByPhone, resolveIncidentStay,
  normalizePhone, phonesMatch, healthSnapshot, warmCache,
};
