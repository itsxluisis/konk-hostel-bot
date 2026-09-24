// test/get-availability-dates.test.js — V1.2 e2e: guarda de fechas pasadas en
// POST /vapi/get-availability. Diseño 24-sep-2026: CUALQUIER checkin pasado
// se rechaza (no se corrige solo — src/stay-dates.js) con un mensaje dirigido
// al MODELO (no al huésped), sin llamar a Cloudbeds ni avisar a Telegram.
// Arranca el servidor real (src/server.js) en un puerto fijo de pruebas y le
// pega peticiones HTTP de verdad con fetch, igual que
// test/admin-panel-security.test.js. axios va interceptado (mismo truco que
// test/cloudbeds-errors.test.js) para que getAvailability() nunca toque la
// red real; el token de Cloudbeds se siembra en memoria con exchangeCode(),
// sin CLOUDBEDS_REFRESH_TOKEN en el entorno (así no arrancan los timers de
// auto-refresco de src/cloudbeds.js).
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- doble de axios, igual que test/cloudbeds-errors.test.js y admin-panel-security.test.js ---
let requestHandler = null; // usado por api() → axios({...}) (getAvailability)
let postHandler = null;    // usado por exchangeCode() para sembrar el token
let cloudbedsCalls = 0;    // cuántas veces se ha llamado a axios({...}) (Cloudbeds)

function fakeAxios(config) {
  cloudbedsCalls++;
  if (!requestHandler) throw new Error('requestHandler no configurado en este caso');
  return requestHandler(config);
}
fakeAxios.post = function (url, data, config) {
  if (!postHandler) throw new Error('postHandler no configurado en este caso');
  return postHandler(url, data, config);
};

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34601;
const BASE = `http://127.0.0.1:${PORT}`;
const VAPI_SECRET = 'test-vapi-secret-fechas';

process.env.PORT = String(PORT);
process.env.VAPI_SECRET = VAPI_SECRET;
process.env.CLOUDBEDS_PROPERTY_ID = 'test-property';
process.env.CLOUDBEDS_CLIENT_ID = 'test-client';
process.env.CLOUDBEDS_CLIENT_SECRET = 'test-secret';
process.env.VIGILANTE_OFF = '1';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.CLOUDBEDS_REFRESH_TOKEN; // evita el auto-refresco por timer de cloudbeds.js
delete process.env.VAPI_SECRET_PREVIOUS;
delete process.env.ENCARGADO_SECRET;

// Sembrar el token de Cloudbeds en memoria (misma instancia de módulo que
// usará src/server.js, porque Node cachea por ruta absoluta resuelta).
const cloudbeds = realRequire.call(module, path.join(__dirname, '../src/cloudbeds.js'));
const { normalizeStayDates } = realRequire.call(module, path.join(__dirname, '../src/stay-dates.js'));
postHandler = async () => ({ data: { access_token: 'tok123', refresh_token: 'reftok123', expires_in: 3600 } });

