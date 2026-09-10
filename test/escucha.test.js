// test/escucha.test.js — a quién escucha el encargado y a quién no.
'use strict';

const assert = require('assert');
delete process.env.TELEGRAM_BOT_TOKEN;      // sin red en los tests
process.env.TELEGRAM_CHAT_ID = '-1001234567890';

const { vaConmigo, limpiar, procesar } = require('../src/encargado/escucha');

let pasan = 0, fallan = 0;
const t = (n, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pasan++; console.log(`  ✓ ${n}`); })
  .catch(e => { fallan++; console.log(`  ✗ ${n}\n     ${e.message}`); });

const msg = (extra = {}) => ({
  text: 'hola', chat: { id: -1001234567890 }, from: { is_bot: false }, ...extra,
});

(async () => {
  console.log('\nEncargado · a quién contesta\n');

  await t('contesta a un comando', async () => {
    assert.strictEqual(await vaConmigo(msg({ text: '/parte' })), true);
  });

  await t('contesta si le responden a él', async () => {
    assert.strictEqual(
      await vaConmigo(msg({ reply_to_message: { from: { is_bot: true } } })), true);
  });

  await t('contesta si le llaman por su oficio', async () => {
    assert.strictEqual(await vaConmigo(msg({ text: 'Encargado, ¿quién llega?' })), true);
  });

  await t('NO se mete en una conversación que no va con él', async () => {
    assert.strictEqual(await vaConmigo(msg({ text: '¿alguien tiene la llave del 3?' })), false);
  });

  await t('ignora a otro chat aunque le hablen', async () => {
    const r = await procesar({ message: msg({ text: '/parte', chat: { id: -999 } }) });
    assert.strictEqual(r.accion, 'ignorado');
    assert.strictEqual(r.motivo, 'chat no autorizado');
  });

  await t('ignora lo que dicen otros bots', async () => {
    const r = await procesar({ message: msg({ text: '/parte', from: { is_bot: true } }) });
    assert.strictEqual(r.accion, 'ignorado');
  });

  await t('ignora mensajes sin texto (una foto, por ejemplo)', async () => {
    const r = await procesar({ message: { chat: { id: -1001234567890 }, photo: [{}] } });
    assert.strictEqual(r.accion, 'ignorado');
  });

  await t('limpia el comando y deja la pregunta', async () => {
    assert.strictEqual(await limpiar('/preguntar ¿quién llega mañana?'), '¿quién llega mañana?');
    assert.strictEqual(await limpiar('Encargado: dame el parte'), 'dame el parte');
  });

  // ─── qué consulta elige cuando no hay cerebro ───
  const { elegir, fechaDeTexto } = require('../src/encargado/cerebro');
  console.log('\nEncargado · qué entiende sin cerebro\n');

  const casos = [
    ['¿quién llega mañana?', 'quien_llega', 'mañana'],
    ['quien se va hoy', 'quien_se_va', 'hoy'],
    ['cuánta gente hay dentro', 'quien_esta_dentro', 'hoy'],
    ['dame el parte', 'estado_del_dia', 'hoy'],
    ['cómo va el equipo', 'como_va_el_equipo', 'hoy'],
    ['revisa los cobros', 'revisar_cobros', 'hoy'],
    ['salidas del 2026-09-14', 'quien_se_va', '2026-09-14'],
  ];
  for (const [texto, esperada, fecha] of casos) {
    await t(`"${texto}" → ${esperada}`, () => {
      const e = elegir(texto);
      assert.ok(e, 'no ha reconocido la pregunta');
      assert.strictEqual(e.consulta, esperada);
      if (e.args.fecha) assert.strictEqual(e.args.fecha, fecha);
    });
  }

  await t('"busca a Cristian" saca el nombre', () => {
    const e = elegir('busca a Cristian');
    assert.strictEqual(e.consulta, 'buscar_huesped');
    assert.strictEqual(e.args.nombre, 'Cristian');
  });

  await t('lo que no entiende, no lo fuerza', () => {
    assert.strictEqual(elegir('¿qué tal el tiempo en Cartagena?'), null);
  });

  await t('fechaDeTexto entiende ayer y mañana', () => {
    assert.strictEqual(fechaDeTexto('quien salio ayer'), 'ayer');
    assert.strictEqual(fechaDeTexto('llegadas de mañana'), 'mañana');
  });

  console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
  process.exit(fallan ? 1 : 0);
})();
