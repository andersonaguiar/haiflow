

# haiflow

**h**ooks · **ai** · **flow**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Claude Code](https://img.shields.io/badge/Claude-Code-cc785c?logo=anthropic)](https://docs.anthropic.com/en/docs/claude-code)
[![n8n](https://img.shields.io/badge/n8n-EA4B71?logo=n8n&logoColor=white)](https://n8n.io)
[![tmux](https://img.shields.io/badge/tmux-1BB91F?logo=tmux&logoColor=white)](https://github.com/tmux/tmux)
[![GitHub stars](https://img.shields.io/github/stars/andersonaguiar/haiflow)](https://github.com/andersonaguiar/haiflow)

Ejecuta [Claude Code](https://docs.anthropic.com/en/docs/claude-code) como un agente de IA sin interfaz (headless) a través de HTTP: sin costes de clave de API, sin SDK, solo tu suscripción existente a Claude Code.

Haiflow envuelve Claude Code en sesiones de tmux y expone una API REST para activar prompts, poner trabajos en cola y capturar respuestas. Automatiza cualquier cosa que puedas hacer en Claude Code: generación de código, refactorización, triaje de errores, informes diarios, desde cualquier cliente HTTP.

> **¿Por qué no usar la API de Claude?** Claude Code incluye el uso de herramientas, acceso a archivos, integración con git y tus habilidades personalizadas de forma nativa. Haiflow te permite automatizar todo eso a través de HTTP sin pagar costes de API por token. Usa n8n, cron, webhooks o cualquier herramienta de automatización para controlarlo.

![demo](assets/demo.gif?v=2)

```
POST /trigger ───┐
                 │        ┌────────────────┐
             ┌───▼───┐    │  tmux session  │
             │ Queue ├───>│   (claude)     │
             │ (FIFO)│    └───────┬────────┘
             └───────┘            │
                           hooks fire on
                           session events
                                  │
                          ┌───────▼────────┐
                          │    Responses   │
                          └───────┬────────┘
                                  │
GET /responses/:id <──────────────┤
                                  │
GET /responses/:id/stream <───────┘  (SSE)
```

### Pipeline de agentes

Encadena agentes juntos con pub/sub basado en eventos. Cada agente se suscribe a los temas que le interesan y emite eventos al terminar: sin dependencias codificadas entre agentes.

```
Design Agent ──emit──▶ design.ready ──subscribe──▶ Developer Agent
Developer    ──emit──▶ code.ready   ──subscribe──▶ Code Reviewer
Reviewer     ──emit──▶ review.done  ──subscribe──▶ QA Agent
```

Consulta [Pipeline](#pipeline) para la configuración.

## Compatibilidad de plataformas

Solo macOS y Linux. Windows aún no es compatible (haiflow depende de tmux y scripts de shell POSIX).

## Requisitos previos

- [Bun](https://bun.sh) v1.2.3+
- [tmux](https://github.com/tmux/tmux)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [jq](https://jqlang.github.io/jq/)
- [Redis](https://redis.io/) — *opcional*, habilita la persistencia de eventos y los reintentos de entrega. Sin él, los eventos de la pipeline se ejecutan pero no se persisten. Ejecútalo con `docker run -d -p 6379:6379 redis`.

## Inicio rápido

### Línea única (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/andersonaguiar/haiflow/main/install.sh | bash
```

Instala Bun si falta, verifica `tmux`/`jq`/`claude`/`redis`, instala la CLI `haiflow` globalmente y configura los hooks de Claude Code.

```bash
export HAIFLOW_API_KEY=your-secret
haiflow serve                                      # run the server
haiflow init /path/to/your/project                 # in another shell: wires hooks, starts a session, runs a smoke test
```

`haiflow init` es la forma más rápida de tener una configuración funcional: instala los hooks, inicia una sesión, ejecuta un prompt de prueba (smoke-test) y te informa inmediatamente si los hooks no están conectados (el error silencioso #1). Para verificar el estado en cualquier momento, ejecuta `haiflow doctor` o `GET /doctor`. ¿Prefieres hacerlo manualmente? Usa `haiflow start worker --cwd /path/to/your/project`.

Omite la configuración de hooks con `HAIFLOW_SKIP_SETUP=1`. Fuerza el registro de npm con `HAIFLOW_INSTALL_METHOD=npm`. Inspecciona el script antes de hacerle pipe si lo prefieres: `curl -fsSL .../install.sh | less`.

### Desde el código fuente

```bash
git clone https://github.com/andersonaguiar/haiflow.git
cd haiflow
bun install      # also installs Claude Code hooks automatically
cp .env.example .env
# Edit .env and set HAIFLOW_API_KEY to any secret string you choose
bun run dev      # starts server with hot reload
```

### Pruébalo

```bash
export HAIFLOW_API_KEY="your-secret-key"

# Start a Claude session
curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "worker", "cwd": "/path/to/your/project"}'

# Send a prompt
curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "explain this codebase", "session": "worker", "id": "my-task"}'

# Poll for the response
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/responses/my-task?session=worker" | jq .

# Watch Claude work (read-only)
tmux attach -t worker -r

# Stop the session
curl -X POST http://localhost:3333/session/stop \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "worker"}'
```

O usa la CLI:

```bash
bun run bin/haiflow.ts start worker --cwd /path/to/your/project
bun run bin/haiflow.ts trigger "explain this codebase" --session worker
bun run bin/haiflow.ts status worker
bun run bin/haiflow.ts stop worker
```

## Configuración

### 1. Instalar dependencias

```bash
bun install
```

### 2. Instalar hooks

Haiflow utiliza [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) para rastrear el estado de la sesión. El comando de configuración fusiona la configuración de los hooks en `~/.claude/settings.json`:

```bash
bun run setup
```

Los hooks son reenviadores HTTP ligeros: hacen POST de eventos de Claude Code al servidor de haiflow. Si el servidor no está en ejecución, no hacen nada (no-op) silenciosamente. No interferirán con sesiones de Claude no orquestadas (el servidor ignora IDs de sesión desconocidos).

### 3. Configurar entorno (opcional)

```bash
cp .env.example .env
```

| Variable | Predeterminado | Descripción |
|----------|---------|-------------|
| `PORT` | `3333` | Puerto del servidor HTTP |
| `HAIFLOW_ENV` | `development` | Entorno de despliegue (`development`/`production`; recurre a `NODE_ENV`). En `production`, haiflow se cierra con fallo al iniciar si la exposición es insegura y rechaza una clave débil o de relleno. Dev es permisivo (no requiere túnel). |
| `HAIFLOW_HOST` | `127.0.0.1` | Dirección de enlace. Loopback por defecto para que el origen solo sea accesible a través de un proxy frontal/túnel: una capa de identidad no puede omitirse accediendo directamente al puerto. Un enlace público en producción requiere `HAIFLOW_ALLOW_PUBLIC_BIND=true`. Consulta [DEPLOYMENT.md](DEPLOYMENT.md). |
| `HAIFLOW_ALLOW_PUBLIC_BIND` | `false` | Reconoce un enlace público (`0.0.0.0`/LAN/IP pública) en producción: tú haces firewall del puerto y ejecutas tu propia capa de identidad. Sin ello, la producción se niega a iniciar cuando está enlazada públicamente. |
| `HAIFLOW_DATA_DIR` | `/tmp/haiflow` | Directorio para el estado de la sesión, colas y respuestas |
| `HAIFLOW_PORT` | `3333` | Puerto utilizado por los scripts de hook (establece si es diferente de PORT) |
| `HAIFLOW_API_KEY` | — | **Requerido.** Cualquier cadena que elijas: es tu propio secreto, no una clave de pago. En `production` debe tener ≥24 caracteres y no ser un marcador. |
| `HAIFLOW_CWD` | — | Cuando se establece, cada sesión se ve obligada a usar este directorio de trabajo. El campo `cwd` en los cuerpos de solicitud de `/session/start` se ignora (se registra una advertencia si difiere). |
| `HAIFLOW_ALLOW_REQUEST_CWD` | `true` | Cuando es `false`, `/session/start` rechaza solicitudes que intentan establecer su propio `cwd`; en su lugar, `HAIFLOW_CWD` debe configurarse en el servidor. |
| `HAIFLOW_GUARDRAILS` | `true` | Instala `~/.claude/skills/haiflow-guardrails/SKILL.md` al arrancar el servidor e inyecta `/haiflow-guardrails` en cada nueva sesión de tmux. La habilidad instruye a Claude para que rechace rutas fuera del directorio de trabajo, se niegue a leer secretos y rechace la exfiltración por red. |
| `REDIS_URL` | `redis://localhost:6379` | **Requerido.** URL de Redis para persistencia de eventos y seguimiento de entregas |
| `HAIFLOW_START_READY_TIMEOUT_MS` | `15000` | Cuánto tiempo espera `/session/start` a que el hook SessionStart vincule un ID de sesión de Claude antes de fallar (una sesión que nunca se vincule descartaría silenciosamente cada respuesta; generalmente significa que los hooks no están conectados) |
| `HAIFLOW_ALLOW_TRIGGER_CALLBACK` | `false` | Habilita el webhook de completado `callbackUrl` por `/trigger`. Desactivado por defecto porque una URL de devolución arbitraria es una superficie de SSRF |
| `HAIFLOW_CALLBACK_ALLOW_HOSTS` | — | Lista blanca opcional de hosts separados por comas para `callbackUrl`. Al establecerlo, las devoluciones a cualquier otro host se rechazan con `400` |
| `N8N_API_KEY` | — | Clave de API de n8n para integración de flujos de trabajo |
| `HAIFLOW_USAGE_ALERT_TOKENS` | — | Cuando se establece, `GET /usage/window` marca `alert: true` una vez que el total de tokens de las últimas 5h lo supera (solo alerta, nunca ralentiza) |
| `HAIFLOW_TASK_TIMEOUT_SEC` | `0` | Tiempo de espera estricto opcional por tarea. `0` lo desactiva. El watchdog marca las tareas que lo exceden |
| `HAIFLOW_WAITING_GRACE_SEC` | `120` | Cuánto tiempo puede permanecer bloqueada una sesión marcada como `waiting` por el hook de Notificación de Claude antes de que actúe el watchdog |
| `HAIFLOW_WATCHDOG_RECOVER` | `false` | Cuando es `true`, el watchdog recupera automáticamente una sesión atascada (Escape, marcar `timed_out`, drenar). Predeterminado: solo alerta |
| `HAIFLOW_MAP_MAX_ITEMS` | `200` | Máximo de elementos que una llamada `POST /map` puede distribuir en un grupo |
| `HAIFLOW_MAP_TIMEOUT_SEC` | `1800` | Cuánto tiempo espera una ejecución de map a los rezagados antes de que el reducer se ejecute con resultados parciales |

## Autenticación

> 🔒 Para el modelo de amenazas completo, límites de confianza, capas de defensa en profundidad y lista de verificación de endurecimiento, consulta **[SECURITY.md](SECURITY.md)**.

`HAIFLOW_API_KEY` es requerido: elige cualquier cadena que te guste (p. ej., `openssl rand -hex 32`). No es una clave de terceros ni una credencial de pago, solo un secreto que defines para proteger tu servidor.

**Por qué importa esto:** Sin autenticación, cualquiera que pueda acceder a tu servidor podría enviar prompts arbitrarios a Claude Code ejecutándose con acceso completo a archivos y git. Esto significa leer tu código fuente, modificar archivos, ejecutar comandos de shell o exfiltrar datos, todo a través de una simple solicitud HTTP.

### Redacción de secretos

Como medida de defensa en profundidad contra que el agente imprima un secreto que leyó durante la depuración, haiflow ejecuta un paso de redacción de "mejor esfuerzo" sobre cada texto saliente (respuestas, mensajes de pipeline, webhooks, respuestas de chat) antes de que salga del sistema. Elimina formatos de credenciales conocidos (claves de AWS/GitHub/Stripe/Google/Anthropic/OpenAI, JWTs, tokens Bearer, bloques de clave privada), reemplazando cada uno por `[REDACTED:type]` y registrando un contador. Está activado por defecto (desactívalo con `HAIFLOW_REDACT=false`); los correos electrónicos son opt-in (`HAIFLOW_REDACT_EMAILS=true`); añade tus propios patrones con `HAIFLOW_REDACT_EXTRA`. Esto es DLP de "mejor esfuerzo", no un firewall: no detectará un secreto codificado o reestructurado, y solo reescribe texto saliente, nunca los archivos que el agente escribe dentro de su directorio de trabajo.

### Token Bearer

El servidor se negará a iniciar sin él. Todos los endpoints de la API (excepto `/health` y `/hooks/*`) requieren un encabezado `Authorization`:

```bash
curl -H "Authorization: Bearer your-secret-key" http://localhost:3333/sessions
```

Los hooks están excluidos de la autenticación ya que provienen de Claude Code ejecutándose localmente: las solicitudes a `/hooks/*` están restringidas a localhost.

### Exposición a internet

Si necesitas acceder a haiflow de forma remota (desde n8n cloud, webhooks, etc.), consulta [DEPLOYMENT.md](DEPLOYMENT.md) para una guía sobre cómo configurar Cloudflare Zero Trust Access: añade una capa de identidad para que una clave de API robada no sea suficiente por sí sola.

## Documentación

La documentación completa para desarrolladores se encuentra en [`docs/`](docs/), un sitio [Mintlify](https://mintlify.com) buscable que cubre el inicio rápido, cada endpoint (con un playground interactivo generado desde `docs/openapi.json`), el servidor MCP, nodos de n8n, pipelines, grupos de trabajadores, despliegue y seguridad. Previsualízalo localmente:

```bash
cd docs && npx mint dev   # http://localhost:3000
```

## API

Consulta [API.md](API.md) para la referencia completa de la API: todos los endpoints, parámetros y ejemplos. La misma superficie también se publica como referencia interactiva en el [sitio de documentación](docs/).

## Panel de control

Haiflow incluye un panel web integrado para monitorear y controlar sesiones en tiempo real.

```
http://localhost:3333/dashboard
```

Introduce tu `HAIFLOW_API_KEY` para autenticarte, luego obtendrás un diseño de dos paneles:

- **Panel izquierdo** — todas las sesiones con insignias de estado en vivo (inactivo/ocupado/desconectado), elimina sesiones desconectadas con ×
- **Panel derecho** — prompt actual (cuando está ocupado), vista con pestañas de Cola/Respuestas/Historial con elementos expandibles que muestran el texto completo del prompt y la respuesta
- **Pestaña Historial** — línea de tiempo de herramientas/comandos/diffs de cada tarea, uso de tokens, duración y "costo de API evitado", más ventanas de uso móviles de 5h/7d (consulta [Historial de tareas y ahorros](#task-history--savings))
- **Terminal en vivo** — de solo lectura por defecto; haz clic en **Tomar control** para cambiar a un adjuntamiento editable y escribir directamente en una sesión atascada desde el navegador (protegido por la clave de API; desactiva con `HAIFLOW_ALLOW_TAKEOVER=false`). Mientras mantienes el control, el drenaje automático se pausa para que la cola no sobrescriba tu entrada
- **Acciones** — iniciar/detener sesiones, enviar prompts, limpiar cola/respuestas

El panel se actualiza automáticamente cada 3 segundos. No se necesita configuración adicional: lo sirve el mismo servidor Bun.

## Historial de tareas y ahorros

Cada tarea se registra en un libro contable SQLite duradero (`haiflow.db` en `HAIFLOW_DATA_DIR`). Al completarse, haiflow extrae la misma transcripción de Claude Code que analiza para el hook Stop y almacena lo que la tarea realmente hizo: las llamadas a herramientas en orden, comandos ejecutados, archivos modificados, diffs reales, uso de tokens, modelo y tiempos. Consulta datos mediante `GET /tasks`, `GET /tasks/:id` y `GET /responses/:id/timeline`, o explóralos en la pestaña Historial del panel.

Dado que haiflow se ejecuta con una suscripción plana a Claude Code, las tareas no cuestan nada por token. `GET /usage` y `GET /usage/window` informan sobre el consumo de tokens medido en ventanas móviles de 5 horas y 7 días (las ventanas de límite de tasa de la suscripción) junto con el costo equivalente de API que habría pagado un cliente por token: el ahorro que la herramienta existe para ofrecer. La cifra en dólares es una estimación basada en una tabla de precios mantenida, no una factura. Establece `HAIFLOW_USAGE_ALERT_TOKENS` para obtener una bandera de solo alerta cuando la ventana de 5h cruza un umbral (nunca ralentiza el trabajo).

> Nota sobre durabilidad: el libro contable reside en `HAIFLOW_DATA_DIR`, que por defecto es `/tmp/haiflow` y se borra al reiniciar. Apúntalo a un directorio persistente para conservar el historial entre reinicios.

## Registro (Logging)

Haiflow emite registros JSON estructurados a stdout/stderr para todos los eventos clave:

```jsonl
{"ts":"2026-03-18T02:35:00Z","level":"info","event":"server_started","port":3333,"auth":true}
{"ts":"2026-03-18T02:35:01Z","level":"info","event":"session_started","session":"worker","cwd":"/app"}
{"ts":"2026-03-18T02:35:02Z","level":"info","event":"trigger_sent","session":"worker","taskId":"task-001"}
{"ts":"2026-03-18T02:35:09Z","level":"info","event":"response_saved","session":"worker","taskId":"task-001","source":"transcript"}
{"ts":"2026-03-18T02:35:10Z","level":"warn","event":"auth_rejected","path":"/trigger"}
```

Eventos: `server_started`, `sessions_recovered`, `stale_prompts_swept`, `sessions_pruned`, `session_started`, `session_start_cwd_defaulted`, `session_stopped`, `session_start_failed`, `trigger_sent`, `trigger_queued`, `trigger_deduped`, `trigger_failed`, `queue_drained`, `queue_cleared`, `queue_item_removed`, `queue_item_reprioritized`, `task_cancelled`, `response_saved`, `stream_opened`, `hook_session_start`, `hook_stop`, `hook_session_end`, `hook_notification`, `interrupt_sent`, `watchdog_triggered`, `watchdog_recovered`, `auth_rejected`, `redis_connected`, `redis_disconnected`, `redis_unavailable`, `event_published`, `event_published_direct`, `pipeline_dispatched`, `pipeline_queued`, `pipeline_subscriber_offline`, `pipeline_circular_skipped`, `pipeline_prompt_too_large`, `pipeline_webhook_sent`, `pipeline_webhook_failed`, `publish_unknown_topic`, `publish_unauthorized`, `pool_dispatched`, `map_started`, `map_progress`, `map_reduced`, `map_reduced_partial`, `ingest_triggered`, `ingest_published`, `ingest_rejected`, `ingest_replay`, `ingest_replay_unavailable`, `shutdown`, `unhandled_rejection`, `uncaught_exception`.

## Cómo funciona

1. **`POST /session/start`** inicia Claude en una sesión de tmux desconectada con `--permission-mode auto`
2. **`POST /trigger`** envía prompts mediante `tmux send-keys` (o los pone en cola si está ocupado) y asigna un ID de tarea
3. **Los hooks de Claude Code** reenvían eventos del ciclo de vida (inicio, prompt, detención, fin) al servidor de haiflow mediante HTTP
4. Al completar la tarea, el servidor extrae los mensajes del asistente de la transcripción de la sesión y los guarda indexados por ID de tarea
5. **`GET /responses/:id`** devuelve la respuesta una vez completada, o el estado `pending`/`queued` mientras está en curso
6. La cola se drena automáticamente: cuando Claude termina una tarea, el siguiente prompt en cola se envía automáticamente

### Gestión del contexto

El llenado de contexto no es un problema con haiflow. Cada sesión está vinculada a la tarea actual: una vez que la tarea se completa, la sesión puede cerrarse limpiamente sin contexto residual. Pero esto es opcional: si la sesión sigue siendo saludable, haiflow la mantiene activa para que el contexto se acumule entre tareas, dando a Claude más conciencia del trabajo anterior en la misma sesión. Si el contexto se llena, la siguiente tarea simplemente inicia una sesión nueva.

## Ejemplos de integración

Haiflow funciona con cualquier herramienta que pueda realizar solicitudes HTTP. Aquí hay algunos ejemplos:

### n8n (plantillas de flujo de trabajo de ejemplo incluidas)

Importa el flujo de cálculo encadenado desde `examples/chained-calc/`:
- `chained-calc-step1.json` — Paso 1: calcular 2+2
- `chained-calc-step2.json` — Paso 2: multiplicar el resultado por 5
- `chained-calc-step3.json` — Paso 3: multiplicar el resultado por 10
- `pipeline-calc-chain.json` — Configuración de pipeline que los conecta

### Servidor MCP (controla haiflow desde cualquier agente)

`integrations/haiflow-mcp/` es un servidor MCP que expone haiflow como herramientas (`haiflow_run`, `haiflow_start_session`, `haiflow_trigger`, `haiflow_get_response`, `haiflow_stop_session`, `haiflow_status`, `haiflow_doctor`, `haiflow_map`), por lo que cualquier agente compatible con MCP (Claude Desktop, Cursor, Cline, otro Claude Code) puede orquestar Claude Code a través de haiflow. Consulta `integrations/haiflow-mcp/README.md` para la conexión. Dentro de Claude Code, la habilidad `haiflow` enseña a un agente a controlar la API HTTP directamente.

### Puente de GitHub

Menciona `@haiflow` en un issue o comentario de PR de GitHub y Claude Code lo abordará en el repositorio clonado localmente: en una rama, como una PR de **borrador**, sin tocar nunca la rama predeterminada. El puente es un retransmisor ligero y con control de acceso; Claude realiza el trabajo de rama/commit/PR por sí mismo (tiene `gh` y `git` en la sesión).

```bash
# point GITHUB_SESSION at a session whose cwd is the cloned repo
haiflow github          # or: bun run github
```

Escucha webhooks de GitHub (puerto predeterminado `3334`), verifica el HMAC `X-Hub-Signature-256` contra `GITHUB_WEBHOOK_SECRET` y solo actúa cuando **ambos** `GITHUB_ALLOWED_REPOS` y `GITHUB_ALLOWED_SENDERS` coincidan.

> ⚠️ **Ambas listas blancas son el límite de confianza.** Si alguna está vacía, se rechaza cada webhook. Cualquier persona que pueda comentar en un repositorio en la lista blanca puede controlar a Claude, así que mantén las listas de repositorios y remitentes estrictas. El texto del comentario se trata como entrada no confiable (envuelta en un marco de datos), y Claude recibe instrucciones para abrir una PR de borrador y nunca empujar a la rama predeterminada; pero revisa sus PRs antes de fusionarlas.

### Tarea Cron

```bash
0 9 * * * curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "/daily-update", "id": "daily-'$(date +\%Y\%m\%d)'", "source": "cron"}'
```

### Alias de Shell

```bash
alias ct='curl -s -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" -d'
ct '{"prompt": "explain the error in the logs", "id": "debug-1"}'
```

## Grupos de trabajadores y map-reduce

Define un grupo de sesiones miembro en `pipeline.json` y haiflow equilibrará la carga de trabajo entre ellos. `POST /pool/:name/trigger` envía un prompt a un miembro inactivo; `POST /map` distribuye una lista de elementos en el grupo en paralelo y ejecuta un reducer una vez que todos los elementos regresan (el fan-in / JOIN). Dado que todo se ejecuta con una sola suscripción plana, mapear 40 archivos en un grupo de trabajadores no cuesta nada extra por token. Consulta [Grupos de trabajadores y map-reduce](API.md) en la referencia de la API para la forma completa de la solicitud.

```json
{ "pools": { "reviewers": { "members": ["reviewer-1", "reviewer-2", "reviewer-3"] } } }
```

## Pipeline

El sistema de pipeline te permite encadenar agentes usando temas pub/sub. Cuando un agente termina una tarea, haiflow emite automáticamente su salida a los temas configurados. Otros agentes suscritos a esos temas reciben la salida como su siguiente prompt.

### Cómo funciona

1. El agente termina una tarea → se ejecuta `/hooks/stop`
2. Haiflow verifica si la sesión tiene temas emisor en `pipeline.json`
3. La salida se publica en esos temas (persistida en Redis con seguimiento de entrega)
4. Los agentes suscritos reciben el mensaje, renderizado a través de su plantilla de prompt
5. Si un suscrito está ocupado, el mensaje se encola y se drena automáticamente

### Configuración

1. **Crea `pipeline.json`** en tu `HAIFLOW_DATA_DIR` (predeterminado `/tmp/haiflow`):

```json
{
  "topics": {
    "design.ready": {
      "description": "Design agent completed its analysis",
      "subscribers": [
        {
          "session": "developer",
          "promptTemplate": "Implement this design:\n\n{{message}}"
        }
      ]
    },
    "code.ready": {
      "subscribers": [
        {
          "session": "code-reviewer",
          "promptTemplate": "Review these changes:\n\n{{message}}"
        }
      ]
    }
  },
  "emitters": {
    "design-agent": ["design.ready"],
    "developer": ["code.ready"]
  }
}
```

2. **Inicia tus agentes** y activa el primero. El pipeline se encarga del resto.

```bash
# Start all agents in the chain
curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "design-agent", "cwd": "/path/to/project"}'

curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "developer", "cwd": "/path/to/project"}'

# Trigger the first agent — the pipeline chains the rest
curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Analyse the Figma design at ...", "session": "design-agent"}'
```

### Plantillas de prompt

Las plantillas usan marcadores de posición `{{variable}}`:

| Variable | Descripción |
|----------|-------------|
| `{{message}}` | El texto de salida del agente fuente |
| `{{topic}}` | El nombre del tema (p. ej., `design.ready`) |
| `{{sourceSession}}` | La sesión que emitió el evento |
| `{{taskId}}` | El ID de la tarea fuente |

### Webhooks salientes

Los temas pueden activar webhooks cuando se publican eventos: no se necesita sondeo (polling). Añade una matriz `webhooks` a cualquier tema en `pipeline.json`:

```json
{
  "topics": {
    "review.done": {
      "subscribers": [...],
      "webhooks": [
        {
          "url": "https://your-n8n.example.com/webhook/review-done",
          "headers": { "X-Pipeline-Secret": "your-secret" }
        }
      ]
    }
  }
}
```

Haiflow hace POST de la carga útil del evento a cada URL:

```json
{
  "topic": "review.done",
  "sourceSession": "code-reviewer",
  "taskId": "task_1234_abc",
  "message": "Review complete. No issues found...",
  "publishedAt": "2026-04-06T10:00:00Z"
}
```

| Campo | Predeterminado | Descripción |
|-------|---------|-------------|
| `url` | — | URL del endpoint del webhook |
| `method` | `POST` | Método HTTP |
| `headers` | `{}` | Encabezados personalizados (fusionados con `Content-Type: application/json`) |
| `enabled` | `true` | Establece en `false` para desactivar |

### Publicación externa

Inyecta eventos desde el exterior (n8n, scripts, webhooks):

```bash
curl -X POST http://localhost:3333/publish \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "design.ready", "message": "New login page design: ..."}'
```

### Introspección

```bash
# View pipeline config, Redis status, and recent events
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline | jq .

# List topic names
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline/topics | jq .
```

### Seguridad

- **Protección circular**: Si el agente A emite a un tema que finalmente enruta de vuelta a A, se detecta el ciclo y se omite
- **Lista blanca de emisores**: Solo las sesiones listadas en `emitters` pueden publicar en un tema (excepto `POST /publish` que usa `"external"`)
- **Reintento de webhook**: Las entregas fallidas de webhooks se reintentan con backoff exponencial (máximo 5 intentos)
- **Reproducción de eventos**: Los eventos sin procesar se reproducen al reiniciar el servidor

Consulta `examples/chained-calc/pipeline-calc-chain.json` para un ejemplo de flujo de cálculo encadenado.

## Estructura del proyecto

```
haiflow/
├── src/
│   ├── index.ts              # Bun HTTP server
│   ├── github-bot.ts         # GitHub webhook bridge (haiflow github)
│   └── dashboard/            # Web dashboard (React + Tailwind)
│       ├── index.html
│       ├── app.tsx
│       ├── api.ts
│       └── components/
├── tests/
│   ├── api.test.ts                  # API integration tests
│   ├── auth.test.ts                 # Auth middleware tests
│   ├── consumer-lifecycle.test.ts   # E2E: start → payload → response → stop (fake Claude, no auth needed)
│   ├── integration.test.ts          # E2E against the REAL Claude CLI (skipped without it)
│   ├── fixtures/fake-claude.ts      # Test double that drives the hook lifecycle deterministically
│   └── index.test.ts                # Unit tests
├── bin/
│   ├── haiflow.ts            # CLI wrapper
│   ├── check-deps.sh         # Dependency checker
│   └── doctor.sh             # Full system health check
├── hooks/
│   ├── forward.sh            # Shared: guard + forward to haiflow server
│   ├── session-start.sh      # SessionStart hook
│   ├── prompt.sh             # UserPromptSubmit hook
│   ├── stop.sh               # Stop hook
│   └── session-end.sh        # SessionEnd hook
├── examples/
│   └── chained-calc/         # Chained calc workflow (n8n steps + pipeline config)
├── assets/
│   └── demo.gif              # Demo recording
├── API.md                    # Full API reference
├── .env.example
├── tsconfig.json
├── package.json
└── LICENSE
```

### Scripts

| Comando | Descripción |
|---------|-------------|
| `bun run setup` | Instalar hooks de Claude Code |
| `bun run dev` | Iniciar servidor con recarga en caliente |
| `bun run start` | Iniciar servidor |
| `bun run github` | Ejecutar el puente de webhook de GitHub |
| `bun run deps` | Verificar todas las dependencias |
| `bun run doctor` | Verificación completa de salud (servidor, n8n, sesiones, pipeline) |
| `bun test` | Ejecutar pruebas |

## Licencia

MIT
