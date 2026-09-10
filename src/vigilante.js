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
const DIAS_TX = Number(process.env.VIGILANTE_DIAS_TX || 10);
const DIAS_BLOQUEOS = Number(process.env.VIGILANTE_DIAS_BLOQUEOS || 30);
const UMBRAL = Number(process.env.VIGILANTE_UMBRAL || 0.5);
const RECORDAR_CADA = Number(process.env.VIGILANTE_RECORDAR_DIAS || 7);
const HORA = Number(process.env.VIGILANTE_HORA || 9);
const TZ = 'Europe/Madrid';

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

async function paginas(endpoint, params = {}, size = 100) {
  const out = [];
  for (let page = 1; page <= 300; page++) {
    const r = await api('GET', endpoint, { ...params, pageNumber: page, pageSize: size });
    if (!r.success) throw new Error(`${endpoint}: ${JSON.stringify(r).slice(0, 200)}`);
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
  const reservas = await paginas('/getReservations', {
    checkOutFrom: dias(hoy, -DIAS_ATRAS), checkOutTo: dias(hoy, 1),
  });

  // El `balance` del listado va desfasado a veces: sirve para preseleccionar,
  // pero cada candidata se confirma con getReservation, que es el que manda.
  const candidatas = reservas.filter(r =>
    !['canceled', 'no_show'].includes(r.status) &&
    !cobraLaOta(r.sourceName) &&
    Math.abs(Number(r.balance || 0)) > UMBRAL);

  const escapados = [], parciales = [], dobles = [];
  for (const r of candidatas) {
    const d = await api('GET', '/getReservation', { reservationID: r.reservationID });
    if (!d.success) continue;
    const b = d.data.balanceDetailed;
    const total = Number(b.grandTotal), pagado = Number(b.paid || 0);
    const saldo = Math.round((total - pagado) * 100) / 100;
    if (d.data.endDate > hoy) continue;   // aún no ha salido: todavía no es un escape
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
    const r = await api('GET', '/getRoomBlocks', { startDate: d, endDate: fin, pageSize: 100 });
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

// ─── ejecución ───────────────────────────────────────────────────────────────
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
    estado.ultimaRevision = hoy;
    guardarEstado(estado);
    return { ...resumen, avisado: false, mensaje: null };
  }
  if (enviar) {
    await sendTelegram(mensaje);
    estado.ultimaRevision = hoy;
    guardarEstado(estado);   // solo se persiste si se envió
  }
  return { ...resumen, avisado: enviar, mensaje };
}

// ─── programador: L-S a las 09:00 de Madrid, domingos no ─────────────────────
function arrancar() {
  const tick = async () => {
    const { fecha, hora, diaSemana } = ahoraMadrid();
    if (diaSemana === 0) return;                       // domingo: no avisa
    if (hora !== HORA) return;
    if (cargarEstado().ultimaRevision === fecha) return;  // ya se hizo hoy
    try {
      await ejecutar({ enviar: true });
    } catch (e) {
      console.error('[Vigilante] ERROR:', e.message);
      await sendTelegram('KONK · vigilante de cobros\n\n⚠️ La revisión de hoy falló: '
        + e.message + '\nLos cobros NO se han comprobado.');
      const est = cargarEstado();
      est.ultimaRevision = fecha;   // no reintentar en bucle durante la hora
      guardarEstado(est);
    }
  };
  setInterval(tick, 5 * 60 * 1000);   // cada 5 min; solo actúa en su franja
  setTimeout(tick, 60 * 1000);
  console.log(`[Vigilante] programado L-S a las ${HORA}:00 (${TZ})`);
}

module.exports = { arrancar, ejecutar };
