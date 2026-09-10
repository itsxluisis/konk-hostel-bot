// test/acciones.test.js — nada se ejecuta sin que el jefe lo confirme.
'use strict';

const assert = require('assert');
const fs = require('fs');

const DIR = '/tmp/enc-test-acciones';
fs.rmSync(DIR, { recursive: true, force: true });
process.env.ENCARGADO_DATA_DIR = DIR;
process.env.ENCARGADO_JEFE_ID = '111';

const acciones = require('../src/encargado/acciones');

let ejecutada = 0;
acciones.registrar('accion_de_prueba', {
  riesgo: 'alto',
  descripcion: 'solo para los tests',
  parametros: {},
  async resumen() { return 'Voy a hacer algo de prueba.'; },
  async ejecutar() { ejecutada++; return 'hecho'; },
});
acciones.registrar('accion_imposible', {
  descripcion: 'nunca se puede',
  parametros: {},
  async resumen() { return { imposible: true, motivo: 'no se puede y ya está' }; },
  async ejecutar() { throw new Error('no debería llegar aquí'); },
});
acciones.registrar('accion_que_falla', {
  descripcion: 'revienta al ejecutar',
  parametros: {},
  async resumen() { return 'Esto va a fallar.'; },
  async ejecutar() { throw new Error('reventó'); },
});

let pasan = 0, fallan = 0;
const t = (n, fn) => Promise.resolve().then(fn)
  .then(() => { pasan++; console.log(`  ✓ ${n}`); })
  .catch(e => { fallan++; console.log(`  ✗ ${n}\n     ${e.message}`); });

(async () => {
  console.log('\nEncargado · nada se hace sin permiso\n');

  await t('proponer NO ejecuta', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    assert.ok(p.id, 'sin id');
    assert.strictEqual(ejecutada, 0, 'se ha ejecutado al proponer');
  });

  await t('el aviso de riesgo alto sale en el mensaje', async () => {
    const p = await acciones.proponer('accion_de_prueba');
    assert.ok(acciones.mensaje(p).includes('no siempre se puede deshacer'));
  });

  await t('un desconocido NO puede confirmar', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    const r = await acciones.confirmar(p.id, '999');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(ejecutada, 0, 'lo ha ejecutado un desconocido');
  });

  await t('el jefe sí puede', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    const r = await acciones.confirmar(p.id, '111');
    assert.strictEqual(r.ok, true, r.texto);
    assert.strictEqual(ejecutada, 1);
  });

  await t('no se puede confirmar dos veces', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    await acciones.confirmar(p.id, '111');
    const segunda = await acciones.confirmar(p.id, '111');
    assert.strictEqual(segunda.ok, false);
    assert.strictEqual(ejecutada, 1, 'se ha ejecutado dos veces');
  });

  await t('una propuesta caducada no se ejecuta', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    // Se envejece a mano en el estado.
    const estado = require('../src/encargado/estado');
    const vieja = { ...require('../src/encargado/estado').leerPropuesta(p.id) };
    vieja.creada = new Date(Date.now() - 999 * 60000).toISOString();
    estado.guardarPropuesta(vieja);
    const r = await acciones.confirmar(p.id, '111');
    assert.strictEqual(r.ok, false);
    assert.ok(r.texto.includes('caducado'), r.texto);
    assert.strictEqual(ejecutada, 0);
  });

  await t('una propuesta inventada no cuela', async () => {
    const r = await acciones.confirmar('deadbeef', '111');
    assert.strictEqual(r.ok, false);
  });

  await t('cancelar la deja inservible', async () => {
    ejecutada = 0;
    const p = await acciones.proponer('accion_de_prueba');
    assert.strictEqual(acciones.cancelar(p.id, '111').ok, true);
    const r = await acciones.confirmar(p.id, '111');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(ejecutada, 0);
  });

  await t('un desconocido tampoco cancela', async () => {
    const p = await acciones.proponer('accion_de_prueba');
    assert.strictEqual(acciones.cancelar(p.id, '999').ok, false);
  });

  await t('lo imposible se dice antes, no se propone', async () => {
    const p = await acciones.proponer('accion_imposible');
    assert.strictEqual(p.imposible, true);
    assert.ok(p.motivo.includes('no se puede'));
  });

  await t('si la acción falla, se cuenta sin romper nada', async () => {
    const p = await acciones.proponer('accion_que_falla');
    const r = await acciones.confirmar(p.id, '111');
    assert.strictEqual(r.ok, false);
    assert.ok(r.texto.includes('reventó'), r.texto);
  });

  await t('sin jefe configurado, no manda nadie', async () => {
    const antes = process.env.ENCARGADO_JEFE_ID;
    delete process.env.ENCARGADO_JEFE_ID;
    const p = await acciones.proponer('accion_de_prueba');
    const r = await acciones.confirmar(p.id, '111');
    process.env.ENCARGADO_JEFE_ID = antes;
    assert.strictEqual(r.ok, false, 'ha dejado actuar sin jefe configurado');
  });

  console.log(`\n${pasan} pasan · ${fallan} fallan\n`);
  process.exit(fallan ? 1 : 0);
})();
