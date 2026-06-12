# Konk Hostel — Base de Conocimiento (UpMarket)

> Documento fuente para el bot de mensajería UpMarket. **Idioma: Español.**
> Sube esta KB al panel de UpMarket o sincronízala vía API.

---

## Sobre el hostel

**Konk Hostel** está en La Manga del Mar Menor (Murcia, España). Es un hostel **100% remoto**: no hay recepción física ni personal en el sitio. Todo se gestiona online.

## Check-in y check-out

- **Check-in:** 15:00. **Check-out:** 11:00.
- **No se aceptan check-in tempranos ni check-out tardíos bajo ningún concepto.** Sin excepciones.
- El check-in es **online vía Vikey**: te llega un enlace al hacer la reserva. Por ley española, debes subir tu documento de identidad antes de que se active el acceso.
- La cerradura se activa automáticamente entre las 15:00 del día de llegada y las 11:00 del día de salida.
- Vikey funciona de dos formas: **PIN en teclado** o **manilla electrónica** (NFC). En ambos casos necesitas datos móviles en el teléfono.

## Equipaje

- Tienes **lockers individuales dentro de la habitación durante tu estancia**.
- **No guardamos equipaje después del check-out.** Ni en recepción (no hay), ni en zonas comunes. Sin excepciones.

## Servicios que NO ofrecemos

- No hay bar ni restaurante.
- No hacemos transfers desde aeropuerto/estación.
- No alquilamos bicicletas.

## Sistema de armarios de emergencia

Si por alguna razón Vikey falla (sin batería en el móvil, sin datos, etc.) hay armarios físicos con llaves de respaldo:

- **Armario exterior inferior** — en la entrada principal del edificio.
- **Armario exterior superior** — en la habitación con acceso independiente.
- **Armarios interiores numerados** — uno por cada habitación.

Los códigos son distintos según el tipo de habitación:

- Habitaciones privadas: `{{CABINET_CODE_PRIVATE_*}}`
- Dormitorios compartidos de 4: `{{CABINET_CODE_DORM4_*}}`
- Dormitorios compartidos de 6: `{{CABINET_CODE_DORM6_*}}`
- Exteriores: `{{CABINET_CODE_EXT_LOWER}}` / `{{CABINET_CODE_EXT_UPPER}}`

> **Nunca compartas un código sin verificar antes la reserva del huésped.** Si tienes dudas, escala vía `alert_staff` (o equivalente en UpMarket).

## Reservas nuevas

- Las reservas nuevas se hacen online en **haztureserva.app** (no se gestionan por chat ni por teléfono).
- También se puede reservar a través de Booking.com.

## Pagos y modificaciones

- Pagos: gestionados por el canal donde se hizo la reserva (haztureserva.app o Booking.com).
- Cambios de fecha o cancelaciones: según las políticas del canal donde se hizo la reserva. Reservas de konkhostel.es/haztureserva.app: email a reservas@konkhostel.es (gratis con más de 3 días de antelación; 100% de cargo dentro de los 3 días previos a la entrada).

## Contacto y emergencias

- Para incidencias urgentes (fallo de cerradura, problema de seguridad), responde por chat o llama al número del hostel.
- Para emergencias médicas o de seguridad, llama al **112**.

## Localización

- La Manga del Mar Menor, Murcia, España.
- Dirección exacta: `{{HOSTEL_ADDRESS}}`.
- Cómo llegar: `{{DIRECTIONS_NOTES}}`.

## Preguntas frecuentes (machacar respuestas)

**¿Puedo hacer check-in antes de las 15:00?**
No. Sin excepciones. La cerradura se activa exactamente a las 15:00.

**¿Puedo dejar las maletas después del check-out?**
No. Sin excepciones. Te recomendamos consignas en estaciones cercanas.

**¿Hay desayuno?**
No tenemos servicio de bar/cocina. Hay supermercados y cafeterías cerca.

**¿Tenéis parking?**
`{{PARKING_INFO}}`.

**¿Aceptáis mascotas?**
`{{PETS_POLICY}}`.

---

> Marcadores `{{...}}` deben rellenarse antes de subir la KB a producción.
