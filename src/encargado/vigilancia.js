// src/encargado/vigilancia.js
// El encargado vigila a los demás agentes: si uno no da señales de vida
// en su ventana, avisa EL MISMO DÍA.
'use strict';

const { AGENTES } = require('./config');
const temas = require('./temas');
const { partes, aMinutos, humano } = require('./reloj');
const estado = require('./estado');
const { send } = require('../telegram');

/**
 * ¿Se esperaba a este agente hoy, y ya se le ha pasado el plazo?
 */
function plazoVencido(cfg, ahora) {
  if (!cfg.dias.includes(ahora.dia)) return false;
  return ahora.minutos >= aMinutos(cfg.horaEsperada) + cfg.margenMin;
}

/**
 * Decisión pura: ¿hay que dar la alarma por este agente?
 * Sin relojes ni disco — así se puede probar de verdad.
 *
 * @param {object} cfg      configuración del agente
 * @param {object} ahora    {iso, minutos, dia} momento actual en Madrid
 * @param {object} arranque {iso, minutos} arranque del proceso, en Madrid
 * @param {object|null} latido último latido registrado ({ts}) o null
 * @returns {{alerta: boolean, motivo: string}}
 */
function debeAlertar(cfg, ahora, arranque, latido) {
  if (!cfg.dias.includes(ahora.dia)) {
    return { alerta: false, motivo: 'hoy no se le espera' };
  }
  const limite = aMinutos(cfg.horaEsperada) + cfg.margenMin;
  if (ahora.minutos < limite) {
    return { alerta: false, motivo: 'aún está dentro de plazo' };
  }
  if (latido && latido.ts.slice(0, 10) === ahora.iso) {
    return { alerta: false, motivo: 'ya ha latido hoy' };
  }
  // Si arrancamos después de que venciera el plazo, no podemos saber si
  // latió mientras estábamos caídos. Callar es mejor que un falso positivo.
  if (arranque.iso === ahora.iso && arranque.minutos > limite) {
    return { alerta: false, motivo: 'arrancamos tarde, sin datos de la ventana' };
  }
  return { alerta: true, motivo: 'plazo vencido sin latido' };
}

/** ¿Ha latido hoy? */
function latioHoy(agente, hoyISO) {
  const l = estado.ultimoLatido(agente);
  if (!l) return false;
  return l.ts.slice(0, 10) === hoyISO;
}

/**
 * Revisa a todos los agentes. Devuelve las alertas que ha emitido.
 * Idempotente: no repite el mismo aviso dos veces el mismo día.
 */
async function revisar({ notificar = true } = {}) {
  const ahora = partes();
  const emitidas = [];

  const arranque = partes(estado.ARRANQUE);

  for (const [id, cfg] of Object.entries(AGENTES)) {
    const { alerta } = debeAlertar(cfg, ahora, arranque, estado.ultimoLatido(id));
    if (!alerta) continue;
    // Si lo hemos silenciado a propósito, se calla y no cuenta como aviso.
    const callado = estado.leerSilencio(id);
    if (callado) continue;

    const clave = `caido:${id}:${ahora.iso}`;
    if (estado.yaAvisado(clave)) continue;

    const ultimo = estado.ultimoLatido(id);
    const texto = [
      `⚠️ ${cfg.nombre} no ha dado señales hoy.`,
      ``,
      `Se le esperaba a las ${cfg.horaEsperada} — ${cfg.que}.`,
      ultimo
        ? `Última vez que corrió: ${humano(new Date(ultimo.ts))}.`
        : `No consta ninguna ejecución previa.`,
      ``,
      `Si el Mac estaba apagado, no pasa nada: lánzalo y vuelve a la normalidad.`,
    ].join('\n');

    if (notificar) {
      await send(texto, { threadId: temas.idDe('ALERTAS') });
      estado.marcarAvisado(clave);
    }
    emitidas.push({ agente: id, texto });
  }

  return emitidas;
}

/**
 * Arranca la vigilancia. Comprueba cada 10 minutos: barato y suficiente
 * para avisar dentro del mismo día.
 */
function arrancar() {
  const CADA = 10 * 60 * 1000;
  const tick = async () => {
    try {
      await revisar();
    } catch (err) {
      // El encargado nunca puede tumbar el bot de voz.
      console.error('[Encargado] Fallo en la vigilancia:', err.message);
    }
  };
  setTimeout(tick, 30 * 1000);        // primer chequeo 30 s tras arrancar
  const t = setInterval(tick, CADA);
  if (t.unref) t.unref();
  return t;
}

module.exports = { revisar, arrancar, plazoVencido, latioHoy, debeAlertar };
