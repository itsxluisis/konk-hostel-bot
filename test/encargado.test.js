// test/encargado.test.js — lógica del Encargado del Konk (sin red ni disco)
'use strict';

const assert = require('assert');
const { debeAlertar } = require('../src/encargado/vigilancia');
const { AGENTES } = require('../src/encargado/config');

const vigilante = AGENTES['vigilante-cobros'];   // L-S 09:00, margen 120 → límite 11:00
const facturador = AGENTES['facturador-konk'];   // lunes 09:00

const jueves = { iso: '2026-09-10', minutos: 16 * 60, dia: 4 };
const arranqueViejo = { iso: '2026-09-01', minutos: 8 * 60 };

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nEncargado · ¿cuándo hay que dar la alarma?\n');

t('alerta si venció el plazo y no ha latido', () => {
  const r = debeAlertar(vigilante, jueves, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('calla si ya latió hoy', () => {
  const latido = { ts: '2026-09-10T09:05:00.000Z' };
  const r = debeAlertar(vigilante, jueves, arranqueViejo, latido);
  assert.strictEqual(r.alerta, false);
});

t('un latido de AYER no vale para hoy', () => {
  const latido = { ts: '2026-09-09T09:05:00.000Z' };
  const r = debeAlertar(vigilante, jueves, arranqueViejo, latido);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('calla dentro de plazo (10:00, límite 11:00)', () => {
  const temprano = { ...jueves, minutos: 10 * 60 };
  const r = debeAlertar(vigilante, temprano, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('alerta justo al vencer el plazo (11:00)', () => {
  const justo = { ...jueves, minutos: 11 * 60 };
  const r = debeAlertar(vigilante, justo, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('el facturador no se espera en jueves', () => {
  const r = debeAlertar(facturador, jueves, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('el facturador SÍ se espera el lunes', () => {
  const lunes = { iso: '2026-09-14', minutos: 16 * 60, dia: 1 };
  const r = debeAlertar(facturador, lunes, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('el vigilante NO se espera en domingo', () => {
  const domingo = { iso: '2026-09-13', minutos: 16 * 60, dia: 0 };
  const r = debeAlertar(vigilante, domingo, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('sin falso positivo si arrancamos tarde el mismo día', () => {
  const arranqueTarde = { iso: '2026-09-10', minutos: 15 * 60 };
  const r = debeAlertar(vigilante, jueves, arranqueTarde, null);
  assert.strictEqual(r.alerta, false, 'no debe alarmar: no vio la ventana');
});

t('sí alerta si arrancamos ANTES del plazo el mismo día', () => {
  const arranquePronto = { iso: '2026-09-10', minutos: 7 * 60 };
  const r = debeAlertar(vigilante, jueves, arranquePronto, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
process.exit(fallan ? 1 : 0);
