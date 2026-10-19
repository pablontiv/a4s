---
tipo: spec
---
# Contrato conceptual de rutas lógicas por rol para Pi Subagents

## Objetivo

Definir un contrato conceptual, fail-closed y acotado para que una ejecución de un rol pueda intentar una ruta preferida y, sólo ante fallos transitorios previos a output y tools, rutas alternativas secuenciales. El contrato extiende la resolución existente sin cambiar asignaciones ni duplicar la definición Markdown del rol.

Pi Subagents 1.6.1 es la línea base observada. En esa versión, `src/error-metadata.ts` contiene metadata con forma de fallback inactivo (`fallback_failed`, `unknown_fallback` e intentos primario/fallback), mientras el runner (`src/runner/sdk-runner.ts`) resuelve un único perfil efectivo, ejecuta sólo `attempt(preferred)`, devuelve `fallback_used: false` fijo y, ante error, emite el fallo primario estructurado sin seleccionar otra ruta; en el historial observado, `fallback_used` permanece en `false`.

## Alcance y exclusiones

Este documento define:

- el schema conceptual `role_routes` y su precedencia;
- selección secuencial, límite de intentos y cooldown;
- categorías retryable y terminales;
- continuidad de prompt, tools, cwd e identidad de tarea;
- validación de independencia de reviewers; y
- un recibo acotado por intento.

Quedan explícitamente fuera de alcance:

- asignaciones concretas de modelo o proveedor;
- implementación o parcheo del runtime;
- mutación de perfiles o configuración;
- fallback entre harnesses;
- cambios al historial instalado; y
- activación de rutas antes de una aprobación de `model-optimizer` basada en evidencia.

Los valores con forma `<provider>/<model-id>` que aparecen abajo son metavariables de schema, no asignaciones.

## Invariantes

1. Cada rol conserva una única definición Markdown canónica. Una ruta sólo cambia modelo y, opcionalmente, esfuerzo; no crea una definición, prompt ni set de tools por modelo.
2. Los intentos son estrictamente secuenciales. Nunca hay carreras, hedging ni fan-out paralelo.
3. No hay fallback si existe output parcial, actividad de tools, efecto de tools o incertidumbre sobre cualquiera de esos hechos.
4. Un subagente no puede delegar: el snapshot de tools continúa excluyendo `subagent_*` en todos los intentos.
5. Un reviewer emparejado con un worker conserva independencia simultánea de proveedor y familia en toda ruta que pudiera ejecutar.
6. La configuración de rutas no se aplica hasta que `model-optimizer` apruebe las asignaciones concretas.

## Schema conceptual `role_routes`

`role_routes` vive conceptualmente junto a `model_profiles` en la configuración nativa de Pi Subagents. No se añade por este trabajo. Su forma normativa es:

```json
{
  "role_routes": {
    "<normalized-role>": {
      "fallbacks": [
        {
          "model": "<provider>/<model-id>",
          "effort": "<optional-thinking-effort>"
        }
      ],
      "max_attempts": 2,
      "cooldown_ms": 1000
    }
  }
}
```

Reglas del schema:

- `<normalized-role>` usa el mismo nombre normalizado que `model_profiles[agent]`.
- `fallbacks` es una lista ordenada de cero a dos rutas. Cada elemento exige un único `model` resoluble; `effort` es opcional y usa el enum ya soportado por el runtime.
- Una ruta fallback sin `effort` hereda el esfuerzo efectivo de la ruta primaria. No hereda ni redefine ningún otro atributo del rol.
- `max_attempts` cuenta la primaria. Es un entero entre `1` y `1 + len(fallbacks)`, con hard cap `3`. Si se omite, vale `1 + len(fallbacks)`.
- `cooldown_ms` es un entero entre `0` y `30000`. Si se omite, vale `1000`. Sólo se aplica antes de un intento posterior elegible.
- Dos rutas no pueden resolver al mismo par canónico proveedor/modelo, aunque difiera el esfuerzo. La ruta primaria también participa en esta comprobación.
- Un campo desconocido, una ruta irresoluble, un rol desconocido, un duplicado o un valor fuera de rango invalida el grupo completo antes de iniciar el intento 1.
- La ausencia de `role_routes[role]` conserva exactamente un intento y el comportamiento de selección vigente.

El grupo contiene sólo referencias de routing. Prompt, tools, permisos, cwd, task y definición siguen teniendo una única fuente.

## Selección y precedencia exactas

La selección ocurre una sola vez antes de ejecutar:

