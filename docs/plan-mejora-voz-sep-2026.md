# Plan de mejora del bot de voz del Konk (v2) — sep-2026

> Escrito por NEXO el 23-sep-2026 a partir de la auditoría independiente del `auditor` (misma fecha). **Planning gate:** nada se toca en producción hasta que Luis apruebe cada tanda. El bot está en vivo 24/7 sin staging: cada push a `vapi/system-prompt.md` se sube solo a Vapi.

## Estado actual (auditado)

LLM gpt-4o-mini · STT Deepgram nova-3 (es) · TTS ElevenLabs turbo v2.5 · solo español. Tools: fecha, disponibilidad, tiempo, incidencia, colgar. Lo que hace bien: precio y disponibilidad calculados 100 % en servidor (`src/availability.js`, puro y con 40+ tests), precios siempre en total de estancia, cierre de llamada determinista, fechas resueltas por tool, corte de reservas del mismo día a las 22:30. Bien alineado con la skill `vapi-voz-reservas`.

## Hallazgos (auditoría 23-sep-2026)

| ID | Sev | Hallazgo | Dónde | Esf |
|---|---|---|---|---|
| H1 | ALTA | Error de la API de Cloudbeds se confunde con "sin disponibilidad": el huésped oye que no hay sitio cuando en realidad falló el token o la API, y nadie se entera | `src/cloudbeds.js:148-151`, `src/server.js:144-153` | S |
| H2 | ALTA | El parámetro `preference` (privada / compartida / cualquiera) puede no estar en el schema real de la tool en Vapi; el prompt ya lo usa. Si falta, siempre cae en "cualquiera" | `CLAUDE.md:89`, `vapi/system-prompt.md:117-134`, `src/server.js:123` | S |
| H3 | ALTA | El panel admin recibe `VAPI_API_KEY` y `VAPI_SECRET` en claro y llama a la API de Vapi desde el navegador | `src/server.js:308-315`, `public/index.html:311-360` | M |
| H4 | ALTA | La `VAPI_API_KEY` compartida por error sigue sin rotar | `CLAUDE.md:88`, `memory.md` | S |
| H5 | MEDIA | Sin inglés: el prompt fuerza español aunque el que llame sea extranjero | `vapi/system-prompt.md:1-5` | M |
| H6 | MEDIA | El endpoint que recibe el informe de fin de llamada no valida secreto: cualquiera puede inyectar informes falsos y llenar Telegram de avisos "LLAMAR" | `src/server.js:363-469` | S |
| H7 | MEDIA | `get-weather` es la única tool sin autenticación | `src/server.js:208` | S |
| H8 | MEDIA | La autenticación es fail-open: sin `VAPI_SECRET` en el entorno, todo pasa | `src/server.js:30-32,502` | S |
| H9 | MEDIA | No hay tool para mandar el enlace de reserva por WhatsApp/SMS al terminar una llamada con interés: el huésped tiene que recordar la URL de oído | `vapi/system-prompt.md:19,113-122` | M |
| H10 | MEDIA | El diccionario de pronunciación se desenganchó por incompatibilidad con turbo v2.5; "Konk" y el dominio quedan sin fijar | `.github/workflows/remove-pronunciation.yml` | M |
| H11 | MEDIA | `docs/architecture.md`, `docs/operations.md`, `docs/pending-decisions.md` describen el diseño de abril (tools de reserva y códigos ya eliminadas): planificar sobre ellos es planificar sobre algo que no existe | `docs/` | S |
| H12 | BAJA | No existen `task_tracker.md` ni `work_log.md` | raíz | S |
| H13 | BAJA | `/health` dice "Cloudbeds autorizado" si existe la variable, no si el refresh token sirve | `src/server.js:351-359` | S |
| H14 | BAJA | Secretos aceptados por query string en dos rutas: acaban en logs | `src/server.js:82-84,276-277` | S |
| H15 | BAJA | Sin métrica de conversión (llamadas → reservas); el informe de coste de Vapi es manual | `.github/workflows/vapi-cost-report.yml` | M |

## Tandas propuestas (orden recomendado)

### Tanda V0 · Seguridad y robustez — esta semana, esfuerzo S, sin tocar el prompt
- H4 Rotación de `VAPI_API_KEY`: **la hace Luis por su cuenta (decisión 23-sep-2026), fuera de esta tanda.** Recordatorio: rotar sin actualizar EasyPanel corta el bot.
- H1 Distinguir error de API de "sin disponibilidad": ante fallo, el bot dice "te lo confirmo en un momento por WhatsApp" y salta aviso a Telegram `ALERTAS`.
- H6 + H7 + H8 Autenticar el informe de fin de llamada y `get-weather`; auth fail-closed si falta el secreto.
- H14 Secretos solo por cabecera. H13 `/health` comprueba el refresh token de verdad.
- Verificación: `node test/availability.test.js`, pestaña "Test dispon." del panel, `verify-assistant.yml`, una llamada real de Luis.

