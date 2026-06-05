// src/server.js
'use strict';

require('dotenv').config();

const express = require('express');
const { exchangeCode, getAvailability, getAuthUrl, getToken } = require('./cloudbeds');
const { send: sendTelegram } = require('./telegram');

const path = require('path');
const app = express();
app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vapi-secret, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Panel admin ──────────────────────────────────────────────────────────────
// Protegido con token en query string o cookie
app.use('/admin-panel', express.static(path.join(__dirname, '../public')));

// ─── Middleware: verificar que la llamada viene de Vapi ───────────────────────
function vapiAuth(req, res, next) {
  const secret = process.env.VAPI_SECRET;
  if (!secret) return next();

  const auth = req.headers['x-vapi-secret'] || req.headers['authorization'];
  
  // Log para diagnosticar problemas de auth
  console.log(`[Auth] ${req.path} | x-vapi-secret: ${req.headers['x-vapi-secret']?.slice(0,8)}... | auth: ${auth?.slice(0,8)}...`);

  if (!auth || auth.replace('Bearer ', '') !== secret) {
    console.warn('[Auth] RECHAZADO desde:', req.ip, '| headers:', JSON.stringify(Object.keys(req.headers)));
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extraer toolCallId del request de Vapi
function getToolCallId(req) {
  return req.body?.message?.toolCallList?.[0]?.id
    || req.body?.toolCallId
    || req.body?.tool_call_id
    || null;
}

// Extraer parámetros del tool call (Vapi los envía dentro de message.toolCallList)
function getToolArgs(req) {
  const args = req.body?.message?.toolCallList?.[0]?.function?.arguments;
  if (args) return typeof args === 'string' ? JSON.parse(args) : args;
  // Fallback: parámetros directamente en el body (para tests con curl)
  return req.body;
}

// Formato de respuesta correcto para Vapi
function vapiReply(req, res, result) {
  const toolCallId = getToolCallId(req);
  console.log(`[Vapi] toolCallId: ${toolCallId}`);

  if (toolCallId) {
    return res.json({
      results: [{ toolCallId, result }],
    });
  }
  return res.json({ result });
}

// ─── OAUTH: flujo autorización inicial ───────────────────────────────────────

// Paso 1: redirigir a Cloudbeds para autorizar
app.get('/auth/cloudbeds', (req, res) => {
  // Proteger esta ruta con un token admin simple
  if (req.query.token !== process.env.VAPI_SECRET) {
    return res.status(401).send('No autorizado');
  }
  res.redirect(getAuthUrl());
});

// Paso 2: Cloudbeds redirige aquí con el código
app.get('/auth/cloudbeds/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error('[OAuth] Error en callback:', error);
    return res.status(400).send(`Error OAuth: ${error || 'sin código'}`);
  }

  try {
    const tokens = await exchangeCode(code);
    console.log('[OAuth] Autorización completada. Guarda estos tokens en .env:');
    console.log('CLOUDBEDS_ACCESS_TOKEN=' + tokens.accessToken);
    console.log('CLOUDBEDS_REFRESH_TOKEN=' + tokens.refreshToken);

    res.send(`
      <h2>✅ Konk Hostel Bot — Autorización completada</h2>
      <p>Cloudbeds conectado correctamente.</p>
      <p>El servidor ya puede verificar reservas y consultar disponibilidad.</p>
      <p><small>Copia el REFRESH_TOKEN en las variables de entorno de EasyPanel para que persista.</small></p>
      <pre>CLOUDBEDS_REFRESH_TOKEN=${tokens.refreshToken}</pre>
    `);
  } catch (err) {
    console.error('[OAuth] Error canjeando código:', err.message);
    res.status(500).send('Error al obtener tokens: ' + err.message);
  }
});


