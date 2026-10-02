// test/email-dictado.test.js — normalización y validación de un correo
// dictado por teléfono (src/email-dictado.js). Funciones puras, sin red.
// Mismo arnés (t/pasan/fallan) que test/stay-dates.test.js.
'use strict';

const assert = require('assert');
const { normalizarEmailDictado: norm, validarEmail, respuestaEmailDictado, MENSAJE_REPETIR } = require('../src/email-dictado');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nemail-dictado · normalizarEmailDictado / validarEmail / respuestaEmailDictado\n');

t('caso básico: arroba y punto', () => {
  assert.strictEqual(norm('juan arroba gmail punto com'), 'juan@gmail.com');
});
t('guion bajo → _ y guion → -', () => {
  assert.strictEqual(norm('juan guion bajo perez guion lopez arroba hotmail punto es'), 'juan_perez-lopez@hotmail.es');
});
t('"guión" con tilde y "guión bajo" con tilde', () => {
  assert.strictEqual(norm('ana guión bajo ruiz guión gil arroba yahoo punto es'), 'ana_ruiz-gil@yahoo.es');
});
t('mayúsculas → minúsculas', () => {
  assert.strictEqual(norm('Juan.Perez ARROBA Gmail PUNTO Com'), 'juan.perez@gmail.com');
});
t('letras deletreadas con espacios', () => {
  assert.strictEqual(norm('j u a n arroba g m a i l punto c o m'), 'juan@gmail.com');
});
t('punto dentro de la parte local y dominio compuesto', () => {
  assert.strictEqual(norm('maria punto garcia arroba empresa punto co punto uk'), 'maria.garcia@empresa.co.uk');
});
t('números ya como dígitos', () => {
  assert.strictEqual(norm('pedro 85 arroba gmail punto com'), 'pedro85@gmail.com');
});
t('ya viene escrito: no se estropea', () => {
  assert.strictEqual(norm('juan.perez@gmail.com'), 'juan.perez@gmail.com');
});
t('punto final de frase y comas se descartan', () => {
  assert.strictEqual(norm('juan arroba gmail punto com.'), 'juan@gmail.com');
  assert.strictEqual(norm('juan, arroba, gmail, punto, com'), 'juan@gmail.com');
});
t('inglés: at / dot / underscore / dash', () => {
  assert.strictEqual(norm('john underscore smith at gmail dot com'), 'john_smith@gmail.com');
  assert.strictEqual(norm('anne dash lee at outlook dot com'), 'anne-lee@outlook.com');
});
t('una palabra que contiene "arroba" no se toca', () => {
  assert.strictEqual(norm('arrobafoo arroba gmail punto com'), 'arrobafoo@gmail.com');
});
t('entradas no texto → cadena vacía', () => {
  for (const v of [undefined, null, 42, {}, '', '   ']) assert.strictEqual(norm(v), '');
});

t('valida correos normales', () => {
  for (const e of ['juan@gmail.com', 'juan.perez+konk@sub.empresa.co.uk', 'a_b-c@x1.es']) {
    assert.strictEqual(validarEmail(e), true, e);
  }
});
t('rechaza correos mal formados', () => {
  const malos = ['', 'juan', 'juan@', '@gmail.com', 'juan@gmail', 'juan@@gmail.com', 'juan@gmail..com',
    '.juan@gmail.com', 'juan.@gmail.com', 'ju..an@gmail.com', 'juan@-gmail.com', 'juan@gmail.c',
    'juan@gmail.c0m', 'juan perez@gmail.com', 'juan@gmail.com.', 'juan@gma_il.com'];
  for (const e of malos) assert.strictEqual(validarEmail(e), false, e);
});
t('rechaza no cadenas y longitudes excesivas', () => {
  assert.strictEqual(validarEmail(undefined), false);
  assert.strictEqual(validarEmail(`${'a'.repeat(65)}@gmail.com`), false);
  assert.strictEqual(validarEmail(`a@${'b'.repeat(250)}.com`), false);
});

t('respuestaEmailDictado: válido devuelve el correo limpio', () => {
  assert.deepStrictEqual(respuestaEmailDictado('Luis guion bajo 7 arroba gmail punto com'),
    { ok: true, email: 'luis_7@gmail.com' });
});
t('respuestaEmailDictado: sin arroba → pide repetir deletreando', () => {
  const r = respuestaEmailDictado('luis gmail punto com');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalido');
  assert.strictEqual(r.mensaje, MENSAJE_REPETIR);
  assert.ok(/deletreando/.test(r.mensaje));
});
t('respuestaEmailDictado: vacío o basura → pide repetir', () => {
  assert.strictEqual(respuestaEmailDictado('').reason, 'vacio');
  assert.strictEqual(respuestaEmailDictado(null).ok, false);
  assert.strictEqual(respuestaEmailDictado('no tengo').ok, false);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
