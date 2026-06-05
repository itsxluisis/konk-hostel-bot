// src/telegram.js
'use strict';

const axios = require('axios');

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.warn('[Telegram] No configurado'); return; }

  // Sanitizar texto — quitar caracteres especiales de Markdown
  const safe = text.replace(/[*_`[\]()~>#+=|{}.!]/g, '').replace(/-/g, ' ');

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: safe,
    });
  } catch (err) {
    console.error('[Telegram] Error:', err.message);
  }
}

module.exports = { send };
