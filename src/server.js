// src/server.js
'use strict';

require('dotenv').config();

const express = require('express');
const { exchangeCode, getAvailability, getAuthUrl, getToken, api: cloudbedsApi } = require('./cloudbeds');
const { send: sendTelegram } = require('./telegram');
const { buildReply } = require('./availability');
const { normalizeStayDates, spokenDate, spokenDateRangePrefix } = require('./stay-dates');
const guestLookup = require('./guest-lookup');
const vigilante = require('./vigilante');
const { matchedSecretKind, timingSafeEqualStr } = require('./secret-auth');
const secretMatchCounters = require('./secret-match-counters');
const adminSession = require('./admin-session');
const vapiProxy = require('./vapi-proxy');
const { redactDeep } = require('./redact');

const path = require('path');
const fs = require('fs');
const app = express();

// EasyPanel pone Traefik delante: sin esto, req.ip es SIEMPRE la IP del
// proxy interno para todas las peticiones, no la del cliente real — rompe
// el rate-limit por IP de /admin/login (cualquiera bloquearía a todo el
// mundo) y los logs de auth rechazada. `1` = confiar en el primer proxy de
// la cadena (el propio Traefik), nada más allá.
app.set('trust proxy', 1);

// ─── V1.2 (commit A): límite de cuerpo más alto solo para /vapi/assistant-config
// El límite por defecto de express.json() es 100kb. El end-of-call-report de
// Vapi incluye el prompt del assistant (unos 26 kB) más de una vez dentro
// del payload (mensajes de tools ~48 kB) y el informe final puede superar
// 100kb — una llamada real de 24-sep-2026 nunca llegó a este handler,
// probablemente por esto. Montado ANTES del parser global: un cuerpo ya
// parseado (req._body === true) no se vuelve a parsear, así que para esta
// ruta manda el límite de 1mb de aquí y el resto de rutas sigue con el
// límite de 100kb de más abajo, sin tocarlo.
app.use('/vapi/assistant-config', express.json({ limit: '1mb' }));

app.use(express.json());

