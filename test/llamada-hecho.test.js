// test/llamada-hecho.test.js — V2b: botón "✅ Hecho" en los avisos "📞 LLAMAR".
//
// Dos mitades, sin red real (mismo truco que test/webhook-body-limits.test.js
// y test/cloudbeds-errors.test.js: se intercepta require('axios') para todo
// el proceso ANTES de requerir src/server.js):
//
//  A) Envío — arranca el servidor real y le pega un end-of-call-report de
//     verdad con fetch; comprueba el payload que se manda a sendMessage.
//  B) Pulsación — llama a escucha.procesar({ callback_query }) directamente
//     (igual que test/escucha.test.js hace con los mensajes de texto) y
//     comprueba answerCallbackQuery / editMessageText.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- doble de axios, controlado por cada caso de prueba -----------------------
const capturedSendMessage = [];
const capturedAnswers = [];
const capturedEdits = [];
let editShouldFail = false;

function fakeAxios() { return Promise.resolve({ data: {} }); } // axios(config) bare, no usado aquí
fakeAxios.get = async () => ({ data: { result: [] } });
fakeAxios.post = async (url, payload) => {
  if (url.includes('/sendMessage')) {
    capturedSendMessage.push(payload);
    return { data: { result: { message_id: 9000 + capturedSendMessage.length, chat: { id: payload.chat_id }, text: payload.text } } };
  }
  if (url.includes('/answerCallbackQuery')) {
    capturedAnswers.push(payload);
    return { data: { result: true } };
  }
  if (url.includes('/editMessageText')) {
    capturedEdits.push(payload);
    if (editShouldFail) {
      const err = new Error('Request failed');
      err.response = { data: { description: 'Bad Request: simulated Telegram failure' } };
      throw err;
    }
    return { data: { result: { message_id: payload.message_id, chat: { id: payload.chat_id }, text: payload.text } } };
  }
  return { data: { result: {} } };
};

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'axios') return fakeAxios;
  return realRequire.apply(this, arguments);
};

const PORT = 34604;
const BASE = `http://127.0.0.1:${PORT}`;
const VAPI_SECRET = 'test-vapi-secret-llamada-hecho';
const CHAT_ID = '-1009988776655';       // chat autorizado (TELEGRAM_CHAT_ID)
const OTRO_CHAT_ID = -1;                // cualquier otro chat

process.env.PORT = String(PORT);
process.env.VAPI_SECRET = VAPI_SECRET;
process.env.VIGILANTE_OFF = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
process.env.TELEGRAM_CHAT_ID = CHAT_ID;
// Evita que el Encargado arranque el sondeo en segundo plano (getUpdates en
// bucle): con TELEGRAM_BOT_TOKEN puesto, arrancaría de verdad. Esta parte B
// llama a escucha.procesar() directamente, no necesita el sondeo.
process.env.ENCARGADO_ESCUCHA = 'webhook';
delete process.env.CLOUDBEDS_REFRESH_TOKEN;
delete process.env.VAPI_SECRET_PREVIOUS;
delete process.env.ENCARGADO_SECRET;

const app = realRequire.call(module, path.join(__dirname, '../src/server.js'));
const escucha = realRequire.call(module, path.join(__dirname, '../src/encargado/escucha.js'));
void app; // solo se necesita para que arranque el servidor (app.listen)