// ─── VAPI TOOL: get_availability ─────────────────────────────────────────────
app.post('/vapi/get-availability', vapiAuth, async (req, res) => {
  const args = getToolArgs(req);
  const checkin_date = args.checkin_date;
  const checkout_date = args.checkout_date;
  const guests = args.guests || 1;

  if (!checkin_date || !checkout_date) {
    return vapiReply(req, res, 'Necesito las fechas de entrada y salida para consultar disponibilidad.');
  }

  if (checkin_date >= checkout_date) {
    return vapiReply(req, res, 'La salida tiene que ser al menos un día después de la entrada. ¿Para qué día sería el checkout?');
  }

  // Corte de reservas: misma noche a partir de las 22:30 (hora de Murcia)
  const nowMurcia = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const todayISO = nowMurcia.toISOString().split('T')[0];
  const h = nowMurcia.getHours(), m = nowMurcia.getMinutes();
  if (checkin_date === todayISO && (h > 22 || (h === 22 && m >= 30))) {
    return vapiReply(req, res, 'Lo siento, las reservas para esta noche ya han cerrado. El plazo límite son las diez y media de la noche. ¿Te consulto disponibilidad para mañana u otra fecha?');
  }

  console.log(`[get-availability] ${checkin_date} → ${checkout_date} (${guests} personas)`);

  const bookingUrl = `https://www.booking.com/hotel/es/konk-hostel.es.html?checkin=${checkin_date}&checkout=${checkout_date}&group_adults=${guests}`;

  try {
    const { rooms, totalCapacity } = await getAvailability(checkin_date, checkout_date, guests);

    if (!rooms || rooms.length === 0) {
      return vapiReply(req, res, `No tenemos disponibilidad para esas fechas. Puedes consultar otras fechas en haz tu reserva punto a pe pe.`);
    }

    const privateRooms = rooms.filter(r => r.soldAsWhole).sort((a, b) => a.capacityPerRoom - b.capacityPerRoom);
    const sharedRooms = rooms.filter(r => !r.soldAsWhole).sort((a, b) => b.capacityPerRoom - a.capacityPerRoom);

    // ── 1-2 personas ──────────────────────────────────────────────────────────
    if (guests <= 2) {
      const opts = [];
      privateRooms.filter(r => r.bedsAvailable > 0).slice(0, 2).forEach(r => {
        opts.push(`${r.roomTypeName} a ${r.price} euros la noche`);
      });
      const cheapShared = sharedRooms[sharedRooms.length - 1];
      if (cheapShared && opts.length < 2) {
        opts.push(`cama en habitación compartida a ${cheapShared.price} euros`);
      }
      if (opts.length === 0) return vapiReply(req, res, `No tenemos disponibilidad para esas fechas.`);
      return vapiReply(req, res, `Para ${guests} persona${guests > 1 ? 's' : ''}: ${opts.join(', o bien ')}. Para reservar, entra en haz tu reserva punto a pe pe.`);
    }

    // ── Grupos (3+): combinar camas compartidas con upselling ─────────────────
    let remaining = guests;
    const combo = [];
    const upsells = [];

    for (const r of sharedRooms) {
      if (remaining <= 0) break;
      if (r.bedsAvailable <= 0) continue;

      const cap = r.capacityPerRoom;
      const bedsToUse = Math.min(remaining, r.bedsAvailable);
      const fullRooms = Math.floor(bedsToUse / cap);
      const extraBeds = bedsToUse % cap;
      const subtotal = r.price * bedsToUse;

      // Upsell: camas libres en habitación parcialmente ocupada
      if (extraBeds > 0) {
        const bedsLeftInRoom = cap - extraBeds;
        const isMujeres = r.roomTypeName.toLowerCase().includes('mujer');
        upsells.push({ bedsLeft: bedsLeftInRoom, price: r.price * bedsLeftInRoom, pricePerBed: r.price, isMujeres });
      }

      const nHab = (n) => n === 1 ? '1 habitación' : `${n} habitaciones`;

      let desc;
      if (extraBeds === 0) {
        desc = `${nHab(fullRooms)} compartida${fullRooms > 1 ? 's' : ''} a ${r.price} euros por cama, ${subtotal} euros en total`;
      } else if (fullRooms === 0) {
        desc = `camas en habitación compartida a ${r.price} euros por cama, ${subtotal} euros en total`;
      } else {
        desc = `${nHab(fullRooms)} completa${fullRooms > 1 ? 's' : ''} más camas en otra habitación compartida, todo a ${r.price} euros por cama, ${subtotal} euros en total`;
      }

      combo.push({ desc, subtotal });
      remaining -= bedsToUse;
    }

    if (remaining > 0) {
      return vapiReply(req, res, `Lo siento, no hay suficiente disponibilidad para ${guests} personas en esas fechas. La capacidad máxima disponible es de ${totalCapacity} personas. Consulta otras fechas en haz tu reserva punto a pe pe.`);
    }

    const totalPrice = combo.reduce((s, c) => s + c.subtotal, 0);
    const comboText = combo.map(c => c.desc).join(', más ');

    // Upsell inteligente
    let upsellText = '';
    if (upsells.length > 0) {
      const u = upsells[0];
      if (u.isMujeres) {
        upsellText = ` Por cierto, una de las camas está en la habitación exclusiva para mujeres — ¿hay alguna chica en el grupo?`;
      } else {
        const fullRoomTotal = totalPrice + u.price;
        upsellText = ` Si la queréis solo para vosotros, la habitación completa son ${fullRoomTotal} euros en total.`;
      }
    }

    // Opción hab. privada entera si encaja exactamente (litera matrimonial para 4)
    const wholeMatch = privateRooms.find(r => r.capacityPerRoom >= guests && r.bedsAvailable > 0);
    const extraOpt = wholeMatch
      ? ` También podéis reservar la habitación con litera matrimonial entera a ${wholeMatch.price} euros la noche.`
      : '';

    return vapiReply(req, res, `Para ${guests} personas: ${comboText}. Total ${totalPrice} euros la noche.${upsellText}${extraOpt} Para reservar entra en haz tu reserva punto a pe pe.`);

  } catch (err) {
    console.error('[get-availability] Error:', err.message);
    return vapiReply(req, res, `No he podido consultar disponibilidad en este momento. Puedes entrar en haz tu reserva punto a pe pe para ver opciones.`);
  }
});




