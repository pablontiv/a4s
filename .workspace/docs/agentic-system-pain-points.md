# Braindump: dónde duele realmente el sistema agentic

## Resumen crudo

El problema no es que los agentes no puedan escribir código o documentos. El problema es que trabajo potencialmente simple termina convertido en coordinación, reconstrucción de contexto, ceremonias y verificaciones tardías.

Hay mucha actividad, pero actividad no equivale a progreso verificable.

Ejemplos extremos:

- `3 h 51 min 58 s` para cambiar tres documentos.
- Casi `2 h 54 min` para cambios principalmente documentales.
- `6 min 56 s` y 23 turnos para añadir dos líneas a `.gitignore`.

La auditoría encontró el patrón en Pi, Claude, Codex y OpenCode. No es un problema exclusivo de A4S ni de un modelo concreto.

## Pain points principales

### 1. Cierre falso

El agente dice “terminado”, “listo” o “no queda nada” porque un Worker lo reportó o porque terminó una etapa intermedia. Todavía pueden faltar commit, merge, push, sincronización con `origin`, instalación, ejecución sobre el checkout correcto o validación del flujo real.

El operador descubre el estado real tarde y debe reabrir, investigar y dirigir nuevamente el trabajo. `completed` funciona como afirmación narrativa, no como estado calculado desde evidencia.

### 2. Amnesia de contexto

Decisiones, restricciones y respuestas ya dadas desaparecen del contexto operativo. El agente vuelve a preguntar, reinterpreta o reconstruye desde cero.

El contexto está fragmentado entre conversación, Backscroll, archivos, Workers y herramientas. No existe una representación compacta y confiable de qué se pidió, qué se decidió, qué está prohibido, qué se hizo, qué falta y qué está demostrado.

### 3. Scope drift

Una edición simple deriva hacia limpieza, documentación adicional, tests, canaries, reviews, nuevas tareas o cambios arquitectónicos.

No existe una frontera ejecutable entre trabajo solicitado, hallazgo interesante y trabajo autorizado. El agente intenta “ser útil” agregando trabajo, aumentando superficie, riesgo y duración.

### 4. Ceremonia más cara que el cambio

Planificación, delegación, handoffs, revisiones, estados y cierre consumen más tiempo que la modificación real. El caso de `.gitignore` lo muestra: dos líneas necesitaron 23 turnos; casi todo el coste estuvo fuera de la edición.

El proceso se aplica por categoría o policy, no de forma proporcional al riesgo y tamaño del cambio.

### 5. Verificación invertida

Primero se acepta o comunica el éxito; después se intenta encontrar evidencia que lo confirme. Cuando aparece la evidencia real, ya existen resúmenes, decisiones y estados derivados de una conclusión falsa.

Verificar se trata como una etapa opcional posterior, no como condición para cambiar el estado de la tarea.

### 6. Mala división y fan-out

Aparecen los dos extremos: un Worker enorme recibe varias responsabilidades y demasiado contexto, o una tarea trivial se fragmenta entre demasiados Workers y fases.

La consecuencia son handoffs, espera, resultados incompatibles, duplicación, integración manual y pérdida de contexto. El trabajo se divide por roles abstractos, no por independencia verificable y coste de coordinación.

### 7. El operador termina haciendo polling

El operador debe preguntar si terminó, si el Worker respondió, qué falta, por qué está detenido, si ya se hizo push o si realmente funciona.

Se delegan acciones, pero no atención. El humano sigue siendo scheduler, monitor y reconciliador porque no existen transiciones automáticas confiables desde “en curso” hasta “resultado validado”.

### 8. Confianza excesiva en autorreportes

El coordinador acepta `status: completed`, “tests verdes” o “push realizado” como evidencia suficiente. Un error de interpretación del Worker se convierte en el estado oficial de la tarea.

La misma entidad ejecuta, interpreta y certifica; no existe separación entre reporte y evidencia observable.

### 9. Git, filesystem y runtime cuentan historias distintas

El archivo puede estar modificado pero no versionado; el commit puede existir solo localmente; `origin/main` puede estar atrás; el checkout activo puede usar código antiguo; el runtime puede cargar otra instalación; o los tests pueden ejecutarse contra otro binario.

