// test/vapi-guest-recognition.test.js — V2a: reconocimiento de huésped por
// teléfono en POST /vapi/get-current-date y POST /vapi/report-incident
// (docs/plan-mejora-voz-sep-2026.md). Arranca el servidor real (src/server.js)
// en un puerto fijo de pruebas y le pega peticiones HTTP de verdad con fetch,
// igual que test/get-availability-dates.test.js. axios va interceptado (mismo
// truco que el resto de tests que arrancan el servidor); el token de
// Cloudbeds se siembra en memoria con exchangeCode(), sin
// CLOUDBEDS_REFRESH_TOKEN en el entorno (así no arrancan los timers de
// auto-refresco de src/cloudbeds.js).
//
// Fixtures con la forma REAL de Cloudbeds (corrección de NEXO, 24-sep-2026):
// guestList es un OBJETO indexado por guestID (no un array) y rooms[] a
// nivel de reserva solo se simula cuando la consulta pide includeAllRooms
// (que src/guest-lookup.js ya pide siempre).
//
// allReservations se rellena ANTES de requerir src/server.js: V2a calienta
// la caché de guest-lookup en segundo plano nada más arrancar
// (guestLookup.warmCache(), disparado dentro de app.listen), así que si el
// fixture no estuviera listo todavía, ese calentamiento poblaría la caché de
// HOY con una lista vacía y los tests de más abajo (dentro de la ventana de
// 3 minutos) leerían esa caché en vez de los datos de este archivo. No se
// toca `allReservations` después de este punto salvo en el caso de timeout,
// que fuerza la expiración de la caché con Date.now (igual que
// test/guest-lookup.test.js) para garantizar una consulta fresca real.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let allReservations = [];
let extraDelayMs = 0; // solo durante los casos de timeout
let telegramCalls = [];

// Fuerza una carga fresca real desde Cloudbeds (cache-miss) en
// guest-lookup.js, incluso si un caso anterior ya dejó la caché "atascada
// en el futuro": fetchCandidates() sella cache.at con Date.now() en el
// instante en que arranca la carga, así que si esa carga arrancó con el
// reloj ya desplazado (como aquí), cache.at queda por delante del reloj
// REAL — un desplazamiento fijo pequeño en el SIGUIENTE caso (p. ej.
// siempre +3min) podría no bastar para superar esa caché ya adelantada.
// Cada llamada usa un salto 10 minutos MAYOR que el anterior, así que
// siempre gana por delante de cualquier caché atascada por un caso previo.
// Devuelve una función para restaurar Date.now — usar siempre en finally.
const realDateNow = Date.now;
let freshOffsetSteps = 0;
function forceFreshCloudbedsFetch() {
  freshOffsetSteps += 1;
  const offsetMs = freshOffsetSteps * 10 * 60 * 1000;
  Date.now = () => realDateNow() + offsetMs;
  return () => { Date.now = realDateNow; };
}

function paginateFixture(config) {
  const pageNumber = config.params.pageNumber || 1;
  const pageSize = config.params.pageSize || 100;
  const start = (pageNumber - 1) * pageSize;
  const slice = allReservations.slice(start, start + pageSize);
  return { data: { success: true, data: slice } };
}

function fakeAxios(config) {
  if (config.url.includes('getRoomTypes')) {
    return Promise.resolve({ data: { success: true, data: [] } });
  }
  if (config.url.includes('getReservations')) {
    if (extraDelayMs > 0) {
      const delay = extraDelayMs;
      return new Promise((resolve) => setTimeout(() => resolve(paginateFixture(config)), delay));
    }
    return Promise.resolve(paginateFixture(config));
  }
  return Promise.reject(new Error('endpoint Cloudbeds inesperado: ' + config.url));
}
fakeAxios.post = async (url, payload) => {
  if (typeof url === 'string' && url.includes('api.telegram.org')) {
    telegramCalls.push(payload);
    return { data: { result: { message_id: telegramCalls.length } } };
  }
  // Endpoint de OAuth de Cloudbeds (exchangeCode/refreshAccessToken).
  return { data: { access_token: 'tok123', refresh_token: 'reftok123', expires_in: 3600 } };
};

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34603;
const BASE = `http://127.0.0.1:${PORT}`;
const VAPI_SECRET = 'test-vapi-secret-guest-recognition';

