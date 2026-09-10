// src/telegram.js
'use strict';

const axios = require('axios');

/**
 * Envía un mensaje al grupo del Konk.
 * @param {string} text
 * @param {object} [opts]
 * @param {number|string} [opts.threadId]  message_thread_id del tema (grupo con Temas).
 *                                         Si no se pasa, cae en General — como siempre.
 * @param {object} [opts.keyboard]         inline_keyboard opcional.
 * @returns {Promise<object|null>} respuesta de Telegram, o null si falló.
 */
async function send(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.warn('[Telegram] No configurado'); return null; }

  // Texto plano (sin parse_mode) → se envía tal cual, sin sanitizar.
  const payload = { chat_id: chatId, text };
  if (opts.threadId) payload.message_thread_id = Number(opts.threadId);
  if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };

  try {
    const { data } = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`, payload
    );
    return data && data.result ? data.result : null;
  } catch (err) {
    // Si el tema no existe (grupo sin Temas todavía), reintenta en General
    // para no perder el aviso.
    const desc = err.response?.data?.description || '';
    if (opts.threadId && /thread not found|TOPIC_/i.test(desc)) {
      console.warn('[Telegram] Tema no encontrado, reenvío a General');
      return send(text, { ...opts, threadId: null });
    }
    console.error('[Telegram] Error:', desc || err.message);
    return null;
  }
}

/** Reescribe un mensaje ya enviado (para el ESTADO fijado). */
async function edit(messageId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !messageId) return null;
  try {
    const { data } = await axios.post(
      `https://api.telegram.org/bot${token}/editMessageText`,
      { chat_id: chatId, message_id: Number(messageId), text }
    );
    return data && data.result ? data.result : null;
  } catch (err) {
    const desc = err.response?.data?.description || '';
    // "message is not modified" no es un error real.
    if (/not modified/i.test(desc)) return null;
    console.error('[Telegram] Error al editar:', desc || err.message);
    return null;
  }
}

/** Fija un mensaje en el chat (o en su tema). Silencioso: no avisa a nadie. */
async function pin(messageId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !messageId) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/pinChatMessage`,
      { chat_id: chatId, message_id: Number(messageId), disable_notification: true });
    return true;
  } catch (err) {
    // No poder fijar (falta de permisos) no debe romper nada.
    console.warn('[Telegram] No se pudo fijar:',
      err.response?.data?.description || err.message);
    return false;
  }
}

module.exports = { send, edit, pin };
