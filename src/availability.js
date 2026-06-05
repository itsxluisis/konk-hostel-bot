// src/availability.js
// Construye la respuesta hablada de disponibilidad para el bot de voz.
// Función PURA (sin red, sin Cloudbeds) para poder testearla aislada.
'use strict';

const BOOK = 'Para reservar, busca haz tu reserva punto a pe pe.';

// Normaliza la preferencia que llega de la tool (acepta el viejo room_type).
function normalizePreference(raw) {
  const p = String(raw || 'any').toLowerCase();
  if (p === 'private' || p === 'privada') return 'private';
  if (p === 'shared' || p === 'compartida' || p === 'dorm' || p === 'dorm4' || p === 'dorm6') return 'shared';
  return 'any';
}

function personasStr(guests) {
  return guests === 1 ? '1 persona' : `${guests} personas`;
}

// Habitaciones privadas reales que alojan a todo el grupo en una sola habitación.
function genuineOffers(privateRooms, guests) {
  return privateRooms
    .filter(r => r.capacityPerRoom >= guests && r.bedsAvailable > 0 && r.price)
    .map(r => ({ price: r.price, text: `una habitación privada para ${personasStr(guests)} a ${r.price} euros la noche` }))
    .sort((a, b) => a.price - b.price);
}

// Para grupos (3+): reservar un dormitorio compartido entero solo para ellos.
function wholeDormOffers(sharedRooms, guests) {
  if (guests < 3) return [];
  return sharedRooms
    .filter(r => r.capacityPerRoom >= guests && r.roomsPhysical >= 1 && r.price)
    .map(r => ({ price: r.price * r.capacityPerRoom, text: `un dormitorio entero solo para vosotros, ${r.capacityPerRoom} camas, a ${r.price * r.capacityPerRoom} euros la noche` }))
    .sort((a, b) => a.price - b.price);
}

// Opción compartida: camas sueltas, combinando dormitorios para grupos.
function sharedReply(sharedRooms, guests, totalCapacity) {
  const withBeds = sharedRooms.filter(r => r.bedsAvailable > 0 && r.price);
  if (withBeds.length === 0) return { ok: false, text: '' };

  if (guests <= 2) {
    const cheap = [...withBeds].sort((a, b) => a.price - b.price)[0];
    const camas = guests === 1 ? 'una cama' : `${guests} camas`;
    const total = cheap.price * guests;
    const totalStr = guests > 1 ? `, ${total} euros en total` : '';
    return { ok: true, text: `${camas} en habitación compartida a ${cheap.price} euros por cama${totalStr}` };
  }

  // Grupos: llenar desde los dormitorios más grandes
  const sorted = [...withBeds].sort((a, b) => b.capacityPerRoom - a.capacityPerRoom);
  let remaining = guests;
  const used = [];
  for (const r of sorted) {
    if (remaining <= 0) break;
    const beds = Math.min(remaining, r.bedsAvailable);
    used.push({ price: r.price, beds });
    remaining -= beds;
  }
  if (remaining > 0) {
    return { ok: false, text: `no hay suficientes camas en compartida para ${personasStr(guests)} en esas fechas (capacidad máxima ${totalCapacity})` };
  }

  const total = used.reduce((s, u) => s + u.price * u.beds, 0);
  const prices = [...new Set(used.map(u => u.price))];
  if (prices.length === 1) {
    return { ok: true, text: `${guests} camas en habitación compartida a ${prices[0]} euros por cama, ${total} euros en total` };
  }
  return { ok: true, text: `${guests} camas repartidas en habitaciones compartidas, ${total} euros en total la noche` };
}

// ── Entrada principal ──────────────────────────────────────────────────────────
function buildReply({ rooms, totalCapacity = 0, guests, preference = 'any' }) {
  if (!rooms || rooms.length === 0) {
    return `No tenemos disponibilidad para esas fechas. Puedes consultar otras fechas en haz tu reserva punto a pe pe.`;
  }

  const pref = normalizePreference(preference);
  const personas = personasStr(guests);
  const privateRooms = rooms.filter(r => r.soldAsWhole);
  const sharedRooms = rooms.filter(r => !r.soldAsWhole);

  const genuine = genuineOffers(privateRooms, guests);
  const wholeDorm = wholeDormOffers(sharedRooms, guests);
  const shared = sharedReply(sharedRooms, guests, totalCapacity);

  if (pref === 'private') {
    // Una privada real + (para grupos) un dormitorio entero como alternativa.
    const offers = [];
    if (genuine[0]) offers.push(genuine[0]);
    if (wholeDorm[0]) offers.push(wholeDorm[0]);
    offers.sort((a, b) => a.price - b.price);
    if (offers.length === 0) {
      let msg = `No tenemos ninguna opción totalmente privada para ${personas} en esas fechas.`;
      if (shared.ok) msg += ` Lo que sí tenemos es ${shared.text}.`;
      return `${msg} ${BOOK}`;
    }
    return `Para ${personas}, en privado: ${offers.map(o => o.text).join(', o bien ')}. ${BOOK}`;
  }

  if (pref === 'shared') {
    if (shared.ok) return `Para ${personas}: ${shared.text}. ${BOOK}`;
    const alt = genuine[0] || wholeDorm[0];
    if (alt) return `No nos quedan camas en compartida para esas fechas, pero sí ${alt.text}. ${BOOK}`;
    if (shared.text) return `Lo siento, ${shared.text}. ${BOOK}`;
    return `No tenemos disponibilidad para esas fechas. ${BOOK}`;
  }

  // any → una privada (la real si la hay; si no, dormitorio entero) + una compartida
  const privSlot = genuine[0] || wholeDorm[0];
  const parts = [];
  if (privSlot) parts.push(privSlot.text);
  if (shared.ok) parts.push(shared.text);
  if (parts.length === 0) {
    if (shared.text) return `Lo siento, ${shared.text}. ${BOOK}`;
    return `No tenemos disponibilidad para esas fechas. ${BOOK}`;
  }
  return `Para ${personas}: ${parts.join('. También, ')}. ${BOOK}`;
}

module.exports = { buildReply, normalizePreference };
