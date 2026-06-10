// src/telegram.js
'use strict';

const axios = require('axios');

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.warn('[Telegram] No configurado'); return; }

  // Texto plano (sin parse_mode) → se envía tal cual, sin sanitizar.
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error('[Telegram] Error:', err.message);
  }
}

module.exports = { send };
