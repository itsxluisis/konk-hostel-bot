// src/cloudbeds.js
// Gestión OAuth 2.0 con Cloudbeds — refresco automático de tokens
'use strict';

const axios = require('axios');

const BASE = 'https://hotels.cloudbeds.com';
const TOKEN_URL = 'https://hotels.cloudbeds.com/api/v1.2/access_token';

// Estado en memoria
let accessToken = process.env.CLOUDBEDS_ACCESS_TOKEN || null;
let refreshToken = process.env.CLOUDBEDS_REFRESH_TOKEN || null;
let tokenExpiry = 0;
let refreshPromise = null; // evitar refreshes paralelos

// Pre-cargar token al arrancar si hay refresh_token disponible
if (process.env.CLOUDBEDS_REFRESH_TOKEN) {
  // Forzar refresh inmediato al arrancar para tener token válido desde el primer request
  setTimeout(async () => {
    try {
      await refreshAccessToken();
      console.log('[Cloudbeds] Token precargado al arrancar');
    } catch (e) {
      console.error('[Cloudbeds] Error precargando token:', e.message);
    }
  }, 2000);

  // Renovar cada 30 minutos para que nunca expire durante el día
  setInterval(async () => {
    try {
      await refreshAccessToken();
      console.log('[Cloudbeds] Token renovado automáticamente');
    } catch (e) {
      console.error('[Cloudbeds] Error renovando token periódico:', e.message);
    }
  }, 30 * 60 * 1000);
}

// ─── OAuth: canjear código por tokens ────────────────────────────────────────
async function exchangeCode(code) {
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.CLOUDBEDS_CLIENT_ID,
    client_secret: process.env.CLOUDBEDS_CLIENT_SECRET,
    redirect_uri: process.env.CLOUDBEDS_REDIRECT_URI,
    code,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  accessToken = res.data.access_token;
  refreshToken = res.data.refresh_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;

  console.log('[Cloudbeds] Tokens obtenidos correctamente');
  return { accessToken, refreshToken };
}

// ─── OAuth: refrescar access token ───────────────────────────────────────────
async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No hay refresh_token. Autoriza la app primero.');

  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.CLOUDBEDS_CLIENT_ID,
    client_secret: process.env.CLOUDBEDS_CLIENT_SECRET,
    refresh_token: refreshToken,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  if (res.data.refresh_token) refreshToken = res.data.refresh_token;

  console.log('[Cloudbeds] Token refrescado');
  return accessToken;
}

// ─── Obtener token válido (refresca si es necesario, evita refreshes paralelos) ─
async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  // Si ya hay un refresh en curso, esperar a que termine
  if (refreshPromise) return refreshPromise;

  refreshPromise = refreshAccessToken().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ─── Llamada genérica a la API de Cloudbeds ───────────────────────────────────
async function api(method, path, params = {}) {
  const token = await getToken();
  const propertyId = process.env.CLOUDBEDS_PROPERTY_ID;

  const res = await axios({
    method,
    url: `https://hotels.cloudbeds.com/api/v1.2${path}`,
    headers: { Authorization: `Bearer ${token}` },
    params: method === 'GET' ? { propertyID: propertyId, ...params } : undefined,
    data: method !== 'GET' ? { propertyID: propertyId, ...params } : undefined,
  });

  return res.data;
}

