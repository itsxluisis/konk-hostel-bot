// src/vigilante.js
// Vigilante de cobros del Konk. Revisa Cloudbeds cada mañana y avisa por
// Telegram SOLO si hay algo. Silencio = todo cuadra.
//
// Nace de la auditoría de 2025: 4.333 € se escaparon simplemente porque nadie
// miraba a tiempo. Todo lo perdido era detectable en 24 horas.
'use strict';

const fs = require('fs');
const path = require('path');
const { api } = require('./cloudbeds');
const { send: sendTelegram } = require('./telegram');

// Canales que cobran ELLOS: nunca generan alarma de cobro (allí el control es
// la liquidación de la OTA, no el saldo del PMS).
const OTA = (process.env.VIGILANTE_OTA ||
  'Booking.com,Airbnb (API),Expedia').split(',').map(s => s.trim());

const DIAS_ATRAS = Number(process.env.VIGILANTE_DIAS_ATRAS || 120);
// Fecha de corte: no se avisa de reservas que ya habían salido antes de que
// existiera el vigilante. Ese pasivo se gestionó a mano; repetirlo cada mañana
// sería ruido, y el ruido es lo que acaba haciendo que se ignoren las alertas.
const DESDE = process.env.VIGILANTE_DESDE || '2026-09-10';
const DIAS_TX = Number(process.env.VIGILANTE_DIAS_TX || 10);
const DIAS_BLOQUEOS = Number(process.env.VIGILANTE_DIAS_BLOQUEOS || 30);
const UMBRAL = Number(process.env.VIGILANTE_UMBRAL || 0.5);
const RECORDAR_CADA = Number(process.env.VIGILANTE_RECORDAR_DIAS || 7);
const HORA = Number(process.env.VIGILANTE_HORA || 9);
const TZ = 'Europe/Madrid';

// Resiliencia ante un Cloudbeds lento (incidente del 5-oct-2026: timeout de 6 s
// a las 09:02 y el día quedó sin revisar). El vigilante corre en segundo plano,
// no tiene un huésped esperando al teléfono: puede esperar más que el bot de voz.
const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);
const TIMEOUT_MS = num(process.env.VIGILANTE_TIMEOUT_MS, 30000);       // por llamada
const REINTENTOS_API = num(process.env.VIGILANTE_REINTENTOS_API, 2);   // por llamada
const BACKOFF_MS = num(process.env.VIGILANTE_BACKOFF_MS, 3000);        // 3 s, 6 s, 12 s...
const INTENTOS_DIA = num(process.env.VIGILANTE_INTENTOS_DIA, 3);       // revisiones completas al día
const REINTENTO_MIN = num(process.env.VIGILANTE_REINTENTO_MIN, 20);    // espera entre ellas
const HORA_LIMITE = num(process.env.VIGILANTE_HORA_LIMITE, 12);        // no reintenta a partir de esta hora
// Tope global de un intento completo: si algo se cuelga sin timeout propio, cuenta
// como fallo de ese intento en vez de dejar `enCurso` enganchado hasta un reinicio.
const TOPE_INTENTO_MS = num(process.env.VIGILANTE_TOPE_INTENTO_MS, 5 * 60 * 1000);

// Con WORKDIR /app y el código en /app/src, esto resuelve a /app/data: montar
// ahí un volumen de EasyPanel basta para que el estado sobreviva a los deploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ESTADO = path.join(DATA_DIR, 'vigilante-estado.json');

// ─── utilidades ──────────────────────────────────────────────────────────────
const eur = n => new Intl.NumberFormat('es-ES',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' €';

/** Fecha/hora local de Madrid, independiente del reloj del contenedor. */
function ahoraMadrid() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const g = t => f.find(p => p.type === t).value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    fecha: `${g('year')}-${g('month')}-${g('day')}`,
    hora: Number(g('hour')),
    diaSemana: dias[g('weekday')],
  };
}

const dias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const dormir = ms => new Promise(r => setTimeout(r, ms));

