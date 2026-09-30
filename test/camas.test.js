// test/camas.test.js — elegir bien la cama, o no elegir ninguna.
'use strict';

const assert = require('assert');
const { elegir, normalizar } = require('../src/encargado/inventario');

// ─── Inventario real del Konk desde el 30-sep-2026 (31 unidades) ─────────────
// Unidades "Hab N · …" y tipos "Habitación N · …", con el punto medio U+00B7.
const TIPOS = {
  1:  { id: '404756', tipo: 'Habitación 1 · Doble', privada: true },
  2:  { id: '404772', tipo: 'Habitación 2 · Dormitorio mixto 6 camas', privada: false },
  3:  { id: '416650', tipo: 'Habitación 3 · Doble adaptada', privada: true },
  4:  { id: '416657', tipo: 'Habitación 4 · Dormitorio mixto 6 camas', privada: false },
  5:  { id: '404771', tipo: 'Habitación 5 · Dormitorio mixto 4 camas', privada: false },
  6:  { id: '404757', tipo: 'Habitación 6 · Litera de matrimonio 2-4 pax', privada: true },
  7:  { id: '413128', tipo: 'Habitación 7 · Doble', privada: true },
  8:  { id: '416665', tipo: 'Habitación 8 · Dormitorio mixto 4 camas', privada: false },
  9:  { id: '674038', tipo: 'Habitación 9 · Dormitorio femenino 6 camas', privada: false },
  10: { id: '404754', tipo: 'Habitación 10 · Doble entrada independiente', privada: true },
};
const UNIDADES = [
  [1, ['Hab 1 · Doble']],
  [2, [1, 2, 3, 4, 5, 6].map(n => `Hab 2 · Cama ${n}`)],
  [3, ['Hab 3 · Adaptada']],
  [4, [1, 2, 3, 4, 5, 6].map(n => `Hab 4 · Cama ${n}`)],
  [5, [1, 2, 3, 4].map(n => `Hab 5 · Cama ${n}`)],
  [6, ['Hab 6 · Litera matrimonio']],
  [7, ['Hab 7 · Doble']],
  [8, [1, 2, 3, 4].map(n => `Hab 8 · Cama ${n}`)],
  [9, [1, 2, 3, 4, 5, 6].map(n => `Hab 9 · Cama ${n}`)],
  [10, ['Hab 10 · Doble entrada indep.']],
];
const NUEVO = [];
for (const [hab, nombres] of UNIDADES) {
  nombres.forEach((nombre, i) => NUEVO.push({
    id: `${TIPOS[hab].id}-${i}`, nombre, tipo: TIPOS[hab].tipo,
    privada: TIPOS[hab].privada, bloqueada: false,
  }));
}

// ─── Inventario con los nombres ANTIGUOS (por si algo viejo vuelve a salir) ──
const ANTIGUO = [
  { id: '404754-0', nombre: 'Room 10', tipo: 'Habitación Doble (entrada independiente)', privada: true, bloqueada: false },
  { id: '404756-0', nombre: 'Room 1', tipo: 'Habitación Doble', privada: true, bloqueada: false },
  { id: '404760-0', nombre: 'Room 7', tipo: 'Habitación doble', privada: true, bloqueada: false },
  { id: '404770-0', nombre: 'R2(1)', tipo: 'Habitación Compartida/Privada 6', privada: false, bloqueada: false },
  { id: '404770-1', nombre: 'R2(2)', tipo: 'Habitación Compartida/Privada 6', privada: false, bloqueada: false },
  { id: '404770-2', nombre: 'R2(10)', tipo: 'Habitación Compartida/Privada 6', privada: false, bloqueada: false },
  { id: '404780-0', nombre: 'R5(1)', tipo: 'Habitación Compartida/Privada 4', privada: false, bloqueada: true },
];

let pasan = 0, fallan = 0;
const t = (n, fn) => { try { fn(); pasan++; console.log(`  ✓ ${n}`); }
  catch (e) { fallan++; console.log(`  ✗ ${n}\n     ${e.message}`); } };

console.log('\nEncargado · inventario de prueba\n');

t('el inventario nuevo tiene las 31 unidades reales', () => {
  assert.strictEqual(NUEVO.length, 31);
});

