// test/vapi-admin-redaction-patch.test.js — V1.1: redacción de las 3 rutas
// GET del proxy de Vapi, PATCH de asistente con fusión en servidor
// (allow-list ampliada con getAssistant) y contadores de rotación en
// /health (docs/plan-mejora-voz-sep-2026.md).
//
// Arranca el servidor real (mismo patrón que test/admin-panel-security.test.js)
// con axios interceptado: sin red real. El doble de axios despacha por
// URL/método a varios "extremos" de Vapi (listCalls/getCall/listAssistants/
// getAssistant/patchAssistant) y a open-meteo (get_weather), todos
// configurables por caso de prueba.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let listCallsHandler = async () => ({ data: [] });
let getCallHandler = async () => ({ data: {} });
let listAssistantsHandler = async () => ({ data: [] });
let getAssistantHandler = async () => ({ data: {} });
let patchAssistantHandler = async () => ({ data: { ok: true } });
let weatherHandler = async () => ({
  data: {
    current_weather: { temperature: 21, weathercode: 0 },
    daily: {
      time: ['2026-09-24', '2026-09-25', '2026-09-26'],
      temperature_2m_max: [26, 25, 24],
      temperature_2m_min: [17, 16, 15],
      weathercode: [0, 1, 2],
      precipitation_sum: [0, 0, 0.2],
    },
  },
});

let axiosCallCount = 0;

function dispatch(config) {
  axiosCallCount++;
  const url = config.url || '';
  const method = (config.method || 'GET').toUpperCase();
  if (url.includes('open-meteo.com')) return weatherHandler(config);
  if (/\/assistant\/[^/]+$/.test(url)) return method === 'PATCH' ? patchAssistantHandler(config) : getAssistantHandler(config);
  if (/\/assistant$/.test(url)) return listAssistantsHandler(config);
  if (/\/call\/[^/]+$/.test(url)) return getCallHandler(config);
  if (/\/call$/.test(url)) return listCallsHandler(config);
  throw new Error('llamada axios inesperada en el test: ' + method + ' ' + url);
}

function fakeAxios(config) { return dispatch(config); }
fakeAxios.get = function (url, opts) { return dispatch(Object.assign({ method: 'GET', url }, opts)); };

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34600;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-v11';
process.env.VAPI_SECRET = 'secreto-actual-v11';
process.env.VAPI_SECRET_PREVIOUS = 'secreto-anterior-v11';
process.env.VAPI_API_KEY = 'test-vapi-api-key-v11-nunca-debe-salir';
process.env.VIGILANTE_OFF = '1';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.CLOUDBEDS_REFRESH_TOKEN;
delete process.env.ENCARGADO_SECRET;
delete process.env.VAPI_LEGACY_AUTH;
delete process.env.VAPI_END_OF_CALL_AUTH;

