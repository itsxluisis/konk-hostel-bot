# Konk Hostel — Automatización

Repositorio del proyecto de automatización del Konk Hostel (La Manga, Murcia). Operación 100% remota sin staff físico.

> **Para Claude Code:** lee primero [`CLAUDE.md`](./CLAUDE.md).

## Estructura

```
.
├── CLAUDE.md                       # Contexto y estado para Claude Code (leer primero)
├── memory.md                       # Memoria histórica del proyecto
├── .env.example                    # Variables de entorno (valores reales en EasyPanel)
├── src/
│   ├── server.js                   # Webhook server Express (Vapi, Cloudbeds, Telegram)
│   ├── availability.js             # Lógica de respuesta de disponibilidad (pura, testeada)
│   ├── cloudbeds.js                # Cliente Cloudbeds (OAuth + availability)
│   └── telegram.js                 # Notificador Telegram
├── public/
│   └── index.html                  # Panel admin (servido en /admin-panel)
├── test/
│   └── availability.test.js        # Tests de la lógica de disponibilidad
├── vapi/
│   ├── system-prompt.md            # Prompt del asistente (ES) — push = sync a Vapi
│   └── tools/get_availability.json # Doc del schema de la tool (el real vive en Vapi)
├── upmarket/
│   └── knowledge-base.md           # KB del concierge virtual (ES)
├── .github/workflows/              # sync-vapi, verify-assistant, cost-report, etc.
└── docs/
    ├── architecture.md             # Arquitectura de llamadas
    ├── operations.md               # Operativa del hostel
    └── pending-decisions.md        # Decisiones pendientes
```

## Inicio rápido

1. `git push` a `main` despliega solo (EasyPanel). Verifica con `/health`.
2. Tests: `node test/availability.test.js` (sin dependencias).
3. Panel admin: `https://<servidor>/admin-panel` (login con ADMIN_USER/ADMIN_PASSWORD).
