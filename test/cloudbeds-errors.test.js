// test/cloudbeds-errors.test.js — H1: error de la API de Cloudbeds ≠ sin disponibilidad.
// No toca la red real: intercepta require('axios') igual que test/vigilante.test.js
// intercepta require('./cloudbeds'), así no hace falta ninguna dependencia nueva.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- doble de axios, controlado por cada caso de prueba -----------------------
let requestHandler = null; // usado por api() → axios({...})
let postHandler = null;    // usado por exchangeCode/refreshAccessToken → axios.post(...)

function fakeAxios(config) {
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

process.env.CLOUDBEDS_PROPERTY_ID = 'test-property';
process.env.CLOUDBEDS_CLIENT_ID = 'test-client';
process.env.CLOUDBEDS_CLIENT_SECRET = 'test-secret';

const cloudbeds = realRequire.call(module, path.join(__dirname, '../src/cloudbeds.js'));
const { CloudbedsApiError } = cloudbeds;

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try {
    await fn();
    pasan++;
    console.log(`  ✓ ${nombre}`);
  } catch (e) {
    fallan++;
    console.log(`  ✗ ${nombre}\n     ${e.message}`);
  }
}

async function esperaError(promesa) {
  try {
    await promesa;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba que lanzara un error y no lanzó');
}

(async () => {
  console.log('\nCloudbeds · H1 error de API vs sin disponibilidad\n');

  await t('sin refresh_token configurado → CloudbedsApiError kind=auth', async () => {
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.ok(err instanceof CloudbedsApiError, 'debe ser CloudbedsApiError');
    assert.strictEqual(err.kind, 'auth');
  });

  // A partir de aquí, todos los casos necesitan un token válido en caché:
  // se consigue con un exchangeCode() de una vez (simula la autorización inicial).
  postHandler = async () => ({ data: { access_token: 'tok123', refresh_token: 'reftok123', expires_in: 3600 } });
  await cloudbeds.exchangeCode('fake-code');

  await t('HTTP 500 de Cloudbeds → kind=http', async () => {
    requestHandler = async () => {
      const e = new Error('Request failed with status code 500');
      e.response = { status: 500, data: { message: 'boom' } };
      throw e;
    };
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.ok(err instanceof CloudbedsApiError);
    assert.strictEqual(err.kind, 'http');
  });

  await t('HTTP 401 de Cloudbeds (token rechazado en la llamada) → kind=auth', async () => {
    requestHandler = async () => {
      const e = new Error('Request failed with status code 401');
      e.response = { status: 401, data: {} };
      throw e;
    };
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.strictEqual(err.kind, 'auth');
  });

  await t('timeout de red → kind=timeout', async () => {
    requestHandler = async () => {
      const e = new Error('timeout of 6000ms exceeded');
      e.code = 'ECONNABORTED';
      throw e;
    };
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.strictEqual(err.kind, 'timeout');
  });

  await t('sin respuesta (caída de red) → kind=network', async () => {
    requestHandler = async () => {
      const e = new Error('Network Error');
      e.request = {}; // axios pone .request cuando no hubo respuesta
      throw e;
    };
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.strictEqual(err.kind, 'network');
  });

  await t('HTTP 200 con success:false → kind=payload (NO "sin disponibilidad")', async () => {
    requestHandler = async (config) => {
      if (config.url.includes('getAvailableRoomTypes')) {
        return { data: { success: false, message: 'Parameter propertyID is required' } };
      }
      return { data: { success: true, data: [] } };
    };
    const err = await esperaError(cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2));
    assert.ok(err instanceof CloudbedsApiError);
    assert.strictEqual(err.kind, 'payload');
  });

  await t('0 habitaciones de verdad → NO es un error, responde vacío', async () => {
    requestHandler = async (config) => {
      if (config.url.includes('getAvailableRoomTypes')) {
        return { data: { success: true, data: [{ propertyRooms: [] }] } };
      }
      return { data: { success: true, data: [] } };
    };
    const r = await cloudbeds.getAvailability('2026-10-01', '2026-10-02', 2);
    assert.deepStrictEqual(r, { rooms: [], totalCapacity: 0, guests: 2 });
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
