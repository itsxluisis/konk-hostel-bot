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
    room({ roomTypeName: 'Doble', soldAsWhole: true, capacityPerRoom: 2, bedsAvailable: 2, roomsPhysical: 1 }, 60, nights),
    room({ roomTypeName: 'Litera matrimonio', soldAsWhole: true, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 154, nights),
    room({ roomTypeName: 'Compartida 6', soldAsWhole: false, capacityPerRoom: 6, bedsAvailable: 6, roomsPhysical: 1 }, 23, nights),
    room({ roomTypeName: 'Compartida 4', soldAsWhole: false, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1 }, 30, nights),
  ];
}
const cap = konk(1).reduce((s, r) => s + r.bedsAvailable, 0);

console.log('normalizePreference:');
check('privada→private', normalizePreference('privada'), ['private']);
check('dorm6→shared', normalizePreference('dorm6'), ['shared']);
check('vacío→any', normalizePreference(undefined), ['any']);

console.log('\n1 NOCHE — 4 personas:');
const n1 = konk(1);
const r1priv = buildReply({ rooms: n1, totalCapacity: cap, guests: 4, preference: 'private', nights: 1 });
check('private: privada real (154) la noche', r1priv, ['habitación privada para 4 personas, 154 euros la noche']);
check('private: no dice "en total" en 1 noche', r1priv, [], ['en total']);
console.log(`     [salida] ${r1priv}`);

console.log('\n2 NOCHES — el caso de la llamada (sáb→lun, 4 pax):');
const n2 = konk(2);
// matrimonio total 2 noches = 308 (en real era 237 por tarifa dinámica; aquí 154*2)
const r2priv = buildReply({ rooms: n2, totalCapacity: cap, guests: 4, preference: 'private', nights: 2 });
check('private: cotiza TOTAL de 2 noches, no promedio', r2priv, ['en total por 2 noches']);
check('private: incluye la privada real (308 total)', r2priv, ['habitación privada para 4 personas, 308 euros en total por 2 noches']);
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

console.log('\nCasos límite:');
const rEmpty = buildReply({ rooms: [], totalCapacity: 0, guests: 3, preference: 'any', nights: 2 });
check('sin habitaciones → mensaje claro', rEmpty, ['No tenemos disponibilidad']);

const rBig = buildReply({ rooms: [konk(2)[3]], totalCapacity: 4, guests: 8, preference: 'shared', nights: 2 });
check('8 pax con solo 4 camas → capacidad', rBig, ['capacidad']);
console.log(`     [salida] ${rBig}`);

console.log(`\n${'='.repeat(40)}\n${pass} OK, ${fail} fallos`);
process.exit(fail > 0 ? 1 : 0);
