// src/encargado/latidos.js
// Router del encargado. Aislado del resto del servidor: si algo falla aquí,
// el bot de voz sigue atendiendo llamadas.
'use strict';

const express = require('express');
const { AGENTES } = require('./config');
const temas = require('./temas');
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
    await send(texto, { threadId: temas.idDe(cfg.tema) || temas.idDe('ALERTAS') });
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
    const r = await cerebro.responder(p);
    res.json({
      ok: true, pregunta: p, respuesta: r.texto,
      // Si la respuesta es una propuesta de acción, se ve aquí sin ejecutarla.
      propuesta: r.botones ? r.botones[0].map(b => b.callback_data) : undefined,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Temas del grupo ─────────────────────────────────────────────────────────

/** GET /encargado/temas — qué carriles hay y a dónde va cada cosa. */
router.get('/temas', auth, async (req, res) => {
  try {
    res.json({ ok: true, grupo: await temas.estadoDelGrupo(), carriles: temas.listar() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data?.description || err.message,
      carriles: temas.listar(),
    });
  }
});

/**
 * POST /encargado/temas — crea los carriles que falten.
 * ?rehacer=1 los crea todos de nuevo (deja los viejos huérfanos: usar con tino).
 */
router.post('/temas', auth, async (req, res) => {
  try {
    const r = await temas.crear({ soloFaltantes: req.query.rehacer !== '1' });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data?.description || err.message });
  }
});

// ─── Acciones (F3) ───────────────────────────────────────────────────────────

/** GET /encargado/acciones — qué sabe hacer y si hay jefe configurado. */
router.get('/acciones', auth, (req, res) => {
  const acciones = require('./acciones');
  require('./acciones-basicas');
  res.json({
    ok: true,
    jefeConfigurado: acciones.hayJefe(),
    vidaPropuestaMin: acciones.VIDA_MIN,
    acciones: Object.values(acciones.ACCIONES).map(a => ({
      nombre: a.nombre, riesgo: a.riesgo, descripcion: a.descripcion,
    })),
  });
});

/**
 * POST /encargado/jefe — quién puede confirmar acciones.
 * Body: { ids: [123, 456] }. Requiere el secreto del servidor, así que
 * no se puede hacer desde el chat: hay que tener acceso al backend.
 */
router.post('/jefe', auth, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ ok: false, error: 'Manda { "ids": [...] }' });
  }
  estado.guardarJefes(ids);
  const acciones = require('./acciones');
  res.json({ ok: true, jefes: acciones.jefes(), fuente: process.env.ENCARGADO_JEFE_ID
    ? 'la variable de entorno manda sobre esto' : 'guardado en disco' });
});

/** GET /encargado/quien-escribe — ids vistos, para saber cuál es el de Luis. */
router.get('/quien-escribe', auth, (req, res) => {
  res.json({ ok: true, vistos: escucha.quienEscribe() });
});

/**
 * POST /encargado/acciones/:nombre
 * Lanza una acción sin pasar por Telegram. Es una vía ADMINISTRATIVA: exige
 * el secreto del servidor, que no está en el grupo ni al alcance de nadie
 * que solo tenga el chat. Sirve para operar y para probar.
 *
 * Por defecto solo PROPONE. Hay que pedir ?ejecutar=1 explícitamente, y así
 * el camino corto sigue siendo un acto deliberado, no un descuido.
 */
router.post('/acciones/:nombre', auth, async (req, res) => {
  const acciones = require('./acciones');
  require('./acciones-basicas');
  require('./acciones-facturas');
  try {
    const p = await acciones.proponer(req.params.nombre, req.body || {});
    if (p.imposible) return res.status(409).json({ ok: false, motivo: p.motivo });
    if (req.query.ejecutar !== '1') {
      return res.json({ ok: true, propuesta: p.id, texto: acciones.mensaje(p),
        nota: 'Solo propuesta. Añade ?ejecutar=1 para hacerlo de verdad.' });
    }
    const jefe = acciones.jefes()[0];
    if (!jefe) return res.status(409).json({ ok: false, error: 'No hay jefe configurado' });
    const r = await acciones.confirmar(p.id, jefe);
    res.status(r.ok ? 200 : 409).json({ ok: r.ok, texto: r.texto });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * GET /encargado/cloudbeds/permisos
 * Qué nos deja hacer Cloudbeds. No escribe nada: cada prueba usa un id
 * inexistente, así que lo peor que puede pasar es un "no lo encuentro".
 */
router.get('/cloudbeds/permisos', auth, async (req, res) => {
  try {
    res.json({ ok: true, pruebas: await require('./permisos').comprobar() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /encargado/cloudbeds/bloqueos — los bloqueos puestos, por fechas. */
router.get('/cloudbeds/bloqueos', auth, async (req, res) => {
  try {
    res.json({ ok: true, bloqueos: await require('./inventario').bloqueos({
      desde: req.query.desde, hasta: req.query.hasta }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

/** GET /encargado/cloudbeds/camas — el inventario real, para poder bloquear. */
router.get('/cloudbeds/camas', auth, async (req, res) => {
  const { api } = require('../cloudbeds');
  try {
    const r = await api('GET', '/getRooms', {});
    res.json({ ok: true, crudo: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

// ─── Órdenes para los agentes del Mac ────────────────────────────────────────

/**
 * GET /encargado/ordenes?agente=facturador-konk
 * El Mac pregunta si hay algo que hacer. Lo que devuelve queda marcado como
 * entregado, para que dos sondeos seguidos no hagan lo mismo dos veces.
 */
router.get('/ordenes', auth, (req, res) => {
  const ordenes = require('./ordenes');
  const agente = req.query.agente;
  if (!agente) return res.status(400).json({ ok: false, error: 'Falta ?agente=' });
  res.json({ ok: true, ordenes: ordenes.recoger(String(agente)) });
});

/**
 * POST /encargado/ordenes/:id/resultado
 * El Mac cuenta cómo ha ido, y se publica en el grupo.
 */
router.post('/ordenes/:id/resultado', auth, async (req, res) => {
  const ordenes = require('./ordenes');
  const temas = require('./temas');
  try {
    const { ok = false, salida = '' } = req.body || {};
    const o = ordenes.resultado(req.params.id, { ok, salida });

    // Un lote emitido se apunta para que no pueda emitirse otra vez.
    if (ok && o.tarea === 'emitir_lote' && o.args?.periodo) {
      estado.guardarLoteEmitido(o.args.periodo);
    }

    const titulo = o.tarea === 'emitir_lote'
      ? (ok ? '🧾 Lote emitido' : '❌ No se pudo emitir el lote')
      : (ok ? '📋 Lote preparado' : '❌ No se pudo preparar el lote');
    await send(`${titulo}\n\n${String(salida).slice(0, 3000)}`,
      { threadId: temas.idDe('FACTURAS') });

    res.json({ ok: true, orden: o });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** GET /encargado/ordenes/todas — las últimas, para mirar qué ha pasado. */
router.get('/ordenes/todas', auth, (req, res) => {
  const ordenes = require('./ordenes');
  res.json({ ok: true, ordenes: ordenes.listar(), olvidadas: ordenes.olvidadas().length });
});

module.exports = router;