process.env.PORT = String(PORT);
process.env.VAPI_SECRET = VAPI_SECRET;
process.env.CLOUDBEDS_PROPERTY_ID = 'test-property';
process.env.CLOUDBEDS_CLIENT_ID = 'test-client';
process.env.CLOUDBEDS_CLIENT_SECRET = 'test-secret';
process.env.VIGILANTE_OFF = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat-id';
process.env.ENCARGADO_ESCUCHA = 'webhook'; // evita el sondeo de getUpdates (no lo necesita este test)
delete process.env.CLOUDBEDS_REFRESH_TOKEN; // evita el auto-refresco por timer de cloudbeds.js
delete process.env.VAPI_SECRET_PREVIOUS;
delete process.env.ENCARGADO_SECRET;

function todayMadridISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const HOY = todayMadridISO();
const MANANA = addDays(HOY, 1);
const AYER = addDays(HOY, -1);
const EN_5_DIAS = addDays(HOY, 5);

// Fixture con la forma REAL de Cloudbeds: guestList como OBJETO indexado por
// guestID; rooms[] a nivel de reserva solo si se pasa reservationRooms
// (simula que Cloudbeds honró includeAllRooms=true).
function reserva({ id, guests, checkin, checkout, status = 'confirmed', channel = 'Direct Booking', adults = 2, reservationRooms }) {
  const guestList = {};
  guests.forEach((g, i) => {
    const guestID = g.guestID || `G${i}`;
    guestList[guestID] = {
      guestID,
      guestName: `${g.first} ${g.last}`,
      guestFirstName: g.first,
      guestLastName: g.last,
      guestPhone: g.phone,
      isMainGuest: !!g.isMainGuest,
    };
  });
  const out = {
    reservationID: id,
    startDate: checkin,
    endDate: checkout,
    status,
    sourceName: channel,
    adults,
    guestList,
  };
  if (reservationRooms) out.rooms = reservationRooms;
  return out;
}

// Datos de prueba fijos para todo el archivo, preparados ANTES de requerir
// server.js (ver cabecera) — no se tocan después salvo el caso de timeout.
allReservations = [
  reserva({
    id: 'RES-ARRIVE', checkin: HOY, checkout: MANANA, channel: 'Direct Booking',
    guests: [{ guestID: 'g1', first: 'Marta', last: 'Ruiz García', phone: '+34611222001', isMainGuest: true }],
    reservationRooms: [{ roomID: 'DORM-7-B', roomName: 'DORM-7-B' }],
  }),
  reserva({
    id: 'RES-INHOUSE', checkin: AYER, checkout: EN_5_DIAS, channel: 'Booking.com',
    guests: [{ guestID: 'g1', first: 'Nora', last: 'Suárez Vega', phone: '+34611222002', isMainGuest: true }],
    reservationRooms: [{ roomID: '12', roomName: '12' }, { roomID: '14', roomName: '14' }],
  }),
];

