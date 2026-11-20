# A4S: contrato operativo

## Alcance

A4S es un monorepo npm privado con extensiones en `packages/`, agentes en `agents/` y skills en `skills/`. `README.md` describe sus componentes y `.workspace/dagu/dags/feature.yaml` define el ciclo de issues. Los cambios deben mantener los contratos de los hosts y las pruebas de los workspaces afectados.

See the [glossary](docs/glossary.md) for scoped terminology; the linked package and skill documents remain authoritative.

## Prerrequisitos externos

- Node.js `>=22.19.0` y npm con soporte para workspaces y `package-lock.json`.
- Acceso a las dependencias fijadas por el lockfile, desde sus servidores o desde la caché local de npm.
- Dagu 2.26.0 en `PATH`, o su binario en `DAGU_BIN`, para las pruebas nativas aisladas que exige el gate.
- Las integraciones reales requieren sus hosts y credenciales correspondientes (OMP, Pi o Claude); Synagent requiere su bus MQTT. El gate local comprueba el código y sus pruebas, no sustituye la verificación contra esos servicios.

## Setup y comandos soportados

El setup se ejecuta desde la raíz del checkout, respetando los manifests y el lockfile versionados:

```sh
npm ci
```

El gate completo, desde la raíz del worktree, es:

```sh
bash scripts/gate.sh
```

`npm test` y `npm run typecheck` recorren los workspaces declarados por los scripts raíz.

## Límites operativos

Principio de permisos de la fábrica: permisos máximos dentro del espacio propio de cada línea. Límites duros y su aplicación real hoy (detalle en `packages/factory/CONTRACTS.md`):

- Aplicados por código: no hacer push ni merge a `main` fuera de `integrate` (lease de integración); no cambiar el estado Git compartido (guarda de Git compartido); QA no cambia el candidato (guarda del candidato).
- **Aún no aplicados por código, solo regla de prompt**: no cambiar la fábrica viva (servicio/config/runs de Dagu, ajustes/instancias de T3, `$STATE` de los runs, breaker, labels) y no manejar secretos. Los sigue la investigación/issue de frontera a nivel de SO (#1061).

Trabajar en el worktree asignado y preservar los cambios del operador. Mantener instalaciones reproducibles con `npm ci` y actualizar el lockfile junto con cualquier cambio intencional de dependencias.

El operador usa OMP. Las operaciones de publicación, push, PR y reconciliación de tareas humanas de Dagu requieren autorización explícita del encargo; el gate local por sí solo no las autoriza. Para el flujo de issues, seguir el skill `packages/omp-dagu/skills/dagu-feature/SKILL.md` y ejecutar el ciclo desde el clone primario según `README.md`, manteniendo la implementación en el worktree del issue. Configuraciones locales, credenciales y servicios externos permanecen bajo control del operador.
