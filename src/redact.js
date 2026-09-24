// src/redact.js
// Redacción profunda de respuestas de la API de Vapi antes de que lleguen al
// navegador (V1.1 — docs/plan-mejora-voz-sep-2026.md). El proxy (src/server.js)
// reenvía el JSON de Vapi tal cual: assistants y calls llevan secretos de
// verdad (server.secret/headers de tools inline, capacidades de escucha en
// vivo de una llamada...). Este módulo clona en profundidad y sustituye esos
// valores por "[redactado]" sin tocar nada más — en particular, nunca toca
// números (contadores de coste/tokens).
//
// Módulo puro: sin red, sin disco, para poder testearlo sin arrancar el
// servidor.
'use strict';

const REDACTED = '[redactado]';

// Claves EXACTAS (comparación case-insensitive) cuyo valor STRING se redacta
// siempre, estén al nivel que estén del árbol. Comparación exacta: "tokens"
// o "promptTokens" NO coinciden con "token" — así no se tocan los contadores
// de coste/tokens de un LLM.
const SENSITIVE_KEYS = new Set([
  'secret',
  'serverurlsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'password',
  'authorization',
  'x-vapi-secret',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Clona en profundidad `value` (objeto o array, típicamente la respuesta de
 * un endpoint de Vapi) redactando:
 *  a) valores string de claves con nombre EXACTO (ver SENSITIVE_KEYS);
 *  b) TODOS los valores de cualquier objeto que cuelgue de una clave
 *     `headers` (se conservan las claves de cabecera, para ver qué existe);
 *  c) `monitor.listenUrl` y `monitor.controlUrl` (capacidades para
 *     escuchar/controlar una llamada en vivo).
 * Nunca muta `value`. No toca nada que no sea uno de estos tres casos —
 * números, booleanos, null y el resto de strings pasan intactos.
 */
function redactDeep(value) {
  return redactNode(value, null);
}

function redactNode(node, parentKeyLower) {
  if (Array.isArray(node)) {
    return node.map((item) => redactNode(item, parentKeyLower));
  }

  if (isPlainObject(node)) {
    const underHeaders = parentKeyLower === 'headers';
    const underMonitor = parentKeyLower === 'monitor';
    const out = {};

    for (const key of Object.keys(node)) {
      const val = node[key];
      const keyLower = key.toLowerCase();

      if (underHeaders) {
        // (b) — cualquier objeto bajo `headers`: todas sus claves se
        // conservan (para ver qué cabeceras existen), todos sus valores se
        // redactan, sea cual sea su tipo.
        out[key] = REDACTED;
        continue;
      }

      if (underMonitor && (keyLower === 'listenurl' || keyLower === 'controlurl') && typeof val === 'string') {
        // (c) monitor.listenUrl / monitor.controlUrl.
        out[key] = REDACTED;
        continue;
      }

      if (SENSITIVE_KEYS.has(keyLower) && typeof val === 'string') {
        // (a) claves con nombre exacto — solo si el valor es string.
        out[key] = REDACTED;
        continue;
      }

      out[key] = redactNode(val, keyLower);
    }

    return out;
  }

  return node;
}

module.exports = { redactDeep, REDACTED };
