// src/vapi-proxy.js
// Proxy server-side a la API de Vapi (H3 — panel sin secretos, Tanda V1).
// La VAPI_API_KEY vive solo aquí, en el servidor; el panel nunca la recibe.
//
// Allow-list explícita: SOLO las rutas listadas en ROUTES son alcanzables.
// Nunca se construye una URL a partir de lo que mande el cliente — esto no
// es un proxy genérico a "cualquier ruta de api.vapi.ai".
'use strict';

const VAPI_BASE = 'https://api.vapi.ai';

const ROUTES = {
  listCalls: {
    method: 'GET',
    path: () => '/call',
  },
  getCall: {
    method: 'GET',
    path: (params) => `/call/${encodeURIComponent(params.id)}`,
  },
  listAssistants: {
    method: 'GET',
    path: () => '/assistant',
  },
  getAssistant: {
    method: 'GET',
    path: (params) => `/assistant/${encodeURIComponent(params.id)}`,
  },
  patchAssistant: {
    method: 'PATCH',
    path: (params) => `/assistant/${encodeURIComponent(params.id)}`,
  },
};

class VapiProxyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VapiProxyError';
    this.code = code;
  }
}

function apiKey() {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new VapiProxyError('VAPI_API_KEY no configurado', 'NO_API_KEY');
  return key;
}

/**
 * Llama a una ruta de la allow-list. `routeKey` tiene que ser una clave
 * literal de ROUTES: cualquier otra cosa se rechaza sin tocar la red.
 */
async function call(routeKey, { params = {}, query = {}, body } = {}) {
  const route = ROUTES[routeKey];
  if (!route) {
    throw new VapiProxyError(`Ruta Vapi no permitida: ${routeKey}`, 'ROUTE_NOT_ALLOWED');
  }

  const axios = require('axios');
  const res = await axios({
    method: route.method,
    url: VAPI_BASE + route.path(params),
    params: query,
    data: body,
    headers: { Authorization: `Bearer ${apiKey()}` },
    timeout: 10000,
  });
  return res.data;
}

module.exports = { call, ROUTES, VapiProxyError };
