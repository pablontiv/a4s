---
tipo: research
fecha: '2026-10-08'
estado: researched
title: 'Drenado de cuota, subagentes y excepción Mechanical routing-read'
baseline_sha: f3f5d39611da4a2c66ffc44f274186f97fa9c477
zona_horaria: America/Mexico_City
---

# Drenado de cuota, subagentes y excepción `Mechanical routing-read`

## 1. Resumen ejecutivo

Esta investigación explica un aumento de consumo observado entre el 7 y el 8 de octubre de 2026. La contabilidad final revisada suma 1,591,865,377 tokens lógicos en la ventana completa. Los Workers de Pi representan 1,197,308,869 tokens, o 75.21% del total. Pi principal representa 382,833,649 tokens, o 24.05%. Codex CLI representa 11,722,859 tokens, o 0.74%.

La causa dominante fue el volumen de respuestas y relecturas de contexto de los Workers. La ventana contiene 981 sesiones hijas y 14,236 respuestas de Workers. El número de respuestas explica aproximadamente 86.55% del exceso normalizado frente al 6 de octubre. El contexto medio creció 3.81%. El ritmo de respuestas creció 32.54%.

Las políticas introducidas el 5 de octubre fueron una condición causal y un amplificador. Los commits relevantes fueron `b7bab13` y `ed2390d`. La carga formada por unidades pequeñas activó el fan-out. Cada Worker acumuló su propio historial. Las respuestas y los resultados de herramientas provocaron relecturas repetidas. La política no fue una causa única ni suficiente.

La evidencia de cuota sólo confirma un cambio de 43 puntos entre dos snapshots comparables. La caída anterior de 80% usado a 11% usado coincidió con un cambio de `resets_at`. Esa caída representa recuperación o sustitución de ventana. No representa consumo negativo. Faltan snapshots al inicio y al final. Setenta puntos son aritméticamente posibles, pero no están confirmados.

El ajuste `entrada_nueva + salida + 0.0505 * cacheRead` fue exploratorio. Produjo una estimación aproximada de 59.7 puntos para el intervalo completo. El proveedor no publica la función autoritativa de cuota. Este informe no presenta `0.0505` como una fórmula autoritativa.

Los Workers no reciben el historial completo del Orchestrator. Reciben el rol, el `cwd`, los schemas permitidos, la tarea y un contexto opcional. Después acumulan su propio historial. El resultado final completo del Worker sí entra en el historial del padre.

Un handoff por archivos sólo reduce tokens si el receptor evita una lectura completa o usa una lectura selectiva. Una ruta no reduce tokens por sí sola. Una lectura completa inserta el contenido en el historial del Worker. El uso general de archivos temporales tampoco es apropiado porque su creación es trabajo `mutating` en A4S.

La investigación produjo una propuesta histórica llamada `Mechanical routing-read`. Claude aprobó una excepción limitada. Una revisión de Debugger rechazó el diff exacto inicial y añadió límites verificables. La sección 9 conserva el texto final completo. Este documento no amplía esa excepción ni concede autoridad operativa.

## 2. Preguntas investigadas

La investigación trató estas preguntas:

1. ¿Cuántos tokens registraron Pi principal, Pi hijo y Codex CLI en la ventana?
2. ¿Qué parte del consumo observado puede reconciliarse con los snapshots de cuota?
3. ¿Qué mecanismo produjo el aumento?
4. ¿Los Workers reciben el historial completo del Orchestrator?
5. ¿Un handoff por archivos reduce el consumo?
6. ¿Una lectura mecánica y limitada antes del dispatch puede reducir despachos innecesarios sin convertir al Orchestrator en investigador?

El análisis separa cuatro clases de afirmación:

- **Hecho validado:** resultado reproducido o confirmado por la revisión independiente.
- **Estimación:** cálculo dependiente de una aproximación declarada.
- **Hipótesis rechazada:** explicación incompatible con la evidencia o insuficiente para explicar el resultado.
- **Límite:** ausencia de datos o de autoridad que impide una conclusión más fuerte.

## 3. Ventana, fuentes y método

### 3.1 Ventana temporal

La zona local fue `America/Mexico_City`.

El intervalo UTC fue estricto:

