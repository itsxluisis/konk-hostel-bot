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
