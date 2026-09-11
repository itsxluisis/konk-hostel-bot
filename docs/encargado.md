# Encargado — Vigilancia de agentes locales

## Qué es

El Encargado es un supervisor que monitorea agentes autónomos que corren en máquinas locales (Mac de Luis). Su único trabajo: **detectar la ausencia de un agente el mismo día en que no corre**.

## Por qué existe

El facturador del Konk estuvo semanas caído sin notificar. Solo mandaba notificación de macOS al Mac local, que nadie ve si está cerrado. El Encargado soluciona esto: revisa cada 10 minutos si un agente mandó su "latido" (señal de vida) en la ventana esperada; si falta, avisa a Telegram.

Ejemplos de ventana esperada:
- **Facturador**: lunes 09:00 ± 120 min → debe latir entre 07:00 y 11:00.
- **Vigilante de cobros**: L-S 09:00 ± 120 min → debe latir en esa ventana cada día.

## Cómo funciona

### Ciclo de vida

1. **Agente local (py/node) corre** → al terminar (éxito o fallo) llama a `POST /encargado/latido`.
2. **Servidor recibe el latido** → lo guarda en `encargado.json` con timestamp.
3. **Cada 10 min, revisión** → compara la hora de Madrid contra el horario esperado de cada agente.
4. **Si falta el latido** → envía alarma a Telegram en el tema correspondiente.
5. **Si llegó tarde** → lo anota, pero no alarma (ocurre si el agente tardó más de lo esperado).

### Autenticación

Todos los endpoints usan el header `x-encargado-secret` (o fallback a `x-vapi-secret`). Si no está configurado en `.env`, la revisión periódica fuerza una autenticación HTTP Basic interna.

### Persistencia

El estado de latidos vive en `ENCARGADO_DATA_DIR/encargado.json` (por defecto `./data/encargado.json`). Persiste entre reinicios del servidor.

## Endpoints

### `POST /encargado/latido`

Un agente avisa que acaba de correr.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
Content-Type: application/json
```

**Body:**
```json
{
  "agente": "facturador-konk",
  "ok": true,
  "resumen": "Facturadas 5 reservas, 127 EUR",
  "detalle": "logs o detalles opcionales"
}
```

**Ejemplo curl:**
```bash
curl -X POST https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/latido \
  -H "x-encargado-secret: tu-secret-aqui" \
  -H "Content-Type: application/json" \
  -d '{
    "agente": "facturador-konk",
    "ok": true,
    "resumen": "Facturadas 3 reservas",
    "detalle": "Sin errores"
  }'
```

**Response (200):**
```json
{
  "ok": true,
  "id": "facturador-konk",
  "timestamp": "2026-09-10T07:45:00.000Z"
}
```

**Si `ok: false`:** genera un aviso inmediato a Telegram en el tema `TG_TEMA_ALERTAS`, sin esperar a la siguiente revisión.

---

### `GET /encargado/estado`

Consulta el estado de todos los agentes (cuándo corrieron por última vez).

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Ejemplo curl:**
```bash
curl https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/estado \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "agentes": {
    "facturador-konk": {
      "ok": true,
      "resumen": "Facturadas 5 reservas, 127 EUR",
      "timestamp": "2026-09-10T07:45:00.000Z",
      "esperado_hoy": "L 09:00 ± 120 min",
      "alerta": false,
      "dias_sin_latido": 0
    },
    "vigilante-cobros": {
      "ok": true,
      "resumen": "0 cobros sin facturar",
      "timestamp": "2026-09-10T08:30:00.000Z",
      "esperado_hoy": "L-S 09:00 ± 120 min",
      "alerta": false,
      "dias_sin_latido": 0
    }
  },
  "ultima_revision": "2026-09-10T08:45:30.000Z"
}
```

---

### `POST /encargado/revisar?seco=1`

Fuerza una revisión manual. Con `seco=1` calcula pero no envía alertas a Telegram.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Ejemplo curl:**
```bash
# Revisar en seco (sin alertar)
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/revisar?seco=1" \
  -H "x-encargado-secret: tu-secret-aqui"

# Revisar y alertar si hay faltas
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/revisar" \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "ok": true,
  "seco": true,
  "alertas": [
    {
      "agente": "facturador-konk",
      "razon": "falta de latido desde hace 2 días",
      "hora_esperada": "lunes 09:00 ± 120 min",
      "ultima_ejecucion": "2026-09-08T08:30:00.000Z",
      "enviado": false
    }
  ]
}
```

---

### `POST /encargado/parte?seco=1`

Genera el parte diario (resumen del estado del hostel basado en Cloudbeds) y lo envía a Telegram en el tema `TG_TEMA_PARTE`.

Con `?seco=1`, calcula pero no envía a Telegram, e incluye las listas crudas de llegadas y salidas en `datos.detalle` para inspeccionar los filtros.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Ejemplo curl:**
```bash
# Generar y enviar parte diario
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/parte" \
  -H "x-encargado-secret: tu-secret-aqui"

# Generar en seco (sin enviar, con detalle)
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/parte?seco=1" \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "ok": true,
  "seco": false,
  "datos": {
    "foto": {
      "timestamp": "2026-09-10T09:15:00.000Z",
      "ocupacion": {
        "ocupados": 12,
        "llegadas_hoy": 3,
        "salidas_hoy": 2,
        "se_quedan_mas": 1
      },
      "fallos": []
    },
    "texto_corto": "🏨 12 huéspedes · +3 llegadas · -2 salidas · ↗ 1 prórroga",
    "texto_largo": "...",
    "detalle": {
      "llegadas": [...],
      "salidas": [...],
      "prorrogas": [...]
    }
  },
  "enviado_a_telegram": true
}
```

**Nota:** si falla alguna consulta a Cloudbeds, el parte no dice "ocupación cero"; avisa de que no ha podido leer y explica por qué.

---

### `POST /encargado/telegram`

Webhook público que recibe eventos de Telegram. **NO usa la autenticación normal del Encargado**: se valida solo con la cabecera `x-telegram-bot-api-secret-token` que Telegram envía al registrar el webhook.

Siempre responde **200** aunque algo falle internamente, porque devolver error hace que Telegram reintente en bucle y acabe desactivando el webhook.

**Headers (enviados por Telegram):**
```
x-telegram-bot-api-secret-token: <ENCARGADO_TG_SECRET>
Content-Type: application/json
```

**Body (enviado por Telegram):**
```json
{
  "update_id": 12345,
  "message": {
    "message_id": 1,
    "from": { "id": ..., "first_name": "..." },
    "chat": { "id": <TELEGRAM_CHAT_ID>, "title": "Konk Staff" },
    "topic_id": 5,
    "text": "¿quién llega mañana?",
    "reply_to_message": { ... }
  }
}
```

**Validación (3 cerrojos):**
1. **Firma de Telegram:** cabecera `x-telegram-bot-api-secret-token` debe coincidir con `ENCARGADO_TG_SECRET` (o fallback a `ENCARGADO_SECRET` o `VAPI_SECRET`). Si no, se ignora silenciosamente.
2. **Chat correcto:** solo se atiende al chat de `TELEGRAM_CHAT_ID`. A cualquier otro chat privado, se ignora (ni siquiera se responde).
3. **Contexto de conversación:** dentro del grupo solo contesta si:
   - Está en el tema `TG_TEMA_PREGUNTAR` (si está definido), O
   - Se le menciona por su @, O
   - Responde a un mensaje suyo, O
   - El mensaje empieza por `/`, O
   - El mensaje empieza por "Encargado," (sin distinción de mayúsculas).
   
   Si no se cumplen estas condiciones, no se mete en la conversación (silencio total).

**Response (siempre 200):**
```json
{
  "ok": true
}
```

---

### `POST /encargado/registrar-escucha`

Registra el webhook en Telegram (operación única). Acepta `{"url": "https://..."}` en el body; si no se pasa, deduce la URL de la petición.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Body:**
```json
{
  "url": "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/telegram"
}
```

**Ejemplo curl:**
```bash
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/registrar-escucha" \
  -H "x-encargado-secret: tu-secret-aqui" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/telegram"}'
