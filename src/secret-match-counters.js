// src/secret-match-counters.js
// Contadores en memoria para verificar en vivo, desde /health, que una
// rotación de VAPI_SECRET ha terminado de verdad (V1.1 —
// docs/plan-mejora-voz-sep-2026.md): cuántas peticiones autenticadas han
// coincidido con el secreto actual frente al anterior, y cuántas peticiones
// "legacy" (get_weather / end-of-call-report) han pasado en modo warn sin
// secreto válido. Solo números, fechas ISO y booleanos — NUNCA valores de
// secretos.
//
// Módulo compartido: lo usan src/server.js (vapiAuth, legacyAuthOk) y
// src/encargado/latidos.js (fallback a VAPI_SECRET) para que un único sitio
// lleve la cuenta, sin depender de req/app. Se reinicia en cada arranque del
// proceso — igual que las sesiones de admin y el resto de contadores en
// memoria de este repo.
'use strict';

const state = {
  secretMatches: { current: 0, previous: 0 },
  legacyUnsigned: { getWeather: 0, endOfCall: 0, lastAt: null },
  since: new Date().toISOString(),
};

/**
 * Registra un match de secreto. `kind` es lo que devuelve
 * matchedSecretKind() de src/secret-auth.js: 'current' | 'previous' | null.
 * null no hace nada (no fue un match).
 */
function recordSecretMatch(kind) {
  if (kind === 'current') state.secretMatches.current++;
  else if (kind === 'previous') state.secretMatches.previous++;
}

/**
 * Registra una petición "legacy" (get_weather o el informe de fin de
 * llamada) dejada pasar en modo warn sin secreto válido. `which` es
 * 'getWeather' | 'endOfCall'; cualquier otro valor no hace nada.
 */
function recordLegacyUnsigned(which) {
  if (which !== 'getWeather' && which !== 'endOfCall') return;
  state.legacyUnsigned[which]++;
  state.legacyUnsigned.lastAt = new Date().toISOString();
}

/** Copia inmutable para /health — nunca expone valores de secretos. */
function snapshot() {
  return {
    secretMatches: { current: state.secretMatches.current, previous: state.secretMatches.previous },
    legacyUnsigned: {
      getWeather: state.legacyUnsigned.getWeather,
      endOfCall: state.legacyUnsigned.endOfCall,
      lastAt: state.legacyUnsigned.lastAt,
    },
    countersSince: state.since,
  };
}

module.exports = { recordSecretMatch, recordLegacyUnsigned, snapshot };
