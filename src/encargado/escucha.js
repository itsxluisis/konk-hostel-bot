// src/encargado/escucha.js
// La oreja del encargado: recibe los mensajes del grupo de Telegram.
//
// Esto abre una puerta pública, así que hay tres cerrojos:
//   1. Telegram firma cada aviso con un secreto que solo conocemos nosotros.
//   2. Solo se atiende al chat configurado. A cualquier otro, silencio.
//   3. Dentro del grupo, solo se contesta cuando se habla con el encargado
//      (en su tema, mencionándolo, respondiéndole o con //).
//
// Lo que escriben las personas es DATO, no órdenes: las consultas son de
// solo lectura y ninguna cambia nada en Cloudbeds.
'use strict';

const axios = require('axios');
const temas = require('./temas');
const { responder } = require('./cerebro');
const acciones = require('./acciones');
const { send } = require('../telegram');

let miUsuario = null;   // @nombre del bot, para detectar menciones

// Quién ha escrito en el grupo. Sirve para averiguar el id de Telegram de
// Luis sin tener que adivinarlo: se mira aquí y se configura ENCARGADO_JEFE_ID.
const vistos = new Map();
function apuntarQuien(from) {
  if (!from || from.is_bot) return;
  vistos.set(String(from.id), {
    id: from.id,
    nombre: [from.first_name, from.last_name].filter(Boolean).join(' '),
    usuario: from.username ? `@${from.username}` : null,
    visto: new Date().toISOString(),
  });
}
function quienEscribe() {
  return [...vistos.values()].sort((a, b) => b.visto.localeCompare(a.visto));
}

async function nombreDelBot() {
  if (miUsuario !== null) return miUsuario;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { miUsuario = ''; return miUsuario; }   // sin token, ni lo intentamos
  try {
    const t = token;
    const { data } = await axios.get(`https://api.telegram.org/bot${t}/getMe`, { timeout: 10000 });
    miUsuario = (data.result?.username || '').toLowerCase();
  } catch {
    miUsuario = '';
  }
  return miUsuario;
}

/** ¿Este mensaje va con nosotros? */
async function vaConmigo(msg) {
  const texto = msg.text || '';
  if (texto.startsWith('/')) return true;

  // Respondiendo a algo que dijo el bot.
  if (msg.reply_to_message?.from?.is_bot) return true;

  // En el tema "Preguntar", todo va dirigido al encargado.
  const tema = String(msg.message_thread_id || '');
  const elSuyo = temas.idDe('PREGUNTAR');
  if (elSuyo && tema === String(elSuyo)) return true;

  // Mención explícita.
  const yo = await nombreDelBot();
  if (yo && texto.toLowerCase().includes(`@${yo}`)) return true;

  // Llamarlo por su oficio también vale.
  return /^\s*encargado[\s,:]/i.test(texto);
}

/** Quita la mención y el comando para quedarnos con la pregunta. */
async function limpiar(texto) {
  const yo = await nombreDelBot();
  let t = texto;
  if (yo) t = t.replace(new RegExp(`@${yo}`, 'gi'), ' ');
  t = t.replace(/^\s*\/\w+(@\S+)?\s*/, ' ');
  t = t.replace(/^\s*encargado[\s,:]+/i, ' ');
  return t.trim();
}

const AYUDA = [
  'Soy el encargado del Konk. Pregúntame en cristiano, por ejemplo:',
  '',
  '   · ¿quién llega mañana?',
  '   · ¿quién se va hoy?',
  '   · ¿cuánta gente hay dentro?',
  '   · dame el parte',
  '   · ¿cómo va el equipo?',
  '   · revisa los cobros',
  '   · busca a Cristian',
].join('\n');

/**
 * Procesa un aviso de Telegram. Devuelve lo que ha hecho, para el log.
 * Nunca lanza: a Telegram siempre se le responde 200 o dejará de avisar.
 */
/** Quita el relojito del botón y, si hace falta, muestra un aviso corto. */
async function contestarBoton(id, aviso) {
  try {
    const t = process.env.TELEGRAM_BOT_TOKEN;
    await axios.post(`https://api.telegram.org/bot${t}/answerCallbackQuery`,
      { callback_query_id: id, text: aviso || undefined, show_alert: false },
      { timeout: 10000 });
  } catch { /* que no llegue el acuse no debe romper nada */ }
}

/**
 * Alguien ha pulsado Confirmar o Cancelar.
 * El botón lo ve todo el grupo, pero solo el jefe manda: quien no lo sea
 * recibe un aviso discreto y no pasa nada más.
 */
async function procesarBoton(cb) {
  apuntarQuien(cb.from);
  const [que, id] = String(cb.data || '').split(':');
  const hilo = cb.message?.message_thread_id || null;

  if (!acciones.esElJefe(cb.from?.id)) {
    await contestarBoton(cb.id, 'Esto solo lo puede confirmar Luis.');
    return { accion: 'boton-rechazado', quien: cb.from?.id };
  }

  const r = que === 'ok'
    ? await acciones.confirmar(id, cb.from.id)
    : acciones.cancelar(id, cb.from.id);

  await contestarBoton(cb.id, r.ok ? 'Hecho' : 'No se ha podido');
  await send(r.texto, { threadId: hilo });
  return { accion: que === 'ok' ? 'confirmado' : 'cancelado', id, ok: r.ok };
}

