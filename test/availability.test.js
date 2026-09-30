// Test rápido de la lógica de respuesta de disponibilidad.
// Ejecutar: node test/availability.test.js   (no requiere dependencias)
'use strict';

const { buildReply, normalizePreference } = require('../src/availability');

let pass = 0, fail = 0;
function check(label, actual, mustInclude, mustNotInclude = []) {
  const okIn = mustInclude.every(s => actual.includes(s));
  const okOut = mustNotInclude.every(s => !actual.includes(s));
  if (okIn && okOut) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}`);
    console.log(`     → ${actual}`);
    if (!okIn) console.log(`     falta: ${mustInclude.filter(s => !actual.includes(s)).join(' | ')}`);
    if (!okOut) console.log(`     no debería: ${mustNotInclude.filter(s => actual.includes(s)).join(' | ')}`);
  }
}

// ── Habitaciones (price = promedio/noche, priceTotal = total estancia) ─────────
// Por noche (1 noche): double 60, matrimonio 154, dorm6 23/cama, dorm4 30/cama
function room(over, totalPerNight, nights) {
  return { ...over, price: totalPerNight, priceTotal: totalPerNight * nights };
}
function konk(nights) {
  return [
    room({ roomTypeName: 'Habitación Doble', soldAsWhole: true, capacityPerRoom: 2, bedsAvailable: 2, roomsPhysical: 1 }, 60, nights),
    room({ roomTypeName: 'Habitación con litera de matrimonio 2 ó 4 pax', soldAsWhole: true, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 154, nights),
    room({ roomTypeName: 'Habitación Compartida/Privada 6', soldAsWhole: false, capacityPerRoom: 6, bedsAvailable: 6, roomsPhysical: 1 }, 23, nights),
    room({ roomTypeName: 'Habitación Compartida/Privada 4', soldAsWhole: false, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 30, nights),
  ];
}
const cap = konk(1).reduce((s, r) => s + r.bedsAvailable, 0);

console.log('normalizePreference:');
check('privada→private', normalizePreference('privada'), ['private']);
check('dorm6→shared', normalizePreference('dorm6'), ['shared']);
check('vacío→any', normalizePreference(undefined), ['any']);

console.log('\n1 persona, 1 NOCHE (solo queda la cuádruple privada — el caso de hoy):');
const n1 = konk(1);
const r1solo = buildReply({ rooms: [konk(1)[1]], totalCapacity: 4, guests: 1, preference: 'private', nights: 1 });
check('nombra la habitación (litera de matrimonio), NO inventa', r1solo, ['litera de matrimonio', '154 euros en total por 1 noche']);
console.log(`     [salida] ${r1solo}`);

console.log('\n1 NOCHE — 4 personas:');
const r1priv = buildReply({ rooms: n1, totalCapacity: cap, guests: 4, preference: 'private', nights: 1 });
check('private: privada real (154) en total por 1 noche, con nombre', r1priv, ['litera de matrimonio', '154 euros en total por 1 noche']);
check('private: NUNCA dice "la noche" suelto', r1priv, [], ['euros la noche']);
console.log(`     [salida] ${r1priv}`);

console.log('\n2 NOCHES — el caso de la llamada (sáb→lun, 4 pax):');
const n2 = konk(2);
// matrimonio total 2 noches = 308 (en real era 237 por tarifa dinámica; aquí 154*2)
const r2priv = buildReply({ rooms: n2, totalCapacity: cap, guests: 4, preference: 'private', nights: 2 });
check('private: cotiza TOTAL de 2 noches, no promedio', r2priv, ['en total por 2 noches']);
check('private: incluye la privada real (308 total) con nombre', r2priv, ['habitación privada con litera de matrimonio para 4 personas, 308 euros en total por 2 noches']);
console.log(`     [salida] ${r2priv}`);

const r2shared = buildReply({ rooms: n2, totalCapacity: cap, guests: 4, preference: 'shared', nights: 2 });
// BUG ORIGINAL: decía 84 (total de 1 noche). Correcto: 4 camas * 23/noche * 2 = 184 total
check('shared: TOTAL de la estancia (184), no 84', r2shared, ['184 euros en total por 2 noches']);
console.log(`     [salida] ${r2shared}`);

const r2any = buildReply({ rooms: n2, totalCapacity: cap, guests: 4, preference: 'any', nights: 2 });
check('any: privada + compartida, ambas total 2 noches', r2any, ['habitación privada', 'camas en habitación compartida', 'en total por 2 noches']);
console.log(`     [salida] ${r2any}`);

console.log('\n2 NOCHES — 2 personas:');
const r2p2 = buildReply({ rooms: n2, totalCapacity: cap, guests: 2, preference: 'shared', nights: 2 });
// 2 camas * 23/noche * 2 noches = 92 total
check('shared 2pax: 92 total por 2 noches', r2p2, ['2 camas en habitación compartida, 92 euros en total por 2 noches']);
console.log(`     [salida] ${r2p2}`);

console.log('\nNombres NUEVOS de Cloudbeds (30-sep-2026): etiquetas de las privadas:');
// Una privada sola, preferencia private: sale la etiqueta hablada de roomLabel().
function soloPrivada(roomTypeName, cap, guests, precio = 60) {
  return buildReply({
    rooms: [room({ roomTypeName, soldAsWhole: true, capacityPerRoom: cap, bedsAvailable: cap, roomsPhysical: 1 }, precio, 1)],
    totalCapacity: cap, guests, preference: 'private', nights: 1,
  });
}
const MALOS = ['·', 'Habitación 1', 'Habitación 3', 'Habitación 6', 'Habitación 7', 'Habitación 10', 'Hab '];
const rDoble1 = soloPrivada('Habitación 1 · Doble', 2, 2);
check('Hab 1 · Doble → "doble"', rDoble1, ['una habitación privada doble para 2 personas, 60 euros en total por 1 noche'], MALOS);
const rDoble7 = soloPrivada('Habitación 7 · Doble', 2, 2);
check('Hab 7 · Doble → "doble"', rDoble7, ['una habitación privada doble para 2 personas'], MALOS);
const rAdapt = soloPrivada('Habitación 3 · Doble adaptada', 2, 2, 65);
check('Hab 3 · Doble adaptada → "doble adaptada y accesible"', rAdapt, ['una habitación privada doble adaptada y accesible para 2 personas, 65 euros'], [...MALOS, 'minusv']);
const rLitera = soloPrivada('Habitación 6 · Litera de matrimonio 2-4 pax', 4, 4, 154);
check('Hab 6 · Litera de matrimonio 2-4 pax → "con litera de matrimonio"', rLitera, ['una habitación privada con litera de matrimonio para 4 personas, 154 euros'], [...MALOS, 'pax']);
const rIndep = soloPrivada('Habitación 10 · Doble entrada independiente', 2, 2, 70);
check('Hab 10 · Doble entrada independiente → "doble con entrada independiente"', rIndep, ['una habitación privada doble con entrada independiente para 2 personas, 70 euros'], MALOS);
console.log(`     [salida] ${rIndep}`);

function konkNuevo(nights) {
  return [
    room({ roomTypeName: 'Habitación 1 · Doble', soldAsWhole: true, capacityPerRoom: 2, bedsAvailable: 2, roomsPhysical: 1 }, 60, nights),
    room({ roomTypeName: 'Habitación 6 · Litera de matrimonio 2-4 pax', soldAsWhole: true, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 154, nights),
    // Cada dormitorio es ahora un tipo con su propio nombre (ya no se funden Hab 2 y Hab 4).
    room({ roomTypeName: 'Habitación 2 · Dormitorio mixto 6 camas', soldAsWhole: false, capacityPerRoom: 6, bedsAvailable: 6, roomsPhysical: 1 }, 23, nights),
    room({ roomTypeName: 'Habitación 4 · Dormitorio mixto 6 camas', soldAsWhole: false, capacityPerRoom: 6, bedsAvailable: 6, roomsPhysical: 1 }, 23, nights),
    room({ roomTypeName: 'Habitación 5 · Dormitorio mixto 4 camas', soldAsWhole: false, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 30, nights),
  ];
}
const nuevo2 = konkNuevo(2);
const capNuevo = nuevo2.reduce((s, r) => s + r.bedsAvailable, 0);
const rNuevoAny = buildReply({ rooms: nuevo2, totalCapacity: capNuevo, guests: 4, preference: 'any', nights: 2 });
check('any con los nombres nuevos: privada + compartida, total 2 noches, sin nombres crudos', rNuevoAny,
  ['habitación privada con litera de matrimonio para 4 personas, 308 euros en total por 2 noches', '4 camas en habitación compartida, 184 euros en total por 2 noches'], MALOS);
console.log(`     [salida] ${rNuevoAny}`);

const rNuevoDorm = buildReply({ rooms: [nuevo2[2], nuevo2[3]], totalCapacity: 12, guests: 4, preference: 'private', nights: 2 });
check('dormitorio entero para 4 (nombres nuevos): "un dormitorio entero… 6 camas", sin nombres crudos', rNuevoDorm,
  ['un dormitorio entero solo para vosotros, 6 camas, 276 euros en total por 2 noches'], MALOS);

console.log('\nCasos límite:');
const rEmpty = buildReply({ rooms: [], totalCapacity: 0, guests: 3, preference: 'any', nights: 2 });
check('sin habitaciones → mensaje claro', rEmpty, ['No tenemos disponibilidad']);

const rBig = buildReply({ rooms: [konk(2)[3]], totalCapacity: 4, guests: 8, preference: 'shared', nights: 2 });
check('8 pax con solo 4 camas → capacidad', rBig, ['capacidad']);
console.log(`     [salida] ${rBig}`);

console.log(`\n${'='.repeat(40)}\n${pass} OK, ${fail} fallos`);
process.exit(fail > 0 ? 1 : 0);
