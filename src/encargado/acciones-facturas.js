// src/encargado/acciones-facturas.js
// Emitir el lote de facturas del Konk desde Telegram.
//
// El facturador vive en el Mac, así que esto no emite nada por sí mismo:
// deja la orden en la cola y el Mac la recoge. Lo que SÍ se puede hacer
// desde aquí es enseñar el lote antes de decidir, porque el facturador ya
// manda en su latido cuántas facturas hay y por cuánto.
'use strict';

const { registrar } = require('./acciones');
const { plural } = require('./parte');
const ordenes = require('./ordenes');
const estado = require('./estado');

function eur(n) {
  return new Intl.NumberFormat('es-ES',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0) + ' €';
}

/** Lo que sabemos del lote pendiente, según el último latido del facturador. */
function loteSegunElLatido() {
  const l = estado.ultimoLatido('facturador-konk');
  if (!l) return { hay: false, motivo: 'El facturador no ha dado señales todavía.' };
  if (!l.ok) return { hay: false, motivo: `La última vez el facturador falló: ${l.resumen}` };
  const d = l.detalle;
  if (!d || !d.listas) {
    return { hay: false, motivo: `La última vez no había nada que facturar (${l.resumen}).` };
  }
  const yaEmitido = estado.leerLoteEmitido();
  if (yaEmitido && yaEmitido.periodo === d.periodo) {
    return {
      hay: false,
      motivo: `Ese lote (${d.periodo}) ya se emitió el`
        + ` ${yaEmitido.cuando.slice(0, 10)}. Si hay uno nuevo, el facturador`
        + ' lo preparará el lunes.',
    };
  }
  return { hay: true, ...d, cuando: l.ts };
}

registrar('emitir_lote', {
  riesgo: 'alto',
  descripcion: 'Emite el lote de facturas que el facturador dejó preparado.'
    + ' Las facturas se numeran de verdad: no se puede deshacer.',
  parametros: {},
  async resumen() {
    const lote = loteSegunElLatido();
    if (!lote.hay) return { imposible: true, motivo: lote.motivo };

    const partes = [
      `🧾 Emitir el lote del periodo ${lote.periodo}:`,
      ``,
      `   · ${plural(lote.listas, 'factura', 'facturas')} por ${eur(lote.total)}`,
    ];
    if (lote.revisar) {
      partes.push(`   · ${plural(lote.revisar, 'reserva apartada', 'reservas apartadas')}`
        + ` para revisión: esas NO se emiten`);
    }
    partes.push(
      ``,
      `Preparado el ${lote.cuando.slice(0, 10)}.`,
      `Las facturas se numeran y se guardan los PDF. Eso no se deshace.`,
      `Se lo mando al Mac; si está apagado, esperará a que lo enciendas.`,
    );
    return partes.join('\n');
  },
  async ejecutar() {
    const lote = loteSegunElLatido();
    if (!lote.hay) return `Ya no se puede: ${lote.motivo}`;
    const o = ordenes.crear('emitir_lote', { periodo: lote.periodo });
    return `🧾 Encargo hecho (orden ${o.id}). El Mac lo recoge en unos minutos`
      + ` y te cuento aquí cómo ha ido.`;
  },
});

registrar('preparar_lote', {
  riesgo: 'medio',
  descripcion: 'Pide al facturador que prepare el lote de la semana. No emite'
    + ' ni numera nada: solo lo deja listo para revisarlo.',
  parametros: {},
  async resumen() {
    return '📋 Pedir al facturador que prepare el lote de la semana pasada.'
      + '\nNo numera ni emite nada: solo lo deja listo para que lo mires.';
  },
  async ejecutar() {
    const o = ordenes.crear('preparar_lote', {});
    return `📋 Encargo hecho (orden ${o.id}). El Mac lo recoge en unos minutos.`;
  },
});

module.exports = { loteSegunElLatido };
