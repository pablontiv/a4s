# OMP Cross-family Review

Extensión de OMP que prioriza modelos de una familia diferente a la del modelo actual de la sesión para los subagentes `reviewer` y `security-reviewer`.

Conserva el modelo principal si ya pertenece a otra familia; si comparte familia con el padre, promueve el primer candidato de otra familia. Ordena los demás candidatos cross-family antes de los de la misma familia, incorpora los roles `@task`, `@slow` y `@default`, y deduplica por proveedor/modelo conservando los specs originales (incluidos aliases y sufijos de thinking). Sin padre o modelo principal resoluble, mantiene la selección existente.

## Instalación global

Desde el clone principal de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run):

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-cross-family-review"
```