```

**Response (200):**
```json
{
  "ok": true,
  "url": "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/telegram",
  "registrado_en_telegram": true
}
```

---

### `GET /encargado/escucha`

Consulta el estado del webhook: si hay cerebro (Claude disponible) y cómo está configurado.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Ejemplo curl:**
```bash
curl "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/escucha" \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "ok": true,
  "cerebro": true,
  "modelo": "claude-haiku-4-5-20251001",
  "webhook_registrado": true,
  "tema_preguntas": "TG_TEMA_PREGUNTAR"
}
```

---

### `POST /encargado/preguntar`

Probar una pregunta sin pasar por Telegram. Muy útil para depurar.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Body:**
```json
{
  "pregunta": "¿quién llega mañana?"
}
```

**Ejemplo curl:**
```bash
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/preguntar" \
  -H "x-encargado-secret: tu-secret-aqui" \
  -H "Content-Type: application/json" \
  -d '{"pregunta": "¿quién llega mañana?"}'
```

**Response (200):**
```json
{
  "ok": true,
  "pregunta": "¿quién llega mañana?",
  "consulta_elegida": "quien_llega",
  "parametros": {
    "fecha": "2026-09-11"
  },
  "respuesta": "Llega Cristian (habitación 3)...",
  "modo": "cerebro"
}
```

Si no hay `ANTHROPIC_API_KEY`, el `modo` es `"palabras_clave"` y funciona igual, solo que sin conversación natural.

## Variables de entorno

| Variable | Descripción | Obligatoria | Default |
|---|---|---|---|
| `ENCARGADO_SECRET` | Secret para autenticar latidos y consultas | No | `VAPI_SECRET` |
| `ENCARGADO_DATA_DIR` | Carpeta donde guardar `encargado.json` | No | `./data` |
| `ANTHROPIC_API_KEY` | API key de Anthropic (opcional; sin ella funciona modo palabras clave) | No | — |
| `ENCARGADO_MODELO` | Modelo Claude para el cerebro del Encargado | No | `claude-haiku-4-5-20251001` |
| `ENCARGADO_TG_SECRET` | Secret que firma Telegram en el webhook | No | `ENCARGADO_SECRET` o `VAPI_SECRET` |
| `TG_TEMA_ESTADO` | ID del tema Telegram para estado general | No | Tema General |
| `TG_TEMA_PARTE` | ID del tema Telegram para parte diario | No | Tema General |
| `TG_TEMA_ALERTAS` | ID del tema Telegram para alertas | No | Tema General |
| `TG_TEMA_LLAMADAS` | ID del tema Telegram para resumen de llamadas Vapi | No | Tema General |
| `TG_TEMA_COBROS` | ID del tema Telegram para vigilante de cobros | No | Tema General |
| `TG_TEMA_FACTURAS` | ID del tema Telegram para facturador | No | Tema General |
| `TG_TEMA_PREGUNTAR` | ID del tema Telegram para preguntas y escucha | No | Tema General |

**Nota:** los `TG_TEMA_*` son **opcionales**. Si no se proporcionan, todos los mensajes van al tema General de Telegram.

**Sobre `ANTHROPIC_API_KEY`:** si no está definida, el Encargado sigue funcionando en modo "palabras clave" (empareja por keywords de la pregunta y devuelve los datos igual), solo que sin conversación natural con Claude.

---

## Acciones con confirmación — F3

### Qué es F3

El Encargado puede **proponer** acciones que modifiquen datos (re-ejecutar facturador, cambiar estado de reserva, silenciar avisos, etc.), pero **nunca se ejecutan solas**. Siempre se propone, se muestra en cristiano lo que va a pasar, y se ejecuta solo cuando Luis pulsa un botón en Telegram.

### Cómo funciona

1. **Claude propone una acción** (o alguien llama a `POST /encargado/acciones/:nombre`).
2. **Código genera la propuesta** (nunca modelo) — texto que explica qué pasará, sin dejar ambigüedad.
3. **Mensaje en Telegram con botones** — "Confirmar" / "Cancelar".
4. **Luis elige** (solo su id de Telegram puede confirmar).
5. **Se ejecuta solo si es confirmada**.
6. **Resultado se notifica** en el tema correspondiente.

### Salvaguardas (corazón de F3)

1. **Solo el jefe confirma.** Se verifica el `id` de Telegram del que pulsa el botón contra `ENCARGADO_JEFE_ID` (ids separados por coma, o configurados vía `POST /encargado/jefe`). Quien no sea el jefe recibe un aviso discreto y nada pasa.
2. **Sin jefe configurado no manda nadie.** La postura segura es la de por defecto: si `ENCARGADO_JEFE_ID` no está definido, el botón no funciona.
3. **Las propuestas caducan** a los 30 minutos (`ENCARGADO_VIDA_PROPUESTA`). Pasado ese tiempo, los botones no funcionan.
4. **No se ejecuta dos veces:** la propuesta se marca como hecha **ANTES** de ejecutar; si algo peta a medias, no se repite sola.
5. **El texto de confirmación lo escribe el código, no el modelo.** Cuando Claude pide una acción se corta el bucle y se devuelve la propuesta tal cual: lo que se va a ejecutar no puede depender de cómo lo parafrasee el modelo.
6. **Las acciones se ofrecen al modelo con prefijo `hacer_`** para que quede claro que eso no es mirar, es tocar.

### Acciones soportadas (en las fases de implementación)

**Acciones sin riesgo** (ejecutan de inmediato tras confirmar):
- `silenciar_avisos` — no alertar a Telegram de nuevos eventos hasta reactivar.
- `reactivar_avisos` — volver a alertar.
- `revisar_cobros_y_avisar` — lanzar ahora una revisión de cobros (sin esperar a las 09:00).

**Acciones de riesgo medio** (ejecutan pero marcadas visiblemente):
- `preparar_lote` — pre-calcular qué se va a facturar (lunes próximo) sin numerarlas aún. Muestra en la propuesta: cuántas reservas, período de fechas, total EUR.

**Acciones de riesgo alto** (requieren confirmación en el mensaje):
- `emitir_lote` — **ejecuta las facturas de verdad**. La propuesta muestra exactamente qué se va a numerar. Riesgo declarado: las facturas se numeran de verdad y eso no se deshace. La propuesta incluye un aviso destacado sobre esto.

### El puente con el Mac

El facturador vive en el Mac de Luis; el servidor está en la nube. La nube no puede entrar en el Mac, así que se hace al revés:

1. **Mac pregunta cada 5 minutos** — solicita al servidor si hay órdenes de trabajo.
2. **Servidor entrega una cola** — nombres de tarea de una **lista cerrada** (`facturador-konk`, `vigilante-cobros`, etc.).
3. **Mac ejecuta lo que le toca** — busca el nombre en su diccionario `TAREAS` y ejecuta el comando correspondiente.
4. **Resultado vuelve** — mac envía `POST /encargado/ordenes/:id/resultado` con `{"ok": true, "salida": "..."}`.
5. **Publicación en Telegram** — resultado sale en el tema `TG_TEMA_FACTURAS`.

**Protección:** por el puente solo viajan nombres de una lista cerrada, nunca comandos. Aunque alguien pirateara el servidor, no podría ejecutar nada fuera de esa lista en el Mac.

**Caducidad:** una orden sin recoger en 24 horas caduca (`ENCARGADO_VIDA_ORDEN`). Evita emitir facturas con mucho desfase si el Mac estuvo apagado demasiado tiempo.

**Marca de entrega:** un lote emitido queda apuntado (`loteEmitido` en el estado) para que no se pueda emitir dos veces en el mismo ciclo.

### Endpoints nuevos

#### `GET /encargado/acciones`

Qué sabe hacer el Encargado, riesgo de cada acción, y si hay jefe configurado.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Response (200):**
```json
{
  "ok": true,
  "jefe_configurado": true,
  "jefe_ids": [123456789],
  "acciones": [
    {
      "nombre": "silenciar_avisos",
      "riesgo": "bajo",
      "descripcion": "Pausar alertas a Telegram hasta reactivar"
    },
    {
      "nombre": "emitir_lote",
      "riesgo": "alto",
      "descripcion": "Numerar y emitir facturas (irreversible)"
    }
  ]
}
```

#### `POST /encargado/acciones/:nombre`

Propone una acción. Con `?ejecutar=1`, intenta ejecutarla de inmediato (requiere el secreto del servidor, no debilita seguridad porque quien tiene ese secreto ya controla el backend).

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Query parameters:**
- `ejecutar` (opcional) — si es `1`, ejecuta la acción sin esperar confirmación (administrativo).

**Response (200):**
```json
{
  "ok": true,
  "propuesta_id": "acc_abc123def456",
  "nombre": "emitir_lote",
  "riesgo": "alto",
  "texto_confirmacion": "Se van a numerar 5 facturas del período 2026-09-02 al 2026-09-08, total 1.250 EUR. Esto no se puede deshacer.",
  "estado": "pendiente_confirmacion",
  "caduca_en_minutos": 30,
  "mensaje_telegram": "..."
}
```

Si `ejecutar=1`:
```json
{
  "ok": true,
  "estado": "ejecutada",
  "resultado": "5 facturas emitidas"
}
```

#### `POST /encargado/jefe`

Configura el id (o ids) de Telegram de quien puede confirmar acciones.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Body:**
```json
{
  "ids": [123456789, 987654321]
}
```

**Response (200):**
```json
{
  "ok": true,
  "jefe_ids": [123456789, 987654321]
}
```

#### `GET /encargado/quien-escribe`

Devuelve los ids de Telegram que el Encargado ha visto escribir en el grupo. Útil para descubrir el id del jefe sin adivinarlo.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Response (200):**
```json
{
  "ok": true,
  "usuarios_vistos": [
    { "id": 123456789, "nombre": "Luis", "ultima_vez": "2026-09-10T10:30:00Z", "es_jefe": true },
    { "id": 987654321, "nombre": "María", "ultima_vez": "2026-09-10T09:15:00Z", "es_jefe": false }
  ]
}
```

#### `GET /encargado/ordenes?agente=facturador-konk`

Lo que el Mac puede recoger en su próximo sondeo (cada 5 minutos).

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Response (200):**
```json
{
  "ok": true,
  "agente": "facturador-konk",
  "ordenes": [
    {
      "id": "ord_xyz789",
      "tarea": "emitir_lote",
      "parametros": { "fecha_inicio": "2026-09-02", "fecha_fin": "2026-09-08" },
      "creada": "2026-09-10T09:30:00Z"
    }
  ]
}
```

#### `POST /encargado/ordenes/:id/resultado`

El Mac reporta lo que hizo.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Body:**
```json
{
  "ok": true,
  "salida": "Emitidas 5 facturas: KH26-558 a KH26-562, total 1.250 EUR"
}
```

**Response (200):**
```json
{
  "ok": true,
  "id": "ord_xyz789",
  "marcada_como_entregada": true,
  "enviado_a_telegram": true
}
```

#### `GET /encargado/ordenes/todas`

Resumen de todas las órdenes y caducidades.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Response (200):**
```json
{
  "ok": true,
  "total_ordenes": 15,
  "pendientes_recogida": 2,
  "caducadas_sin_recoger": 1,
  "entregadas": 12,
  "ultimas": [
    { "id": "ord_xyz789", "tarea": "emitir_lote", "estado": "entregada", "creada": "2026-09-10T09:30:00Z" }
  ]
}
```

### Variables de entorno nuevas

| Variable | Descripción | Default |
|---|---|---|
| `ENCARGADO_JEFE_ID` | IDs de Telegram de quien confirma (separados por coma) | Sin valor (sin jefe = no se ejecuta nada) |
| `ENCARGADO_VIDA_PROPUESTA` | Minutos que vive una propuesta antes de caducar | 30 |
| `ENCARGADO_VIDA_ORDEN` | Horas que vive una orden antes de caducarse si el Mac no la recoge | 24 |

## Archivos

### Vigilancia de latidos (F0)

- `src/encargado/config.js` — definición de agentes vigilados y sus horarios.
- `src/encargado/reloj.js` — hora de Madrid (el servidor corre en UTC).
- `src/encargado/estado.js` — persistencia en `encargado.json`.
- `src/encargado/vigilancia.js` — lógica pura de detección (`debeAlertar()`) y scheduler.
- `src/encargado/latidos.js` — router Express para los endpoints `/encargado/latido`, `/encargado/estado`, `/encargado/revisar`.
- `src/encargado/index.js` — función `montar(app)` para registrar el módulo.

### Parte diario (F1)

- `src/encargado/recolector.js` — lee el estado actual del Konk de Cloudbeds. Solo lectura: consulta `getReservations` con filtros de fecha. Si una consulta falla, anota el error en `foto.fallos` y sigue adelante (el parte nunca asume que los datos están incompletos; lo reporta).
- `src/encargado/parte.js` — funciones puras que convierten la foto de Cloudbeds en texto. Exporta `estadoFijado()` (resumen corto para el mensaje fijado, ej. "🏨 12 huéspedes") y `parteDiario()` (resumen largo con detalles).
- `src/encargado/agenda.js` — reloj de ejecución automática: envía el parte diario a las 09:15 hora de Madrid (configurable con `ENCARGADO_HORA_PARTE`) y refresca el mensaje de ESTADO fijado cada hora. Persiste la marca "ya enviado hoy" en disco para que un redespliegue no lo repita.

### Consultas y cerebro (F2)

- `src/encargado/consultas.js` — catálogo de consultas que sabe responder (solo lectura):
  - `estado_del_dia(fecha)` — ocupación, llegadas, salidas, prórrogas.
  - `quien_llega(fecha)` — huéspedes que llegan en una fecha.
  - `quien_se_va(fecha)` — huéspedes que se van en una fecha.
  - `quien_esta_dentro(fecha)` — huéspedes dentro en una fecha.
  - `buscar_huesped(nombre)` — busca las reservas de una persona por su nombre.
  - `por_canal(canal, fecha)` — quién está alojado viniendo de un canal (Booking, Airbnb, Expedia, web, walk-in). Resuelve preguntas como "el de Airbnb". Si ese canal no aparece, dice cuáles hay ese día.
  - `como_va_el_equipo()` — si los agentes (facturador, vigilante) han corrido y qué han hecho. Sin parámetros.
  - `revisar_cobros()` — lanza ahora una revisión de cobros y devuelve lo que encuentre, sin avisar al grupo. Sin parámetros.
  
  Las fechas aceptan "hoy", "mañana", "ayer" o formato AAAA-MM-DD. Cada entrada contiene su función, descripción y esquema de parámetros para que Claude las use como tools.

- `src/encargado/cerebro.js` — entiende la pregunta en lenguaje natural. Con `ANTHROPIC_API_KEY` usa Claude pasándole las consultas como herramientas (tool use). Sin clave sigue funcionando: empareja por palabras clave y devuelve los mismos datos, solo que sin conversación. Si el cerebro falla, cae al modo simple en vez de quedarse callado.

- `src/encargado/escucha.js` — el webhook de Telegram. Valida firma, filtra chat y contexto, desambigua la pregunta y llama al cerebro.

### Acciones con confirmación (F3)

- `src/encargado/acciones.js` — motor de acciones: `proponer(nombre, parametros)` genera una propuesta JSON con id único, texto de confirmación (escrito en código, nunca por modelo), y botones para Telegram. `confirmar(propuesta_id, id_usuario)` verifica que sea el jefe, marca como entregada antes de ejecutar, y devuelve el resultado. `cancelar(propuesta_id)` anula una propuesta pendiente. También exporta `botones()` y `mensaje()` para formatear en Telegram.

- `src/encargado/acciones-basicas.js` — implementación de acciones sin riesgo:
  - `silenciar_avisos(parametros)` — pausar alertas del Encargado a Telegram hasta reactivar.
  - `reactivar_avisos(parametros)` — volver a alertar.
  - `revisar_cobros_y_avisar(parametros)` — lanzar una revisión de cobros ahora (sin esperar a las 09:00) y devolver lo encontrado.

- `src/encargado/acciones-facturas.js` — acciones sobre facturación:
  - `preparar_lote(parametros)` — pre-calcular lote (fecha inicio, fecha fin) sin numerarlas. Devuelve propuesta con: cuántas reservas, período, total EUR. Riesgo **medio**.
  - `emitir_lote(parametros)` — **ejecutar** las facturas de verdad, numerarlas y notificar al Mac. Riesgo **alto**: las facturas se numeran y eso no se deshace. El Mac es quien las genera de verdad; en `emitir_lote()` se crea la orden y se espera el resultado del Mac.

- `src/encargado/ordenes.js` — cola de encargos para agentes locales. Funciones:
  - `crear_orden(tarea, parametros)` — añade a la cola una orden con nombre de tarea cerrado.
  - `leer_ordenes_pendientes(agente)` — el Mac consulta cada 5 min.
  - `marcar_entregada(orden_id)` — después que el Mac hace el trabajo.
  - `reportar_resultado(orden_id, ok, salida)` — Mac manda resultados.
  - `limpiar_caducadas()` — rutina interna cada 10 min para purgar órdenes de >24 horas.
  - `get_todas()` — para diagnosticar.

### Bloquear y desbloquear camas (F3 completado y verificado 11-sep-2026)

- `src/encargado/inventario.js` — gestión del inventario de camas del Konk. Funciones puras:
  - `camas(soloBloqueadas)` — devuelve array con todas las camas o solo las bloqueadas; caché de 10 minutos desde Cloudbeds.
  - `elegir(lista, texto)` — función pura que busca UNA cama en la lista por nombre exacto (sin tildes ni mayúsculas); si encaja con varias o ninguna, devuelve `null`.
  - `buscar(texto)` — busca en el inventario actual; si hay ambigüedad, devuelve la lista; si hay una coincidencia, devuelve la cama.
  - `resumen()` — resumen breve: "31 camas, 3 bloqueadas" (solo lectura).
  
  **Inventario real del Konk (11-sep-2026):** 31 unidades:
  - **Compartidas (26 camas):** R2(1..6) tipo "Habitación Compartida/Privada 6" (6 camas); R4(1..6) tipo "Habitación compartida/privada 6" (6 camas); H9(1..6) tipo "Habitación compartida / privada mujeres 6" (dormitorio femenino, 6 camas); R5(1..4) tipo "Habitación Compartida/Privada 4" (4 camas); R8(1..4) tipo "Habitación compartida/privada 4" (4 camas).
  - **Privadas (5 habitaciones):** Room 1 (Doble); Room 7 (Doble); Room 10 (Doble con entrada independiente); "Room 6 parejas" (litera matrimonio, 2 ó 4 personas); R3(1) (Doble adaptada para minusválidos).
  - **Nota sobre conteo:** R4 y H9 no aparecían en la primera página de `getRooms` (trampa de paginado: la API devuelve solo 20 por defecto). Tras paginar correctamente se ven los 31 reales. Se cuenta lo físico, no el nombre del tipo.

- `src/encargado/acciones-camas.js` — acciones para cambiar estado de camas:
  - `bloquear_cama(parametros)` — bloquea un rango de fechas en una cama concreta. Riesgo **alto** porque cierra esa cama; se escribe de verdad en Cloudbeds API endpoint `postRoomBlock` con `roomBlockID` único. Propuesta muestra: nombre de la cama, fechas exactas, razón del bloqueo.
  - `desbloquear_cama(parametros)` — levanta un bloqueo existente llamando a `deleteRoomBlock` por su `roomBlockID`. Riesgo **medio** porque es reversible (el bloqueo se borra, la cama vuelve a estar libre). Propuesta muestra: cama, cuál bloqueo se va a deshacer. **Confirmado 11-sep:** el endpoint funciona con el token del Konk; no se requieren permisos especiales fuera de los normales del PMS.

- Consulta nueva en `src/encargado/consultas.js`:
  - `que_camas_hay(soloBloqueadas)` — solo lectura: lista todas las camas o solo las que están bloqueadas en Cloudbeds en la fecha actual o en un rango. Sin parámetros toca que es un booleano true/false.

### Escribir en Cloudbeds — cinco trampas verificadas en producción (11-sep-2026)

**Trampa 0: Cloudbeds pagina TODO lo que lista.** `getRooms`, `getReservations`, `getTransactions`, `getRoomBlocks` devuelven solo la primera página si no se especifican `pageNumber` y `pageSize`. El error no se nota porque los datos parecen completos: están los primeros N registros, pero faltan los demás. Ejemplo real: `getRooms` sin paginar devolvía 20 camas (count: 20, total: 31); dos dormitorios enteros —el femenino H9 y el R8— y la sexta cama del R4 no existían para el encargado. Afectaba también a `getReservations` en el recolector: el parte diario mira 60 días de entradas, pero si solo ve la primera página, pierde gente si hay más. **Solución:** comparar siempre `count` con `total`. Si `count < total`, hay más páginas. El módulo `src/encargado/paginado.js` exporta `todas(endpoint, params)` que recorre automáticamente todas las páginas (tamaño 100, corta cuando una página es más corta que el tamaño o al alcanzar `total`). Lo usan `inventario.js`, `recolector.js` y `consultas.js`. Verificado 11-sep-2026: fue la causa de que R4 y H9 desaparecieran.

**Trampa 1: Formato de POST.** Cloudbeds admite POST en `x-www-form-urlencoded` (key1=value1&key2=value2) pero **rechaza JSON** con error HTTP 200 + `{"success": false, "message": "Parameter X is required"}` para un parámetro que sí va puesto. El servidor (`src/cloudbeds.js`) convierte los POST a form-urlencoded automáticamente; los GET siguen siendo querystring normal.

**Trampa 2: Éxito aparente.** Cloudbeds **responde siempre HTTP 200**, incluso cuando la acción falló. Ejemplo: bloquear una cama que ya está bloqueada da `{"success": false, "message": "..."}`. Hay que leer **siempre** el campo `success` del body, no solo el código HTTP. El servidor devuelve `{ok: true, success: false, message: "..."}` si algo fue mal; todo handler debe revisar `success`.

**Trampa 3: `roomBlockType` es obligatorio y restringido.** El parámetro `roomBlockType` es obligatorio en `postRoomBlock` y solo admite exactamente estos tres valores:
- `out_of_service` (avería, limpieza; es el predeterminado usado por el Konk)
- `blocked_dates` (bloqueadas por disponibilidad/cerrado)
- `courtesy_hold` (reserva de cortesía)

Cualquier otro valor se rechaza con HTTP 200 + `{"success": false}`. Se puede elegir con el parámetro `tipo` de `bloquear_cama()` o con la variable de entorno `CLOUDBEDS_TIPO_BLOQUEO`.

**Trampa 4: Arrays en notación de corchetes PHP, no JSON.** Los `rooms[]` deben ir en formato `x-www-form-urlencoded` con **notación de corchetes PHP**:
```
rooms[0][roomID]=404780-1&rooms[0][quantity]=1
```
**NO** como JSON dentro de un campo:
```javascript
rooms: [{ roomID: "404780-1", quantity: 1 }]
```
Si se manda como JSON, Cloudbeds responde "At least one room is required" aunque el campo esté completamente puesto. `src/cloudbeds.js` ya aplana automáticamente cualquier array u objeto en los POST.

**Parámetros de `postRoomBlock` (verificados 11-sep):** requiere `startDate` (AAAA-MM-DD), `endDate` (AAAA-MM-DD), `rooms` (en notación de corchetes PHP), `roomBlockType` (enum: `out_of_service`, `blocked_dates`, `courtesy_hold`), y opcionalmente `roomBlockReason` (texto descriptivo).

**Identificación única del bloqueo:** cada bloqueo tiene un `roomBlockID` único. Se usa `roomBlockID` para consultarlo con `getRoomBlocks` y para borrarlo con `deleteRoomBlock`. **No se identifica por roomID ni por fechas**: dos bloqueos distintos pueden tapar el mismo `roomID` en períodos solapados o diferentes.

### Consultar y gestionar bloqueos

**`GET /encargado/cloudbeds/bloqueos`** — lista todos los bloqueos en un rango de fechas (solo lectura).

**Query parameters:**
- `desde` (opcional) — fecha de inicio en AAAA-MM-DD (por defecto hoy).
- `hasta` (opcional) — fecha de fin en AAAA-MM-DD (por defecto 120 días adelante).
- `crudo` (opcional) — si es `1`, devuelve la respuesta tal cual de Cloudbeds sin procesar.

**Ejemplo curl:**
```bash
curl "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/cloudbeds/bloqueos?desde=2026-09-11&hasta=2026-12-31" \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "ok": true,
  "bloqueos": [
    {
      "roomBlockID": "abc123def456",
      "roomID": "404780-1",
      "startDate": "2026-09-15",
      "endDate": "2026-09-18",
      "roomBlockType": "out_of_service",
      "roomBlockReason": "Limpieza profunda"
    }
  ]
}
```

**Nota sobre rangos:** `getRoomBlocks` de Cloudbeds no admite rangos de más de 35 días. `src/encargado/inventario.js` recorre el período por tramos de 30 días y deduplica por `roomBlockID` porque los tramos se solapan. Por defecto consulta 120 días hacia adelante.

**Nota sobre la lectura de bloqueos:** el campo `roomBlocked` de `getRooms` significa "bloqueada HOY", no "tiene bloqueos futuros". Un bloqueo para el mes que viene no marca `roomBlocked: true` hoy. Por eso las consultas de estado usan `getRoomBlocks` en lugar de `getRooms`.

---

**`POST /encargado/cloudbeds/bloqueos/:id/borrar`** — borra un bloqueo existente por su `roomBlockID` (requiere autenticación administrativa).

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Ejemplo curl:**
```bash
curl -X POST "https://rentalme-konk-bot-webhook.sklshk.easypanel.host/encargado/cloudbeds/bloqueos/abc123def456/borrar" \
  -H "x-encargado-secret: tu-secret-aqui"
