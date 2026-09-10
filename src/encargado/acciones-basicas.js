// src/encargado/acciones-basicas.js
// Las acciones que no pueden romper nada: silenciar avisos y lanzar
// revisiones. Se registran en el catálogo al cargar el módulo.
'use strict';

const { registrar } = require('./acciones');
const { AGENTES } = require('./config');
const { plural } = require('./parte');
const { hoyISO } = require('./reloj');
const estado = require('./estado');
const temas = require('./temas');
const { send } = require('../telegram');

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nombreDe(agente) {
  return AGENTES[agente] ? AGENTES[agente].nombre : agente;
}

// ─── silenciar los avisos de un agente ───────────────────────────────────────
registrar('silenciar_avisos', {
  riesgo: 'ninguno',
  descripcion: 'Deja de avisar de que un agente no ha corrido, durante unos días.'
    + ' Para cuando ya sabes por qué está parado y no quieres el recordatorio.',
  parametros: {
    agente: `cuál: ${Object.keys(AGENTES).join(' o ')}`,
    dias: 'cuántos días de silencio (por defecto 1)',
  },
  async resumen({ agente, dias }) {
    if (!AGENTES[agente]) {
      return { imposible: true, motivo: `No tengo ningún agente llamado "${agente}".`
        + ` Los que hay son: ${Object.keys(AGENTES).join(', ')}.` };
    }
    const n = Math.max(1, Math.min(30, Number(dias) || 1));
    return `🔕 Callarme sobre ${nombreDe(agente)} durante ${plural(n, 'día', 'días')},`
      + ` hasta el ${sumarDias(hoyISO(), n)}.`
      + `\nSeguirá corriendo igual: solo dejo de darte la lata si no lo hace.`;
  },
  async ejecutar({ agente, dias }) {
    const n = Math.max(1, Math.min(30, Number(dias) || 1));
    const hasta = sumarDias(hoyISO(), n);
    estado.guardarSilencio(agente, hasta);
    return `🔕 De acuerdo. No te digo nada de ${nombreDe(agente)} hasta el ${hasta}.`;
  },
});

// ─── volver a hablar ─────────────────────────────────────────────────────────
registrar('reactivar_avisos', {
  riesgo: 'ninguno',
  descripcion: 'Vuelve a avisar de un agente que estaba silenciado.',
  parametros: { agente: `cuál: ${Object.keys(AGENTES).join(' o ')}` },
  async resumen({ agente }) {
    if (!AGENTES[agente]) {
      return { imposible: true, motivo: `No tengo ningún agente llamado "${agente}".` };
    }
    const hasta = estado.leerSilencio(agente);
    if (!hasta) return { imposible: true, motivo: `${nombreDe(agente)} no está silenciado.` };
    return `🔔 Volver a avisarte de ${nombreDe(agente)} (estaba callado hasta el ${hasta}).`;
  },
  async ejecutar({ agente }) {
    estado.guardarSilencio(agente, null);
    return `🔔 Hecho. Vuelvo a avisarte si ${nombreDe(agente)} no corre.`;
  },
});

// ─── revisar cobros y contarlo en el grupo ───────────────────────────────────
registrar('revisar_cobros_y_avisar', {
  riesgo: 'ninguno',
  descripcion: 'Lanza una revisión de cobros AHORA y publica el resultado en el'
    + ' carril de Cobros del grupo. No cambia nada: solo mira y cuenta.',
  parametros: {},
  async resumen() {
    return '💰 Revisar los cobros ahora y publicar lo que salga en el grupo.';
  },
  async ejecutar() {
    const r = await require('../vigilante').ejecutar({ enviar: false, todo: true });
    const texto = r.mensaje || '💰 Revisados los cobros: todo cuadra, nada que reclamar.';
    await send(texto, { threadId: temas.idDe('COBROS') });
    return r.mensaje
      ? `Publicado en 💰 Cobros: ${r.escapados} sin cobrar, ${r.parciales} parciales,`
        + ` ${r.dobles} de más.`
      : 'Publicado en 💰 Cobros: todo cuadra.';
  },
});

module.exports = {};