let pasan = 0, fallan = 0;
async function t(nombre, fn) {
  try { await fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.stack || e.message}`); }
}

function postRaw(urlPath, body, headers = {}) {
  return fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

const AVISO_TEXTO = '🏨 Konk Hostel · llamada\n\n📞 LLAMAR\n📋 Motivo: acceso\n'
  + '📝 no puede entrar\n\n💶 Coste: 0,10 €\n⏱️ Duración: 1m 30s\n'
  + '🕐 Cuándo: 25/09 12:00\n📱 Tel: +34600111222';

function mensajeConBoton(messageId) {
  return {
    message_id: messageId,
    chat: { id: Number(CHAT_ID) },
    message_thread_id: 999,
    text: AVISO_TEXTO,
    reply_markup: { inline_keyboard: [[{ text: '✅ Hecho', callback_data: escucha.LLAMADA_HECHO_DATA }]] },
  };
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300)); // deja arrancar el servidor real

  console.log('\nV2b · botón "✅ Hecho" en avisos de llamar\n');

  // ─── A) Envío ────────────────────────────────────────────────────────────
  await t('llamar=true: el aviso "📞 LLAMAR" lleva el botón "✅ Hecho"', async () => {
    capturedSendMessage.length = 0;
    const body = JSON.stringify({
      message: {
        type: 'end-of-call-report',
        customer: { number: '+34600111222' },
        durationSeconds: 90,
        cost: 0.1,
        startedAt: new Date().toISOString(),
        analysis: { structuredData: { llamar: true, motivo: 'acceso', descripcion: 'no puede entrar' } },
      },
    });
    const r = await postRaw('/vapi/assistant-config', body, { 'x-vapi-secret': VAPI_SECRET });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(capturedSendMessage.length, 1, 'debía mandar exactamente un sendMessage');
    const enviado = capturedSendMessage[0];
    assert.ok(enviado.text.includes('📞 LLAMAR'), 'la cabecera debía ser 📞 LLAMAR');
    assert.deepStrictEqual(enviado.reply_markup, {
      inline_keyboard: [[{ text: '✅ Hecho', callback_data: 'llamada:hecho' }]],
    });
  });

  await t('llamar=false: el aviso "✅ No llamar" NO lleva botón', async () => {
    capturedSendMessage.length = 0;
    const body = JSON.stringify({
      message: {
        type: 'end-of-call-report',
        customer: { number: '+34600111222' },
        durationSeconds: 20,
        analysis: { structuredData: { llamar: false, motivo: 'info', descripcion: 'consulta wifi' } },
      },
    });
    const r = await postRaw('/vapi/assistant-config', body, { 'x-vapi-secret': VAPI_SECRET });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(capturedSendMessage.length, 1);
    const enviado = capturedSendMessage[0];
    assert.ok(enviado.text.includes('✅ No llamar'), 'la cabecera debía ser ✅ No llamar');
    assert.strictEqual(enviado.reply_markup, undefined, 'no debía llevar teclado');
  });

  // ─── B) Pulsación ────────────────────────────────────────────────────────
  await t('pulsación desde el chat autorizado: responde y edita con la línea, sin teclado', async () => {
    capturedAnswers.length = 0; capturedEdits.length = 0;
    const cb = {
      id: 'cbq-autorizado',
      data: escucha.LLAMADA_HECHO_DATA,
      from: { id: 111, first_name: 'Marta', is_bot: false },
      message: mensajeConBoton(5001),
    };
    const r = await escucha.procesar({ callback_query: cb });
    assert.strictEqual(r.accion, 'llamada-hecho');
    assert.strictEqual(capturedAnswers.length, 1);
    assert.strictEqual(capturedAnswers[0].text, 'Marcado como hecho');
    assert.strictEqual(capturedEdits.length, 1);
    const edicion = capturedEdits[0];
    assert.strictEqual(edicion.message_id, 5001);
    assert.ok(edicion.text.startsWith(AVISO_TEXTO));
    assert.match(edicion.text, /\n\n✅ Hecho · Marta · \d{2}:\d{2}$/);
    assert.deepStrictEqual(edicion.reply_markup, { inline_keyboard: [] });
  });

  await t('pulsación desde otro chat: "No autorizado" y sin edición', async () => {
    capturedAnswers.length = 0; capturedEdits.length = 0;
    const cb = {
      id: 'cbq-otro-chat',
      data: escucha.LLAMADA_HECHO_DATA,
      from: { id: 222, first_name: 'Desconocido', is_bot: false },
      message: { ...mensajeConBoton(5002), chat: { id: OTRO_CHAT_ID } },
    };
    const r = await escucha.procesar({ callback_query: cb });
    assert.strictEqual(r.accion, 'llamada-hecho-rechazado');
    assert.strictEqual(capturedAnswers.length, 1);
    assert.strictEqual(capturedAnswers[0].text, 'No autorizado');
    assert.strictEqual(capturedEdits.length, 0, 'no debía tocar el mensaje');
  });

  await t('segunda pulsación sobre un aviso ya marcado: solo responde, sin segunda edición', async () => {
    capturedAnswers.length = 0; capturedEdits.length = 0;
    const cb = {
      id: 'cbq-repetido',
      data: escucha.LLAMADA_HECHO_DATA,
      from: { id: 333, first_name: 'Otro', is_bot: false },
      message: {
        ...mensajeConBoton(5003),
        text: `${AVISO_TEXTO}\n\n✅ Hecho · Marta · 12:05`,
        reply_markup: undefined, // Telegram ya no manda teclado: la edición anterior lo quitó
      },
    };
    const r = await escucha.procesar({ callback_query: cb });
    assert.strictEqual(r.accion, 'llamada-hecho-repetido');
    assert.strictEqual(capturedAnswers.length, 1);
    assert.strictEqual(capturedAnswers[0].text, 'Ya estaba marcado como hecho.');
    assert.strictEqual(capturedEdits.length, 0, 'no debía editar dos veces');
  });

  await t('un error de Telegram al editar no rompe la escucha', async () => {
    capturedAnswers.length = 0; capturedEdits.length = 0;
    editShouldFail = true;
    const cb = {
      id: 'cbq-fallo-edicion',
      data: escucha.LLAMADA_HECHO_DATA,
      from: { id: 444, first_name: 'Cris', is_bot: false },
      message: mensajeConBoton(5004),
    };
    let r;
    await assert.doesNotReject(async () => { r = await escucha.procesar({ callback_query: cb }); });
    editShouldFail = false;
    assert.strictEqual(r.accion, 'llamada-hecho');
    assert.strictEqual(capturedAnswers.length, 1);
    assert.strictEqual(capturedAnswers[0].text, 'Marcado como hecho');
    assert.strictEqual(capturedEdits.length, 1, 'el intento de edición debía darse (y fallar por dentro)');
  });

  console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
  process.exit(fallan > 0 ? 1 : 0);
})();
