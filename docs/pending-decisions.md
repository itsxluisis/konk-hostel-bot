# Decisiones pendientes — Konk Hostel

> Lista corta de decisiones que bloquean producción. Resuelve antes de poner el asistente Vapi en vivo.

## 1. Webhook `check_reservation` (BLOQUEANTE — riesgo de seguridad)

**Problema:** el bot Vapi tiene una tool `check_reservation` que llama a un endpoint que **no existe**. Resultado: el modelo alucina verificaciones positivas y comparte códigos de armario sin validar al huésped.

**Opciones:**

- **A) Desplegar endpoint mínimo bloqueante (recomendado).**
  - Implementar `server/webhooks/check_reservation.js` (placeholder ya creado).
  - Conectar a Cloudbeds API (ver `.env.example`).
  - Hosting: Vercel / Cloud Run / Railway.
  - Tiempo estimado: 2–4 h si la API key de Cloudbeds está lista.

- **B) Desactivar verificación a nivel de prompt (temporal).**
  - Editar `vapi/system-prompt.md` → quitar la tool `check_reservation` y reemplazar el flujo por: "Por seguridad no podemos compartir códigos por teléfono. Le hemos enviado los datos por email." + `alert_staff`.
  - Sin riesgo de alucinación, pero degrada la UX.
  - Tiempo: 15 min.

**Decisión esperada:** Luis. Hasta entonces, **no activar el asistente en el número público**.

---

## 2. Regenerar API key de Vapi

**Problema:** la API key de Vapi se compartió accidentalmente en una conversación anterior.

**Acción:**
1. Entrar en `vapi.ai → Account → API Keys`.
2. Revocar la key comprometida.
3. Generar una nueva.
4. Actualizar en `.env` y en el panel admin.

**Estado:** sin confirmar. Comprobar en cuanto sea posible.

---

## 3. Integración Cloudbeds API

**Problema:** la pasarela directa de reservas está siendo rehecha. Mientras tanto, todas las reservas pasan por Booking.com.

**Pendiente:**
- Confirmar credenciales de Cloudbeds API (OAuth o API key).
- Definir qué endpoints se usan: `getReservations`, `getRooms`, `getRatePlans`, `postReservation`.
- Diseñar UI / flujo de pago directo (probablemente Stripe).

---

## 4. Rellenar placeholders de códigos de armario

**Dónde:**
- `vapi/system-prompt.md` — buscar `{{CABINET_CODE_*}}`.
- `upmarket/knowledge-base.md` — mismos placeholders.
- `docs/operations.md` — referencia.

**Acción:** sustituir por los códigos reales **solo en el destino (Vapi/UpMarket)**, **no en el repo** (no commitear códigos físicos).

Mejor flujo: mantener placeholders en el repo y resolverlos vía variables de entorno o vía el panel admin al desplegar.
