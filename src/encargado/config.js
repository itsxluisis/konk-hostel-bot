// src/encargado/config.js
// Quiénes son los agentes del Konk y cuándo se les espera.
'use strict';

const TZ = 'Europe/Madrid';

// dias: 0=domingo, 1=lunes ... 6=sábado
const AGENTES = {
  'facturador-konk': {
    nombre: 'Facturador Konk',
    que: 'prepara el lote semanal de facturas KH26',
    dias: [1],                 // lunes
    horaEsperada: '09:00',
    margenMin: 120,            // se le da 2 h antes de dar la alarma
    tema: 'FACTURAS',
  },
  'vigilante-cobros': {
    nombre: 'Vigilante de cobros',
    que: 'compara cobros Cloudbeds vs Booking',
    dias: [1, 2, 3, 4, 5, 6],  // L-S
    horaEsperada: '09:00',
    margenMin: 120,
    tema: 'COBROS',
  },
};

// Temas del grupo de Telegram. Se rellenan con los message_thread_id reales
// cuando el grupo tenga los temas creados. Vacío = cae en General (como hoy).
const TEMAS = {
  ESTADO:   process.env.TG_TEMA_ESTADO   || null,
  PARTE:    process.env.TG_TEMA_PARTE    || null,
  ALERTAS:  process.env.TG_TEMA_ALERTAS  || null,
  LLAMADAS: process.env.TG_TEMA_LLAMADAS || null,
  COBROS:   process.env.TG_TEMA_COBROS   || null,
  FACTURAS: process.env.TG_TEMA_FACTURAS || null,
  PREGUNTAR: process.env.TG_TEMA_PREGUNTAR || null,
};

module.exports = { TZ, AGENTES, TEMAS };
