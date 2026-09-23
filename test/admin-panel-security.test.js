// test/admin-panel-security.test.js — H3 panel sin secretos, extremo a extremo.
// Arranca el servidor real (src/server.js) en un puerto fijo de pruebas y le
// pega peticiones HTTP de verdad con fetch (global en Node 18+, sin
// dependencias nuevas). Es el único test que hace esto en el repo: se
// necesita para comprobar la respuesta real de /admin/login.
//
// Por qué es seguro arrancar el servidor completo aquí:
//  - CLOUDBEDS_REFRESH_TOKEN no se define → cloudbeds.js nunca intenta una
//    llamada de red real (revienta síncrono con "No hay refresh_token",
//    igual que comprueba test/cloudbeds-errors.test.js).
//  - TELEGRAM_BOT_TOKEN no se define → el Encargado no arranca el sondeo de
//    Telegram (escucha.arrancarSondeo corta él solo) y telegram.js no manda
//    nada de verdad.
//  - VIGILANTE_OFF=1 desactiva el vigilante de cobros.
//  - Los temporizadores del Encargado (vigilancia/agenda) están unref'd y su
//    primer tick tarda 30-60s: no llegan a dispararse en este test.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- doble de axios, igual que test/cloudbeds-errors.test.js -----------------
// El único axios real que este test podría disparar es el del proxy de Vapi
// (/admin/vapi/calls); Cloudbeds y Telegram se cortan antes de llegar a la
// red porque no hay CLOUDBEDS_REFRESH_TOKEN ni TELEGRAM_BOT_TOKEN. Aun así,
// interceptamos require('axios') para todo el proceso: cero red real.
let requestHandler = async () => ({ data: [] }); // respuesta por defecto para /admin/vapi/calls
function fakeAxios(config) {
  return requestHandler(config);
}
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34599;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-x7';
process.env.VAPI_SECRET = 'test-vapi-secret-actual';
process.env.VAPI_API_KEY = 'test-vapi-api-key-nunca-debe-salir';
process.env.VIGILANTE_OFF = '1';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.CLOUDBEDS_REFRESH_TOKEN;
delete process.env.VAPI_SECRET_PREVIOUS;
delete process.env.ENCARGADO_SECRET;

const app = realRequire.call(module, path.join(__dirname, '../src/server.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

function login(user, pass) {
  return fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });
}

