// src/encargado/inventario.js
// El Konk por dentro: qué camas hay y cómo se llaman.
//
// Sin esto, "bloquea la cama 3" no significa nada. Cloudbeds las llama
// R2(3), R5(1), "Room 7"… y el nombre del TIPO no siempre coincide con las
// unidades reales (hay un tipo "compartida/privada 6" con 5 camas), así que
// se cuenta lo que hay, no lo que dice el nombre.
'use strict';

const { api } = require('../cloudbeds');

let cache = null;
let cuando = 0;
const VIDA_MS = 10 * 60 * 1000;   // el inventario cambia poco

async function camas({ refrescar = false } = {}) {
  if (!refrescar && cache && Date.now() - cuando < VIDA_MS) return cache;
  const r = await api('GET', '/getRooms', {});
  const bloques = r?.data || [];
  const lista = [];
  for (const b of bloques) {
    for (const x of (b.rooms || [])) {
      lista.push({
        id: x.roomID,
        nombre: x.roomName,
        tipo: x.roomTypeName,
        privada: Boolean(x.isPrivate),
        bloqueada: Boolean(x.roomBlocked),
        plazas: Number(x.maxGuests) || null,
      });
    }
  }
  cache = lista;
  cuando = Date.now();
  return lista;
}

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Encuentra la cama de la que habla Luis. Devuelve {cama} si no hay duda,
 * o {varias} si el nombre encaja con más de una: preguntar es mejor que
 * bloquear la que no era.
 */
function elegir(todas, texto) {
  const q = normalizar(texto);
  if (!q) return { varias: [], motivo: 'No me has dicho qué cama.' };

  // El nombre exacto manda: "R2(1)" no debe confundirse con "R2(10)".
  const exacta = todas.filter(c => normalizar(c.nombre) === q);
  if (exacta.length === 1) return { cama: exacta[0] };

  const parcial = todas.filter(c =>
    normalizar(c.nombre).includes(q) || normalizar(c.tipo).includes(q));
  if (parcial.length === 1) return { cama: parcial[0] };
  // Con más de una candidata NO se elige: bloquear la que no era es peor
  // que preguntar.
  if (parcial.length > 1) return { varias: parcial };
  return { varias: [], motivo: `No encuentro ninguna cama que se llame "${texto}".` };
}

async function buscar(texto) {
  return elegir(await camas(), texto);
}

/** El inventario contado, para responder "¿qué camas tienes?". */
async function resumen() {
  const todas = await camas();
  const porTipo = new Map();
  for (const c of todas) {
    const k = `${c.tipo}|${c.privada}`;
    if (!porTipo.has(k)) porTipo.set(k, { tipo: c.tipo, privada: c.privada, camas: [] });
    porTipo.get(k).camas.push(c);
  }
  return { total: todas.length, grupos: [...porTipo.values()] };
}

/**
 * Los bloqueos de verdad, por fechas.
 *
 * OJO: el campo roomBlocked de getRooms dice si la cama está bloqueada HOY,
 * no si tiene bloqueos futuros. Para saber qué hay puesto hay que preguntar
 * por getRoomBlocks en un rango.
 */
async function bloqueos({ desde, hasta } = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const d = desde || hoy;
  const h = hasta || (() => {
    const x = new Date(`${hoy}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 180);
    return x.toISOString().slice(0, 10);
  })();

  const r = await api('GET', '/getRoomBlocks', { startDate: d, endDate: h, pageSize: 100 });
  const data = r?.data;
  const grupos = Array.isArray(data) ? data : (data ? [data] : []);
  const salida = [];
  for (const g of grupos) {
    for (const b of (g?.roomBlocks || [])) {
      salida.push({
        id: b.roomBlockID,
        roomID: b.roomID || null,
        nombre: b.roomName || null,
        desde: b.startDate,
        hasta: b.endDate,
        tipo: b.roomBlockType || null,
        motivo: (b.roomBlockReason || '').trim(),
      });
    }
  }
  return salida;
}

module.exports = { camas, buscar, elegir, resumen, normalizar, bloqueos };
