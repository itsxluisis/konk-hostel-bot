// src/encargado/estado.js
// Memoria del encargado: quién ha dado señales de vida y cuándo.
// Fichero JSON simple. Si el disco no es persistente (redeploy), se
// reconstruye solo con los latidos del día siguiente.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.ENCARGADO_DATA_DIR || path.join(__dirname, '../../data');
const FICHERO = path.join(DIR, 'encargado.json');

// Momento en que arrancó este proceso: no alarmamos por ventanas
// que ya habían pasado antes de estar vivos (evita falsos positivos).
const ARRANQUE = new Date();

let cache = null;

function leer() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FICHERO, 'utf8'));
  } catch {
    cache = { latidos: {}, alertado: {} };
  }
  return cache;
}

function guardar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FICHERO, JSON.stringify(cache, null, 2));
  } catch (err) {
    // Nunca tumbar el proceso por no poder escribir estado.
    console.error('[Encargado] No se pudo guardar estado:', err.message);
  }
}

function registrarLatido(agente, datos) {
  const e = leer();
  e.latidos[agente] = {
    ts: new Date().toISOString(),
    ok: datos.ok !== false,
    resumen: datos.resumen || '',
    detalle: datos.detalle || null,
  };
  guardar();
  return e.latidos[agente];
}

function ultimoLatido(agente) {
  return leer().latidos[agente] || null;
}

function todosLosLatidos() {
  return { ...leer().latidos };
}

// Marca que ya avisamos de algo hoy, para no repetir el mismo aviso.
function yaAvisado(clave) {
  return Boolean(leer().alertado[clave]);
}

function marcarAvisado(clave) {
  const e = leer();
  e.alertado[clave] = new Date().toISOString();
  // Limpieza: nos quedamos con las 200 marcas más recientes.
  const claves = Object.keys(e.alertado);
  if (claves.length > 200) {
    claves.sort((a, b) => new Date(e.alertado[a]) - new Date(e.alertado[b]))
      .slice(0, claves.length - 200)
      .forEach(k => delete e.alertado[k]);
  }
  guardar();
}

// El mensaje de ESTADO fijado: guardamos su id para reescribirlo en sitio
// en vez de llenar el chat de mensajes nuevos.
function guardarFijado(messageId) {
  const e = leer();
  e.fijado = { messageId, desde: new Date().toISOString() };
  guardar();
}

function leerFijado() {
  return leer().fijado || null;
}

module.exports = {
  ARRANQUE, FICHERO,
  guardarFijado, leerFijado,
  registrarLatido, ultimoLatido, todosLosLatidos,
  yaAvisado, marcarAvisado,
};
