// src/admin-session.js
// Sesiones del panel admin — H3 "panel sin secretos" (Tanda V1).
// El navegador ya no recibe VAPI_API_KEY ni VAPI_SECRET: /admin/login emite
// un token de sesión opaco, sin relación con ningún secreto de Vapi, que el
// panel manda de vuelta en la cabecera x-admin-token.
//
// Guardado en memoria (se pierde en cada redeploy, como cualquier estado del
// proceso): obliga a volver a hacer login tras un despliegue, que es lo
// esperado en un panel de administración sin base de datos.
'use strict';

const crypto = require('crypto');
const { timingSafeEqualStr } = require('./secret-auth');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

const sessions = new Map(); // token -> expiresAt (ms epoch)

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token || typeof token !== 'string') return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function invalidateSession(token) {
  if (token) sessions.delete(token);
}

/**
 * HTTP Basic auth con ADMIN_USER/ADMIN_PASSWORD — solo por cabecera
 * Authorization, nunca por query string. Pensada para diagnóstico por curl
 * (igual que antes se hacía con x-vapi-secret), sin depender de haber hecho
 * login primero en el panel.
 */
function checkBasicAuth(headerValue, adminUser, adminPass) {
  if (!headerValue || !adminPass || typeof headerValue !== 'string') return false;
  if (!headerValue.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // Tiempo constante: quien intenta adivinar ADMIN_PASSWORD no debe poder
  // medir cuánto tarda la comparación para inferir cuántos caracteres acertó.
  return timingSafeEqualStr(user, adminUser) && timingSafeEqualStr(pass, adminPass);
}

module.exports = {
  createSession,
  isValidSession,
  invalidateSession,
  checkBasicAuth,
  SESSION_TTL_MS,
};
