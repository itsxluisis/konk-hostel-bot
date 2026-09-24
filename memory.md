**Purpose & context**

Luis is automating **Konk Hostel**, a recently acquired property in La Manga del Mar Menor, Murcia, Spain, operated through his company **Rentalme.es**. The goal is 100% remote, staff-free operations. Core automation stack:

- **Cloudbeds** – PMS
- **UpMarket** – messaging bot / virtual concierge
- **Vikey** – online check-in and smart lock access
- **PricePoint** – dynamic pricing
- **Vapi** – AI voice assistant for call handling

**Current state**

**Call-handling architecture (finalized):**
Android SIM → unconditional call forward (`*21*`) → Sipgate Free (SIP bridge) → Vapi SIP trunk → AI assistant. Luis cannot purchase numbers directly in Vapi due to plan restrictions, so the SIP trunk import method via API calls is the workaround.

**Vapi assistant:**
A comprehensive system prompt has been produced (English), including tool call definitions for: `check_reservation`, `get_availability`, `create_reservation` (disabled), `get_cabinet_code`, and `alert_staff`. A Spanish-language knowledge base document for UpMarket has also been produced. Both contain placeholder markers for cabinet codes.

**Admin panel:**
A React-based single-HTML-file admin panel was built, connecting to Vapi via API key. Features: prompt editing, knowledge base management, voice/language config, browser test calls, call history with transcriptions, and an emergency detection panel.

**Unresolved issue – security risk:** ✅ **CERRADO (2026-06)** — la verificación de reservas se sacó del scope del bot de voz: el prompt actual no verifica reservas ni da códigos, y el código de `check_reservation` se eliminó del servidor. El bot solo informa, consulta disponibilidad y redirige.
~~The bot is hallucinating reservation verifications because the `check_reservation` webhook does not yet exist. Luis was presented with two options (deploy a minimal blocking endpoint vs. temporarily disable verification in the prompt) but did not select one before the conversation ended. **This requires a decision before going live.**~~

**Vapi API key was accidentally shared in chat** – Luis was advised to regenerate it immediately. Status of this action is unconfirmed.

**Key operational details (Konk Hostel):**

- Fully remote, no physical reception; staff alerts via Telegram
- **Vikey check-in flow:** link sent at booking, Spanish law requires document upload, access active 15:00–11:00, requires mobile data, two interaction modes (PIN or electronic handle)
- **Physical emergency cabinet system:** exterior lower (main entrance), exterior upper (independent-access room), interior numbered cabinets per room type — different protocols for private rooms vs. 4-person vs. 6-person shared dorms
- **No exceptions policy:** no early/late check-out under any circumstances, no post-checkout luggage storage; individual lockers available during stay only
- **No services:** no bar, no transfers, no bike rental
- **Bookings:** currently redirecting new reservations to Booking.com while direct payment gateway is rebuilt; Cloudbeds API integration was expected imminently

**On the horizon**

- ~~Decide on `check_reservation` webhook solution~~ ✅ Cerrado: feature fuera de scope, código eliminado (2026-06)
- Confirm Vapi API key has been regenerated (sigue pendiente — ver CLAUDE.md)
- ~~Cloudbeds API integration~~ ✅ Hecha: get_availability en producción; reservas directas via haztureserva.app
- Populate cabinet code placeholders in the UpMarket knowledge base (el prompt de voz ya no usa códigos)

**Tools & resources**

| Tool | Role |
|---|---|
| Vapi | AI voice assistant / call handling |
| Sipgate Free | SIP bridge from Android SIM to Vapi |
| Cloudbeds | PMS |
| UpMarket | Guest messaging bot / virtual concierge |
| Vikey | Online check-in + smart lock access |
| PricePoint | Dynamic pricing |
| Telegram | Staff incident alerts |
| Booking.com | Current channel for new reservations |
| Rentalme.es | Luis's operating company |

## 23-sep-2026 — Tanda V0 desplegada

