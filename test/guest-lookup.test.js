// test/guest-lookup.test.js — V2a: reconocimiento de huésped por teléfono
// (docs/plan-mejora-voz-sep-2026.md). Intercepta require('axios') igual que
// test/cloudbeds-errors.test.js: no toca la red real, no hace falta ninguna
// dependencia nueva. El filtro de fechas de Cloudbeds no es de fiar
// (docs/encargado.md, "F1"), así que el doble de axios ignora a propósito
// los parámetros checkInFrom/checkInTo/checkOutFrom/checkOutTo de cada
// consulta y devuelve siempre el mismo listado crudo — el módulo tiene que
// quedarse solo con lo que de verdad cumple startDate/endDate.
//
// Cada caso que no es específicamente sobre la caché usa un "hoy" propio
// (diaUnico()) para no compartir la clave de caché de 3 minutos con otro
// caso — si dos casos usaran el mismo todayISO, el segundo leería del caché
// del primero en vez de la lista fresca que ese caso preparó.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

let allReservations = [];
let axiosCalls = 0;
let forceFailure = null; // null | 'success-false' | 'reject'

function fakeAxios(config) {
  axiosCalls++;
  if (config.url.includes('getReservations')) {
    if (forceFailure === 'reject') return Promise.reject(new Error('fallo de red simulado'));
    if (forceFailure === 'success-false') return Promise.resolve({ data: { success: false, message: 'boom de prueba' } });
    const pageNumber = config.params.pageNumber || 1;
    const pageSize = config.params.pageSize || 100;
    const start = (pageNumber - 1) * pageSize;
    const slice = allReservations.slice(start, start + pageSize);
    return Promise.resolve({ data: { success: true, data: slice } });
  }
  return Promise.reject(new Error('endpoint inesperado: ' + config.url));
}
fakeAxios.post = async () => ({ data: { access_token: 'tok123', refresh_token: 'reftok123', expires_in: 3600 } });

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

process.env.CLOUDBEDS_PROPERTY_ID = 'test-property';
process.env.CLOUDBEDS_CLIENT_ID = 'test-client';
process.env.CLOUDBEDS_CLIENT_SECRET = 'test-secret';

const cloudbeds = realRequire.call(module, path.join(__dirname, '../src/cloudbeds.js'));
const { findStayByPhone, normalizePhone, phonesMatch, healthSnapshot } = realRequire.call(module, path.join(__dirname, '../src/guest-lookup.js'));

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

