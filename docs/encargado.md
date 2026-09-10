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

- `src/encargado/config.js` — definición de agentes vigilados y sus horarios.
- `src/encargado/reloj.js` — hora de Madrid (el servidor corre en UTC).
- `src/encargado/estado.js` — persistencia en `encargado.json`.
- `src/encargado/vigilancia.js` — lógica pura de detección (`debeAlertar()`) y scheduler.
- `src/encargado/latidos.js` — router Express para los endpoints.
- `src/encargado/index.js` — función `montar(app)` para registrar el módulo.
- `test/encargado.test.js` — 10 casos de test; ejecutar con `node test/encargado.test.js`.

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

## Pendiente / fases siguientes

### F1: Parte diario
El Encargado debería enviar un resumen diario (ej. 09:30) mostrando qué agentes corrieron ayer y cuál falta por correr hoy. Útil para darse cuenta el lunes que el facturador de la semana pasada no llegó a terminar.

### F2: Preguntar por Telegram
En lugar de solo alertar, el Encargado podría preguntar "¿Te doy permiso para re-ejecutar el facturador?" vía botón en Telegram, y re-dispararía el agente sin tocar el Mac.

### F3: Que actúe
El Encargado recibiría confirmación de Luis por Telegram y dispararía el agente remotamente vía SSH o API local, sin intervención manual del Mac.

## Test

```bash
node test/encargado.test.js
```

10 casos: horarios cruzados, latidos atrasados, faltas detectadas, resolución de alertas, persistencia.
