// src/room-names.js
// Nombres de habitación de Cloudbeds: funciones PURAS (sin red ni Cloudbeds)
// para poder testearlas aisladas.
//
// El Konk renombró sus habitaciones en Cloudbeds el 30-sep-2026. Separador:
// punto medio "·" (U+00B7) con espacios a los lados.
//   Unidad (roomName):      "Hab 2 · Cama 3", "Hab 10 · Doble entrada indep."
//   Tipo (roomTypeName):    "Habitación 4 · Dormitorio mixto 6 camas"
// Antes eran "R2(3)", "Room 7", "Habitación Compartida/Privada 6"… Todo lo
// que dependa del formato del nombre tiene que pasar por aquí (o por
// src/encargado/inventario.js para el matcher de Telegram), no por regex
// sueltos repartidos por el código.
'use strict';

// "Habitación 4 · ", "Hab. 10 - ", "hab 2": el número de PUERTA al principio
// del nombre. No es una capacidad, y antes se colaba como dígito suelto.
const PREFIJO_NUMERO_PUERTA = /^\s*(?:habitaci[oó]n|hab\.?)\s*\d+\s*[·\-–—:]*\s*/i;

function enteroPositivo(texto) {
  const n = Number(texto);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Capacidad (camas) de un dormitorio a partir del NOMBRE DEL TIPO, o null si
 * el nombre no la dice. Solo se usa con tipos compartidos: maxGuests de
 * Cloudbeds no es fiable ahí.
 *
 * Orden: "<n> camas" (formato nuevo) → "<n> pax" (formato antiguo) → último
 * recurso, el dígito suelto 6/4/5 del nombre (formato antiguo sin número
 * explícito, p. ej. "Habitación Compartida/Privada 6"). En ese último recurso
 * se ignora el número de puerta del principio ("Habitación 4 · …"): con el
 * formato nuevo, el 4 de "Habitación 4" no dice nada de las camas.
 */
function capacidadDeTipo(nombreTipo) {
  const n = String(nombreTipo || '').normalize('NFC').toLowerCase();

  let m = n.match(/(\d+)\s*camas?\b/);
  if (m && enteroPositivo(m[1])) return enteroPositivo(m[1]);

  m = n.match(/(\d+)\s*pax\b/);
  if (m && enteroPositivo(m[1])) return enteroPositivo(m[1]);

  const sinPuerta = n.replace(PREFIJO_NUMERO_PUERTA, '');
  if (sinPuerta.includes('6')) return 6;
  if (sinPuerta.includes('4')) return 4;
  if (sinPuerta.includes('5')) return 5;
  return null;
}

// ─── Voz ─────────────────────────────────────────────────────────────────────
// Un TTS lee "Hab 2 · Cama 3" como algo raro ("hab dos punto medio cama
// tres"). Esto lo convierte en algo que se pueda decir tal cual. SOLO para lo
// que va a voz (Vapi): en Telegram el nombre se queda como lo da Cloudbeds.

// "Hab 10", "Habitación 4", "Hab. 3", y el "Room 7" antiguo, con lo que
// venga detrás del separador opcional.
const NOMBRE_CON_PUERTA = /^(?:habitaci[oó]n|hab\.?|room)\s*(\d+)\s*(?:[·\-–—:]\s*)?(.*)$/i;

function descriptorParaVoz(descriptor) {
  let s = String(descriptor || '').replace(/\s+/g, ' ').trim().toLowerCase();

  s = s.replace(/\bindep\b\.?/g, 'independiente');
  s = s.replace(/\bdoble entrada\b/g, 'doble con entrada');
  s = s.replace(/\blitera (?:de )?matrimonio\b/g, 'litera de matrimonio');
  // "2-4 pax" / "2 ó 4 pax" / "4 pax": se dice en personas, no en "pax".
  s = s.replace(/(\d+)\s*[-–—]\s*(\d+)\s*pax\b/g, 'para $1 a $2 personas');
  s = s.replace(/(\d+)\s*[óo]\s*(\d+)\s*pax\b/g, 'para $1 o $2 personas');
  s = s.replace(/(\d+)\s*pax\b/g, 'para $1 personas');
  // "dormitorio mixto 6 camas" → "dormitorio mixto de 6 camas"
  s = s.replace(/\b(dormitorio(?:\s+[a-záéíóúüñ]+)?)\s+(\d+)\s+camas\b/g, '$1 de $2 camas');
  // Así se dice siempre (vapi/system-prompt.md): "adaptada y accesible".
  s = s.replace(/\badaptada\b(?!\s+y\s+accesible)/g, 'adaptada y accesible');

  return s.replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Nombre de habitación (unidad o tipo) → texto para decir por teléfono.
 *   "Hab 2 · Cama 3"                          → "habitación 2, cama 3"
 *   "Hab 10 · Doble entrada indep."           → "habitación 10, doble con entrada independiente"
 *   "Habitación 4 · Dormitorio mixto 6 camas" → "habitación 4, dormitorio mixto de 6 camas"
 * Un nombre que no sigue el patrón "Hab N · …" (formato antiguo, un id suelto)
 * no se inventa: se devuelve limpio pero sin reinterpretar. Vacío → ''.
 */
function hablarHabitacion(nombre) {
  const crudo = String(nombre == null ? '' : nombre).replace(/\s+/g, ' ').trim();
  if (!crudo) return '';

  const m = crudo.match(NOMBRE_CON_PUERTA);
  if (!m) {
    return crudo.replace(/\s*·\s*/g, ', ').replace(/\bindep\b\.?/gi, 'independiente');
  }
  const resto = descriptorParaVoz(m[2]);
  return resto ? `habitación ${m[1]}, ${resto}` : `habitación ${m[1]}`;
}

module.exports = { capacidadDeTipo, hablarHabitacion };
