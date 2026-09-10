# CLAUDE.md — Konk Hostel Automatización

> Este archivo es el punto de entrada para Claude Code. Léelo siempre antes de actuar.

## Proyecto

Automatización 100% remota y sin personal del **Konk Hostel** (La Manga del Mar Menor, Murcia, España), operado por **Rentalme.es** (Luis).

## Stack

| Servicio | Rol | Estado |
|---|---|---|
| Cloudbeds | PMS | Activo, OAuth conectado |
| UpMarket | Bot mensajería / concierge virtual | KB en `upmarket/knowledge-base.md` |
| Vikey | Check-in online + cerradura inteligente | Activo |
| PricePoint | Pricing dinámico | Activo |
| Vapi | Asistente de voz IA | **En producción** (LLM gpt-4o-mini · voz ElevenLabs `eleven_turbo_v2_5` · STT Deepgram nova-3 es) |
| Sipgate Free | Puente SIP Android → Vapi | Configurado |
| Telegram | Resumen esquemático de cada llamada | Activo |
| haztureserva.app | Canal de nuevas reservas (el bot dirige aquí) | Activo |

## Arquitectura de llamadas

```
Android SIM con número del hostel
   │  *21*  (desvío incondicional)
   ▼
Sipgate Free (SIP bridge)
   │  SIP trunk
   ▼
Vapi (asistente IA)
   │  webhooks HTTPS
   ▼
Backend (Node/Express en EasyPanel)
https://rentalme-konk-bot-webhook.sklshk.easypanel.host
```

## Scope del agente de voz

Nada más descolgar bifurca entre **reserva** (aún no ha reservado) y **soporte** (ya tiene reserva). El bot atiende llamadas entrantes y puede:
1. **Responder preguntas frecuentes** — check-in/out, WiFi, acceso, servicios
2. **Consultar disponibilidad y tarifas** — via `get_availability` (Cloudbeds API)
3. **Dar soporte al huésped con reserva** — acceso Vikey paso a paso, info de la estancia (WiFi, lavandería, cocina, normas), y recomendaciones de la zona (conserje)
4. **Escalar incidencias al equipo** — via `report_incident` (Telegram): fallos de acceso persistentes, incidencias de la estancia o peticiones de contacto
5. **Emergencias flagrantes** (incendio, pelea) → indicar llamar al 112 + escribir por WhatsApp
6. **Cerrar la llamada** con `end_call` al terminar

El bot **no** gestiona reservas (dirige a haztureserva.app) y **nunca da códigos de acceso ni claves por teléfono** (si el acceso falla, escala con `report_incident`).

## Resumen automático de llamadas (Telegram)

Al terminar cada llamada, Vapi envía el `end-of-call-report` al servidor, que reenvía un resumen breve al grupo de Telegram de staff para monitoreo.

## Encargado — Vigilancia de agentes locales

Supervisor que monitorea agentes autónomos en máquinas locales (facturador-konk, vigilante-cobros) y detecta su ausencia el mismo día en que no corren. Ver detalles en `docs/encargado.md`.

- **Horario facturador**: lunes 09:00 ± 120 min.
- **Horario vigilante**: L-S 09:00 ± 120 min.
- **Revisión periódica**: cada 10 minutos.
- **Alarma**: aviso a Telegram en tema correspondiente si falta el latido.

## Estado actual

- **Prompt Vapi (ES):** `vapi/system-prompt.md` — se sincroniza solo al hacer push (Action `sync-vapi.yml`)
- **Tool get_availability:** `vapi/tools/get_availability.json` (documentación; el schema real vive en Vapi)
- **Lógica de disponibilidad:** `src/availability.js` (pura, testeada en `test/availability.test.js`)
- **KB UpMarket (ES):** `upmarket/knowledge-base.md`
- **Admin panel:** `public/index.html` (servido en `/admin-panel`)
- **Webhook server:** `src/server.js` (Node/Express en EasyPanel)

## Deploy y CI

- **Push a `main` = deploy**: EasyPanel auto-despliega en <1 min. Verificar con `/health`.
- **Push que toque `vapi/system-prompt.md`** → la Action `sync-vapi.yml` lo sube a Vapi.
- ⚠️ **Editar el assistant en el dashboard de Vapi pisa lo subido por API** — tras tocar el
  dashboard, re-ejecutar `sync-vapi.yml` (workflow_dispatch).
- `verify-assistant.yml` (manual) lee el assistant en vivo y comprueba los marcadores clave.
- `set-server-messages.yml` (manual) reactiva `serverMessages: ["end-of-call-report"]`. ⚠️ Si el bot
  atiende pero **no llega el resumen a Telegram**, casi siempre es que un edit en el dashboard dejó
  `serverMessages` en null (Vapi deja de mandar el fin de llamada): re-ejecuta este workflow.
  Diagnóstico: `diag-server-messages.yml` vuelca serverMessages/server.url en vivo.
- `remove-pronunciation.yml` (manual) desengancha el diccionario de pronunciación si
  reapareciera (rompe la voz con modelos ≠ flash_v2/turbo_v2).

## Pendientes

1. **Rotar la VAPI_API_KEY** — se compartió accidentalmente en una sesión antigua (actualizar también los secrets del repo).
2. **Añadir el parámetro `preference`** (enum private/shared/any) al schema de la tool `get_availability` en Vapi — el servidor ya lo soporta (default `any`).
3. **Afinar turn-detection/endpointing** en Vapi para bajar latencia (los waits por defecto añaden ~1,5s).
4. **Rellenar placeholders de la KB UpMarket** (códigos de armarios, parking, mascotas) y re-subirla al panel.
5. **Puesta en marcha del Encargado** (Fase 0: vigilancia básica, Fases 1-3 en roadmap de `docs/encargado.md`):
   - Crear 7 temas en el grupo de Telegram del Konk (Estado, Parte, Alertas, Llamadas, Cobros, Facturas, Preguntar).
   - Rellenar `TG_TEMA_*` en `.env` de EasyPanel con los IDs de los temas.
   - Copiar `ENCARGADO_SECRET` (de `.env` EasyPanel) a `.env` del facturador-konk y vigilante-cobros en el Mac.
   - Rellenar `ENCARGADO_URL` (URL del servidor Konk) en ambos agentes locales.
   - Verificar que los agentes llamen a `latir()` al terminar (ya está implementado en el código).

## Cómo trabajar en este repo

- Cambios en el prompt Vapi → editar `vapi/system-prompt.md` y hacer push (se sincroniza solo).
- Cambios en la KB de UpMarket → editar `upmarket/knowledge-base.md` y subirla al panel de UpMarket.
- Cambios en el servidor → editar `src/` y hacer push (EasyPanel auto-despliega). Correr antes `node test/availability.test.js`.
- Variables de entorno → documentadas en `.env.example`; los valores reales viven en EasyPanel.

## Convenciones

- Idiomas: prompt Vapi en **ES**, KB UpMarket en **ES**, docs y código en **ES**.
- Placeholders con doble llave: `{{CABINET_CODE_...}}`, etc.
- Nada de claves reales en el repo.