// Contador para /health de errores del body-parser (cuerpo demasiado grande
// o JSON roto) — solo metadatos (ruta, tipo, tamaño declarado), nunca el
// cuerpo en sí. El error-handling middleware que lo rellena vive al final
// del archivo (Express solo invoca middleware de error — 4 argumentos —
// registrado DESPUÉS del punto donde salta el error; con las rutas en medio
// sigue viendo los fallos de los dos express.json() de arriba).
const webhookBodyErrors = { count: 0, last: null };

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
// / 15 min (src/login-rate-limit.js, con purga propia de entradas vencidas).
// Cubre POST /admin/login Y cualquier intento de HTTP Basic con
// ADMIN_USER/ADMIN_PASSWORD equivocados en CUALQUIER ruta protegida por
// adminAuth/vapiAuth — si solo protegiéramos /admin/login, se podría probar
// la contraseña sin límite contra, p. ej., GET /admin/vigilante. Una sesión
// de panel válida (x-admin-token) nunca cuenta ni se ve afectada por un
// bloqueo: es un token de alta entropía, adivinarlo no es viable por fuerza
// bruta. En memoria: se resetea en cada redeploy, igual que las sesiones.
const { isBlocked: isIpBlocked, registerFailedAttempt } = require('./login-rate-limit');

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
  const kind = matchedSecretKind(provided, secret, process.env.VAPI_SECRET_PREVIOUS);
  if (kind) {
    // V1.1: contador de verificación de rotación (solo cuenta, no cambia la
    // decisión de autorización — ver src/secret-match-counters.js).
    secretMatchCounters.recordSecretMatch(kind);
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
  const kind = matchedSecretKind(provided, secret, process.env.VAPI_SECRET_PREVIOUS);
  if (kind) {
    secretMatchCounters.recordSecretMatch(kind);
    return true;
  }
  return false;
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

// ─── V1.2: guarda de fechas pasadas en get_availability ──────────────────────
// 24-sep-2026 (docs/plan-mejora-voz-sep-2026.md): un huésped real pidió
// "entrar mañana y salir el domingo" y gpt-4o-mini llamó a get_current_date y
// get_availability EN PARALELO, mandando fechas de hace varios años —no un
// año mal escrito, fechas inventadas—. Cloudbeds contesta success:false
// ("startDate should be greater than today") y eso se oía como un error
// técnico + disparaba una alerta a Telegram. Corregir la fecha nosotros
// mismos habría podido dar una fecha igual de falsa (ver src/stay-dates.js),
// así que NINGÚN checkin pasado se corrige solo: se rechaza sin llamar a
// Cloudbeds ni avisar a Telegram, y se le pide al MODELO —no al huésped—
// que recalcule con un calendario real.
const MISSING_DATES_MSG = 'Necesito las fechas de entrada y salida para consultar disponibilidad.';

// Contador para /health (visibilidad de cuánto dispara esta guarda; nunca
// bloquea nada ni cambia la respuesta al bot).
const availabilityDateRejections = { count: 0, lastAt: null };

// ─── VAPI TOOL: get_availability ─────────────────────────────────────────────
app.post('/vapi/get-availability', vapiAuth, async (req, res) => {
  const args = getToolArgs(req);
  const checkin_date = args.checkin_date;
  const checkout_date = args.checkout_date;
  const guests = parseInt(args.guests) || 1;
  const preference = args.preference || args.room_type || 'any';

  if (!checkin_date || !checkout_date) {
    return vapiReply(req, res, MISSING_DATES_MSG);
  }

  // "Hoy" en Europe/Madrid con toLocaleDateString('en-CA', ...) — NO con el
  // truco toLocaleString+toISOString (ver más abajo, nowMurcia): ese truco
  // desplaza el DÍA según la zona horaria del contenedor. Se calcula aquí
  // (único punto de I/O de reloj del handler) y se pasa al helper puro.
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

  const normalized = normalizeStayDates(checkin_date, checkout_date, todayISO);
  if (!normalized.ok) {
    if (normalized.reason === 'formato') {
      return vapiReply(req, res, MISSING_DATES_MSG);
    }
    // reason === 'pasada': ni Cloudbeds ni alerta a Telegram — no es un
    // fallo técnico (H1), es una fecha que el modelo calculó mal.
    //
    // Fix (hallazgo ALTA del auditor, 24-sep-2026): vapi/system-prompt.md
    // le dice al modelo que lea la respuesta de esta tool ENTERA Y TAL
    // CUAL — así que el texto anterior, dirigido al modelo ("FECHAS NO
    // VÁLIDAS... No le digas al huésped que hay un error..."), se estaba
    // leyendo en voz alta al huésped. Arreglado SIN tocar el prompt: el
    // texto de aquí tiene que valer para decirse tal cual, sin ISO, sin
    // calendario y sin la palabra "error". El modelo ya sabe la fecha de
    // hoy por el prompt y recalcula cuando el huésped repite las fechas.
    // normalizeStayDates() sigue calculando nextOccurrence (se loguea, útil
    // para depurar) pero ya no se dice.
    availabilityDateRejections.count++;
    availabilityDateRejections.lastAt = new Date().toISOString();
    console.log(`[get-availability] fecha pasada rechazada: ${checkin_date}→${checkout_date} (hoy ${todayISO}, nextOccurrence=${normalized.nextOccurrence || 'n/d'})`);

    return vapiReply(req, res,
      `Perdona, no he entendido bien las fechas. Hoy es ${spokenDate(todayISO)}. ¿Qué día quieres entrar y qué día salir?`
    );
  }

  const stayCheckin = normalized.checkin;
  const stayCheckout = normalized.checkout;

  if (stayCheckin >= stayCheckout) {
    return vapiReply(req, res, 'La salida tiene que ser al menos un día después de la entrada. ¿Para qué día sería el checkout?');
  }

  // Corte de reservas: misma noche a partir de las 22:30 (hora de Murcia)
  const nowMurcia = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const h = nowMurcia.getHours(), m = nowMurcia.getMinutes();
  if (stayCheckin === todayISO && (h > 22 || (h === 22 && m >= 30))) {
    return vapiReply(req, res, 'Lo siento, las reservas para esta noche ya han cerrado. El plazo límite son las diez y media de la noche. ¿Te consulto disponibilidad para mañana u otra fecha?');
  }

  console.log(`[get-availability] ${stayCheckin} → ${stayCheckout} (${guests} pax, pref=${preference})`);

  try {
    const { rooms, totalCapacity, nights } = await getAvailability(stayCheckin, stayCheckout, guests);
    // Fallback por si Cloudbeds no devolviera nights: calcularlo de las fechas
    const stayNights = nights || Math.max(1, Math.round((new Date(stayCheckout) - new Date(stayCheckin)) / 86400000));
    const reply = buildReply({ rooms, totalCapacity, guests, preference, nights: stayNights });
    // V1.2 (commit C): la consulta a Cloudbeds ha terminado bien (haya o no
    // disponibilidad) — anteponer las fechas consultadas en español. Esta
    // guarda solo rechaza checkin_date PASADO; si el modelo se equivoca en
    // una fecha futura, el huésped no tenía forma de saberlo. No toca
    // buildReply ni el texto que devuelve.
    const datesPrefix = spokenDateRangePrefix(stayCheckin, stayCheckout, todayISO);
    console.log(`[get-availability] reply: ${datesPrefix}${reply}`);
    return vapiReply(req, res, datesPrefix + reply);
  } catch (err) {
    console.error(`[get-availability] Error (kind=${err?.kind || 'unknown'}):`, err.message);
    // Fire-and-forget: no bloquear la respuesta al bot por el aviso a Telegram
    // (la tool tiene 8s de margen en Vapi).
    alertCloudbedsFailure(req, err).catch(e => console.error('[get-availability] alerta falló:', e.message));
    return vapiReply(req, res, 'Ahora mismo no puedo consultar la disponibilidad por un problema técnico. Puedes reservar directamente en haz tu reserva punto app, o llamar más tarde. Ya he avisado al equipo.');
  }
});




// V2a (24-sep-2026, docs/plan-mejora-voz-sep-2026.md): tope de tiempo
// COMPARTIDO frente a Cloudbeds para get_current_date Y report_incident.
// Corrección del auditor (24-sep-2026): report_incident llamaba a
// findStayByPhone SIN carrera — con la caché fría y Cloudbeds lento, el
// aviso de "no puede entrar" podía retrasarse varios segundos (hasta el
// timeout de 6s de la propia llamada HTTP en cloudbeds.js). Ninguna de las
// dos tools espera más de GUEST_LOOKUP_TIMEOUT_MS por Cloudbeds: si vence,
// get_current_date responde sin la línea de reserva (igual que si no
// hubiera estancia) y report_incident manda el aviso con "Reserva: no
// consultada a tiempo" (ver más abajo). GUEST_LOOKUP_TIMED_OUT es un Symbol
// para no poder confundirse nunca con null, un array vacío o una estancia
// real.
const GUEST_LOOKUP_TIMEOUT_MS = 2500;
const GUEST_LOOKUP_TIMED_OUT = Symbol('guest-lookup-timed-out');
function withGuestLookupTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(GUEST_LOOKUP_TIMED_OUT), GUEST_LOOKUP_TIMEOUT_MS)),
  ]);
}

