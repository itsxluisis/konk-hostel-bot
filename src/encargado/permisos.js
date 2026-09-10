// src/encargado/permisos.js
// ¿Qué nos deja hacer Cloudbeds de verdad?
//
// Los scopes que pide la app no garantizan lo que el token concede. Esto lo
// comprueba PREGUNTANDO, pero sin escribir nada: cada prueba usa un id que no
// existe, así que lo más que puede pasar es que Cloudbeds diga "no encuentro
// esa reserva". Un 403 significa que falta permiso; un 400/404 significa que
// el permiso está y lo que falla son los datos.
//
// No acepta parámetros de fuera: las pruebas son estas y no otras.
'use strict';

const { api } = require('../cloudbeds');

const IMPOSIBLE = '000000000000000';   // id que no existe en ninguna propiedad

const PRUEBAS = [
  {
    clave: 'modificar_reserva',
    que: 'Ampliar o cambiar una reserva',
    metodo: 'POST', ruta: '/putReservation',
    datos: { reservationID: IMPOSIBLE },
  },
  {
    clave: 'bloquear_habitacion',
    que: 'Bloquear o desbloquear una cama',
    metodo: 'POST', ruta: '/postRoomBlock',
    datos: { roomID: IMPOSIBLE, startDate: '2000-01-01', endDate: '2000-01-02' },
  },
  {
    clave: 'registrar_pago',
    que: 'Registrar un cobro',
    metodo: 'POST', ruta: '/postPayment',
    datos: { reservationID: IMPOSIBLE, amount: 0 },
  },
  {
    clave: 'nota_en_reserva',
    que: 'Dejar una nota en una reserva',
    metodo: 'POST', ruta: '/postReservationNote',
    datos: { reservationID: IMPOSIBLE, note: '' },
  },
];

function interpretar(err) {
  const status = err.response?.status;
  const cuerpo = err.response?.data;
  const mensaje = (cuerpo?.message || cuerpo?.error || '').toString();

  if (status === 403 || /scope|permission|unauthorized/i.test(mensaje)) {
    return { permitido: false, motivo: 'falta permiso (scope)' };
  }
  if (status === 404 && /not found|no route|endpoint/i.test(mensaje)) {
    return { permitido: null, motivo: 'ese endpoint no existe con ese nombre' };
  }
  // Nos ha dejado entrar y se ha quejado de los datos: el permiso está.
  if (status === 400 || status === 404 || status === 422) {
    return { permitido: true, motivo: 'acepta la llamada; falla por los datos de prueba' };
  }
  return { permitido: null, motivo: `respuesta inesperada (${status || 'sin código'})` };
}

async function comprobar() {
  const salida = [];
  for (const p of PRUEBAS) {
    try {
      const r = await api(p.metodo, p.ruta, p.datos);
      // Que salga bien con un id imposible sería rarísimo; se anota tal cual.
      salida.push({ ...p, datos: undefined, permitido: true,
        motivo: 'respondió sin error', crudo: JSON.stringify(r).slice(0, 200) });
    } catch (err) {
      const i = interpretar(err);
      salida.push({
        clave: p.clave, que: p.que, ruta: p.ruta,
        ...i,
        codigo: err.response?.status || null,
        dijo: (err.response?.data?.message || err.message || '').toString().slice(0, 200),
      });
    }
  }
  return salida;
}

module.exports = { comprobar, PRUEBAS };
