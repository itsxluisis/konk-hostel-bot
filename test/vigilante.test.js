// Test del vigilante con la API de Cloudbeds simulada.
// No toca la red ni el refresh token de produccion.
'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- datos simulados ---------------------------------------------------------
const HOY = new Date().toISOString().slice(0, 10);
const ayer = n => { const d = new Date(HOY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0,10); };

const RESERVAS = [
  // sin cobrar, canal directo, ya salio -> ALARMA
  { reservationID: 'R1', status: 'confirmed', sourceName: 'Website/Booking Engine', balance: 120 },
  // Booking con saldo: NUNCA debe avisar
  { reservationID: 'R2', status: 'confirmed', sourceName: 'Booking.com', balance: 300 },
  // Airbnb con saldo: NUNCA debe avisar
  { reservationID: 'R3', status: 'confirmed', sourceName: 'Airbnb (API)', balance: 90 },
  // Expedia con saldo: NUNCA debe avisar (cobra Expedia)
  { reservationID: 'R4', status: 'confirmed', sourceName: 'Expedia', balance: 60 },
  // cancelada: se ignora
  { reservationID: 'R5', status: 'canceled', sourceName: 'Website/Booking Engine', balance: 80 },
  // cobro parcial -> ALARMA naranja
  { reservationID: 'R6', status: 'confirmed', sourceName: 'Phone', balance: 40 },
  // cobrado de mas -> ALARMA morada
  { reservationID: 'R7', status: 'confirmed', sourceName: 'Website/Booking Engine', balance: -15 },
  // saldo abierto pero AUN NO HA SALIDO: no es un escape todavia
  { reservationID: 'R8', status: 'confirmed', sourceName: 'Website/Booking Engine', balance: 200 },
  // salio ANTES de que existiera el vigilante: pasivo viejo, no debe avisar
  { reservationID: 'R11', status: 'confirmed', sourceName: 'Website/Booking Engine', balance: 500 },
];
const DETALLES = {
  R1: { grandTotal: 120, paid: 0,   endDate: ayer(3), startDate: ayer(5), guestName: 'Ana Directa' },
  R6: { grandTotal: 100, paid: 60,  endDate: ayer(2), startDate: ayer(4), guestName: 'Paco Parcial' },
  R7: { grandTotal: 100, paid: 115, endDate: ayer(1), startDate: ayer(2), guestName: 'Doble Cobro' },
  R8: { grandTotal: 200, paid: 0,   endDate: '2099-01-01', startDate: '2098-12-30', guestName: 'Futuro' },
  R11:{ grandTotal: 500, paid: 0,   endDate: ayer(60),      startDate: ayer(62),      guestName: 'Pasivo Viejo' },
};
// bloqueo creado 3 dias DESPUES de la noche -> retroactivo
const idRetro = String(new Date(ayer(2) + 'T10:00:00Z').getTime()) + '000';
// bloqueo creado esa misma tarde -> operativa normal, NO debe avisar
const idMismoDia = String(new Date(ayer(5) + 'T21:00:00Z').getTime()) + '000';

const TX = [
  // cobro anulado y nunca rehecho -> ALARMA amarilla
  { reservationID: 'R9', category: 'Debit Card', transactionCategory: 'void',
    transactionDateTime: ayer(1) + ' 12:00:00', amount: -75, guestName: 'Anulado Sinrehacer' },
  // anulado pero recobrado despues -> NO debe avisar
  { reservationID: 'R10', category: 'Cash', transactionCategory: 'void',
    transactionDateTime: ayer(1) + ' 12:00:00', amount: -50, guestName: 'Rehecho' },
  { reservationID: 'R10', category: 'Cash', transactionCategory: 'payment',
    transactionDateTime: ayer(1) + ' 12:30:00', amount: 50, guestName: 'Rehecho' },
];