(async () => {
  // Espera a que el servidor esté escuchando de verdad.
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log('\nadmin-panel-security · /admin/login, sesión, allow-list y rate-limit\n');

  let sessionToken = null;

  await t('/admin/login con credenciales correctas: 200, ok:true y un token', async () => {
    const r = await login('admin', 'test-admin-password-x7');
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.token === 'string' && body.token.length >= 32, 'falta token de sesión utilizable');
    sessionToken = body.token;
  });

  await t('/admin/login NUNCA devuelve VAPI_API_KEY ni VAPI_SECRET, ni en el body ni en ningún campo', async () => {
    const r = await login('admin', 'test-admin-password-x7');
    const body = await r.json();
    const raw = JSON.stringify(body);
    assert.ok(!('vapiKey' in body), 'el body no debe tener vapiKey');
    assert.ok(!('webhookSecret' in body), 'el body no debe tener webhookSecret');
    assert.ok(!('VAPI_API_KEY' in body), 'el body no debe tener VAPI_API_KEY');
    assert.ok(!('VAPI_SECRET' in body), 'el body no debe tener VAPI_SECRET');
    assert.ok(!raw.includes('test-vapi-api-key-nunca-debe-salir'), 'la API key de Vapi ha aparecido en la respuesta de login');
    assert.ok(!raw.includes('test-vapi-secret-actual'), 'el webhook secret ha aparecido en la respuesta de login');
  });

  await t('/admin/login con credenciales incorrectas: 401, ok:false, sin token', async () => {
    const r = await login('admin', 'contraseña-mala');
    assert.strictEqual(r.status, 401);
    const body = await r.json();
    assert.strictEqual(body.ok, false);
    assert.ok(!body.token);
  });

  await t('el token de sesión emitido da acceso a una ruta /admin/* protegida', async () => {
    const r = await fetch(`${BASE}/admin/reservations-today`, {
      headers: { 'x-admin-token': sessionToken },
    });
    assert.strictEqual(r.status, 200);
  });

  await t('sin token de sesión ni Basic auth, una ruta /admin/* protegida rechaza con 401', async () => {
    const r = await fetch(`${BASE}/admin/reservations-today`);
    assert.strictEqual(r.status, 401);
  });

  await t('un token inventado no sirve (no es "cualquier cosa vale")', async () => {
    const r = await fetch(`${BASE}/admin/reservations-today`, {
      headers: { 'x-admin-token': 'token-que-me-he-inventado' },
    });
    assert.strictEqual(r.status, 401);
  });

  await t('Basic auth con ADMIN_USER/ADMIN_PASSWORD también da acceso (diagnóstico por curl)', async () => {
    const basic = 'Basic ' + Buffer.from('admin:test-admin-password-x7').toString('base64');
    const r = await fetch(`${BASE}/admin/reservations-today`, {
      headers: { Authorization: basic },
    });
    assert.strictEqual(r.status, 200);
  });

  await t('las credenciales por query string NO sirven para /admin/login', async () => {
    const r = await fetch(`${BASE}/admin/login?user=admin&pass=test-admin-password-x7`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.notStrictEqual(r.status, 200);
  });

  await t('/admin/logout invalida la sesión: el mismo token deja de servir', async () => {
    const login2 = await login('admin', 'test-admin-password-x7');
    const { token } = await login2.json();
    const before = await fetch(`${BASE}/admin/reservations-today`, { headers: { 'x-admin-token': token } });
    assert.strictEqual(before.status, 200);
    const out = await fetch(`${BASE}/admin/logout`, { method: 'POST', headers: { 'x-admin-token': token } });
    assert.strictEqual(out.status, 200);
    const after = await fetch(`${BASE}/admin/reservations-today`, { headers: { 'x-admin-token': token } });
    assert.strictEqual(after.status, 401);
  });

  await t('/admin/vapi/calls con una sesión válida responde con lo que da Vapi (vía axios mockeado, sin red real)', async () => {
    let seenAuth = null;
    requestHandler = async (config) => { seenAuth = config.headers && config.headers.Authorization; return { data: [{ id: 'call-1' }] }; };
    const login3 = await login('admin', 'test-admin-password-x7');
    const { token } = await login3.json();
    const r = await fetch(`${BASE}/admin/vapi/calls`, { headers: { 'x-admin-token': token } });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.deepStrictEqual(body, [{ id: 'call-1' }]);
    // La API key la pone el backend; la sesión del navegador no la conoce.
    assert.strictEqual(seenAuth, 'Bearer test-vapi-api-key-nunca-debe-salir');
  });

  await t('/admin/vapi/calls sin sesión ni Basic auth: 401 (no cuela sin credenciales)', async () => {
    const r = await fetch(`${BASE}/admin/vapi/calls`);
    assert.strictEqual(r.status, 401);
  });

  await t('/health expone vapiSecretPreviousActive y encargadoSecretDedicated como booleanos, sin valores', async () => {
    const r = await fetch(`${BASE}/health`);
    const body = await r.json();
    assert.strictEqual(typeof body.vapiSecretPreviousActive, 'boolean');
    assert.strictEqual(body.vapiSecretPreviousActive, false); // no está definida en este test
    assert.strictEqual(typeof body.encargadoSecretDedicated, 'boolean');
    assert.strictEqual(body.encargadoSecretDedicated, false); // sin ENCARGADO_SECRET propio en este test
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('test-vapi-secret-actual'), '/health no debe filtrar el valor del secreto');
  });

  // ── Rate-limit: SIEMPRE el último bloque, agota el cupo de intentos de esta IP ──
  await t('rate-limit de /admin/login: 10 intentos/15min por IP, el 11º devuelve 429', async () => {
    let last = null;
    // Ya hemos hecho varios intentos arriba desde este mismo proceso (misma IP
    // 127.0.0.1); consumimos el resto del cupo con intentos fallidos.
    for (let i = 0; i < 15; i++) {
      last = await login('admin', 'password-incorrecta-' + i);
      if (last.status === 429) break;
    }
    assert.strictEqual(last.status, 429);
    const body = await last.json();
    assert.strictEqual(body.ok, false);
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