realRequire.call(module, path.join(__dirname, '../src/server.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

function login() {
  return fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'test-admin-password-v11' }),
  }).then((r) => r.json());
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log('\nvapi-admin-redaction-patch · redacción del proxy, PATCH con fusión en servidor y contadores de /health\n');

  const { token } = await login();
  function adminGet(p) { return fetch(`${BASE}${p}`, { headers: { 'x-admin-token': token } }); }
  function adminPatch(p, body) {
    return fetch(`${BASE}${p}`, {
      method: 'PATCH',
      headers: { 'x-admin-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── REDACCIÓN de las 3 rutas GET ─────────────────────────────────────────

  await t('GET /admin/vapi/calls redacta monitor.listenUrl/controlUrl sin tocar contadores numéricos', async () => {
    listCallsHandler = async () => ({
      data: [{
        id: 'call-1',
        cost: 0.5,
        costBreakdown: { promptTokens: 321, completionTokens: 45 },
        monitor: { listenUrl: 'MARCADOR-LISTEN-1', controlUrl: 'MARCADOR-CONTROL-1' },
      }],
    });
    const r = await adminGet('/admin/vapi/calls');
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('MARCADOR-LISTEN-1') && !raw.includes('MARCADOR-CONTROL-1'), 'no debe filtrar monitor.listenUrl/controlUrl');
    assert.strictEqual(body[0].costBreakdown.promptTokens, 321, 'no debe tocar contadores numéricos de tokens');
    assert.strictEqual(body[0].id, 'call-1');
  });

  await t('GET /admin/vapi/calls/:id redacta monitor y conserva la transcripción', async () => {
    getCallHandler = async () => ({
      data: {
        id: 'call-2',
        transcript: 'AI: hola\nUser: hola',
        monitor: { listenUrl: 'MARCADOR-LISTEN-2', controlUrl: 'MARCADOR-CONTROL-2' },
      },
    });
    const r = await adminGet('/admin/vapi/calls/call-2');
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('MARCADOR-LISTEN-2') && !raw.includes('MARCADOR-CONTROL-2'));
    assert.strictEqual(body.transcript, 'AI: hola\nUser: hola');
  });

  await t('GET /admin/vapi/assistants redacta server.headers y el secreto de una tool inline', async () => {
    listAssistantsHandler = async () => ({
      data: [{
        id: 'asst-1',
        name: 'Konk',
        server: { url: 'https://x/y', headers: { 'x-vapi-secret': 'MARCADOR-HDR-1' } },
        model: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: 'prompt' }],
          tools: [{
            type: 'function',
            function: { name: 'get_availability' },
            server: { url: 'https://x/z', secret: 'MARCADOR-TOOL-1', headers: { 'x-vapi-secret': 'MARCADOR-HDR-2' } },
          }],
        },
      }],
    });
    const r = await adminGet('/admin/vapi/assistants');
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    const raw = JSON.stringify(body);
    ['MARCADOR-HDR-1', 'MARCADOR-TOOL-1', 'MARCADOR-HDR-2'].forEach((m) => {
      assert.ok(!raw.includes(m), `${m} se ha filtrado al panel`);
    });
    assert.strictEqual(body[0].model.tools[0].function.name, 'get_availability', 'no debe destruir campos no sensibles de la tool');
  });

  // ── PATCH con fusión en servidor ─────────────────────────────────────────

  const REAL_ID = '11111111-2222-4333-8444-555555555555';

  await t('PATCH ignora el model falso del navegador y manda a Vapi las tools/secretos reales del assistant', async () => {
    let patchSeenBody = null;
    getAssistantHandler = async () => ({
      data: {
        id: REAL_ID,
        name: 'Nombre viejo',
        model: {
          model: 'gpt-4o-mini',
          provider: 'openai',
          messages: [
            { role: 'system', content: 'PROMPT VIEJO' },
            { role: 'assistant', content: 'hola' },
          ],
          tools: [{
            type: 'function',
            function: { name: 'get_availability' },
            server: { url: 'https://x/z', secret: 'SECRETO-REAL-TOOL' },
          }],
          toolIds: ['tool_real_1'],
        },
      },
    });
    patchAssistantHandler = async (config) => {
      patchSeenBody = config.data;
      return { data: Object.assign({ id: REAL_ID }, config.data) };
    };

    const r = await adminPatch(`/admin/vapi/assistants/${REAL_ID}`, {
      name: 'Nombre nuevo',
      firstMessage: 'Hola, Konk Hostel',
      modelName: 'gpt-4o',
      systemPrompt: 'PROMPT NUEVO',
      // Campo `model` inventado por un navegador desactualizado/malicioso:
      // debe ignorarse por completo.
      model: { model: 'modelo-inventado', tools: [{ server: { secret: 'SECRETO-FALSO-DEL-NAVEGADOR' } }] },
    });
    assert.strictEqual(r.status, 200);

    assert.ok(patchSeenBody, 'debe haber llamado a patchAssistant');
    assert.strictEqual(patchSeenBody.name, 'Nombre nuevo');
    assert.strictEqual(patchSeenBody.firstMessage, 'Hola, Konk Hostel');
    assert.strictEqual(patchSeenBody.model.model, 'gpt-4o');
    assert.strictEqual(patchSeenBody.model.provider, 'openai', 'debe conservar el resto de campos de model tal cual');
    assert.deepStrictEqual(patchSeenBody.model.toolIds, ['tool_real_1']);
    assert.strictEqual(patchSeenBody.model.tools[0].server.secret, 'SECRETO-REAL-TOOL', 'debe mandar el secreto REAL de la tool, no el falso del navegador');

    const sysMsg = patchSeenBody.model.messages.find((m) => m.role === 'system');
    assert.strictEqual(sysMsg.content, 'PROMPT NUEVO');
    const otherMsg = patchSeenBody.model.messages.find((m) => m.role === 'assistant');
    assert.strictEqual(otherMsg.content, 'hola', 'debe conservar el resto de mensajes');

    const rawSent = JSON.stringify(patchSeenBody);
    assert.ok(!rawSent.includes('SECRETO-FALSO-DEL-NAVEGADOR'), 'el model falso del navegador no debe llegar a Vapi');
    assert.ok(!rawSent.includes('modelo-inventado'), 'el modelo falso del navegador no debe llegar a Vapi');

    const body = await r.json();
    assert.ok(!JSON.stringify(body).includes('SECRETO-REAL-TOOL'), 'la respuesta al panel debe salir redactada');
  });

  await t('PATCH añade el mensaje system al principio si el assistant real no tenía ninguno', async () => {
    let patchSeenBody = null;
    getAssistantHandler = async () => ({
      data: { id: REAL_ID, model: { model: 'gpt-4o-mini', messages: [{ role: 'assistant', content: 'hola' }] } },
    });
    patchAssistantHandler = async (config) => { patchSeenBody = config.data; return { data: {} }; };

    const r = await adminPatch(`/admin/vapi/assistants/${REAL_ID}`, { systemPrompt: 'PRIMER PROMPT' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(patchSeenBody.model.messages[0].role, 'system');
    assert.strictEqual(patchSeenBody.model.messages[0].content, 'PRIMER PROMPT');
    assert.strictEqual(patchSeenBody.model.messages[1].content, 'hola');
  });

  await t('PATCH con :id que no es UUID responde 400 y no llama a Vapi', async () => {
    const before = axiosCallCount;
    const r = await adminPatch('/admin/vapi/assistants/no-es-un-uuid', { systemPrompt: 'x' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(axiosCallCount, before, 'no debe tocar la red con un id inválido');
  });

  await t('PATCH con systemPrompt demasiado largo responde 400 y no llama a Vapi', async () => {
    const before = axiosCallCount;
    const r = await adminPatch(`/admin/vapi/assistants/${REAL_ID}`, { systemPrompt: 'x'.repeat(60001) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(axiosCallCount, before, 'no debe tocar la red si la validación falla');
  });

  await t('PATCH con name demasiado largo responde 400', async () => {
    const r = await adminPatch(`/admin/vapi/assistants/${REAL_ID}`, { name: 'x'.repeat(81) });
    assert.strictEqual(r.status, 400);
  });

  await t('PATCH sin sesión ni Basic auth: 401', async () => {
    const r = await fetch(`${BASE}/admin/vapi/assistants/${REAL_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.strictEqual(r.status, 401);
  });

  // ── CONTADORES /health ────────────────────────────────────────────────────

  await t('/health arranca con secretMatches y legacyUnsigned en cero y countersSince como ISO', async () => {
    const r = await fetch(`${BASE}/health`);
    const body = await r.json();
    assert.deepStrictEqual(body.secretMatches, { current: 0, previous: 0 });
    assert.deepStrictEqual(body.legacyUnsigned, { getWeather: 0, endOfCall: 0, lastAt: null });
    assert.ok(!Number.isNaN(Date.parse(body.countersSince)));
  });

  await t('una llamada con VAPI_SECRET (actual) sube secretMatches.current', async () => {
    const before = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    const r = await fetch(`${BASE}/vapi/get-current-date`, {
      method: 'POST',
      headers: { 'x-vapi-secret': 'secreto-actual-v11', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 200);
    const after = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    assert.strictEqual(after.current, before.current + 1);
    assert.strictEqual(after.previous, before.previous);
  });

  await t('una llamada con VAPI_SECRET_PREVIOUS sube secretMatches.previous', async () => {
    const before = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    const r = await fetch(`${BASE}/vapi/get-current-date`, {
      method: 'POST',
      headers: { 'x-vapi-secret': 'secreto-anterior-v11', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 200);
    const after = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    assert.strictEqual(after.previous, before.previous + 1);
    assert.strictEqual(after.current, before.current);
  });

  await t('un secreto que no coincide con ninguno de los dos NO sube ningún contador (401)', async () => {
    const before = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    const r = await fetch(`${BASE}/vapi/get-current-date`, {
      method: 'POST',
      headers: { 'x-vapi-secret': 'esto-no-es-ningun-secreto-configurado', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 401);
    const after = (await (await fetch(`${BASE}/health`)).json()).secretMatches;
    assert.deepStrictEqual(after, before);
  });

  await t('get_weather sin secreto (modo warn) sube legacyUnsigned.getWeather y pone lastAt', async () => {
    const before = (await (await fetch(`${BASE}/health`)).json()).legacyUnsigned;
    const r = await fetch(`${BASE}/vapi/get-weather`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 200);
    const after = (await (await fetch(`${BASE}/health`)).json()).legacyUnsigned;
    assert.strictEqual(after.getWeather, before.getWeather + 1);
    assert.strictEqual(after.endOfCall, before.endOfCall);
    assert.ok(after.lastAt && !Number.isNaN(Date.parse(after.lastAt)));
  });

  await t('end-of-call-report sin secreto (modo warn) sube legacyUnsigned.endOfCall', async () => {
    const before = (await (await fetch(`${BASE}/health`)).json()).legacyUnsigned;
    const r = await fetch(`${BASE}/vapi/assistant-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { type: 'end-of-call-report', durationSeconds: 12, customer: { number: 'test' } } }),
    });
    assert.strictEqual(r.status, 200);
    const after = (await (await fetch(`${BASE}/health`)).json()).legacyUnsigned;
    assert.strictEqual(after.endOfCall, before.endOfCall + 1);
    assert.strictEqual(after.getWeather, before.getWeather);
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
