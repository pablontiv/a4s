---
name: discovery
description: Diagnose an adopted repository through independent lenses in the Dagu discovery run, producing stable JSONL findings for validation and issue materialization.
---

# Diagnóstico por lentes

Opera el `human.task` `discover` del DAG `discovery`. El método común está en
[`METHOD.md`](METHOD.md), el contrato de ejecución en
[`CONTRACT.md`](CONTRACT.md) y cada lente en [`lenses/`](lenses/).

## Coordinación de `discover`

Lee en la salida de `snapshot` los valores `out_dir`, `sha` y `snapshot`. La
copia indicada por `snapshot` es el repositorio de solo lectura que se audita;
no trabajes sobre `PRIMARY` ni escribas dentro de la copia.

Interpreta `LENSES` como una lista separada por comas. El coordinador ejecuta
exactamente un subagente por lente solicitada, con un máximo de ocho subagentes
simultáneos. Cada asignación incluye:

1. `CONTRACT.md` y el módulo `lenses/<lens>-*.md` correspondiente.
2. La ruta de la copia `snapshot`, la rama por defecto y `sha`.
3. La ruta del out-dir y, cuando exista, `prior-<lens>.jsonl`.
4. La obligación de auditar autónomamente, mantener el repositorio en solo
   lectura y escribir únicamente `findings-<lens>.jsonl` en el out-dir.

Cada subagente escribe un objeto JSON por línea con las claves `id`, `lens`,
`unit`, `location`, `criterion`, `severity`, `evidence`, `reproduce`, `status`
y `verification`. `lens` coincide con la lente asignada; `id` es la huella
estable de lente + ubicación + criterio. Un archivo vacío representa una lente
aplicable sin hallazgos y es válido.

El coordinador espera a todos los subagentes y comprueba que exista un
`findings-<lens>.jsonl` por cada lente solicitada antes de completar el
`human.task`. No combina los archivos ni calcula el estado temporal: los pasos
deterministas posteriores del DAG validan cada JSONL y generan
`temporal-<lens>.jsonl`.
