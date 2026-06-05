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

// ── Datos reales del Konk (precios por noche) ─────────────────────────────────
const double = { roomTypeName: 'Habitación Doble', soldAsWhole: true, capacityPerRoom: 2, bedsAvailable: 2, roomsPhysical: 1, price: 60 };
const matrimonio = { roomTypeName: 'Habitación con litera de matrimonio 2 ó 4 pax', soldAsWhole: true, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1, price: 154 };
const dorm6 = { roomTypeName: 'Habitación Compartida/Privada 6', soldAsWhole: false, capacityPerRoom: 6, bedsAvailable: 6, roomsPhysical: 1, price: 23 };
const dorm4 = { roomTypeName: 'Habitación Compartida/Privada 4', soldAsWhole: false, capacityPerRoom: 4, bedsAvailable: 4, roomsPhysical: 1, price: 30 };

const ALL = [double, matrimonio, dorm6, dorm4];
const cap = ALL.reduce((s, r) => s + r.bedsAvailable, 0);

console.log('normalizePreference:');
check('privada→private', normalizePreference('privada'), ['private']);
check('dorm6→shared', normalizePreference('dorm6'), ['shared']);
check('vacío→any', normalizePreference(undefined), ['any']);

console.log('\n4 personas (el caso de la llamada real):');
// EL BUG ORIGINAL: pidió privada y el bot dijo "no hay privadas". Ahora debe ofrecer privadas.
const r4priv = buildReply({ rooms: ALL, totalCapacity: cap, guests: 4, preference: 'private' });
check('private: ofrece privada, NO dice "no hay"', r4priv, ['privado', 'euros'], ['No tenemos ninguna opción']);
check('private: incluye la habitación privada real (154)', r4priv, ['habitación privada para 4 personas a 154']);
check('private: incluye dormitorio entero como alternativa', r4priv, ['dormitorio entero']);
console.log(`     [salida] ${r4priv}`);

const r4shared = buildReply({ rooms: ALL, totalCapacity: cap, guests: 4, preference: 'shared' });
check('shared: camas compartidas, NO menciona privada', r4shared, ['camas en habitación compartida'], ['habitación privada', 'dormitorio entero']);
console.log(`     [salida] ${r4shared}`);

const r4any = buildReply({ rooms: ALL, totalCapacity: cap, guests: 4, preference: 'any' });
check('any: ofrece privada Y compartida', r4any, ['privada', 'compartida']);
console.log(`     [salida] ${r4any}`);

console.log('\n2 personas:');
const r2priv = buildReply({ rooms: ALL, totalCapacity: cap, guests: 2, preference: 'private' });
check('private: lidera con la doble (60), no con matrimonio', r2priv, ['habitación privada para 2 personas a 60']);
check('private 2pax: no ofrece dormitorio entero (overkill)', r2priv, [], ['dormitorio entero']);
console.log(`     [salida] ${r2priv}`);

const r2shared = buildReply({ rooms: ALL, totalCapacity: cap, guests: 2, preference: 'shared' });
check('shared: 2 camas a 23 (el más barato), 46 total', r2shared, ['2 camas', '23 euros por cama', '46 euros']);
console.log(`     [salida] ${r2shared}`);

console.log('\nCasos límite:');
const rEmpty = buildReply({ rooms: [], totalCapacity: 0, guests: 3, preference: 'any' });
check('sin habitaciones → mensaje claro', rEmpty, ['No tenemos disponibilidad']);

// Grupo grande que no cabe en compartida
const rBig = buildReply({ rooms: [dorm4], totalCapacity: 4, guests: 8, preference: 'shared' });
check('8 pax en shared con solo 4 camas → no alcanza', rBig, ['capacidad']);
console.log(`     [salida] ${rBig}`);

// Privada pedida pero solo hay compartida disponible
const rNoPriv = buildReply({ rooms: [dorm6], totalCapacity: 6, guests: 2, preference: 'private' });
check('private pero solo compartida → lo dice y ofrece dormitorio/compartida', rNoPriv, ['No tenemos ninguna opción totalmente privada']);
console.log(`     [salida] ${rNoPriv}`);

console.log(`\n${'='.repeat(40)}\n${pass} OK, ${fail} fallos`);
process.exit(fail > 0 ? 1 : 0);
