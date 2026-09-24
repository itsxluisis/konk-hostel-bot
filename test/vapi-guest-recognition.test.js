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
let extraDelayMs = 0; // solo durante el caso de timeout
let telegramCalls = [];

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
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000 + 1000;
    extraDelayMs = 3500;
    const started = Date.now(); // con el reloj ya desplazado, solo para medir el propio caso
    const r = await callGetCurrentDate('+34 611 222 001'); // mismo huésped que sí existe (Marta)
    const elapsed = Date.now() - started;
    extraDelayMs = 0;
    Date.now = realNow;
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

  await t('acceso sin teléfono reconocido → "Reserva: no encontrada con este teléfono", no urgente', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: '+34699000111', category: 'acceso', description: 'no entra' });
    const texto = telegramCalls[0].text;
    assert.ok(!texto.startsWith('🚨'));
    assert.ok(texto.includes('Reserva: no encontrada con este teléfono'));
  });

  await t('sin teléfono en el payload (no detectado) → "Reserva: no encontrada con este teléfono"', async () => {
    telegramCalls.length = 0;
    await callReportIncident({ phone: null, category: 'acceso', description: 'llamó sin número visible' });
    const texto = telegramCalls[0].text;
    assert.ok(texto.includes('Teléfono: no detectado'));
    assert.ok(texto.includes('Reserva: no encontrada con este teléfono'));
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

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