- **Cambios integrados:** H1 error de API ≠ sin disponibilidad (bot dice "te lo confirmo en un momento por WhatsApp" + aviso Telegram ALERTAS); H6/H7 auth en modo warn para end-of-call-report y get_weather vía `VAPI_LEGACY_AUTH`; H8 vapiAuth fail-closed con aviso de arranque con cooldown 6 h; H13 `/health` comprueba Cloudbeds de verdad (refresh token); H14 sin secretos por query string (solo headers).
- **Plan completo:** `docs/plan-mejora-voz-sep-2026.md`. Tandas V1–V4 pendientes (panel sin secretos, conversión, idioma, docs).
- **Trampa nueva:** `get_weather` se creó a mano en el dashboard sin secreto; los JSON en `vapi/tools/` son documentación, `sync-vapi.yml` solo sincroniza el prompt.
- **Pendiente de Luis:** pegar el valor de `VAPI_SECRET` en Vapi en dos sitios (Tools/get_weather/Server/Secret y Assistant/Server/Secret); después rotar `VAPI_API_KEY`.
- **Regla operativa:** cada push a main redespliega el bot; no pushear solo docs.

## 23-sep-2026 — Tanda V1 (panel sin secretos + rotación sin cortes)

- **Qué cambia:** el navegador ya no recibe `VAPI_API_KEY` ni `VAPI_SECRET` — `/admin/login` solo devuelve un token de sesión (12h, en memoria). `adminAuth` nuevo (sesión `x-admin-token` o Basic `ADMIN_USER`/`ADMIN_PASSWORD`, nunca query string) protege `/admin/*`. `vapiAuth`/`legacyAuthOk` admiten `VAPI_SECRET_PREVIOUS` durante una rotación. Rate-limit compartido (10 fallos/15min por IP) entre `/admin/login` y cualquier Basic auth en `/admin/*`/`/vapi/*`; `app.set('trust proxy', 1)` para que `req.ip` sea la IP real del cliente detrás de Traefik/EasyPanel, no la del proxy. Comparaciones de secretos y contraseña en tiempo constante (`crypto.timingSafeEqual`).
- **4 rutas proxy nuevas** (la API key de Vapi vive solo en el servidor, allow-list explícita en `src/vapi-proxy.js`): `GET /admin/vapi/calls`, `GET /admin/vapi/calls/:id`, `GET /admin/vapi/assistants`, `PATCH /admin/vapi/assistants/:id`.
- **Sesión de 12h en memoria:** se pierde en cada redeploy — hay que volver a hacer login en el panel después de cada despliegue (igual que con cualquier redeploy de EasyPanel).
- **Rotar `VAPI_SECRET` sin cortes (5 pasos):** 1) desplegar esta versión; 2) en EasyPanel poner `VAPI_SECRET_PREVIOUS`=secreto viejo y `VAPI_SECRET`=nuevo; 3) actualizar el secreto en Vapi (Tools/get_weather/Server/Secret y Assistant/Server/Secret) al nuevo; 4) llamada de prueba real; 5) borrar `VAPI_SECRET_PREVIOUS` de EasyPanel.
- **`ENCARGADO_SECRET` antes de rotar:** fijar uno propio (distinto de `VAPI_SECRET`) antes de cualquier rotación — mientras no exista, `latidos.js` cae en `VAPI_SECRET`/`VAPI_SECRET_PREVIOUS` por compatibilidad (ver `docs/encargado.md`), y sin él los agentes del Mac dependen de que la rotación de arriba se haga bien.
- **Estado:** rama `v1-panel-sin-secretos`, auditada y con condiciones cerradas el 23-sep-2026 (`docs/plan-mejora-voz-sep-2026.md`), pendiente de merge con Luis. `npm test` en verde (144 comprobaciones).

## 24-sep-2026 — V1 desplegada, rotación y V1.1

