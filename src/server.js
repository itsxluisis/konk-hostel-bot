// src/server.js
'use strict';

require('dotenv').config();

const express = require('express');
const { exchangeCode, getAvailability, getAuthUrl, getToken, api: cloudbedsApi } = require('./cloudbeds');
const { send: sendTelegram } = require('./telegram');
const { buildReply } = require('./availability');
const vigilante = require('./vigilante');
const { matchesConfiguredSecret, timingSafeEqualStr } = require('./secret-auth');
const adminSession = require('./admin-session');
const vapiProxy = require('./vapi-proxy');

const path = require('path');
const fs = require('fs');
const app = express();

// EasyPanel pone Traefik delante: sin esto, req.ip es SIEMPRE la IP del
// proxy interno para todas las peticiones, no la del cliente real — rompe
// el rate-limit por IP de /admin/login (cualquiera bloquearía a todo el
// mundo) y los logs de auth rechazada. `1` = confiar en el primer proxy de
// la cadena (el propio Traefik), nada más allá.
app.set('trust proxy', 1);

app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vapi-secret, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Panel admin ──────────────────────────────────────────────────────────────
// Protegido con token en query string o cookie
app.use('/admin-panel', express.static(path.join(__dirname, '../public')));

// ─── Límite de fuerza bruta compartido (login + Basic auth) ──────────────────
// Sin dependencias nuevas: contador en memoria por IP, 10 intentos FALLIDOS
// / 15 min. Cubre POST /admin/login Y cualquier intento de HTTP Basic con
// ADMIN_USER/ADMIN_PASSWORD equivocados en CUALQUIER ruta protegida por
// adminAuth/vapiAuth — si solo protegiéramos /admin/login, se podría probar
// la contraseña sin límite contra, p. ej., GET /admin/vigilante. Una sesión
// de panel válida (x-admin-token) nunca cuenta ni se ve afectada por un
// bloqueo: es un token de alta entropía, adivinarlo no es viable por fuerza
// bruta. En memoria: se resetea en cada redeploy, igual que las sesiones.
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 10;
const loginAttemptsByIp = new Map(); // ip -> { count, windowStart }

function isIpBlocked(ip) {
  const entry = loginAttemptsByIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) return false;
  return entry.count > LOGIN_RATE_LIMIT_MAX;
}

/** Cuenta un intento fallido (login o Basic auth) para esta IP. */
function registerFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

