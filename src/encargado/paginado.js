// src/encargado/paginado.js
// Cloudbeds pagina TODO lo que lista: reservas, habitaciones, bloqueos,
// transacciones. Una llamada suelta trae la primera página y nada más, y
// el error no se nota: los datos parecen completos, solo que faltan.
//
// Ya pasó una vez: 20 de 31 camas, y un dormitorio entero "no existía".
'use strict';

const { api } = require('../cloudbeds');

const TAM = 100;
const MAX_PAGINAS = 50;   // 5.000 registros: más que de sobra para el Konk

/**
 * Trae TODAS las páginas de un listado y devuelve los registros juntos.
 * `extraer` saca el array de cada respuesta (por defecto, r.data).
 */
async function todas(endpoint, params = {}, extraer = r => r?.data || []) {
  const salida = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await api('GET', endpoint, { ...params, pageNumber: pagina, pageSize: TAM });
    if (r && r.success === false) {
      throw new Error(r.message || `${endpoint} falló`);
    }
    const lote = extraer(r);
    salida.push(...lote);
    const total = Number(r?.total);
    if (lote.length < TAM) break;                       // última página
    if (Number.isFinite(total) && salida.length >= total) break;
  }
  return salida;
}

module.exports = { todas, TAM };
