// src/encargado/consultas.js
// Lo que el encargado sabe responder. Cada consulta es una función normal
// que devuelve texto ya listo para Telegram.
//
// Se usan de dos maneras: como herramientas del cerebro (Claude decide cuál
// llamar) y como respuestas directas cuando no hay cerebro configurado.
'use strict';

const { api } = require('../cloudbeds');
const { recolectar } = require('./recolector');
const { parteDiario, plural, nombres } = require('./parte');
const { hoyISO } = require('./reloj');
const { AGENTES } = require('./config');
const estado = require('./estado');

const VIVAS = new Set(['confirmed', 'checked_in', 'not_confirmed']);

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Acepta 'hoy', 'mañana', 'ayer' o una fecha ISO. */
function resolverFecha(f) {
  const hoy = hoyISO();
  if (!f || /^hoy$/i.test(f)) return hoy;
  if (/^ma[ñn]ana$/i.test(f)) return sumarDias(hoy, 1);
  if (/^ayer$/i.test(f)) return sumarDias(hoy, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  return hoy;
}

async function reservas(params) {
  const d = await api('GET', '/getReservations', params);
  return (d.data || [])
    .map(r => ({
      id: r.reservationID,
      huesped: (r.guestName || `${r.guestFirstName || ''} ${r.guestLastName || ''}`).trim(),
      entrada: r.startDate,
      salida: r.endDate,
      personas: Number(r.adults || 1) + Number(r.children || 0),
      estado: r.status,
      origen: r.sourceName || r.source || '',
    }))
    .filter(r => VIVAS.has(r.estado));
}

// ─── las consultas ───────────────────────────────────────────────────────────

async function estadoDelDia({ fecha } = {}) {
  const f = resolverFecha(fecha);
  const foto = await recolectar(f);
  return parteDiario(foto);
}

async function quienLlega({ fecha } = {}) {
  const f = resolverFecha(fecha);
  // Se pide filtrado, pero se comprueba aquí: Cloudbeds ignora el filtro.
  const r = (await reservas({ checkInFrom: f, checkInTo: f }))
    .filter(x => x.entrada === f);
  if (!r.length) return `El ${f} no llega nadie.`;
  const lineas = r.map(x => `   · ${x.huesped} — ${plural(x.personas, 'persona', 'personas')},`
    + ` hasta el ${x.salida}${x.origen ? ` (${x.origen})` : ''}`);
  return `📥 El ${f} llegan ${plural(r.length, 'reserva', 'reservas')}:\n${lineas.join('\n')}`;
}

async function quienSeVa({ fecha } = {}) {
  const f = resolverFecha(fecha);
  const r = (await reservas({ checkOutFrom: f, checkOutTo: f }))
    .filter(x => x.salida === f);
  if (!r.length) return `El ${f} no se va nadie.`;
  const lineas = r.map(x => `   · ${x.huesped} — entró el ${x.entrada}`);
  return `📤 El ${f} salen ${plural(r.length, 'reserva', 'reservas')}:\n${lineas.join('\n')}`;
}

async function quienEstaDentro({ fecha } = {}) {
  const f = resolverFecha(fecha);
  const foto = await recolectar(f);
  if (!foto.enCasa.length) return `El ${f} no hay nadie alojado.`;
  const lineas = foto.enCasa
    .sort((a, b) => a.salida.localeCompare(b.salida))
    .map(x => `   · ${x.huesped} — ${plural(x.personas, 'persona', 'personas')}, se va el ${x.salida}`);
  return `🛏️ El ${f} hay ${plural(foto.huespedes, 'persona', 'personas')} alojadas`
    + ` en ${plural(foto.enCasa.length, 'reserva', 'reservas')}:\n${lineas.join('\n')}`;
}

async function buscarHuesped({ nombre } = {}) {
  if (!nombre || nombre.trim().length < 3) {
    return 'Dime al menos tres letras del nombre para buscarlo.';
  }
  const hoy = hoyISO();
  // Ventana amplia: dos meses atrás y tres adelante.
  const r = await reservas({ checkInFrom: sumarDias(hoy, -60), checkInTo: sumarDias(hoy, 90) });
  const q = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hit = r.filter(x => x.huesped.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q));
  if (!hit.length) return `No encuentro a nadie que se llame "${nombre}" entre hace 60 días y dentro de 90.`;
  const lineas = hit.slice(0, 10).map(x =>
    `   · ${x.huesped} — ${x.entrada} → ${x.salida}, ${plural(x.personas, 'persona', 'personas')}`
    + `${x.origen ? ` (${x.origen})` : ''} · id ${x.id}`);
  return `🔎 ${plural(hit.length, 'reserva', 'reservas')} de "${nombre}":\n${lineas.join('\n')}`
    + (hit.length > 10 ? `\n   … y ${hit.length - 10} más` : '');
}

/**
 * Quién viene de un canal concreto: "el de Airbnb", "los de Booking",
 * "los que reservaron por la web".
 */
