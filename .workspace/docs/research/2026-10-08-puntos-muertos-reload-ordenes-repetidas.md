---
tipo: research
fecha: '2026-10-08'
estado: accepted-with-reservations
title: 'Investigación de puntos muertos, reload y órdenes repetidas'
---

# Investigación de puntos muertos, `/reload` y órdenes repetidas

## Objetivo

Esta investigación identifica causas de puntos muertos operativos, gates, Workers detenidos y órdenes repetidas. También separa causas directas, amplificadores y correlaciones.

El veredicto de revisión es `aceptado_con_reservas`.

## Ventana temporal

El corte documental terminó el 2026-10-08. La investigación cubrió la instantánea completa del corpus disponible en ese corte. La evidencia conservada no define una fecha inicial única. Por eso, este documento no atribuye al corpus una ventana de producción cerrada.

## Método

La investigación combinó cuatro tipos de evidencia:

1. Clasificación exhaustiva del corpus.
2. Lectura de políticas aplicables.
3. Inspección de la implementación de `/reload` y de la cancelación de Workers.
4. Contraste entre eventos, estados terminales y órdenes posteriores.

La consulta integral agotó tres veces el timeout de 20 minutos. La investigación requirió particiones sucesivas para completar el corpus. Cada partición redujo el conjunto pendiente y conservó la misma clasificación.

La cobertura final fue 463/463. La clasificación fue 53/27/383:

| Clase | Casos | Interpretación |
| --- | ---: | --- |
| `INCIDENTE_CONFIRMADO` | 53 | El caso contiene un incidente confirmado dentro del alcance. |
| `SEÑAL_SIN_CAUSA` | 27 | El caso contiene una señal, pero la evidencia no demuestra una causa. |
| `SIN_INCIDENTE` | 383 | El caso no contiene un incidente demostrado dentro del alcance. |

Estos totales describen el corpus completo revisado. El corpus completo incluye muchos fixtures distribuidos entre sus clases. Por ello, estos totales no representan una tasa de producción.

## Modelo causal

Este documento usa tres categorías:

- **Causa directa:** produce el estado observado mediante una secuencia técnica o normativa demostrada.
- **Amplificador:** aumenta la duración, la visibilidad o la probabilidad de repetición. No produce el estado por sí solo.
- **Correlación:** coincide con el estado observado. La evidencia no demuestra una secuencia causal.

## Hallazgos

### Causas directas confirmadas

1. `/reload` detiene Workers activos. `AgentSession.reload()` emite `session_shutdown` con `reason="reload"`. La extensión recibe el evento y ejecuta `manager.cancelRunning`. La cadena de cancelación activa un `AbortController` y termina en `AgentSession.abort()` para la sesión anidada.
2. La combinación condicional de delegación obligatoria, propiedad de sesión y prohibición de verificación directa puede dejar una acción sin actor autorizado. El Orchestrator debe delegar la acción. El Worker no puede representar la sesión propietaria. El Orchestrator tampoco puede ejecutar la verificación de dominio por sí mismo.
3. La falta de reconciliación posterior a `/reload` permite estados obsoletos. El runtime inicia de nuevo la extensión, pero la evidencia revisada no muestra una reconciliación obligatoria de tareas canceladas, resultados terminales o acciones pendientes.

### Causas de prompting confirmadas

- Un gate bloqueado solicita la condición que falta.
- La pérdida de una capacidad obligatoria solicita una decisión o una acción del operador cuando esa intervención permite continuar.
- Un intento agotado solicita autorización explícita para otro intento.
- Un estado obsoleto después de `/reload` puede solicitar una acción ya iniciada o una verificación ya resuelta.
- Una acción sin actor autorizado solicita una decisión aunque exista capacidad técnica en otro actor.

### Amplificadores

- El modo background amplifica la separación temporal entre la orden, el fallo y su observación. No es una causa suficiente.
- El backscroll incompleto amplifica la ambigüedad. Omitió algunos eventos terminales y algunos errores de mensajes vacíos.
- Los gates rígidos amplifican la visibilidad de una condición faltante. Los gates son paradas previstas. No todos los gates bloqueados son defectos.
- La regla de intento único amplifica los fallos recuperables. La regla transforma esos fallos en `blocked` o `input_required` y exige una nueva orden del operador para autorizar otro intento. La regla no causa el fallo técnico inicial.

### Causas técnicas independientes

OAuth, el proveedor, GitHub, SQLite, los watchers y los timeouts técnicos produjeron fallos independientes. Estos fallos pueden detener trabajo o requerir otra orden. No dependen del punto muerto normativo ni de `/reload`.

### Correlaciones y riesgos no demostrados

- La ejecución en background coincide con varios retrasos. La evidencia no la establece como causa suficiente.
- El conflicto entre una salida XML y el contrato de cinco campos es un riesgo estático. La investigación no demostró un incidente causado por ese conflicto.
- La proximidad entre un gate y una orden repetida no demuestra que el gate sea defectuoso.

## Evidencia representativa

| Fuente durable | Evidencia |
| --- | --- |
| `/Users/pones/.pi/agent/AGENTS.md` | Define la delegación obligatoria, la propiedad de sesión, la prohibición de verificación directa, el intento único y el uso predeterminado de background. |
| `/Users/Shared/harness/a4s/AGENTS.md` | Define los gates inicial y final. También exige detener el trabajo cuando falta una condición. |
| `/Users/Shared/vendor/pi/packages/coding-agent/src/core/agent-session.ts` | `AgentSession.reload()` emite `session_shutdown` con `reason="reload"` antes de invalidar y recargar la extensión. |
| `/Users/pones/.pi/agent/npm/node_modules/pi-subagents-j0k3r/src/extension/subagents-extension.ts` | El handler de `session_shutdown` ejecuta `manager.cancelRunning('Pi session shutdown')`. La cadena usa cancelación abortable para detener la sesión anidada. |

Los casos representativos mostraron cuatro patrones. Un Worker activo terminó durante `/reload`. Una acción quedó sin actor autorizado. Un estado no reconciliado generó una solicitud posterior. Un fallo recuperable necesitó una nueva orden por la regla de intento único.

## Cambios mínimos de wording recomendados

1. Añadir a la política una frase que exija revisar el estado de las tareas después de `/reload` antes de repetir una orden.
2. Indicar en la política un actor autorizado para cada verificación obligatoria.
3. Aclarar en la política que la regla de intento único amplifica un fallo recuperable y no causa el fallo técnico inicial.
4. Definir en la política cuándo el operador puede autorizar un retry acotado. El texto debe indicar el límite total.
5. Añadir a la política una frase que indique que `/reload` cancela los Workers activos.
6. Aclarar en la política que cada gate debe tener un actor autorizado y una condición resoluble.

Estas recomendaciones son propuestas de wording. Este documento no las aplica a la política ni al código.

La causa técnica de `/reload` requiere una investigación de runtime separada. Esta investigación no forma parte de los cambios de wording recomendados.

## Límites

- El corpus completo incluye muchos fixtures distribuidos entre sus clases.
- La clasificación demuestra cobertura del corpus. No demuestra prevalencia en producción.
- El backscroll omitió algunos eventos terminales y errores de mensajes vacíos.
- La evidencia no permite atribuir todos los casos a una causa común.
- La investigación no demuestra que background cause un punto muerto por sí solo.
- La investigación no demuestra que todos los gates bloqueados sean defectos.
- La investigación no demuestra un incidente causado por el conflicto XML frente a cinco campos.
- Las causas técnicas independientes pueden coincidir con los patrones normativos.
- La ausencia de una fecha inicial única limita cualquier comparación temporal.
