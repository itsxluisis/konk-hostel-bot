// test/admin-session.test.js — H3 panel sin secretos: sesiones del panel admin
// y Basic auth con ADMIN_USER/ADMIN_PASSWORD. Sin red, sin servidor.
'use strict';

const assert = require('assert');
const adminSession = require('../src/admin-session');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nadmin-session · sesiones del panel y Basic auth\n');

t('createSession devuelve un token no vacío y no es un secreto conocido', () => {
  const token = adminSession.createSession();
  assert.ok(typeof token === 'string' && token.length >= 32, 'token demasiado corto/no-string');
});

t('un token recién creado es válido', () => {
  const token = adminSession.createSession();
  assert.strictEqual(adminSession.isValidSession(token), true);
});

t('un token aleatorio/no emitido es inválido', () => {
  assert.strictEqual(adminSession.isValidSession('token-que-nunca-se-emitio'), false);
});

t('vacío/undefined/null nunca son sesión válida', () => {
  assert.strictEqual(adminSession.isValidSession(''), false);
  assert.strictEqual(adminSession.isValidSession(undefined), false);
  assert.strictEqual(adminSession.isValidSession(null), false);
});

t('invalidateSession revoca el token: deja de ser válido', () => {
  const token = adminSession.createSession();
  assert.strictEqual(adminSession.isValidSession(token), true);
  adminSession.invalidateSession(token);
  assert.strictEqual(adminSession.isValidSession(token), false);
});

t('dos sesiones son independientes', () => {
  const a = adminSession.createSession();
  const b = adminSession.createSession();
  assert.notStrictEqual(a, b);
  adminSession.invalidateSession(a);
  assert.strictEqual(adminSession.isValidSession(a), false);
  assert.strictEqual(adminSession.isValidSession(b), true);
});

// ─── Basic auth ───────────────────────────────────────────────────────────────
function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

t('checkBasicAuth acepta user/pass correctos', () => {
  const header = basicHeader('admin', 'supersecreto');
  assert.strictEqual(adminSession.checkBasicAuth(header, 'admin', 'supersecreto'), true);
});

t('checkBasicAuth rechaza contraseña incorrecta', () => {
  const header = basicHeader('admin', 'mala');
  assert.strictEqual(adminSession.checkBasicAuth(header, 'admin', 'supersecreto'), false);
});

t('checkBasicAuth rechaza usuario incorrecto', () => {
  const header = basicHeader('otro', 'supersecreto');
  assert.strictEqual(adminSession.checkBasicAuth(header, 'admin', 'supersecreto'), false);
});

t('checkBasicAuth rechaza cabeceras que no son "Basic "', () => {
  assert.strictEqual(adminSession.checkBasicAuth('Bearer algo', 'admin', 'supersecreto'), false);
  assert.strictEqual(adminSession.checkBasicAuth(undefined, 'admin', 'supersecreto'), false);
});

t('checkBasicAuth rechaza si no hay ADMIN_PASSWORD configurado (adminPass vacío)', () => {
  const header = basicHeader('admin', 'lo-que-sea');
  assert.strictEqual(adminSession.checkBasicAuth(header, 'admin', undefined), false);
  assert.strictEqual(adminSession.checkBasicAuth(header, 'admin', ''), false);
});

t('checkBasicAuth no revienta con base64 corrupto', () => {
  assert.strictEqual(adminSession.checkBasicAuth('Basic %%%no-es-base64%%%', 'admin', 'x'), false);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
