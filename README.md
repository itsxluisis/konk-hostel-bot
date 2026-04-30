# Konk Hostel — Automatización

Repositorio del proyecto de automatización del Konk Hostel (La Manga, Murcia). Operación 100% remota sin staff físico.

> **Para Claude Code:** lee primero [`CLAUDE.md`](./CLAUDE.md).

## Estructura

```
.
├── CLAUDE.md                       # Contexto y estado para Claude Code
├── memory.md                       # Memoria original importada del proyecto
├── .env.example                    # Variables de entorno
├── vapi/
│   ├── system-prompt.md            # Prompt del asistente (EN)
│   └── tools/                      # Definiciones JSON de tool calls
├── upmarket/
│   └── knowledge-base.md           # KB del concierge virtual (ES)
├── admin-panel/
│   └── index.html                  # Panel admin React single-file
├── server/
│   └── webhooks/
│       └── check_reservation.js    # Endpoint placeholder
└── docs/
    ├── architecture.md             # Arquitectura de llamadas
    ├── operations.md               # Operativa del hostel
    └── pending-decisions.md        # Decisiones pendientes
```

## Inicio rápido

1. Copia `.env.example` a `.env` y rellena las claves.
2. Revisa `docs/pending-decisions.md` antes de tocar nada en producción.
3. Sirve el panel: abre `admin-panel/index.html` en el navegador.