// ─── Middleware: verificar que la llamada viene de Vapi ───────────────────────
// Fail-closed (H8): sin VAPI_SECRET configurado, las rutas protegidas
// devuelven 503 (no dejan pasar sin auth). El proceso sigue arrancado igual;
// solo estos endpoints quedan bloqueados hasta que se configure el secreto.
//
// Rotación (V1): si VAPI_SECRET_PREVIOUS está definida, también se acepta
// (ver src/secret-auth.js) — así se puede cambiar VAPI_SECRET en EasyPanel
// sin cortar el bot mientras Vapi todavía manda el secreto viejo.
//
// Admin panel (H3 — panel sin secretos): el navegador ya no conoce
// VAPI_SECRET. La pestaña "Test dispon." llama a este mismo tool
// (/vapi/get-availability) para previsualizar la respuesta del bot, así que
// una sesión de panel válida (o Basic con ADMIN_USER/ADMIN_PASSWORD) también
// autentica aquí. Las llamadas reales de Vapi siguen usando el secreto.
function vapiAuth(req, res, next) {
  const secret = process.env.VAPI_SECRET;
  if (!secret) {
    console.error(`[Auth] VAPI_SECRET no configurado — ${req.path} responde 503`);
    return res.status(503).json({ error: 'Servidor sin autenticación configurada (falta VAPI_SECRET)' });
  }

  const provided = req.headers['x-vapi-secret'] || req.headers['authorization'];
  if (matchesConfiguredSecret(provided, secret, process.env.VAPI_SECRET_PREVIOUS)) {
    return next();
  }
  if (isAdminAuthenticated(req)) {
    console.log(`[Auth] ${req.path} autenticado por sesión de panel admin`);
    return next();
  }

  console.warn('[Auth] RECHAZADO desde:', req.ip, '| path:', req.path);
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── Auth en modo warn/strict para tools "legacy" sin server.secret confirmado
// Comprobado en vivo (diag-server-messages.yml, 23-sep-2026): no está
// confirmado que Vapi mande x-vapi-secret ni con el end-of-call-report ni con
// get_weather. En 'warn' (por defecto) se deja pasar sin secreto válido, se
// loguea y se manda UN aviso a Telegram por proceso; en 'strict' se rechaza
// con 401. VAPI_END_OF_CALL_AUTH se conserva como alias de compatibilidad
// (ya documentado en .env.example) si VAPI_LEGACY_AUTH no está definida.
const VAPI_LEGACY_AUTH_MODE = (
  process.env.VAPI_LEGACY_AUTH || process.env.VAPI_END_OF_CALL_AUTH || 'warn'
).toLowerCase();

function legacyAuthOk(req) {
  const secret = process.env.VAPI_SECRET;
  if (!secret) return false;
  const provided = req.headers['x-vapi-secret'] || req.headers['authorization'];
  return matchesConfiguredSecret(provided, secret, process.env.VAPI_SECRET_PREVIOUS);
}

// ─── Middleware: panel admin (H3 — panel sin secretos) ────────────────────────
// El navegador nunca recibe VAPI_API_KEY ni VAPI_SECRET. Se autentica con:
//  a) el token de sesión que devuelve /admin/login (cabecera x-admin-token), o
//  b) HTTP Basic con ADMIN_USER/ADMIN_PASSWORD (para curl/diagnóstico manual).
// Nunca se aceptan credenciales por query string (solo cabeceras).
//
// Basic auth comparte el limitador de fuerza bruta con /admin/login (ver
// arriba): si la IP ya está bloqueada, se rechaza sin comprobar
// credenciales; si falla, cuenta como intento — así no se puede probar
// ADMIN_PASSWORD sin límite contra cualquier ruta /admin/* o /vapi/*.
function isAdminAuthenticated(req) {
  if (adminSession.isValidSession(req.headers['x-admin-token'])) return true;

  const authz = req.headers['authorization'];
  if (typeof authz !== 'string' || !authz.startsWith('Basic ')) return false;
  if (isIpBlocked(req.ip)) return false;

  const adminUser = process.env.ADMIN_USER || 'admin';
  const ok = adminSession.checkBasicAuth(authz, adminUser, process.env.ADMIN_PASSWORD);
  if (!ok) registerFailedAttempt(req.ip);
  return ok;
}

function adminAuth(req, res, next) {
  if (isAdminAuthenticated(req)) return next();
  console.warn('[AdminAuth] RECHAZADO desde:', req.ip, '| path:', req.path);
  return res.status(401).json({ error: 'Unauthorized' });
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
function vapiReply(req, res, result, status = 200) {
  const toolCallId = getToolCallId(req);
  console.log(`[Vapi] toolCallId: ${toolCallId}`);

  res.status(status);
  if (toolCallId) {
    return res.json({
      results: [{ toolCallId, result }],
    });
  }
  return res.json({ result });
}

// ─── OAUTH: flujo autorización inicial ───────────────────────────────────────

// Paso 1: obtener la URL de autorización de Cloudbeds.
// H14: el secreto va SOLO por cabecera (x-vapi-secret / Authorization), nunca
// por query string — un token en la URL acaba en logs de acceso e historial
// del navegador. Como un GET de navegador no puede mandar cabeceras propias,
// esta ruta ya no redirige directamente: devuelve la URL en JSON para
// pegarla en el navegador (curl -H "x-vapi-secret: $VAPI_SECRET" .../auth/cloudbeds).
app.get('/auth/cloudbeds', vapiAuth, (req, res) => {
  res.json({ url: getAuthUrl() });
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


// ─── H1: alerta a Telegram si Cloudbeds falla al consultar disponibilidad ────
// Rate-limit de 1 aviso cada 10 minutos para no inundar el tema ALERTAS si
// Cloudbeds está caído un buen rato.
let lastCloudbedsAlertAt = 0;
const CLOUDBEDS_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// ─── Cooldown persistente para avisos de arranque ────────────────────────────
// Un contador en memoria no sirve de cooldown para avisos que se disparan
// en el arranque: si el proceso entra en crash-loop, cada reinicio vuelve a
// tener memoria limpia y el tema ALERTAS se llenaría de spam. Se usa una
// marca en disco (DATA_DIR, igual que el vigilante) que sobrevive a los
// reinicios y, si hay volumen montado en EasyPanel, también a los redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ALERTA_ARRANQUE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 horas

/**
 * true si toca avisar (no hay marca previa o tiene más de `cooldownMs`).
 * Si toca avisar, actualiza la marca en el momento (no al enviar), para que
 * dos arranques seguidos en el mismo minuto no duplique el aviso.
 */
function debeAvisarConCooldown(marcaPath, cooldownMs) {
  try {
    const stat = fs.statSync(marcaPath);
    if (Date.now() - stat.mtimeMs < cooldownMs) return false;
  } catch (e) {
    // No existe la marca (primera vez o se borró el volumen) → toca avisar.
  }
  try {
    fs.mkdirSync(path.dirname(marcaPath), { recursive: true });
    fs.writeFileSync(marcaPath, String(Date.now()));
  } catch (e) {
    console.error('[Cooldown] No se pudo escribir la marca', marcaPath, '—', e.message);
  }
  return true;
}

function extractVapiCallInfo(req) {
  const phone =
    req.body?.message?.customer?.number
    || req.body?.message?.call?.customer?.number
    || req.body?.customer?.number
    || null;
  const callId =
    req.body?.message?.call?.id
    || req.body?.call?.id
    || req.body?.message?.toolCallList?.[0]?.id
    || null;
  return { phone, callId };
}

async function alertCloudbedsFailure(req, err) {
  const now = Date.now();
  if (now - lastCloudbedsAlertAt < CLOUDBEDS_ALERT_COOLDOWN_MS) {
    console.warn('[get-availability] Alerta a Telegram omitida (rate-limit 10 min)');
    return;
  }
  lastCloudbedsAlertAt = now;

  const kind = err?.kind || 'unknown';
  const shortMsg = (err?.message || 'error desconocido').slice(0, 200);
  const hora = new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const { phone, callId } = extractVapiCallInfo(req);

  const lines = [
    '⚠️ Konk Bot — Cloudbeds falló consultando disponibilidad',
    `Tipo: ${kind}`,
    `Error: ${shortMsg}`,
    `Hora: ${hora}`,
  ];
  if (phone) lines.push(`Tel: ${phone}`);
  if (callId) lines.push(`Llamada: ${callId}`);

  try {
    await sendTelegram(lines.join('\n'), { threadId: require('./encargado').hilo('ALERTAS') });
  } catch (e) {
    console.error('[get-availability] Error enviando alerta a Telegram:', e.message);
  }
}

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
    const { rooms, totalCapacity, nights } = await getAvailability(checkin_date, checkout_date, guests);
    // Fallback por si Cloudbeds no devolviera nights: calcularlo de las fechas
    const stayNights = nights || Math.max(1, Math.round((new Date(checkout_date) - new Date(checkin_date)) / 86400000));
    const reply = buildReply({ rooms, totalCapacity, guests, preference, nights: stayNights });
    console.log(`[get-availability] reply: ${reply}`);
    return vapiReply(req, res, reply);
  } catch (err) {
    console.error(`[get-availability] Error (kind=${err?.kind || 'unknown'}):`, err.message);
    // Fire-and-forget: no bloquear la respuesta al bot por el aviso a Telegram
    // (la tool tiene 8s de margen en Vapi).
    alertCloudbedsFailure(req, err).catch(e => console.error('[get-availability] alerta falló:', e.message));
    return vapiReply(req, res, 'Ahora mismo no puedo consultar la disponibilidad por un problema técnico. Puedes reservar directamente en haz tu reserva punto app, o llamar más tarde. Ya he avisado al equipo.');
  }
});




// ─── VAPI TOOL: report_incident ──────────────────────────────────────────────
// Escala una incidencia de huésped al equipo del hostel vía Telegram.
const INCIDENT_CATEGORY_LABELS = {
  acceso: 'ACCESO',
  mantenimiento: 'MANTENIMIENTO',
  limpieza: 'LIMPIEZA',
  ruido: 'RUIDO',
  otro: 'OTRO',
};

app.post('/vapi/report-incident', vapiAuth, async (req, res) => {
  const args = getToolArgs(req);
  const guest_name = args.guest_name || 'no indicado';
  const room = args.room || 'no indicada';
  const category = args.category || 'otro';
  const description = args.description || 'sin detalle';

  const categoryLabel = INCIDENT_CATEGORY_LABELS[category] || category.toUpperCase();

  // Mismo lugar del payload que usa /vapi/assistant-config (end-of-call-report: msg.customer.number),
  // con fallbacks encadenados por si la estructura del tool-call difiere.
  const phone =
    req.body?.message?.customer?.number
    || req.body?.message?.call?.customer?.number
    || req.body?.customer?.number
    || 'no detectado';
  const phoneLabel = phone === 'no detectado' ? 'no detectado (ver resumen de llamada)' : phone;

  const msg =
    `🔴 INCIDENCIA — ${categoryLabel}\n` +
    `Huésped: ${guest_name}\n` +
    `Habitación: ${room}\n` +
    `Teléfono: ${phoneLabel}\n` +
    `Detalle: ${description}`;

  console.log(`[report-incident] ${categoryLabel} | ${guest_name} | ${room} | ${phoneLabel} | ${description}`);

  try {
    // Una incidencia de un huésped va al carril de alertas del grupo.
    await sendTelegram(msg, { threadId: require('./encargado').hilo('ALERTAS') });
  } catch (err) {
    console.error('[report-incident] Error enviando a Telegram:', err.message);
  }

  return vapiReply(req, res, 'Incidencia registrada y equipo avisado.');
});

// ─── VAPI TOOL: get_weather ──────────────────────────────────────────────────
// La Manga del Mar Menor: 37.64°N, -0.73°E
// Auth en modo warn/strict (VAPI_LEGACY_AUTH, ver arriba): no está confirmado
// que este tool mande x-vapi-secret desde el assistant de Vapi, así que no
// puede ir en auth estricta (vapiAuth) todavía.
let warnedMissingWeatherSecret = false;
app.post('/vapi/get-weather', async (req, res) => {
  if (!legacyAuthOk(req)) {
    if (VAPI_LEGACY_AUTH_MODE === 'strict') {
      console.warn('[get-weather] RECHAZADO: sin secreto válido (modo strict)');
      return vapiReply(req, res, 'No puedo consultar el tiempo ahora mismo', 401);
    }
    console.warn('[get-weather] Llamada SIN secreto válido — dejando pasar (modo warn)');
    if (!warnedMissingWeatherSecret) {
      warnedMissingWeatherSecret = true;
      sendTelegram(
        '⚠️ Konk Bot: get_weather sin secreto válido (x-vapi-secret). '
        + 'Configurar server.secret en el assistant de Vapi y pasar VAPI_LEGACY_AUTH a strict.',
        { threadId: require('./encargado').hilo('ALERTAS') }
      ).catch(e => console.error('[get-weather] Error avisando falta de secreto:', e.message));
    }
  }
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
// H14: antes aceptaba el secreto también por ?token= (query string); ahora
// solo por cabecera. H3 (V1): esta y el resto de rutas /admin/* de diagnóstico
// ya no aceptan VAPI_SECRET desde el navegador — usan adminAuth (sesión del
// panel o Basic ADMIN_USER/ADMIN_PASSWORD), nunca query string.
app.get('/admin/room-types', adminAuth, async (req, res) => {
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
app.get('/admin/availability-debug', adminAuth, async (req, res) => {
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
// H3 (V1): ya NO devuelve VAPI_API_KEY ni VAPI_SECRET — el navegador no debe
// conocer ninguno de los dos. Devuelve un token de sesión opaco (ver
// src/admin-session.js) que el panel manda en la cabecera x-admin-token para
// el resto de rutas /admin/* y para las tools de Vapi que la pestaña "Test
// dispon." dispara desde el navegador.
// Rate-limit: mismo limitador compartido que la auth Basic (ver arriba). Solo
// cuentan los intentos FALLIDOS — un login correcto nunca gasta el cupo.
app.post('/admin/login', (req, res) => {
  if (isIpBlocked(req.ip)) {
    console.warn('[AdminLogin] Rate-limit excedido desde', req.ip);
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' });
  }
  const { user, pass } = req.body || {};
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD not set' });
  const ok = typeof user === 'string' && typeof pass === 'string'
    && timingSafeEqualStr(user, adminUser) && timingSafeEqualStr(pass, adminPass);
  if (!ok) {
    registerFailedAttempt(req.ip);
    return res.status(401).json({ ok: false });
  }
  const token = adminSession.createSession();
  res.json({ ok: true, token });
});

// ─── ADMIN: logout ────────────────────────────────────────────────────────────
app.post('/admin/logout', adminAuth, (req, res) => {
  adminSession.invalidateSession(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ─── ADMIN: proxy a la API de Vapi (H3 — panel sin secretos) ─────────────────
// La VAPI_API_KEY solo vive en el servidor (src/vapi-proxy.js). Allow-list
// explícita: exactamente las 4 llamadas que hace public/index.html hoy
// (historial de llamadas, detalle de llamada, asistente, guardar prompt).
function vapiLimit(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

app.get('/admin/vapi/calls', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('listCalls', { query: { limit: vapiLimit(req.query.limit, 50, 200) } });
    res.json(data);
  } catch (err) {
    console.error('[admin/vapi/calls]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

app.get('/admin/vapi/calls/:id', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('getCall', { params: { id: req.params.id } });
    res.json(data);
  } catch (err) {
    console.error('[admin/vapi/calls/:id]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

app.get('/admin/vapi/assistants', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('listAssistants', { query: { limit: vapiLimit(req.query.limit, 10, 50) } });
    res.json(data);
  } catch (err) {
    console.error('[admin/vapi/assistants]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

app.patch('/admin/vapi/assistants/:id', adminAuth, async (req, res) => {
  try {
    const { name, firstMessage, model } = req.body || {};
    const data = await vapiProxy.call('patchAssistant', {
      params: { id: req.params.id },
      body: { name, firstMessage, model },
    });
    res.json(data);
  } catch (err) {
    console.error('[admin/vapi/assistants/:id PATCH]', err.message);
    res.status(502).json({ error: 'Error actualizando Vapi' });
  }
});

// ─── ADMIN: reservas hoy y mañana ─────────────────────────────────────────────
app.get('/admin/reservations-today', adminAuth, async (req, res) => {
  try {
    // Fecha en hora de Madrid (en-CA da formato YYYY-MM-DD); UTC mostraría
    // el día anterior entre las 00:00 y la 01:00/02:00 hora española.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
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

// ─── VIGILANTE DE COBROS ──────────────────────────────────────────────────────
// Revisión manual. Sin ?enviar=1 solo devuelve lo que vería, no manda Telegram.
app.get('/admin/vigilante', adminAuth, async (req, res) => {
  try {
    const r = await vigilante.ejecutar({
      enviar: req.query.enviar === '1',
      todo: req.query.todo === '1',
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[Vigilante] error manual:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── H13: /health comprueba Cloudbeds de verdad ──────────────────────────────
// Antes: 'authorized' solo miraba si CLOUDBEDS_REFRESH_TOKEN existía como
// variable, no si el token sirve de verdad. Ahora hace una llamada barata
// autenticada (getRoomTypes) con caché de 5 minutos (el panel admin sondea
// /health cada 30s; sin caché golpearíamos Cloudbeds sin necesidad).
const CLOUDBEDS_HEALTH_TTL_MS = 5 * 60 * 1000;
let cloudbedsHealthCache = { status: 'error', checkedAt: null };
let cloudbedsHealthPromise = null;

async function checkCloudbedsHealth() {
  const now = Date.now();
  if (cloudbedsHealthCache.checkedAt && (now - cloudbedsHealthCache.checkedAt) < CLOUDBEDS_HEALTH_TTL_MS) {
    return cloudbedsHealthCache;
  }
  if (cloudbedsHealthPromise) return cloudbedsHealthPromise;

  cloudbedsHealthPromise = (async () => {
    let status = 'error';
    try {
      const data = await cloudbedsApi('GET', '/getRoomTypes', {});
      status = (data && data.success === false) ? 'error' : 'ok';
    } catch (err) {
      console.error('[health] Chequeo de Cloudbeds falló:', err.message);
      status = 'error';
    }
    cloudbedsHealthCache = { status, checkedAt: Date.now() };
    return cloudbedsHealthCache;
  })();

  try {
    return await cloudbedsHealthPromise;
  } finally {
    cloudbedsHealthPromise = null;
  }
}

app.get('/health', async (req, res) => {
  const cb = await checkCloudbedsHealth();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // 'ok' | 'error' — comprobación real (getRoomTypes), no solo si existe la variable.
    cloudbeds: cb.status,
    cloudbedsCheckedAt: cb.checkedAt ? new Date(cb.checkedAt).toISOString() : null,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
    vigilante: vigilante.info(),
    // H8: visibilidad de si las rutas protegidas están realmente protegidas.
    vapiSecretConfigured: !!process.env.VAPI_SECRET,
    // V1: booleanos, nunca valores. true mientras dure una rotación de
    // VAPI_SECRET (hay que retirar VAPI_SECRET_PREVIOUS cuando termine).
    vapiSecretPreviousActive: !!process.env.VAPI_SECRET_PREVIOUS,
    // true si el Encargado tiene su propio secreto (ENCARGADO_SECRET) en vez
    // de reusar VAPI_SECRET como fallback de compatibilidad.
    encargadoSecretDedicated: !!process.env.ENCARGADO_SECRET,
  });
});

// ─── H6: autenticar el informe de fin de llamada ─────────────────────────────
// Comprobado en vivo (diag-server-messages.yml, 23-sep-2026): el assistant de
// Vapi tiene serverMessages: ["end-of-call-report"] pero server.secret está
// SIN configurar (secretSet: false) — hoy Vapi NO manda x-vapi-secret con este
// evento. Por eso el modo por defecto es 'warn' (deja pasar + loguea + UN
// aviso a Telegram) y no 'strict' (que cortaría el resumen de cada llamada
// hasta que alguien active server.secret en el assistant, fuera del alcance
// de esta tanda — es un cambio de Vapi, no de este servidor).
// Modo y helper compartidos con get_weather: ver VAPI_LEGACY_AUTH_MODE y
// legacyAuthOk() cerca de vapiAuth, arriba.
let warnedMissingEndOfCallSecret = false;

// ─── VAPI: inyectar fecha actual al inicio de cada llamada ────────────────────
app.get('/vapi/assistant-config', (req, res) => res.json({ ok: true }));
app.post('/vapi/assistant-config', (req, res) => {
  const eventType = req.body?.message?.type;
  console.log(`[assistant-config] Evento recibido: ${eventType || 'desconocido'}, body keys: ${Object.keys(req.body||{}).join(',')}`);

  // Resumen post-llamada a Telegram
  if (eventType === 'end-of-call-report') {
    if (!legacyAuthOk(req)) {
      if (VAPI_LEGACY_AUTH_MODE === 'strict') {
        console.warn('[end-of-call] RECHAZADO: informe sin secreto válido (modo strict)');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      console.warn('[end-of-call] Informe SIN secreto válido — dejando pasar (modo warn)');
      if (!warnedMissingEndOfCallSecret) {
        warnedMissingEndOfCallSecret = true;
        sendTelegram(
          '⚠️ Konk Bot: el informe de fin de llamada llega sin secreto válido (x-vapi-secret). '
          + 'Cualquiera que conozca la URL podría inyectar informes falsos. '
          + 'Revisar server.secret en el assistant de Vapi (no configurado a día de hoy).',
          { threadId: require('./encargado').hilo('ALERTAS') }
        ).catch(e => console.error('[end-of-call] Error avisando falta de secreto:', e.message));
      }
    }
    const msg = req.body?.message;
    console.log('[end-of-call] Recibido evento fin de llamada');
    console.log('[end-of-call] Campos disponibles:', JSON.stringify({
      hasSummary: !!msg?.summary,
      hasAnalysis: !!msg?.analysis,
      analysisKeys: msg?.analysis ? Object.keys(msg.analysis) : [],
      summary: msg?.summary,
      analysisSummary: msg?.analysis?.summary,
    }));
    const duration = msg?.durationSeconds != null ? Math.round(msg.durationSeconds) : null;
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
      `📱 Tel: ${phone}`,
      { threadId: require('./encargado').hilo('LLAMADAS') }
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
if (process.env.VIGILANTE_OFF !== '1') vigilante.arrancar();
// ───── Encargado del Konk ─────
// Módulo aislado: vigila a los agentes (facturador, vigilante de cobros) y
// avisa si alguno no da señales de vida. No toca el flujo de voz.
require('./encargado').montar(app);

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
  GET  /auth/cloudbeds   (cabecera x-vapi-secret) ← devuelve la URL para autorizar Cloudbeds
  GET  /auth/cloudbeds/callback                   ← callback automático

  GET  /health                               ← estado del servidor
`);

  // Avisar si falta configuración crítica
  if (!process.env.CLOUDBEDS_CLIENT_ID) console.warn('⚠️  CLOUDBEDS_CLIENT_ID no configurado');
  if (!process.env.CLOUDBEDS_REFRESH_TOKEN) console.warn('⚠️  CLOUDBEDS_REFRESH_TOKEN no configurado — autoriza con: curl -H "x-vapi-secret: $VAPI_SECRET" .../auth/cloudbeds');
  if (!process.env.TELEGRAM_BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN no configurado');
  // H8: fail-closed — sin VAPI_SECRET, las rutas protegidas devuelven 503 (no
  // pasan sin auth). El proceso sigue arrancado; el log en consola se ve en
  // cada arranque, pero el aviso a Telegram lleva cooldown de 6h para no
  // inundar ALERTAS si el proceso entra en crash-loop.
  if (!process.env.VAPI_SECRET) {
    console.warn('⚠️  VAPI_SECRET no configurado — las rutas protegidas responden 503 hasta que se configure');
    if (debeAvisarConCooldown(path.join(DATA_DIR, '.alerta-vapi-secret'), ALERTA_ARRANQUE_COOLDOWN_MS)) {
      sendTelegram(
        '⚠️ Konk Bot: VAPI_SECRET no está configurado en este arranque. '
        + 'Las rutas protegidas (disponibilidad, incidencias, tiempo, panel admin) responden 503 hasta que se configure.',
        { threadId: require('./encargado').hilo('ALERTAS') }
      ).catch(e => console.error('[arranque] Error avisando falta de VAPI_SECRET:', e.message));
    } else {
      console.warn('[arranque] Aviso a Telegram omitido (cooldown 6h, ya se avisó recientemente)');
    }
  }

  // V1: rotación de VAPI_SECRET en curso. Mientras VAPI_SECRET_PREVIOUS esté
  // definida, vapiAuth/legacyAuthOk aceptan también el secreto viejo — hace
  // falta para poder cambiar VAPI_SECRET sin cortar el bot mientras Vapi
  // sigue usando el anterior. Un solo aviso por cooldown de 6h, igual que el
  // resto de avisos de arranque (evita spam en crash-loop).
  if (process.env.VAPI_SECRET_PREVIOUS) {
    console.warn('[Arranque] VAPI_SECRET_PREVIOUS definida — aceptando también el secreto anterior (rotación en curso).');
    if (debeAvisarConCooldown(path.join(DATA_DIR, '.alerta-vapi-secret-previous'), ALERTA_ARRANQUE_COOLDOWN_MS)) {
      sendTelegram(
        '🔄 Konk Bot: rotación de VAPI_SECRET en curso (VAPI_SECRET_PREVIOUS definida). '
        + 'Retirar VAPI_SECRET_PREVIOUS cuando Vapi ya use el nuevo secreto.',
        { threadId: require('./encargado').hilo('ALERTAS') }
      ).catch(e => console.error('[arranque] Error avisando rotación en curso:', e.message));
    } else {
      console.warn('[arranque] Aviso de rotación omitido (cooldown 6h, ya se avisó recientemente)');
    }
  }

});

module.exports = app;