// ─── VAPI TOOL: get_weather ──────────────────────────────────────────────────
// La Manga del Mar Menor: 37.64°N, -0.73°E
app.post('/vapi/get-weather', async (req, res) => {
  const axios = require('axios');
  const WMO = (c) => {
    if (c === 0) return 'cielo despejado';
    if (c <= 3) return 'parcialmente nublado';
    if (c <= 48) return 'niebla';
    if (c <= 57) return 'llovizna';
    if (c <= 67) return 'lluvia';
    if (c <= 77) return 'nieve';
    if (c <= 82) return 'chubascos';
    return 'tormenta';
  };
  try {
    const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: 37.64, longitude: -0.73,
        current_weather: true,
        daily: 'temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum',
        timezone: 'Europe/Madrid',
        forecast_days: 3,
      },
      timeout: 8000,
    });
    const cur = data.current_weather;
    const d = data.daily;
    const labels = ['hoy', 'mañana', 'pasado mañana'];
    const days = d.time.slice(0, 3).map((_, i) =>
      `${labels[i]}: ${WMO(d.weathercode[i])}, entre ${Math.round(d.temperature_2m_min[i])} y ${Math.round(d.temperature_2m_max[i])} grados`
    ).join('; ');
    console.log(`[get-weather] ${Math.round(cur.temperature)}°C, ${WMO(cur.weathercode)}`);
    return vapiReply(req, res, `Ahora mismo en La Manga: ${WMO(cur.weathercode)}, ${Math.round(cur.temperature)} grados. Previsión: ${days}.`);
  } catch (err) {
    console.error('[get-weather] Error:', err.message);
    return vapiReply(req, res, 'No he podido consultar el tiempo ahora mismo. Puedes ver la previsión en el buscador.');
  }
});

