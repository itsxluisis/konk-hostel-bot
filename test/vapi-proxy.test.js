// test/vapi-proxy.test.js — H3 panel sin secretos: proxy server-side a la API
// de Vapi con allow-list de rutas. Intercepta require('axios') igual que
// test/cloudbeds-errors.test.js: no toca la red real, no hace falta ninguna
// dependencia nueva.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let requestHandler = null;
let axiosCallCount = 0;

function fakeAxios(config) {
  axiosCallCount++;
  if (!requestHandler) throw new Error('requestHandler no configurado en este caso');
  return requestHandler(config);
}

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

process.env.VAPI_API_KEY = 'test-vapi-api-key';

const vapiProxy = realRequire.call(module, path.join(__dirname, '../src/vapi-proxy.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

async function esperaError(promesa) {
  try { await promesa; } catch (err) { return err; }
  throw new Error('se esperaba que lanzara un error y no lanzó');
}

(async () => {
  console.log('\nvapi-proxy · allow-list de rutas a api.vapi.ai\n');

  await t('una ruta fuera de la allow-list se rechaza SIN tocar la red', async () => {
    axiosCallCount = 0;
    requestHandler = null; // si algo llamara a axios, reventaría (bien) o lo detectamos con el contador
    const err = await esperaError(vapiProxy.call('borrar_todo_el_negocio', {}));
    assert.strictEqual(err.code, 'ROUTE_NOT_ALLOWED');
    assert.strictEqual(axiosCallCount, 0, 'no debía llamar a axios para una ruta no permitida');
  });

  await t('otra ruta arbitraria (ej. intento de URL propia) también se rechaza', async () => {
    axiosCallCount = 0;
    const err = await esperaError(vapiProxy.call('https://evil.example.com/steal', {}));
    assert.strictEqual(err.code, 'ROUTE_NOT_ALLOWED');
    assert.strictEqual(axiosCallCount, 0);
  });

  await t('listCalls llama a GET /call con la API key en Authorization', async () => {
    let seen = null;
    requestHandler = async (config) => { seen = config; return { data: [{ id: 'c1' }] }; };
    const data = await vapiProxy.call('listCalls', { query: { limit: 5 } });
    assert.deepStrictEqual(data, [{ id: 'c1' }]);
    assert.strictEqual(seen.method, 'GET');
    assert.strictEqual(seen.url, 'https://api.vapi.ai/call');
    assert.deepStrictEqual(seen.params, { limit: 5 });
    assert.strictEqual(seen.headers.Authorization, 'Bearer test-vapi-api-key');
  });

  await t('getCall arma la URL con el id y lo escapa (nada de path traversal)', async () => {
    let seen = null;
    requestHandler = async (config) => { seen = config; return { data: { id: 'abc' } }; };
    await vapiProxy.call('getCall', { params: { id: '../../etc/passwd' } });
    assert.strictEqual(seen.url, 'https://api.vapi.ai/call/..%2F..%2Fetc%2Fpasswd');
  });

  await t('patchAssistant manda PATCH con el body recibido', async () => {
    let seen = null;
    requestHandler = async (config) => { seen = config; return { data: { ok: true } }; };
    await vapiProxy.call('patchAssistant', {
      params: { id: 'asst1' },
      body: { name: 'Konk', firstMessage: 'Hola' },
    });
    assert.strictEqual(seen.method, 'PATCH');
    assert.strictEqual(seen.url, 'https://api.vapi.ai/assistant/asst1');
    assert.deepStrictEqual(seen.data, { name: 'Konk', firstMessage: 'Hola' });
  });

  await t('sin VAPI_API_KEY configurada, no llama a axios y lanza NO_API_KEY', async () => {
    const before = process.env.VAPI_API_KEY;
    delete process.env.VAPI_API_KEY;
    axiosCallCount = 0;
    requestHandler = async () => { throw new Error('no debería llegar a llamarse'); };
    try {
      const err = await esperaError(vapiProxy.call('listAssistants', {}));
      assert.strictEqual(err.code, 'NO_API_KEY');
      assert.strictEqual(axiosCallCount, 0);
    } finally {
      process.env.VAPI_API_KEY = before;
    }
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