```

**Response (200):**
```json
{
  "ok": true,
  "roomBlockID": "abc123def456",
  "borrado": true
}
```

---

### Comprobar permisos sin escribir nada

Endpoints auxiliares que validan acceso sin modificar datos:

- **`GET /encargado/cloudbeds/permisos`** — llama a cada endpoint de escritura con un id imposible (ej. `roomID: 999999`). Resultado:
  - HTTP 403 o mensaje sobre "scope" → **falta permiso**.
  - HTTP 400 o `success: false` quejándose de **datos** → **permiso OK**, es un dato incorrecto.
  - En el Konk (11-sep-2026): bloquear/desbloquear camas, registrar cobros y notas en reservas están permitidos; modificar reservas da 404; enlaces de pago no verificados. **Desbloquear (`deleteRoomBlock`) confirmado funcional con el token del Konk.**

- **`GET /encargado/cloudbeds/camas`** — vuelca el inventario crudo de Cloudbeds sin procesar (solo lectura).

### Tests para selección de camas

- `test/camas.test.js` — 8 casos sobre la función `elegir()`:
  - Coincidencia exacta: "R2(1)" → elige R2(1).
  - Sin tildes: "habitación" → ignora tildes en el inventario.
  - Ambigüedad: "R2" → devuelve null, el encargado pregunta cuál ("¿R2(1) a R2(6)?").
  - Nombres compuestos: "Room 6 parejas" → coincide exacto.
  - Rechazo de parciales: "Room" → no elige nada (podría ser Room 1, 7, 10 o "Room 6 parejas").
  - Con inventario real del Konk (31 camas).

### Tests para acciones de camas

`test/camas.test.js` — 8 casos sobre elegir la cama correcta, con el inventario
real del Konk:
- El nombre exacto manda: "R2(1)" no se confunde con "R2(10)".
- Se compara sin tildes ni mayúsculas.
- Ante la duda NO elige: "R2" devuelve las seis candidatas y pregunta.
- Un tipo entero ("Compartida/Privada 6") también es ambiguo.
- Lo que no existe se dice claro, y sin nombre no adivina.
- Una privada con tipo único ("entrada independiente") sí se resuelve sola.

Las salvaguardas de la confirmación (solo el jefe, caducidad, no ejecutar dos
veces) están en `test/acciones.test.js` y valen para todas las acciones,
incluidas las de camas.

### Tests

- `test/encargado.test.js` — 27 casos para F0 y F1; ejecutar con `node test/encargado.test.js`.
- `test/escucha.test.js` — 18 casos para F2 (validación de webhook, autenticación, filtro de chat/contexto, elección de consulta); ejecutar con `node test/escucha.test.js`.
- `test/acciones.test.js` — 12+ casos para F3:
  - Propuesta se crea con id único y texto generado en código.
  - Solo el jefe (id en `ENCARGADO_JEFE_ID`) puede confirmar.
  - Sin jefe configurado no se ejecuta nada.
  - Propuestas caducan a los 30 minutos.
  - No se ejecuta dos veces (marca como hecha antes de ejecutar).
  - Confirmación falla si la propuesta es desconocida o ya expirada.
  - Las acciones sin riesgo se ejecutan de inmediato tras confirmar.
  - Bloquear cama: propuesta clara, sin ejecutarse dos veces.
  - Desbloquear cama: igual, marcada como reversible.
- `test/ordenes.test.js` — 8 casos para la cola de encargos:
  - Orden se crea y se marca entregada solo por el agente correcto.
  - Órdenes caducadas (>24 h) se limpian automáticamente.
  - Resultado se reporta y persiste en disco.
  - `leer_ordenes_pendientes()` devuelve solo las de ese agente.
- `test/camas.test.js` — 8 casos para elegir cama correcta:
  - Coincidencia exacta, ambigüedad, rechazos.
  - Con inventario real del Konk.

## Seguridad del webhook de Telegram (F2)

El webhook es una puerta pública. Tres cerrojos evitan que cualquiera abuse:

### 1. Firma de Telegram
Telegram firma cada aviso con un secreto que solo nosotros conocemos. La cabecera `x-telegram-bot-api-secret-token` debe coincidir con `ENCARGADO_TG_SECRET` (con fallbacks a `ENCARGADO_SECRET` o `VAPI_SECRET`). Si no, se ignora silenciosamente. **No se devuelve error** porque Telegram reintentaría y acabaría desactivando el webhook.

### 2. Chat correcto
Solo se atiende al chat de `TELEGRAM_CHAT_ID` (grupo de staff del Konk). A cualquier otro chat privado donde alguien encuentre el bot, silencio total: ni se contesta, ni se registra, ni se alerta.

### 3. Contexto de conversación
Dentro del grupo solo contesta si:
- Está en el tema `TG_TEMA_PREGUNTAR` (si está definido), O
- Se le menciona por su @ (`@encargado_bot` u otro), O
- Responde a un mensaje suyo, O
- El mensaje empieza por `/` (comando), O
- El mensaje empieza por "Encargado," (sin distinción de mayúsculas).

Si no se cumplen estas condiciones, **no se mete en conversaciones ajenas**. El silencio es intencionado: evita ruido innecesario y ahorros de tokens.

---

## Datos, no órdenes

Lo que escriben las personas en el grupo se trata como **DATO**, nunca como órdenes. Todas las consultas actuales (F2) son de **solo lectura** y ninguna modifica nada en Cloudbeds:
- ¿Quién llega? → Solo lee reservas de Cloudbeds.
- ¿Quién está dentro? → Solo lee estado de ocupación.
- ¿Revisar cobros? → Solo consulta el estado sin marcar nada.

Cuando llegue **F3 (acciones)**, la confirmación será explícita: el Encargado pedirá aprobación por Telegram antes de ejecutar cualquier acción que modifique datos (re-ejecutar facturador, cambiar estatus de una reserva, etc.).

---

## Ejemplos de preguntas que entiende

Incluso sin `ANTHROPIC_API_KEY` (modo palabras clave), el Encargado reconoce y contesta:

- **Llegadas:** "¿Quién llega mañana?", "llega hoy", "dame llegadas"
- **Salidas:** "Quién se va hoy", "salidas mañana", "quién se marcha"
- **Ocupación:** "Cuánta gente hay dentro", "cuántos hay ahora", "quiénes están"
- **Parte:** "Dame el parte", "resumen del día", "estado del hostel"
- **Equipo:** "Cómo va el equipo", "¿ha corrido el facturador?", "estado de agentes"
- **Cobros:** "Revisa los cobros", "qué cobros pendientes", "estado de pagos"
- **Búsqueda:** "Busca a Cristian", "dónde está María", "información de Juan"

La precisión mejora con Claude (si `ANTHROPIC_API_KEY` está), pero el fallback de palabras clave mantiene la funcionalidad básica.

---

## Cómo añadir un agente nuevo a la vigilancia

1. **Editar `src/encargado/config.js`** — añadir entrada en `AGENTES`:
   ```javascript
   'mi-agente': {
     nombre: 'Mi agente',
     que: 'lo que hace, en una línea (sale en el aviso)',
     dias: [1, 2, 3, 4, 5],        // 0=domingo, 1=lunes ... 6=sábado
     horaEsperada: '14:00',        // hora de Madrid
     margenMin: 120,               // minutos de tolerancia antes de avisar
     tema: 'ALERTAS',              // clave de TEMAS, no el nombre de la variable
   },
   ```

   El campo `tema` es una clave del mapa `TEMAS` que hay más abajo en el mismo
   archivo (`ESTADO`, `PARTE`, `ALERTAS`, `LLAMADAS`, `COBROS`, `FACTURAS`,
   `PREGUNTAR`). Cada una se rellena con su variable `TG_TEMA_*`. Si el agente
   no encaja en ninguna, usa `ALERTAS`.

2. **Crear o editar `latido.py`** en el proyecto del agente local:
   ```python
   # Sin dependencias, urllib solo
   import urllib.request
   import json
   import os
   
   def latir(agente_id, ok, resumen, detalle=""):
       url = os.getenv("ENCARGADO_URL", "")
       secret = os.getenv("ENCARGADO_SECRET", "")
       if not url or not secret:
           return  # No está configurado, pasa
       
       data = json.dumps({
           "agente": agente_id,
           "ok": ok,
           "resumen": resumen,
           "detalle": detalle
       }).encode('utf-8')
       
       req = urllib.request.Request(
           url + "/encargado/latido",
           data=data,
           headers={"x-encargado-secret": secret, "Content-Type": "application/json"},
           method="POST"
       )
       try:
           with urllib.request.urlopen(req, timeout=5) as resp:
               pass  # Fire and forget
       except:
           pass  # Si el servidor está caído, no romper la rutina

   # En main():
   # ...
   latir("mi-agente", True, "Procesadas 50 cosas", "Sin errores")
   ```

3. **Configurar `.env` del agente local:**
   ```
   ENCARGADO_URL=https://rentalme-konk-bot-webhook.sklshk.easypanel.host
   ENCARGADO_SECRET=el-secret-del-konk
   ```

4. **Si hay errores detectables**, pasar `ok=False`:
   ```python
   latir("mi-agente", False, "Error de red", "ConnectionError en línea 42")
   ```
   Esto genera un aviso inmediato en `TG_TEMA_ALERTAS`.

5. **Reiniciar el servidor del Konk** para que `config.js` se recargue.

## Decisiones de diseño de F1

El parte diario es fiable porque:

### 1. No se fía del filtro de fechas de Cloudbeds
Se pide `checkOutFrom`/`checkOutTo`, pero la API devuelve reservas que no lo cumplen, así que los filtros se aplican en nuestro lado. Si la respuesta no cuadra con lo solicitado, queda un aviso en el log. Sin esto, el parte contaba como salidas a gente que acababa de entrar.

### 2. Cero por no haber podido preguntar no es cero de verdad
Si falla alguna consulta a Cloudbeds, el parte **no dice** "el hostel está vacío"; dice que no ha podido leer y explica por qué. El mensaje fijado muestra "Datos incompletos" en lugar de cifras.

### 3. Prórrogas
En el hostel es corriente que alguien alargue la estancia registrada como una reserva nueva: sale hoy y entra hoy. Contarlo como salida + llegada da una imagen falsa del movimiento. Se cruzan por nombre (normalizado: sin tildes, sin importar el orden de nombre y apellido) y se muestran en la línea "se quedan más días". Limitación conocida: dos huéspedes distintos con el mismo nombre se confundirían, pero el error sería solo de presentación.

### Otros detalles de implementación

- El parte solo se envía dentro de una ventana de 3 horas desde su hora esperada. Si el servidor arranca por la tarde, no dispara un "parte de la mañana" a deshora.
- La marca "ya enviado hoy" vive en disco (`encargado.json`) para que un redespliegue no repita el envío.
- El mensaje de ESTADO se fija una sola vez y luego se reescribe en sitio (`telegram.edit()` + `telegram.pin()`), en lugar de acumular mensajes.
- El parte lee también el estado del vigilante de cobros (ahora en `src/vigilante.js`, ver abajo) y solo lo menciona si hay algo que decir: que esté apagado, o que su última revisión no sea de hoy.

## Vigilante de cobros — cambio de arquitectura

⚠️ **El vigilante de cobros ya no corre en el Mac.** Se reescribió en Node/Express y corre en este mismo backend (`src/vigilante.js`), programado L-S a las 09:00 hora de Madrid. El LaunchAgent del Mac se retiró el 10-sep-2026 para evitar dos vigilantes avisando por duplicado.

El único agente que sigue en el Mac es el **Facturador Konk** (lunes).

---

## Los siete carriles — Organización de temas en Telegram (10-sep-2026)

El grupo de Telegram del Konk se llama **"Konk alertas"** (supergrupo). Tiene los **Temas** (Topics) activados, y el encargado creó siete carriles, cada uno con su cometido:

| Tema | ID | Qué llega ahí |
|---|---|---|
| 📌 Estado | 969 | El mensaje fijado que se reescribe en sitio |
| 🛎️ Parte diario | 970 | El parte de las 09:15 |
| ⚠️ Alertas | 971 | Agente caído, e incidencias de huéspedes del bot de voz |
| 📞 Llamadas | 972 | Resumen de cada llamada (end-of-call-report) |
| 💰 Cobros | 973 | El vigilante de cobros |
| 🧾 Facturas | 974 | El facturador |
| 💬 Preguntar | 975 | Las preguntas a Claude y sus respuestas |

### Cómo funciona `src/encargado/temas.js`

- **Telegram permite CREAR temas por API** (`createForumTopic`) **pero NO listarlos.** Por eso los IDs de los temas que crea el encargado se guardan en disco (`encargado.json`, campo `temas`).
- **`idDe(clave)`** resuelve el ID del tema: primero mira la variable de entorno `TG_TEMA_<CLAVE>` (que siempre prevalece), luego lo guardado en disco. Si no hay nada, devuelve `null` y el mensaje cae en el tema General.
- **Se eliminó el mapa `TEMAS`** que había en `config.js`: era una segunda fuente de verdad leída del entorno al arrancar. Ahora los IDs se crean en caliente y se guardan.

### Endpoints para gestionar temas

#### `GET /encargado/temas`

Consulta si el grupo tiene Temas activados y a dónde va cada cosa.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Response (200):**
```json
{
  "ok": true,
  "grupo_tiene_temas": true,
  "chat_id": -1001234567890,
  "temas": {
    "ESTADO": 969,
    "PARTE": 970,
    "ALERTAS": 971,
    "LLAMADAS": 972,
    "COBROS": 973,
    "FACTURAS": 974,
    "PREGUNTAR": 975
  }
}
```

Si `grupo_tiene_temas: false`, el grupo aún no tiene activados los Temas. Ver más abajo.

#### `POST /encargado/temas`

Crea los carriles que falten. Es **idempotente**: si algunos ya existen, los deja y crea solo los ausentes.

**Headers:**
```
x-encargado-secret: <ENCARGADO_SECRET>
```

**Parámetro opcional `?rehacer=1`:** crea todos los carriles de nuevo, dejando huérfanos los anteriores (usar con cuidado).

**Response (200):**
```json
{
  "ok": true,
  "creados": {
    "ESTADO": 969,
    "PARTE": 970,
    "ALERTAS": 971,
    "LLAMADAS": 972,
    "COBROS": 973,
    "FACTURAS": 974,
    "PREGUNTAR": 975
  },
  "ya_existentes": {}
}
```

**Response (409) si el grupo no tiene Temas activados:**
```json
{
  "ok": false,
  "error": "El grupo no tiene Temas habilitados",
  "mensaje": "Activa los Temas en los ajustes del grupo (Editar → Temas) y reintenta"
}
```

### Activar los Temas es manual

**No se puede por API.** Hay que hacerlo en los ajustes del grupo (Editar → Temas), y el bot necesita el permiso de administrador **"Gestionar temas"**. Una vez activados, las siguientes llamadas a `POST /encargado/temas` crean los carriles.

Nota útil: si el grupo ya es supergrupo, activar los Temas **NO cambia el `chat_id`**.

### Enrutado de avisos que no son del encargado

Se enrutaron también los mensajes del bot de voz y el vigilante de cobros a sus carriles:

- **Incidencias de huéspedes** (del bot de voz) → tema **Alertas**
- **Resúmenes de llamada** (end-of-call-report) → tema **Llamadas**
- **Vigilante de cobros** → tema **Cobros**

Todos usan `require('./encargado').hilo('CLAVE')` con carga perezosa y **try/catch**: si el encargado no está montado o algo falla, devuelve `null` y el mensaje cae en General como siempre. **Ningún aviso se pierde** por esto.

### Un mensaje no se puede mover de tema

El mensaje de ESTADO fijado guarda en qué carril está. Si el carril cambia (por ejemplo al crear los temas, cuando el fijado estaba en General), **se crea de nuevo en el lugar correcto y se desancla el anterior**, para no dejar arriba un anclado congelado con datos obsoletos.

---

## Fases completadas y pendientes

### F0: ✅ Vigilancia de latidos (base)
Detección de ausencia de agentes locales (facturador-konk, vigilante-cobros) con revisiones cada 10 minutos. Alarma a Telegram si faltan latidos esperados. Completada.

### F1: ✅ Parte diario y mensaje de ESTADO fijado (10-sep-2026)
Resumen diario del estado del hostel (ocupación, llegadas, salidas, prórrogas) a las 09:15 y refresco del mensaje fijado cada hora. Incluye datos sobre el vigilante de cobros. Completada.

### F2: ✅ Escucha de Telegram y respuesta inteligente (10-sep-2026)
El Encargado atiende preguntas en el grupo de Telegram por webhook. Entiende consultas en lenguaje natural (con Claude si `ANTHROPIC_API_KEY` está, modo palabras clave si no). Consultas soportadas: estado del día, quién llega/se va/está dentro, búsqueda de huésped, estado del equipo, revisión de cobros. Validación de seguridad en 3 niveles (firma de Telegram, chat correcto, contexto de conversación). Completada.

### F3: ✅ Acciones con confirmación (completada 10-sep-2026, verificada en producción 11-sep-2026)
El Encargado propone acciones, las muestra en cristiano en Telegram, y Luis confirma antes de ejecutar. Tres salvaguardas claves: solo el jefe confirma (verificación de id), propuestas caducan a los 30 minutos, y no se ejecutan dos veces (marcada antes de ejecutar). Acciones desplegadas: silenciar/reactivar avisos, revisar cobros, preparar lote de facturas (riesgo medio), emitir lote de facturas (riesgo alto), **bloquear cama (riesgo alto)**, **desbloquear cama (riesgo medio)**. Puente con Mac: servidor entrega órdenes por API (cada 5 min), Mac ejecuta y reporta resultado. Escritura en Cloudbeds acotada a bloquear/desbloquear camas; **ciclo completo verificado 11-sep-2026 (bloquear → ver → desbloquear por nombre → limpio)**. Se conocen las cuatro trampas de Cloudbeds (formato POST, lectura de `success`, `roomBlockType` obligatorio, arrays en corchetes PHP) y se proporcionan herramientas de diagnóstico (`GET /encargado/cloudbeds/permisos`, `GET /encargado/cloudbeds/camas`, `GET /encargado/cloudbeds/bloqueos`).

**Arquitectura y flujo completados y verificados en producción.** Nota operativa sobre **EasyPanel**: si se pulsa Deploy justo después de un push, a veces construye el penúltimo commit. Solución: un commit vacío + push fuerza el redespliegue correcto. El auto-deploy por webhook se durmió tras ~25 despliegues en un día.

Pendientes administrativos: rotar las claves (`VAPI_API_KEY`, `VAPI_SECRET`, `ANTHROPIC_API_KEY`) que fueron compartidas en sesiones anteriores. Ampliaciones futuras sin confirmar: modificar reservas (el endpoint `putReservation` da 404, probablemente se llama de otra forma) y enlaces de pago.

### Pendientes administrativos
- ✅ **Crear los 7 temas en el grupo de Telegram** del Konk (Estado, Parte, Alertas, Llamadas, Cobros, Facturas, Preguntar) — **Hecho el 10-sep-2026.**
- ✅ **F3 arquitectura e implementación** — **Hecho el 10-sep-2026.** Motor de acciones, salvaguardas, puente con Mac, endpoints, tests.
- ✅ **Bloquear y desbloquear camas desde F3** — **Hecho el 11-sep-2026 y verificado en producción.** Inventario del Konk, `src/encargado/inventario.js`, `src/encargado/acciones-camas.js`, cuatro trampas de Cloudbeds documentadas (formato POST, `success`, `roomBlockType`, arrays en corchetes PHP), herramientas de diagnóstico (`GET /encargado/cloudbeds/bloqueos`, endpoints de borrado). Ciclo completo: bloquear → ver → desbloquear por nombre → limpio. Confirmado: `deleteRoomBlock` funciona con token del Konk.
- Rellenar `TG_TEMA_*` en `.env` de EasyPanel con los IDs de los temas (ya están, consultables con `GET /encargado/temas`).
- **Rotar las claves** `VAPI_API_KEY`, `VAPI_SECRET`, `ANTHROPIC_API_KEY` (fueron compartidas accidentalmente en sesiones anteriores). **Pendiente.**

## Tests

**F0 y F1 (vigilancia y parte):**
```bash
node test/encargado.test.js
```
27 casos: vigilancia de latidos (horarios cruzados, atrasados, faltas), parte diario (recolección de datos, cálculo de ocupación, prorrogas, manejo de fallos), generación de textos, persistencia y scheduling.

**F2 (escucha de Telegram):**
```bash
node test/escucha.test.js
```
18 casos: validación de webhook (firma de Telegram, chat correcto, contexto de conversación), elección de consulta según la pregunta, fallback a modo palabras clave, ejemplos de preguntas reales.

**F3 (acciones con confirmación):**
```bash
node test/acciones.test.js
node test/ordenes.test.js
```
12 casos en `acciones.test.js`: propuestas con id único, texto generado en código, verificación de jefe, expiración a los 30 minutos, ejecución una sola vez, fallback cuando no hay jefe. 8 casos en `ordenes.test.js`: creación de órdenes, entrega al Mac correcto, limpieza automática de órdenes caducadas (>24 h), reportes de resultado.