let enviados = [];
let latidos = [];
let romperEncargado = false;
const fakeEstado = {
  registrarLatido: (agente, datos) => {
    if (romperEncargado) throw new Error('encargado caido');
    latidos.push({ agente, ...datos });
  },
};
// Gancho por escenario: si devuelve algo distinto de undefined, sustituye a la
// respuesta normal; si lanza, simula el fallo de Cloudbeds.
let apiHook = null;
let llamadas = [];   // { ruta, opts } de cada llamada del vigilante a api()
const fakeCloudbeds = {
  api: async (method, ruta, params = {}, opts = {}) => {
    llamadas.push({ ruta, opts });
    if (apiHook) {
      const forzada = await apiHook(ruta, params, opts);
      if (forzada !== undefined) return forzada;
    }
    if (ruta === '/getReservations') {
      return { success: true, data: params.pageNumber === 1 ? RESERVAS : [] };
    }
    if (ruta === '/getReservation') {
      const d = DETALLES[params.reservationID];
      if (!d) return { success: false };
      return { success: true, data: {
        status: 'confirmed', startDate: d.startDate, endDate: d.endDate,
        guestName: d.guestName, source: 'x',
        balanceDetailed: { grandTotal: d.grandTotal, paid: d.paid },
      } };
    }
    if (ruta === '/getTransactions') {
      return { success: true, data: params.pageNumber === 1 ? TX : [] };
    }
    if (ruta === '/getRoomBlocks') {
      return { success: true, data: [{ roomBlocks: [
        { roomBlockID: idRetro,    startDate: ayer(5), endDate: ayer(4), roomBlockReason: 'sucia' },
        { roomBlockID: idMismoDia, startDate: ayer(5), endDate: ayer(4), roomBlockReason: 'Moho' },
      ] }] };
    }
    return { success: false };
  },
};
const fakeTelegram = { send: async t => { enviados.push(t); } };

// Doble de axios para cargar el cloudbeds.js REAL (test de que el bot de voz
// conserva sus 6 s). Registra la config de cada request; nunca toca la red.
let configsAxios = [];
const fakeAxios = async config => { configsAxios.push(config); return { data: { success: true, data: [] } }; };
fakeAxios.post = async () => ({ data: { access_token: 'tok-test', refresh_token: 'ref-test', expires_in: 3600 } });

// --- inyectar los dobles ------------------------------------------------------
const real = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './cloudbeds') return fakeCloudbeds;
  if (id === './telegram') return fakeTelegram;
  if (id === 'axios') return fakeAxios;
  if (id === './encargado/estado') return fakeEstado;
  return real.apply(this, arguments);
};
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'vig-test-' + Date.now());
process.env.VIGILANTE_DESDE = ayer(30);   // R11 salió antes del corte
process.env.VIGILANTE_BACKOFF_MS = '1';   // los reintentos del test no esperan segundos
const vig = real.call(module, path.join(__dirname, '../src/vigilante.js'));
// La intercepcion se queda puesta: vigilante.js carga './encargado/estado' de
// forma perezosa, ya dentro de ejecutar(), no al importarse.

