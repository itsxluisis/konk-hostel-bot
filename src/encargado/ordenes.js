// src/encargado/ordenes.js
// El puente con el Mac.
//
// El encargado vive en la nube y el facturador en el Mac de Luis. La nube no
// puede entrar en el Mac, así que se hace al revés: el Mac pregunta cada pocos
// minutos si hay algo que hacer, lo hace y cuenta cómo ha ido.
//
// SEGURIDAD: aquí solo viajan NOMBRES de tarea de una lista cerrada, nunca
// comandos. Qué comando corresponde a cada nombre lo decide el Mac, no la
// nube. Aunque alguien se colara aquí, no podría ejecutar algo arbitrario.
'use strict';

const crypto = require('crypto');
const estado = require('./estado');

// Las únicas tareas que se pueden encargar, y a qué agente.
const TAREAS = {
  emitir_lote: {
    agente: 'facturador-konk',
    descripcion: 'Emitir el lote de facturas ya preparado',
  },
  preparar_lote: {
    agente: 'facturador-konk',
    descripcion: 'Preparar el lote de la semana (no emite nada)',
  },
};

// Una orden sin recoger más de un día es que el Mac lleva apagado demasiado.
const VIDA_HORAS = Number(process.env.ENCARGADO_VIDA_ORDEN || 24);

function crear(tarea, args = {}) {
  const t = TAREAS[tarea];
  if (!t) throw new Error(`Tarea desconocida: ${tarea}`);
  const orden = {
    id: crypto.randomBytes(4).toString('hex'),
    tarea, args, agente: t.agente,
    estado: 'pendiente',
    creada: new Date().toISOString(),
  };
  estado.guardarOrden(orden);
  return orden;
}

function caducada(o) {
  return (Date.now() - new Date(o.creada).getTime()) > VIDA_HORAS * 3600000;
}

/**
 * Lo que le toca al agente que pregunta. Marca lo entregado para que dos
 * sondeos seguidos no ejecuten la misma orden dos veces.
 */
function recoger(agente) {
  const todas = estado.leerOrdenes();
  const suyas = Object.values(todas).filter(o =>
    o.agente === agente && o.estado === 'pendiente' && !caducada(o));
  suyas.forEach(o => estado.actualizarOrden(o.id, {
    estado: 'entregada', entregada: new Date().toISOString(),
  }));
  return suyas.map(o => ({ id: o.id, tarea: o.tarea, args: o.args }));
}

/** El agente cuenta cómo ha ido. */
function resultado(id, { ok, salida }) {
  const o = estado.leerOrden(id);
  if (!o) throw new Error('Esa orden no existe');
  estado.actualizarOrden(id, {
    estado: ok ? 'hecha' : 'fallida',
    salida: String(salida || '').slice(0, 4000),
    terminada: new Date().toISOString(),
  });
  return estado.leerOrden(id);
}

/** Órdenes que se quedaron sin recoger: el Mac estaba apagado. */
function olvidadas() {
  return Object.values(estado.leerOrdenes())
    .filter(o => ['pendiente', 'entregada'].includes(o.estado) && caducada(o));
}

function listar() {
  return Object.values(estado.leerOrdenes())
    .sort((a, b) => b.creada.localeCompare(a.creada))
    .slice(0, 20);
}

module.exports = { TAREAS, crear, recoger, resultado, listar, olvidadas, VIDA_HORAS };
