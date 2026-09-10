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

// Los temas del grupo viven en temas.js: se crean por API y sus ids se
// guardan en disco, así que no pueden ser una constante leída del entorno.

module.exports = { TZ, AGENTES };
