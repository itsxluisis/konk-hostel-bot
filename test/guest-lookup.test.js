// test/guest-lookup.test.js — V2a: reconocimiento de huésped por teléfono
// (docs/plan-mejora-voz-sep-2026.md). Intercepta require('axios') igual que
// test/cloudbeds-errors.test.js: no toca la red real, no hace falta ninguna
// dependencia nueva. El filtro de fechas de Cloudbeds no es de fiar
// (docs/encargado.md, "F1"), así que el doble de axios ignora a propósito
// los parámetros checkInFrom/checkInTo/checkOutFrom/checkOutTo de cada
// consulta y devuelve siempre el mismo listado crudo — el módulo tiene que
// quedarse solo con lo que de verdad cumple startDate/endDate.
//
// Corrección de NEXO (24-sep-2026) contra la doc oficial de Cloudbeds: con
// includeGuestsDetails=true, `guestList` es un OBJETO indexado por guestID
// ("a map of guest IDs to guest objects"), NO un array — y `rooms[]` a nivel
// de RESERVA solo llega si se pide includeAllRooms=true. Los fixtures de
// aquí reproducen esa forma real (ver reserva()); hay un caso explícito de
// regresión que habría fallado con la implementación anterior
// (`Array.isArray(r.guestList) ? r.guestList : []`, que devolvía [] siempre
// contra un guestList real).
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
const { findStayByPhone, findStaysByPhone, resolveIncidentStay, normalizePhone, phonesMatch, healthSnapshot } = realRequire.call(module, path.join(__dirname, '../src/guest-lookup.js'));

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