```text
[2026-10-07T06:00:00Z, 2026-10-08T08:07:06Z)
```

El intervalo local equivalente fue desde `2026-10-07 00:00:00` hasta `2026-10-08 02:07:06`. El inicio se incluyó. El final se excluyó.

Los dos snapshots comparables fueron:

- 11% usado a `2026-10-07T12:04:39.653Z`.
- 54% usado a `2026-10-08T05:03:26.849Z`.

Ambos snapshots tuvieron el mismo `resets_at=1791948517`.

### 3.2 Fuentes principales

La revisión usó estas familias de fuentes:

- `~/.pi/agent/sessions/**/*.jsonl`
- `~/.local/share/pi/subagents/sessions/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.pi/agent/settings.json`
- `~/.pi/agent/subagents.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/pi-context-expert.json`
- `~/.pi/agent/AGENTS.md`
- `agents/common/AGENTS.md`
- `skills/cost-analyzer/SKILL.md`
- El código activo de `pi-subagents-j0k3r`, descrito por Git como `v1.6.1-3-gd51f14b`.

El informe usa rutas abreviadas con `~`. No incluye nombres completos de archivos de sesión. Esos nombres pueden contener identificadores persistentes. El informe tampoco incluye secretos, credenciales, prompts privados ni contenido de respuestas.

### 3.3 Campos y unidades

La normalización revisó estos datos:

- timestamp del registro y límites de la ventana;
- raíz de origen para distinguir Pi principal, Pi hijo y Codex CLI;
- tipo y rol del mensaje;
- identificador de respuesta para deduplicación;
- modelo y proveedor declarados;
- `usage.input` o su equivalente normalizado;
- `usage.output` o su equivalente normalizado;
- `usage.cacheRead` o su equivalente normalizado;
- `usage.cacheWrite` o su equivalente normalizado;
- bloques `toolCall` y nombres como `subagent_run`, `subagent_continue` y `codemode`;
- eventos de compactación;
- relaciones de sesión padre e hija;
- snapshots de porcentaje usado y `resets_at`.

La métrica lógica suma las categorías de tokens registradas para cada respuesta única. La métrica bruta suma los registros antes de retirar duplicados. `cacheRead` forma parte del volumen lógico. No representa por sí solo el precio monetario ni una función pública de cuota.

### 3.4 Método

El recuento aplicó este orden:

1. Seleccionó registros dentro del intervalo estricto por su timestamp interno.
2. Separó las raíces de Pi principal, Pi hijo y Codex CLI.
3. Extrajo las categorías de uso de cada respuesta.
4. Identificó respuestas Pi duplicadas.
5. Restó una sola copia de cada duplicado del total bruto.
6. Agregó los resultados por origen y por segmento temporal.
7. Comparó sólo snapshots con el mismo `resets_at`.
8. Contrastó el ritmo de respuestas y el contexto medio con el 6 de octubre.
9. Revisó la configuración y el código activo para reconstruir el contexto inicial real de los Workers.

Este método de ventana difiere del análisis histórico de cohortes descrito en `skills/cost-analyzer/SKILL.md`. Ese skill usa `mtime` para seleccionar sesiones completas. Esta investigación necesitó timestamps internos porque midió respuestas dentro de un intervalo estricto. La diferencia evita aplicar una regla de cohorte a una pregunta de contabilidad temporal.

## 4. Corrección de la contabilidad

### 4.1 Total final revisado

| Origen | Tokens lógicos | Parte del total |
| --- | ---: | ---: |
| Pi principal | 382,833,649 | 24.05% |
| Pi hijo | 1,197,308,869 | 75.21% |
| Codex CLI | 11,722,859 | 0.74% |
| **Total lógico** | **1,591,865,377** | **100.00%** |

El total bruto fue 1,592,378,929 tokens. La revisión encontró 21 respuestas Pi duplicadas. Esas respuestas sumaron 513,552 tokens. La resta produce el total lógico:

```text
1,592,378,929 - 513,552 = 1,591,865,377
```

`cacheRead` sumó 1,497,797,120 tokens. Esa cifra representa 94.091% del total lógico.

### 4.2 Por qué los primeros cálculos fueron incompletos o engañosos

