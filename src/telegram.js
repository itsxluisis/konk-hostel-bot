// src/telegram.js
'use strict';

const axios = require('axios');

function ts() {
  return new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

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

async function alertStaff({ urgency, guestName, room, issue, summary }) {
  const icons = { low: 'ℹ️', high: '⚠️', critical: '🚨' };
  const icon = icons[urgency] || '⚠️';

  await send(
    `${icon} *Alerta Konk Hostel* — ${urgency.toUpperCase()}\n\n` +
    `🕐 ${ts()}\n` +
    `👤 Huésped: ${guestName || 'desconocido'}\n` +
    `🚪 Habitación: ${room || '—'}\n` +
    `📋 Incidencia: ${issue}\n\n` +
    `💬 _${summary || ''}_`
  );
}

module.exports = { send, alertStaff };
