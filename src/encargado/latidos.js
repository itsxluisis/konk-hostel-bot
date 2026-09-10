// src/encargado/latidos.js
// Router del encargado. Aislado del resto del servidor: si algo falla aquí,
// el bot de voz sigue atendiendo llamadas.
'use strict';

const express = require('express');
const { AGENTES, TEMAS } = require('./config');
const { humano } = require('./reloj');
const estado = require('./estado');
const vigilancia = require('./vigilancia');
const agenda = require('./agenda');
const escucha = require('./escucha');
const cerebro = require('./cerebro');
const { send } = require('../telegram');

const router = express.Router();

// Mismo secreto que el resto del servidor (VAPI_SECRET), por cabecera o body.
function auth(req, res, next) {
  const secreto = process.env.ENCARGADO_SECRET || process.env.VAPI_SECRET;
  if (!secreto) return res.status(503).json({ error: 'Encargado sin secreto configurado' });
  const dado = (req.headers['x-encargado-secret']
    || req.headers['x-vapi-secret']
    || (req.headers.authorization || '').replace('Bearer ', '')
    || req.body?.secreto || '').trim();
  if (dado !== secreto) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/**
 * POST /encargado/latido
 * Body: { agente, ok, resumen, detalle }
 * Un agente dice "he corrido y esto es lo que ha pasado".
 */
router.post('/latido', auth, async (req, res) => {
  const { agente, ok = true, resumen = '', detalle = null } = req.body || {};
  if (!agente || !AGENTES[agente]) {
    return res.status(400).json({
      error: 'Agente desconocido',
      conocidos: Object.keys(AGENTES),
    });
  }

  const l = estado.registrarLatido(agente, { ok, resumen, detalle });
  const cfg = AGENTES[agente];
  console.log(`[Encargado] Latido de ${agente} · ok=${l.ok} · ${resumen}`);

  // Solo molestamos si el agente dice que algo fue mal. Si fue bien,
  // queda registrado y sale en el parte — no genera aviso suelto.
  if (!l.ok) {
    const texto = [
      `⚠️ ${cfg.nombre} ha terminado con error.`,
      ``,
      resumen || 'Sin detalle.',
    ].join('\n');
    await send(texto, { threadId: TEMAS[cfg.tema] || TEMAS.ALERTAS });
  }

  res.json({ ok: true, registrado: l.ts });
});

/**
 * GET /encargado/estado
 * Cómo está el equipo ahora mismo. Para el panel y para depurar.
 */
router.get('/estado', auth, (req, res) => {
  const latidos = estado.todosLosLatidos();
  const equipo = Object.entries(AGENTES).map(([id, cfg]) => {
    const l = latidos[id] || null;
    return {
      id,
      nombre: cfg.nombre,
      esperado: `${cfg.dias.join(',')} @ ${cfg.horaEsperada}`,
      ultimo: l ? l.ts : null,
      ultimoHumano: l ? humano(new Date(l.ts)) : 'nunca',
      ok: l ? l.ok : null,
      resumen: l ? l.resumen : null,
    };
  });
  res.json({
    ok: true,
    arranque: estado.ARRANQUE.toISOString(),
    fijado: estado.leerFijado(),   // el mensaje de ESTADO anclado en el grupo
    equipo,
  });
});

/**
 * POST /encargado/revisar
 * Fuerza una revisión ahora (para probar sin esperar al reloj).
 * ?seco=1 → calcula pero no envía nada a Telegram.
 */
router.post('/revisar', auth, async (req, res) => {
  const seco = req.query.seco === '1' || req.body?.seco === true;
  const alertas = await vigilancia.revisar({ notificar: !seco });
  res.json({ ok: true, seco, alertas });
});

/**
 * POST /encargado/parte
 * Genera el parte del día. Con ?seco=1 lo devuelve sin enviarlo a Telegram,
 * que es como se prueba sin molestar a nadie.
 */
router.post('/parte', auth, async (req, res) => {
  const seco = req.query.seco === '1' || req.body?.seco === true;
  try {
    const r = await agenda.emitirParte({ notificar: !seco });
    res.json({
      ok: true, seco, enviado: r.enviado, texto: r.texto,
      datos: {
        huespedes: r.foto.huespedes,
        llegadas: r.foto.llegadas.length,
        salidas: r.foto.salidas.length,
        fallos: r.foto.fallos,
        // En seco devolvemos las listas crudas: sirve para comprobar que
        // los filtros de Cloudbeds hacen lo que creemos.
        detalle: seco ? { llegadas: r.foto.llegadas, salidas: r.foto.salidas } : undefined,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Escucha de Telegram (F2) ────────────────────────────────────────────────

/** El secreto con el que Telegram firma cada aviso. */
function secretoTelegram() {
  return process.env.ENCARGADO_TG_SECRET
    || process.env.ENCARGADO_SECRET
    || process.env.VAPI_SECRET;
}

/**
 * POST /encargado/telegram
 * Aquí avisa Telegram cuando alguien escribe en el grupo. No lleva nuestra
 * autenticación normal: Telegram no la conoce. Firma con su propia cabecera.
 *
 * Siempre se responde 200, incluso si algo falla: si devolvemos error,
 * Telegram reintenta en bucle y acaba desactivando el webhook.
 */
router.post('/telegram', async (req, res) => {
  const firma = req.headers['x-telegram-bot-api-secret-token'];
  if (!secretoTelegram() || firma !== secretoTelegram()) {
    // Ni pistas a quien llame a esta puerta sin la llave.
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });   // se contesta ya; el trabajo va después

  try {
    const r = await escucha.procesar(req.body);
    if (r.accion !== 'ignorado') console.log('[Encargado] Telegram:', JSON.stringify(r));
  } catch (err) {
    console.error('[Encargado] Fallo procesando Telegram:', err.message);
  }
});

/**
 * POST /encargado/registrar-escucha
 * Le dice a Telegram dónde avisarnos. Se llama una vez.
 * Body opcional: { url } — si no, se deduce de la petición.
 */
router.post('/registrar-escucha', auth, async (req, res) => {
  try {
    const base = req.body?.url
      || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const r = await escucha.registrar(base, secretoTelegram());
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data?.description || err.message });
  }
});

/** GET /encargado/escucha — cómo está la oreja y si hay cerebro. */
router.get('/escucha', auth, async (req, res) => {
  try {
    res.json({
      ok: true,
      cerebro: cerebro.hayCerebro() ? cerebro.MODELO : 'sin ANTHROPIC_API_KEY (modo palabras clave)',
      modo: process.env.ENCARGADO_ESCUCHA || 'sondeo',
      sondeo: escucha.estadoSondeo(),
      webhook: await escucha.estadoEscucha(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /encargado/preguntar — probar una pregunta sin pasar por Telegram. */
router.post('/preguntar', auth, async (req, res) => {
  const p = req.body?.pregunta || req.query.q;
  if (!p) return res.status(400).json({ ok: false, error: 'Falta la pregunta' });
  try {
    res.json({ ok: true, pregunta: p, respuesta: await cerebro.responder(p) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