El cálculo inicial de 395,203,830 tokens omitió las sesiones hijas. Por esa razón, no midió el origen dominante del consumo. La omisión no fue un error pequeño. Pi hijo representa 75.21% del total lógico final.

Un cálculo intermedio produjo exactamente 1,592,273,235 tokens. La revisión independiente no pudo reproducir ese valor. El análisis lo sustituyó por el total lógico deduplicado de 1,591,865,377. La precisión decimal de un resultado no compensa una derivación no reproducible.

El total bruto también era engañoso como cifra final. Contaba dos veces 21 respuestas Pi. La diferencia fue pequeña frente al total, pero la contabilidad final debía retirarla.

La lectura directa de porcentajes de cuota también podía inducir a error. La secuencia incluyó una caída de 80% usado a 11% usado con un nuevo `resets_at`. Esa discontinuidad no se puede tratar como una devolución de 69 puntos causada por menor consumo. Representa recuperación o sustitución de la ventana del proveedor.

Por último, una equivalencia fija entre tokens y puntos habría sido injustificada. El proveedor no publica la función autoritativa. La mezcla contiene entrada nueva, salida y lectura de caché. Esas categorías pueden tener ponderaciones distintas.

## 5. Reconciliación de cuota

### 5.1 Segmento comparable

Los snapshots de 11% y 54% comparten el mismo `resets_at`. El cambio confirmado fue de 43 puntos.

| Origen | Tokens lógicos entre snapshots | Parte del segmento |
| --- | ---: | ---: |
| Pi hijo | 929,150,492 | 78.5425% |
| Pi principal | 243,606,178 | 20.59% |
| Codex CLI | 10,234,046 | 0.87% |
| **Total lógico** | **1,182,990,716** | **100.00%** |

`cacheRead` sumó 1,117,275,648 tokens en este segmento. Esa cifra representa 94.445% del total lógico del segmento.

Estos snapshots permiten asociar 1,182,990,716 tokens lógicos con un aumento observado de 43 puntos bajo el mismo identificador de reinicio. No permiten derivar una función universal de cuota.

### 5.2 Discontinuidad y datos faltantes

La serie observada incluyó una transición de 80% usado a 11% usado. `resets_at` cambió en esa transición. La caída de 69 puntos representa recuperación o sustitución de ventana.

Falta un snapshot en el inicio exacto del intervalo. También falta un snapshot en el final exacto. Por eso, la investigación no confirma el consumo total de puntos durante toda la ventana.

Setenta puntos son aritméticamente posibles si los segmentos no observados aportaron el consumo restante. La evidencia no confirma esa cifra. Este informe no presenta 70 puntos como consumo observado.

### 5.3 Ajuste exploratorio

La investigación probó este ajuste:

```text
entrada_nueva + salida + 0.0505 * cacheRead
```

El ajuste estimó aproximadamente 59.7 puntos para el intervalo completo. El coeficiente `0.0505` fue un parámetro exploratorio. No es una tarifa publicada. No es una fórmula autoritativa de cuota. El ajuste tampoco elimina el efecto de los snapshots faltantes.

La conclusión válida es limitada. El gran volumen de `cacheRead` coincide con la presión de cuota. La evidencia no permite convertir ese volumen en puntos mediante una regla pública y estable.

## 6. Causa raíz

### 6.1 Hechos de actividad

La ventana contiene estos conteos validados:

- 981 sesiones hijas.
- 14,236 respuestas de Workers.
- 3,166 respuestas Pi principales.
- 736 llamadas `subagent_run`.
- 179 llamadas `subagent_continue`.
- 775 despachos con cuatro párrafos repetidos.

Frente al 6 de octubre, el ritmo de respuestas aumentó 32.54%. El contexto medio aumentó 3.81%. La descomposición normalizada atribuyó aproximadamente 86.55% del exceso al número de respuestas.

Estos resultados indican que la frecuencia dominó sobre el aumento del tamaño medio. Un contexto ligeramente mayor se releyó muchas más veces.

### 6.2 Cadena causal

La cadena causal revisada fue esta:

1. Los cambios de política del 5 de octubre crearon una condición favorable al fan-out.
2. Una carga con muchas unidades pequeñas activó esa condición.
3. El Orchestrator produjo numerosos despachos.
4. Los despachos crearon 981 sesiones hijas.
5. Los Workers emitieron 14,236 respuestas.
6. Cada Worker acumuló respuestas, llamadas de herramientas y resultados en su propio historial.
7. Los turnos posteriores releyeron una parte grande de ese historial.
8. El volumen de `cacheRead` alcanzó 94.091% del total lógico.

Los commits relevantes fueron:

- `b7bab13`, con fecha de autor `2026-10-05T09:13:01-06:00`.
- `ed2390d`, con fecha de autor `2026-10-05T22:29:10-06:00`.

La política fue una condición causal y un amplificador. La política no fue causa única. La carga concreta, el fan-out, la cantidad de respuestas y el historial acumulado también fueron necesarios para explicar la magnitud.

### 6.3 Ejemplo `scrap`

El caso `scrap` mostró:

- 718 respuestas;
- 423 llamadas `codemode`;
- 21 llamadas `subagent_run`;
- 82,223,313 tokens.

`codemode` aumentó los ciclos y las relecturas. No fue causa única. El caso también incluyó respuestas repetidas, subagentes e historial acumulado.

### 6.4 Compactación y modelo

Pi principal registró 17 compactaciones. Pi hijo registró una compactación. La compactación mitigó el crecimiento. No compensó el volumen de respuestas y relecturas.

Todas las respuestas Pi contabilizadas declararon `openai-codex/gpt-5.6-sol`. La ventana configurada fue de 872,000 tokens. El modelo y la ventana fueron condiciones del comportamiento observado. No fueron una causa única.

Codex CLI representó 0.74% del total lógico. Los duplicados representaron 513,552 tokens. Los errores y abortos tampoco tuvieron magnitud suficiente. Ninguno de esos factores explica el drenado principal.

## 7. Contexto real de Workers

Los Workers no heredan el historial completo del Orchestrator.

El contexto inicial contiene estos elementos:

- la definición del rol;
- el `cwd`;
- los schemas de herramientas permitidos;
- `task`;
- `context` cuando el dispatch lo incluye.

Con `session_resources: lean`, el runtime omite `AGENTS.md`, skills, templates, temas, adjuntos y el historial del padre.

Las mediciones del contexto inicial fueron:

| Componente | Tamaño medido |
| --- | ---: |
| Rol más `cwd` | 2,765 caracteres |
| Cuatro schemas | 2,889 caracteres |
| Dispatch observado | 3,693 a 4,291 caracteres |
| Primera entrada real | 1,880 a 2,009 tokens |

El contexto inicial fue acotado. El crecimiento ocurrió después. Cada Worker conservó su propio historial de respuestas, llamadas de herramientas y resultados de herramientas.

Un ejemplo observado tuvo 15 turnos. Su contexto final fue 200,135 tokens. Su consumo lógico fue 2,553,604 tokens. `cacheRead` fue 2,433,024 tokens.

El resultado final completo del Worker sí se incorpora al historial del padre. Por eso, un resultado largo puede aumentar el contexto del Orchestrator aunque el Worker no haya recibido el historial del Orchestrator.

Esta distinción corrige dos ideas incorrectas. El costo de un Worker no empieza con una copia completa del padre. El aislamiento inicial tampoco impide que el Worker acumule un historial grande durante su ejecución.

## 8. Handoff por archivos

Una ruta ahorra tokens sólo cuando el receptor evita leer el contenido completo o usa una selección pequeña. El ahorro depende del patrón de lectura.

Una lectura completa inserta el resultado en el historial del Worker. En ese caso, el archivo cambia el lugar y el momento del consumo. No elimina el consumo.

Un handoff acotado debe especificar:

```text
path
revision_or_digest
selector
maximum_read
```

`path` identifica el artefacto. `revision_or_digest` fija la versión. `selector` limita la parte necesaria. `maximum_read` establece un límite antes de exponer contenido.

Para un bloque de `P` tokens eliminado de las 14,236 respuestas de Workers, el límite superior teórico del ahorro es:

```text
P * 14,236
```

Si cada uno de los 981 Workers lee el bloque completo una vez, el costo aproximado de esas lecturas es:

```text
P * 981
```