console.log('\nEncargado · normalizar\n');

t('el punto medio, paréntesis, guiones, barras y puntos son separadores', () => {
  assert.strictEqual(normalizar('Hab 2 · Cama 1'), 'hab 2 cama 1');
  assert.strictEqual(normalizar('R2(1)'), 'r2 1');
  assert.strictEqual(normalizar('Compartida/Privada 6'), 'compartida privada 6');
  assert.strictEqual(normalizar('Hab. 10 - Doble entrada indep.'), 'hab 10 doble entrada indep');
});

t('sin tildes, sin mayúsculas y sin espacios de más', () => {
  assert.strictEqual(normalizar('  HABITACIÓN   4 ·  Dormitorio  '), 'hab 4 dormitorio');
});

t('"habitación" y "hab" son lo mismo', () => {
  assert.strictEqual(normalizar('habitación 2 cama 3'), normalizar('Hab 2 · Cama 3'));
});

t('vacío o null no revientan', () => {
  assert.strictEqual(normalizar(''), '');
  assert.strictEqual(normalizar(null), '');
  assert.strictEqual(normalizar('·'), '');
});

console.log('\nEncargado · elegir la cama correcta (nombres nuevos)\n');

t('"hab 2 cama 1" encuentra "Hab 2 · Cama 1"', () => {
  const r = elegir(NUEVO, 'hab 2 cama 1');
  assert.ok(r.cama, 'no ha elegido ninguna');
  assert.strictEqual(r.cama.nombre, 'Hab 2 · Cama 1');
});

t('el nombre tal cual lo da Cloudbeds (con el punto medio) también sirve', () => {
  assert.strictEqual(elegir(NUEVO, 'Hab 9 · Cama 6').cama.nombre, 'Hab 9 · Cama 6');
  assert.strictEqual(elegir(NUEVO, 'Hab 10 · Doble entrada indep.').cama.nombre, 'Hab 10 · Doble entrada indep.');
});

t('"habitación 4 cama 3" y "Hab. 4 - Cama 3" dan la misma cama', () => {
  assert.strictEqual(elegir(NUEVO, 'habitación 4 cama 3').cama.id, '416657-2');
  assert.strictEqual(elegir(NUEVO, 'Hab. 4 - Cama 3').cama.id, '416657-2');
});

t('dos dormitorios con el mismo nombre de tipo no se mezclan (Hab 2 vs Hab 4)', () => {
  assert.strictEqual(elegir(NUEVO, 'hab 2 cama 3').cama.id, '404772-2');
  assert.strictEqual(elegir(NUEVO, 'hab 4 cama 3').cama.id, '416657-2');
});

t('"hab 1" es la Hab 1, NO la Hab 10: se resuelve sola', () => {
  const r = elegir(NUEVO, 'hab 1');
  assert.ok(r.cama, 'debería resolverse a una sola unidad');
  assert.strictEqual(r.cama.nombre, 'Hab 1 · Doble');
});

t('"hab 10" es la Hab 10', () => {
  assert.strictEqual(elegir(NUEVO, 'hab 10').cama.nombre, 'Hab 10 · Doble entrada indep.');
});

t('"habitación 1" y "Habitación 1 · Doble" (el tipo) también dan la Hab 1', () => {
  assert.strictEqual(elegir(NUEVO, 'habitación 1').cama.nombre, 'Hab 1 · Doble');
  assert.strictEqual(elegir(NUEVO, 'Habitación 1 · Doble').cama.nombre, 'Hab 1 · Doble');
});

t('"hab 3" (privada de una unidad) se resuelve; su tipo completo también', () => {
  assert.strictEqual(elegir(NUEVO, 'hab 3').cama.nombre, 'Hab 3 · Adaptada');
  assert.strictEqual(elegir(NUEVO, 'Hab 3 · Doble adaptada').cama.nombre, 'Hab 3 · Adaptada');
});

t('un dormitorio entero ("hab 2") es ambiguo: pregunta por las 6 camas', () => {
  const r = elegir(NUEVO, 'hab 2');
  assert.ok(!r.cama, 'ha elegido una cama con el dormitorio entero');
  assert.strictEqual(r.varias.length, 6);
  assert.ok(r.varias.every(c => c.nombre.startsWith('Hab 2 · ')));
});

