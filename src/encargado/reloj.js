// src/encargado/reloj.js
// Hora de Madrid, sin dependencias. El servidor corre en UTC.
'use strict';

const { TZ } = require('./config');

function partes(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  // getDay() en TZ: se deduce de la fecha local formateada en ISO
  const iso = `${p.year}-${p.month}-${p.day}`;
  const dia = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return {
    iso,                                   // '2026-09-10'
    hora: `${p.hour}:${p.minute}`,         // '09:15'
    minutos: Number(p.hour) * 60 + Number(p.minute),
    dia,                                   // 0=domingo
  };
}

function hoyISO() { return partes().iso; }

function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function humano(d = new Date()) {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

module.exports = { partes, hoyISO, aMinutos, humano };
