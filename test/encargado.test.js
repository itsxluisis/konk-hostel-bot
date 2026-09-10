// test/encargado.test.js — lógica del Encargado del Konk (sin red ni disco)
'use strict';

const assert = require('assert');
const { debeAlertar } = require('../src/encargado/vigilancia');
const { AGENTES } = require('../src/encargado/config');

const vigilante = AGENTES['vigilante-cobros'];   // L-S 09:00, margen 120 → límite 11:00
const facturador = AGENTES['facturador-konk'];   // lunes 09:00

const jueves = { iso: '2026-09-10', minutos: 16 * 60, dia: 4 };
const arranqueViejo = { iso: '2026-09-01', minutos: 8 * 60 };

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nEncargado · ¿cuándo hay que dar la alarma?\n');

t('alerta si venció el plazo y no ha latido', () => {
  const r = debeAlertar(vigilante, jueves, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('calla si ya latió hoy', () => {
  const latido = { ts: '2026-09-10T09:05:00.000Z' };
  const r = debeAlertar(vigilante, jueves, arranqueViejo, latido);
  assert.strictEqual(r.alerta, false);
});

t('un latido de AYER no vale para hoy', () => {
  const latido = { ts: '2026-09-09T09:05:00.000Z' };
  const r = debeAlertar(vigilante, jueves, arranqueViejo, latido);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('calla dentro de plazo (10:00, límite 11:00)', () => {
  const temprano = { ...jueves, minutos: 10 * 60 };
  const r = debeAlertar(vigilante, temprano, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('alerta justo al vencer el plazo (11:00)', () => {
  const justo = { ...jueves, minutos: 11 * 60 };
  const r = debeAlertar(vigilante, justo, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('el facturador no se espera en jueves', () => {
  const r = debeAlertar(facturador, jueves, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('el facturador SÍ se espera el lunes', () => {
  const lunes = { iso: '2026-09-14', minutos: 16 * 60, dia: 1 };
  const r = debeAlertar(facturador, lunes, arranqueViejo, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});

t('el vigilante NO se espera en domingo', () => {
  const domingo = { iso: '2026-09-13', minutos: 16 * 60, dia: 0 };
  const r = debeAlertar(vigilante, domingo, arranqueViejo, null);
  assert.strictEqual(r.alerta, false);
});

t('sin falso positivo si arrancamos tarde el mismo día', () => {
  const arranqueTarde = { iso: '2026-09-10', minutos: 15 * 60 };
  const r = debeAlertar(vigilante, jueves, arranqueTarde, null);
  assert.strictEqual(r.alerta, false, 'no debe alarmar: no vio la ventana');
});

t('sí alerta si arrancamos ANTES del plazo el mismo día', () => {
  const arranquePronto = { iso: '2026-09-10', minutos: 7 * 60 };
  const r = debeAlertar(vigilante, jueves, arranquePronto, null);
  assert.strictEqual(r.alerta, true, r.motivo);
});


// ─────────── El parte diario ───────────
const { estadoFijado, parteDiario, nombres, plural } = require('../src/encargado/parte');

const cuando = new Date('2026-09-10T07:15:00Z');
const vacio = { fecha: '2026-09-10', llegadas: [], salidas: [], enCasa: [],
                huespedes: 0, agentes: [], fallos: [] };
const lleno = {
  fecha: '2026-09-10',
  llegadas: [
    { huesped: 'Cristina Pilar Fernandez', personas: 2, salida: '2026-09-11', origen: 'Booking' },
    { huesped: 'Cristian Viadero', personas: 1, salida: '2026-09-14', origen: '' },
  ],
  salidas: [{ huesped: 'Manuel Cuesta', personas: 1, salida: '2026-09-10', origen: '' }],
  enCasa: [], huespedes: 14,
  agentes: [
    { id: 'facturador-konk', nombre: 'Facturador Konk', seEsperaHoy: false, latioHoy: false, ok: null, resumen: null },
    { id: 'vigilante-cobros', nombre: 'Vigilante de cobros', seEsperaHoy: true, latioHoy: true, ok: true, resumen: 'todo cuadra' },
  ],
  fallos: [],
};

console.log('\nEncargado · el parte diario\n');

t('plural: singular y plural', () => {
  assert.strictEqual(plural(1, 'huésped', 'huéspedes'), '1 huésped');
  assert.strictEqual(plural(3, 'huésped', 'huéspedes'), '3 huéspedes');
});

t('nombres: recorta a partir del tope', () => {
  const lista = 'ABCDEF'.split('').map(x => ({ huesped: `${x} Apellido` }));
  assert.ok(nombres(lista, 4).endsWith('y 2 más'), nombres(lista, 4));
});

t('hostel vacío: lo dice con todas las letras', () => {
  assert.ok(parteDiario(vacio, cuando).includes('vacío'));
});

t('parte con movimiento: nombres, personas y origen', () => {
  const txt = parteDiario(lleno, cuando);
  assert.ok(txt.includes('14 personas'), 'faltan los huéspedes');
  assert.ok(txt.includes('Cristina Pilar Fernandez'), 'falta el nombre');
  assert.ok(txt.includes('(Booking)'), 'falta el origen');
  assert.ok(txt.includes('Manuel'), 'faltan las salidas');
});

t('el fijado es corto y lleva el semáforo del equipo', () => {
  const txt = estadoFijado(lleno, cuando);
  assert.ok(txt.split('\n').length <= 10, 'el fijado se ha alargado demasiado');
  assert.ok(txt.includes('🤖'), 'falta el semáforo');
  assert.ok(txt.includes('Vigilante de cobros ✅'), 'el vigilante debería salir en verde');
  assert.ok(txt.includes('Facturador Konk —'), 'hoy no se le espera: guion');
});

t('un agente que no ha corrido sale como pendiente', () => {
  const foto = { ...lleno, agentes: [
    { nombre: 'Vigilante de cobros', seEsperaHoy: true, latioHoy: false, ok: null, resumen: null }] };
  assert.ok(estadoFijado(foto, cuando).includes('⏳'));
  assert.ok(parteDiario(foto, cuando).includes('Aún sin correr hoy'));
});

t('un agente en error se ve en el parte', () => {
  const foto = { ...lleno, agentes: [
    { nombre: 'Vigilante de cobros', seEsperaHoy: true, latioHoy: true, ok: false, resumen: 'la revisión falló' }] };
  assert.ok(parteDiario(foto, cuando).includes('la revisión falló'));
});

t('si Cloudbeds falla, el parte lo confiesa en vez de mentir', () => {
  const foto = { ...vacio, fallos: ['No se pudieron leer las llegadas: timeout'] };
  const txt = parteDiario(foto, cuando);
  assert.ok(txt.includes('No he podido consultarlo todo'), txt);
  assert.ok(txt.includes('timeout'));
});

t('cero por no poder mirar NO se cuenta como hostel vacío', () => {
  const foto = { ...vacio, fallos: ['No se pudo calcular la ocupación: timeout'] };
  const txt = parteDiario(foto, cuando);
  assert.ok(!txt.includes('está vacío'), 'no debe afirmar que está vacío');
  assert.ok(txt.includes('no puedo darte el estado'), txt);
});

t('el fijado tampoco da cifras falsas si faltan datos', () => {
  const foto = { ...lleno, fallos: ['timeout'] };
  const txt = estadoFijado(foto, cuando);
  assert.ok(txt.includes('Datos incompletos'), txt);
  assert.ok(!txt.includes('14 huéspedes'), 'no debe dar una cifra que no puede confirmar');
});

t('el parte avisa si el vigilante de cobros está apagado', () => {
  const foto = { ...lleno, cobros: { activo: false, ultimaRevision: null } };
  assert.ok(parteDiario(foto, cuando).includes('apagado'));
});

t('el parte avisa si la última revisión de cobros no es de hoy', () => {
  const foto = { ...lleno, cobros: { activo: true, ultimaRevision: '2026-09-08' } };
  assert.ok(parteDiario(foto, cuando).includes('2026-09-08'));
});

t('si los cobros están al día, el parte no los menciona', () => {
  const foto = { ...lleno, cobros: { activo: true, ultimaRevision: '2026-09-10' } };
  assert.ok(!parteDiario(foto, cuando).includes('Cobros:'));
});

console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
process.exit(fallan ? 1 : 0);