t('"hab 4" son solo las 6 camas de la Hab 4 (no mezcla otras habitaciones)', () => {
  const r = elegir(NUEVO, 'hab 4');
  assert.strictEqual(r.varias.length, 6);
  assert.ok(r.varias.every(c => c.nombre.startsWith('Hab 4 · ')));
});

t('"cama 3" sola es ambigua (hay una en cada dormitorio): no elige', () => {
  const r = elegir(NUEVO, 'cama 3');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 5);   // Hab 2, 4, 5, 8 y 9
});

t('un tipo compartido entero también es ambiguo ("dormitorio mixto 4 camas")', () => {
  const r = elegir(NUEVO, 'dormitorio mixto 4 camas');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 8);   // Hab 5 (4) + Hab 8 (4)
});

t('una privada por su tipo único sí se resuelve ("entrada independiente", "litera")', () => {
  assert.strictEqual(elegir(NUEVO, 'entrada independiente').cama.nombre, 'Hab 10 · Doble entrada indep.');
  assert.strictEqual(elegir(NUEVO, 'litera').cama.nombre, 'Hab 6 · Litera matrimonio');
});

t('"doble" a secas es ambiguo (1, 3, 7 y 10)', () => {
  const r = elegir(NUEVO, 'doble');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 4);
});

t('lo que no existe se dice claro (Hab 11, Hab 2 · Cama 7)', () => {
  for (const q of ['hab 11', 'hab 2 cama 7', 'R9(4)']) {
    const r = elegir(NUEVO, q);
    assert.ok(!r.cama, `"${q}" no debería elegir nada`);
    assert.strictEqual(r.varias.length, 0, `"${q}"`);
    assert.ok(r.motivo.includes('No encuentro'), `"${q}"`);
  }
});

t('solo separadores ("·") o vacío: no adivina', () => {
  for (const q of ['', '   ', '·', ' · ']) {
    const r = elegir(NUEVO, q);
    assert.ok(!r.cama, `"${q}"`);
    assert.ok(r.motivo.includes('No me has dicho'), `"${q}"`);
  }
});

t('si hubiera dos unidades con el MISMO nombre exacto, no elige ninguna', () => {
  const dup = [...NUEVO, { id: 'x-0', nombre: 'Hab 1 · Doble', tipo: 'Habitación 1 · Doble', privada: true, bloqueada: false }];
  const r = elegir(dup, 'Hab 1 · Doble');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 2);
});

console.log('\nEncargado · elegir la cama correcta (nombres antiguos, compatibilidad)\n');

t('nombre exacto', () => {
  assert.strictEqual(elegir(ANTIGUO, 'R2(2)').cama.id, '404770-1');
});

t('"R2(1)" NO se confunde con "R2(10)"', () => {
  const r = elegir(ANTIGUO, 'R2(1)');
  assert.ok(r.cama, 'no ha elegido ninguna');
  assert.strictEqual(r.cama.nombre, 'R2(1)');
});

t('sin tildes ni mayúsculas', () => {
  assert.strictEqual(elegir(ANTIGUO, 'room 7').cama.nombre, 'Room 7');
});

t('ante la duda NO elige: pregunta', () => {
  const r = elegir(ANTIGUO, 'R2');
  assert.ok(!r.cama, 'ha elegido una cama con el nombre ambiguo');
  assert.strictEqual(r.varias.length, 3);
});

t('un tipo entero también es ambiguo', () => {
  const r = elegir(ANTIGUO, 'Compartida/Privada 6');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 3);
});

t('lo que no existe se dice claro', () => {
  const r = elegir(ANTIGUO, 'R9(4)');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 0);
  assert.ok(r.motivo.includes('No encuentro'));
});

t('sin nombre, no adivina', () => {
  const r = elegir(ANTIGUO, '');
  assert.ok(!r.cama);
  assert.ok(r.motivo.includes('No me has dicho'));
});

t('una privada por su tipo único sí se resuelve', () => {
  assert.strictEqual(elegir(ANTIGUO, 'entrada independiente').cama.nombre, 'Room 10');
});

console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
process.exit(fallan ? 1 : 0);
