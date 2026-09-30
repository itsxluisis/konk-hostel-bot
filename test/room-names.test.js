// test/room-names.test.js — nombres de habitación de Cloudbeds (renombrado 30-sep-2026).
//
// Cubre:
//   · capacidadDeTipo: capacidad de un dormitorio a partir del nombre del tipo.
//   · hablarHabitacion: cómo se dice un nombre por teléfono (Vapi).
//   · getAvailability + buildReply de punta a punta con los 10 tipos nuevos
//     (sin red: se intercepta require('axios'), igual que cloudbeds-errors.test.js).
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- doble de axios -----------------------------------------------------------
let requestHandler = null;
function fakeAxios(config) {
  if (!requestHandler) throw new Error('requestHandler no configurado');
  return requestHandler(config);
}
fakeAxios.post = async () => ({ data: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 } });

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

process.env.CLOUDBEDS_PROPERTY_ID = 'test-property';
process.env.CLOUDBEDS_CLIENT_ID = 'test-client';
process.env.CLOUDBEDS_CLIENT_SECRET = 'test-secret';

const { capacidadDeTipo, hablarHabitacion } = require('../src/room-names');
const cloudbeds = realRequire.call(module, path.join(__dirname, '../src/cloudbeds.js'));
const { buildReply } = require('../src/availability');

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

// Los 10 tipos reales desde el 30-sep-2026 (roomTypeID → nombre, privada).
const TIPOS = [
  { id: '404756', nombre: 'Habitación 1 · Doble', privada: true },
  { id: '404772', nombre: 'Habitación 2 · Dormitorio mixto 6 camas', privada: false },
  { id: '416650', nombre: 'Habitación 3 · Doble adaptada', privada: true },
  { id: '416657', nombre: 'Habitación 4 · Dormitorio mixto 6 camas', privada: false },
  { id: '404771', nombre: 'Habitación 5 · Dormitorio mixto 4 camas', privada: false },
  { id: '404757', nombre: 'Habitación 6 · Litera de matrimonio 2-4 pax', privada: true },
  { id: '413128', nombre: 'Habitación 7 · Doble', privada: true },
  { id: '416665', nombre: 'Habitación 8 · Dormitorio mixto 4 camas', privada: false },
  { id: '674038', nombre: 'Habitación 9 · Dormitorio femenino 6 camas', privada: false },
  { id: '404754', nombre: 'Habitación 10 · Doble entrada independiente', privada: true },
];

