// test/stay-dates.test.js — V1.2: normalización de fechas de estancia antes
// de consultar disponibilidad. Diseño 24-sep-2026: CUALQUIER checkin pasado
// se rechaza (no se corrige solo — ver src/stay-dates.js), con una pista
// `nextOccurrence` para que el modelo recalcule. Función pura, sin red —
// mismo arnés (t/pasan/fallan) que test/cloudbeds-errors.test.js.
'use strict';

const assert = require('assert');
const { normalizeStayDates, spokenDate, buildForwardCalendar } = require('../src/stay-dates');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try {
    fn();
    pasan++;
    console.log(`  ✓ ${nombre}`);
  } catch (e) {
    fallan++;
    console.log(`  ✗ ${nombre}\n     ${e.message}`);
  }
}

console.log('\nstay-dates · normalizeStayDates / spokenDate / buildForwardCalendar\n');

t('checkin futuro: válido, sin tocar', () => {
  const r = normalizeStayDates('2026-10-24', '2026-10-26', '2026-09-24');
  assert.deepStrictEqual(r, { ok: true, checkin: '2026-10-24', checkout: '2026-10-26' });
});

t('checkin === hoy: válido (hoy es válido; el corte de 22:30 va aparte)', () => {
  const r = normalizeStayDates('2026-09-24', '2026-09-26', '2026-09-24');
  assert.deepStrictEqual(r, { ok: true, checkin: '2026-09-24', checkout: '2026-09-26' });
});

t('fecha inventada de hace varios años (el caso real 24-sep): pasada, con nextOccurrence del mismo mes/día', () => {
  const r = normalizeStayDates('2023-10-07', '2023-10-08', '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'pasada', nextOccurrence: '2026-10-07' });
});

t('año mal calculado (enero-septiembre del año en curso): pasada, nextOccurrence apunta al año que viene', () => {
  const r = normalizeStayDates('2026-01-15', '2026-01-18', '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'pasada', nextOccurrence: '2027-01-15' });
});

t('fecha pasada de hace pocos días: también se rechaza (ya no hay corrección automática)', () => {
  const r = normalizeStayDates('2026-09-20', '2026-09-22', '2026-09-24');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pasada');
  assert.strictEqual(r.nextOccurrence, '2027-09-20');
});

t('29 de febrero pasado: nextOccurrence cae en año no bisiesto → pasa al 28', () => {
  const r = normalizeStayDates('2024-02-29', '2024-03-01', '2025-01-15');
  assert.deepStrictEqual(r, { ok: false, reason: 'pasada', nextOccurrence: '2025-02-28' });
});

t('formato inválido: día fuera de rango del mes (30 de febrero)', () => {
  const r = normalizeStayDates('2026-02-30', '2026-03-02', '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'formato' });
});

t('formato inválido: mes fuera de rango (13)', () => {
  const r = normalizeStayDates('2026-13-01', '2026-13-03', '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'formato' });
});

t('formato inválido: patrón que no es YYYY-MM-DD', () => {
  const r = normalizeStayDates('24-09-2026', '26-09-2026', '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'formato' });
});

t('formato inválido: fechas ausentes (undefined)', () => {
  const r = normalizeStayDates(undefined, undefined, '2026-09-24');
  assert.deepStrictEqual(r, { ok: false, reason: 'formato' });
});

console.log('\nspokenDate:');

t('spokenDate sin año', () => {
  assert.strictEqual(spokenDate('2026-09-24'), 'jueves 24 de septiembre');
});

t('spokenDate con año', () => {
  assert.strictEqual(spokenDate('2026-09-24', { withYear: true }), 'jueves 24 de septiembre de 2026');
});

console.log('\nbuildForwardCalendar:');

t('calendario de hoy a +14 días: 15 líneas, incluye hoy/mañana y termina en +14', () => {
  const cal = buildForwardCalendar('2026-09-24', 14);
  assert.ok(cal.includes('2026-09-24 (hoy)'), 'falta la entrada de hoy');
  assert.ok(cal.includes('2026-09-25 (mañana)'), 'falta la entrada de mañana');
  assert.ok(cal.includes('2026-10-08 (en 14 días)'), 'falta la última entrada (+14 días)');
  assert.strictEqual(cal.split(', ').length, 15, 'debe tener 15 líneas (hoy + 14 días)');
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