/**
 * ¿Merece la pena repetir esta llamada? Sí ante lo transitorio: timeout, corte
 * de red, 429 y 5xx. Nunca ante un 4xx (401/403 = auth, el resto = petición
 * mala): repetirlo solo machacaría a Cloudbeds con el mismo error.
 */
function esTransitorio(err) {
  const st = err && err.response && err.response.status;
  if (st) return st === 429 || st >= 500;
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
    'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_NETWORK'].includes(err && err.code);
}

/**
 * Llamada a Cloudbeds con timeout propio y reintentos con espera creciente.
 * Si se agota, lanza un Error que nombra la llamada (err.endpoint) y el motivo.
 */
async function llamar(method, endpoint, params = {}) {
  let intento = 0;
  for (;;) {
    try {
      return await api(method, endpoint, params, { timeout: TIMEOUT_MS });
    } catch (e) {
      intento++;
      if (esTransitorio(e) && intento <= REINTENTOS_API) {
        const espera = BACKOFF_MS * 2 ** (intento - 1);
        console.warn(`[Vigilante] ${method} ${endpoint} falló (${e.code || (e.response && e.response.status) || e.message}); reintento ${intento}/${REINTENTOS_API} en ${espera} ms`);
        await dormir(espera);
        continue;
      }
      const st = e.response && e.response.status;
      const err = new Error(`${method} ${endpoint} — ${e.message}`
        + (st ? ` (HTTP ${st})` : (e.code ? ` (${e.code})` : ''))
        + (intento > 1 ? ` tras ${intento} intentos` : ''));
      err.endpoint = `${method} ${endpoint}`;
      err.status = st;
      err.code = e.code;
      throw err;
    }
  }
}

async function paginas(endpoint, params = {}, size = 100) {
  const out = [];
  for (let page = 1; page <= 300; page++) {
    const r = await llamar('GET', endpoint, { ...params, pageNumber: page, pageSize: size });
    if (!r.success) {
      const err = new Error(`GET ${endpoint}: ${JSON.stringify(r).slice(0, 200)}`);
      err.endpoint = `GET ${endpoint}`;
      throw err;
    }
    const d = r.data || [];
    out.push(...d);
    if (d.length < size) break;
  }
  return out;
}

const cobraLaOta = canal => OTA.includes((canal || '').trim());

// ─── estado (para no repetir la misma alarma cada día) ───────────────────────
let memoria = { conocidos: {} };

function cargarEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  } catch {
    return memoria;
  }
}

function guardarEstado(e) {
  memoria = e;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ESTADO, JSON.stringify(e, null, 1));
  } catch (err) {
    // Sin volumen persistente el estado vive en memoria: tras un redeploy
    // puede repetirse un aviso una vez. No es motivo para fallar.
    console.warn('[Vigilante] estado solo en memoria:', err.message);
  }
}

/** Separa en nuevos / ya avisados y refresca la fecha del último aviso. */
function particionar(items, clave, estado, hoy, todo) {
  const nuevos = [], viejos = [];
  for (const x of items) {
    const k = clave(x);
    const prev = estado.conocidos[k];
    if (todo || !prev) {
      nuevos.push(x); estado.conocidos[k] = hoy;
    } else {
      const d = Math.round((new Date(hoy) - new Date(prev)) / 86400000);
      if (d >= RECORDAR_CADA) { nuevos.push(x); estado.conocidos[k] = hoy; }
      else viejos.push(x);
    }
  }
  return { nuevos, viejos };
}