const cloudbeds = realRequire.call(module, path.join(__dirname, '../src/cloudbeds.js'));
const { spokenDate } = realRequire.call(module, path.join(__dirname, '../src/stay-dates.js'));
const app = realRequire.call(module, path.join(__dirname, '../src/server.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

function callGetCurrentDate(phone) {
  const payload = phone ? { message: { customer: { number: phone } } } : {};
  return fetch(`${BASE}/vapi/get-current-date`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': VAPI_SECRET },
    body: JSON.stringify(payload),
  });
}

function callReportIncident({ phone, category = 'otro', guest_name = 'Test', room = 'no indicada', description = 'prueba' }) {
  const payload = {
    category, guest_name, room, description,
    message: phone ? { customer: { number: phone } } : {},
  };
  return fetch(`${BASE}/vapi/report-incident`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': VAPI_SECRET },
    body: JSON.stringify(payload),
  });
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await cloudbeds.exchangeCode('fake-code');

  console.log('\nisUrgentAccessIncident (pura, sin tocar el reloj):\n');

  await t('llega hoy + hora 15 → urgente', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: HOY, checkout: MANANA }, HOY, 15), true);
  });
  await t('llega hoy + hora 14 (aún no son las 15:00) → NO urgente', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: HOY, checkout: MANANA }, HOY, 14), false);
  });
  await t('llega hoy + hora 23 → urgente (ya pasaron las 15:00)', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: HOY, checkout: MANANA }, HOY, 23), true);
  });
  await t('alojado (entró ayer, sale en 5 días) → urgente a cualquier hora', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: AYER, checkout: EN_5_DIAS }, HOY, 9), true);
  });
  await t('llega MAÑANA → nunca urgente hoy, a ninguna hora', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: MANANA, checkout: EN_5_DIAS }, HOY, 20), false);
  });
  await t('sin estancia (null) → nunca urgente', () => {
    assert.strictEqual(app.isUrgentAccessIncident(null, HOY, 20), false);
  });
  await t('checkout = hoy (ya se va): no alojado ni llega hoy → no urgente', () => {
    assert.strictEqual(app.isUrgentAccessIncident({ checkin: AYER, checkout: HOY }, HOY, 20), false);
  });

  console.log('\nPOST /vapi/get-current-date · V2a\n');

  await t('timeout de 2,5s: si Cloudbeds tarda más, responde a tiempo y SIN la línea de reserva', async () => {
    // Fuerza una consulta fresca de verdad (cache-miss) aunque el
    // calentamiento al arrancar ya haya poblado la caché de HOY: sin esto,
    // el caso pasaría por una razón equivocada (respuesta instantánea desde
    // caché, sin llegar a ejercitar el Promise.race de 2,5s).
    const restoreClock = forceFreshCloudbedsFetch();
    extraDelayMs = 3500;
    const started = Date.now(); // con el reloj ya desplazado, solo para medir el propio caso
    const r = await callGetCurrentDate('+34 611 222 001'); // mismo huésped que sí existe (Marta)
    const elapsed = Date.now() - started;
    extraDelayMs = 0;
    restoreClock();
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.ok(elapsed < 2900, `debía responder en menos de ~2.9s (tardó ${elapsed}ms)`);
    assert.ok(body.result.startsWith('HOY es'), 'el texto base debe seguir intacto');
    assert.ok(!body.result.includes('RESERVA DE QUIEN LLAMA'), 'no debía dar tiempo a añadir la línea');
  });

  await t('coincidencia (llegada hoy): añade nombre de pila y fechas habladas, nunca habitación/id/canal/teléfono/importe', async () => {
    const r = await callGetCurrentDate('611 222 001'); // sin +34, con espacios
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    const esperado = ` RESERVA DE QUIEN LLAMA: a nombre de Marta, entrada el ${spokenDate(HOY)}, salida el ${spokenDate(MANANA)}.`;
    assert.ok(body.result.endsWith(esperado), `esperaba que terminase en "${esperado}": ${body.result}`);
    assert.ok(!body.result.includes('DORM-7-B'), 'nunca debe aparecer la habitación');
    assert.ok(!body.result.includes('RES-ARRIVE'), 'nunca debe aparecer el id de reserva');
    assert.ok(!body.result.includes('Direct Booking'), 'nunca debe aparecer el canal');
    assert.ok(!body.result.includes('611222001') && !body.result.includes('611 222 001'), 'nunca debe aparecer el teléfono');
    assert.ok(!/€|\beur\b/i.test(body.result), 'nunca debe aparecer un importe');
  });

  await t('coincidencia (alojado): también añade la línea', async () => {
    const r = await callGetCurrentDate('+34611222002'); // Nora, alojada
    const body = await r.json();
    const esperado = ` RESERVA DE QUIEN LLAMA: a nombre de Nora, entrada el ${spokenDate(AYER)}, salida el ${spokenDate(EN_5_DIAS)}.`;
    assert.ok(body.result.endsWith(esperado), `esperaba que terminase en "${esperado}": ${body.result}`);
  });

  await t('sin coincidencia (teléfono no registrado): el texto queda igual que sin teléfono', async () => {
    const r = await callGetCurrentDate('+34699000000');
    const body = await r.json();
    assert.ok(!body.result.includes('RESERVA DE QUIEN LLAMA'));
    assert.ok(body.result.startsWith('HOY es'));
  });

  await t('sin teléfono en el payload: el texto queda igual que sin teléfono', async () => {
    const r = await callGetCurrentDate(null);
    const body = await r.json();
    assert.ok(!body.result.includes('RESERVA DE QUIEN LLAMA'));
    assert.ok(body.result.startsWith('HOY es'));
  });

  console.log('\nPOST /vapi/report-incident · V2a\n');

  await t('acceso + alojado → URGENTE, con línea de Reserva completa; la respuesta a Vapi no cambia', async () => {
    telegramCalls.length = 0;
    const r = await callReportIncident({ phone: '+34 611 222 002', category: 'acceso', guest_name: 'Nora (según el huésped)', description: 'no puede abrir con el código' });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result, 'Incidencia registrada y equipo avisado.');
    assert.strictEqual(telegramCalls.length, 1, 'debía mandar exactamente un mensaje a Telegram');
    const texto = telegramCalls[0].text;
    assert.ok(texto.startsWith('🚨 URGENTE — NO PUEDE ENTRAR\n'), `debía empezar por el aviso urgente: ${texto}`);
    assert.ok(texto.includes('🔴 INCIDENCIA — ACCESO'));
    assert.ok(texto.includes('Reserva: Nora Suárez Vega'));
    assert.ok(texto.includes('12, 14'));
    assert.ok(texto.includes(`entrada ${AYER}`));
    assert.ok(texto.includes(`salida ${EN_5_DIAS}`));
    assert.ok(texto.includes('canal Booking.com'));
    assert.ok(texto.includes('id RES-INHOUSE'));
    assert.ok(texto.includes('estado confirmed'));
  });

  await t('categoría distinta de "acceso" (ruido), aunque esté alojado → NUNCA urgente; la línea de Reserva se añade igual', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: '+34611222002', category: 'ruido', description: 'vecino ruidoso' });
    const texto = telegramCalls[0].text;
    assert.ok(!texto.startsWith('🚨'), 'una incidencia de ruido nunca lleva el aviso urgente de acceso');
    assert.ok(texto.includes('🔴 INCIDENCIA — RUIDO'));
    assert.ok(texto.includes('Reserva: Nora Suárez Vega'));
  });

  await t('acceso, llegada de HOY: la reserva se encuentra y se añade (el corte exacto de las 14:59/15:00 ya se prueba de forma determinista arriba, sin tocar el reloj)', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: '+34611222001', category: 'acceso', description: 'no encuentra el cajetín' });
    const texto = telegramCalls[0].text;
    assert.ok(texto.includes('Reserva: Marta Ruiz García'));
  });

  await t('acceso sin teléfono reconocido y sin nombre que coincida (guest_name="Test") → "Reserva: no encontrada", no urgente', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: '+34699000111', category: 'acceso', description: 'no entra' });
    const texto = telegramCalls[0].text;
    assert.ok(!texto.startsWith('🚨'));
    assert.ok(texto.includes('Reserva: no encontrada'));
    assert.ok(!texto.includes('coincidencia por nombre'), '"Test" no debe coincidir con ningún huésped real del fixture');
  });

  await t('sin teléfono en el payload (no detectado) y sin nombre que coincida → "Reserva: no encontrada"', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: null, category: 'acceso', description: 'llamó sin número visible' });
    const texto = telegramCalls[0].text;
    assert.ok(texto.includes('Teléfono: no detectado'));
    assert.ok(texto.includes('Reserva: no encontrada'));
  });

  await t('condición del auditor (tope de tiempo, 24-sep-2026): si Cloudbeds tarda más de 2,5s, el aviso sale a tiempo con "Reserva: no consultada a tiempo" y SIN prefijo urgente calculado por reserva', async () => {
    // Nora está alojada (rank 1): si SÍ diera tiempo, sería urgente sin
    // depender de la hora — por eso es el caso más exigente para probar que
    // el timeout suprime la urgencia calculada a partir de la reserva.
    const restoreClock = forceFreshCloudbedsFetch();
    extraDelayMs = 3500;
    telegramCalls.length = 0;
    const started = Date.now();
    const r = await callReportIncident({ phone: '+34611222002', category: 'acceso', description: 'no puede entrar, y esta vez Cloudbeds no contesta a tiempo' });
    const elapsed = Date.now() - started;
    extraDelayMs = 0;
    restoreClock();

    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.result, 'Incidencia registrada y equipo avisado.', 'la respuesta a Vapi no cambia');
    assert.ok(elapsed < 2900, `el aviso no debía esperar más de ~2,5s por Cloudbeds (tardó ${elapsed}ms)`);
    assert.strictEqual(telegramCalls.length, 1);
    const texto = telegramCalls[0].text;
    assert.ok(texto.includes('Reserva: no consultada a tiempo'), `debía indicar que no dio tiempo a consultar: ${texto}`);
    assert.ok(!texto.startsWith('🚨'), 'sin datos de la reserva no se afirma urgencia, aunque Nora (de haber llegado a tiempo) sí lo fuera');
  });

  console.log('\nGET /health · V2a\n');

  await t('/health expone guestLookup con matches/misses/errors/lastAt (solo números y fecha)', async () => {
    const r = await fetch(`${BASE}/health`);
    const body = await r.json();
    assert.ok(body.guestLookup, 'debía existir la clave guestLookup');
    assert.strictEqual(typeof body.guestLookup.matches, 'number');
    assert.strictEqual(typeof body.guestLookup.misses, 'number');
    assert.strictEqual(typeof body.guestLookup.errors, 'number');
    assert.ok(body.guestLookup.matches >= 1, 'ya hubo coincidencias en los casos anteriores');
    assert.ok(body.guestLookup.misses >= 1, 'ya hubo misses en los casos anteriores');
    assert.ok(typeof body.guestLookup.lastAt === 'string');
  });

  await t('/health → guestLookup.scan refleja el calentamiento al arrancar (2 reservas, ambas con teléfono y habitación) — solo números y fecha, nunca nombres', async () => {
    const r = await fetch(`${BASE}/health`);
    const body = await r.json();
    const scan = body.guestLookup.scan;
    assert.ok(scan, 'guestLookup.scan debía existir (calentamiento al arrancar o alguna búsqueda real ya lo pobló)');
    assert.strictEqual(scan.reservations, 2);
    assert.strictEqual(scan.withPhone, 2);
    assert.strictEqual(scan.withRoom, 2);
    assert.strictEqual(typeof scan.at, 'string');
    const raw = JSON.stringify(scan);
    assert.ok(!raw.includes('Marta') && !raw.includes('Nora') && !raw.includes('611222'), 'scan nunca debe exponer nombres ni teléfonos');
  });

  console.log('\nBúsqueda por nombre en report_incident (28-sep-2026: Booking deja de mandar el teléfono) · va al final\n');

  await t('Booking sin teléfono: report_incident encuentra la reserva por NOMBRE (args.guest_name), la marca "verificar" y suma nameMatches en /health', async () => {
    const before = await (await fetch(`${BASE}/health`)).json();
    allReservations = [
      reserva({
        id: 'BOOKING-SIN-TEL', checkin: HOY, checkout: MANANA, channel: 'Booking.com',
        guests: [{ guestID: 'g1', first: 'Teresa', last: 'Vidal Ponce', isMainGuest: true }], // sin phone: Booking desde 28-sep-2026
      }),
    ];
    const restoreClock = forceFreshCloudbedsFetch();
    try {
      telegramCalls.length = 0;
      const r = await callReportIncident({ phone: '+34699222333', guest_name: 'Teresa Vidal Ponce', category: 'acceso', description: 'no encuentra el código' });
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.strictEqual(body.result, 'Incidencia registrada y equipo avisado.', 'la respuesta a Vapi no cambia');
      const texto = telegramCalls[0].text;
      assert.ok(texto.includes('Reserva (coincidencia por nombre, verificar): Teresa Vidal Ponce'), `debía usar la reserva encontrada por nombre: ${texto}`);
      assert.ok(texto.includes('id BOOKING-SIN-TEL'));
      const after = await (await fetch(`${BASE}/health`)).json();
      assert.strictEqual(after.guestLookup.nameMatches, before.guestLookup.nameMatches + 1, 'debía sumar 1 a guestLookup.nameMatches');
    } finally {
      restoreClock();
    }
  });

  await t('nombre ambiguo en report_incident: "varias posibles" con hasta 3, sin urgencia', async () => {
    allReservations = [
      reserva({ id: 'AMB-1', checkin: HOY, checkout: MANANA, channel: 'Booking.com', guests: [{ guestID: 'g1', first: 'Pedro', last: 'Martínez', isMainGuest: true }] }),
      reserva({ id: 'AMB-2', checkin: MANANA, checkout: EN_5_DIAS, channel: 'Booking.com', guests: [{ guestID: 'g1', first: 'Pedro', last: 'Martínez', isMainGuest: true }] }),
    ];
    const restoreClock = forceFreshCloudbedsFetch();
    try {
      telegramCalls.length = 0;
      await callReportIncident({ phone: '+34699222444', guest_name: 'Pedro Martínez', category: 'acceso', description: 'no entra' });
      const texto = telegramCalls[0].text;
      assert.ok(texto.includes('varias posibles (coincidencia por nombre, verificar)'), `debía listar varias posibles: ${texto}`);
      assert.ok(texto.includes('AMB-1') && texto.includes('AMB-2'), 'debía listar las dos reservas ambiguas');
      assert.ok(!texto.startsWith('🚨'), 'nombre ambiguo: nunca se afirma urgencia');
    } finally {
      restoreClock();
    }
  });

  await t('nombre sin coincidencia en report_incident: "Reserva: no encontrada", sin "coincidencia por nombre"', async () => {
    allReservations = [
      reserva({ id: 'SIN-COINCIDIR', checkin: HOY, checkout: MANANA, channel: 'Booking.com', guests: [{ guestID: 'g1', first: 'Gonzalo', last: 'Prieto', isMainGuest: true }] }),
    ];
    const restoreClock = forceFreshCloudbedsFetch();
    try {
      telegramCalls.length = 0;
      await callReportIncident({ phone: '+34699222555', guest_name: 'Ismael Rocha', category: 'acceso', description: 'no entra' });
      const texto = telegramCalls[0].text;
      assert.ok(texto.includes('Reserva: no encontrada'));
      assert.ok(!texto.includes('coincidencia por nombre'));
    } finally {
      restoreClock();
    }
  });

  await t('corrección del auditor (28-sep-2026, segunda vuelta): coincidencia DÉBIL (solo nombre de pila) en report_incident → "Reserva posible (solo nombre de pila, verificar)" y NUNCA urgente, aunque la reserva esté alojada', async () => {
    allReservations = [
      // Alojada (checkin ayer, checkout en 5 días): por teléfono o por
      // nombre FUERTE sería urgente sin depender de la hora — el caso más
      // exigente para probar que la coincidencia débil NO dispara 🚨.
      reserva({ id: 'DEBIL-ALOJADA', checkin: AYER, checkout: EN_5_DIAS, channel: 'Booking.com', guests: [{ guestID: 'g1', first: 'Fernanda', last: 'Quiroga Beltrán', isMainGuest: true }] }),
    ];
    const restoreClock = forceFreshCloudbedsFetch();
    try {
      telegramCalls.length = 0;
      const r = await callReportIncident({ phone: '+34699222666', guest_name: 'Fernanda', category: 'acceso', description: 'no puede abrir' }); // SOLO nombre de pila, sin apellido
      assert.strictEqual(r.status, 200);
      const texto = telegramCalls[0].text;
      assert.ok(texto.includes('Reserva posible (solo nombre de pila, verificar): Fernanda Quiroga Beltrán'), `debía marcarla como coincidencia débil: ${texto}`);
      assert.ok(!texto.includes('coincidencia por nombre, verificar):'), 'no debe usar la redacción de la coincidencia fuerte');
      assert.ok(!texto.startsWith('🚨'), 'una coincidencia débil nunca debe disparar el aviso urgente, aunque la reserva esté alojada');
    } finally {
      restoreClock();
    }
  });

  console.log('\nEmpate real extremo a extremo (condición del auditor, 24-sep-2026) · último caso, va al final\n');

  await t('empate real: get_current_date NO añade la línea (ambigüedad) y report_incident lista las DOS en el aviso, en orden determinista', async () => {
    // Se ejecuta el último a propósito: sustituye allReservations por un
    // fixture propio (dos reservas con el MISMO teléfono, llegando MAÑANA —
    // rango 2, nunca urgente, así no interfiere con los casos de urgencia
    // de arriba) y fuerza una carga fresca real; no hace falta restaurar
    // nada después porque no quedan más casos que dependan del fixture
    // original de Marta/Nora.
    allReservations = [
      reserva({
        id: 'TIE-B', checkin: MANANA, checkout: EN_5_DIAS, channel: 'Airbnb',
        guests: [{ guestID: 'g1', first: 'Bruno', last: 'Empate', phone: '+34611222900', isMainGuest: true }],
      }),
      reserva({
        id: 'TIE-A', checkin: MANANA, checkout: EN_5_DIAS, channel: 'Airbnb',
        guests: [{ guestID: 'g1', first: 'Alba', last: 'Empate', phone: '+34611222900', isMainGuest: true }],
      }),
    ];
    const restoreClock = forceFreshCloudbedsFetch(); // fuerza que esta ampliación se recoja de verdad
    try {
      const r1 = await callGetCurrentDate('+34611222900');
      const body1 = await r1.json();
      assert.ok(!body1.result.includes('RESERVA DE QUIEN LLAMA'), 'con empate real, get_current_date no debe revelar ninguna de las dos reservas');

      telegramCalls.length = 0;
      const r2 = await callReportIncident({ phone: '+34611222900', category: 'acceso', description: 'no entra ninguno de los dos' });
      assert.strictEqual(r2.status, 200);
      const texto = telegramCalls[0].text;
      assert.ok(texto.includes('Reserva 1/2:'), `debía listar la primera de las dos: ${texto}`);
      assert.ok(texto.includes('Reserva 2/2:'), `debía listar la segunda de las dos: ${texto}`);
      assert.ok(texto.includes('Alba Empate'), 'debía nombrar a Alba');
      assert.ok(texto.includes('Bruno Empate'), 'debía nombrar a Bruno');
      // Orden determinista por id de reserva (mismo checkin ambas): TIE-A
      // antes que TIE-B, aunque TIE-B se insertó primero en el fixture.
      assert.ok(texto.indexOf('TIE-A') < texto.indexOf('TIE-B'), 'orden determinista por id, no por inserción');
      assert.ok(!texto.startsWith('🚨'), 'llegan mañana (rango 2): nunca urgente, haya empate o no');
    } finally {
      restoreClock();
    }
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