// ─── Fixture con la forma REAL de Cloudbeds (includeGuestsDetails=true) ────
// `guests`: array de { guestID, first, last, phone, cellPhone, isMainGuest,
// roomName, assignedRoom, roomID, roomTypeName, rooms, unassignedRooms } que
// se vuelca en un OBJETO indexado por guestID (guestList), no en un array.
// `reservationRooms`: si se pasa, simula que Cloudbeds SÍ honró
// includeAllRooms=true y devolvió rooms[] a nivel de RESERVA (objetos con
// roomID/roomName/roomTypeID/roomTypeName/subReservationID).
function reserva({ id, checkin, checkout, status = 'confirmed', channel = 'Direct Booking', adults = 2, guests = [], reservationRooms, roomID, roomNumber }) {
  const guestList = {};
  guests.forEach((g, i) => {
    const guestID = g.guestID || `G${i}`;
    guestList[guestID] = {
      guestID,
      // guestNameOnly: true simula un huésped cuyo único dato de nombre es
      // el guestName combinado (sin guestFirstName/guestLastName por
      // separado) — así se puede probar que se deriven bien del guestName.
      guestName: g.guestName || `${g.first} ${g.last}`,
      guestFirstName: g.guestNameOnly ? undefined : g.first,
      guestLastName: g.guestNameOnly ? undefined : g.last,
      guestPhone: g.phone,
      guestCellPhone: g.cellPhone,
      guestEmail: g.email,
      isMainGuest: !!g.isMainGuest,
      assignedRoom: g.assignedRoom,
      roomID: g.roomID,
      roomName: g.roomName,
      roomTypeName: g.roomTypeName,
      rooms: g.rooms,
      unassignedRooms: g.unassignedRooms,
      startDate: checkin,
      endDate: checkout,
    };
  });
  const out = {
    reservationID: id,
    startDate: checkin,
    endDate: checkout,
    status,
    sourceName: channel,
    adults,
    guestList, // OBJETO indexado por guestID — forma real de Cloudbeds, NO un array.
  };
  if (reservationRooms) out.rooms = reservationRooms;
  if (roomID) out.roomID = roomID;
  if (roomNumber) out.roomNumber = roomNumber;
  return out;
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
    assert.strictEqual(phonesMatch('512345678', '+34512345678'), true);
  });
  await t('demasiado corto (menos de 9 dígitos) → nunca coincide', () => {
    assert.strictEqual(phonesMatch('12345', '+34612345678'), false);
  });
  await t('valor no numérico (p. ej. "test", customer.number sin número real) → no coincide', () => {
    assert.strictEqual(phonesMatch('test', '+34612345678'), false);
  });

  console.log('\nfindStayByPhone — forma real de Cloudbeds (guestList como objeto):\n');

  await t('REGRESIÓN: guestList es un OBJETO indexado por guestID, no un array — con `Array.isArray(r.guestList) ? r.guestList : []` esto SIEMPRE fallaba (devolvía [] y nunca encontraba el teléfono)', async () => {
    const hoy = diaUnico();
    const r1 = reserva({
      id: 'REGRESION-OBJETO',
      checkin: hoy, checkout: addDays(hoy, 1),
      guests: [{ guestID: 'g1', first: 'Diego', last: 'Fuentes', phone: '+34655001122', isMainGuest: true }],
    });
    // El propio fixture reproduce la forma real: un objeto, no un array.
    assert.strictEqual(Array.isArray(r1.guestList), false, 'el fixture debe simular guestList como OBJETO, igual que Cloudbeds real');
    assert.strictEqual(typeof r1.guestList, 'object');
    assert.ok(r1.guestList.g1, 'indexado por guestID');
    allReservations = [r1];
    const r = await findStayByPhone('+34655001122', hoy);
    assert.ok(r, 'debía encontrar el teléfono dentro de guestList aunque sea un objeto, no un array');
    assert.strictEqual(r.firstName, 'Diego');
    assert.strictEqual(r.reservationId, 'REGRESION-OBJETO');
  });

  await t('sin teléfono → null sin tocar Cloudbeds', async () => {
    axiosCalls = 0;
    const r = await findStayByPhone(null, diaUnico());
    assert.strictEqual(r, null);
    assert.strictEqual(axiosCalls, 0);
  });

  await t('llegada hoy que coincide por teléfono (con espacios) → devuelve la estancia', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'R1', checkin: hoy, checkout: addDays(hoy, 2),
        guests: [{ guestID: 'g1', first: 'Marta', last: 'Ruiz', phone: '+34612345678', isMainGuest: true }],
        reservationRooms: [{ roomID: '12', roomName: '12', roomTypeID: 'rt1', roomTypeName: 'Doble' }],
      }),
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
      reserva({ id: 'R2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Juan', last: 'Gómez', phone: '+34600000001', isMainGuest: true }] }),
    ];
    const before = healthSnapshot();
    const r = await findStayByPhone('+34699999999', hoy);
    assert.strictEqual(r, null);
    const after = healthSnapshot();
    assert.strictEqual(after.misses, before.misses + 1);
    assert.strictEqual(after.errors, before.errors);
  });

  await t('el nombre usado es el del huésped isMainGuest aunque el teléfono que coincide sea el de OTRO huésped de la reserva (y NO es simplemente el primero de la lista)', async () => {
    const hoy = diaUnico();
    const r1 = reserva({
      id: 'MAIN-GUEST', checkin: hoy, checkout: addDays(hoy, 2),
      // Pablo (no principal) va PRIMERO en la lista a propósito, para probar
      // que se busca por isMainGuest y no se toma sin más list[0].
      guests: [
        { guestID: 'g2', first: 'Pablo', last: 'Campos', phone: '+34611000002', isMainGuest: false },
        { guestID: 'g1', first: 'Elena', last: 'Campos', phone: '+34611000001', isMainGuest: true },
      ],
    });
    allReservations = [r1];
    const r = await findStayByPhone('+34611000002', hoy); // llama Pablo, el secundario
    assert.ok(r, 'debía encontrar la reserva por el teléfono del huésped secundario');
    assert.strictEqual(r.reservationId, 'MAIN-GUEST', 'sigue siendo la misma reserva');
    assert.strictEqual(r.firstName, 'Elena', 'el nombre debe ser el del huésped isMainGuest, no el que llamó');
    assert.strictEqual(r.fullName, 'Elena Campos');
  });

  await t('varias coincidencias: prioriza la que llega HOY sobre la alojada', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'ALOJADO', checkin: addDays(hoy, -1), checkout: addDays(hoy, 5), guests: [{ guestID: 'g1', first: 'Pedro', last: 'Soto', phone: '+34622333444', isMainGuest: true }] }),
      reserva({ id: 'LLEGA_HOY', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Pedro', last: 'Soto', phone: '+34622333444', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34622333444', hoy);
    assert.strictEqual(r.reservationId, 'LLEGA_HOY');
  });

  await t('varias coincidencias: prioriza la ALOJADA sobre la que llega mañana', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'LLEGA_MANANA', checkin: addDays(hoy, 1), checkout: addDays(hoy, 5), guests: [{ guestID: 'g1', first: 'Ana', last: 'Cruz', phone: '+34633444555', isMainGuest: true }] }),
      reserva({ id: 'ALOJADA2', checkin: addDays(hoy, -1), checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Ana', last: 'Cruz', phone: '+34633444555', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34633444555', hoy);
    assert.strictEqual(r.reservationId, 'ALOJADA2');
  });

  await t('alojado hoy: entrada antes de hoy y salida después de hoy → se encuentra vía la consulta de alojados', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'R4', checkin: addDays(hoy, -1), checkout: addDays(hoy, 5), guests: [{ guestID: 'g1', first: 'Nadia', last: 'López', phone: '+34644555666', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34644555666', hoy);
    assert.ok(r, 'debía encontrar al huésped alojado');
    assert.strictEqual(r.reservationId, 'R4');
  });

  await t('sale HOY (checkout = hoy): NO cuenta como alojado ni como llegada — no aparece', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'SALE_HOY', checkin: addDays(hoy, -1), checkout: hoy, guests: [{ guestID: 'g1', first: 'Root', last: 'Out', phone: '+34655666777', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34655666777', hoy);
    assert.strictEqual(r, null, 'un checkout de hoy significa que ya no está alojado ni llega hoy');
  });

  await t('cancelada y no-show se excluyen aunque el teléfono coincida', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CANC', checkin: hoy, checkout: addDays(hoy, 1), status: 'canceled', guests: [{ guestID: 'g1', first: 'X', last: 'Y', phone: '+34666777888', isMainGuest: true }] }),
      reserva({ id: 'NOSHOW', checkin: hoy, checkout: addDays(hoy, 1), status: 'no_show', guests: [{ guestID: 'g1', first: 'X', last: 'Y', phone: '+34666777888', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34666777888', hoy);
    assert.strictEqual(r, null);
  });

  console.log('\nfindStayByPhone — habitación (prioridad de fuentes):\n');

  await t('habitación a nivel de RESERVA (rooms[], simula includeAllRooms=true) tiene prioridad sobre la del huésped', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'ROOM1', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Iker', last: 'Mora', phone: '+34677888991', isMainGuest: true, roomName: 'OTRA-DEL-HUESPED' }],
        reservationRooms: [{ roomID: '7', roomName: 'Dorm 7', roomTypeName: 'Compartida 6' }],
      }),
    ];
    const r = await findStayByPhone('+34677888991', hoy);
    assert.deepStrictEqual(r.rooms, ['Dorm 7'], 'debe usar la de la reserva (includeAllRooms), no la del huésped');
  });

  await t('varias habitaciones a nivel de reserva (grupo en 2 habitaciones) → array con las dos, sin duplicar', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'ROOM2', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Sole', last: 'Vidal', phone: '+34677888992', isMainGuest: true }],
        reservationRooms: [
          { roomID: '1', roomName: 'Dorm 1' },
          { roomID: '2', roomName: 'Dorm 2' },
          { roomID: '1', roomName: 'Dorm 1' }, // sub-reserva repetida: no debe duplicar
        ],
      }),
    ];
    const r = await findStayByPhone('+34677888992', hoy);
    assert.deepStrictEqual(r.rooms, ['Dorm 1', 'Dorm 2']);
  });

  await t('sin rooms[] a nivel de reserva (Cloudbeds no lo devolvió): usa la del huésped (roomName)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'ROOM3', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Nuria', last: 'Paz', phone: '+34677888993', isMainGuest: true, roomName: 'Dorm 9' }],
      }),
    ];
    const r = await findStayByPhone('+34677888993', hoy);
    assert.deepStrictEqual(r.rooms, ['Dorm 9']);
  });

  await t('sin rooms[] a nivel de reserva ni roomName de huésped: usa assignedRoom del huésped', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'ROOM4', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Bea', last: 'Solís', phone: '+34677888994', isMainGuest: true, assignedRoom: '14' }],
      }),
    ];
    const r = await findStayByPhone('+34677888994', hoy);
    assert.deepStrictEqual(r.rooms, ['14']);
  });

  await t('unassignedRooms del huésped NUNCA se usa como habitación (significa lo contrario: sin asignar)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'ROOM5', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Caro', last: 'Ibáñez', phone: '+34677888995', isMainGuest: true, unassignedRooms: [{ roomTypeName: 'Compartida 6' }] }],
      }),
    ];
    const r = await findStayByPhone('+34677888995', hoy);
    assert.strictEqual(r.rooms, null, 'unassignedRooms no cuenta como habitación asignada');
  });

  await t('último recurso: roomID suelto a nivel de reserva (compatibilidad con getReservationsByDate) si no hay nada más', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'R5', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Iker', last: 'Mora', phone: '+34677888999', isMainGuest: true }],
        roomID: '404780-1',
      }),
    ];
    const r = await findStayByPhone('+34677888999', hoy);
    assert.deepStrictEqual(r.rooms, ['404780-1']);
  });

  await t('sin ningún campo de habitación en ningún sitio → rooms es null, no se inventa', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({
        id: 'R6', checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Eva', last: 'Ponte', phone: '+34688999000', isMainGuest: true }],
      }),
    ];
    const r = await findStayByPhone('+34688999000', hoy);
    assert.strictEqual(r.rooms, null);
  });

  console.log('\nfindStayByPhone — paginado, caché y errores:\n');

  await t('paginado: la coincidencia está en la página 2 (101 reservas, pageSize 100)', async () => {
    const hoy = diaUnico();
    const relleno = Array.from({ length: 100 }, (_, i) =>
      reserva({
        id: `FILLER${i}`, checkin: hoy, checkout: addDays(hoy, 1),
        guests: [{ guestID: 'g1', first: 'Relleno', last: String(i), phone: `+3460000${String(i).padStart(4, '0')}`, isMainGuest: true }],
      })
    );
    const real = reserva({
      id: 'PAGINA2', checkin: hoy, checkout: addDays(hoy, 1),
      guests: [{ guestID: 'g1', first: 'Sara', last: 'Vidal', phone: '+34699111222', isMainGuest: true }],
    });
    allReservations = [...relleno, real];
    const r = await findStayByPhone('+34699111222', hoy);
    assert.ok(r, 'debía encontrar la reserva que solo existe en la página 2');
    assert.strictEqual(r.reservationId, 'PAGINA2');
  });

  await t('caché de 3 minutos: una segunda búsqueda el mismo día no vuelve a llamar a Cloudbeds', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CACHE1', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Cache', last: 'Uno', phone: '+34612000111', isMainGuest: true }] }),
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
      reserva({ id: 'CACHE2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Cache', last: 'Dos', phone: '+34612000222', isMainGuest: true }] }),
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

  console.log('\nfindStayByPhone / findStaysByPhone — empates en el rango ganador (corrección del auditor, 24-sep-2026):\n');

  await t('empate en rango 0 (dos llegan HOY con el mismo teléfono): findStayByPhone → null (ambigüedad, no revela nada)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'Z999', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Uno', last: 'A', phone: '+34600100100', isMainGuest: true }] }),
      reserva({ id: 'A111', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Dos', last: 'B', phone: '+34600100100', isMainGuest: true }] }),
    ];
    const r = await findStayByPhone('+34600100100', hoy);
    assert.strictEqual(r, null, 'un empate real debe devolver null, nunca elegir una al azar');
  });

  await t('el mismo empate: findStaysByPhone devuelve las DOS, ordenadas por id de reserva — determinista, no por orden de inserción (Z999 se insertó antes que A111)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'Z999', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Uno', last: 'A', phone: '+34600100200', isMainGuest: true }] }),
      reserva({ id: 'A111', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Dos', last: 'B', phone: '+34600100200', isMainGuest: true }] }),
    ];
    const rs = await findStaysByPhone('+34600100200', hoy);
    assert.strictEqual(rs.length, 2);
    assert.deepStrictEqual(rs.map(s => s.reservationId), ['A111', 'Z999'], 'orden determinista por id, no por inserción');
  });

  await t('empate en rango 1 (dos alojados con distinta fecha de entrada): findStaysByPhone ordena por fecha de entrada (la más antigua primero), aunque se inserte al revés; findStayByPhone también ve el empate', async () => {
    const hoy = diaUnico();
    allReservations = [
      // Se inserta primero la de entrada MÁS RECIENTE (debería quedar segunda).
      reserva({ id: 'R-RECIENTE', checkin: addDays(hoy, -1), checkout: addDays(hoy, 3), guests: [{ guestID: 'g1', first: 'Tres', last: 'C', phone: '+34600100300', isMainGuest: true }] }),
      reserva({ id: 'R-ANTIGUA', checkin: addDays(hoy, -5), checkout: addDays(hoy, 3), guests: [{ guestID: 'g1', first: 'Cuatro', last: 'D', phone: '+34600100300', isMainGuest: true }] }),
    ];
    const rs = await findStaysByPhone('+34600100300', hoy);
    assert.strictEqual(rs.length, 2);
    assert.deepStrictEqual(rs.map(s => s.reservationId), ['R-ANTIGUA', 'R-RECIENTE'], 'la que entró antes va primero, aunque se insertara después');
    const solo = await findStayByPhone('+34600100300', hoy); // misma caché (mismo teléfono/hoy)
    assert.strictEqual(solo, null, 'findStayByPhone también ve el empate y devuelve null');
  });

  await t('más de 3 empatadas: findStaysByPhone se limita a MAX_TIE_CANDIDATES (3), en orden determinista', async () => {
    const hoy = diaUnico();
    const tel = '+34600100400';
    allReservations = [
      reserva({ id: 'D', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'D', last: 'D', phone: tel, isMainGuest: true }] }),
      reserva({ id: 'B', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'B', last: 'B', phone: tel, isMainGuest: true }] }),
      reserva({ id: 'A', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'A', last: 'A', phone: tel, isMainGuest: true }] }),
      reserva({ id: 'C', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'C', last: 'C', phone: tel, isMainGuest: true }] }),
    ];
    const rs = await findStaysByPhone(tel, hoy);
    assert.strictEqual(rs.length, 3, 'se recorta a 3 aunque haya 4 empatadas');
    assert.deepStrictEqual(rs.map(s => s.reservationId), ['A', 'B', 'C'], 'las 3 primeras en orden alfabético de id (mismo checkin)');
  });

  await t('sin empate real (una sola reserva en el rango ganador): findStaysByPhone también funciona, con 1 elemento', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'UNICA', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Sole', last: 'Vidal', phone: '+34600100500', isMainGuest: true }] }),
    ];
    const rs = await findStaysByPhone('+34600100500', hoy);
    assert.strictEqual(rs.length, 1);
    assert.strictEqual(rs[0].reservationId, 'UNICA');
  });

  console.log('\nfetchCandidates — promesa en vuelo compartida (corrección del auditor, 24-sep-2026):\n');

  await t('dos búsquedas simultáneas con la caché fría no duplican las llamadas a Cloudbeds', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'CONC1', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Concu', last: 'Rrente', phone: '+34600100600', isMainGuest: true }] }),
    ];
    axiosCalls = 0;
    const [r1, r2] = await Promise.all([
      findStayByPhone('+34600100600', hoy),
      findStayByPhone('+34600100600', hoy),
    ]);
    assert.ok(r1 && r2, 'las dos búsquedas debían encontrar la reserva');
    assert.strictEqual(r1.reservationId, 'CONC1');
    assert.strictEqual(r2.reservationId, 'CONC1');
    // fetchCandidates hace 2 consultas reales (llegadas + alojados), 1
    // página cada una con este fixture pequeño. Si las dos búsquedas
    // comparten la promesa en vuelo: 2 llamadas a axios en total. Si la
    // duplicaran (sin compartir): 4.
    assert.strictEqual(axiosCalls, 2, 'las dos búsquedas simultáneas debían compartir la misma carga (2 llamadas), no duplicarla (4)');
  });

  console.log('\nresolveIncidentStay — búsqueda por NOMBRE, fuerte vs débil (corrección del auditor, 28-sep-2026, segunda vuelta):\n');

  await t('REGRESIÓN auditor 1: "Carlos del Bosque" NO coincide con la reserva de "Ana del Valle" (antes colaba: solo compartían la partícula "del")', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'BOSQUE', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Ana', last: 'del Valle', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Carlos del Bosque', hoy);
    assert.strictEqual(r.source, 'none', 'el nombre de pila no coincide (Carlos ≠ Ana): nunca debía dar la reserva por buena');
    assert.strictEqual(r.stay, null);
  });

  await t('REGRESIÓN auditor 2: "Pedro Gil Ruiz" NO coincide con la reserva de "Marta Gil Soto" (antes colaba: solo compartían el apellido "Gil", nunca se miraba el nombre de pila)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'GILSOTO', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Marta', last: 'Gil Soto', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Pedro Gil Ruiz', hoy);
    assert.strictEqual(r.source, 'none', 'el nombre de pila no coincide (Pedro ≠ Marta): nunca debía dar la reserva por buena');
    assert.strictEqual(r.stay, null);
  });

  await t('coincidencia FUERTE (nombre + apellido) → source:"name-strong", stay definitivo, cuenta nameMatches', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N1', checkin: hoy, checkout: addDays(hoy, 2), guests: [{ guestID: 'g1', first: 'Carlos', last: 'Iglesias', isMainGuest: true }] }), // sin phone: Booking ya no lo manda
    ];
    const before = healthSnapshot();
    const r = await resolveIncidentStay(null, 'Carlos Iglesias', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.ok(r.stay, 'debía encontrar exactamente una reserva por nombre');
    assert.strictEqual(r.stay.reservationId, 'N1');
    assert.strictEqual(r.tied.length, 0);
    const after = healthSnapshot();
    assert.strictEqual(after.nameMatches, before.nameMatches + 1);
  });

  await t('"José Antonio García" (quien llama) contra guestName suelto "Jose A. Garcia Lopez" (sin guestFirstName/guestLastName; la inicial "A." se descarta) → fuerte', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'JAG', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', guestName: 'Jose A. Garcia Lopez', guestNameOnly: true, isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'José Antonio García', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'JAG');
  });

  await t('tildes y mayúsculas: "JOSÉ ÁNGEL MUÑOZ" (quien llama) coincide con "Jose Angel" / "Munoz" (Cloudbeds sin tildes) → fuerte', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N4', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Jose Angel', last: 'Munoz', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'JOSÉ ÁNGEL MUÑOZ', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'N4');
  });

  await t('tildes al revés: Cloudbeds SÍ trae tildes ("Muñoz") y quien llama las dice sin tildes ("Munoz") → fuerte', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N4B', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'José', last: 'Muñoz', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'jose munoz', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'N4B');
  });

  await t('nombre de pila coincide pero el APELLIDO dado NO coincide → sin coincidencia (nunca cae a débil)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N3', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Marcos', last: 'Peláez', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Marcos Villanueva', hoy); // mismo nombre, apellido distinto
    assert.strictEqual(r.source, 'none', 'el apellido no coincide: no debe darse la reserva por buena, ni como fuerte ni como débil');
    assert.strictEqual(r.stay, null);
  });

  await t('nombre compuesto y apellido compuesto, con partículas de por medio ("María del Carmen" / "Rodríguez de la Torre") → fuerte', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'COMPUESTO', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'María del Carmen', last: 'Rodríguez de la Torre', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'María del Carmen Rodríguez de la Torre', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'COMPUESTO');
  });

  console.log('\nresolveIncidentStay — coincidencia DÉBIL (solo nombre de pila, sin apellido dado):\n');

  await t('"María" sola (sin apellido) con una ÚNICA María → source:"name-weak", cuenta nameMatches', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'M-UNICA', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'María', last: 'Sánchez', isMainGuest: true }] }),
    ];
    const before = healthSnapshot();
    const r = await resolveIncidentStay(null, 'María', hoy);
    assert.strictEqual(r.source, 'name-weak');
    assert.strictEqual(r.stay.reservationId, 'M-UNICA');
    const after = healthSnapshot();
    assert.strictEqual(after.nameMatches, before.nameMatches + 1, 'una coincidencia débil también cuenta en nameMatches');
  });

  await t('"María" sola con DOS Marías → sin coincidencia (la ambigüedad débil no se lista como "varias posibles")', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'M-UNO', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'María', last: 'López', isMainGuest: true }] }),
      reserva({ id: 'M-DOS', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'María', last: 'Ruiz', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'María', hoy);
    assert.strictEqual(r.source, 'none', 'dos coincidencias débiles no bastan: se trata como si no hubiera ninguna');
    assert.strictEqual(r.stay, null);
    assert.strictEqual(r.tied.length, 0, 'a diferencia del empate fuerte, el ambiguo débil no se lista');
  });

  await t('coincidencia solo por nombre de pila con apellido REAL en la reserva: sigue siendo débil si quien llama no dio apellido', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Rebeca', last: 'Ortiz', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Rebeca', hoy);
    assert.strictEqual(r.source, 'name-weak');
    assert.strictEqual(r.stay.reservationId, 'N2');
  });

  console.log('\nresolveIncidentStay — ambigüedad FUERTE, generales y prioridad del teléfono:\n');

  await t('varias reservas con coincidencia FUERTE → source:"name-strong", stay:null, tied con las candidatas (orden determinista)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'AMB-Z', checkin: addDays(hoy, 1), checkout: addDays(hoy, 3), guests: [{ guestID: 'g1', first: 'Elena', last: 'García', isMainGuest: true }] }),
      reserva({ id: 'AMB-A', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Elena', last: 'García', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Elena García', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay, null, 'con varias reservas posibles no se elige ninguna');
    assert.strictEqual(r.tied.length, 2);
    assert.deepStrictEqual(r.tied.map(s => s.reservationId), ['AMB-A', 'AMB-Z'], 'orden determinista por fecha de entrada, luego id');
  });

  await t('ambigüedad fuerte con más de 3 posibles: se recorta a MAX_TIE_CANDIDATES (3)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'M4', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Luis', last: 'Fernández', isMainGuest: true }] }),
      reserva({ id: 'M2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Luis', last: 'Fernández', isMainGuest: true }] }),
      reserva({ id: 'M1', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Luis', last: 'Fernández', isMainGuest: true }] }),
      reserva({ id: 'M3', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Luis', last: 'Fernández', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Luis Fernández', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.tied.length, 3);
    assert.deepStrictEqual(r.tied.map(s => s.reservationId), ['M1', 'M2', 'M3']);
  });

  await t('nombre sin ninguna coincidencia → source:"none"', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N5', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Patricia', last: 'Salas', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Ricardo Montenegro', hoy);
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.stay, null);
    assert.strictEqual(r.tied.length, 0);
  });

  await t('sin guest_name (undefined/vacío) y sin teléfono → source:"none", sin tocar Cloudbeds para el nombre (nada que buscar)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N6', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Ana', last: 'Bravo', isMainGuest: true }] }),
    ];
    const r1 = await resolveIncidentStay(null, undefined, hoy);
    assert.strictEqual(r1.source, 'none');
    const r2 = await resolveIncidentStay(null, '', hoy);
    assert.strictEqual(r2.source, 'none');
  });

  await t('inicial con punto ("A.") no cuenta como token, sea cual sea su longitud tras quitarle el punto: no basta para buscar por nombre', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N7', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Antonio', last: 'Ramos', isMainGuest: true }] }),
    ];
    axiosCalls = 0;
    const r = await resolveIncidentStay(null, 'A.', hoy);
    assert.strictEqual(r.source, 'none', 'una inicial sola no debe bastar para intentar la búsqueda por nombre');
    assert.strictEqual(axiosCalls, 0, 'sin teléfono y sin ningún token de nombre utilizable, no debía tocar Cloudbeds');
  });

  await t('partículas sueltas ("de", "la", "san"...) no cuentan como nombre de pila por sí solas', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N7B', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Santiago', last: 'De la Fuente', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'de la', hoy); // solo partículas, nada significativo
    assert.strictEqual(r.source, 'none');
  });

  await t('EL TELÉFONO TIENE PRIORIDAD SOBRE EL NOMBRE: si el teléfono encuentra una reserva, nunca se intenta el nombre (aunque el nombre coincidiría con OTRA reserva distinta)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'POR-TELEFONO', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Sara', last: 'Duque', phone: '+34611777888', isMainGuest: true }] }),
      reserva({ id: 'POR-NOMBRE', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Otra', last: 'Persona Distinta', isMainGuest: true }] }),
    ];
    // guest_name coincide con la reserva "POR-NOMBRE", pero el teléfono
    // coincide con "POR-TELEFONO": debe ganar el teléfono.
    const r = await resolveIncidentStay('+34611777888', 'Otra Persona Distinta', hoy);
    assert.strictEqual(r.source, 'phone');
    assert.strictEqual(r.stay.reservationId, 'POR-TELEFONO');
  });

  await t('el teléfono empatado (varias reservas) tampoco cae al nombre: sigue siendo "phone" (ambiguo), no se prueba el nombre', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'TEL-EMP-1', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Uno', last: 'X', phone: '+34611888999', isMainGuest: true }] }),
      reserva({ id: 'TEL-EMP-2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Dos', last: 'Y', phone: '+34611888999', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay('+34611888999', 'Nombre Que No Aparece', hoy);
    assert.strictEqual(r.source, 'phone');
    assert.strictEqual(r.stay, null);
    assert.strictEqual(r.tied.length, 2);
  });

  await t('sin teléfono en absoluto (null): cae directo al nombre (fuerte, porque se da apellido)', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N8', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Teo', last: 'Casas', isMainGuest: true }] }),
    ];
    const r = await resolveIncidentStay(null, 'Teo Casas', hoy);
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'N8');
  });

  await t('reutiliza las MISMAS candidatas que el teléfono: la búsqueda por nombre no vuelve a paginar Cloudbeds aparte', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'N9', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Nuria', last: 'Campos', isMainGuest: true }] }),
    ];
    axiosCalls = 0;
    const r = await resolveIncidentStay('+34600999888', 'Nuria Campos', hoy); // teléfono no coincide con nadie → cae a nombre
    assert.strictEqual(r.source, 'name-strong');
    assert.strictEqual(r.stay.reservationId, 'N9');
    // 2 llamadas reales (llegadas + alojados, 1 página cada una) para TODO
    // el proceso: el intento por teléfono puebla la caché y el de nombre la
    // reutiliza — nunca 4 (lo que daría si repaginara aparte).
    assert.strictEqual(axiosCalls, 2, 'la búsqueda por nombre debía servirse de la misma carga que ya hizo la de teléfono, no repaginar');
  });

  await t('Cloudbeds falla en el intento por teléfono: la búsqueda por nombre lo intenta de nuevo y también puede fallar → source:"none", sin lanzar', async () => {
    const hoy = diaUnico();
    forceFailure = 'reject';
    let r;
    try {
      r = await resolveIncidentStay('+34600111000', 'Cualquier Nombre', hoy);
    } finally {
      forceFailure = null;
    }
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.stay, null);
  });

  console.log('\nhealthSnapshot().scan:');

  await t('scan refleja la última carga real: recuentos, nunca nombres ni teléfonos', async () => {
    const hoy = diaUnico();
    allReservations = [
      reserva({ id: 'SCAN1', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Con', last: 'Telefono', phone: '+34600111222', isMainGuest: true, roomName: 'Dorm 1' }] }),
      reserva({ id: 'SCAN2', checkin: hoy, checkout: addDays(hoy, 1), guests: [{ guestID: 'g1', first: 'Sin', last: 'Telefono', isMainGuest: true }] }), // sin teléfono ni habitación
    ];
    await findStayByPhone('+34600111222', hoy); // fuerza una carga real (cache miss) para este "hoy" nuevo
    const snap = healthSnapshot();
    assert.ok(snap.scan, 'scan debía existir tras una carga real');
    assert.strictEqual(snap.scan.reservations, 2);
    assert.strictEqual(snap.scan.withPhone, 1);
    assert.strictEqual(snap.scan.withRoom, 1);
    assert.strictEqual(typeof snap.scan.at, 'string');
    const raw = JSON.stringify(snap.scan);
    assert.ok(!raw.includes('Con') && !raw.includes('Telefono') && !raw.includes('600111222'), 'scan nunca debe exponer nombres ni teléfonos');
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