// ─── alarmas ─────────────────────────────────────────────────────────────────
/** A/B/C: cobro escapado, cobro parcial y cobrado de más. */
async function revisarCobros(hoy) {
  // Nunca se mira más atrás de la fecha de corte, aunque la ventana lo permita.
  const ventana = dias(hoy, -DIAS_ATRAS);
  const desde = ventana > DESDE ? ventana : DESDE;
  const reservas = await paginas('/getReservations', {
    checkOutFrom: desde, checkOutTo: dias(hoy, 1),
  });

  // El `balance` del listado va desfasado a veces: sirve para preseleccionar,
  // pero cada candidata se confirma con getReservation, que es el que manda.
  const candidatas = reservas.filter(r =>
    !['canceled', 'no_show'].includes(r.status) &&
    !cobraLaOta(r.sourceName) &&
    Math.abs(Number(r.balance || 0)) > UMBRAL);

  const escapados = [], parciales = [], dobles = [];
  for (const r of candidatas) {
    const d = await llamar('GET', '/getReservation', { reservationID: r.reservationID });
    if (!d.success) continue;
    const b = d.data.balanceDetailed;
    const total = Number(b.grandTotal), pagado = Number(b.paid || 0);
    const saldo = Math.round((total - pagado) * 100) / 100;
    if (d.data.endDate > hoy) continue;   // aún no ha salido: todavía no es un escape
    if (d.data.endDate < DESDE) continue;  // anterior al vigilante: no es asunto suyo
    const fila = {
      id: r.reservationID, canal: r.sourceName || d.data.source || '?',
      huesped: d.data.guestName, in: d.data.startDate, out: d.data.endDate,
      total, pagado, saldo,
    };
    if (saldo > UMBRAL) (pagado > UMBRAL ? parciales : escapados).push(fila);
    else if (saldo < -UMBRAL) dobles.push(fila);
  }
  return { escapados, parciales, dobles };
}

/** D: un cobro anulado y nunca vuelto a registrar. */
async function revisarAnulaciones(hoy) {
  const tx = await paginas('/getTransactions', {
    resultsFrom: dias(hoy, -DIAS_TX), resultsTo: hoy,
  });
  const METODOS = ['Debit Card', 'Cash', 'Credit Card', 'Paid at another location.',
    'AirBnB Prepaid Card', 'Direct Bill'];
  const porReserva = {};
  for (const t of tx) {
    if (!METODOS.includes(t.category || '')) continue;
    (porReserva[t.reservationID] ||= []).push(t);
  }
  const fuera = [];
  for (const [id, movs] of Object.entries(porReserva)) {
    const anul = movs.filter(t => t.transactionCategory === 'void');
    if (!anul.length) continue;
    const ultima = anul.map(t => t.transactionDateTime).sort().pop();
    const recobro = movs.some(t => t.transactionCategory === 'payment'
      && t.transactionDateTime > ultima);
    if (!recobro) {
      fuera.push({
        id, cuando: ultima.slice(0, 16),
        importe: anul.reduce((s, t) => s + Math.abs(Number(t.amount)), 0),
        huesped: anul[0].guestName || '?',
      });
    }
  }
  return fuera;
}

/** E: bloqueo creado cuando el día de esa noche ya había terminado. */
async function revisarBloqueos(hoy) {
  const vistos = new Set(), fuera = [];
  let d = dias(hoy, -DIAS_BLOQUEOS);
  while (d <= hoy) {
    const fin = dias(d, 30) > hoy ? hoy : dias(d, 30);
    const r = await llamar('GET', '/getRoomBlocks', { startDate: d, endDate: fin, pageSize: 100 });
    const data = r.data;
    const grupos = Array.isArray(data) ? data : (data ? [data] : []);
    for (const g of grupos) {
      for (const b of (g?.roomBlocks || [])) {
        if (vistos.has(b.roomBlockID)) continue;
        vistos.add(b.roomBlockID);
        const creado = new Date(Number(String(b.roomBlockID).slice(0, 13)));
        if (isNaN(creado)) continue;
        const ini = b.startDate, finB = b.endDate;
        const noches = finB <= ini ? [ini] : (() => {
          const out = [];
          for (let x = ini; x < finB; x = dias(x, 1)) out.push(x);
          return out;
        })();
        // Solo cuenta si se creó cuando el DÍA de esa noche ya había acabado:
        // eso ya no impide vender nada, solo reescribe el pasado.
        const pasadas = noches.filter(n => new Date(dias(n, 1) + 'T00:00:00') < creado);
        if (pasadas.length) {
          fuera.push({
            id: b.roomBlockID,
            creado: creado.toISOString().slice(0, 16).replace('T', ' '),
            noches: pasadas.join(', '),
            motivo: (b.roomBlockReason || '(sin motivo)').trim(),
          });
        }
      }
    }
    d = dias(fin, 1);
  }
  return fuera;
}

