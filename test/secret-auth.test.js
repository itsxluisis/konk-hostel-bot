// test/secret-auth.test.js — H3 rotación: VAPI_SECRET_PREVIOUS aceptado/rechazado.
// Módulo puro (src/secret-auth.js), sin red ni servidor: se testea directo.
'use strict';

const assert = require('assert');
const { normalizeBearer, matchesConfiguredSecret } = require('../src/secret-auth');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nsecret-auth · rotación de VAPI_SECRET (VAPI_SECRET_PREVIOUS)\n');

t('acepta el secreto actual', () => {
  assert.strictEqual(matchesConfiguredSecret('nuevo', 'nuevo', null), true);
});

t('rechaza el secreto viejo si NO hay VAPI_SECRET_PREVIOUS configurado', () => {
  assert.strictEqual(matchesConfiguredSecret('viejo', 'nuevo', null), false);
  assert.strictEqual(matchesConfiguredSecret('viejo', 'nuevo', undefined), false);
  assert.strictEqual(matchesConfiguredSecret('viejo', 'nuevo', ''), false);
});

t('acepta el secreto viejo cuando VAPI_SECRET_PREVIOUS está definida', () => {
  assert.strictEqual(matchesConfiguredSecret('viejo', 'nuevo', 'viejo'), true);
});

t('sigue aceptando el nuevo aunque haya VAPI_SECRET_PREVIOUS', () => {
  assert.strictEqual(matchesConfiguredSecret('nuevo', 'nuevo', 'viejo'), true);
});

t('rechaza cualquier otro valor durante la rotación', () => {
  assert.strictEqual(matchesConfiguredSecret('otro-cualquiera', 'nuevo', 'viejo'), false);
});

t('quita el prefijo "Bearer " antes de comparar (case-insensitive)', () => {
  assert.strictEqual(matchesConfiguredSecret('Bearer nuevo', 'nuevo', null), true);
  assert.strictEqual(matchesConfiguredSecret('bearer nuevo', 'nuevo', null), true);
  assert.strictEqual(matchesConfiguredSecret('Bearer viejo', 'nuevo', 'viejo'), true);
});

t('rechaza vacío/undefined/null sin reventar', () => {
  assert.strictEqual(matchesConfiguredSecret('', 'nuevo', 'viejo'), false);
  assert.strictEqual(matchesConfiguredSecret(undefined, 'nuevo', 'viejo'), false);
  assert.strictEqual(matchesConfiguredSecret(null, 'nuevo', 'viejo'), false);
});

t('nunca compara contra un current/previous vacíos (no "matchea todo")', () => {
  assert.strictEqual(matchesConfiguredSecret('', '', ''), false);
  assert.strictEqual(matchesConfiguredSecret('cualquiera', '', ''), false);
});

t('normalizeBearer deja pasar valores no-string tal cual', () => {
  assert.strictEqual(normalizeBearer(undefined), undefined);
  assert.strictEqual(normalizeBearer(null), null);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
