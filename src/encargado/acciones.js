// src/encargado/acciones.js
// Lo que el encargado puede HACER, no solo contar.
//
// Regla que gobierna todo este archivo: nada se ejecuta solo. Una acción se
// PROPONE, se muestra en cristiano con lo que va a pasar, y solo se hace
// cuando el jefe pulsa el botón. Y solo el jefe: el grupo tiene más gente,
// y preguntar puede cualquiera, pero ordenar no.
'use strict';

const crypto = require('crypto');
const estado = require('./estado');

// Cuánto vive una propuesta sin confirmar. Pasado ese rato, caduca: confirmar
// a ciegas algo propuesto hace horas es justo lo que no queremos.
const VIDA_MIN = Number(process.env.ENCARGADO_VIDA_PROPUESTA || 30);

/**
 * Quiénes pueden ordenar: la variable de entorno manda, y si no hay,
 * lo guardado en disco. Sin ninguno de los dos, nadie manda: es la
 * postura segura, no un descuido.
 */
function jefes() {
  const env = (process.env.ENCARGADO_JEFE_ID || '').trim();
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return estado.leerJefes();
}

function esElJefe(userId) {
  if (!userId) return false;
  return jefes().includes(String(userId));
}

function hayJefe() {
  return jefes().length > 0;
}

// ─── catálogo ────────────────────────────────────────────────────────────────
// Cada acción declara:
//   riesgo:   'ninguno' | 'medio' | 'alto'  (solo informativo, para el aviso)
//   resumen:  qué se va a hacer, en una frase, ANTES de hacerlo
//   ejecutar: lo que hace de verdad
const ACCIONES = {};

function registrar(nombre, def) {
  ACCIONES[nombre] = { nombre, riesgo: 'medio', ...def };
}

// ─── propuestas ──────────────────────────────────────────────────────────────

/**
 * Prepara una acción y devuelve la propuesta, sin ejecutar nada.
 */
async function proponer(nombre, args = {}) {
  const a = ACCIONES[nombre];
  if (!a) throw new Error(`No sé hacer "${nombre}".`);

  const id = crypto.randomBytes(4).toString('hex');
  let resumen;
  try {
    resumen = await a.resumen(args);
  } catch (err) {
    throw new Error(`No he podido preparar la acción: ${err.message}`);
  }
  if (resumen && resumen.imposible) {
    return { imposible: true, motivo: resumen.motivo };
  }

  const propuesta = {
    id, accion: nombre, args,
    texto: typeof resumen === 'string' ? resumen : resumen.texto,
    riesgo: a.riesgo,
    creada: new Date().toISOString(),
  };
  estado.guardarPropuesta(propuesta);
  return propuesta;
}

function caducada(p) {
  return (Date.now() - new Date(p.creada).getTime()) > VIDA_MIN * 60000;
}

/**
 * Ejecuta una propuesta confirmada. Devuelve {ok, texto}.
 * Comprueba, por este orden: que exista, que no esté usada, que no haya
 * caducado y que quien confirma sea el jefe.
 */
async function confirmar(id, userId) {
  const p = estado.leerPropuesta(id);
  if (!p) return { ok: false, texto: 'Esa propuesta ya no existe. Vuelve a pedírmelo.' };
  if (p.hecha) return { ok: false, texto: `Eso ya se hizo el ${p.hecha.slice(0, 16).replace('T', ' a las ')}.` };
  if (caducada(p)) return { ok: false, texto: `La propuesta ha caducado (más de ${VIDA_MIN} min). Pídemelo otra vez.` };
  if (!esElJefe(userId)) {
    return { ok: false, texto: 'Esto solo lo puede confirmar Luis.' };
  }

  const a = ACCIONES[p.accion];
  if (!a) return { ok: false, texto: `Ya no sé hacer "${p.accion}".` };

  // Se marca ANTES de ejecutar: si algo peta a medias, no se repite sola.
  estado.marcarPropuestaHecha(id);
  try {
    const texto = await a.ejecutar(p.args);
    return { ok: true, texto };
  } catch (err) {
    return { ok: false, texto: `Lo he intentado y ha fallado: ${err.message}` };
  }
}

function cancelar(id, userId) {
  const p = estado.leerPropuesta(id);
  if (!p) return { ok: false, texto: 'Esa propuesta ya no existe.' };
  if (!esElJefe(userId)) return { ok: false, texto: 'Esto solo lo puede cancelar Luis.' };
  estado.borrarPropuesta(id);
  return { ok: true, texto: 'Hecho, lo dejo estar.' };
}

/** Los botones que acompañan a una propuesta. */
function botones(p) {
  return [[
    { text: '✅ Confirmar', callback_data: `ok:${p.id}` },
    { text: '✖️ Cancelar', callback_data: `no:${p.id}` },
  ]];
}

/** El mensaje de la propuesta, tal cual va al grupo. */
function mensaje(p) {
  const aviso = p.riesgo === 'alto'
    ? '\n\n⚠️ Esto cambia datos de verdad y no siempre se puede deshacer.'
    : '';
  return `${p.texto}${aviso}\n\n¿Lo hago?`;
}

module.exports = {
  ACCIONES, registrar, proponer, confirmar, cancelar,
  botones, mensaje, esElJefe, hayJefe, jefes, VIDA_MIN,
};
