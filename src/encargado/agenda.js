// src/encargado/agenda.js
// Cuándo habla el encargado: el parte de la mañana y el refresco del
// mensaje de ESTADO fijado.
'use strict';

const temas = require('./temas');
const { partes, aMinutos } = require('./reloj');
const estado = require('./estado');
const { recolectar } = require('./recolector');
const { estadoFijado, parteDiario } = require('./parte');
const { send, edit, pin } = require('../telegram');

const HORA_PARTE = process.env.ENCARGADO_HORA_PARTE || '09:15';

/**
 * Refresca el mensaje fijado. Lo edita en sitio; si no existe todavía
 * (o lo borraron), lo crea y lo fija.
 */
async function refrescarEstado(foto) {
  const texto = estadoFijado(foto);
  const guardado = estado.leerFijado();
  const hilo = temas.idDe('ESTADO');

  // Si el carril ha cambiado (por ejemplo, se acaban de crear los temas y
  // el fijado seguía en General), no vale con editarlo: hay que ponerlo
  // donde toca. Un mensaje no se puede mover de tema.
  const cambioDeCarril = guardado
    && Number(guardado.hilo || 0) !== Number(hilo || 0);

  if (guardado && guardado.messageId && !cambioDeCarril) {
    const r = await edit(guardado.messageId, texto);
    if (r !== null) return { accion: 'editado', messageId: guardado.messageId };
    // edit() devuelve null tanto si no cambió nada como si falló.
    // Comprobamos si el mensaje sigue existiendo intentando fijarlo.
    if (await pin(guardado.messageId)) {
      return { accion: 'sin-cambios', messageId: guardado.messageId };
    }
  }

  const msg = await send(texto, { threadId: hilo });
  if (!msg) return { accion: 'fallo', messageId: null };
  await pin(msg.message_id);
  estado.guardarFijado(msg.message_id, hilo);
  return { accion: cambioDeCarril ? 'rehecho en su carril' : 'creado', messageId: msg.message_id };
}

/** Manda el parte del día y deja el ESTADO al día. */
async function emitirParte({ notificar = true } = {}) {
  const foto = await recolectar();
  const texto = parteDiario(foto);
  let enviado = null;
  if (notificar) {
    enviado = await send(texto, { threadId: temas.idDe('PARTE') });
    await refrescarEstado(foto);
  }
  return { foto, texto, enviado: Boolean(enviado) };
}

/**
 * Reloj del encargado: comprueba cada 10 min si toca el parte, y refresca
 * el ESTADO fijado una vez por hora para que no envejezca.
 */
// Cuánto puede retrasarse el parte y seguir teniendo sentido. Si el
// servidor arranca por la tarde, el "parte de la mañana" ya no se manda:
// llegaría a deshora y solo sería ruido.
const VENTANA_PARTE_MIN = 180;

function arrancar() {
  const CADA = 10 * 60 * 1000;
  let ultimoRefresco = null; // 'YYYY-MM-DD HH'

  const tick = async () => {
    try {
      const ahora = partes();
      const horaParte = aMinutos(HORA_PARTE);
      const dentroDeVentana = ahora.minutos >= horaParte
        && ahora.minutos < horaParte + VENTANA_PARTE_MIN;

      // El parte, una vez al día. La marca va en disco para que un
      // redespliegue no lo mande dos veces.
      const clave = `parte:${ahora.iso}`;
      if (dentroDeVentana && !estado.yaAvisado(clave)) {
        estado.marcarAvisado(clave);      // se marca antes: si falla, no insiste
        await emitirParte();
        console.log(`[Encargado] Parte del día enviado (${ahora.iso})`);
        return;
      }

      // Refresco del fijado, una vez por hora, en horario despierto.
      const franja = `${ahora.iso} ${ahora.hora.slice(0, 2)}`;
      if (ultimoRefresco !== franja && ahora.minutos >= horaParte) {
        ultimoRefresco = franja;
        await refrescarEstado(await recolectar());
      }
    } catch (err) {
      console.error('[Encargado] Fallo en la agenda:', err.message);
    }
  };

  setTimeout(tick, 60 * 1000);
  const t = setInterval(tick, CADA);
  if (t.unref) t.unref();
  return t;
}

module.exports = { arrancar, emitirParte, refrescarEstado, HORA_PARTE, VENTANA_PARTE_MIN };
