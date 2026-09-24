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

// Coincidencia por SUBCADENA (case-insensitive) en el nombre de la clave,
// para el valor STRING de esa clave, esté al nivel que esté del árbol.
// Ampliación pedida por el auditor tras la V1.1: la lista de nombres
// EXACTOS se quedaba corta con variantes reales de Vapi/proveedores que no
// se pueden enumerar todas (clientSecret, webhookSecret, privateKey,
// bearerToken, apiToken, credentials[].apiKey, transcriber.apiKey...). Lo
// que impide que se toquen los contadores de coste/tokens de un LLM (p. ej.
// `promptTokens`, que SÍ contiene "token" como subcadena) es el guard de
// tipo — más abajo, `typeof val === 'string'` — no el nombre de la clave.
const SENSITIVE_KEY_RE = /secret|password|token|apikey|api[_-]?key|authorization|private[_-]?key/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Clona en profundidad `value` (objeto o array, típicamente la respuesta de
 * un endpoint de Vapi) redactando:
 *  a) valores string de claves cuyo nombre CONTIENE alguna palabra
 *     sensible (ver SENSITIVE_KEY_RE) — comparación por subcadena;
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

      if (SENSITIVE_KEY_RE.test(keyLower) && typeof val === 'string') {
        // (a) subcadena sensible en el nombre de la clave — solo si el
        // valor es string (ver el comentario de SENSITIVE_KEY_RE arriba).
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
