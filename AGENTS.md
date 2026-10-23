# A4S: contrato operativo

## Alcance

A4S es un monorepo npm privado con extensiones en `packages/`, agentes en `.omp/agents/` y skills en `skills/`. `README.md` describe sus componentes y `.workspace/dagu/dags/feature.yaml` define el ciclo de issues. Los cambios deben mantener los contratos de los hosts y las pruebas de los workspaces afectados.

## Prerrequisitos externos

- Node.js `>=22.19.0` y npm con soporte para workspaces y `package-lock.json`.
- Acceso a las dependencias fijadas por el lockfile, desde sus servidores o desde la caché local de npm. En particular, el tarball de desarrollo de `@pablontiv/pion` requiere acceso a los releases de `pablontiv/pi` o una copia íntegra en la caché de npm. Ese release no está disponible públicamente; su disponibilidad es un prerrequisito para la instalación y el gate completo. CI documenta su alternativa de instalación y ejecuta un subconjunto de typechecks en `.github/workflows/ci.yml`.
- Orca instalado y en ejecución para crear worktrees administrados; su política de setup debe ser `run-by-default` para ejecutar automáticamente el hook heredado. Una invocación que requiera forzarlo puede usar `--setup run`.
- Las integraciones reales requieren sus hosts y credenciales correspondientes (OMP/Orca, Pi/Pion o Claude); Synagent requiere su bus MQTT. El gate local comprueba el código y sus pruebas, no sustituye la verificación contra esos servicios.

## Setup y comandos soportados

El `orca.yaml` raíz delega `scripts.setup` a `bash scripts/bootstrap.sh`. El script se sitúa en la raíz del checkout y ejecuta `npm ci`, respetando los manifests y el lockfile versionados. También puede ejecutarse manualmente desde cualquier directorio:

```sh
bash scripts/bootstrap.sh
```

El gate completo, desde la raíz del worktree, es:

```sh
npm ci && npm test && npm run typecheck
```

`npm test` y `npm run typecheck` recorren los workspaces declarados por los scripts raíz. Esperar a que termine el setup de Orca antes de iniciar estos checks: la creación del worktree puede retornar mientras la instalación sigue ejecutándose en su terminal de setup.

## Límites operativos

Trabajar en el worktree asignado y preservar los cambios del operador. Mantener instalaciones reproducibles con `npm ci` y actualizar el lockfile junto con cualquier cambio intencional de dependencias. Mantener el hook de Orca como delegación al bootstrap versionado.

The operator uses OMP. Publishing, push, PR and Dagu human-task reconciliation require explicit assignment authority; the local gate alone grants none. Follow `packages/issue-lifecycle/skills/issue-execution/SKILL.md` from the primary clone as documented in `README.md`, and implement only in the assigned issue worktree. Local configuration, credentials and external services remain operator-owned.