1. Seleccionar la definición del rol con el orden vigente: proyecto sobre global para el mismo nombre normalizado y, dentro de un scope, `subagents` sobre `agents`.
2. Seleccionar `role_routes[role]` únicamente desde la configuración que corresponde al origen de esa definición: una definición de proyecto usa rutas de proyecto y una global usa rutas globales. Los grupos no se mezclan, concatenan ni heredan libremente entre scopes. Si no existe un grupo en el scope correspondiente, no hay fallbacks.
3. Resolver la ruta primaria sin alterar la precedencia existente: `model_profiles[role].model` del scope de la definición, frontmatter `model`, `default_model` efectivo, modelo actual del orquestador y, finalmente, unresolved. Para esfuerzo se conserva el mismo orden: perfil, definición, default efectivo, orquestador y unresolved.
4. Si la primaria queda unresolved, fallar cerrado antes de lanzar una sesión; una fallback nunca repara una primaria mal resuelta.
5. Formar la lista ordenada como primaria seguida de `fallbacks`, validar schema, duplicados e independencia de reviewer, y truncar la ejecución a `max_attempts`. El orden declarado nunca se reordena por disponibilidad, precio o prestigio.

Esta precedencia preserva el resolver de perfiles y la afinidad entre definición y scope. `role_routes` añade sólo alternativas posteriores; no sustituye la ruta preferida ni inventa asignaciones.

## Independencia de reviewer

Para un reviewer emparejado, la construcción del grupo recibe `effective_provider` y `effective_model` del worker desde su recibo exitoso; la familia del worker se resuelve desde el catálogo runtime de `model-optimizer`, indexado por ese proveedor/modelo efectivos. Antes del intento 1 debe validar cada ruta reviewer que pudiera ejecutarse:

```text
reviewer.provider != worker.provider
AND
reviewer.family != worker.family
```

El catálogo runtime usado por `model-optimizer` resuelve la familia del worker y de cada ruta reviewer; para el worker, la clave es el proveedor/modelo efectivos del recibo exitoso, no una heurística sobre el nombre. Proveedor o familia desconocidos, iguales o no verificables invalidan el grupo completo. No se omite silenciosamente una ruta inválida ni se relaja la comparación durante fallback. Un cambio de modelo dentro del mismo proveedor o de proveedor conservando la misma familia no satisface independencia.

## Algoritmo secuencial acotado

Para una nueva tarea delegada:

1. Resolver y validar el grupo completo. Congelar `role`, definición, system prompt, task/context, cwd, tools, permisos, identidad de tarea, modo, recursos y deadlines.
2. Para `attempt = 1..max_attempts`, elegir la ruta en la misma posición. `attempt=1` es la primaria; todo intento mayor es fallback.
3. Crear una sesión aislada con esa ruta y el snapshot congelado. Nunca ejecutar dos sesiones de la tarea a la vez.
4. Si el intento termina con éxito, emitir su recibo y detenerse.
5. Si falla, normalizar la categoría, emitir el recibo fallido y evaluar todos estos predicados:
   - la categoría está marcada como condicionalmente retryable en la tabla;
   - el metadata normalizado conserva `retryable=true`;
   - `partial_result_available` existe y es exactamente `false`;
   - no comenzó output entregable al caller;
   - el contador de actividad de tools es exactamente cero;
   - el contador de efectos de tools es exactamente cero;
   - queda una ruta dentro de `max_attempts`; y
   - no existe cancelación, interrupción ni deadline vencido.
6. Si un predicado falla o es unknown, terminar con el fallo observado. No volver a ejecutar la misma ruta ni saltar a otra.
7. Si todos pasan, esperar exactamente `cooldown_ms` y luego iniciar la siguiente ruta. La espera es cancelable, no lleva jitter ni backoff implícito, no reinicia el timeout total y ocurre una sola vez por transición. Cancelación durante la espera termina como `cancelled`; deadline vencido termina como `total_timeout`. Si no queda presupuesto para la espera y otro intento, no se lanza la ruta.
8. Si una fallback falla y no puede continuar, el resultado agregado puede usar `fallback_failed`, pero conserva los recibos y categorías originales de todos los intentos.

“Actividad de tools” incluye tool solicitada, iniciada, completada o fallida, aunque sea de sólo lectura. “Efecto” incluye cualquier mutación observada o potencial. Por eso todo efecto parcial falla cerrado y nunca se compensa repitiendo la tarea.

Este algoritmo se aplica a una nueva ejecución. No rerutea una continuación persistida ni convierte fallback en una nueva identidad de tarea.

## Tabla exhaustiva de categorías

La tabla cubre todo el union `SubagentErrorCategory` observado en `src/error-metadata.ts`. “Condicional” significa que todavía deben pasar todos los guards del algoritmo; no autoriza por sí sola otro intento.

