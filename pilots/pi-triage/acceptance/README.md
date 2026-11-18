# Aceptación headless de Pi triage

Desde la raíz del worktree, con Node.js ≥22.19.0 y el **binario nativo** de Dagu 2.26.0 en `PATH` o en `DAGU_BIN`:

```sh
# Autoprueba del harness con sus propios fixtures.
node pilots/pi-triage/acceptance/run.mjs --fixture

# Corte vertical real; el worker sigue usando el proveedor fixture.
node pilots/pi-triage/acceptance/run.mjs --e2e

# Misma estación aislada, usando el adaptador del supervisor en vez de la UI de T3.
node --test pilots/pi-triage/acceptance/supervisor.integration.test.mjs
```

`--e2e` es el modo por defecto. Usa `.workspace/dagu/pilot/pi-triage-slice.yaml`, su compañero `pi-triage-slice.mjs` y `pilots/pi-triage/worker/triage.mjs`. Si alguno falta, devuelve `BLOCKED E2E` (código 2); un `PASS FIXTURE` no cubre los componentes reales. Si `dagu` en `PATH` es un wrapper que carga credenciales o apunta a una estación, el harness lo rechaza sin ejecutarlo: usa `DAGU_BIN=/ruta/al/binario/dagu`.

## Qué comprueba la prueba automática

- El worker opt-in (`A4S_PI_TRIAGE_FIXTURE=1`) devuelve una línea JSON estable con la identidad de la issue y del run.
- `APPROVE` y `REJECT`: `pi-triage-slice` escribe `triage.json`, espera en la tarea `decide` sin `decision.json` y termina `Succeeded` con la decisión correspondiente. `decide` se completa una sola vez, sin reintento.
- Duplicado: Dagu 2.26.0 devuelve `alreadyCompleted` al repetir la misma decisión sin encolar ni reanudar; cambiar el valor devuelve `409`. No cambian el estado persistido ni `decision.json`.
- Independencia: un proceso cliente inicia un tercer run. Se cierra solo ese cliente durante `Waiting`; otro cliente observa el mismo run y lo completa. Esto prueba la persistencia en Dagu, no la integración de la interfaz T3.

La prueba del adaptador usa los perfiles `supervise` y `observe` con Dagu real: inicio manual, consulta de la espera, rechazo de un token obsoleto, denegación del diálogo simulado, aprobación y veredicto. No prueba el diálogo del compositor ni el programador de T3.

Cada invocación crea `DAGU_HOME` y `STATE_ROOT` privados, escribe `${DAGU_HOME}/.a4s-pi-triage-slice`, copia únicamente el DAG bajo prueba con su compañero, si corresponde, y arranca Dagu con config explícita en un puerto libre de `127.0.0.1`. El harness usa un prefijo HTTP aleatorio; la prueba del adaptador usa `/api/v1` sin prefijo, como el perfil del supervisor. El scheduler procesa la continuación de `human.task`; no se levanta un coordinador. Los procesos reciben un entorno reducido sin `DAGU_*` heredadas, credenciales ni configuración de usuario. La config base privada aporta la variable opt-in a los pasos de Dagu sin editar el DAG. Hay bloqueos en `PATH` para `omp`, `tern`, `gh` y `git`: invocarlos falla la prueba. No requiere OMP, Tern, T3, GitHub ni proveedor real.

Al terminar o ante `SIGINT`/`SIGTERM`, el harness detiene los runs activos que inició, cierra su estación y elimina su directorio temporal. No usa ni limpia la estación del operador. Las aserciones leen los artefactos antes del teardown; ante un fallo se muestran los logs de la estación privada.

## Checklist manual de T3 — pendiente, no lo ejecuta el harness

Realizar después de integrar los carriles, con autorización del operador. Usar **otra estación desechable** del piloto: config explícita, loopback, `DAGU_HOME` marcado, `STATE_ROOT` privado y `A4S_PI_TRIAGE_FIXTURE=1`. La estación debe vivir en el backend, fuera del ciclo de vida de la interfaz. No reutilizar la estación del operador ni activar GitHub, push o PR.

- [ ] Abrir un hilo **Pi** de T3 con el carril integrado y apuntado a esa estación. Verificar que expone `factory_start`, `factory_status` y `factory_decide` sin abrir OMP ni Tern.
- [ ] Ejecutar `factory_start` para `fixture-1`; anotar el `runId` `pi-slice-*`. Con `factory_status` para ese mismo ID, comprobar `Waiting` en `decide` y `triage.json` con `issue: "fixture-1"`, `poc: "yes"` y el ID correcto.
- [ ] En T3, usar **Run now** sobre una tarea de solo lectura que consulte `factory_status` del ID anotado. Comprobar que observa el mismo run, no crea otro ni completa `decide` y no aparece `decision.json`.
- [ ] Sin decidir aún, cerrar únicamente la interfaz T3 (no detener el backend, la estación ni el run). Reabrir y consultar el mismo ID. Debe seguir en `Waiting` con su evidencia, sin reiniciar Dagu ni lanzar otro run.
- [ ] Ejecutar `factory_decide` con `APPROVE` para ese ID. Confirmar `Succeeded` y `decision.json` con `schemaVersion: 1`, el mismo ID y `APPROVE`. Si se repite la acción no debe haber otra transición. Repetir en un ID nuevo con `REJECT` y confirmar igualmente `Succeeded` y su decisión.
- [ ] Registrar IDs, estados, resultados de Run now y los contenidos de `triage.json` y `decision.json`; hacer teardown únicamente de la estación desechable. No marcar este checklist como aprobado a partir del PASS automático.
