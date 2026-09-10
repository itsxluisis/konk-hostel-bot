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
  - `buscar_huesped(nombre)` — búsqueda por nombre de huésped.
  - `como_va_el_equipo(fecha)` — resumen de si los agentes (facturador, vigilante) han reportado hoy.
  - `revisar_cobros(fecha)` — estado de cobros de Cloudbeds sin facturar.
  
  Las fechas aceptan "hoy", "mañana", "ayer" o formato AAAA-MM-DD. Cada entrada contiene su función, descripción y esquema de parámetros para que Claude las use como tools.

- `src/encargado/cerebro.js` — entiende la pregunta en lenguaje natural. Con `ANTHROPIC_API_KEY` usa Claude pasándole las consultas como herramientas (tool use). Sin clave sigue funcionando: empareja por palabras clave y devuelve los mismos datos, solo que sin conversación. Si el cerebro falla, cae al modo simple en vez de quedarse callado.

- `src/encargado/escucha.js` — el webhook de Telegram. Valida firma, filtra chat y contexto, desambigua la pregunta y llama al cerebro.

### Tests

- `test/encargado.test.js` — 27 casos para F0 y F1; ejecutar con `node test/encargado.test.js`.
- `test/escucha.test.js` — 18 casos para F2 (validación de webhook, autenticación, filtro de chat/contexto, elección de consulta); ejecutar con `node test/escucha.test.js`.

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

## Fases completadas y pendientes

### F0: ✅ Vigilancia de latidos (base)
Detección de ausencia de agentes locales (facturador-konk, vigilante-cobros) con revisiones cada 10 minutos. Alarma a Telegram si faltan latidos esperados. Completada.

### F1: ✅ Parte diario y mensaje de ESTADO fijado (10-sep-2026)
Resumen diario del estado del hostel (ocupación, llegadas, salidas, prórrogas) a las 09:15 y refresco del mensaje fijado cada hora. Incluye datos sobre el vigilante de cobros. Completada.

### F2: ✅ Escucha de Telegram y respuesta inteligente (10-sep-2026)
El Encargado atiende preguntas en el grupo de Telegram por webhook. Entiende consultas en lenguaje natural (con Claude si `ANTHROPIC_API_KEY` está, modo palabras clave si no). Consultas soportadas: estado del día, quién llega/se va/está dentro, búsqueda de huésped, estado del equipo, revisión de cobros. Validación de seguridad en 3 niveles (firma de Telegram, chat correcto, contexto de conversación). Completada.

### F3: Que actúe (con confirmación)
El Encargado recibiría confirmación de Luis por Telegram y dispararía agentes remotamente (re-ejecutar facturador, cambiar estado de reserva, etc.) sin intervención manual del Mac. Todas las acciones requerirán confirmación explícita antes de ejecutarse. **Pendiente.**

### Pendiente administrativo
- Crear los **7 temas en el grupo de Telegram** del Konk (Estado, Parte, Alertas, Llamadas, Cobros, Facturas, Preguntar).
- Rellenar `TG_TEMA_*` en `.env` de EasyPanel con los IDs de los temas.
- Registrar el webhook en Telegram ejecutando `POST /encargado/registrar-escucha`.

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