// --- comprobaciones -----------------------------------------------------------
(async () => {
  const r = await vig.ejecutar({ enviar: true, todo: true });

  assert.strictEqual(r.escapados, 1, 'debe haber 1 cobro escapado (solo R1)');
  assert.strictEqual(r.parciales, 1, 'debe haber 1 cobro parcial (R6)');
  assert.strictEqual(r.dobles, 1, 'debe haber 1 cobrado de mas (R7)');
  assert.strictEqual(r.anulaciones, 1, 'solo R9: R10 se recobro');
  assert.strictEqual(r.bloqueos, 1, 'solo el retroactivo, no el de esa misma tarde');

  const m = enviados[0];
  assert.ok(m.includes('Ana Directa'), 'el mensaje nombra al huesped sin cobrar');
  assert.ok(!m.includes('Booking.com'), 'NUNCA debe avisar de Booking');
  assert.ok(!m.includes('Airbnb'), 'NUNCA debe avisar de Airbnb');
  assert.ok(!m.includes('Expedia'), 'NUNCA debe avisar de Expedia');
  assert.ok(!m.includes('Futuro'), 'no avisa de estancias que aun no han salido');
  assert.ok(!m.includes('Rehecho'), 'no avisa de anulaciones ya recobradas');
  assert.ok(!m.includes('Moho'), 'no avisa de bloqueos hechos esa misma tarde');
  assert.ok(!m.includes('Pasivo Viejo'), 'no avisa de reservas anteriores a la fecha de corte');
  assert.ok(m.includes('Anulado Sinrehacer'), 'si avisa de la anulacion sin rehacer');
  assert.strictEqual(r.importePendiente, 160, 'pendiente = 120 (R1) + 40 (R6)');

  // el latido llega al Encargado, y en verde: encontrar algo no es un fallo suyo
  assert.strictEqual(latidos.length, 1, 'manda exactamente un latido por revision');
  assert.strictEqual(latidos[0].agente, 'vigilante-cobros', 'se identifica bien');
  assert.strictEqual(latidos[0].ok, true, 'hallar incidencias NO es un fallo del vigilante');
  assert.ok(latidos[0].resumen.includes('incidencia'), 'el resumen dice lo que encontro');

  // segunda pasada: sin --todo no debe repetir lo ya avisado
  enviados = [];
  const r2 = await vig.ejecutar({ enviar: true });
  assert.strictEqual(enviados.length, 0, 'no repite las mismas alarmas al dia siguiente');

  // si el Encargado esta caido, la revision debe seguir funcionando igual
  romperEncargado = true;
  latidos = [];
  const r3 = await vig.ejecutar({ enviar: true, todo: true });
  assert.strictEqual(r3.escapados, 1, 'un Encargado caido no rompe la revision');
  assert.strictEqual(latidos.length, 0, 'y el latido simplemente se pierde');
  romperEncargado = false;

  // ─── fallos de Cloudbeds: reintentos, día sin marcar, aviso al agotar ──────
  const fs = require('fs');
  const estadoPath = path.join(process.env.DATA_DIR, 'vigilante-estado.json');
  const reset = () => {
    fs.writeFileSync(estadoPath, JSON.stringify({ conocidos: {} }));
    enviados = []; latidos = []; llamadas = []; apiHook = null;
  };
  const estadoDisco = () => JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
  const fechaMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const ahoraT = hora => ({ fecha: fechaMadrid, hora, diaSemana: 2 });   // un martes
  const T0 = Date.now();
  const MIN = 60 * 1000;
  const errTimeout = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
  const errHttp = st => Object.assign(new Error('Request failed with status code ' + st), { response: { status: st } });
  const getReservations = () => llamadas.filter(c => c.ruta === '/getReservations').length;

  // 1. el vigilante usa su propio timeout (30 s), no los 6 s del bot de voz
  reset();
  await vig.tick(ahoraT(9), T0);
  assert.ok(llamadas.length > 0, 'el vigilante llama a Cloudbeds');
  assert.ok(llamadas.every(c => c.opts.timeout === 30000), 'todas sus llamadas llevan timeout 30000');

  // 2. un timeout que luego va bien: se reintenta la llamada y el dia queda hecho
  reset();
  let primera = true;
  apiHook = async ruta => {
    if (ruta === '/getReservations' && primera) { primera = false; throw errTimeout(); }
  };
  assert.strictEqual(await vig.tick(ahoraT(9), T0), 'hecha');
  assert.strictEqual(getReservations(), 2, 'una llamada fallida + un reintento que va bien');
  assert.strictEqual(estadoDisco().ultimaRevision, fechaMadrid, 'tras el reintento exitoso el dia queda revisado');
  assert.strictEqual(estadoDisco().ultimoResultado.ok, true);
  assert.ok(!enviados.some(t => t.includes('falló')), 'no hay aviso de fallo si el reintento funcionó');

  // 3. 429 y 5xx tambien se reintentan; ECONNRESET igual
  for (const fallo of [errHttp(429), errHttp(503), Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })]) {
    reset();
    let una = true;
    apiHook = async ruta => { if (ruta === '/getReservations' && una) { una = false; throw fallo; } };
    assert.strictEqual(await vig.tick(ahoraT(9), T0), 'hecha');
    assert.strictEqual(getReservations(), 2, 'se reintenta ante ' + (fallo.code || fallo.response.status));
  }

  // 4. 401 / 403 / 400: sin reintento de la llamada
  for (const st of [401, 403, 400]) {
    reset();
    apiHook = async ruta => { if (ruta === '/getReservations') throw errHttp(st); };
    await vig.tick(ahoraT(9), T0);
    assert.strictEqual(getReservations(), 1, `un ${st} NO se reintenta`);
    assert.strictEqual(estadoDisco().ultimaRevision || null, null, `tras un ${st} el dia no se da por revisado`);
    assert.strictEqual(estadoDisco().ultimoResultado.endpoint, 'GET /getReservations');
    reset();
  }

  // 5. fallo total: no marca ultimaRevision, deja reintento a los 20 min, avisa solo al agotar
  reset();
  apiHook = async ruta => { if (ruta === '/getReservations') throw errTimeout(); };
  assert.strictEqual(await vig.tick(ahoraT(9), T0), 'reintento-programado');
  assert.strictEqual(getReservations(), 3, 'la llamada se intenta 1 + 2 reintentos antes de rendirse');
  let est = estadoDisco();
  assert.strictEqual(est.ultimaRevision || null, null, 'el fallo NO marca ultimaRevision');
  assert.strictEqual(est.ultimoResultado.ok, false);
  assert.strictEqual(est.ultimoResultado.intentos, 1);
  assert.strictEqual(Date.parse(est.ultimoResultado.proximoReintento), T0 + 20 * MIN, 'reintento a los 20 min');
  assert.strictEqual(enviados.length, 0, 'sin aviso a Telegram mientras queden reintentos');
  assert.strictEqual(latidos.length, 0, 'ni latido en rojo todavia');
  assert.strictEqual(vig.info().ultimaRevision || null, null, '/health no dice que se reviso');
  assert.strictEqual(vig.info().ultimoResultado.ok, false, '/health expone el fallo');
  assert.ok('ultimaRevision' in vig.info() && 'horario' in vig.info(), '/health conserva su formato');

  llamadas = [];
  assert.strictEqual(await vig.tick(ahoraT(9), T0 + 5 * MIN), 'espera', 'antes de los 20 min no reintenta');
  assert.strictEqual(llamadas.length, 0, 'y no llama a Cloudbeds');

  assert.strictEqual(await vig.tick(ahoraT(9), T0 + 20 * MIN), 'reintento-programado');
  assert.strictEqual(estadoDisco().ultimoResultado.intentos, 2);
  assert.strictEqual(enviados.length, 0);

  assert.strictEqual(await vig.tick(ahoraT(10), T0 + 40 * MIN), 'agotado', 'tercer fallo = definitivo');
  est = estadoDisco();
  assert.strictEqual(est.ultimaRevision || null, null, 'agotados los reintentos, hoy sigue sin revisar');
  assert.strictEqual(est.ultimoResultado.definitivo, true);
  assert.strictEqual(enviados.length, 1, 'un solo aviso de fallo, al agotar');
  assert.ok(enviados[0].includes('GET /getReservations'), 'el aviso dice que llamada fallo');
  assert.ok(enviados[0].includes('timeout of 30000ms exceeded'), 'y el error');
  assert.ok(enviados[0].includes('NO se han comprobado'));
  assert.strictEqual(latidos.length, 1, 'un latido, en rojo');
  assert.strictEqual(latidos[0].ok, false);

  assert.strictEqual(await vig.tick(ahoraT(10), T0 + 60 * MIN), 'agotado', 'no sigue intentando ni avisando');
  assert.strictEqual(enviados.length, 1, 'sin avisos duplicados');
  assert.strictEqual(await vig.tick(ahoraT(9), T0 + 80 * MIN), 'agotado');

  // 6. fallo y reintento que va bien: un solo aviso (el de las alarmas), latido en verde
  reset();
  let rota = true;
  apiHook = async ruta => { if (ruta === '/getReservations' && rota) throw errTimeout(); };
  assert.strictEqual(await vig.tick(ahoraT(9), T0), 'reintento-programado');
  rota = false;
  assert.strictEqual(await vig.tick(ahoraT(9), T0 + 20 * MIN), 'hecha');
  est = estadoDisco();
  assert.strictEqual(est.ultimaRevision, fechaMadrid, 'el reintento que funciona marca el dia');
  assert.strictEqual(est.ultimoResultado.ok, true);
  assert.strictEqual(est.ultimoResultado.intentos, 2);
  assert.strictEqual(enviados.length, 1, 'el aviso de cobros sale una sola vez');
  assert.ok(!enviados[0].includes('falló'), 'y no es un aviso de fallo');
  assert.deepStrictEqual(latidos.map(l => l.ok), [true]);
  assert.strictEqual(await vig.tick(ahoraT(9), T0 + 40 * MIN), 'hecha', 'revisado: no se vuelve a ejecutar');

  // 7. se cierra la ventana con un reintento pendiente: se da por perdido y se avisa
  reset();
  apiHook = async ruta => { if (ruta === '/getReservations') throw errTimeout(); };
  await vig.tick(ahoraT(9), T0);
  assert.strictEqual(await vig.tick(ahoraT(12), T0 + 20 * MIN), 'agotado');
  assert.strictEqual(enviados.length, 1);
  assert.strictEqual(latidos[0].ok, false);

  // 8. fuera de hora y domingo: no arranca
  reset();
  assert.strictEqual(await vig.tick(ahoraT(15), T0), 'fuera-de-hora');
  assert.strictEqual(await vig.tick({ fecha: fechaMadrid, hora: 9, diaSemana: 0 }, T0), 'domingo');
  assert.strictEqual(llamadas.length, 0);

  // 9. el bot de voz conserva sus 6 s: api() sin opts sigue en 6000
  const cb = real.call(module, path.join(__dirname, '../src/cloudbeds.js'));
  await cb.exchangeCode('codigo-de-prueba');
  configsAxios = [];
  await cb.api('GET', '/getRooms');
  assert.strictEqual(configsAxios[0].timeout, 6000, 'api() por defecto: 6000 ms');
  await cb.getAvailability('2099-01-01', '2099-01-02', 1);
  assert.ok(configsAxios.length >= 3);
  assert.ok(configsAxios.slice(1).every(c => c.timeout === 6000), 'getAvailability (bot de voz): 6000 ms');
  await cb.api('GET', '/getRooms', {}, { timeout: 30000 });
  assert.strictEqual(configsAxios[configsAxios.length - 1].timeout, 30000, 'timeout por llamada solo si se pide');

  console.log('  ✓ el vigilante usa timeout propio de 30 s');
  console.log('  ✓ reintenta ante timeout, 429, 5xx y ECONNRESET; el reintento exitoso marca el dia');
  console.log('  ✓ 400/401/403 no se reintentan');
  console.log('  ✓ fallo total: no marca ultimaRevision, reintento a los 20 min, un solo aviso al agotar');
  console.log('  ✓ /health no hace creer que se reviso tras un fallo');
  console.log('  ✓ ventana cerrada con reintento pendiente = fallo definitivo; domingo y fuera de hora no corren');
  console.log('  ✓ el bot de voz conserva su timeout de 6 s');

  console.log('  ✓ excluye Booking, Airbnb y Expedia');
  console.log('  ✓ detecta escapado, parcial y cobrado de mas');
  console.log('  ✓ ignora estancias que aun no han salido');
  console.log('  ✓ anulacion sin rehacer si, recobrada no');
  console.log('  ✓ bloqueo retroactivo si, del mismo dia no');
  console.log('  ✓ ignora el pasivo anterior a la fecha de corte');
  console.log('  ✓ no repite alarmas ya avisadas');
  console.log('  ✓ manda latido al Encargado, en verde aunque halle incidencias');
  console.log('  ✓ si el Encargado falla, la revision sigue funcionando');
  console.log('\nTODOS LOS TESTS PASAN');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
