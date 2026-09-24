---
tipo: spec
---
# Política Herdr subagent-first

## Propósito

Invertir la política de ejecución directa: todo trabajo no trivial se delega primero a un subagente durable antes de que empiece su ejecución.

## Decisión

En Herdr, un **Worker peer** es el subagente durable. Cada unidad no trivial se asigna a un Worker en un tab peer con un Bead reclamado. El Worker es una hoja: ejecuta exactamente su Bead acotado y no crea subagentes in-session ni delega de nuevo.

Esta semántica hace obligatoria la delegación sin crear recursión infinita.

## Invariantes preservados

- Un Bead reclamado, un Worker y un tab por unidad de trabajo.
- Un Worker conserva ownership de un repositorio, worktree, `TASK_ACK`, `TASK_RESULT` y el callback asociado.
- Las unidades independientes hacen fan-out a Workers peer distintos; las dependencias continúan serializándolas.
- El Verifier permanece independiente en su propio tab peer.
- Pushes, merges, borrados, secretos y otros efectos externos siguen siendo gates explícitos.

## Límites

Los subagentes nativos in-session no son unidades durables: no tienen Bead, worktree, callbacks ni autoridad externa. Por tanto siguen prohibidos dentro de un Worker peer. Este cambio no rediseña su ciclo de vida ni sus permisos.

## Cambios de la skill

Modificar `skills/herdr/SKILL.md` para:

1. Declarar en el frontmatter que el trabajo no trivial es subagent-first mediante Workers peer con Bead.
2. Reemplazar la prohibición general por la regla Worker-hoja no recursiva.
3. Ajustar los resúmenes de Safety para reflejar la delegación obligatoria y distinguir Workers peer de subagentes nativos.

## Verificación

- RED: tres escenarios de presión sin la regla eligieron trabajo directo en vez de delegar.
- GREEN: ejecutar los mismos escenarios con la skill modificada y comprobar que delegan el trabajo no trivial a un Worker peer, pero que el Worker hoja no recurre.
- Ejecutar las comprobaciones existentes de la skill y buscar prohibiciones o contradicciones residuales en `skills/herdr/SKILL.md`.