| Categoría | Política | Razón |
| --- | --- | --- |
| `total_timeout` | terminal | El deadline total falló; reintentar ocultaría timeout y ampliaría el budget. |
| `stall_timeout` | terminal | Un stall es timeout y falla cerrado. |
| `cancelled` | terminal | Respeta cancelación del caller. |
| `interrupted` | terminal | Respeta interrupción y no reconstruye intención. |
| `empty_response_no_tools` | terminal | Una respuesta vacía no está en el allowlist transitorio. |
| `empty_response_after_tools` | terminal | Ya hubo actividad de tools. |
| `context_overflow` | terminal | Cambiar ruta no debe alterar o truncar silenciosamente contexto. |
| `provider_api_error` | condicional | Retryable por defecto en 1.6.1, sólo pre-output y pre-tool. |
| `provider_auth_error` | terminal | Credenciales o autorización requieren corrección explícita. |
| `provider_rate_limit` | condicional | Retryable por defecto en 1.6.1, sólo pre-output y pre-tool. |
| `provider_network_error` | condicional | Retryable por defecto en 1.6.1, sólo pre-output y pre-tool. |
| `tool_failure` | terminal | Puede haber actividad o efectos; nunca se repite. |
| `fallback_failed` | terminal | Es un fallo agregado, no una causa para recursión. |
| `unknown_fallback` | terminal | La ruta o causa fallback es desconocida. |
| `malformed_thrown_value` | terminal | No hay clasificación confiable. |
| `serialization_failure` | terminal | El metadata no es confiable. |
| `unknown` | terminal | Toda incertidumbre falla cerrado. |

Aunque `provider_api_error`, `provider_rate_limit` y `provider_network_error` son retryable por defecto, pasan a terminales cuando hay output parcial, cualquier actividad o efecto de tools, metadata incompleto, `retryable=false`, falta de ruta o budget agotado. Auth, context overflow, timeout, cancelación, interrupción y efectos parciales son siempre terminales.

## Continuidad entre intentos

Todos los intentos de una tarea comparten bytes y autoridad para:

- nombre y definición canónica del rol;
- system prompt e instrucciones del rol;
- task y context del caller;
- cwd canónico;
- allowlist de tools ya expandida y sus guards de seguridad;
- permisos y prohibición de delegación hija;
- identidad opaca de tarea y parent session identity;
- modo de ejecución y política de recursos; y
- deadline total original.

Sólo pueden cambiar proveedor, modelo y el esfuerzo explícito de la ruta. Cada fallback abre una sesión aislada, pero no crea otra tarea. No concatena output fallido, no reinyecta un prompt modificado y no reutiliza resultados de tools; los guards garantizan que no existan resultados de tools que transferir.

## Recibo de ruta efectiva

Cada intento lanzado produce exactamente un recibo `pi-subagents.route-receipt/v1`. Una ejecución conserva como máximo tres recibos y señala como terminal el último. Forma normativa:

```json
{
  "schema": "pi-subagents.route-receipt/v1",
  "task_identity": "<opaque-bounded-id>",
  "role": "<normalized-role>",
  "attempt": 2,
  "requested_provider": "<provider>",
  "requested_model": "<model-id>",
  "effective_provider": "<provider>",
  "effective_model": "<model-id>",
  "outcome": "success",
  "failure_category": null,
  "fallback_used": true
}
```

Reglas:

- `attempt` es 1-based y nunca supera `max_attempts` ni 3.
- Los campos requested registran la ruta pedida después de precedencia; los effective registran la ruta observada por la sesión. Divergencia no explicable falla cerrado como `unknown`.
- `outcome` es `success` o `failure`. `failure_category` es `null` sólo en success y exige una categoría de la tabla en failure.
- `fallback_used` equivale exactamente a `attempt > 1`; nunca significa que sólo se configuró una alternativa.
- Los identificadores son acotados y no incluyen prompts, resultados, argumentos de tools, transcript, secretos ni paths privados.
- Un fallo de resolución previo al launch no inventa un recibo de intento. Se reporta como error de configuración terminal.

Los recibos previos permanecen visibles cuando una fallback tiene éxito, de modo que no se oculta la categoría que motivó el cambio de ruta.

## Evidencia y trazabilidad

La evidencia confirmada para este contrato es:

- package instalado Pi Subagents 1.6.1;
- resolver con precedencia profile/definition/default/orchestrator y perfiles ligados al origen de la definición;
- runner que hoy ejecuta sólo `attempt(preferred)` y no selecciona otra ruta tras un error;
- metadata con sólo tres categorías retryable por defecto y formas de fallback inactivo (`fallback_failed`, `unknown_fallback`, intentos primario/fallback y `fallback_used`); y
- historial SQLite resuelto por `resolveSubagentsHistoryHome`, donde se observaron auth, timeout total, cancelación e interrupción y `fallback_used` permaneció en `false`.

La evidencia durable no copia prompts, resultados, transcripts ni paths privados del historial.

## Criterios de aceptación

- Schema, defaults, scope y precedencia son deterministas.
- La tabla enumera todas las categorías vigentes y sólo tres son condicionalmente retryable.
- El algoritmo es secuencial, tiene hard cap de tres, cooldown definido y no reintenta después de output o tools.
- Auth, context overflow, timeout, cancelación, interrupción, unknowns y efectos parciales fallan cerrado.
- Prompt, tools, cwd e identidad de tarea permanecen continuos.
- Toda ruta reviewer conserva independencia verificada de proveedor y familia.
- Cada intento produce un recibo acotado con role, attempt, requested/effective model/provider, failure category y fallback_used.
- No se realizan asignaciones, implementación, mutación de perfiles ni fallback cross-harness.
- Los documentos nuevos validan con Rootline y una revisión fresca debe aprobar el contrato antes de integración.
