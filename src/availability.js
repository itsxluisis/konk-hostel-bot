// src/availability.js
// Construye la respuesta hablada de disponibilidad para el bot de voz.
// Función PURA (sin red, sin Cloudbeds) para poder testearla aislada.
//
// IMPORTANTE: siempre se cotiza el TOTAL de la estancia (no el promedio por
// noche). Cloudbeds da roomRate como total del rango; cotizar por noche
// infra-cotizaba en estancias de varias noches y no cuadraba con la web.
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

// Frase de precio: SIEMPRE el total de la estancia, nunca "por noche".
// Así el modelo no puede convertirlo en "X euros la noche" (bug recurrente).
function priceText(total, nights) {
  const n = nights && nights > 0 ? nights : 1;
  return `${total} euros en total por ${n} ${n === 1 ? 'noche' : 'noches'}`;
}

// Precio total de la estancia para una habitación (fallback a price si hiciera falta).
function roomTotal(r) {
  return (r.priceTotal != null ? r.priceTotal : r.price);
}

// Etiqueta hablada y anclada del tipo de habitación (a partir del nombre de
// Cloudbeds). Evita que el modelo invente la descripción.
function roomLabel(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('litera de matrimonio') || n.includes('litera matrimonio')) return 'con litera de matrimonio';
  if (n.includes('adaptada')) return 'doble adaptada y accesible';
  if (n.includes('independiente')) return 'doble con entrada independiente';
  if (n.includes('doble')) return 'doble';
  return '';
}

// Habitaciones privadas reales que alojan a todo el grupo en una sola habitación.
function genuineOffers(privateRooms, guests, nights) {
  return privateRooms
    .filter(r => r.capacityPerRoom >= guests && r.bedsAvailable > 0 && roomTotal(r))
    .map(r => {
      const label = roomLabel(r.roomTypeName);
      const desc = label ? `una habitación privada ${label}` : 'una habitación privada';
      return { price: roomTotal(r), text: `${desc} para ${personasStr(guests)}, ${priceText(roomTotal(r), nights)}` };
    })
    .sort((a, b) => a.price - b.price);
}

// Para grupos (3+): reservar un dormitorio compartido entero solo para ellos.
function wholeDormOffers(sharedRooms, guests, nights) {
  if (guests < 3) return [];
  return sharedRooms
    .filter(r => r.capacityPerRoom >= guests && r.roomsPhysical >= 1 && roomTotal(r))
    .map(r => {
      const total = roomTotal(r) * r.capacityPerRoom;
      return { price: total, text: `un dormitorio entero solo para vosotros, ${r.capacityPerRoom} camas, ${priceText(total, nights)}` };
    })
    .sort((a, b) => a.price - b.price);
}

// Opción compartida: camas sueltas, combinando dormitorios para grupos.
function sharedReply(sharedRooms, guests, totalCapacity, nights) {
  const withBeds = sharedRooms.filter(r => r.bedsAvailable > 0 && roomTotal(r));
  if (withBeds.length === 0) return { ok: false, text: '' };

  if (guests <= 2) {
    const cheap = [...withBeds].sort((a, b) => roomTotal(a) - roomTotal(b))[0];
    const camas = guests === 1 ? 'una cama' : `${guests} camas`;
    const total = roomTotal(cheap) * guests;
    return { ok: true, text: `${camas} en habitación compartida, ${priceText(total, nights)}` };
  }

  // Grupos: llenar desde los dormitorios más grandes
  const sorted = [...withBeds].sort((a, b) => b.capacityPerRoom - a.capacityPerRoom);
  let remaining = guests;
  let total = 0;
  for (const r of sorted) {
    if (remaining <= 0) break;
    const beds = Math.min(remaining, r.bedsAvailable);
    total += roomTotal(r) * beds;
    remaining -= beds;
  }
  if (remaining > 0) {
    return { ok: false, text: `no hay suficientes camas en compartida para ${personasStr(guests)} en esas fechas (capacidad máxima ${totalCapacity})` };
  }
  return { ok: true, text: `${guests} camas en habitación compartida, ${priceText(total, nights)}` };
}

// ── Entrada principal ──────────────────────────────────────────────────────────
function buildReply({ rooms, totalCapacity = 0, guests, preference = 'any', nights = 1 }) {
  if (!rooms || rooms.length === 0) {
    return `No tenemos disponibilidad para esas fechas. Puedes consultar otras fechas en haz tu reserva punto a pe pe.`;
  }

  const pref = normalizePreference(preference);
  const personas = personasStr(guests);
  const privateRooms = rooms.filter(r => r.soldAsWhole);
  const sharedRooms = rooms.filter(r => !r.soldAsWhole);

  const genuine = genuineOffers(privateRooms, guests, nights);
  const wholeDorm = wholeDormOffers(sharedRooms, guests, nights);
  const shared = sharedReply(sharedRooms, guests, totalCapacity, nights);

  if (pref === 'private') {
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