// ─── mensaje ─────────────────────────────────────────────────────────────────
function construir(hoy, a, pendientes) {
  const L = [];
  const { escapados, parciales, dobles, anulaciones, bloqueos } = a;
  if (escapados.length) {
    L.push(`🔴 SIN COBRAR · ${escapados.length} reserva(s) · ${eur(escapados.reduce((s, x) => s + x.saldo, 0))}`);
    for (const x of [...escapados].sort((p, q) => q.saldo - p.saldo)) {
      L.push(`   ${eur(x.saldo)} · ${x.in}→${x.out} · ${x.canal} · ${x.huesped}`);
      L.push(`      id ${x.id}`);
    }
  }
  if (parciales.length) {
    L.push(`🟠 COBRO PARCIAL · ${parciales.length} · falta ${eur(parciales.reduce((s, x) => s + x.saldo, 0))}`);
    for (const x of parciales) {
      L.push(`   falta ${eur(x.saldo)} de ${eur(x.total)} · ${x.in}→${x.out} · ${x.canal} · ${x.huesped}`);
    }
  }
  if (dobles.length) {
    L.push(`🟣 COBRADO DE MÁS · ${dobles.length} · ${eur(dobles.reduce((s, x) => s - x.saldo, 0))} a favor del huésped`);
    for (const x of dobles) L.push(`   +${eur(-x.saldo)} · ${x.in}→${x.out} · ${x.huesped}`);
  }
  if (anulaciones.length) {
    L.push(`🟡 COBRO ANULADO SIN REHACER · ${anulaciones.length} · ${eur(anulaciones.reduce((s, x) => s + x.importe, 0))}`);
    for (const x of anulaciones) L.push(`   ${eur(x.importe)} · anulado ${x.cuando} · ${x.huesped}`);
  }
  if (bloqueos.length) {
    L.push(`🔵 BLOQUEO SOBRE UNA NOCHE YA PASADA · ${bloqueos.length}`);
    for (const x of bloqueos) L.push(`   creado ${x.creado} tapa ${x.noches} · «${x.motivo}»`);
  }
  if (!L.length) return null;
  if (pendientes.length) {
    const t = pendientes.reduce((s, x) => s + (x.saldo || 0), 0);
    L.push('', `(siguen abiertas ${pendientes.length} ya avisadas${t ? `, ${eur(t)}` : ''})`);
  }
  const [y, m, dd] = hoy.split('-');
  return `KONK · vigilante de cobros — ${dd}/${m}/${y}\n\n${L.join('\n')}`;
}

/** El carril de Cobros del grupo, si existe. null = tema General. */
function carrilCobros() {
  try {
    return require('./encargado').hilo('COBROS');
  } catch {
    return null;
  }
}

// ─── latido al Encargado ─────────────────────────────────────────────────────
/**
 * Avisa al Encargado de que el vigilante ha corrido. Carga perezosa y a prueba
 * de fallos a propósito: un hook de monitorización jamás debe poder tumbar lo
 * que monitoriza, y el módulo del Encargado puede no estar montado.
 */
function latir(ok, resumen, detalle) {
  try {
    require('./encargado/estado').registrarLatido('vigilante-cobros', { ok, resumen, detalle });
  } catch (e) {
    console.warn('[Vigilante] no se pudo registrar el latido:', e.message);
  }
}

// ─── ejecución ───────────────────────────────────────────────────────────────
/** Revisión completada: se da el día por hecho y se olvida cualquier fallo previo. */
function marcarHecha(estado, hoy) {
  const prev = estado.ultimoResultado;
  const intentos = prev && prev.ok === false && prev.fecha === hoy ? prev.intentos + 1 : 1;
  estado.ultimaRevision = hoy;
  estado.ultimoResultado = { ok: true, fecha: hoy, cuando: new Date().toISOString(), intentos };
  guardarEstado(estado);
}