Ese segundo cálculo no incluye el turno adicional, las instrucciones de lectura ni las relecturas posteriores. El ahorro neto sólo existe si el bloque deja de repetirse más veces de las que se lee y si el contenido leído no permanece en muchos turnos posteriores.

El handoff por archivos ayuda en estos casos:

- El Worker necesita un selector pequeño de un artefacto grande.
- Varios turnos usan una referencia estable sin releer el cuerpo.
- El receptor puede validar una revisión o un digest antes de leer.
- El límite de lectura se aplica antes de exponer el resultado.

El handoff sólo desplaza el consumo en estos casos:

- Cada Worker lee el archivo completo.
- El resultado completo de `read` permanece en el historial.
- El archivo repite contenido que ya estaba en el dispatch.
- La lectura añade un turno sin reducir repeticiones posteriores.

A4S clasifica la creación de archivos temporales como trabajo `mutating`. Por esa razón, esta investigación no recomienda un protocolo general de archivos temporales. Cada uso necesita alcance, propiedad, retención y validación explícitos.

## 9. Evaluación de `Mechanical routing-read`

### 9.1 Ejecución de Claude headless

La evaluación externa usó una sola ejecución de Claude headless.

- Binario: `~/.local/bin/claude`.
- Directorio de trabajo: `/Users/Shared/harness/a4s`.
- Opt-in: `A4S_AGENT_E2E_OPT_IN=1`.
- Flags: `--print --tools "" --output-format text`.
- Código de salida: 0.
- Cambio visible del checkout: ninguno.

Claude aprobó una excepción limitada. Claude no recibió herramientas. La ejecución no autorizó mutaciones.

Una revisión de Debugger rechazó el diff exacto inicial. Esa revisión exigió límites más estrictos. También exigió un presupuesto por unidad, búsquedas exactas, conteos reales y autoridad local. El texto siguiente fue el resultado histórico final de la investigación.

### 9.2 Propuesta final histórica

> Mechanical routing-read exception. Before the first dispatch of a work unit, the Orchestrator may make at most 5 read-only tool calls solely to locate context for that dispatch. The closed set of permitted operations is: list one directory; test the existence of one path; search for one exact path or identifier supplied by the operator or repository navigation metadata; read a repository path, symbol, or API index; or read one selected file range only to copy an exact path, identifier, selector, signature, or line range. Each call must return no more than 50 lines, 2000 UTF-8 bytes, and 20 entries or matches. The tool must enforce these limits before it exposes the result. The Orchestrator may copy only those literal navigation values into the dispatch. It must not summarize, paraphrase, interpret, compare, trace, infer, evaluate, or use the content to produce a domain finding, decision, design, diagnosis, review, or verification. It must dispatch a Worker when it needs semantic understanding, when the target is not found within the limits, or when the available tool cannot enforce the limits. For each call, retain in the conversation trajectory the work-unit identifier, operation, target or exact query, configured limits, actual line, byte, and match counts, copied literal value, and destination dispatch field. This exception applies only when the applicable repository policy permits read_only work. It grants no mutation authority and does not change any repository gate.

### 9.3 Interpretación limitada

La excepción intenta evitar un dispatch sólo para descubrir una ruta, un símbolo o un rango. No autoriza investigación semántica por parte del Orchestrator.

Los límites de 5 llamadas, 50 líneas, 2000 bytes y 20 resultados son máximos por llamada. La herramienta debe aplicar los límites antes de mostrar el resultado. Un recorte posterior no satisface la propuesta.

El registro debe incluir los conteos reales y el valor literal copiado. Esa evidencia permite distinguir navegación de análisis. La excepción no permite resumir, inferir, comparar ni verificar contenido de dominio.

La propuesta conserva la autoridad local. Sólo aplica si la política del repositorio permite trabajo `read_only`. No concede autoridad `mutating`. No cambia gates del repositorio. Este informe registra la propuesta como resultado histórico. No la convierte por sí mismo en política vigente.

## 10. Hipótesis aceptadas y rechazadas

### 10.1 Hipótesis aceptadas con alcance limitado