// ─── Fechas de prueba: un "hoy" distinto por caso para no compartir caché ──
let diaCounter = 0;
function diaUnico() {
  diaCounter++;
  const d = new Date(Date.UTC(2026, 8, 24)); // base 2026-09-24
  d.setUTCDate(d.getUTCDate() + diaCounter * 5); // salto de 5 días: deja hueco a mañana/ayer/+semana sin pisar el siguiente caso
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function reserva({ id, first, last, checkin, checkout, status = 'confirmed', rooms, channel = 'Direct Booking', adults = 2, phone, guestListPhones }) {
  return {
    reservationID: id,
    guestFirstName: first,
    guestLastName: last,
    guestName: `${first} ${last}`,
    startDate: checkin,
    endDate: checkout,
    status,
    sourceName: channel,
    adults,
    rooms: rooms ? rooms.map(r => ({ roomID: r })) : undefined,
    guestPhone: phone,
    guestList: guestListPhones
      ? guestListPhones.map(p => ({ guestFirstName: first, guestLastName: last, guestPhone: p }))
      : undefined,
  };
}

(async () => {
  await cloudbeds.exchangeCode('fake-code');

  console.log('\nguest-lookup · normalizePhone\n');

  await t('+34 ya formateado se mantiene igual', () => {
    assert.strictEqual(normalizePhone('+34612345678'), '+34612345678');
  });
  await t('0034 se convierte en +34', () => {
    assert.strictEqual(normalizePhone('0034612345678'), '+34612345678');
  });
  await t('9 dígitos españoles con espacios se normalizan a +34', () => {
    assert.strictEqual(normalizePhone('612 345 678'), '+34612345678');
  });
  await t('guiones y paréntesis se eliminan antes de aplicar las reglas', () => {
    assert.strictEqual(normalizePhone('(612) 345-678'), '+34612345678');
  });
  await t('puntos se eliminan', () => {
    assert.strictEqual(normalizePhone('612.345.678'), '+34612345678');
  });
  await t('+351 (Portugal) se mantiene igual, sin +34', () => {
    assert.strictEqual(normalizePhone('+351 912 345 678'), '+351912345678');
  });
  await t('+44 (Reino Unido) se mantiene igual', () => {
    assert.strictEqual(normalizePhone('+44 7911 123456'), '+447911123456');
  });
  await t('cadena vacía, null o undefined → null', () => {
    assert.strictEqual(normalizePhone(''), null);
    assert.strictEqual(normalizePhone(null), null);
    assert.strictEqual(normalizePhone(undefined), null);
  });

  console.log('\nphonesMatch:');

  await t('mismo número en formatos distintos → coincide', () => {
    assert.strictEqual(phonesMatch('+34612345678', '612 345 678'), true);
  });
  await t('números distintos → no coincide', () => {
    assert.strictEqual(phonesMatch('+34612345678', '+34699999999'), false);
  });
  await t('mismos últimos 9 dígitos pero prefijo de país distinto → NO coincide', () => {
    assert.strictEqual(phonesMatch('+34612345678', '+44612345678'), false);
  });
  await t('un lado sin prefijo de país reconocible → se compara solo por los últimos 9 dígitos', () => {
    // '512345678' no empieza por 6/7/8/9 (no se le añade +34) ni por '+':
    // countryPrefixOf devuelve null para ese lado, así que el veto de
    // prefijo se omite y basta con que coincidan los últimos 9 dígitos.
    assert.strictEqual(phonesMatch('512345678', '+34512345678'), true);
  });
  await t('demasiado corto (menos de 9 dígitos) → nunca coincide', () => {
    assert.strictEqual(phonesMatch('12345', '+34612345678'), false);
  });
  await t('valor no numérico (p. ej. "test", customer.number sin número real) → no coincide', () => {
    assert.strictEqual(phonesMatch('test', '+34612345678'), false);
  });

  console.log('\nfindStayByPhone:');

  await t('sin teléfono → null sin tocar Cloudbeds', async () => {
    axiosCalls = 0;
    const r = await findStayByPhone(null, diaUnico());
    assert.strictEqual(r, null);
    assert.strictEqual(axiosCalls, 0);
  });

  await t('llegada hoy que coincide por teléfono (con espacios) → devuelve la estancia', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'R1', first: 'Marta', last: 'Ruiz', checkin: hoy, checkout: addDays(hoy, 2), rooms: ['12'], phone: '+34612345678' }),
    ];
    const before = healthSnapshot();
    const r = await findStayByPhone('612 345 678', hoy);
    assert.ok(r, 'debía encontrar la estancia');
    assert.strictEqual(r.firstName, 'Marta');
    assert.strictEqual(r.fullName, 'Marta Ruiz');
    assert.strictEqual(r.reservationId, 'R1');
    assert.strictEqual(r.checkin, hoy);
    assert.strictEqual(r.checkout, addDays(hoy, 2));
    assert.deepStrictEqual(r.rooms, ['12']);
    assert.strictEqual(r.channel, 'Direct Booking');
    assert.strictEqual(r.status, 'confirmed');
    assert.strictEqual(r.guests, 2);
    const after = healthSnapshot();
    assert.strictEqual(after.matches, before.matches + 1);
  });

  await t('teléfono que no coincide con nadie → null (miss, no error)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'R2', first: 'Juan', last: 'Gómez', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34600000001' }),
    ];
    const before = healthSnapshot();
    const r = await findStayByPhone('+34699999999', hoy);
    assert.strictEqual(r, null);
    const after = healthSnapshot();
    assert.strictEqual(after.misses, before.misses + 1);
    assert.strictEqual(after.errors, before.errors);
  });

  await t('teléfono solo en guestList (includeGuestsDetails) → coincide igualmente', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'R3', first: 'Laura', last: 'Díaz', checkin: hoy, checkout: addDays(hoy, 1), guestListPhones: ['+34611222333'] }),
    ];
    const r = await findStayByPhone('+34611222333', hoy);
    assert.ok(r);
    assert.strictEqual(r.reservationId, 'R3');
  });

  await t('varias coincidencias: prioriza la que llega HOY sobre la alojada', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'ALOJADO', first: 'Pedro', last: 'Soto', checkin: addDays(hoy, -1), checkout: addDays(hoy, 5), phone: '+34622333444' }),
      reserva({ id: 'LLEGA_HOY', first: 'Pedro', last: 'Soto', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34622333444' }),
    ];
    const r = await findStayByPhone('+34622333444', hoy);
    assert.strictEqual(r.reservationId, 'LLEGA_HOY');
  });

  await t('varias coincidencias: prioriza la ALOJADA sobre la que llega mañana', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'LLEGA_MANANA', first: 'Ana', last: 'Cruz', checkin: addDays(hoy, 1), checkout: addDays(hoy, 5), phone: '+34633444555' }),
      reserva({ id: 'ALOJADA2', first: 'Ana', last: 'Cruz', checkin: addDays(hoy, -1), checkout: addDays(hoy, 1), phone: '+34633444555' }),
    ];
    const r = await findStayByPhone('+34633444555', hoy);
    assert.strictEqual(r.reservationId, 'ALOJADA2');
  });

  await t('alojado hoy: entrada antes de hoy y salida después de hoy → se encuentra vía la consulta de alojados', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'R4', first: 'Nadia', last: 'López', checkin: addDays(hoy, -1), checkout: addDays(hoy, 5), phone: '+34644555666' }),
    ];
    const r = await findStayByPhone('+34644555666', hoy);
    assert.ok(r, 'debía encontrar al huésped alojado');
    assert.strictEqual(r.reservationId, 'R4');
  });

  await t('sale HOY (checkout = hoy): NO cuenta como alojado ni como llegada — no aparece', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'SALE_HOY', first: 'Root', last: 'Out', checkin: addDays(hoy, -1), checkout: hoy, phone: '+34655666777' }),
    ];
    const r = await findStayByPhone('+34655666777', hoy);
    assert.strictEqual(r, null, 'un checkout de hoy significa que ya no está alojado ni llega hoy');
  });

  await t('cancelada y no-show se excluyen aunque el teléfono coincida', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CANC', first: 'X', last: 'Y', checkin: hoy, checkout: addDays(hoy, 1), status: 'canceled', phone: '+34666777888' }),
      reserva({ id: 'NOSHOW', first: 'X', last: 'Y', checkin: hoy, checkout: addDays(hoy, 1), status: 'no_show', phone: '+34666777888' }),
    ];
    const r = await findStayByPhone('+34666777888', hoy);
    assert.strictEqual(r, null);
  });

  await t('habitación única (sin array rooms) usa roomID/roomNumber igual que getReservationsByDate', async () => {
    const hoy = diaUnico();
    const soloRoomId = reserva({ id: 'R5', first: 'Iker', last: 'Mora', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34677888999' });
    delete soloRoomId.rooms;
    soloRoomId.roomID = '404780-1';
    allReservations = [soloRoomId];
    const r = await findStayByPhone('+34677888999', hoy);
    assert.deepStrictEqual(r.rooms, ['404780-1']);
  });

  await t('sin ningún campo de habitación → rooms es null, no se inventa', async () => {
    const hoy = diaUnico();
    const sinHabitacion = reserva({ id: 'R6', first: 'Eva', last: 'Ponte', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34688999000' });
    delete sinHabitacion.rooms;
    allReservations = [sinHabitacion];
    const r = await findStayByPhone('+34688999000', hoy);
    assert.strictEqual(r.rooms, null);
  });

  await t('paginado: la coincidencia está en la página 2 (101 reservas, pageSize 100)', async () => {
    const hoy = diaUnico();
    const relleno = Array.from({ length: 100 }, (_, i) =>
      reserva({ id: `FILLER${i}`, first: 'Relleno', last: String(i), checkin: hoy, checkout: addDays(hoy, 1), phone: `+3460000${String(i).padStart(4, '0')}` })
    );
    const real = reserva({ id: 'PAGINA2', first: 'Sara', last: 'Vidal', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34699111222' });
    allReservations = [...relleno, real];
    const r = await findStayByPhone('+34699111222', hoy);
    assert.ok(r, 'debía encontrar la reserva que solo existe en la página 2');
    assert.strictEqual(r.reservationId, 'PAGINA2');
  });

  await t('caché de 3 minutos: una segunda búsqueda el mismo día no vuelve a llamar a Cloudbeds', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CACHE1', first: 'Cache', last: 'Uno', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34612000111' }),
    ];
    await findStayByPhone('+34612000111', hoy); // primera llamada: puebla la caché
    axiosCalls = 0;
    // Cambiamos los datos crudos SIN que se note: si no hubiera caché, este
    // teléfono ya no aparecería (no está en la nueva lista, vacía).
    allReservations = [];
    const r = await findStayByPhone('+34612000111', hoy);
    assert.ok(r, 'debía servir desde caché, no desde la lista (ya vacía)');
    assert.strictEqual(axiosCalls, 0, 'no debía volver a llamar a Cloudbeds dentro de la ventana de 3 min');
  });

  await t('caché expirada (>3 min): vuelve a consultar Cloudbeds', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CACHE2', first: 'Cache', last: 'Dos', checkin: hoy, checkout: addDays(hoy, 1), phone: '+34612000222' }),
    ];
    await findStayByPhone('+34612000222', hoy); // puebla la caché
    allReservations = []; // ya no hay nada de verdad
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60 * 1000 + 1000; // +3min y 1s: fuera de la ventana de caché
      axiosCalls = 0;
      const r = await findStayByPhone('+34612000222', hoy);
      assert.strictEqual(r, null, 'la caché ya expiró y la lista real está vacía');
      assert.ok(axiosCalls > 0, 'debía volver a llamar a Cloudbeds tras expirar la caché');
    } finally {
      Date.now = realNow;
    }
  });

  await t('Cloudbeds success:false → null, no lanza, se cuenta en errors (no en misses)', async () => {
    const hoy = diaUnico();
    forceFailure = 'success-false';
    const before = healthSnapshot();
    let r;
    try {
      r = await findStayByPhone('+34612345000', hoy);
    } finally {
      forceFailure = null;
    }
    assert.strictEqual(r, null);
    const after = healthSnapshot();
    assert.strictEqual(after.errors, before.errors + 1);
    assert.strictEqual(after.misses, before.misses);
  });

  await t('Cloudbeds caído (fallo de red) → null, no lanza, se cuenta en errors', async () => {
    const hoy = diaUnico();
    forceFailure = 'reject';
    const before = healthSnapshot();
    let r;
    try {
      r = await findStayByPhone('+34612345001', hoy);
    } finally {
      forceFailure = null;
    }
    assert.strictEqual(r, null);
    const after = healthSnapshot();
    assert.strictEqual(after.errors, before.errors + 1);
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
