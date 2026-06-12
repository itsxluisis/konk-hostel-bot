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

El bot atiende llamadas entrantes y puede:
1. **Responder preguntas frecuentes** — check-in/out, WiFi, acceso, servicios
2. **Consultar disponibilidad y tarifas** — via `get_availability` (Cloudbeds API)
3. **Redirigir al WhatsApp del hostel** para cualquier gestión o incidencia
4. **Emergencias flagrantes** (incendio, pelea) → indicar llamar al 112 + escribir por WhatsApp
5. **Cerrar la llamada** con `end_call` al terminar

El bot **no** gestiona reservas, no da códigos de acceso físico, no escala incidencias por Telegram directamente.

## Resumen automático de llamadas (Telegram)

Al terminar cada llamada, Vapi envía el `end-of-call-report` al servidor, que reenvía un resumen breve al grupo de Telegram de staff para monitoreo.

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
- `remove-pronunciation.yml` (manual) desengancha el diccionario de pronunciación si
  reapareciera (rompe la voz con modelos ≠ flash_v2/turbo_v2).

## Pendientes

1. **Rotar la VAPI_API_KEY** — se compartió accidentalmente en una sesión antigua (actualizar también los secrets del repo).
2. **Añadir el parámetro `preference`** (enum private/shared/any) al schema de la tool `get_availability` en Vapi — el servidor ya lo soporta (default `any`).
3. **Afinar turn-detection/endpointing** en Vapi para bajar latencia (los waits por defecto añaden ~1,5s).
4. **Rellenar placeholders de la KB UpMarket** (códigos de armarios, parking, mascotas) y re-subirla al panel.

## Cómo trabajar en este repo

- Cambios en el prompt Vapi → editar `vapi/system-prompt.md` y hacer push (se sincroniza solo).
- Cambios en la KB de UpMarket → editar `upmarket/knowledge-base.md` y subirla al panel de UpMarket.
- Cambios en el servidor → editar `src/` y hacer push (EasyPanel auto-despliega). Correr antes `node test/availability.test.js`.
- Variables de entorno → documentadas en `.env.example`; los valores reales viven en EasyPanel.

## Convenciones

- Idiomas: prompt Vapi en **ES**, KB UpMarket en **ES**, docs y código en **ES**.
- Placeholders con doble llave: `{{CABINET_CODE_...}}`, etc.
- Nada de claves reales en el repo.
