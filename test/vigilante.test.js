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
];
const DETALLES = {
  R1: { grandTotal: 120, paid: 0,   endDate: ayer(3), startDate: ayer(5), guestName: 'Ana Directa' },
  R6: { grandTotal: 100, paid: 60,  endDate: ayer(2), startDate: ayer(4), guestName: 'Paco Parcial' },
  R7: { grandTotal: 100, paid: 115, endDate: ayer(1), startDate: ayer(2), guestName: 'Doble Cobro' },
  R8: { grandTotal: 200, paid: 0,   endDate: '2099-01-01', startDate: '2098-12-30', guestName: 'Futuro' },
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
const fakeCloudbeds = {
  api: async (method, ruta, params = {}) => {
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

// --- inyectar los dobles ------------------------------------------------------
const real = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './cloudbeds') return fakeCloudbeds;
  if (id === './telegram') return fakeTelegram;
  return real.apply(this, arguments);
};
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'vig-test-' + Date.now());
const vig = real.call(module, path.join(__dirname, '../src/vigilante.js'));
Module.prototype.require = real;

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
  assert.ok(m.includes('Anulado Sinrehacer'), 'si avisa de la anulacion sin rehacer');
  assert.strictEqual(r.importePendiente, 160, 'pendiente = 120 (R1) + 40 (R6)');

  // segunda pasada: sin --todo no debe repetir lo ya avisado
  enviados = [];
  const r2 = await vig.ejecutar({ enviar: true });
  assert.strictEqual(enviados.length, 0, 'no repite las mismas alarmas al dia siguiente');

  console.log('  ✓ excluye Booking, Airbnb y Expedia');
  console.log('  ✓ detecta escapado, parcial y cobrado de mas');
  console.log('  ✓ ignora estancias que aun no han salido');
  console.log('  ✓ anulacion sin rehacer si, recobrada no');
  console.log('  ✓ bloqueo retroactivo si, del mismo dia no');
  console.log('  ✓ no repite alarmas ya avisadas');
  console.log('\nTODOS LOS TESTS PASAN');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
