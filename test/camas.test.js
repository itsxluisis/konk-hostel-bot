// test/camas.test.js — elegir bien la cama, o no elegir ninguna.
'use strict';

const assert = require('assert');
const { elegir } = require('../src/encargado/inventario');

// El inventario real del Konk, resumido.
const INV = [
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

console.log('\nEncargado · elegir la cama correcta\n');

t('nombre exacto', () => {
  assert.strictEqual(elegir(INV, 'R2(2)').cama.id, '404770-1');
});

t('"R2(1)" NO se confunde con "R2(10)"', () => {
  const r = elegir(INV, 'R2(1)');
  assert.ok(r.cama, 'no ha elegido ninguna');
  assert.strictEqual(r.cama.nombre, 'R2(1)');
});

t('sin tildes ni mayúsculas', () => {
  assert.strictEqual(elegir(INV, 'room 7').cama.nombre, 'Room 7');
});

t('ante la duda NO elige: pregunta', () => {
  const r = elegir(INV, 'R2');
  assert.ok(!r.cama, 'ha elegido una cama con el nombre ambiguo');
  assert.strictEqual(r.varias.length, 3);
});

t('un tipo entero también es ambiguo', () => {
  const r = elegir(INV, 'Compartida/Privada 6');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 3);
});

t('lo que no existe se dice claro', () => {
  const r = elegir(INV, 'R9(4)');
  assert.ok(!r.cama);
  assert.strictEqual(r.varias.length, 0);
  assert.ok(r.motivo.includes('No encuentro'));
});

t('sin nombre, no adivina', () => {
  const r = elegir(INV, '');
  assert.ok(!r.cama);
  assert.ok(r.motivo.includes('No me has dicho'));
});

t('una privada por su tipo único sí se resuelve', () => {
  assert.strictEqual(elegir(INV, 'entrada independiente').cama.nombre, 'Room 10');
});

console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
process.exit(fallan ? 1 : 0);
