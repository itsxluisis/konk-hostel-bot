// src/secret-auth.js
// Comparación del secreto de Vapi admitiendo un secreto "previous" mientras
// dura una rotación (Tanda V1 — panel sin secretos, docs/plan-mejora-voz-sep-2026.md).
// Módulo puro: sin red, sin disco, para poder testearlo sin arrancar el servidor.
'use strict';

const crypto = require('crypto');

/** Quita el prefijo "Bearer " si lo hay (case-insensitive). */
function normalizeBearer(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/^Bearer\s+/i, '');
}

/**
 * Compara dos strings en tiempo constante (crypto.timingSafeEqual), para no
 * filtrar por temporización cuánto de un secreto ha acertado un atacante.
 * Si las longitudes difieren, rechaza sin comparar — timingSafeEqual exige
 * buffers del mismo tamaño o lanza, así que este es el único atajo posible
 * (comparar secretos de longitud distinta ya no es un secreto que se pueda
 * adivinar carácter a carácter, así que no hace falta ocultar esa diferencia).
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Como matchesConfiguredSecret, pero en vez de un boolean dice CUÁL de los
 * dos secretos ha coincidido: 'current' | 'previous' | null. Pensada para
 * los contadores de verificación de rotación de /health (V1.1 —
 * docs/plan-mejora-voz-sep-2026.md): nunca decide autorización por sí
 * misma (eso lo sigue haciendo matchesConfiguredSecret, más abajo, que
 * delega en esta función y por tanto se comporta exactamente igual que
 * antes). Nunca compara contra valores vacíos — un `current`/`previous`
 * vacío o undefined jamás produce un "match".
 */
function matchedSecretKind(provided, current, previous) {
  const p = normalizeBearer(provided);
  if (!p) return null;
  if (current && timingSafeEqualStr(p, current)) return 'current';
  if (previous && timingSafeEqualStr(p, previous)) return 'previous';
  return null;
}

/**
 * true si `provided` (con o sin prefijo Bearer) coincide, en tiempo
 * constante, con `current` o, si está definido, con `previous`. Nunca
 * compara contra valores vacíos — un `current`/`previous` vacío o
 * undefined jamás produce un "match".
 */
function matchesConfiguredSecret(provided, current, previous) {
  return matchedSecretKind(provided, current, previous) !== null;
}

module.exports = { normalizeBearer, matchesConfiguredSecret, matchedSecretKind, timingSafeEqualStr };
