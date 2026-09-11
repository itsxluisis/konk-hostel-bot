// src/encargado/acciones-camas.js
// Bloquear y desbloquear camas del Konk.
//
// Es reversible, pero no inofensivo: una cama bloqueada es una cama que no
// se vende. Por eso el bloqueo pide siempre fechas y motivo, y por eso al
// confirmar se dice en cristiano qué cama y cuántas noches se van a tapar.
'use strict';

const { registrar } = require('./acciones');
const { api } = require('../cloudbeds');
const { plural } = require('./parte');
const { hoyISO } = require('./reloj');
const inventario = require('./inventario');

/** El mensaje de Cloudbeds, no el genérico de axios. */
function porQue(err) {
  const d = err.response?.data;
  return (d?.message || d?.error || (typeof d === 'string' ? d : '') || err.message)
    .toString().slice(0, 300);
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function esFecha(f) {
  return /^\d{4}-\d{2}-\d{2}$/.test(f || '');
}

function noches(desde, hasta) {
  return Math.round((new Date(hasta) - new Date(desde)) / 86400000);
}

/** Resuelve cama y fechas, o explica por qué no se puede. */
async function resolver({ cama, desde, hasta }) {
  const r = await inventario.buscar(cama);
  if (!r.cama) {
    if (r.varias && r.varias.length) {
      return { imposible: true, motivo: `"${cama}" encaja con varias camas:`
        + ` ${r.varias.map(c => c.nombre).join(', ')}. Dime cuál exactamente.` };
    }
    return { imposible: true, motivo: r.motivo };
  }

  const d = esFecha(desde) ? desde : hoyISO();
  const h = esFecha(hasta) ? hasta : sumarDias(d, 1);
  if (noches(d, h) < 1) {
    return { imposible: true, motivo: 'La fecha de fin tiene que ser posterior a la de inicio.' };
  }
  return { cama: r.cama, desde: d, hasta: h };
}

registrar('bloquear_cama', {
  riesgo: 'alto',
  descripcion: 'Bloquea una cama en Cloudbeds para que no se pueda vender'
    + ' (avería, limpieza, uso propio). Se deshace desbloqueándola.',
  parametros: {
    cama: 'nombre de la cama, como R2(3) o "Room 7"',
    desde: 'primera noche AAAA-MM-DD (por defecto hoy)',
    hasta: 'noche de salida AAAA-MM-DD (por defecto mañana)',
    motivo: 'por qué se bloquea',
    tipo: 'clase de bloqueo (por defecto mantenimiento)',
  },
  async resumen(args) {
    const r = await resolver(args);
    if (r.imposible) return r;
    const n = noches(r.desde, r.hasta);
    if (r.cama.bloqueada) {
      return { imposible: true, motivo: `${r.cama.nombre} ya figura como bloqueada en Cloudbeds.` };
    }
    return [
      `⛔ Bloquear ${r.cama.nombre} (${r.cama.tipo})`,
      `   del ${r.desde} al ${r.hasta} · ${plural(n, 'noche', 'noches')}`,
      args.motivo ? `   motivo: ${args.motivo}` : '   sin motivo indicado',
      ``,
      `Esas noches dejan de venderse. Se deshace desbloqueándola.`,
    ].join('\n');
  },
  async ejecutar(args) {
    const r = await resolver(args);
    if (r.imposible) return `Ya no se puede: ${r.motivo}`;
    let res;
    try {
      res = await api('POST', '/postRoomBlock', {
        startDate: r.desde,
        endDate: r.hasta,
        rooms: [{ roomID: r.cama.id, quantity: 1 }],
        // Cloudbeds exige decir de qué clase es el bloqueo.
        roomBlockType: args.tipo || process.env.CLOUDBEDS_TIPO_BLOQUEO || 'maintenance',
        roomBlockReason: args.motivo || 'Bloqueada desde el encargado',
      });
    } catch (err) {
      throw new Error(porQue(err));
    }
    if (res && res.success === false) {
      throw new Error(res.message || 'Cloudbeds lo ha rechazado');
    }
    await inventario.camas({ refrescar: true });
    return `⛔ ${r.cama.nombre} bloqueada del ${r.desde} al ${r.hasta}.`;
  },
});

registrar('desbloquear_cama', {
  riesgo: 'medio',
  descripcion: 'Quita el bloqueo de una cama para que vuelva a venderse.',
  parametros: { cama: 'nombre de la cama, como R2(3)' },
  async resumen({ cama }) {
    const r = await inventario.buscar(cama);
    if (!r.cama) {
      if (r.varias && r.varias.length) {
        return { imposible: true, motivo: `"${cama}" encaja con varias:`
          + ` ${r.varias.map(c => c.nombre).join(', ')}. Dime cuál.` };
      }
      return { imposible: true, motivo: r.motivo };
    }
    if (!r.cama.bloqueada) {
      return { imposible: true, motivo: `${r.cama.nombre} no está bloqueada.` };
    }
    return `🔓 Desbloquear ${r.cama.nombre} (${r.cama.tipo}) para que vuelva a venderse.`;
  },
  async ejecutar({ cama }) {
    const r = await inventario.buscar(cama);
    if (!r.cama) return 'Ya no encuentro esa cama.';
    let res;
    try {
      res = await api('POST', '/deleteRoomBlock', { roomID: r.cama.id });
    } catch (err) {
      throw new Error(porQue(err));
    }
    if (res && res.success === false) {
      throw new Error(res.message || 'Cloudbeds lo ha rechazado');
    }
    await inventario.camas({ refrescar: true });
    return `🔓 ${r.cama.nombre} vuelve a estar disponible.`;
  },
});

module.exports = { resolver };
