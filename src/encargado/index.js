// src/encargado/index.js
// Punto de entrada del Encargado del Konk.
//
// Se monta sobre el servidor existente sin tocar nada del flujo de voz:
//   const encargado = require('./encargado');
//   encargado.montar(app);
//
// Si el encargado falla al arrancar, el servidor sigue igual que antes.
'use strict';

const router = require('./latidos');
const vigilancia = require('./vigilancia');
const agenda = require('./agenda');
const escucha = require('./escucha');

function montar(app) {
  try {
    app.use('/encargado', router);
    vigilancia.arrancar();
    agenda.arrancar();
    // Escuchar por sondeo salvo que se prefiera webhook (ENCARGADO_ESCUCHA=webhook).
    if ((process.env.ENCARGADO_ESCUCHA || 'sondeo') === 'sondeo') escucha.arrancarSondeo();
    console.log('🧑‍💼 Encargado del Konk montado en /encargado');
  } catch (err) {
    console.error('[Encargado] No se pudo montar (el resto sigue OK):', err.message);
  }
}

/**
 * El carril al que mandar un mensaje. Pensada para que el resto del
 * servidor la use sin acoplarse al encargado: si algo falla aquí,
 * devuelve null y el mensaje cae en General, como siempre.
 */
function hilo(clave) {
  try {
    return require('./temas').idDe(clave);
  } catch {
    return null;
  }
}

module.exports = { montar, hilo };