// Línea "Reserva: ..." del aviso de Telegram de report_incident — un único
// sitio para no repetir la plantilla cuando hay varias reservas empatadas
// (ver findStaysByPhone en src/guest-lookup.js).
function formatStayLine(stay) {
  return `${stay.fullName || stay.firstName || '(sin nombre)'} · hab. ${stay.rooms ? stay.rooms.join(', ') : 'sin asignar'} · entrada ${stay.checkin || '?'} · salida ${stay.checkout || '?'} · canal ${stay.channel || '?'} · id ${stay.reservationId || '?'} · estado ${stay.status || '?'}`;
}

// ─── VAPI TOOL: report_incident ──────────────────────────────────────────────
// Escala una incidencia de huésped al equipo del hostel vía Telegram.
const INCIDENT_CATEGORY_LABELS = {
  acceso: 'ACCESO',
  mantenimiento: 'MANTENIMIENTO',
  limpieza: 'LIMPIEZA',
  ruido: 'RUIDO',
  otro: 'OTRO',
};

// V2a (24-sep-2026): una de cada cuatro llamadas del último mes era un
// huésped que no podía entrar (Vikey) — priorizar esas incidencias de
// verdad ayuda al equipo a reaccionar antes. Pura: recibe la hora de Madrid
// ya calculada (mismo patrón que src/stay-dates.js, "no tocar el reloj
// dentro de una función pura") para poder testearla sin depender del
// instante real en que corren los tests. Urgente si: el huésped ya está
// alojado (entró antes de hoy y no ha salido) — cualquier hora — o si llega
// HOY y ya son las 15:00 o más en Europe/Madrid (hora de check-in por
// defecto, ver memoria "Check-in 15:00 por defecto"). Antes de esa hora, una
// llegada de hoy con un aviso de acceso no es aún una emergencia (podría ser
// una duda sobre entrada anticipada).
function isUrgentAccessIncident(stay, todayISO, madridHour) {
  if (!stay || !stay.checkin || !stay.checkout) return false;
  if (stay.checkin < todayISO && stay.checkout > todayISO) return true; // ya alojado
  if (stay.checkin === todayISO) return madridHour >= 15;
  return false;
}

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

  // V2a: la(s) estancia(s) encontradas por teléfono se añaden SOLO al aviso
  // del EQUIPO (la respuesta hablada a Vapi, más abajo, no cambia). Nunca
  // rompe el aviso si Cloudbeds falla o tarda (findStaysByPhone no lanza;
  // withGuestLookupTimeout limita la espera) — el try/catch de aquí es una
  // segunda red de seguridad. Corrección del auditor (24-sep-2026): antes
  // se llamaba a findStayByPhone SIN carrera, así que con la caché fría y
  // Cloudbeds lento el aviso de "no puede entrar" podía retrasarse varios
  // segundos — ahora nunca espera más de GUEST_LOOKUP_TIMEOUT_MS.
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  let stays = []; // reservas del rango ganador: 0, 1, o varias si hay empate
  let lookupTimedOut = false;
  try {
    if (phone !== 'no detectado') {
      const result = await withGuestLookupTimeout(guestLookup.findStaysByPhone(phone, todayISO));
      if (result === GUEST_LOOKUP_TIMED_OUT) {
        lookupTimedOut = true;
      } else {
        stays = result;
      }
    }
  } catch (err) {
    console.error('[report-incident] Error consultando la estancia (no bloquea el aviso):', err.message);
  }

  // Corrección del auditor (empate, 24-sep-2026): si hay más de una reserva
  // en el rango ganador (p. ej. dos llegadas de hoy con el mismo teléfono),
  // se listan TODAS (findStaysByPhone ya las recorta a 3 como mucho) en
  // orden determinista, numeradas — nunca se elige una al azar. Si venció
  // el plazo de 2,5s, no se afirma nada sobre la reserva.
  const stayLine = lookupTimedOut
    ? 'Reserva: no consultada a tiempo'
    : !stays.length
      ? 'Reserva: no encontrada con este teléfono'
      : stays.length === 1
        ? `Reserva: ${formatStayLine(stays[0])}`
        : stays.map((s, i) => `Reserva ${i + 1}/${stays.length}: ${formatStayLine(s)}`).join('\n');

  // Las reservas empatadas comparten SIEMPRE el mismo veredicto de urgencia
  // (están en el mismo rango: o todas "llega hoy", o todas "alojado" — ver
  // rankOf/isUrgentAccessIncident en src/guest-lookup.js y arriba), así que
  // basta con mirar la primera. Si venció el plazo, no hay estancia con la
  // que calcular la urgencia: nunca se marca urgente por esta vía (el
  // huésped puede seguir describiéndolo como grave, pero eso no lo decide
  // esta tool).
  const nowMurcia = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const urgent = !lookupTimedOut && category === 'acceso'
    && isUrgentAccessIncident(stays[0] || null, todayISO, nowMurcia.getHours());

  const msg =
    (urgent ? '🚨 URGENTE — NO PUEDE ENTRAR\n' : '') +
    `🔴 INCIDENCIA — ${categoryLabel}\n` +
    `Huésped: ${guest_name}\n` +
    `Habitación: ${room}\n` +
    `Teléfono: ${phoneLabel}\n` +
    `${stayLine}\n` +
    `Detalle: ${description}`;

  console.log(`[report-incident] ${categoryLabel} | ${guest_name} | ${room} | ${phoneLabel} | ${description}${urgent ? ' | URGENTE' : ''}${lookupTimedOut ? ' | TIMEOUT' : ''}`);

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
    // V1.1: cuenta CADA petición sin secreto (no solo la primera) — es la
    // señal que dice en /health cuándo ya se puede pasar a modo strict.
    secretMatchCounters.recordLegacyUnsigned('getWeather');
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
//
// V2a (24-sep-2026, docs/plan-mejora-voz-sep-2026.md): si el teléfono de
// quien llama coincide con una única llegada de hoy/mañana o un alojado de
// hoy en Cloudbeds, se añade una frase con su reserva — nunca habitación,
// email, teléfono ni importe (ver src/guest-lookup.js). Si el teléfono
// coincide con VARIAS reservas del mismo rango (empate), findStayByPhone ya
// devuelve null a propósito (ambigüedad = no revelar nada; ver corrección
// del auditor en src/guest-lookup.js) y aquí no hace falta nada especial.
// Tope de GUEST_LOOKUP_TIMEOUT_MS (definido arriba, compartido con
// report_incident): si Cloudbeds tarda más, se responde sin esa línea (la
// consulta sigue en segundo plano y alimenta la caché de 3 min para la
// siguiente tool call de la misma llamada). No se toca el texto base de
// abajo.
app.post('/vapi/get-current-date', vapiAuth, async (req, res) => {
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

  let reply = `HOY es ${dias[murcia.getDay()]} ${murcia.getDate()} de ${meses[murcia.getMonth()]} (${isoToday}), son las ${hora}:${min}. Próximos 7 días: ${nextDays.filter((_,i) => i >= 7).join(', ')}.`;

  try {
    const { phone: callerPhone } = extractVapiCallInfo(req);
    if (callerPhone) {
      // todayISO propio, independiente de isoToday de arriba: isoToday usa
      // el truco toLocaleString+toISOString que V1.2 marcó como dependiente
      // de la zona horaria del contenedor (memory.md, 24-sep-2026); esta
      // consulta nueva usa el método seguro ya usado en /vapi/get-availability
      // (toLocaleDateString('en-CA', ...)), sin tocar isoToday ni el texto base.
      const lookupTodayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
      const stay = await withGuestLookupTimeout(guestLookup.findStayByPhone(callerPhone, lookupTodayISO));
      if (stay && stay !== GUEST_LOOKUP_TIMED_OUT && stay.firstName && stay.checkin && stay.checkout) {
        reply += ` RESERVA DE QUIEN LLAMA: a nombre de ${stay.firstName}, entrada el ${spokenDate(stay.checkin)}, salida el ${spokenDate(stay.checkout)}.`;
      }
    }
  } catch (err) {
    // Nunca romper la tool por esto: sin estancia, el texto queda igual que hoy.
    console.error('[get-current-date] Error añadiendo la reserva de quien llama (se responde sin esa línea):', err.message);
  }

  return vapiReply(req, res, reply);
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
// explícita: exactamente las llamadas que hace public/index.html hoy
// (historial de llamadas, detalle de llamada, asistente, guardar prompt).
//
// V1.1 (docs/plan-mejora-voz-sep-2026.md): las 3 respuestas GET se redactan
// (src/redact.js) antes de mandarlas al navegador — el objeto de Vapi trae
// secretos de verdad (server.headers/secret de tools inline, monitor.listenUrl
// /controlUrl de una llamada en vivo) que nunca deben llegar al panel.
function vapiLimit(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

app.get('/admin/vapi/calls', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('listCalls', { query: { limit: vapiLimit(req.query.limit, 50, 200) } });
    res.json(redactDeep(data));
  } catch (err) {
    console.error('[admin/vapi/calls]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

app.get('/admin/vapi/calls/:id', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('getCall', { params: { id: req.params.id } });
    res.json(redactDeep(data));
  } catch (err) {
    console.error('[admin/vapi/calls/:id]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

app.get('/admin/vapi/assistants', adminAuth, async (req, res) => {
  try {
    const data = await vapiProxy.call('listAssistants', { query: { limit: vapiLimit(req.query.limit, 10, 50) } });
    res.json(redactDeep(data));
  } catch (err) {
    console.error('[admin/vapi/assistants]', err.message);
    res.status(502).json({ error: 'Error consultando Vapi' });
  }
});

// ─── ADMIN: guardar asistente — fusión en servidor (V1.1) ────────────────────
// El PATCH que sale del navegador antes reenviaba el `model` que mandara el
// panel (Object.assign sobre lo último que se leyó por GET). Como el GET ya
// viene redactado (arriba), ese `model` traía "[redactado]" en los secretos
// de las tools — un guardado real los habría pisado en Vapi. Ahora el
// navegador solo puede pedir 4 campos de texto; el `model` que se manda a
// Vapi lo construye el SERVIDOR a partir del assistant real (nueva ruta
// `getAssistant` en la allow-list de src/vapi-proxy.js), que nunca ha
// pasado por el navegador.
const ASSISTANT_PATCH_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ASSISTANT_PATCH_MAX_LEN = { name: 80, modelName: 80, firstMessage: 1000, systemPrompt: 60000 };

/**
 * Valida el body del PATCH de asistente: SOLO { name, firstMessage,
 * modelName, systemPrompt }, todos opcionales, todos string, con tope de
 * longitud. Cualquier otro campo del body (en particular `model`, que es lo
 * que mandaba el navegador antes) se ignora sin más: nunca se lee.
 */
function validateAssistantPatchFields(body) {
  const fields = {};
  for (const key of Object.keys(ASSISTANT_PATCH_MAX_LEN)) {
    const val = body ? body[key] : undefined;
    if (val === undefined) continue;
    if (typeof val !== 'string') return { error: `${key} debe ser texto` };
    if (val.length > ASSISTANT_PATCH_MAX_LEN[key]) {
      return { error: `${key} supera el máximo de ${ASSISTANT_PATCH_MAX_LEN[key]} caracteres` };
    }
    fields[key] = val;
  }
  return { fields };
}

/**
 * Construye el `model` a mandar a Vapi a partir del model REAL del
 * asistente (con sus tools, toolIds y secretos reales — nunca han pasado
 * por el navegador): cambia `model.model` si llega `modelName` y sustituye
 * el contenido del mensaje `role:'system'` por `systemPrompt` si llega (si
 * no hay mensaje system, lo añade al principio; conserva el resto de
 * mensajes tal cual). No muta `realModel`.
 */
function buildAssistantModel(realModel, fields) {
  const base = (realModel && typeof realModel === 'object') ? realModel : {};
  const model = Object.assign({}, base);

  if (fields.modelName !== undefined) {
    model.model = fields.modelName;
  }

  if (fields.systemPrompt !== undefined) {
    const messages = Array.isArray(base.messages) ? base.messages.slice() : [];
    const idx = messages.findIndex((m) => m && m.role === 'system');
    if (idx === -1) {
      messages.unshift({ role: 'system', content: fields.systemPrompt });
    } else {
      messages[idx] = Object.assign({}, messages[idx], { content: fields.systemPrompt });
    }
    model.messages = messages;
  }

  return model;
}

app.patch('/admin/vapi/assistants/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!ASSISTANT_PATCH_ID_RE.test(id)) {
    return res.status(400).json({ error: 'id de asistente inválido' });
  }

  const { fields, error } = validateAssistantPatchFields(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const real = await vapiProxy.call('getAssistant', { params: { id } });
    const model = buildAssistantModel(real && real.model, fields);

    const patchBody = { model };
    if (fields.name !== undefined) patchBody.name = fields.name;
    if (fields.firstMessage !== undefined) patchBody.firstMessage = fields.firstMessage;

    const data = await vapiProxy.call('patchAssistant', { params: { id }, body: patchBody });
    res.json(redactDeep(data));
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
    // V1.1: contadores para decidir cuándo es seguro retirar
    // VAPI_SECRET_PREVIOUS y pasar VAPI_LEGACY_AUTH a strict — previous=0 y
    // legacyUnsigned=0 tras una llamada de prueba con el secreto nuevo (ver
    // src/secret-match-counters.js). Solo números/fechas, nunca secretos.
    ...secretMatchCounters.snapshot(),
    // V1.2: cuántas veces get_availability ha rechazado un checkin_date
    // pasado (ver arriba) — nunca bloquea nada, es solo visibilidad de
    // cuánto se dispara la guarda.
    availabilityDateRejections: { ...availabilityDateRejections },
    // V2a: estadísticas del reconocimiento de huésped por teléfono
    // (get_current_date + report_incident) — solo números y fecha, nunca
    // datos de huéspedes (ver src/guest-lookup.js).
    guestLookup: guestLookup.healthSnapshot(),
    // V1.2 (commit A): errores del body-parser (cuerpo grande / JSON roto) —
    // ver middleware de error al final del archivo. Solo metadatos.
    webhookBodyErrors: { count: webhookBodyErrors.count, last: webhookBodyErrors.last },
    // V1.2 (commit A): cuántos end-of-call-report han llegado a
    // /vapi/assistant-config, contado ANTES de la autenticación.
    endOfCall: { ...endOfCallReports },
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

// V1.2 (commit A): cuántos end-of-call-report LLEGAN a este handler, contado
// ANTES de la autenticación — visibilidad independiente de si legacyAuthOk
// pasa o no. Motivo: una llamada real de 24-sep-2026 no dejó rastro de su
// informe de fin de llamada; si el payload no llega ni a esta línea (p. ej.
// por el límite de cuerpo, ver commit A más arriba) este contador se queda
// en 0 para esa llamada aunque el resto del log diga que terminó bien.
const endOfCallReports = { received: 0, lastAt: null };

// ─── VAPI: inyectar fecha actual al inicio de cada llamada ────────────────────
app.get('/vapi/assistant-config', (req, res) => res.json({ ok: true }));
app.post('/vapi/assistant-config', (req, res) => {
  const eventType = req.body?.message?.type;
  console.log(`[assistant-config] Evento recibido: ${eventType || 'desconocido'}, body keys: ${Object.keys(req.body||{}).join(',')}`);

  // Resumen post-llamada a Telegram
  if (eventType === 'end-of-call-report') {
    endOfCallReports.received++;
    endOfCallReports.lastAt = new Date().toISOString();
    if (!legacyAuthOk(req)) {
      if (VAPI_LEGACY_AUTH_MODE === 'strict') {
        console.warn('[end-of-call] RECHAZADO: informe sin secreto válido (modo strict)');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      console.warn('[end-of-call] Informe SIN secreto válido — dejando pasar (modo warn)');
      secretMatchCounters.recordLegacyUnsigned('endOfCall');
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

// ─── V1.2 (commit A): errores del body-parser (cuerpo grande / JSON roto) ────
// express.json() llama a next(err) cuando el cuerpo supera el límite
// (err.type === 'entity.too.large', 413) o no es JSON válido
// (err.type === 'entity.parse.failed', 400). Sin este middleware, Express
// respondía con su página de error HTML por defecto. Solo registra
// metadatos (nunca el cuerpo) y cuenta en webhookBodyErrors para /health.
// Cualquier otro error sigue su camino normal (next(err)) — no cambia el
// comportamiento de errores que no vienen del body-parser.
app.use((err, req, res, next) => {
  if (!err || (err.type !== 'entity.too.large' && err.type !== 'entity.parse.failed')) {
    return next(err);
  }
  const declaredLength = Number.isFinite(err.length) ? err.length : (Number(req.headers['content-length']) || null);
  console.error(`[body-parser] ${err.type} en ${req.path} (longitud declarada: ${declaredLength ?? 'desconocida'})`);
  webhookBodyErrors.count++;
  webhookBodyErrors.last = { at: new Date().toISOString(), path: req.path, type: err.type, length: declaredLength };

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Cuerpo demasiado grande' });
  }
  return res.status(400).json({ error: 'JSON inválido' });
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

  // V2a corrección NEXO (24-sep-2026): calienta la caché de guest-lookup en
  // segundo plano nada más arrancar, para que /health → guestLookup.scan
  // tenga datos cuanto antes. Fire-and-forget a propósito: no se espera
  // (await) aquí — un Cloudbeds lento o caído no debe retrasar ni romper el
  // arranque del servidor (warmCache() ya se traga sus propios errores).
  guestLookup.warmCache();

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

// V2a: expuesta para tests (test/vapi-guest-recognition.test.js) sin tener
// que falsear el reloj global de un servidor real con otros temporizadores
// vivos (vigilante, encargado…) — mismo motivo que la hace pura arriba.
app.isUrgentAccessIncident = isUrgentAccessIncident;

module.exports = app;
