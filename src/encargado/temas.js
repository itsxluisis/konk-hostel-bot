// src/encargado/temas.js
// Los carriles del grupo: cada cosa a su tema.
//
// Telegram deja crear temas por API, pero NO listarlos. Así que los ids de
// los que creamos nosotros se guardan en disco, y se pueden fijar a mano por
// variable de entorno si algún día hay que rehacerlos.
'use strict';

const axios = require('axios');
const estado = require('./estado');

// Orden = orden en que aparecerán en el grupo.
const CARRILES = [
  { clave: 'ESTADO',    nombre: '📌 Estado',    icono: '📌' },
  { clave: 'PARTE',     nombre: '🛎️ Parte diario', icono: '🛎️' },
  { clave: 'ALERTAS',   nombre: '⚠️ Alertas',   icono: '⚠️' },
  { clave: 'LLAMADAS',  nombre: '📞 Llamadas',  icono: '📞' },
  { clave: 'COBROS',    nombre: '💰 Cobros',    icono: '💰' },
  { clave: 'FACTURAS',  nombre: '🧾 Facturas',  icono: '🧾' },
  { clave: 'PREGUNTAR', nombre: '💬 Preguntar', icono: '💬' },
];

function tg(metodo, datos, get = false) {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('Falta TELEGRAM_BOT_TOKEN');
  const url = `https://api.telegram.org/bot${t}/${metodo}`;
  return (get ? axios.get(url, { params: datos, timeout: 15000 })
              : axios.post(url, datos, { timeout: 15000 })).then(r => r.data.result);
}

/**
 * El id del tema, mirando primero la variable de entorno (manda siempre)
 * y luego lo que creamos nosotros. null = va al tema General.
 */
function idDe(clave) {
  const fijado = process.env[`TG_TEMA_${clave}`];
  if (fijado) return Number(fijado);
  const guardados = estado.leerTemas();
  return guardados[clave] ? Number(guardados[clave]) : null;
}

/** ¿El grupo tiene los temas activados? */
async function estadoDelGrupo() {
  const chat = await tg('getChat', { chat_id: process.env.TELEGRAM_CHAT_ID }, true);
  return {
    titulo: chat.title,
    tipo: chat.type,
    conTemas: Boolean(chat.is_forum),
    id: chat.id,
  };
}

/**
 * Crea los carriles que falten. Es idempotente respecto a lo que nosotros
 * hayamos creado: si ya tenemos el id guardado, no lo vuelve a crear.
 */
async function crear({ soloFaltantes = true } = {}) {
  const grupo = await estadoDelGrupo();
  if (!grupo.conTemas) {
    return {
      ok: false,
      motivo: 'El grupo no tiene los Temas activados. Hay que encenderlos en'
        + ' los ajustes del grupo (Editar → Temas); no se puede hacer por API.',
      grupo,
    };
  }

  const guardados = estado.leerTemas();
  const hechos = [];
  for (const c of CARRILES) {
    if (soloFaltantes && (guardados[c.clave] || process.env[`TG_TEMA_${c.clave}`])) {
      hechos.push({ ...c, id: idDe(c.clave), accion: 'ya existía' });
      continue;
    }
    try {
      const t = await tg('createForumTopic', {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        name: c.nombre,
      });
      guardados[c.clave] = t.message_thread_id;
      estado.guardarTemas(guardados);
      hechos.push({ ...c, id: t.message_thread_id, accion: 'creado' });
    } catch (err) {
      hechos.push({
        ...c, id: null, accion: 'falló',
        error: err.response?.data?.description || err.message,
      });
    }
  }
  return { ok: true, grupo, carriles: hechos };
}

function listar() {
  return CARRILES.map(c => ({
    clave: c.clave,
    nombre: c.nombre,
    id: idDe(c.clave),
    origen: process.env[`TG_TEMA_${c.clave}`] ? 'variable de entorno'
      : (estado.leerTemas()[c.clave] ? 'creado por el encargado' : 'sin tema (va a General)'),
  }));
}

module.exports = { CARRILES, idDe, crear, listar, estadoDelGrupo };
