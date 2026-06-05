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

// ─── Diagnóstico: devuelve el roomRate CRUDO de Cloudbeds + el computado ──────
// Sirve para entender la semántica del precio (total estancia vs por noche).
async function getAvailabilityDebug(checkinDate, checkoutDate) {
  const d1 = new Date(checkinDate);
  const d2 = new Date(checkoutDate);
  const nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));

  const availData = await api('GET', '/getAvailableRoomTypes', { startDate: checkinDate, endDate: checkoutDate });
  const propertyData = availData.data?.[0];
  const raw = (propertyData?.propertyRooms || []).map(r => ({
    roomTypeName: r.roomTypeName,
    roomTypeID: r.roomTypeID,
    roomsAvailable: r.roomsAvailable,
    maxGuests: r.maxGuests,
    roomRate: r.roomRate,
    roomRate_div_nights: r.roomRate ? Math.round(parseFloat(r.roomRate) / nights) : null,
  }));
  return { nights, currency: propertyData?.propertyCurrency?.currencyCode || 'EUR', raw };
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

module.exports = { exchangeCode, getAvailability, getAvailabilityDebug, getAuthUrl, getToken, getReservationsByDate };
