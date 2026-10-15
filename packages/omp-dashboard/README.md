# omp-dashboard (PoC)

PoC de [a4s#149](https://github.com/pablontiv/a4s/issues/149). Es un panel local de solo lectura: muestra el estado, el progreso y las acciones pendientes de las sesiones omp vivas. El veredicto y la evidencia están en el issue.

```sh
bun packages/omp-dashboard/src/server.ts   # http://127.0.0.1:7788 (PORT para cambiarlo)
```

## Fuentes

Solo lee. No modifica omp ni Orca.

- **Procesos omp interactivos:** con `ps`. El transcript de cada sesión sale de su descriptor abierto con `lsof`.
- **Estado, `todo`, `ask` pendientes, herramienta en curso, título y costo:** del transcript `~/.omp/agent/sessions/<dir>/<sesión>.jsonl`, que el servidor lee de forma incremental.
- **Terminal de Orca:** con `orca terminal list --json`, cruzando el título que omp le pone a la terminal (`π - <título> - <carpeta>`).
- **Click en una sesión:** `POST /api/focus` → `orca terminal switch`.

## Límites conocidos

- **Asociación por título:** la terminal se asocia a la sesión por el título. Orca no expone el `pid` ni el `tty` de sus terminales, así que dos sesiones con el mismo título en la misma carpeta no se distinguen.
- **"Visto" local:** "turno terminado sin ver" se guarda en `localStorage` del navegador.