async function porCanal({ canal, fecha } = {}) {
  if (!canal || canal.trim().length < 3) {
    return 'Dime de qué canal: Booking, Airbnb, Expedia, la web o walk-in.';
  }
  const f = resolverFecha(fecha);
  const foto = await recolectar(f);
  const q = canal.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // "web" y "directo" son la misma cosa en Cloudbeds.
  const alias = /web|directo|propia/.test(q) ? 'website' : q;
  const dentro = foto.enCasa.filter(r =>
    (r.origen || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').includes(alias));
  if (!dentro.length) {
    const canales = [...new Set(foto.enCasa.map(r => r.origen).filter(Boolean))];
    return `El ${f} no hay nadie de "${canal}".`
      + (canales.length ? ` Los canales de ese día son: ${canales.join(', ')}.` : '');
  }
  const lineas = dentro
    .sort((a, b) => a.salida.localeCompare(b.salida))
    .map(r => `   · ${r.huesped} — ${plural(r.personas, 'persona', 'personas')},`
      + ` del ${r.entrada} al ${r.salida} (${r.origen})`);
  return `🔗 El ${f} hay ${plural(dentro.length, 'reserva', 'reservas')} de "${canal}":\n`
    + lineas.join('\n');
}

async function comoVaElEquipo() {
  const latidos = estado.todosLosLatidos();
  const lineas = Object.entries(AGENTES).map(([id, cfg]) => {
    const l = latidos[id];
    if (!l) return `   · ${cfg.nombre} — sin noticias todavía`;
    const cuando = l.ts.slice(0, 10) === hoyISO() ? 'hoy' : `el ${l.ts.slice(0, 10)}`;
    return `   · ${cfg.nombre} — ${l.ok ? '✅' : '❌'} ${cuando}: ${l.resumen || 'sin detalle'}`;
  });
  let cobros = '';
  try {
    const info = require('../vigilante').info();
    cobros = `\n💰 Vigilante de cobros: ${info.activo ? 'activo' : 'APAGADO'},`
      + ` última revisión ${info.ultimaRevision || 'ninguna'}.`;
  } catch { /* el módulo puede no estar */ }
  return `🤖 El equipo:\n${lineas.join('\n')}${cobros}`;
}

async function revisarCobrosAhora() {
  try {
    const r = await require('../vigilante').ejecutar({ enviar: false });
    if (!r.mensaje) return '💰 Revisados los cobros: todo cuadra, nada que reclamar.';
    return r.mensaje;
  } catch (err) {
    return `No he podido revisar los cobros: ${err.message}`;
  }
}

// Catálogo: nombre → { fn, descripcion, parametros }. El cerebro lo usa para
// saber qué puede pedir, y el modo sin cerebro para emparejar por palabras.
const CONSULTAS = {
  estado_del_dia: {
    fn: estadoDelDia,
    descripcion: 'El parte completo de un día: cuánta gente hay, quién llega, quién sale y quién prorroga.',
    parametros: { fecha: 'hoy, mañana, ayer o AAAA-MM-DD' },
  },
  quien_llega: {
    fn: quienLlega,
    descripcion: 'Las llegadas de un día concreto, con nombres y hasta cuándo se quedan.',
    parametros: { fecha: 'hoy, mañana, ayer o AAAA-MM-DD' },
  },
  quien_se_va: {
    fn: quienSeVa,
    descripcion: 'Las salidas de un día concreto.',
    parametros: { fecha: 'hoy, mañana, ayer o AAAA-MM-DD' },
  },
  quien_esta_dentro: {
    fn: quienEstaDentro,
    descripcion: 'Quién está alojado en el hostel en una fecha.',
    parametros: { fecha: 'hoy, mañana, ayer o AAAA-MM-DD' },
  },
  buscar_huesped: {
    fn: buscarHuesped,
    descripcion: 'Busca las reservas de una persona por su nombre.',
    parametros: { nombre: 'nombre o apellido del huésped' },
  },
  por_canal: {
    fn: porCanal,
    descripcion: 'Quién está alojado en una fecha viniendo de un canal concreto'
      + ' (Booking, Airbnb, Expedia, la web, walk-in). Úsala para preguntas como'
      + ' "el de Airbnb" o "los de Booking". Si no encuentra el canal, dice cuáles hay.',
    parametros: {
      canal: 'Booking, Airbnb, Expedia, web, walk-in…',
      fecha: 'hoy, mañana, ayer o AAAA-MM-DD',
    },
  },
  como_va_el_equipo: {
    fn: comoVaElEquipo,
    descripcion: 'Estado de los agentes automáticos: si han corrido hoy y qué han hecho.',
    parametros: {},
  },
  revisar_cobros: {
    fn: revisarCobrosAhora,
    descripcion: 'Lanza ahora una revisión de cobros y devuelve lo que encuentre, sin avisar al grupo.',
    parametros: {},
  },
};

module.exports = { CONSULTAS, resolverFecha, sumarDias };