(async () => {
  console.log('\nroom-names · capacidadDeTipo (dormitorios)\n');

  await t('los 5 dormitorios NUEVOS: 6, 6, 4, 4 y 6 camas', () => {
    assert.strictEqual(capacidadDeTipo('Habitación 2 · Dormitorio mixto 6 camas'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación 4 · Dormitorio mixto 6 camas'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación 5 · Dormitorio mixto 4 camas'), 4);
    assert.strictEqual(capacidadDeTipo('Habitación 8 · Dormitorio mixto 4 camas'), 4);
    assert.strictEqual(capacidadDeTipo('Habitación 9 · Dormitorio femenino 6 camas'), 6);
  });

  await t('el número de puerta NO cuenta como capacidad (Hab 5 con 6 camas es 6, no 5)', () => {
    assert.strictEqual(capacidadDeTipo('Habitación 5 · Dormitorio mixto 6 camas'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación 6 · Dormitorio mixto 4 camas'), 4);
    assert.strictEqual(capacidadDeTipo('Habitación 4 · Dormitorio mixto 8 camas'), 8);
  });

  await t('sin "camas" ni "pax", el dígito de la puerta tampoco se cuela en el fallback', () => {
    assert.strictEqual(capacidadDeTipo('Habitación 4 · Dormitorio mixto'), null);
    assert.strictEqual(capacidadDeTipo('Hab 6 - Dormitorio'), null);
  });

  await t('nombres ANTIGUOS: "<n> pax" y dígito suelto', () => {
    assert.strictEqual(capacidadDeTipo('Habitación compartida / privada mujeres 6 PAX'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación con litera de matrimonio 2 ó 4 pax'), 4);
    assert.strictEqual(capacidadDeTipo('Habitación Compartida/Privada 6'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación compartida/privada 6'), 6);
    assert.strictEqual(capacidadDeTipo('Habitación Compartida/Privada 4'), 4);
    assert.strictEqual(capacidadDeTipo('Habitación compartida/privada 4'), 4);
  });

  await t('el fallback antiguo sigue conservando el 5', () => {
    assert.strictEqual(capacidadDeTipo('Habitación Compartida 5'), 5);
  });

  await t('"<n> camas" manda sobre "<n> pax" y sobre el dígito suelto', () => {
    assert.strictEqual(capacidadDeTipo('Dormitorio 4 camas (6 pax máx)'), 4);
  });

  await t('sin datos, null (el llamante se queda con maxGuests)', () => {
    assert.strictEqual(capacidadDeTipo(''), null);
    assert.strictEqual(capacidadDeTipo(null), null);
    assert.strictEqual(capacidadDeTipo(undefined), null);
    assert.strictEqual(capacidadDeTipo('Habitación Doble'), null);
    assert.strictEqual(capacidadDeTipo('Habitación 0 camas'), null);
  });

  console.log('\nroom-names · hablarHabitacion (lo que se dice por teléfono)\n');

  await t('unidad: "Hab 2 · Cama 3" → "habitación 2, cama 3"', () => {
    assert.strictEqual(hablarHabitacion('Hab 2 · Cama 3'), 'habitación 2, cama 3');
  });

  await t('"Hab 10 · Doble entrada indep." → "habitación 10, doble con entrada independiente"', () => {
    assert.strictEqual(hablarHabitacion('Hab 10 · Doble entrada indep.'),
      'habitación 10, doble con entrada independiente');
  });

  await t('tipo: "Habitación 4 · Dormitorio mixto 6 camas" → "habitación 4, dormitorio mixto de 6 camas"', () => {
    assert.strictEqual(hablarHabitacion('Habitación 4 · Dormitorio mixto 6 camas'),
      'habitación 4, dormitorio mixto de 6 camas');
  });

  await t('las 10 unidades nuevas', () => {
    const esperado = {
      'Hab 1 · Doble': 'habitación 1, doble',
      'Hab 2 · Cama 1': 'habitación 2, cama 1',
      'Hab 3 · Adaptada': 'habitación 3, adaptada y accesible',
      'Hab 4 · Cama 6': 'habitación 4, cama 6',
      'Hab 5 · Cama 4': 'habitación 5, cama 4',
      'Hab 6 · Litera matrimonio': 'habitación 6, litera de matrimonio',
      'Hab 7 · Doble': 'habitación 7, doble',
      'Hab 8 · Cama 2': 'habitación 8, cama 2',
      'Hab 9 · Cama 5': 'habitación 9, cama 5',
      'Hab 10 · Doble entrada indep.': 'habitación 10, doble con entrada independiente',
    };
    for (const [crudo, dicho] of Object.entries(esperado)) {
      assert.strictEqual(hablarHabitacion(crudo), dicho, crudo);
    }
  });

  await t('los 10 tipos nuevos', () => {
    const esperado = {
      'Habitación 1 · Doble': 'habitación 1, doble',
      'Habitación 2 · Dormitorio mixto 6 camas': 'habitación 2, dormitorio mixto de 6 camas',
      'Habitación 3 · Doble adaptada': 'habitación 3, doble adaptada y accesible',
      'Habitación 4 · Dormitorio mixto 6 camas': 'habitación 4, dormitorio mixto de 6 camas',
      'Habitación 5 · Dormitorio mixto 4 camas': 'habitación 5, dormitorio mixto de 4 camas',
      'Habitación 6 · Litera de matrimonio 2-4 pax': 'habitación 6, litera de matrimonio para 2 a 4 personas',
      'Habitación 7 · Doble': 'habitación 7, doble',
      'Habitación 8 · Dormitorio mixto 4 camas': 'habitación 8, dormitorio mixto de 4 camas',
      'Habitación 9 · Dormitorio femenino 6 camas': 'habitación 9, dormitorio femenino de 6 camas',
      'Habitación 10 · Doble entrada independiente': 'habitación 10, doble con entrada independiente',
    };
    for (const [crudo, dicho] of Object.entries(esperado)) {
      assert.strictEqual(hablarHabitacion(crudo), dicho, crudo);
    }
  });

  await t('lo que sale nunca lleva el punto medio ni abreviaturas de pantalla', () => {
    for (const crudo of ['Hab 2 · Cama 3', 'Hab 10 · Doble entrada indep.',
      'Habitación 6 · Litera de matrimonio 2-4 pax', 'Hab. 3 - Adaptada']) {
      const dicho = hablarHabitacion(crudo);
      assert.ok(!dicho.includes('·'), `${crudo} → ${dicho}`);
      assert.ok(!/\bhab\b/i.test(dicho), `${crudo} → ${dicho}`);
      assert.ok(!/indep\b/i.test(dicho), `${crudo} → ${dicho}`);
      assert.ok(!/\bpax\b/i.test(dicho), `${crudo} → ${dicho}`);
    }
  });

  await t('sin número de puerta: no se inventa nada (se limpia y ya)', () => {
    assert.strictEqual(hablarHabitacion('Dorm 7'), 'Dorm 7');
    assert.strictEqual(hablarHabitacion('R2(3)'), 'R2(3)');
    assert.strictEqual(hablarHabitacion('12'), '12');
    assert.strictEqual(hablarHabitacion('Suite · Vistas al mar'), 'Suite, Vistas al mar');
  });

  await t('vacío, null o solo espacios → cadena vacía', () => {
    assert.strictEqual(hablarHabitacion(''), '');
    assert.strictEqual(hablarHabitacion(null), '');
    assert.strictEqual(hablarHabitacion(undefined), '');
    assert.strictEqual(hablarHabitacion('   '), '');
  });

  await t('solo el número de puerta: "habitación 7"', () => {
    assert.strictEqual(hablarHabitacion('Hab 7'), 'habitación 7');
    assert.strictEqual(hablarHabitacion('Hab 7 ·'), 'habitación 7');
  });

  await t('es pura: no toca el nombre que se le pasa (Telegram lo sigue viendo crudo)', () => {
    const crudo = 'Hab 2 · Cama 3';
    hablarHabitacion(crudo);
    assert.strictEqual(crudo, 'Hab 2 · Cama 3');
  });

  // ─── De punta a punta: getAvailability con los 10 tipos nuevos ───────────────
  console.log('\nroom-names · getAvailability + buildReply con los 10 tipos nuevos\n');

  // maxGuests a 1 a propósito en los dormitorios: lo que manda es el nombre.
  const roomRate = { 404756: 60, 404772: 23, 416650: 65, 416657: 23, 404771: 30, 404757: 154, 413128: 60, 416665: 30, 674038: 28, 404754: 70 };
  const disponibles = { 404772: 6, 416657: 6, 404771: 4, 416665: 4, 674038: 6 };   // camas libres
  requestHandler = async (config) => {
    if (config.url.includes('getRoomTypes')) {
      return { data: { success: true, data: TIPOS.map(x => ({
        roomTypeID: x.id, roomTypeName: x.nombre, isPrivate: x.privada,
        maxGuests: x.privada ? (x.id === '404757' ? '4' : '2') : '1',
      })) } };
    }
    if (config.url.includes('getAvailableRoomTypes')) {
      return { data: { success: true, data: [{
        propertyCurrency: { currencyCode: 'EUR' },
        propertyRooms: TIPOS.map(x => ({
          roomTypeID: x.id, roomTypeName: x.nombre,
          roomsAvailable: String(x.privada ? 1 : disponibles[x.id]),
          roomRate: roomRate[x.id],
        })),
      }] } };
    }
    throw new Error(`URL inesperada en el test: ${config.url}`);
  };
  await cloudbeds.exchangeCode('fake-code');

  const disp = await cloudbeds.getAvailability('2026-10-10', '2026-10-11', 2);

  await t('salen los 10 tipos: cada dormitorio va por separado (ya no se funden Hab 2 y Hab 4)', () => {
    assert.strictEqual(disp.rooms.length, 10);
    assert.strictEqual(disp.rooms.filter(r => !r.soldAsWhole).length, 5);
  });

  await t('capacidad de los dormitorios desde el nombre aunque maxGuests venga mal: 6, 6, 4, 4, 6', () => {
    const cap = id => disp.rooms.find(r => r.roomTypeId === id).capacityPerRoom;
    assert.strictEqual(cap('404772'), 6);   // Hab 2
    assert.strictEqual(cap('416657'), 6);   // Hab 4
    assert.strictEqual(cap('404771'), 4);   // Hab 5
    assert.strictEqual(cap('416665'), 4);   // Hab 8
    assert.strictEqual(cap('674038'), 6);   // Hab 9
  });

  await t('camas disponibles y habitaciones físicas coherentes con la capacidad', () => {
    const d = id => disp.rooms.find(r => r.roomTypeId === id);
    assert.strictEqual(d('404772').bedsAvailable, 6);
    assert.strictEqual(d('404772').roomsPhysical, 1);
    assert.strictEqual(d('404771').bedsAvailable, 4);
    assert.strictEqual(d('404771').roomsPhysical, 1);
    // 26 camas de dormitorio (6+6+4+4+6) + 12 de privadas (doble 2, adaptada 2, litera 4, doble 2, Hab 10 2).
    assert.strictEqual(disp.totalCapacity, 26 + 12);
  });

  await t('las privadas conservan su capacidad (maxGuests), no la del nombre', () => {
    const d = id => disp.rooms.find(r => r.roomTypeId === id);
    assert.strictEqual(d('404757').capacityPerRoom, 4);   // litera de matrimonio
    assert.strictEqual(d('404756').capacityPerRoom, 2);   // doble
  });

  // Un dormitorio con solo 3 camas libres NO ofrece "dormitorio entero" (antes,
  // dos dormitorios con el mismo nombre de tipo se fundían y sumaban camas).
  await t('dos dormitorios con 3 camas libres cada uno NO dan "un dormitorio entero" para 4', async () => {
    const previo = requestHandler;
    requestHandler = async (config) => {
      const r = await previo(config);
      if (config.url.includes('getAvailableRoomTypes')) {
        r.data.data[0].propertyRooms = r.data.data[0].propertyRooms
          .filter(x => x.roomTypeID === '404772' || x.roomTypeID === '416657')
          .map(x => ({ ...x, roomsAvailable: '3' }));
      }
      return r;
    };
    const parcial = await cloudbeds.getAvailability('2026-10-10', '2026-10-11', 4);
    requestHandler = previo;
    const texto = buildReply({ rooms: parcial.rooms, totalCapacity: parcial.totalCapacity, guests: 4, preference: 'private', nights: 1 });
    assert.ok(!texto.includes('dormitorio entero'), texto);
  });

  await t('la respuesta que llega a la voz NO lleva nombres crudos ni el punto medio', () => {
    for (const preference of ['any', 'private', 'shared']) {
      for (const guests of [1, 2, 3, 4, 6]) {
        const texto = buildReply({ rooms: disp.rooms, totalCapacity: disp.totalCapacity, guests, preference, nights: 1 });
        assert.ok(!texto.includes('·'), `${preference}/${guests}: ${texto}`);
        for (const x of TIPOS) {
          assert.ok(!texto.includes(x.nombre), `${preference}/${guests}: "${x.nombre}" en ${texto}`);
        }
        assert.ok(!/\bHab\b/.test(texto), `${preference}/${guests}: ${texto}`);
      }
    }
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
