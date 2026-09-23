// src/secret-auth.js
// Comparación del secreto de Vapi admitiendo un secreto "previous" mientras
// dura una rotación (Tanda V1 — panel sin secretos, docs/plan-mejora-voz-sep-2026.md).
// Módulo puro: sin red, sin disco, para poder testearlo sin arrancar el servidor.
'use strict';

/** Quita el prefijo "Bearer " si lo hay (case-insensitive). */
function normalizeBearer(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/^Bearer\s+/i, '');
}

/**
 * true si `provided` (con o sin prefijo Bearer) coincide con `current` o,
 * si está definido, con `previous`. Nunca compara contra valores vacíos —
 * un `current`/`previous` vacío o undefined jamás produce un "match".
 */
function matchesConfiguredSecret(provided, current, previous) {
  const p = normalizeBearer(provided);
  if (!p) return false;
  if (current && p === current) return true;
  if (previous && p === previous) return true;
  return false;
}

module.exports = { normalizeBearer, matchesConfiguredSecret };
