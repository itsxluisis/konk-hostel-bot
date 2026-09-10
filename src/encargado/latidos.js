// src/encargado/latidos.js
// Router del encargado. Aislado del resto del servidor: si algo falla aquí,
// el bot de voz sigue atendiendo llamadas.
'use strict';

const express = require('express');
const { AGENTES, TEMAS } = require('./config');
const { humano } = require('./reloj');
const estado = require('./estado');
const vigilancia = require('./vigilancia');
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
  res.json({ ok: true, arranque: estado.ARRANQUE.toISOString(), equipo });
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

module.exports = router;
