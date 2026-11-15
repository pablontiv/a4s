# A4S: contrato operativo

## Alcance

A4S es un monorepo npm privado con extensiones en `packages/`, agentes en `agents/` y skills en `skills/`. `README.md` describe sus componentes y `.workspace/dagu/dags/feature.yaml` define el ciclo de issues. Los cambios deben mantener los contratos de los hosts y las pruebas de los workspaces afectados.

## Prerrequisitos externos

- Node.js `>=22.19.0` y npm con soporte para workspaces y `package-lock.json`.
- Acceso a las dependencias fijadas por el lockfile, desde sus servidores o desde la caché local de npm.
- Las integraciones reales requieren sus hosts y credenciales correspondientes (OMP, Pi o Claude); Synagent requiere su bus MQTT. El gate local comprueba el código y sus pruebas, no sustituye la verificación contra esos servicios.

## Setup y comandos soportados

El setup se ejecuta desde la raíz del checkout, respetando los manifests y el lockfile versionados:

```sh
npm ci
```

El gate completo, desde la raíz del worktree, es:

```sh
npm ci && npm test && npm run typecheck
```

`npm test` y `npm run typecheck` recorren los workspaces declarados por los scripts raíz.

## Límites operativos

Trabajar en el worktree asignado y preservar los cambios del operador. Mantener instalaciones reproducibles con `npm ci` y actualizar el lockfile junto con cualquier cambio intencional de dependencias.

El operador usa OMP. Las operaciones de publicación, push, PR y reconciliación de tareas humanas de Dagu requieren autorización explícita del encargo; el gate local por sí solo no las autoriza. Para el flujo de issues, seguir el skill `packages/omp-dagu/skills/dagu-feature/SKILL.md` y ejecutar el ciclo desde el clone primario según `README.md`, manteniendo la implementación en el worktree del issue. Configuraciones locales, credenciales y servicios externos permanecen bajo control del operador.
