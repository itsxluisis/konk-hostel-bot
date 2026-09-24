// test/redact.test.js — V1.1: redacción profunda de secretos en respuestas
// de Vapi antes de que lleguen al navegador (docs/plan-mejora-voz-sep-2026.md).
// Módulo puro (src/redact.js), sin red ni servidor: se testea directo.
'use strict';

const assert = require('assert');
const { redactDeep, REDACTED } = require('../src/redact');

let pasan = 0, fallan = 0;
function t(nombre, fn) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallan++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nredact · redacción profunda de secretos en respuestas de Vapi\n');

t('redacta server.headers[\'x-vapi-secret\'] del assistant, conservando la clave de cabecera', () => {
  const asst = {
    id: 'asst_1',
    server: {
      url: 'https://example.com/hook',
      headers: { 'x-vapi-secret': 'MARCADOR-1', 'Content-Type': 'application/json' },
    },
  };
  const out = redactDeep(asst);
  assert.strictEqual(out.server.headers['x-vapi-secret'], REDACTED);
  // (b) TODOS los valores bajo `headers`, no solo el que nombra la tarea.
  assert.strictEqual(out.server.headers['Content-Type'], REDACTED);
  assert.ok('x-vapi-secret' in out.server.headers && 'Content-Type' in out.server.headers, 'debe conservar las claves de cabecera');
  assert.ok(!JSON.stringify(out).includes('MARCADOR-1'));
});

t('redacta server.secret de una tool inline y los headers de su server, sin tocar el resto de la tool', () => {
  const asst = {
    id: 'asst_1',
    model: {
      model: 'gpt-4o-mini',
      tools: [
        {
          type: 'function',
          function: { name: 'get_availability' },
          server: { url: 'https://x/y', secret: 'MARCADOR-2', headers: { 'x-vapi-secret': 'MARCADOR-3' } },
        },
      ],
    },
  };
  const out = redactDeep(asst);
  const tool = out.model.tools[0];
  assert.strictEqual(tool.server.secret, REDACTED);
  assert.strictEqual(tool.server.headers['x-vapi-secret'], REDACTED);
  assert.strictEqual(tool.function.name, 'get_availability', 'no debe tocar campos no sensibles');
  assert.strictEqual(tool.server.url, 'https://x/y', 'no debe tocar la URL del server');
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes('MARCADOR-2') && !raw.includes('MARCADOR-3'));
});

t('redacta monitor.listenUrl y monitor.controlUrl de una llamada', () => {
  const call = { id: 'call_1', monitor: { listenUrl: 'wss://marcador-listen', controlUrl: 'https://marcador-control' } };
  const out = redactDeep(call);
  assert.strictEqual(out.monitor.listenUrl, REDACTED);
  assert.strictEqual(out.monitor.controlUrl, REDACTED);
});

t('redacta claves exactas (case-insensitive): token, accessToken, refreshToken, apiKey, password, authorization, serverUrlSecret', () => {
  const obj = {
    token: 'MARCADOR-TOK',
    accessToken: 'MARCADOR-ACC',
    refreshToken: 'MARCADOR-REF',
    apiKey: 'MARCADOR-KEY',
    password: 'MARCADOR-PASS',
    Authorization: 'MARCADOR-AUTH', // case-insensitive
    ApiKEY: 'MARCADOR-KEY2',
    serverUrlSecret: 'MARCADOR-SUS',
  };
  const out = redactDeep(obj);
  Object.keys(obj).forEach((k) => assert.strictEqual(out[k], REDACTED, `${k} debería redactarse`));
});

