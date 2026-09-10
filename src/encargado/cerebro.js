// src/encargado/cerebro.js
// Entiende lo que le preguntan y decide qué consultar.
//
// Con ANTHROPIC_API_KEY usa Claude, que elige la consulta y redacta la
// respuesta. Sin clave sigue siendo útil: empareja por palabras y contesta
// con los mismos datos, solo que sin conversación.
'use strict';

const axios = require('axios');
const { CONSULTAS } = require('./consultas');
const acciones = require('./acciones');
require('./acciones-basicas');   // registra las acciones en el catálogo
const { hoyISO } = require('./reloj');

const MODELO = process.env.ENCARGADO_MODELO || 'claude-haiku-4-5-20251001';
const MAX_PASOS = 4;

function hayCerebro() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ─── modo sin cerebro: palabras clave ────────────────────────────────────────

const PISTAS = [
  [/(qui[eé]n|qu[eé]).*(llega|entra|check.?in)|llegadas?/i, 'quien_llega'],
  [/(qui[eé]n|qu[eé]).*(se va|sale|marcha|check.?out)|salidas?/i, 'quien_se_va'],
  [/(qui[eé]n|cu[aá]nt).*(dentro|alojad|dormi|en casa|hay)|ocupaci[oó]n/i, 'quien_esta_dentro'],
  [/cobro|cobrad|pagad|pendiente de pago|debe/i, 'revisar_cobros'],
  [/agente|robot|bot|vigilante|facturador|equipo/i, 'como_va_el_equipo'],
  [/parte|resumen|c[oó]mo va|estado/i, 'estado_del_dia'],
];

function fechaDeTexto(t) {
  if (/pasado ma[ñn]ana/i.test(t)) return 'pasado';
  if (/ma[ñn]ana/i.test(t)) return 'mañana';
  if (/ayer/i.test(t)) return 'ayer';
  const iso = t.match(/\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : 'hoy';
}

/**
 * Decide qué consulta encaja con la pregunta. Pura: no consulta nada,
 * solo elige. Devuelve null si no reconoce la pregunta.
 */
function elegir(pregunta) {
  const buscar = pregunta.match(/busca(?:r)?\s+a?\s*([\p{L}\s]{3,40})/iu);
  if (buscar) return { consulta: 'buscar_huesped', args: { nombre: buscar[1].trim() } };
  for (const [re, nombre] of PISTAS) {
    if (re.test(pregunta)) return { consulta: nombre, args: { fecha: fechaDeTexto(pregunta) } };
  }
  return null;
}

async function sinCerebro(pregunta) {
  const e = elegir(pregunta);
  if (e) return CONSULTAS[e.consulta].fn(e.args);
  return [
    'No tengo el cerebro conectado, así que solo entiendo preguntas sencillas.',
    'Prueba con: "quién llega mañana", "quién se va hoy", "quién está dentro",',
    '"cómo va el equipo", "revisa los cobros" o "busca a Cristian".',
  ].join('\n');
}

// ─── modo con cerebro: Claude elige la consulta ──────────────────────────────

function herramientas() {
  const consultas = Object.entries(CONSULTAS).map(([nombre, c]) => ({
    name: nombre,
    description: c.descripcion,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(c.parametros).map(([k, d]) => [k, { type: 'string', description: d }])
      ),
      required: [],
    },
  }));

  // Las acciones se ofrecen con el prefijo hacer_ para que quede claro,
  // también para el modelo, que eso no es mirar: es tocar.
  const hacer = Object.entries(acciones.ACCIONES).map(([nombre, a]) => ({
    name: `hacer_${nombre}`,
    description: `[ACCIÓN, requiere confirmación de Luis] ${a.descripcion}`,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(a.parametros || {}).map(([k, d]) => [k, { type: 'string', description: d }])
      ),
      required: [],
    },
  }));

  return [...consultas, ...hacer];
}

