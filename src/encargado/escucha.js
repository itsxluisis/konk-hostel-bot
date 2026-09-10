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
const { TEMAS } = require('./config');
const { responder } = require('./cerebro');
const { send } = require('../telegram');

let miUsuario = null;   // @nombre del bot, para detectar menciones

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
  if (TEMAS.PREGUNTAR && tema === String(TEMAS.PREGUNTAR)) return true;

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
async function procesar(update) {
  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.text) return { accion: 'ignorado', motivo: 'sin texto' };
  if (msg.from?.is_bot) return { accion: 'ignorado', motivo: 'lo ha dicho un bot' };

  // Cerrojo 2: solo el chat configurado.
  const permitido = String(process.env.TELEGRAM_CHAT_ID || '');
  if (permitido && String(msg.chat?.id) !== permitido) {
    return { accion: 'ignorado', motivo: 'chat no autorizado' };
  }

  if (!await vaConmigo(msg)) return { accion: 'ignorado', motivo: 'no me hablaba a mí' };

  const pregunta = await limpiar(msg.text);
  const hilo = msg.message_thread_id || TEMAS.PREGUNTAR || null;

  if (!pregunta || /^(ayuda|help|start)$/i.test(pregunta)) {
    await send(AYUDA, { threadId: hilo });
    return { accion: 'ayuda' };
  }

  const respuesta = await responder(pregunta);
  await send(respuesta, { threadId: hilo });
  return { accion: 'respondido', pregunta, largo: respuesta.length };
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
    allowed_updates: ['message'],
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

module.exports = { procesar, registrar, estadoEscucha, vaConmigo, limpiar, AYUDA };