t('V1.1 (ampliación del auditor): redacta por SUBCADENA en el nombre de clave, sin tocar campos no sensibles', () => {
  const obj = {
    id: 'asst_9',
    name: 'Konk',
    firstMessage: 'Hola, Konk Hostel',
    clientSecret: 'MARCADOR-CS',
    privateKey: 'MARCADOR-PK',
    webhookSecret: 'MARCADOR-WHS',
    bearerToken: 'MARCADOR-BT',
    apiToken: 'MARCADOR-AT',
    credentials: [{ apiKey: 'MARCADOR-CRED-AK', provider: 'openai' }],
    transcriber: { provider: 'deepgram', apiKey: 'MARCADOR-TRANS-AK' },
    model: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'PROMPT DE VERDAD' }],
    },
    customer: { number: '+34600000000' },
    status: 'ended',
    transcript: 'AI: hola\nUser: hola',
    createdAt: '2026-09-24T10:00:00.000Z',
    costBreakdown: { promptTokens: 321, completionTokens: 45 },
  };

  const out = redactDeep(obj);

  // Se redactan (subcadena sensible en el nombre de la clave, valor string)
  assert.strictEqual(out.clientSecret, REDACTED);
  assert.strictEqual(out.privateKey, REDACTED);
  assert.strictEqual(out.webhookSecret, REDACTED);
  assert.strictEqual(out.bearerToken, REDACTED);
  assert.strictEqual(out.apiToken, REDACTED);
  assert.strictEqual(out.credentials[0].apiKey, REDACTED);
  assert.strictEqual(out.transcriber.apiKey, REDACTED);

  // Siguen intactos: campo numérico (aunque "promptTokens" contenga
  // "token") y el resto de campos no sensibles, tal cual.
  assert.strictEqual(out.costBreakdown.promptTokens, 321);
  assert.strictEqual(out.name, 'Konk');
  assert.strictEqual(out.model.model, 'gpt-4o-mini');
  assert.strictEqual(out.firstMessage, 'Hola, Konk Hostel');
  assert.strictEqual(out.model.messages[0].content, 'PROMPT DE VERDAD');
  assert.strictEqual(out.customer.number, '+34600000000');
  assert.strictEqual(out.status, 'ended');
  assert.strictEqual(out.transcript, 'AI: hola\nUser: hola');
  assert.strictEqual(out.createdAt, '2026-09-24T10:00:00.000Z');
  assert.strictEqual(out.credentials[0].provider, 'openai');
  assert.strictEqual(out.transcriber.provider, 'deepgram');

  const raw = JSON.stringify(out);
  ['MARCADOR-CS', 'MARCADOR-PK', 'MARCADOR-WHS', 'MARCADOR-BT', 'MARCADOR-AT', 'MARCADOR-CRED-AK', 'MARCADOR-TRANS-AK'].forEach((m) => {
    assert.ok(!raw.includes(m), `${m} debería haberse redactado`);
  });
});

t('NO toca campos numéricos ni claves que solo "contienen" la palabra (tokens, promptTokens)', () => {
  const obj = { promptTokens: 123, tokens: 456, cost: { promptTokens: 12, completionTokens: 34 } };
  const out = redactDeep(obj);
  assert.strictEqual(out.promptTokens, 123);
  assert.strictEqual(out.tokens, 456);
  assert.strictEqual(out.cost.promptTokens, 12);
  assert.strictEqual(out.cost.completionTokens, 34);
});

t('no muta el objeto original', () => {
  const asst = { server: { headers: { 'x-vapi-secret': 'MARCADOR-4' } }, model: { tools: [{ server: { secret: 'MARCADOR-5' } }] } };
  const clone = JSON.parse(JSON.stringify(asst));
  const out = redactDeep(asst);
  assert.deepStrictEqual(asst, clone, 'el objeto original no debe cambiar');
  assert.notStrictEqual(out, asst, 'debe devolver un objeto nuevo, no el mismo');
  assert.notStrictEqual(out.server, asst.server, 'debe clonar en profundidad, no solo el nivel superior');
});

t('un array de llamadas (listCalls) redacta cada elemento sin perder los demás campos', () => {
  const calls = [
    { id: 'c1', cost: 0.123, monitor: { listenUrl: 'MARCADOR-6' } },
    { id: 'c2', cost: 0.456 },
  ];
  const out = redactDeep(calls);
  assert.strictEqual(out[0].monitor.listenUrl, REDACTED);
  assert.strictEqual(out[0].cost, 0.123);
  assert.strictEqual(out[1].id, 'c2');
  assert.strictEqual(out[1].cost, 0.456);
});

t('valores no-string en claves sensibles se dejan tal cual', () => {
  const obj = { secret: null, token: 42, password: undefined };
  const out = redactDeep(obj);
  assert.strictEqual(out.secret, null);
  assert.strictEqual(out.token, 42);
  assert.strictEqual(out.password, undefined);
});

t('primitivos sueltos (string/number/null) pasan a través de redactDeep sin reventar', () => {
  assert.strictEqual(redactDeep('hola'), 'hola');
  assert.strictEqual(redactDeep(42), 42);
  assert.strictEqual(redactDeep(null), null);
  assert.strictEqual(redactDeep(undefined), undefined);
});

console.log(`\n${'='.repeat(40)}\n${pasan} OK, ${fallan} fallos`);
process.exit(fallan > 0 ? 1 : 0);