- **V1 en producción:** merge `219db47` a `main` a las 11:15; EasyPanel autodesplegó.
- **Rotación hecha por Luis:** las tools de Vapi y el Server del assistant llevan el `VAPI_SECRET` nuevo en una **cabecera personalizada `x-vapi-secret`**, no en el campo "Secret" del dashboard — el assistant de Vapi no tiene campo Secret propio, por eso se usa la cabecera. `VAPI_API_KEY` también regenerada y actualizada en EasyPanel y GitHub Actions.
- **Hallazgo que motiva V1.1:** `GET /admin/vapi/assistants` reenviaba la config del assistant tal cual, así que el navegador recibía `server.headers['x-vapi-secret']` (y los secretos de tools inline); y `saveAsst()` mandaba de vuelta el `model` completo que acababa de leer, así que un PATCH real habría escrito "[redactado]" en Vapi y roto las tools. V1.1 redacta las respuestas del proxy y hace que el servidor reconstruya el `model` a partir del assistant real en cada PATCH — nunca del que mande el navegador.
- **Contadores de `/health` para la rotación:** `secretMatches.current/previous` cuentan qué secreto autenticó cada petición (vapiAuth, legacyAuthOk, fallback del Encargado); `legacyUnsigned.getWeather/endOfCall` cuentan las peticiones que pasan en modo warn sin secreto válido. Es seguro retirar `VAPI_SECRET_PREVIOUS` de EasyPanel y pasar `VAPI_LEGACY_AUTH` a `strict` cuando, tras una llamada de prueba real (con una consulta de la hora, que dispara `get_current_date`/`get_weather`), `previous` se quede en 0 (ya nadie usa el secreto viejo) y `legacyUnsigned` también en 0 (Vapi ya manda `x-vapi-secret` en el informe de fin de llamada y en get_weather).

## 24-sep-2026 — V1.2 guarda de fechas

- **El fallo real:** en una llamada real, el huésped pidió "entrar mañana y salir el domingo" y gpt-4o-mini llamó a `get_current_date` y `get_availability` EN PARALELO (mismo instante), mandando `checkin_date`/`checkout_date` de hace varios años (p. ej. `2023-10-07`) — fechas inventadas, no solo un año mal escrito. Cloudbeds contestaba `success:false` ("startDate should be greater than today"), el huésped oía un error técnico y saltaba una alerta a Telegram por algo que no era un fallo de la API.
- **La regla (rediseñada tras ver el log real):** `src/stay-dates.js` (`normalizeStayDates`, puro) rechaza CUALQUIER `checkin_date` anterior a hoy (Europe/Madrid, calculado con `toLocaleDateString('en-CA', ...)`, nunca con el truco `toLocaleString`+`toISOString` que depende de la zona del contenedor) — ya no hay corrección automática ni tope de 330 días: "corregir" al mismo mes/día de otro año podía dar una fecha tan falsa como la original si lo que falló fue el cálculo entero. El handler `/vapi/get-availability` NO llama a Cloudbeds con una fecha pasada.
- **Fix del mismo día (hallazgo ALTA del auditor):** el primer diseño devolvía un texto dirigido al MODELO ("FECHAS NO VÁLIDAS... No le digas al huésped que hay un error...", con calendario de +14 días y `nextOccurrence`) asumiendo que el modelo lo reinterpretaría en vez de leerlo. Pero `vapi/system-prompt.md` le ordena al modelo leer la respuesta de esta tool ENTERA Y TAL CUAL, así que ese texto se habría leído en voz alta al huésped. Arreglado SIN tocar el prompt: ahora el rechazo es una frase pensada para decirse tal cual — "Perdona, no he entendido bien las fechas. Hoy es \<día semana> \<día> de \<mes>. ¿Qué día quieres entrar y qué día salir?" (`spokenDate()`, sin año, sin ISO, sin la palabra "error"). `normalizeStayDates()` sigue calculando `nextOccurrence` (se loguea en consola, ya no se dice) y `buildForwardCalendar()` sigue existiendo y testeada, pero ya no se usa en este handler.
- **La alerta a Telegram queda solo para fallos técnicos de verdad (H1):** una fecha pasada rechazada por esta guarda NUNCA dispara `alertCloudbedsFailure` (no es un fallo de Cloudbeds); solo se cuenta en `/health` → `availabilityDateRejections: { count, lastAt }`, visibilidad sin ruido.
- **Commit A (mismo día, misma rama):** el `end-of-call-report` de esa llamada real no dejó rastro en el servidor; sospecha: el límite por defecto de `express.json()` (100kb) se queda corto con el prompt del assistant embebido varias veces en el payload (~48kB de mensajes de tools). `/vapi/assistant-config` monta su propio `express.json({limit:'1mb'})` ANTES del parser global (un cuerpo ya parseado no se reparsea, así que solo esa ruta sube a 1mb; el resto del sitio sigue en 100kb). Un middleware de error nuevo (al final de `src/server.js`) captura `entity.too.large`/`entity.parse.failed`, responde 413/400 sin la página HTML por defecto de Express, y cuenta en `/health` → `webhookBodyErrors: { count, last:{at,path,type,length} }` (nunca el cuerpo). `/health` → `endOfCall: { received, lastAt }` cuenta TODO POST con `message.type === 'end-of-call-report'` antes de comprobar el secreto — si una llamada real no deja rastro aquí, el límite de cuerpo no era la causa.
- **Commit C (mismo día, misma rama):** la guarda solo rechaza fechas PASADAS; si el modelo se equivoca en una fecha futura, el huésped no se enteraba. `spokenDateRangePrefix()` (`src/stay-dates.js`) antepone a la respuesta de disponibilidad (haya o no disponibilidad) las fechas consultadas en español — "Del sábado 10 al lunes 12 de octubre: " si es el mismo mes/año, "Del ... de <mes> al ... de <mes>: " si cruza de mes, con " de <año>" por fecha solo si esa fecha no es del año en curso. No toca `src/availability.js`, el texto de error técnico, el mensaje de fecha pasada ni el corte de las 22:30.