// ─── Verificar reserva: nombre + fecha check-in ───────────────────────────────
async function checkReservation(guestName, checkinDate) {
  try {
    console.log(`[Cloudbeds] checkReservation: "${guestName}" / ${checkinDate}`);

    const data = await api('GET', '/getReservations', {
      checkInFrom: checkinDate,
      checkInTo: checkinDate,
      status: 'confirmed,checked_in,not_confirmed',
    });

    console.log(`[Cloudbeds] getReservations total: ${data.total || 0}, count: ${data.data?.length || 0}`);
    if (data.data?.length > 0) {
      console.log('[Cloudbeds] primera reserva:', JSON.stringify(data.data[0]).slice(0, 300));
    } else {
      console.log('[Cloudbeds] respuesta completa:', JSON.stringify(data).slice(0, 300));
    }

    if (!data.data || data.data.length === 0) {
      // Reintentar sin filtro de status
      console.log('[Cloudbeds] Reintentando sin filtro de status...');
      const data2 = await api('GET', '/getReservations', {
        checkInFrom: checkinDate,
        checkInTo: checkinDate,
      });
      console.log(`[Cloudbeds] reintento total: ${data2.total || 0}, count: ${data2.data?.length || 0}`);
      if (data2.data?.length > 0) {
        // Excluir reservas ya finalizadas
        const active = data2.data.filter(r => r.status !== 'checked_out' && r.status !== 'cancelled' && r.status !== 'no_show');
        console.log(`[Cloudbeds] reservas activas: ${active.length}`);
        if (active.length > 0) {
          console.log('[Cloudbeds] primera activa:', JSON.stringify(active[0]).slice(0, 200));
          data.data = active;
        } else {
          return { found: false, reason: 'No active reservations found for that check-in date' };
        }
      }
      if (!data.data || data.data.length === 0) {
        return { found: false, reason: 'No reservations found for that check-in date' };
      }
    }

    // ── Funciones de matching ─────────────────────────────────────────────────
    const normalize = (str) => str.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Levenshtein distance
    const levenshtein = (a, b) => {
      const m = a.length, n = b.length;
      const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
      for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
          dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      return dp[m][n];
    };

    const nameLower = normalize(guestName);
    const nameParts = nameLower.split(' ').filter(p => p.length > 1);

    const scoreMatch = (reservationName) => {
      const full = normalize(reservationName);
      const fullParts = full.split(' ').filter(p => p.length > 1);

      // Match exacto
      if (full === nameLower || full.includes(nameLower) || nameLower.includes(full)) return 100;

      // Match por palabras con Levenshtein
      let matchedParts = 0;
      for (const np of nameParts) {
        for (const fp of fullParts) {
          const maxLen = Math.max(np.length, fp.length);
          const dist = levenshtein(np, fp);
          const threshold = maxLen <= 4 ? 1 : maxLen <= 6 ? 2 : 3;
          if (dist <= threshold) { matchedParts++; break; }
        }
      }
      if (matchedParts >= Math.min(2, nameParts.length)) return 80;

      // Match parcial — alguna palabra del nombre dicho está en el nombre de la reserva
      const partialMatch = nameParts.some(np => full.includes(np) && np.length > 3);
      if (partialMatch) return 50;

      return 0;
    };

    // Buscar mejor match
    const scored = data.data.map(r => ({
      r,
      score: scoreMatch(r.guestName || `${r.guestFirstName || ''} ${r.guestLastName || ''}`.trim())
    })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    console.log(`[Cloudbeds] scores: ${scored.map(x => `${x.r.guestName}=${x.score}`).join(', ')}`);

    let match = scored[0]?.r || null;
    let needsConfirmation = false;

    // Si no hay match pero solo hay una reserva ese día → confirmar con el huésped
    if (!match && data.data.length === 1) {
      match = data.data[0];
      needsConfirmation = true;
      console.log(`[Cloudbeds] fallback a reserva única: ${match.guestName}`);
    }

    // Si el score es bajo → confirmar con el huésped
    if (match && scored[0]?.score < 80) {
      needsConfirmation = true;
    }

    if (!match) {
      return { found: false, reason: 'Name does not match any reservation for that date' };
    }

    // Obtener detalle completo de la reserva para encontrar la habitación
    let roomNumber = null;
    try {
      const detail = await api('GET', '/getReservation', { reservationID: match.reservationID });
      const r = detail.data;
      console.log(`[Cloudbeds] getReservation keys: ${Object.keys(r || {}).join(', ')}`);
      // La habitación puede estar en assigned[], rooms[], accommodations[] o roomName
      const assigned = r?.assigned || r?.rooms || r?.accommodations || [];
      console.log(`[Cloudbeds] assigned/rooms: ${JSON.stringify(assigned).slice(0, 300)}`);
      if (assigned.length > 0) {
        const first = assigned[0];
        // roomName es el número físico (ej: "Room 1", "R5(1)")
        const raw = first.roomName || first.roomID || first.roomNumber || null;
        if (raw) {
          // Extraer número de "Room 1" → "1", "R5(1)" → "5", etc.
          const numMatch = raw.match(/(\d+)/);
          roomNumber = numMatch ? numMatch[1] : raw;
        }
      }
      console.log(`[Cloudbeds] roomNumber final: ${roomNumber}`);
    } catch (err) {
      console.error('[Cloudbeds] getReservation error:', err.message);
    }

    return {
      found: true,
      needsConfirmation,
      reservationId: match.reservationID,
      guestName: match.guestName || `${match.guestFirstName || ''} ${match.guestLastName || ''}`.trim(),
      roomNumber,
      roomName: match.roomTypeName || match.roomType || null,
      checkin: match.startDate,
      checkout: match.endDate,
      status: match.status,
    };
  } catch (err) {
    console.error('[Cloudbeds] checkReservation error:', err.message);
    throw err;
  }
}

// ─── Consultar disponibilidad ─────────────────────────────────────────────────
async function getAvailability(checkinDate, checkoutDate, guests = 1) {
  try {
    console.log(`[Cloudbeds] getAvailability: ${checkinDate} → ${checkoutDate} (${guests} pax)`);

    const d1 = new Date(checkinDate);
    const d2 = new Date(checkoutDate);
    const nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));

    // Llamadas en paralelo
    const [availData, typesData] = await Promise.all([
      api('GET', '/getAvailableRoomTypes', { startDate: checkinDate, endDate: checkoutDate }),
      api('GET', '/getRoomTypes', {}),
    ]);

    const propertyData = availData.data?.[0];
    if (!propertyData?.propertyRooms?.length) {
      return { rooms: [], totalCapacity: 0, guests };
    }

    // Mapa estático por roomTypeID
    const typesMeta = {};
    (typesData.data || []).forEach(t => {
      // Inferir capacidad real por habitación desde el nombre si maxGuests es incorrecto
      const name = t.roomTypeName.toLowerCase();
      let capPerRoom = parseInt(t.maxGuests) || 1;
      // Si no es privada, la capacidad real está en el nombre
      if (!t.isPrivate) {
        if (name.includes('6')) capPerRoom = 6;
        else if (name.includes('4')) capPerRoom = 4;
        else if (name.includes('5')) capPerRoom = 5;
      }
      typesMeta[t.roomTypeID] = {
        isPrivate: t.isPrivate,
        capPerRoom,
        nameNormalized: name.trim(),
      };
    });

    // Agrupar perfiles disponibles — usar nombre normalizado para unificar tipos idénticos
    const typeMap = new Map();
    propertyData.propertyRooms
      .filter(r => parseInt(r.roomsAvailable) > 0)
      .forEach(r => {
        const id = r.roomTypeID;
        const meta = typesMeta[id] || { isPrivate: true, capPerRoom: parseInt(r.maxGuests) || 1, nameNormalized: r.roomTypeName.toLowerCase().trim() };
        
        // Agrupar por nombre normalizado para unificar tipos con mismo nombre pero distinto ID
        const groupKey = meta.isPrivate ? id : meta.nameNormalized;
        
        if (!typeMap.has(groupKey)) {
          typeMap.set(groupKey, {
            roomTypeId: id,
            roomTypeName: r.roomTypeName.trim(),
            isPrivate: meta.isPrivate,
            capPerRoom: meta.capPerRoom,
            unitsAvail: parseInt(r.roomsAvailable) || 0,
            price: r.roomRate ? parseFloat(r.roomRate) : null,
            currency: propertyData.propertyCurrency?.currencyCode || 'EUR',
          });
        } else {
          typeMap.get(groupKey).unitsAvail += parseInt(r.roomsAvailable) || 0;
        }
      });

    const rooms = Array.from(typeMap.values()).map(r => {
      const pricePerNight = r.price ? Math.round(r.price / nights) : null;
      // Camas totales disponibles:
      // - Privada: unitsAvail = habitaciones disponibles → camas = unitsAvail * capPerRoom
      // - Compartida: unitsAvail = camas disponibles directamente
      const bedsAvailable = r.isPrivate ? r.unitsAvail * r.capPerRoom : r.unitsAvail;
      // Habitaciones físicas disponibles:
      const roomsPhysical = r.isPrivate ? r.unitsAvail : Math.floor(r.unitsAvail / r.capPerRoom);

      return {
        roomTypeId: r.roomTypeId,
        roomTypeName: r.roomTypeName,
        soldAsWhole: r.isPrivate,
        capacityPerRoom: r.capPerRoom,
        bedsAvailable,
        roomsPhysical,
        price: pricePerNight,
        currency: r.currency,
      };
    });

    const totalCapacity = rooms.reduce((sum, r) => sum + r.bedsAvailable, 0);

    console.log(`[Cloudbeds] ${rooms.length} tipos, capacidad total: ${totalCapacity}`);
    rooms.forEach(r => console.log(`  - ${r.roomTypeName}: soldAsWhole=${r.soldAsWhole}, cap=${r.capacityPerRoom}, beds=${r.bedsAvailable}, rooms=${r.roomsPhysical}, price=${r.price}`));

    return { rooms, totalCapacity, guests };

  } catch (err) {
    console.error('[Cloudbeds] getAvailability error:', err.message);
    if (err.response) {
      console.error('[Cloudbeds] status:', err.response.status);
      console.error('[Cloudbeds] data:', JSON.stringify(err.response.data || '').slice(0, 300));
    }
    throw err;
  }
}

// ─── URL de autorización OAuth (para el primer login) ────────────────────────
function getAuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CLOUDBEDS_CLIENT_ID,
    redirect_uri: process.env.CLOUDBEDS_REDIRECT_URI,
    scope: 'read:reservation write:reservation read:room read:rate_plan read:hotel read:guest',
  });
  return `https://hotels.cloudbeds.com/api/v1.2/oauth?${params}`;
}

// ─── Reservas para una fecha (para el panel admin) ───────────────────────────
async function getReservationsByDate(date) {
  try {
    const data = await api('GET', '/getReservations', {
      checkInFrom: date, checkInTo: date,
    });
    return (data.data || []).map(r => ({
      reservationId: r.reservationID,
      guestName: r.guestName || `${r.guestFirstName||''} ${r.guestLastName||''}`.trim(),
      roomNumber: r.roomID || r.roomNumber || null,
      checkin: r.startDate,
      checkout: r.endDate,
      adults: r.adults || 1,
      status: r.status,
    }));
  } catch (err) {
    console.error('[Cloudbeds] getReservationsByDate error:', err.message);
    return [];
  }
}

module.exports = { exchangeCode, checkReservation, getAvailability, getAuthUrl, getToken, getReservationsByDate };
