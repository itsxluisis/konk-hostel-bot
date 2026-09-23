// src/login-rate-limit.js
// Límite de fuerza bruta compartido entre POST /admin/login y cualquier
// intento fallido de HTTP Basic en rutas protegidas por adminAuth/vapiAuth
// (ver src/server.js). Contador en memoria por IP, 10 intentos FALLIDOS /
// 15 min — si solo protegiéramos /admin/login, se podría probar
// ADMIN_PASSWORD sin límite contra cualquier otra ruta /admin/*.
//
// Purga: cada llamada a isBlocked()/registerFailedAttempt() barre primero
// las entradas cuya ventana de 15 min ya expiró, así el Map nunca acumula
// para siempre una entrada por cada IP que falló alguna vez mientras viva
// el proceso. Sin setInterval a propósito: no hay temporizador que purgar
// ni que dejar colgado al cerrar el proceso (importante en los tests, que
// arrancan y paran el servidor en el mismo `node test/....js`).
'use strict';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attemptsByIp = new Map(); // ip -> { count, windowStart }

function isExpired(entry, now) {
  return now - entry.windowStart > WINDOW_MS;
}

/** Barre las entradas con la ventana ya vencida. Barato: solo recorre IPs con algún fallo reciente. */
function purgeExpired(now = Date.now()) {
  for (const [ip, entry] of attemptsByIp) {
    if (isExpired(entry, now)) attemptsByIp.delete(ip);
  }
}

function isBlocked(ip) {
  const now = Date.now();
  purgeExpired(now);
  const entry = attemptsByIp.get(ip);
  if (!entry) return false;
  return entry.count > MAX_ATTEMPTS;
}

/** Cuenta un intento fallido (login o Basic auth) para esta IP. */
function registerFailedAttempt(ip) {
  const now = Date.now();
  purgeExpired(now);
  const entry = attemptsByIp.get(ip);
  if (!entry || isExpired(entry, now)) {
    attemptsByIp.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

module.exports = {
  isBlocked,
  registerFailedAttempt,
  WINDOW_MS,
  MAX_ATTEMPTS,
  // Solo para tests: inspeccionar/preparar el mapa sin depender del reloj real.
  _has: (ip) => attemptsByIp.has(ip),
  _size: () => attemptsByIp.size,
  _set: (ip, entry) => attemptsByIp.set(ip, entry),
  _purgeNow: () => purgeExpired(),
};
