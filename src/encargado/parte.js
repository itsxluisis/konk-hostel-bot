// src/encargado/parte.js
// Convierte la foto del Konk en texto para Telegram.
// Funciones puras: sin red, sin disco, sin reloj → se pueden probar.
'use strict';

const { humano } = require('./reloj');

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Nombres de pila, para no llenar el mensaje de apellidos. */
function nombres(lista, tope = 4) {
  const ns = lista.map(r => (r.huesped || '?').split(' ')[0]).filter(Boolean);
  if (ns.length <= tope) return ns.join(', ');
  return `${ns.slice(0, tope).join(', ')} y ${ns.length - tope} más`;
}

/**
 * El mensaje FIJADO: la foto del Konk de un vistazo. Corto a propósito.
 */
function estadoFijado(foto, ahora = new Date()) {
  const l = foto.llegadas.length;
  const s = foto.salidas.length;
  const fiable = foto.fallos.length === 0;
  const lineas = [
    `🏨 KONK · ${humano(ahora)}`,
    ``,
  ];

  if (fiable) {
    lineas.push(`🛏️ ${plural(foto.huespedes, 'huésped', 'huéspedes')} en casa`
      + ` · ${plural(l, 'llegada', 'llegadas')} · ${plural(s, 'salida', 'salidas')}`);
  } else {
    // Con datos a medias, mejor decirlo que dar una cifra que puede ser falsa.
    lineas.push(`🛏️ Datos incompletos — no he podido leer Cloudbeds del todo.`);
  }

  if (l) lineas.push(`   Llegan: ${nombres(foto.llegadas)}`);
  if (s) lineas.push(`   Salen: ${nombres(foto.salidas)}`);

  lineas.push(``, resumenAgentes(foto.agentes));

  if (foto.fallos.length) {
    lineas.push(``, `⚠️ ${foto.fallos.join(' · ')}`);
  }
  return lineas.join('\n');
}

/** Una línea con el semáforo del equipo. */
function resumenAgentes(agentes) {
  const partes = agentes.map(a => {
    if (!a.seEsperaHoy) return `${a.nombre} —`;
    if (!a.latioHoy) return `${a.nombre} ⏳`;
    return `${a.nombre} ${a.ok ? '✅' : '❌'}`;
  });
  return `🤖 ${partes.join(' · ')}`;
}

/**
 * El PARTE DIARIO: lo mismo, pero contado. Se manda una vez al día.
 */
function parteDiario(foto, ahora = new Date()) {
  const lineas = [`🛎️ Parte del día · ${humano(ahora)}`, ``];

  const fiable = foto.fallos.length === 0;

  if (!fiable && !foto.huespedes && !foto.llegadas.length && !foto.salidas.length) {
    // Cero por no haber podido preguntar NO es lo mismo que cero de verdad.
    lineas.push('No he podido leer Cloudbeds, así que hoy no puedo darte el estado'
      + ' del hostel. Lo de abajo explica por qué.');
  } else if (!foto.huespedes && !foto.llegadas.length && !foto.salidas.length) {
    lineas.push('El hostel está vacío hoy: nadie dentro, nadie entra, nadie sale.');
  } else {
    lineas.push(`Hoy duermen aquí ${plural(foto.huespedes, 'persona', 'personas')}.`);
    if (foto.llegadas.length) {
      lineas.push(``, `📥 Llegan ${plural(foto.llegadas.length, 'reserva', 'reservas')}:`);
      foto.llegadas.slice(0, 12).forEach(r => {
        lineas.push(`   · ${r.huesped} — ${plural(r.personas, 'persona', 'personas')},`
          + ` hasta el ${r.salida}${r.origen ? ` (${r.origen})` : ''}`);
      });
      if (foto.llegadas.length > 12) lineas.push(`   … y ${foto.llegadas.length - 12} más`);
    }
    if (foto.salidas.length) {
      lineas.push(``, `📤 Salen ${plural(foto.salidas.length, 'reserva', 'reservas')}:`
        + ` ${nombres(foto.salidas, 8)}`);
    }
  }

  // Cobros: solo se menciona si hay algo raro que contar.
  const c = foto.cobros;
  if (c) {
    if (c.activo === false) {
      lineas.push(``, `⚠️ El vigilante de cobros está apagado.`);
    } else if (c.ultimaRevision && c.ultimaRevision !== foto.fecha) {
      lineas.push(``, `💰 Cobros: la última revisión es del ${c.ultimaRevision}.`);
    }
  }

  // El equipo, solo si hay algo que decir.
  const pendientes = foto.agentes.filter(a => a.seEsperaHoy && !a.latioHoy);
  const fallidos = foto.agentes.filter(a => a.latioHoy && a.ok === false);
  if (fallidos.length) {
    lineas.push(``, `❌ ${fallidos.map(a => `${a.nombre}: ${a.resumen || 'terminó con error'}`).join('\n   ')}`);
  }
  if (pendientes.length) {
    lineas.push(``, `⏳ Aún sin correr hoy: ${pendientes.map(a => a.nombre).join(', ')}.`);
  }
  const bien = foto.agentes.filter(a => a.latioHoy && a.ok);
  bien.forEach(a => { if (a.resumen) lineas.push(``, `✅ ${a.nombre}: ${a.resumen}`); });

  if (foto.fallos.length) {
    lineas.push(``, `⚠️ No he podido consultarlo todo:`);
    foto.fallos.forEach(f => lineas.push(`   · ${f}`));
  }

  return lineas.join('\n');
}

module.exports = { estadoFijado, parteDiario, resumenAgentes, nombres, plural };
