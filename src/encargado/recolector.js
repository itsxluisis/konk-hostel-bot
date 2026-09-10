// src/encargado/recolector.js
// Reúne el estado del Konk. Solo lectura, y nunca lanza: si una fuente
// falla, lo dice en el parte en vez de tumbarlo entero.
'use strict';

const { api } = require('../cloudbeds');
const { AGENTES } = require('./config');
const { hoyISO } = require('./reloj');
const estado = require('./estado');

// Estados que significan "esta reserva cuenta".
const VIVAS = new Set(['confirmed', 'checked_in', 'not_confirmed']);

function normalizar(r) {
  return {
    id: r.reservationID,
    huesped: (r.guestName || `${r.guestFirstName || ''} ${r.guestLastName || ''}`).trim(),
    entrada: r.startDate,
    salida: r.endDate,
    personas: Number(r.adults || 1) + Number(r.children || 0),
    estado: r.status,
    origen: r.sourceName || r.source || '',
  };
}

async function reservas(params) {
  const data = await api('GET', '/getReservations', params);
  return (data.data || []).map(normalizar).filter(r => VIVAS.has(r.estado));
}

/**
 * Foto del Konk para una fecha (por defecto hoy, hora de Madrid).
 * Devuelve siempre un objeto; los fallos van en .fallos.
 */
/**
 * Deja constancia si la API devolvió cosas que no cumplían el filtro:
 * es la señal de que Cloudbeds está ignorando un parámetro.
 */
function apuntarDescartes(foto, que, recibidas, validas) {
  if (recibidas > validas) {
    console.warn(`[Encargado] Cloudbeds devolvió ${recibidas} ${que} y solo`
      + ` ${validas} cumplen la fecha: el filtro no se está aplicando.`);
  }
}

async function recolectar(fecha = hoyISO()) {
  const foto = {
    fecha,
    llegadas: [], salidas: [], enCasa: [],
    huespedes: 0,
    cobros: null,
    agentes: [],
    fallos: [],
  };

  // Llegadas y salidas de hoy.
  // Pedimos filtrado a Cloudbeds, pero NO nos fiamos: comprobamos la fecha
  // de cada reserva por nuestra cuenta. Un filtro que la API ignore en
  // silencio nos haría contar como salida a quien acaba de entrar.
  try {
    const r = await reservas({ checkInFrom: fecha, checkInTo: fecha });
    foto.llegadas = r.filter(x => x.entrada === fecha);
    apuntarDescartes(foto, 'llegadas', r.length, foto.llegadas.length);
  } catch (err) {
    foto.fallos.push(`No se pudieron leer las llegadas: ${err.message}`);
  }
  try {
    const r = await reservas({ checkOutFrom: fecha, checkOutTo: fecha });
    foto.salidas = r.filter(x => x.salida === fecha);
    apuntarDescartes(foto, 'salidas', r.length, foto.salidas.length);
  } catch (err) {
    foto.fallos.push(`No se pudieron leer las salidas: ${err.message}`);
  }

  // Quién duerme hoy aquí: entró en los últimos 60 días y aún no se ha ido.
  try {
    const desde = new Date(`${fecha}T12:00:00Z`);
    desde.setUTCDate(desde.getUTCDate() - 60);
    const abiertas = await reservas({
      checkInFrom: desde.toISOString().slice(0, 10),
      checkInTo: fecha,
    });
    foto.enCasa = abiertas.filter(r => r.entrada <= fecha && r.salida > fecha);
    foto.huespedes = foto.enCasa.reduce((n, r) => n + r.personas, 0);
  } catch (err) {
    foto.fallos.push(`No se pudo calcular la ocupación: ${err.message}`);
  }

  // Estado del vigilante de cobros, que ahora vive en este mismo proceso.
  // Carga perezosa y tolerante: si el módulo no está, el parte sigue saliendo.
  try {
    foto.cobros = require('../vigilante').info();
  } catch (err) {
    foto.cobros = null;
  }

  // Cómo va el equipo de agentes
  const latidos = estado.todosLosLatidos();
  foto.agentes = Object.entries(AGENTES).map(([id, cfg]) => {
    const l = latidos[id];
    return {
      id,
      nombre: cfg.nombre,
      seEsperaHoy: cfg.dias.includes(new Date(`${fecha}T12:00:00Z`).getUTCDay()),
      latioHoy: Boolean(l && l.ts.slice(0, 10) === fecha),
      ok: l ? l.ok : null,
      resumen: l ? l.resumen : null,
    };
  });

  return foto;
}

module.exports = { recolectar };