// ─── VAPI TOOL: get_current_date ─────────────────────────────────────────────
// El bot llama esto cuando necesita saber la fecha/hora actual
app.post('/vapi/get-current-date', vapiAuth, (req, res) => {
  const now = new Date();
  const murcia = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

  const isoToday = murcia.toISOString().split('T')[0];
  const anio = murcia.getFullYear();
  const hora = murcia.getHours().toString().padStart(2,'0');
  const min = murcia.getMinutes().toString().padStart(2,'0');

  const nextDays = [];
  for (let i = -7; i <= 7; i++) {
    const d = new Date(murcia);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().split('T')[0];
    const label = i === 0 ? 'HOY' : i === -1 ? 'ayer' : i === 1 ? 'mañana' : i < 0 ? `hace ${Math.abs(i)} días` : null;
    const entry = `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]} = ${iso}${label ? ` (${label})` : ''}`;
    nextDays.push(entry);
  }

  console.log(`[get-current-date] ${isoToday} ${hora}:${min} (Murcia)`);

  return vapiReply(req, res,
    `HOY es ${dias[murcia.getDay()]} ${murcia.getDate()} de ${meses[murcia.getMonth()]} (${isoToday}), son las ${hora}:${min}. Próximos 7 días: ${nextDays.filter((_,i) => i >= 7).join(', ')}.`
  );
});
// ─── DIAGNÓSTICO: ver estructura de room types en Cloudbeds ──────────────────
app.get('/admin/room-types', async (req, res) => {
  const token = req.headers['x-vapi-secret'] || req.query.token;
  if (process.env.VAPI_SECRET && token !== process.env.VAPI_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const axios = require('axios');
    const accessToken = await getToken();
    const response = await axios.get('https://hotels.cloudbeds.com/api/v1.2/getRoomTypes', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { propertyID: process.env.CLOUDBEDS_PROPERTY_ID },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: login ─────────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body || {};
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD not set' });
  if (user !== adminUser || pass !== adminPass) return res.status(401).json({ ok: false });
  res.json({ ok: true, vapiKey: process.env.VAPI_API_KEY || '', webhookSecret: process.env.VAPI_SECRET || '' });
});

// ─── ADMIN: reservas hoy y mañana ─────────────────────────────────────────────
app.get('/admin/reservations-today', vapiAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const { getReservationsByDate } = require('./cloudbeds');
    const [todayRes, tomorrowRes] = await Promise.all([
      getReservationsByDate(today),
      getReservationsByDate(tomorrow)
    ]);
    res.json({ today: todayRes, tomorrow: tomorrowRes });
  } catch (err) {
    console.error('[admin/reservations-today]', err.message);
    res.json({ today: [], tomorrow: [] });
  }
});

// ─── ADMIN: endpoint mantenido por compatibilidad con el panel, ya no envía Telegram ──
app.post('/admin/send-call-summary', vapiAuth, (req, res) => res.json({ ok: true }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cloudbeds: !!process.env.CLOUDBEDS_REFRESH_TOKEN ? 'authorized' : 'pending_auth',
    telegram: !!process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
  });
});