async function procesar(update) {
  if (update?.callback_query) {
    try {
      return await procesarBoton(update.callback_query);
    } catch (err) {
      console.error('[Encargado] Fallo con un botón:', err.message);
      return { accion: 'boton-fallido', error: err.message };
    }
  }

  const msg = update?.message || update?.edited_message;
  apuntarQuien(msg?.from);
  if (!msg || !msg.text) return { accion: 'ignorado', motivo: 'sin texto' };
  if (msg.from?.is_bot) return { accion: 'ignorado', motivo: 'lo ha dicho un bot' };

  // Cerrojo 2: solo el chat configurado.
  const permitido = String(process.env.TELEGRAM_CHAT_ID || '');
  if (permitido && String(msg.chat?.id) !== permitido) {
    return { accion: 'ignorado', motivo: 'chat no autorizado' };
  }

  if (!await vaConmigo(msg)) return { accion: 'ignorado', motivo: 'no me hablaba a mí' };

  const pregunta = await limpiar(msg.text);
  const hilo = msg.message_thread_id || temas.idDe('PREGUNTAR') || null;

  if (!pregunta || /^(ayuda|help|start)$/i.test(pregunta)) {
    await send(AYUDA, { threadId: hilo });
    return { accion: 'ayuda' };
  }

  const r = await responder(pregunta);
  await send(r.texto, { threadId: hilo, keyboard: r.botones });
  return {
    accion: r.botones ? 'propuesta' : 'respondido',
    pregunta, largo: r.texto.length,
  };
}

/**
 * Le dice a Telegram dónde avisarnos. Se llama una vez, desde
 * POST /encargado/registrar-escucha.
 */
async function registrar(urlBase, secreto) {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('Falta TELEGRAM_BOT_TOKEN');
  const url = `${urlBase.replace(/\/$/, '')}/encargado/telegram`;
  const { data } = await axios.post(`https://api.telegram.org/bot${t}/setWebhook`, {
    url,
    secret_token: secreto,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }, { timeout: 15000 });
  return { url, telegram: data };
}

async function estadoEscucha() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return { configurado: false, motivo: 'sin TELEGRAM_BOT_TOKEN' };
  const { data } = await axios.get(`https://api.telegram.org/bot${t}/getWebhookInfo`,
    { timeout: 10000 });
  return data.result || {};
}

// ─── sondeo (alternativa al webhook) ─────────────────────────────────────────
// Telegram no consigue resolver el dominio de EasyPanel, así que en vez de
// esperar a que nos avise, preguntamos nosotros. Es el mismo mecanismo que
// usa cualquier bot detrás de un NAT: una conexión larga que se queda
// esperando a que haya algo. Ni DNS, ni certificados, ni puertos.
let sondeando = false;
let ultimoUpdate = 0;
let ultimoLatidoSondeo = null;
let ultimoErrorSondeo = null;

async function unaVuelta() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) return 0;
  const { data } = await axios.get(`https://api.telegram.org/bot${t}/getUpdates`, {
    params: {
      offset: ultimoUpdate ? ultimoUpdate + 1 : undefined,
      timeout: 30,                       // Telegram espera hasta 30 s si no hay nada
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    },
    timeout: 40000,
  });
  const updates = data.result || [];
  for (const u of updates) {
    ultimoUpdate = Math.max(ultimoUpdate, u.update_id);
    try {
      const r = await procesar(u);
      if (r.accion !== 'ignorado') console.log('[Encargado] Telegram:', JSON.stringify(r));
    } catch (err) {
      console.error('[Encargado] Fallo procesando un mensaje:', err.message);
    }
  }
  ultimoLatidoSondeo = new Date().toISOString();
  return updates.length;
}

/**
 * Arranca el sondeo. Se reintenta solo: un fallo de red no debe dejar
 * al encargado sordo para siempre.
 */
function arrancarSondeo() {
  if (sondeando) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('[Encargado] Sin TELEGRAM_BOT_TOKEN: el encargado no escucha.');
    return;
  }
  sondeando = true;
  console.log('👂 Encargado escuchando Telegram por sondeo');

  // Cuántos conflictos seguidos se toleran antes de rendirse. Diez intentos
  // de 30 s son cinco minutos: de sobra para un despliegue, poco para un
  // webhook mal puesto.
  const MAX_CONFLICTOS = 10;

  (async function bucle() {
    let fallos = 0;
    let conflictos = 0;
    for (;;) {
      try {
        await unaVuelta();
        fallos = 0;
        conflictos = 0;
      } catch (err) {
        fallos++;
        const desc = err.response?.data?.description || err.message;
        // 409 = hay un webhook puesto; el sondeo y el webhook se estorban.
        ultimoErrorSondeo = { cuando: new Date().toISOString(), status: err.response?.status || null, desc };

        if (err.response?.status === 409) {
          // Otro proceso pregunta por el mismo bot. Durante un despliegue esto
          // es NORMAL: la instancia vieja y la nueva se solapan unos segundos.
          // Rendirse aquí dejaría al encargado sordo tras cada deploy, así que
          // se espera a que la otra se muera. Solo se abandona si el conflicto
          // dura de verdad: entonces es un webhook puesto, no un solape.
          conflictos++;
          if (conflictos > MAX_CONFLICTOS) {
            console.error('[Encargado] Conflicto persistente, dejo de escuchar:', desc);
            sondeando = false;
            return;
          }
          console.warn(`[Encargado] Sondeo en conflicto (${conflictos}/${MAX_CONFLICTOS}),`
            + ' probablemente un despliegue. Reintento en 30 s.');
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }

        console.error(`[Encargado] Sondeo falló (${fallos}):`, desc);
        // Espera creciente, con tope de un minuto.
        await new Promise(r => setTimeout(r, Math.min(60000, 2000 * fallos)));
      }
    }
  })();
}

function estadoSondeo() {
  return { activo: sondeando, ultimoUpdate, ultimaVuelta: ultimoLatidoSondeo,
           ultimoError: ultimoErrorSondeo };
}

module.exports = {
  procesar, registrar, estadoEscucha, vaConmigo, limpiar, AYUDA, quienEscribe,
  arrancarSondeo, estadoSondeo,
};
