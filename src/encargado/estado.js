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
function guardarFijado(messageId, hilo = null) {
  const e = leer();
  e.fijado = { messageId, hilo: hilo ? Number(hilo) : null, desde: new Date().toISOString() };
  guardar();
}

function leerFijado() {
  return leer().fijado || null;
}

// Ids de los temas del grupo que hemos creado. Telegram no deja listarlos,
// así que hay que recordarlos nosotros.
function guardarTemas(mapa) {
  const e = leer();
  e.temas = { ...(e.temas || {}), ...mapa };
  guardar();
}

function leerTemas() {
  return leer().temas || {};
}

// Propuestas de acción pendientes de confirmar.
function guardarPropuesta(p) {
  const e = leer();
  e.propuestas = e.propuestas || {};
  e.propuestas[p.id] = p;
  // Se limpian las viejas para que el fichero no crezca sin fin.
  const ids = Object.keys(e.propuestas);
  if (ids.length > 100) {
    ids.sort((a, b) => new Date(e.propuestas[a].creada) - new Date(e.propuestas[b].creada))
      .slice(0, ids.length - 100)
      .forEach(k => delete e.propuestas[k]);
  }
  guardar();
}

function leerPropuesta(id) {
  return (leer().propuestas || {})[id] || null;
}

function marcarPropuestaHecha(id) {
  const e = leer();
  if (e.propuestas && e.propuestas[id]) {
    e.propuestas[id].hecha = new Date().toISOString();
    guardar();
  }
}

function borrarPropuesta(id) {
  const e = leer();
  if (e.propuestas) { delete e.propuestas[id]; guardar(); }
}

// Silencios: hasta qué día no molestar con un agente.
function guardarSilencio(agente, hasta) {
  const e = leer();
  e.silencios = e.silencios || {};
  if (hasta) e.silencios[agente] = hasta; else delete e.silencios[agente];
  guardar();
}

function leerSilencio(agente) {
  const s = (leer().silencios || {})[agente];
  if (!s) return null;
  // Un silencio caducado es como si no estuviera.
  return s >= new Date().toISOString().slice(0, 10) ? s : null;
}

// Quién manda. Se puede fijar por variable de entorno o guardar aquí.
function guardarJefes(ids) {
  const e = leer();
  e.jefes = (ids || []).map(String);
  guardar();
}

function leerJefes() {
  return leer().jefes || [];
}

// Órdenes para los agentes que viven en el Mac.
function guardarOrden(o) {
  const e = leer();
  e.ordenes = e.ordenes || {};
  e.ordenes[o.id] = o;
  const ids = Object.keys(e.ordenes);
  if (ids.length > 100) {
    ids.sort((a, b) => new Date(e.ordenes[a].creada) - new Date(e.ordenes[b].creada))
      .slice(0, ids.length - 100).forEach(k => delete e.ordenes[k]);
  }
  guardar();
}

function leerOrden(id) { return (leer().ordenes || {})[id] || null; }
function leerOrdenes() { return leer().ordenes || {}; }

function actualizarOrden(id, campos) {
  const e = leer();
  if (e.ordenes && e.ordenes[id]) {
    Object.assign(e.ordenes[id], campos);
    guardar();
  }
}

// El último lote de facturas emitido, para no emitirlo dos veces.
function guardarLoteEmitido(periodo) {
  const e = leer();
  e.loteEmitido = { periodo, cuando: new Date().toISOString() };
  guardar();
}

function leerLoteEmitido() { return leer().loteEmitido || null; }

module.exports = {
  ARRANQUE, FICHERO,
  guardarLoteEmitido, leerLoteEmitido,
  guardarOrden, leerOrden, leerOrdenes, actualizarOrden,
  guardarJefes, leerJefes,
  guardarSilencio, leerSilencio,
  guardarPropuesta, leerPropuesta, marcarPropuestaHecha, borrarPropuesta,
  guardarFijado, leerFijado,
  guardarTemas, leerTemas,
  registrarLatido, ultimoLatido, todosLosLatidos,
  yaAvisado, marcarAvisado,
};