const SISTEMA = `Eres el encargado del Konk Hostel (La Manga, Murcia). Hablas con Luis, el dueño, por Telegram.

Hoy es {HOY}.

Contestas corto y en cristiano, como un encargado que conoce la casa. Nada de rodeos ni de repetir la pregunta.

Reglas:
- Para cualquier dato del hostel usa las herramientas. No te inventes nunca nombres, fechas ni cifras.
- Si una herramienta ya devuelve el texto formateado, puedes pasarlo tal cual o resumirlo, pero no cambies los datos.
- Si no puedes saber algo, dilo claramente en una línea.
- Las herramientas que empiezan por hacer_ CAMBIAN cosas. Úsalas solo si Luis
  pide claramente que hagas algo, nunca por iniciativa propia ni "por si acaso".
  No hacen el cambio: lo preparan para que Luis lo confirme con un botón.
- Nada de markdown: Telegram lo muestra en texto plano.`;

async function conCerebro(pregunta) {
  const url = 'https://api.anthropic.com/v1/messages';
  const cabeceras = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const mensajes = [{ role: 'user', content: pregunta }];

  for (let paso = 0; paso < MAX_PASOS; paso++) {
    const { data } = await axios.post(url, {
      model: MODELO,
      max_tokens: 1024,
      system: SISTEMA.replace('{HOY}', hoyISO()),
      tools: herramientas(),
      messages: mensajes,
    }, { headers: cabeceras, timeout: 45000 });

    const usos = (data.content || []).filter(b => b.type === 'tool_use');
    if (!usos.length) {
      const texto = (data.content || []).filter(b => b.type === 'text')
        .map(b => b.text).join('\n').trim();
      return { texto: texto || 'No he sabido qué contestar a eso.' };
    }

    // Si pide una acción, se corta aquí. El mensaje de confirmación lo
    // escribimos nosotros palabra por palabra: lo que se va a ejecutar no
    // puede depender de cómo lo parafrasee el modelo.
    const accion = usos.find(u => u.name.startsWith('hacer_'));
    if (accion) {
      const nombre = accion.name.slice('hacer_'.length);
      try {
        const p = await acciones.proponer(nombre, accion.input || {});
        if (p.imposible) return { texto: p.motivo };
        return { texto: acciones.mensaje(p), botones: acciones.botones(p) };
      } catch (err) {
        return { texto: `No he podido preparar eso: ${err.message}` };
      }
    }

    mensajes.push({ role: 'assistant', content: data.content });
    const resultados = [];
    for (const u of usos) {
      const c = CONSULTAS[u.name];
      let salida;
      try {
        salida = c ? await c.fn(u.input || {}) : `No existe la consulta ${u.name}.`;
      } catch (err) {
        salida = `La consulta ${u.name} falló: ${err.message}`;
      }
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: String(salida) });
    }
    mensajes.push({ role: 'user', content: resultados });
  }
  return { texto: 'Me he liado dando vueltas a esa pregunta. Prueba a decirlo más concreto.' };
}

/**
 * Responde a una pregunta. Nunca lanza: si algo falla, lo dice.
 */
/**
 * Responde a una pregunta. Devuelve {texto, botones?}.
 * Nunca lanza: si algo falla, lo dice.
 */
async function responder(pregunta) {
  const p = (pregunta || '').trim();
  if (!p) return null;
  try {
    if (!hayCerebro()) return { texto: await sinCerebro(p) };
    return await conCerebro(p);
  } catch (err) {
    const detalle = err.response?.data?.error?.message || err.message;
    console.error('[Encargado] Fallo al responder:', detalle);
    // Si el cerebro falla, todavía podemos intentar el modo simple.
    try {
      return { texto: `(el cerebro falló: ${detalle})\n\n` + await sinCerebro(p) };
    } catch {
      return { texto: `No he podido responder: ${detalle}` };
    }
  }
}

module.exports = { responder, hayCerebro, sinCerebro, elegir, fechaDeTexto, MODELO };
