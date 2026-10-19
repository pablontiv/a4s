---
name: github-issue
description: "Investiga una necesidad y genera tickets GitHub Issue de tipo bugfix, enhancement o spike. Usar manualmente con /skill:github-issue cuando el resultado deseado sean issues, no implementación."
disable-model-invocation: true
metadata:
  author: pablontiv
  updated: "2026-10-10"
---

# GitHub Issue

Convierte una necesidad en uno o más GitHub Issues y se detiene.

## Límites

- La invocación autoriza investigar, redactar y crear los GitHub Issues. No autoriza su implementación.
- No implementes, diseñes la solución, planifiques ejecución, edites el repositorio, crees Beads, abras PRs, ejecutes tests ni delegues.
- No invoques `work-lifecycle`, Roadmap, Superpowers ni otras skills. Superpowers puede comenzar después, sólo si el operador lo pide por separado.
- Usa el repositorio actual como destino. Si el destino es ambiguo, pregunta antes de investigar.

## Flujo

1. Extrae de la petición la necesidad, el resultado esperado y las restricciones expresas.
2. Investiga sólo lo necesario para comprobar el estado actual y redactar el ticket. Usa primero el contexto suministrado. No enumeres todo el backlog.
3. Lee las plantillas de issues y `CONTRIBUTING.md` del repositorio destino cuando existan. Busca duplicados y trabajo relacionado con términos específicos.
4. Clasifica cada resultado independiente como:
   - `bugfix`: hay un síntoma o comportamiento incorrecto observable;
   - `enhancement`: se solicita un comportamiento nuevo observable;
   - `spike`: un unknown material impide decidir el cambio correcto.
5. Redacta un solo issue por defecto. Divide sólo resultados que puedan aceptarse independientemente.
6. Crea los issues con `gh`, verifica título y URL, devuelve las URLs y detente.

## Contenido mínimo

```markdown
## Problem
<necesidad, síntoma o pregunta>

## Evidence
<hechos comprobados y referencias; marca unknowns como unknown>

## Expected outcome
<resultado observable, sin prescribir implementación innecesaria>

## Scope
<incluido y excluido>

## Acceptance criteria
- [ ] <criterio observable>
```

Añade `## Unknowns` sólo cuando cambie la clasificación, el alcance o la aceptación.

## Reglas de redacción

- Un bugfix nombra el síntoma, no una solución supuesta.
- Un enhancement describe el comportamiento deseado y el gap actual.
- Un spike formula la pregunta, la evidencia que debe producir y la decisión que habilitará; no entrega implementación.
- No inventes hechos, labels ni requisitos. Aplica únicamente labels existentes.
- Conserva el idioma del operador salvo que la plantilla del repositorio exija otro.
