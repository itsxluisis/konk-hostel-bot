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
| Vapi | Asistente de voz IA | En despliegue |
| Sipgate Free | Puente SIP Android → Vapi | Configurado |
| Telegram | Resumen automático de cada llamada | Activo |
| Booking.com | Canal actual de nuevas reservas | Activo (mientras se rehace pasarela directa) |

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

- **Prompt Vapi (EN):** `vapi/system-prompt.md`
- **Tool activa:** `vapi/tools/get_availability.json`
- **KB UpMarket (ES):** `upmarket/knowledge-base.md`
- **Admin panel:** `admin-panel/index.html`
- **Webhook server:** `ANTIGRAVITY/BOT LLAMADAS KONK/konk-webhook/konk-webhook/src/server.js`

## Pendientes

1. **Activar `end_call` en el asistente Vapi** — habilitarlo en la configuración del assistant (es una tool built-in de Vapi).
2. **Confirmar regeneración de la API key de Vapi** — se compartió accidentalmente en sesión anterior.
3. **Rellenar `{{WHATSAPP_NUMBER}}`** en `vapi/system-prompt.md` cuando esté listo.
4. **Desplegar cambios** subiendo el código actualizado a EasyPanel.

## Cómo trabajar en este repo

- Cambios en el prompt Vapi → editar `vapi/system-prompt.md`, luego sincronizar con la API de Vapi o vía panel admin.
- Cambios en la KB de UpMarket → editar `upmarket/knowledge-base.md` y subirla al panel de UpMarket.
- Cambios en el servidor → editar `src/server.js` y redesplegar en EasyPanel.
- Variables de entorno → `.env.example`.

## Convenciones

- Idiomas: prompt Vapi en **EN**, KB UpMarket en **ES**, docs y código en **ES**.
- Placeholders con doble llave: `{{WHATSAPP_NUMBER}}`, etc.
- Nada de claves reales en el repo.
