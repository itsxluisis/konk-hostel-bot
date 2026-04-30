# Arquitectura — Konk Hostel

## 1. Manejo de llamadas (voz)

```
┌──────────────────────┐
│ Número del hostel    │  (SIM Android física)
└──────────┬───────────┘
           │ *21*  (desvío incondicional)
           ▼
┌──────────────────────┐
│ Sipgate Free         │  (puente SIP gratuito)
└──────────┬───────────┘
           │ SIP trunk
           ▼
┌──────────────────────┐
│ Vapi (asistente IA)  │
│ - prompt EN          │
│ - tools JSON         │
│ - voz ES por defecto │
└──────────┬───────────┘
           │ webhooks (HTTPS)
           ▼
┌──────────────────────────────────┐
│ Backend webhooks (Node/Express)  │
│ - check_reservation              │
│ - get_availability               │
│ - get_cabinet_code               │
│ - alert_staff                    │
└──────────┬───────────────────────┘
           │
   ┌───────┴────────┐
   ▼                ▼
Cloudbeds API     Telegram Bot API
```

### Por qué Sipgate Free
Vapi no permite comprar un número con el plan actual de Luis. Workaround: importar un SIP trunk via API; Sipgate Free actúa como puente gratuito desde la SIM Android.

### Pasos para reproducir el setup
1. SIM Android con número del hostel insertada en un teléfono (puede estar guardado en cajón).
2. Configurar desvío incondicional: marcar `*21*<número_sipgate>#`.
3. Crear cuenta en **Sipgate Free** y obtener credenciales SIP.
4. En Vapi, importar el trunk SIP via API (no UI). Endpoint: `POST /phone-number` con `provider: "byo-sip-trunk"`.
5. Asignar el assistant al phone number creado.

## 2. Mensajería (chat)

```
Booking.com / WhatsApp / Email
            │
            ▼
       UpMarket (bot)
            │
            ▼
   KB en upmarket/knowledge-base.md
            │
            └── escala a humano vía Telegram si no resuelve
```

## 3. Check-in y acceso físico

```
Reserva confirmada en Cloudbeds
        │
        ▼
Vikey envía link de check-in al huésped
        │  (ley española: documento obligatorio)
        ▼
Huésped sube DNI/pasaporte
        │
        ▼
Cerradura inteligente activa 15:00 → 11:00
        │
        ├── PIN en teclado
        └── Manilla electrónica (NFC)
```

## 4. Pricing

PricePoint conecta con Cloudbeds y ajusta tarifas dinámicamente. Sin intervención manual rutinaria.

## 5. Flujo de incidencias

```
Bot detecta intent de emergencia / lock failure
        │
        ▼
alert_staff (Vapi tool) o equivalente UpMarket
        │
        ▼
Telegram Bot envía mensaje a grupo de staff
        │
        ▼
Staff responde (WhatsApp/llamada al huésped)
```