## 24-sep-2026 — V2a acceso reconocido

- **El problema:** una de cada cuatro llamadas del último mes era un huésped que no podía entrar (Vikey). Luis aprobó que el bot reconozca a quien llama por el teléfono, cruzándolo contra las llegadas de hoy/mañana y los alojados de hoy en Cloudbeds, para personalizar la atención y avisar al equipo como urgente con nombre y habitación. Sin API de Vikey, sin canales de contacto nuevos.
- **`src/guest-lookup.js` (nuevo):** `findStayByPhone(phone, todayISO)` pide a Cloudbeds `getReservations` (`checkInFrom`/`checkInTo` para llegadas hoy/mañana, `checkInTo`/`checkOutFrom` para alojados) con `includeGuestsDetails=true`, paginando y sin canceladas/no-show. El filtro de fechas de Cloudbeds no es de fiar (`docs/encargado.md`, "F1 no se fía del filtro de fechas"): la verdad se recalcula siempre en cliente con `startDate`/`endDate`. Normaliza teléfonos (espacios/guiones/paréntesis/puntos fuera, `00`→`+`, 9 dígitos ES→`+34`) y compara por los últimos 9 dígitos + prefijo de país si ambos lo traen. Varias coincidencias: prioriza llega-hoy > alojado > llega-mañana. Caché en memoria de 3 min (una llamada dispara `get_current_date` y luego `report_incident`, no repaginar dos veces). Cualquier fallo de Cloudbeds → `null`, log en consola, sin alerta a Telegram, sin romper la tool que la llama.
- **Campos de Cloudbeds usados:** teléfono de `guestPhone`/`guestCellPhone` de cada huésped en `guestList` (con `includeGuestsDetails=true`; se mantiene también la lectura a nivel de reserva por si acaso, pero según la doc oficial ahí no viene). Nombre: prioriza el huésped con `isMainGuest` (no el primero de la lista). Habitación: `rooms[]` a nivel de RESERVA (solo llega si se pide `includeAllRooms=true`, que `fetchAllPages` ya añade) → si no viene, `rooms[]`/`roomName`/`assignedRoom`/`roomTypeName`/`roomID` de cada huésped de `guestList` (nunca `unassignedRooms`, que significa justo lo contrario: sin asignar) → como último recurso, el `roomID`/`roomNumber` suelto a nivel de reserva que ya usa `getReservationsByDate`; sin ninguno, `rooms: null` (nunca se inventa).
- **Corrección crítica de NEXO (mismo día, commit `f4be1da`):** contra la doc oficial de Cloudbeds, `guestList` con `includeGuestsDetails=true` es un OBJETO indexado por guestID ("a map of guest IDs to guest objects"), NO un array. El primer diseño (`Array.isArray(r.guestList) ? r.guestList : []`) devolvía SIEMPRE `[]` contra la API real → en producción nunca habría encontrado un teléfono (bug silencioso: todo seguía respondiendo 200/OK, solo que sin estancia siempre). `guestListOf()` corregido admite objeto (`Object.values()`) y array (por si acaso). Fixtures de test rehechos con la forma real; test de regresión explícito verificado a mano (se reintrodujo el bug, el test falló; se restauró el fix, volvió a pasar).
- **`get_current_date`:** con el teléfono de quien llama (mismos 3 fallbacks que `report_incident`: `message.customer.number` / `message.call.customer.number` / `customer.number`), si hay estancia añade al final " RESERVA DE QUIEN LLAMA: a nombre de \<nombre de pila>, entrada el \<fecha>, salida el \<fecha>." (reutiliza `spokenDate()` de `stay-dates.js`) — nunca habitación, email, teléfono ni importe. Tope de 2,5s vía `Promise.race`: si Cloudbeds tarda más, se responde sin la línea (la consulta sigue en segundo plano y calienta la caché de 3 min para la siguiente tool call de la misma llamada). El `todayISO` de esta consulta es propio (método seguro `toLocaleDateString('en-CA', ...)`, el mismo que usa `/vapi/get-availability`), independiente del `isoToday` que ya calcula el handler con el truco que V1.2 marcó como dependiente de la zona del contenedor — no se toca ese cálculo ni el texto base existente.
- **`report_incident`:** añade al aviso de Telegram (mismo tema ALERTAS, misma respuesta a Vapi) la línea "Reserva: \<nombre completo> · hab. \<...> · entrada ... · salida ... · canal ... · id ... · estado ..." o "Reserva: no encontrada con este teléfono". Antepone "🚨 URGENTE — NO PUEDE ENTRAR" si la categoría es "acceso" y el huésped ya está alojado (entró antes de hoy, no ha salido — urgente a cualquier hora) o llega hoy y son las 15:00 o más en Europe/Madrid (hora de check-in por defecto, ver memoria "Check-in 15:00 por defecto"). `isUrgentAccessIncident()` es pura (recibe la hora ya calculada, mismo patrón que `stay-dates.js`) y se expuso como `app.isUrgentAccessIncident` solo para poder testear el corte de las 15:00 sin falsear el reloj de un servidor con otros temporizadores vivos (vigilante, encargado…).
- **`/health` → `guestLookup: { matches, misses, errors, lastAt, scan }`** (solo números y fecha, nunca datos de huésped). `scan = { at, reservations, withPhone, withRoom }` es el recuento de la última carga REAL de candidatas (no de cada `findStayByPhone`, que puede servir desde caché) — sirve para comprobar contra Cloudbeds de verdad que `guestPhone`/`rooms` están llegando, sin exponer nombres ni teléfonos a nadie. `warmCache()` calienta la caché una vez al arrancar el servidor, en segundo plano dentro de `app.listen` (fire-and-forget, nunca bloquea el arranque ni rompe nada si Cloudbeds falla — probado en vivo: en los tests, el calentamiento del arranque falla por falta de token todavía y se traga el error sin más).
- **Decisiones en casos límite:** "a nombre de" usa el huésped `isMainGuest` de la reserva (no necesariamente el que coincidió por teléfono, que puede ser otro huésped de la misma reserva — sigue siendo esa reserva). El "prefijo de país" al comparar teléfonos es "todo lo que sobra antes de los últimos 9 dígitos" (no una tabla ITU real): sirve para NO cruzar dos países que compartan por casualidad los últimos 9 dígitos, no para validar el prefijo en sí — sin impacto en el caso normal (mismo número, formatos distintos). Sin campo de habitación en ningún sitio → "sin asignar" en el aviso de Telegram, `rooms: null` en el objeto devuelto.
- **Sigue sin verificar contra Cloudbeds real** (la tarea lo pidió así: tests con Cloudbeds mockeado, sin tocar secretos). El bug de `guestList` como array SÍ se corrigió contra la doc oficial, pero antes de mergear conviene una llamada real de Luis que dispare `get_current_date`/`report_incident` con una reserva de verdad y mirar `/health` → `guestLookup.scan` (¿`withPhone`/`withRoom` > 0 de verdad?) para confirmar que `guestPhone`/`includeAllRooms` se comportan en producción como dice la doc.
- **Rama `v2a-acceso-reconocido`, sin mergear, sin push.** No se tocó `vapi/system-prompt.md` ni `.github/workflows/`. Tests sin red (axios interceptado, mismo patrón que `cloudbeds-errors.test.js`/`get-availability-dates.test.js`): `test/guest-lookup.test.js` (37 casos) y `test/vapi-guest-recognition.test.js` (19 casos, arranca el servidor real). `npm test`: 21 archivos, todos en verde. Commits: `9d4bea3` (helper), `a4b1fd8` (wiring), `82c2f5d` (docs), `f4be1da` (corrección guestList/rooms/scan/warmup).
