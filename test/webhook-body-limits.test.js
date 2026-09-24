// test/webhook-body-limits.test.js — V1.2 (commit A): límite de cuerpo más
// alto solo para /vapi/assistant-config, errores del body-parser visibles en
// /health, y el contador endOfCall (recibidos ANTES de la autenticación).
// Motivo: el end-of-call-report de Vapi puede superar el límite por defecto
// de express.json() (100kb) — una llamada real de 24-sep-2026 nunca dejó
// rastro de su informe. Arranca el servidor real (src/server.js) en un
// puerto fijo de pruebas y le pega peticiones HTTP de verdad con fetch,
// mismo patrón que test/admin-panel-security.test.js. axios va interceptado
// (mismo truco que el resto de tests que arrancan el servidor) para que
// ninguna llamada toque la red real, aunque ninguno de estos casos llega a
// necesitarlo (el cuerpo se rechaza antes de tocar Cloudbeds/Telegram).
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let requestHandler = async () => ({ data: [] });
function fakeAxios(config) { return requestHandler(config); }
fakeAxios.post = async () => ({ data: {} });
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34602;
const BASE = `http://127.0.0.1:${PORT}`;
const VAPI_SECRET = 'test-vapi-secret-body-limits';

process.env.PORT = String(PORT);
process.env.VAPI_SECRET = VAPI_SECRET;
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

// JSON cuyo tamaño en bytes se acerca a `targetBytes` (relleno con 'x').
function jsonBodyOfApproxSize(targetBytes, type = 'synthetic-payload') {
  const wrap = (pad) => JSON.stringify({ message: { type, padding: pad } });
  const overhead = Buffer.byteLength(wrap(''));
  const padLen = Math.max(0, targetBytes - overhead);
  return wrap('x'.repeat(padLen));
}

function postRaw(urlPath, body, headers = {}) {
  return fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function getHealth() {
  return fetch(`${BASE}/health`).then((r) => r.json());
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log('\nwebhook-body-limits · V1.2 commit A: límite de cuerpo, errores de body-parser, endOfCall\n');

  await t('/vapi/assistant-config acepta un cuerpo de ~300kb (por encima del límite global de 100kb)', async () => {
    const body = jsonBodyOfApproxSize(300000);
    assert.ok(Buffer.byteLength(body) > 102400, 'el cuerpo de prueba debía superar ya el límite global de 100kb');
    const r = await postRaw('/vapi/assistant-config', body);
    assert.strictEqual(r.status, 200, `esperaba 200 con ~300kb en /vapi/assistant-config: ${await r.text()}`);
  });

  await t('/vapi/assistant-config con más de 1mb: 413 y sube webhookBodyErrors.count', async () => {
    const before = await getHealth();
    const body = jsonBodyOfApproxSize(1_100_000);
    assert.ok(Buffer.byteLength(body) > 1048576, 'el cuerpo de prueba debía superar 1mb');
    const r = await postRaw('/vapi/assistant-config', body);
    assert.strictEqual(r.status, 413);
    const respBody = await r.json();
    assert.strictEqual(respBody.error, 'Cuerpo demasiado grande');
    const after = await getHealth();
    assert.strictEqual(after.webhookBodyErrors.count, before.webhookBodyErrors.count + 1);
    assert.strictEqual(after.webhookBodyErrors.last.type, 'entity.too.large');
    assert.strictEqual(after.webhookBodyErrors.last.path, '/vapi/assistant-config');
    assert.ok(typeof after.webhookBodyErrors.last.at === 'string');
  });

  await t('JSON roto (Content-Type application/json pero cuerpo inválido): 400 y sube webhookBodyErrors.count', async () => {
    const before = await getHealth();
    const r = await postRaw('/vapi/assistant-config', '{ esto no es JSON válido');
    assert.strictEqual(r.status, 400);
    const respBody = await r.json();
    assert.strictEqual(respBody.error, 'JSON inválido');
    const after = await getHealth();
    assert.strictEqual(after.webhookBodyErrors.count, before.webhookBodyErrors.count + 1);
    assert.strictEqual(after.webhookBodyErrors.last.type, 'entity.parse.failed');
  });

  await t('otras rutas siguen con el límite global de 100kb (no heredan el 1mb de assistant-config)', async () => {
    const body = jsonBodyOfApproxSize(150000);
    assert.ok(Buffer.byteLength(body) > 102400 && Buffer.byteLength(body) < 1048576);
    const r = await postRaw('/vapi/report-incident', body, { 'x-vapi-secret': VAPI_SECRET });
    assert.strictEqual(r.status, 413, 'un cuerpo de 150kb en otra ruta debía rechazarse con el límite de 100kb');
  });

  await t('endOfCall.received cuenta un end-of-call-report ANTES de comprobar el secreto (modo warn, sin x-vapi-secret)', async () => {
    const before = await getHealth();
    const body = JSON.stringify({ message: { type: 'end-of-call-report', customer: { number: 'test' }, durationSeconds: 5 } });
    const r = await postRaw('/vapi/assistant-config', body); // sin x-vapi-secret
    assert.strictEqual(r.status, 200);
    const after = await getHealth();
    assert.strictEqual(after.endOfCall.received, before.endOfCall.received + 1);
    assert.ok(typeof after.endOfCall.lastAt === 'string');
  });

  await t('endOfCall.received también cuenta cuando SÍ llega con el secreto correcto', async () => {
    const before = await getHealth();
    const body = JSON.stringify({ message: { type: 'end-of-call-report', customer: { number: 'test' }, durationSeconds: 5 } });
    const r = await postRaw('/vapi/assistant-config', body, { 'x-vapi-secret': VAPI_SECRET });
    assert.strictEqual(r.status, 200);
    const after = await getHealth();
    assert.strictEqual(after.endOfCall.received, before.endOfCall.received + 1);
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
