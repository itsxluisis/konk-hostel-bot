// test/login-rate-limit.test.js — re-auditoría V1: el Map de intentos fallidos
// purga las entradas cuya ventana de 15 min ya expiró, en vez de acumular
// para siempre una entrada por cada IP que falló alguna vez.
// Módulo puro (src/login-rate-limit.js), sin red ni servidor.
'use strict';

const assert = require('assert');
const rl = require('../src/login-rate-limit');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nlogin-rate-limit · límite de fuerza bruta y purga de entradas vencidas\n');

t('una IP sin fallos previos no está bloqueada', () => {
  assert.strictEqual(rl.isBlocked('ip-nueva-sin-historial'), false);
});

t('tras MAX_ATTEMPTS+1 fallos, la IP queda bloqueada', () => {
  const ip = 'ip-que-falla-mucho';
  for (let i = 0; i <= rl.MAX_ATTEMPTS; i++) rl.registerFailedAttempt(ip);
  assert.strictEqual(rl.isBlocked(ip), true);
});

t('purga: varias IPs con marca de tiempo vieja (ventana vencida) desaparecen del mapa', () => {
  const vieja = Date.now() - (rl.WINDOW_MS + 1000);
  rl._set('ip-vieja-a', { count: 3, windowStart: vieja });
  rl._set('ip-vieja-b', { count: rl.MAX_ATTEMPTS + 5, windowStart: vieja }); // incluso una "bloqueada"
  rl._set('ip-vieja-c', { count: 1, windowStart: vieja });
  assert.ok(rl._has('ip-vieja-a') && rl._has('ip-vieja-b') && rl._has('ip-vieja-c'), 'setup: deben existir antes de purgar');

  rl._purgeNow();

  assert.strictEqual(rl._has('ip-vieja-a'), false, 'ip-vieja-a debía purgarse');
  assert.strictEqual(rl._has('ip-vieja-b'), false, 'ip-vieja-b debía purgarse (aunque estuviera "bloqueada")');
  assert.strictEqual(rl._has('ip-vieja-c'), false, 'ip-vieja-c debía purgarse');
});

t('la purga NO toca entradas dentro de la ventana de 15 min', () => {
  rl._set('ip-fresca', { count: 4, windowStart: Date.now() });
  rl._purgeNow();
  assert.ok(rl._has('ip-fresca'), 'una entrada reciente no debe purgarse');
});

t('isBlocked() purga entradas ajenas vencidas como efecto colateral (no hace falta llamar a _purgeNow)', () => {
  const vieja = Date.now() - (rl.WINDOW_MS + 1000);
  rl._set('ip-vieja-que-isBlocked-debe-limpiar', { count: rl.MAX_ATTEMPTS + 1, windowStart: vieja });
  assert.ok(rl._has('ip-vieja-que-isBlocked-debe-limpiar'));

  rl.isBlocked('cualquier-otra-ip-que-consultamos'); // dispara la purga interna

  assert.strictEqual(rl._has('ip-vieja-que-isBlocked-debe-limpiar'), false);
});

t('registerFailedAttempt() también purga entradas ajenas vencidas', () => {
  const vieja = Date.now() - (rl.WINDOW_MS + 1000);
  rl._set('ip-vieja-que-register-debe-limpiar', { count: 2, windowStart: vieja });
  assert.ok(rl._has('ip-vieja-que-register-debe-limpiar'));

  rl.registerFailedAttempt('otra-ip-distinta-cualquiera');

  assert.strictEqual(rl._has('ip-vieja-que-register-debe-limpiar'), false);
});

t('una entrada vencida para la MISMA IP se trata como si no existiera (reinicia el contador)', () => {
  const ip = 'ip-con-historial-viejo';
  const vieja = Date.now() - (rl.WINDOW_MS + 1000);
  rl._set(ip, { count: rl.MAX_ATTEMPTS + 5, windowStart: vieja }); // "bloqueada" en el pasado
  assert.strictEqual(rl.isBlocked(ip), false, 'una ventana vencida no debe seguir bloqueando');
  rl.registerFailedAttempt(ip);
  assert.strictEqual(rl.isBlocked(ip), false, 'un solo fallo tras expirar no debe bloquear de nuevo');
});

t('el mapa no crece sin límite: tras purgar, su tamaño refleja solo entradas vivas', () => {
  const vieja = Date.now() - (rl.WINDOW_MS + 1000);
  for (let i = 0; i < 5; i++) rl._set(`ip-a-purgar-${i}`, { count: 1, windowStart: vieja });
  rl._set('ip-viva', { count: 1, windowStart: Date.now() });
  rl._purgeNow();
  assert.strictEqual(rl._has('ip-viva'), true);
  for (let i = 0; i < 5; i++) assert.strictEqual(rl._has(`ip-a-purgar-${i}`), false);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
