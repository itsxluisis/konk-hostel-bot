// src/email-dictado.js
// Normaliza un correo electrónico DICTADO por teléfono (lo que escribe el STT
// de Vapi) y lo valida. Funciones PURAS: sin red ni reloj.
//
// Ejemplo: "Juan guion Perez arroba gmail punto com" → "juan-perez@gmail.com".
//
// Hoy NINGUNA tool del bot recoge un correo (get_availability, get_current_date
// y report_incident no lo piden). Esta pieza queda lista para la primera tool
// que lo pida: llamar a `respuestaEmailDictado(valor)` y, si `ok` es false,
// devolver su `mensaje` al modelo para que se lo repita al huésped deletreando.
'use strict';

// Palabras sueltas (ya sin tildes y en minúsculas) → símbolo. Español primero;
// el inglés cubre a huéspedes extranjeros que dictan en su idioma.
const PALABRA_A_SIMBOLO = {
  arroba: '@', at: '@',
  punto: '.', dot: '.',
  guion: '-', dash: '-', hyphen: '-',
  underscore: '_',
};

// Pares de palabras que hay que mirar ANTES que las sueltas ("guion bajo" ≠ "guion").
const PAR_A_SIMBOLO = {
  'guion bajo': '_',
  'guion medio': '-',
  'barra baja': '_',
};

const MAX_LONGITUD = 254;
const LOCAL_RE = /^[a-z0-9]+(?:[._%+-][a-z0-9]+)*$/;
const ETIQUETA_DOMINIO_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,24}$/;

function sinTildes(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Convierte el texto dictado en un candidato a correo (minúsculas, sin
 * espacios, con @ . _ - ya sustituidos). No valida: eso lo hace validarEmail.
 * @param {*} bruto  texto tal como llega del STT
 * @returns {string}
 */
function normalizarEmailDictado(bruto) {
  if (typeof bruto !== 'string') return '';
  const texto = sinTildes(bruto.toLowerCase()).trim();
  // Tokens separados por espacios o comas; sin puntuación de frase a los lados.
  const palabras = texto
    .split(/[\s,;]+/)
    .map((p) => p.replace(/^[¿¡"'()]+|[?!"'()]+$/g, ''))
    .filter(Boolean);

  const partes = [];
  for (let i = 0; i < palabras.length; i++) {
    const par = `${palabras[i]} ${palabras[i + 1] || ''}`;
    if (Object.prototype.hasOwnProperty.call(PAR_A_SIMBOLO, par)) {
      partes.push(PAR_A_SIMBOLO[par]);
      i++;
    } else if (Object.prototype.hasOwnProperty.call(PALABRA_A_SIMBOLO, palabras[i])) {
      partes.push(PALABRA_A_SIMBOLO[palabras[i]]);
    } else {
      partes.push(palabras[i]);
    }
  }
  // Quita espacios (ya no hay) y el punto o coma de cierre de frase.
  return partes.join('').replace(/[.,;]+$/, '');
}

/**
 * Valida un correo ya normalizado (formato práctico, no el RFC completo).
 * @param {string} email
 * @returns {boolean}
 */
function validarEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_LONGITUD) return false;
  const trozos = email.split('@');
  if (trozos.length !== 2) return false;
  const [local, dominio] = trozos;
  if (local.length === 0 || local.length > 64 || !LOCAL_RE.test(local)) return false;
  const etiquetas = dominio.split('.');
  if (etiquetas.length < 2) return false;
  if (!etiquetas.every((e) => e.length > 0 && e.length <= 63 && ETIQUETA_DOMINIO_RE.test(e))) return false;
  return TLD_RE.test(etiquetas[etiquetas.length - 1]);
}

const MENSAJE_REPETIR =
  'No he entendido bien el correo. Pídele que te lo repita despacio, deletreando: ' +
  'las letras una a una y diciendo "arroba", "punto", "guion" o "guion bajo" donde toque. ' +
  'No des el correo por bueno hasta que te llegue completo.';

/**
 * Para usar dentro de una tool. Devuelve { ok:true, email } o
 * { ok:false, reason, mensaje } con el texto que se devuelve al modelo.
 */
function respuestaEmailDictado(bruto) {
  const email = normalizarEmailDictado(bruto);
  if (!email) return { ok: false, reason: 'vacio', mensaje: MENSAJE_REPETIR };
  if (!validarEmail(email)) return { ok: false, reason: 'invalido', mensaje: MENSAJE_REPETIR };
  return { ok: true, email };
}

module.exports = { normalizarEmailDictado, validarEmail, respuestaEmailDictado, MENSAJE_REPETIR };