| Hipótesis | Resultado | Alcance |
| --- | --- | --- |
| El fan-out de Workers dominó el consumo. | Aceptada. | Pi hijo representó 75.21% del total lógico. |
| El número de respuestas dominó el exceso. | Aceptada como descomposición. | Explicó aproximadamente 86.55% del exceso normalizado. |
| Las políticas del 5 de octubre amplificaron el consumo. | Aceptada. | Fueron condición causal, no causa única. |
| El historial propio de cada Worker produjo relecturas. | Aceptada. | El ejemplo de 15 turnos mostró 2,433,024 tokens de `cacheRead`. |
| `codemode` aumentó ciclos en `scrap`. | Aceptada. | No explica por sí solo el caso ni el total. |
| La compactación redujo parte del crecimiento. | Aceptada. | Fue insuficiente ante el volumen de turnos. |
| Una lectura mecánica puede evitar algunos despachos de navegación. | Aceptada con controles. | Sólo bajo el texto limitado de la sección 9. |

### 10.2 Hipótesis rechazadas

| Hipótesis | Motivo del rechazo |
| --- | --- |
| El total fue 395,203,830 tokens. | Omitió las sesiones hijas. |
| El total exacto fue 1,592,273,235 tokens. | La revisión independiente no lo reprodujo. |
| El total bruto fue el consumo lógico final. | Incluyó 21 respuestas Pi duplicadas. |
| Se consumieron 70 puntos confirmados. | Faltan snapshots al inicio y al final. |
| `0.0505` es el factor autoritativo de `cacheRead`. | El proveedor no publica esa función. |
| Los Workers recibieron todo el historial del padre. | El contexto inicial observado fue rol, `cwd`, schemas, tarea y contexto opcional. |
| Codex CLI explicó el drenado. | Representó 0.74% del total lógico. |
| Los duplicados explicaron el drenado. | Sumaron 513,552 tokens frente a 1,591,865,377 tokens lógicos. |
| Los errores y abortos explicaron el drenado. | Su magnitud no coincide con el volumen dominante de respuestas y relecturas. |
| El modelo fue la causa única. | El fan-out y la frecuencia explican la estructura del consumo. |
| La compactación debía impedir el drenado. | Hubo compactación, pero el volumen de turnos la superó. |
| Una ruta de archivo ahorra tokens automáticamente. | Una lectura completa vuelve a insertar el contenido. |
| La excepción permite análisis previo por el Orchestrator. | La propuesta permite sólo navegación literal y limitada. |

## 11. Riesgos y limitaciones

- Faltan snapshots de cuota en los límites exactos de la ventana.
- El proveedor no publica la función autoritativa que convierte categorías de tokens en puntos.
- La estimación de 59.7 puntos depende de un ajuste exploratorio.
- La posibilidad aritmética de 70 puntos no constituye observación.
- La deduplicación depende de los identificadores y campos disponibles en los JSONL.
- Los formatos de Pi y Codex pueden cambiar entre versiones.
- El análisis de causa es observacional. No fue un experimento controlado que aislara cada política.
- La comparación con el 6 de octubre normaliza actividad, pero no hace idénticas las tareas.
- El ejemplo `scrap` ilustra un mecanismo. No representa por sí solo todas las sesiones.
- La cifra de ahorro por archivos es un límite superior. No incluye turnos adicionales ni relecturas.
- La evaluación de Claude tuvo una sola ejecución.
- La ausencia de cambio visible del checkout no prueba ausencia de todo efecto externo.
- La propuesta `Mechanical routing-read` necesita una herramienta que imponga límites antes de exponer resultados.
- Este documento no contiene los JSONL, los snapshots completos ni identificadores de cuenta. Esa omisión protege datos sensibles, pero exige acceso local autorizado para repetir el análisis.

## 12. Fuentes y reproducción

### 12.1 Comandos ejecutados para procedencia Git

La verificación documental ejecutó este comando sobre la base indicada:

```bash
git -C /Users/Shared/harness/a4s-token-drain-research show -s \
  --format='%h %aI %s' b7bab13 ed2390d
```

El comando confirmó ambas fechas del 5 de octubre. También confirmó estos asuntos:

```text
b7bab13 docs(orchestrator): enforce ready-unit fan-out (#36)
ed2390d docs(agents): align harness and prose contracts (#54)
```

La identidad del worktree se verificó con comandos de sólo lectura:

