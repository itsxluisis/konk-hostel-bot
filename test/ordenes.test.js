// test/ordenes.test.js — el puente con el Mac.
'use strict';

const assert = require('assert');
const fs = require('fs');

const DIR = '/tmp/enc-test-ordenes';
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ENCARGADO_DATA_DIR = DIR;

const ordenes = require('../src/encargado/ordenes');
const estado = require('../src/encargado/estado');

let pasan = 0, fallan = 0;
const t = (n, fn) => { try { fn(); pasan++; console.log(`  ✓ ${n}`); }
  catch (e) { fallan++; console.log(`  ✗ ${n}\n     ${e.message}`); } };

console.log('\nEncargado · encargos al Mac\n');

t('solo se aceptan tareas de la lista', () => {
  assert.throws(() => ordenes.crear('borrar_todo'), /desconocida/);
  assert.ok(ordenes.crear('emitir_lote').id);
});

t('el Mac recoge lo suyo', () => {
  const o = ordenes.crear('emitir_lote', { periodo: 'X' });
  const recogidas = ordenes.recoger('facturador-konk');
  assert.ok(recogidas.some(x => x.id === o.id), 'no ha recogido su orden');
});

t('no se entrega dos veces (dos sondeos seguidos)', () => {
  const o = ordenes.crear('emitir_lote', { periodo: 'Y' });
  ordenes.recoger('facturador-konk');
  const segunda = ordenes.recoger('facturador-konk');
  assert.ok(!segunda.some(x => x.id === o.id), 'la ha entregado dos veces');
});

t('otro agente no recoge lo ajeno', () => {
  const o = ordenes.crear('emitir_lote', { periodo: 'Z' });
  const otras = ordenes.recoger('vigilante-cobros');
  assert.ok(!otras.some(x => x.id === o.id));
});

t('el resultado queda registrado', () => {
  const o = ordenes.crear('preparar_lote');
  ordenes.recoger('facturador-konk');
  const r = ordenes.resultado(o.id, { ok: true, salida: 'listo' });
  assert.strictEqual(r.estado, 'hecha');
  assert.strictEqual(r.salida, 'listo');
});

t('un fallo también queda registrado', () => {
  const o = ordenes.crear('preparar_lote');
  const r = ordenes.resultado(o.id, { ok: false, salida: 'reventó' });
  assert.strictEqual(r.estado, 'fallida');
});

t('informar de una orden inventada no cuela', () => {
  assert.throws(() => ordenes.resultado('nope', { ok: true }), /no existe/);
});

t('una orden vieja no se entrega: el Mac llevaba días apagado', () => {
  const o = ordenes.crear('emitir_lote', { periodo: 'vieja' });
  estado.actualizarOrden(o.id, {
    creada: new Date(Date.now() - 99 * 3600000).toISOString(),
  });
  const recogidas = ordenes.recoger('facturador-konk');
  assert.ok(!recogidas.some(x => x.id === o.id), 'ha entregado una orden caducada');
  assert.ok(ordenes.olvidadas().some(x => x.id === o.id), 'no figura como olvidada');
});

console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
process.exit(fallan ? 1 : 0);
