// src/server.js
'use strict';

require('dotenv').config();

const express = require('express');
const { exchangeCode, getAvailability, getAuthUrl, getToken } = require('./cloudbeds');
const { send: sendTelegram } = require('./telegram');
const { buildReply } = require('./availability');

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
  const guests = parseInt(args.guests) || 1;
  const preference = args.preference || args.room_type || 'any';

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

  console.log(`[get-availability] ${checkin_date} → ${checkout_date} (${guests} pax, pref=${preference})`);

  try {
    const { rooms, totalCapacity } = await getAvailability(checkin_date, checkout_date, guests);
    const reply = buildReply({ rooms, totalCapacity, guests, preference });
    console.log(`[get-availability] reply: ${reply}`);
    return vapiReply(req, res, reply);
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
    const label = i === 0 ? 'HOY' : i === -1 ? 'ayer' : i === 1 ? 'mañana' : i === 2 ? 'pasado mañana' : i < 0 ? `hace ${Math.abs(i)} días` : `en ${i} días`;
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

// ─── DIAGNÓSTICO: precios crudos de Cloudbeds para un rango ──────────────────
app.get('/admin/availability-debug', vapiAuth, async (req, res) => {
  const { checkin, checkout } = req.query;
  if (!checkin || !checkout) return res.status(400).json({ error: 'Faltan checkin/checkout' });
  try {
    const { getAvailabilityDebug } = require('./cloudbeds');
    const data = await getAvailabilityDebug(checkin, checkout);
    res.json(data);
  } catch (err) {
    console.error('[availability-debug]', err.message);
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
    const phone = msg?.customer?.number || 'test';
    const sd = msg?.analysis?.structuredData || null;

    // Campos esquemáticos (vienen del structuredDataPlan de Vapi)
    const llamar = sd?.llamar === true;
    const motivo = sd?.motivo || '—';
    const descripcion = sd?.descripcion || msg?.summary || msg?.analysis?.summary || '(sin descripción)';

    // Coste con coma decimal y 2 decimales
    const costeStr = (typeof msg?.cost === 'number') ? `${msg.cost.toFixed(2).replace('.', ',')} €` : '—';
    // Duración mm:ss
    const durStr = duration != null ? `${Math.floor(duration/60)}m ${duration%60}s` : '—';
    // Momento de la llamada (hora de Murcia)
    const started = msg?.startedAt ? new Date(msg.startedAt) : new Date();
    const momento = started.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    const cabecera = llamar ? '📞 LLAMAR' : '✅ No llamar';

    console.log(`[end-of-call] ${phone} | ${motivo} | ${durStr} | ${costeStr} | llamar: ${llamar}`);

    sendTelegram(
      `🏨 Konk Hostel · llamada\n\n` +
      `${cabecera}\n` +
      `📋 Motivo: ${motivo}\n` +
      `📝 ${descripcion}\n\n` +
      `💶 Coste: ${costeStr}\n` +
      `⏱️ Duración: ${durStr}\n` +
      `🕐 Cuándo: ${momento}\n` +
      `📱 Tel: ${phone}`
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
