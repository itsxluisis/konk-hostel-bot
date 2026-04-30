# Operativa — Konk Hostel

> Reglas duras de operación. Esto se aplica al prompt de Vapi, a la KB de UpMarket y a cualquier respuesta humana.

## Política sin excepciones

- **Check-in: 15:00.** No early check-in. La cerradura no se abre antes.
- **Check-out: 11:00.** No late check-out. La cerradura se desactiva.
- **Equipaje post check-out: NO.** Lockers solo durante la estancia.
- **Sin servicios:** sin bar, sin transfers, sin alquiler de bicis.

## Check-in via Vikey

1. Reserva confirmada → Vikey envía link automático al huésped.
2. Huésped sube documento de identidad (obligatorio por ley española).
3. Cerradura activa entre 15:00 día llegada y 11:00 día salida.
4. Móvil del huésped necesita **datos móviles** para abrir.
5. Modos: **PIN** (teclado) o **manilla electrónica** (NFC).

### Si Vikey falla
- Huésped sin batería → códigos de armario físico (ver abajo).
- Documento no subido → bloquear acceso, escalar a staff.

## Sistema de armarios de emergencia

| Armario | Ubicación | Quién lo usa | Placeholder |
|---|---|---|---|
| Exterior inferior | Entrada principal | Cualquiera con acceso al edificio | `{{CABINET_CODE_EXT_LOWER}}` |
| Exterior superior | Habitación con acceso independiente | Huéspedes de esa habitación | `{{CABINET_CODE_EXT_UPPER}}` |
| Interior privadas | Dentro de cada habitación privada | Huésped asignado | `{{CABINET_CODE_PRIVATE_<n>}}` |
| Interior dormitorio 4 | Dentro de cada dorm de 4 | Huéspedes asignados | `{{CABINET_CODE_DORM4_<n>}}` |
| Interior dormitorio 6 | Dentro de cada dorm de 6 | Huéspedes asignados | `{{CABINET_CODE_DORM6_<n>}}` |

> **Nunca dar un código sin verificar reserva.** En Vapi: tras `check_reservation` exitoso → `get_cabinet_code`. En UpMarket: equivalente humano si la KB no resuelve.

## Reservas

- **Nuevas reservas:** solo Booking.com (la pasarela directa está en reconstrucción).
- **PMS:** Cloudbeds.
- **Modificaciones / cancelaciones:** según política del canal.

## Escalación a humano

Disparadores que **siempre** escalan vía Telegram:

- Emergencia médica / fuego / seguridad.
- Fallo de cerradura.
- Documento de check-in rechazado / no subido a tiempo.
- Quejas que requieren respuesta personal.
- Cualquier situación fuera del playbook.

## Contactos / numeración

- Número público del hostel: `{{HOSTEL_PHONE}}`
- WhatsApp staff: `{{WHATSAPP_NUMBER}}`
- Telegram bot token / chat id: ver `.env`.