const app = realRequire.call(module, path.join(__dirname, '../src/server.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

function isoPlusDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayMadridISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

function mockEmptyAvailability() {
  requestHandler = async (config) => {
    if (config.url.includes('getAvailableRoomTypes')) {
      return { data: { success: true, data: [{ propertyRooms: [] }] } };
    }
    return { data: { success: true, data: [] } };
  };
}

function callAvailability(body) {
  return fetch(`${BASE}/vapi/get-availability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': VAPI_SECRET },
    body: JSON.stringify(body),
  });
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await cloudbeds.exchangeCode('fake-code');

  console.log('\nget-availability · V1.2 guarda de fechas pasadas (rediseño 24-sep-2026: nunca se corrige sola)\n');

  await t('caso real: fechas inventadas de hace años (2023-10-07→08) — NO llama a Cloudbeds, mensaje dirigido al modelo con calendario (incluye mañana) y nextOccurrence', async () => {
    const todayISO = todayMadridISO();
    const expected = normalizeStayDates('2023-10-07', '2023-10-08', todayISO);
    assert.strictEqual(expected.reason, 'pasada');
    const manana = isoPlusDays(todayISO, 1);

    cloudbedsCalls = 0;
    requestHandler = async () => { throw new Error('Cloudbeds NO debería llamarse para un checkin pasado'); };

    const r = await callAvailability({ checkin_date: '2023-10-07', checkout_date: '2023-10-08', guests: 2 });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.ok(body.result.startsWith('FECHAS NO VÁLIDAS'), `debía empezar por FECHAS NO VÁLIDAS: ${body.result}`);
    assert.ok(body.result.includes('No le digas al huésped que hay un error'), 'falta la instrucción de no confesar el error al huésped');
    assert.ok(body.result.includes(manana), `el calendario debía incluir mañana (${manana}): ${body.result}`);
    assert.ok(body.result.includes(expected.nextOccurrence), `debía sugerir nextOccurrence (${expected.nextOccurrence}): ${body.result}`);
    assert.strictEqual(cloudbedsCalls, 0, 'no debía llamarse a Cloudbeds para un checkin pasado');
  });

  await t('año mal calculado (2026-01-15, enero de este año): rechazo que sugiere 2027-01-15, sin llamar a Cloudbeds', async () => {
    cloudbedsCalls = 0;
    requestHandler = async () => { throw new Error('Cloudbeds NO debería llamarse para un checkin pasado'); };
    const r = await callAvailability({ checkin_date: '2026-01-15', checkout_date: '2026-01-18', guests: 2 });
    const body = await r.json();
    assert.ok(body.result.includes('2027-01-15'), `debía sugerir 2027-01-15: ${body.result}`);
    assert.strictEqual(cloudbedsCalls, 0);
  });

  await t('checkin de hace pocos días (caso general, no solo el histórico): también se rechaza igual, sin llamar a Cloudbeds', async () => {
    const todayISO = todayMadridISO();
    const checkin = isoPlusDays(todayISO, -4);
    const checkout = isoPlusDays(checkin, 2);
    cloudbedsCalls = 0;
    requestHandler = async () => { throw new Error('Cloudbeds NO debería llamarse para un checkin pasado'); };
    const r = await callAvailability({ checkin_date: checkin, checkout_date: checkout, guests: 2 });
    const body = await r.json();
    assert.ok(body.result.startsWith('FECHAS NO VÁLIDAS'), `debía rechazarse igual que cualquier fecha pasada: ${body.result}`);
    assert.strictEqual(cloudbedsCalls, 0);
  });

  await t('checkin_date de hoy: válido, sigue el flujo normal (llama a Cloudbeds, sin "FECHAS NO VÁLIDAS")', async () => {
    mockEmptyAvailability();
    const todayISO = todayMadridISO();
    const r = await callAvailability({ checkin_date: todayISO, checkout_date: isoPlusDays(todayISO, 2), guests: 2 });
    const body = await r.json();
    assert.ok(!body.result.includes('FECHAS NO VÁLIDAS'), `hoy es válido, no debía rechazarse: ${body.result}`);
  });

  await t('checkin_date futuro (caso normal): llama a Cloudbeds y responde el texto de buildReply de siempre', async () => {
    mockEmptyAvailability();
    const todayISO = todayMadridISO();
    const checkin = isoPlusDays(todayISO, 10);
    const checkout = isoPlusDays(checkin, 2);
    const r = await callAvailability({ checkin_date: checkin, checkout_date: checkout, guests: 2 });
    const body = await r.json();
    assert.ok(!body.result.includes('FECHAS NO VÁLIDAS'));
    assert.ok(body.result.includes('No tenemos disponibilidad'), `esperaba la respuesta normal de buildReply: ${body.result}`);
  });

  await t('formato inválido (no YYYY-MM-DD): responde el mensaje de fechas que faltan, sin llamar a Cloudbeds', async () => {
    cloudbedsCalls = 0;
    requestHandler = async () => { throw new Error('Cloudbeds NO debería llamarse con formato inválido'); };
    const r = await callAvailability({ checkin_date: '10/10/2026', checkout_date: '12/10/2026', guests: 2 });
    const body = await r.json();
    assert.ok(body.result.includes('Necesito las fechas'), `debía pedir de nuevo las fechas: ${body.result}`);
    assert.strictEqual(cloudbedsCalls, 0);
  });

  await t('/health expone availabilityDateRejections con count > 0 tras los rechazos de arriba', async () => {
    const r = await fetch(`${BASE}/health`);
    const body = await r.json();
    assert.ok(body.availabilityDateRejections, 'falta availabilityDateRejections en /health');
    assert.ok(body.availabilityDateRejections.count >= 3, `count debía reflejar los rechazos previos: ${JSON.stringify(body.availabilityDateRejections)}`);
    assert.ok(typeof body.availabilityDateRejections.lastAt === 'string');
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
