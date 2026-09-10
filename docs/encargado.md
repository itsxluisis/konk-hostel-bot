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

## Variables de entorno

| Variable | Descripción | Obligatoria | Default |
|---|---|---|---|
| `ENCARGADO_SECRET` | Secret para autenticar latidos y consultas | No | `VAPI_SECRET` |
| `ENCARGADO_DATA_DIR` | Carpeta donde guardar `encargado.json` | No | `./data` |
| `TG_TEMA_ESTADO` | ID del tema Telegram para estado general | No | Tema General |
| `TG_TEMA_PARTE` | ID del tema Telegram para parte diario | No | Tema General |
| `TG_TEMA_ALERTAS` | ID del tema Telegram para alertas | No | Tema General |
| `TG_TEMA_LLAMADAS` | ID del tema Telegram para resumen de llamadas Vapi | No | Tema General |
| `TG_TEMA_COBROS` | ID del tema Telegram para vigilante de cobros | No | Tema General |
| `TG_TEMA_FACTURAS` | ID del tema Telegram para facturador | No | Tema General |
| `TG_TEMA_PREGUNTAR` | ID del tema Telegram para acciones que requieren aprobación | No | Tema General |

**Nota:** los `TG_TEMA_*` son **opcionales**. Si no se proporcionan, todos los mensajes van al tema General de Telegram.

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

### Tests

- `test/encargado.test.js` — 27 casos; ejecutar con `node test/encargado.test.js`.

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

## Pendiente / fases siguientes

### F1: ✅ Parte diario y mensaje de ESTADO fijado (10-sep-2026)
Hecho y en producción. Genera un resumen diario del estado del hostel (ocupación, llegadas, salidas, prórrogas) a las 09:15 y refresca el mensaje fijado cada hora. Incluye datos sobre el vigilante de cobros.

### F2: Preguntar por Telegram
El Encargado podría preguntar "¿Te doy permiso para re-ejecutar el facturador?" vía botón en Telegram, y re-dispararía el agente sin tocar el Mac. Requiere webhook entrante para recibir respuestas.

### F3: Que actúe
El Encargado recibiría confirmación de Luis por Telegram y dispararía el agente remotamente vía SSH o API local, sin intervención manual del Mac.

### Pendiente administrativo
- Crear los **7 temas en el grupo de Telegram** del Konk (Estado, Parte, Alertas, Llamadas, Cobros, Facturas, Preguntar).
- Rellenar `TG_TEMA_*` en `.env` de EasyPanel con los IDs de los temas.

## Test

```bash
node test/encargado.test.js
```

27 casos: vigilancia de latidos (horarios cruzados, atrasados, faltas), parte diario (recolección de datos, cálculo de ocupación, prorrogas, manejo de fallos), generación de textos, persistencia y scheduling.
