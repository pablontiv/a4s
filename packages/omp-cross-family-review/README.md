# OMP Cross-family Review

Extensión de OMP que compara familias mediante la API canónica `ctx.models.family`.
`qa` y `reviewer` usan elegibilidad estricta: conservan solo modelos de familias
admitidas y bloquean con candidatos/causa cuando faltan alternativas o identidad.
En el gate de `dagu-feature`, el guard acredita el implementador efectivo desde
su JSONL y vincula esa referencia al nombre del subagente antes del dispatch.
QA y reviewer pueden compartir familia; cada uno debe diferir del implementador.

Los candidatos se resuelven y deduplican por proveedor/id conservando specs,
aliases y thinking. El gate examina los candidatos solicitados y los roles
`@slow`, `@default`, `@task`; usa esa misma política estricta en el límite `task`.
Fuera de ese gate, QA/reviewer comparan con el modelo padre y `@task`.
`security-reviewer` conserva el orden preferente frente a padre y `@task`;
`triage-reviewer` conserva el orden preferente frente al padre y los roles
`@task`, `@slow`, `@default`.

La selección es preventiva; la admisión exige los proveedores/modelos de los
mensajes efectivos que emitieron los veredictos. El guard de `omp-dagu` valida
procedencia, SHA y familias y registra los fallbacks reales. Un fallback efectivo
de la familia del implementador bloquea aunque la selección inicial calificase.
El acceso de la TUI al store de Dagu hace este control advisory.

## Instalación global

Desde el clone principal de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run):

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-cross-family-review"
```

También se puede cargar el directorio con `omp -e /ruta/a/omp-cross-family-review`
sin cambiar settings globales. El hook se ejecuta después de la selección inicial
del agente.