```bash
git -C /Users/Shared/harness/a4s rev-parse --path-format=absolute --git-common-dir
git -C /Users/Shared/harness/a4s-token-drain-research rev-parse --path-format=absolute --git-common-dir
git -C /Users/Shared/harness/a4s remote get-url origin
git -C /Users/Shared/harness/a4s-token-drain-research remote get-url origin
git -C /Users/Shared/harness/a4s worktree list --porcelain
```

Ambos directorios resolvieron el mismo directorio Git común y el mismo remoto `origin`. El listado registró el worktree de investigación en la rama `docs/token-drain-research`.

### 12.2 Esquema reproducible de inventario

El siguiente bloque es un esquema de reproducción. Esta unidad documental no lo ejecutó. El esquema evita imprimir rutas individuales, nombres de sesión y contenido JSONL.

```bash
python3 - <<'PY'
from pathlib import Path

roots = {
    "pi_main": Path.home() / ".pi/agent/sessions",
    "pi_child": Path.home() / ".local/share/pi/subagents/sessions",
    "codex": Path.home() / ".codex/sessions",
}

for label, root in roots.items():
    files = list(root.glob("**/*.jsonl"))
    rows = 0
    for path in files:
        with path.open("rb") as stream:
            rows += sum(1 for _ in stream)
    print(label, "files", len(files), "jsonl_rows", rows)
PY
```

Este inventario sólo prueba cuántos archivos y registros están disponibles al repetirlo. No reproduce los totales de tokens.

### 12.3 Esquema del reductor temporal

Un reductor que reproduzca la contabilidad debe aplicar estas reglas en este orden:

```text
start = 2026-10-07T06:00:00Z, incluido
end   = 2026-10-08T08:07:06Z, excluido

para cada raíz autorizada:
  leer cada línea JSONL
  localizar el timestamp del registro
  conservar start <= timestamp < end
  conservar sólo respuestas con usage
  normalizar input, output, cacheRead y cacheWrite
  clasificar por raíz: pi_main, pi_child o codex
  formar una clave estable de respuesta Pi
  contar una sola vez cada respuesta Pi duplicada
  sumar las categorías normalizadas
```

La reproducción debe producir estas invariantes antes de aceptar el resultado:

```text
raw_total - duplicate_tokens = logical_total
1,592,378,929 - 513,552 = 1,591,865,377
pi_main + pi_child + codex = logical_total
382,833,649 + 1,197,308,869 + 11,722,859 = 1,591,865,377
duplicate_responses = 21
cacheRead = 1,497,797,120
```

La comparación de cuota debe agrupar snapshots por `resets_at`. Sólo debe restar porcentajes dentro del mismo grupo. Para el grupo `1791948517`, debe confirmar 11%, 54% y una diferencia de 43 puntos.

### 12.4 Verificación parcial sin exponer identificadores

Este esquema genera una huella agregada. No imprime nombres de archivos. Esta unidad documental no lo ejecutó.

```bash
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path

roots = [
    Path.home() / ".pi/agent/sessions",
    Path.home() / ".local/share/pi/subagents/sessions",
    Path.home() / ".codex/sessions",
]

digest = sha256()
count = 0
for root in roots:
    for path in sorted(root.glob("**/*.jsonl")):
        stat = path.stat()
        relative_name = str(path.relative_to(root)).encode()
        digest.update(sha256(relative_name).digest())
        digest.update(str(stat.st_size).encode())
        count += 1
print("files", count)
print("manifest_sha256_prefix", digest.hexdigest()[:16])
PY
```

La huella permite comparar dos inventarios locales sin publicar identificadores. No prueba igualdad del contenido. Una validación completa necesitaría hashes de contenido protegidos y una cadena de custodia autorizada.

### 12.5 Validación del documento

La unidad de implementación debe cerrar con estos comandos:

```bash
git -C /Users/Shared/harness/a4s-token-drain-research diff --check
git -C /Users/Shared/harness/a4s-token-drain-research status --short
git -C /Users/Shared/harness/a4s-token-drain-research diff --name-only
```

El repositorio no declaró un validador Markdown en su `package.json`. La inspección tampoco encontró una configuración de `markdownlint`. Por esa razón, la unidad no debe instalar dependencias ni añadir un validador nuevo.
