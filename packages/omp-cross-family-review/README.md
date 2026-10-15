# OMP Cross-family Review

Extensión de OMP que prioriza modelos de familias distintas a las referencias de cada subagente de revisión. Para `reviewer` y `security-reviewer`, que revisan código escrito por `task`, excluye tanto la familia del modelo actual de la sesión como la de `@task`. Para `triage-reviewer`, que revisa la decisión de triage del padre, excluye solo la familia del modelo actual. El agente dedicado de triage se distribuye con `@a4s/omp-dagu`; `reviewer` conserva su uso para code review.

Conserva el modelo principal si pertenece a una familia no excluida; si comparte una familia excluida, promueve el primer candidato que califica. Ordena los demás candidatos que califican antes de los de familias excluidas y deduplica por proveedor/modelo conservando los specs originales (incluidos aliases y sufijos de thinking). `reviewer` y `security-reviewer` incorporan los fallbacks `@slow` y `@default`; `triage-reviewer` incorpora `@task`, `@slow` y `@default`. Sin padre o modelo principal resoluble, mantiene la selección existente. Si `@task` no resuelve, los revisores de código excluyen solo la familia del padre.

## Instalación global

Desde el clone principal de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run):

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-cross-family-review"
```

También se puede cargar el directorio con `omp -e /ruta/a/omp-cross-family-review`
sin cambiar settings globales. El hook se ejecuta después de la selección inicial
del agente.
