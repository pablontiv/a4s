# Worker de triage Pi (carril 1)

Dagu invoca `node <WORKER_ENTRY> --issue fixture-1 --run-id <runId>` con argumentos separados. `WORKER_ENTRY` es la ruta absoluta a `triage.mjs`; `runId` empieza por `pi-slice-`. El resultado de éxito es una sola línea JSON con LF final y exactamente estas claves: `schemaVersion` (1), `issue`, `runId`, `poc` (`"yes"`), `question` y `reason` (textos no vacíos). `issue` y `runId` salen del argv, no del modelo. En caso de error el código es no cero, stdout queda vacío y el diagnóstico va a stderr. Consumir el resultado como JSON, nunca como código.

## Fixture sin proveedor

```sh
A4S_PI_TRIAGE_FIXTURE=1 node "$PWD/pilots/pi-triage/worker/triage.mjs" --issue fixture-1 --run-id pi-slice-local
```

Desde la raíz del worktree. Este modo no carga el SDK ni necesita instalar dependencias. Solo `1` lo activa; `0` o la variable ausente seleccionan Pi y cualquier otro valor falla.

## Pi por defecto

Instalar desde el lockfile de A4S con `npm ci`. Pi usa `anthropic/claude-haiku-4-5-20251001` y exige `A4S_PI_TRIAGE_ANTHROPIC_API_KEY`. No busca credenciales del operador ni elige otro modelo. La sesión, las credenciales y los ajustes viven en memoria. El worker suministra el prompt y no carga extensiones, skills, plantillas, temas ni archivos de contexto. No habilita herramientas, shell, reintentos ni calentamiento de caché. Una respuesta del modelo incompleta o que no cumpla el esquema falla; no se devuelve el fixture como sustituto.

A4S fija `@earendil-works/pi-coding-agent` y `@earendil-works/pi-ai` en `1.0.3` para este worker. El Pi instalado en este host es `1.5.2`; las APIs públicas que usa el worker también funcionan con los paquetes de esa instalación en las pruebas con transporte simulado. La ejecución normal resuelve los paquetes de A4S por nombre; no busca el binario ni la instalación global de Pi.

## Pruebas

```sh
node --test pilots/pi-triage/worker/triage.test.mjs
```

La suite comprueba el proceso CLI y usa el SDK real con un doble HTTP para Anthropic, sin red ni credenciales reales. Para repetirla con otra instalación de Pi, pasar la ruta absoluta a su `node_modules` en `A4S_PI_TRIAGE_TEST_NODE_MODULES` (solo afecta a la suite). Queda sin verificar una respuesta de un proveedor real con credenciales autorizadas.