async function ejecutar({ enviar = true, todo = false } = {}) {
  const { fecha: hoy } = ahoraMadrid();
  console.log(`[Vigilante] revisando (${hoy})`);

  const { escapados, parciales, dobles } = await revisarCobros(hoy);
  const anulaciones = await revisarAnulaciones(hoy);
  const bloqueos = await revisarBloqueos(hoy);

  const resumen = {
    escapados: escapados.length, parciales: parciales.length, dobles: dobles.length,
    anulaciones: anulaciones.length, bloqueos: bloqueos.length,
    importePendiente: Math.round(
      [...escapados, ...parciales].reduce((s, x) => s + x.saldo, 0) * 100) / 100,
  };
  console.log('[Vigilante]', JSON.stringify(resumen));

  const estado = cargarEstado();
  const pe = particionar(escapados, x => `cobro:${x.id}`, estado, hoy, todo);
  const pp = particionar(parciales, x => `parcial:${x.id}`, estado, hoy, todo);
  const pd = particionar(dobles, x => `doble:${x.id}`, estado, hoy, todo);
  const pa = particionar(anulaciones, x => `void:${x.id}`, estado, hoy, todo);
  const pb = particionar(bloqueos, x => `blk:${x.id}`, estado, hoy, todo);

  const mensaje = construir(hoy, {
    escapados: pe.nuevos, parciales: pp.nuevos, dobles: pd.nuevos,
    anulaciones: pa.nuevos, bloqueos: pb.nuevos,
  }, [...pe.viejos, ...pp.viejos]);

  if (!mensaje) {
    marcarHecha(estado, hoy);
    latir(true, 'Sin incidencias: todos los cobros cuadran.', resumen);
    return { ...resumen, avisado: false, mensaje: null };
  }
  if (enviar) {
    await sendTelegram(mensaje, { threadId: carrilCobros() });
    marcarHecha(estado, hoy);   // solo se persiste si se envió
  }
  // El vigilante hizo su trabajo: encontrar algo NO es un fallo suyo. Latido en
  // verde con el detalle; de las alarmas ya avisa él por su cuenta.
  const n = resumen.escapados + resumen.parciales + resumen.dobles
    + resumen.anulaciones + resumen.bloqueos;
  latir(true, `${n} incidencia(s)` + (resumen.importePendiente
    ? ` · ${eur(resumen.importePendiente)} pendiente` : ''), resumen);
  return { ...resumen, avisado: enviar, mensaje };
}

// ─── programador: L-S a las 09:00 de Madrid, domingos no ─────────────────────
let enCurso = false;   // un solo intento a la vez, aunque Cloudbeds vaya lento

/**
 * Un tick del programador (cada 5 min). Devuelve qué hizo, para poder testearlo.
 *
 * Primer intento: a la HORA (09:xx). Si falla, NO se da el día por revisado:
 * se apunta el fallo y se reintenta pasados REINTENTO_MIN minutos, hasta
 * INTENTOS_DIA intentos en total y sin pasar de HORA_LIMITE. Solo cuando se
 * agotan (o se acaba la ventana) se avisa por Telegram y el latido va en rojo.
 */
async function tick(ahora = ahoraMadrid(), ms = Date.now()) {
  const { fecha, hora, diaSemana } = ahora;
  if (diaSemana === 0) return 'domingo';              // domingo: no avisa
  if (enCurso) return 'en-curso';
  const est = cargarEstado();
  if (est.ultimaRevision === fecha) return 'hecha';   // ya se hizo hoy

  const prev = est.ultimoResultado && est.ultimoResultado.ok === false
    && est.ultimoResultado.fecha === fecha ? est.ultimoResultado : null;
  if (prev && prev.definitivo) return 'agotado';      // ya se avisó del fallo de hoy
  if (!prev && hora !== HORA) return 'fuera-de-hora';

  let intentos = prev ? prev.intentos : 0;
  if (prev) {
    if (hora >= HORA_LIMITE) {
      // La ventana se cerró con un reintento pendiente: se da por perdido.
      await rendirse(est, fecha, prev);
      return 'agotado';
    }
    if (ms < Date.parse(prev.proximoReintento)) return 'espera';
  }

  enCurso = true;
  try {
    await conTope(ejecutar({ enviar: true }), TOPE_INTENTO_MS);
    return 'hecha';
  } catch (e) {
    intentos++;
    console.error(`[Vigilante] ERROR (intento ${intentos}/${INTENTOS_DIA}):`, e.message);
    const fallo = {
      ok: false, fecha, cuando: new Date(ms).toISOString(), intentos,
      error: e.message, endpoint: e.endpoint || null,
      definitivo: false, proximoReintento: null,
    };
    const est2 = cargarEstado();      // ultimaRevision NO se toca: hoy sigue sin revisar
    if (intentos >= INTENTOS_DIA) {
      await rendirse(est2, fecha, fallo);
      return 'agotado';
    }
    fallo.proximoReintento = new Date(ms + REINTENTO_MIN * 60 * 1000).toISOString();
    est2.ultimoResultado = fallo;
    guardarEstado(est2);
    return 'reintento-programado';
  } finally {
    enCurso = false;
  }
}

