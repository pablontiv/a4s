# Repository guidance

## Purpose

A4S reúne configuración de orquestación, métodos, artefactos portátiles y runtime para convertir coordinación agentic frágil en trabajo durable, estructurado y verificable.

Antes de trabajar, resuelve la política operativa desde `.workspace/config.yaml`. El perfil reusable bajo `profiles/pablontiv/` es material de referencia; la operación concreta proviene de la instancia del workspace.

## Boundaries

- Mantén configuración y runtime como capas del mismo producto, no como productos o decision logs paralelos.
- Mantén cada skill autocontenido bajo `skills/<name>/`; no introduzcas dependencias entre skills hermanos.
- Cada `skills/<name>/SKILL.md` declara `metadata.author: pablontiv` y `metadata.updated: "YYYY-MM-DD"`. Actualiza `updated` en el mismo commit que cambia el comportamiento o contenido del skill; los cambios sólo de metadata no la mueven.
- Un loop de Roadmap nunca edita `skills/roadmap`; los cambios al skill van en su propio PR y se activan instalando un tag `roadmap-vN` (runbook en `skills/roadmap/README.md`).
- Trata runtimes y herramientas externas como providers integrados, no como código propio de A4S.
- Añade familias top-level sólo cuando exista contenido real.
- Preserva ADRs, specs y planes históricos; sustituye decisiones en lugar de reescribirlas.
- Rootline gobierna Markdown durable bajo `.workspace/docs/`; Backscroll aporta memoria episódica cuando la historia pueda cambiar el trabajo.
- Los proyectos citados en `.workspace/docs/references/related-projects.md` son referencias, no candidatos implícitos a migración.

## Simplicity

- Prefiere la operación directa y reversible sobre frameworks, migraciones o taxonomías anticipadas.
- Aplica DRY y KISS antes de crear una nueva capa.
- Usa desarrollo empírico sólo cuando un unknown material requiera evidencia; no conviertas reorganizaciones ordinarias en experimentos.
- No implementes capacidades de control plane antes de satisfacer el gate runtime-first del ADR 0009.

## Safety

- Trata inventario y planificación como operaciones read-only.
- Exige autorización explícita y acotada antes de efectos externos destructivos.
- Falla cerrado ante ownership ambiguo, path drift, symlinks o estructuras no soportadas.
- Nunca interpretes una coincidencia textual como permiso para eliminar.

## Delivery

- Revisa el ADR aceptado que gobierna el cambio antes de implementar.
- Registra decisiones cross-cutting en `.workspace/docs/adr/` mediante Rootline.
- Mantén documentación y comportamiento sincronizados.
- Usa conventional commits y pull requests.
- Ejecuta los checks aplicables antes del commit y declara honestamente cualquier check diferido.