// ─── VAPI: inyectar fecha actual al inicio de cada llamada ────────────────────
app.get('/vapi/assistant-config', (req, res) => res.json({ ok: true }));
app.post('/vapi/assistant-config', (req, res) => {
  const eventType = req.body?.message?.type;
  console.log(`[assistant-config] Evento recibido: ${eventType || 'desconocido'}, body keys: ${Object.keys(req.body||{}).join(',')}`);

  // Resumen post-llamada a Telegram
  if (eventType === 'end-of-call-report') {
    const msg = req.body?.message;
    console.log('[end-of-call] Recibido evento fin de llamada');
    console.log('[end-of-call] Campos disponibles:', JSON.stringify({
      hasSummary: !!msg?.summary,
      hasAnalysis: !!msg?.analysis,
      analysisKeys: msg?.analysis ? Object.keys(msg.analysis) : [],
      summary: msg?.summary,
      analysisSummary: msg?.analysis?.summary,
    }));
    const duration = msg?.durationSeconds ? Math.round(msg.durationSeconds) : null;
    const cost = msg?.cost ? msg.cost.toFixed(3) : null;
    const summary = msg?.summary || msg?.analysis?.summary || null;
    const transcript = msg?.transcript || '';
    const phone = msg?.customer?.number || 'test';
    const structuredData = msg?.analysis?.structuredData || null;

    const tl = transcript.toLowerCase();
    const tipo = tl.includes('cajetín') || tl.includes('código') || tl.includes('no puedo entrar') ? 'Emergencia acceso' :
                 tl.includes('disponibilidad') || tl.includes('reservar') ? 'Consulta reserva' :
                 tl.includes('pelea') || tl.includes('emergencia') || tl.includes('médico') ? 'URGENCIA' :
                 'Info general';

    const durStr = duration ? `${Math.floor(duration/60)}m ${duration%60}s` : '—';

    let callbackLine = '';
    if (structuredData) {
      const emoji = structuredData.llamar ? '📞' : '✅';
      const label = structuredData.llamar ? 'LLAMAR' : 'No llamar';
      const motivo = structuredData.motivo || '';
      callbackLine = `\n${emoji} ${label}${motivo ? ` — ${motivo}` : ''}`;
    }

    console.log(`[end-of-call] ${phone} | ${tipo} | ${durStr} | €${cost||'—'} | callback: ${structuredData?.llamar ?? '?'}`);

    sendTelegram(
      `Llamada Konk Hostel\n\n` +
      `Numero: ${phone}\n` +
      `Tipo: ${tipo}\n` +
      `Duracion: ${durStr}\n` +
      `Coste: ${cost ? `€${cost}` : '—'}` +
      `${callbackLine}\n\n` +
      `${summary || 'Sin resumen'}`
    ).catch(console.error);

    return res.json({});
  }

  // Ignorar eventos frecuentes sin interés
  const ignoredEvents = ['speech-update', 'status-update', 'conversation-update'];
  if (ignoredEvents.includes(eventType)) {
    return res.json({});
  }

  // Log de cualquier evento no reconocido para detectar el end-of-call-report
  if (eventType !== 'assistant-request') {
    console.log(`[assistant-config] Evento no manejado: "${eventType}" | keys: ${Object.keys(req.body?.message || {}).join(',')}`);
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  });

  const dateInjection = `Today is ${dateStr}, ${timeStr} (Spain time). Current year is ${now.getFullYear()}. When dates are mentioned without a year, always use ${now.getFullYear()}.`;

  console.log(`[assistant-config] Inyectando: ${dateStr}`);

  if (eventType === 'assistant-request') {
    // Vapi pide qué asistente usar — devolvemos el asistente con override del prompt
    return res.json({
      assistant: {
        model: {
          messages: [{
            role: 'system',
            content: dateInjection,
          }],
        },
      },
    });
  }

  // Para cualquier otro evento, devolver las variables
  res.json({
    assistantOverrides: {
      variableValues: {
        current_date: dateStr,
        current_time: timeStr,
        current_year: now.getFullYear().toString(),
      },
    },
  });
});

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   Konk Hostel — Webhook Server                       ║
║   Puerto: ${PORT}                                        ║
║   URL: https://rentalme-konk-bot-webhook.sklshk.easypanel.host
╚══════════════════════════════════════════════════════╝

Endpoints Vapi:
  POST /vapi/get-availability
  POST /vapi/assistant-config   ← end-of-call-report + assistant-request

OAuth:
  GET  /auth/cloudbeds?token=TU_VAPI_SECRET  ← autorizar Cloudbeds
  GET  /auth/cloudbeds/callback              ← callback automático

  GET  /health                               ← estado del servidor
`);

  // Avisar si falta configuración crítica
  if (!process.env.CLOUDBEDS_CLIENT_ID) console.warn('⚠️  CLOUDBEDS_CLIENT_ID no configurado');
  if (!process.env.CLOUDBEDS_REFRESH_TOKEN) console.warn('⚠️  CLOUDBEDS_REFRESH_TOKEN no configurado — visita /auth/cloudbeds para autorizar');
  if (!process.env.TELEGRAM_BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN no configurado');
  if (!process.env.VAPI_SECRET) console.warn('⚠️  VAPI_SECRET no configurado — los endpoints no están protegidos');


});

module.exports = app;