### Tanda V1 · Panel sin secretos — esfuerzo M
- H3 Las llamadas a la API de Vapi salen del navegador: el backend hace de proxy y el panel solo habla con el propio backend. Aprovechar para que el panel muestre el estado real de la key rotada.

### Tanda V2 · Conversión y tools compartidas — esfuerzo M, acompasada con CONSERJE HOSTELS
- H2 Verificar en vivo el schema de `get_availability` en Vapi; si falta `preference`, añadirlo por `sync-vapi.yml`.
- **Tools compartidas:** `get-availability` y `getReservations` aceptan `propertyID` (hoy fijo al Konk) y se exponen en un endpoint interno con secreto para el Conserje Hostels. Una sola verdad de disponibilidad para voz y chat.
- H9 Tool `enviar_enlace_reserva`: al detectar interés, el bot pide el móvil (o usa el que llama) y manda por **WhatsApp Cloud API** una plantilla utility con el enlace del motor precargado (`checkin`, `checkout`, `adults`). Depende de la Fase 0 del Conserje Hostels (número 682 335 986 en Meta). Mientras no exista, no se hace por SMS de pago: se espera.
- H15 Métrica de conversión: enlaces enviados vs reservas nuevas con ese teléfono/email en Cloudbeds; informe de coste de Vapi programado semanal.

### Tanda V3 · Voz e idioma — esfuerzo M, requiere llamadas de prueba
- H5 Inglés de respaldo, **criterio de Luis (23-sep-2026): el bot habla español y, si detecta que el huésped habla inglés, pasa a inglés.** Ejecución:
  1. **STT:** Deepgram nova-3 pasa de `language: es` a `language: multi` (detección y cambio de idioma dentro de la misma llamada, cubre es/en). Sin esto, la primera frase en inglés se transcribe como ruido y el bot nunca "detecta" nada. Comprobar que el español no pierde precisión con 5 llamadas de prueba.
  2. **TTS:** ElevenLabs turbo v2.5 ya es multilingüe; no se cambia de voz ni de modelo. La misma voz habla inglés.
  3. **Prompt:** sustituir la regla "ni una palabra en inglés" por: saludo y primer turno en español; si el interlocutor habla en inglés o lo pide, cambiar a inglés y mantenerlo el resto de la llamada; **un solo idioma por frase**, nunca spanglish; si vuelve al español, volver. El saludo no cambia.
  4. **Tools bilingües en servidor:** `get_availability`, `get_current_date` y el cierre de llamada aceptan `lang: es|en` y devuelven el texto ya redactado en ese idioma desde `src/availability.js` (plantillas en/es, tests para ambas). El modelo NO traduce precios ni fechas: gpt-4o-mini se equivoca con números al traducir al vuelo.
  5. **Telegram:** el resumen de la llamada al staff sigue en español e indica el idioma de la llamada.
  6. **Pruebas:** "Talk to assistant" en inglés y en español, y 3 llamadas reales de Luis (una en inglés, una que empieza en español y cambia, una solo español). Verificación con `verify-assistant.yml` tras `sync-vapi.yml`.
  Descartado: dos asistentes (ES/EN) con transferencia entre ellos, más complejo y con corte audible; menú "para inglés pulse 2", peor experiencia.
- H10 Pronunciación: los diccionarios por fonemas de ElevenLabs solo funcionan en modelos solo-inglés, que romperían el español. Usar **alias** (Konk → "Conc", haztureserva.app → "haz tu reserva punto app") en el diccionario o directamente en el prompt, sin cambiar de modelo. Verificar con "Talk to assistant" del dashboard.

### Tanda V4 · Operación y documentación — esfuerzo S
- H11 Reescribir los tres docs obsoletos al diseño real. H12 Crear `task_tracker.md` y `work_log.md` y volcar el histórico de `memory.md` + `git log`.

## Protocolo de pruebas (sin llamadas reales salvo cierre de tanda)
1. `node test/availability.test.js` antes de tocar precios o filtrado.
2. Pestaña "Test dispon." del panel para ver el texto exacto que leerá el bot contra Cloudbeds real.
3. Tras cualquier cambio de prompt: `sync-vapi.yml` → `verify-assistant.yml`. Tras cualquier prueba en el dashboard de Vapi: relanzar `sync-vapi.yml` (el dashboard pisa la API y viceversa).
4. STT / TTS / interrupciones / latencia: solo con "Talk to assistant" o una llamada real de Luis al cierre de la tanda.
5. Nunca rotar `VAPI_API_KEY` ni `VAPI_SECRET` sin actualizar EasyPanel en el mismo acto.

## Estado
- **23-sep-2026: plan aprobado por Luis** (orden V0 → V4). Rotación de key: la hace Luis. Inglés: aprobado con el criterio de arriba.
- V0 en construcción en la rama `v0-seguridad-robustez` (sin push a main hasta revisar y confirmar `VAPI_SECRET` en EasyPanel).