Existen varias fuentes de verdad sin reconciliación automática. “Ya está cambiado” o “funciona” deja de tener un significado inequívoco.

### 10. Sprawl de autoridad, routing e identidad

No queda claro qué instrucción sigue vigente, qué archivo tiene autoridad, qué sesión posee el trabajo, qué agente puede actuar o quién realizó realmente el cambio.

El ejemplo más claro fue `.workspace/config`: acumuló autoridad y ceremonia hasta que hubo que revocarla por completo.

### 11. Comunicación que oculta el estado

Respuestas extensas y pulidas mezclan hechos, inferencias, planes, pendientes y bloqueos. El operador debe traducir prosa a estado operativo y puede aceptar como hecho algo que solo era una expectativa.

### 12. Restricciones locales descubiertas tarde

Una solución genéricamente razonable viola una restricción específica del dominio o repositorio: monotonicidad, permisos contributor/maintainer, preservación de datos, routing, política Git, formato documental o automatización obligatoria.

Las restricciones locales se expresan como prosa consultiva, no como condiciones comprobables. El resultado es retrabajo y otra nueva regla escrita.

## Bucles recurrentes

1. `amnesia -> investigación repetida -> más contexto -> nueva amnesia`
2. `delegación -> autorreporte -> cierre falso -> comprobación humana -> reapertura`
3. `fan-out -> handoffs -> estados incompatibles -> integración manual`
4. `ceremonia -> demora -> polling humano -> nuevas instrucciones -> más ceremonia`
5. `estado narrado -> divergencia Git/runtime -> diagnóstico equivocado -> nueva narración`
6. `fallo -> nueva regla en prosa -> más autoridad distribuida -> nuevo fallo`

## Dolor del operador

- No saber si “terminado” significa realmente terminado.
- Repetir instrucciones y decisiones.
- Vigilar que el sistema continúe trabajando.
- Esperar horas por cambios triviales.
- Leer mucha prosa para descubrir qué falta.
- Detectar personalmente inconsistencias entre Git, runtime y reportes.
- No poder predecir cuánto costará una tarea pequeña.
- Perder confianza incluso cuando el resultado sí es correcto.

## Dolor interno del sistema

- Contexto fragmentado.
- Varias fuentes de verdad.
- Autoridad e identidad ambiguas.
- División del trabajo sin medir coordinación.
- Verificación narrativa.
- Estado que no progresa sin intervención humana.
- Reglas locales dispersas y contradictorias.

## Causas raíz probables

1. No hay un estado único y observable de la tarea.
2. El cierre depende de afirmaciones, no de evidencia.
3. El contexto operativo no se conserva de forma compacta.
4. Ejecución, reporte y certificación no están separados.
5. La división no considera el coste de coordinación.
6. Autoridad, identidad y configuración están distribuidas.
7. Las restricciones siguen expresándose como prosa que el modelo puede ignorar.

## Síntomas, no causas

- sesiones largas;
- demasiados turnos;
- polling;
- reaperturas;
- scope drift;
- documentación excesiva;
- Workers detenidos;
- diferencias entre Git y runtime;
- más reglas después de cada fallo.

## Hipótesis que vale la pena prototipar

- ¿Cuántos cierres falsos desaparecerían si `completed` exigiera recibos de herramientas?
- ¿Puede evitarse fan-out cuando coordinar cuesta más que ejecutar?
- ¿Puede eliminarse el polling mediante transiciones y callbacks automáticos?
- ¿Cuál es la representación mínima de alcance, decisiones, pendientes y evidencia?
- ¿Puede reconciliarse automáticamente filesystem, Git, instalación y runtime?
- ¿Qué restricciones locales pueden convertirse en checks?
- ¿Puede separarse el autorreporte del Worker de la certificación?
- De los 23 turnos de `.gitignore`, ¿cuántos produjeron información nueva?

La síntesis principal es esta: el sistema no necesita más instrucciones sobre cómo comportarse. Necesita que los estados importantes sean observables y que los estados inválidos sean imposibles de declarar como terminados.