/** Rechaza si `promesa` no termina en `ms`. No cancela la original: solo deja de esperarla. */
function conTope(promesa, ms) {
  let timer;
  const tope = new Promise((_, rechazar) => {
    timer = setTimeout(() => {
      const err = new Error(`la revisión no terminó en ${Math.round(ms / 1000)} s (llamada colgada)`);
      err.code = 'TOPE_INTENTO';
      rechazar(err);
    }, ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(timer));
}

/** Fallo definitivo: se guarda, se avisa una sola vez y el latido va en rojo. */
async function rendirse(estado, fecha, fallo) {
  estado.ultimoResultado = { ...fallo, definitivo: true, proximoReintento: null };
  guardarEstado(estado);
  latir(false, 'La revisión falló: ' + fallo.error, null);
  let enviado = false;
  try {
    enviado = !!await sendTelegram('KONK · vigilante de cobros\n\n⚠️ La revisión de hoy falló tras '
      + fallo.intentos + ' intento(s).\n'
      + 'Llamada: ' + (fallo.endpoint || 'desconocida') + '\n'
      + 'Error: ' + fallo.error + '\n'
      + 'Los cobros NO se han comprobado.', { threadId: carrilCobros() });
  } catch (e) {
    console.error('[Vigilante] no se pudo avisar del fallo:', e.message);
  }
  // telegram.send devuelve null si no pudo enviar: que quede constancia, no silencio.
  if (!enviado) console.error('[Vigilante] AVISO DE FALLO NO ENVIADO a Telegram');
  estado.ultimoResultado.avisoEnviado = enviado;
  guardarEstado(estado);
}

function arrancar() {
  setInterval(() => tick().catch(e => console.error('[Vigilante] tick:', e.message)),
    5 * 60 * 1000);   // cada 5 min; solo actúa en su franja
  setTimeout(() => tick().catch(e => console.error('[Vigilante] tick:', e.message)), 60 * 1000);
  console.log(`[Vigilante] programado L-S a las ${HORA}:00 (${TZ}), `
    + `hasta ${INTENTOS_DIA} intentos al día cada ${REINTENTO_MIN} min`);
}

/** Diagnóstico para /health: dice si el estado sobrevive a un redeploy. */
function info() {
  let persistente = false, motivo = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, '.probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    persistente = true;
  } catch (e) {
    motivo = e.code || e.message;
  }
  const est = cargarEstado();
  return {
    activo: process.env.VIGILANTE_OFF !== '1',
    horario: `L-S ${HORA}:00 ${TZ}`,
    desde: DESDE,
    ota: OTA,
    dataDir: DATA_DIR,
    estado: persistente ? 'persistente' : 'solo memoria',
    ...(motivo ? { motivoNoPersistente: motivo } : {}),
    // Solo se rellena cuando la revisión TERMINÓ bien: un fallo no la mueve.
    ultimaRevision: est.ultimaRevision || null,
    // Resultado del último intento: { ok, fecha, cuando, intentos, error?,
    // endpoint?, definitivo?, proximoReintento? }. ok=false = hoy NO se revisó.
    ultimoResultado: est.ultimoResultado || null,
    alarmasRecordadas: Object.keys(est.conocidos || {}).length,
  };
}

module.exports = { arrancar, ejecutar, info, tick };
