// test/secret-match-counters.test.js — V1.1: contadores de verificación de
// rotación para /health (docs/plan-mejora-voz-sep-2026.md). Módulo puro
// (src/secret-match-counters.js), sin red ni servidor.
//
// El módulo mantiene estado a nivel de proceso (module-level), así que este
// archivo hace sus propias comprobaciones "antes/después" en vez de asumir
// que arranca en cero — igual que hace el resto de tests de este repo con
// singletons en memoria (p. ej. test/login-rate-limit.test.js).
'use strict';

const assert = require('assert');
const counters = require('../src/secret-match-counters');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nsecret-match-counters · contadores de rotación para /health\n');

t('snapshot() inicial tiene la forma correcta (números, ISO, null)', () => {
  const s = counters.snapshot();
  assert.strictEqual(typeof s.secretMatches.current, 'number');
  assert.strictEqual(typeof s.secretMatches.previous, 'number');
  assert.strictEqual(typeof s.legacyUnsigned.getWeather, 'number');
  assert.strictEqual(typeof s.legacyUnsigned.endOfCall, 'number');
  assert.strictEqual(s.legacyUnsigned.lastAt, null, 'lastAt empieza en null hasta la primera petición legacy');
  assert.ok(!Number.isNaN(Date.parse(s.countersSince)), 'countersSince debe ser una fecha ISO parseable');
});

t('recordSecretMatch(\'current\') solo sube secretMatches.current', () => {
  const before = counters.snapshot();
  counters.recordSecretMatch('current');
  const after = counters.snapshot();
  assert.strictEqual(after.secretMatches.current, before.secretMatches.current + 1);
  assert.strictEqual(after.secretMatches.previous, before.secretMatches.previous);
});

t('recordSecretMatch(\'previous\') solo sube secretMatches.previous', () => {
  const before = counters.snapshot();
  counters.recordSecretMatch('previous');
  const after = counters.snapshot();
  assert.strictEqual(after.secretMatches.previous, before.secretMatches.previous + 1);
  assert.strictEqual(after.secretMatches.current, before.secretMatches.current);
});

t('recordSecretMatch(null) no hace nada (no fue un match)', () => {
  const before = counters.snapshot();
  counters.recordSecretMatch(null);
  const after = counters.snapshot();
  assert.deepStrictEqual(after.secretMatches, before.secretMatches);
});

t('recordLegacyUnsigned(\'getWeather\') sube ese contador y actualiza lastAt', () => {
  const before = counters.snapshot();
  counters.recordLegacyUnsigned('getWeather');
  const after = counters.snapshot();
  assert.strictEqual(after.legacyUnsigned.getWeather, before.legacyUnsigned.getWeather + 1);
  assert.strictEqual(after.legacyUnsigned.endOfCall, before.legacyUnsigned.endOfCall);
  assert.ok(after.legacyUnsigned.lastAt && !Number.isNaN(Date.parse(after.legacyUnsigned.lastAt)));
});

t('recordLegacyUnsigned(\'endOfCall\') sube ese contador de forma independiente', () => {
  const before = counters.snapshot();
  counters.recordLegacyUnsigned('endOfCall');
  const after = counters.snapshot();
  assert.strictEqual(after.legacyUnsigned.endOfCall, before.legacyUnsigned.endOfCall + 1);
  assert.strictEqual(after.legacyUnsigned.getWeather, before.legacyUnsigned.getWeather);
});

t('recordLegacyUnsigned con un valor desconocido no hace nada', () => {
  const before = counters.snapshot();
  counters.recordLegacyUnsigned('otraCosa');
  const after = counters.snapshot();
  assert.deepStrictEqual(after.legacyUnsigned, before.legacyUnsigned);
});

t('snapshot() devuelve una copia: mutarla no afecta al estado interno', () => {
  const s1 = counters.snapshot();
  s1.secretMatches.current = 99999;
  s1.legacyUnsigned.getWeather = 99999;
  const s2 = counters.snapshot();
  assert.notStrictEqual(s2.secretMatches.current, 99999);
  assert.notStrictEqual(s2.legacyUnsigned.getWeather, 99999);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
