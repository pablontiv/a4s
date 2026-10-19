# a4s-reconcile

`a4s-reconcile` converge Beads y Herdr una vez por ejecución. No usa modelos. El modo por defecto es `--dry-run`.

## Flujo

El reconciliador aplica estas reglas:

1. Valida la propiedad de Mission Control.
2. Despacha Beads listos con la etiqueta `auto-dispatch`.
3. Revisa Workers activos.
4. Cierra un Bead solo con un registro `TASK_RESULT` válido.
5. Cierra una pestaña terminada cuando pasan todas las guardas.
6. Crea un AttentionTicket para un estado que necesita atención.

El gate de Mission Control falla cerrado. El propietario debe tener un Bead `in_progress` con la etiqueta `mission-control`, un lease vigente y una identidad que coincida con Herdr. El reconciliador nunca muta ese Bead ni sus recursos.

`--callback` y `--orchestrator-target` son el mismo flag. El valor identifica al Project Orchestrator. El Worker envía sus preguntas solo a ese destino.

## Persistencia

La raíz estándar es:

```text
${A4S_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/a4s}
```

El reconciliador usa este árbol:

```text
<root>/log/reconcile/events.jsonl
<root>/audit/reconcile/audit.jsonl
<root>/state/reconcile/tick.lock
<root>/state/reconcile/attention/*.md
```

Los directorios usan modo `0700`. Los archivos usan modo `0600`. El reconciliador rechaza un enlace simbólico y un objeto que no sea regular.

`--root` y `--a4s-root` cambian la raíz. `--state-dir` queda como alias de migración. Si su valor termina en `reconcile`, el padre pasa a ser la raíz. Para otros valores, el valor pasa a ser la raíz. `A4S_RECONCILE_STATE` conserva la misma regla cuando termina en `reconcile`.

## Audit durable

Cada mutación externa pasa por `mutate()`. Hay seis operaciones:

- `bd.update`
- `bd.close`
- `herdr.tab.create`
- `herdr.tab.close`
- `herdr.agent.start`
- `herdr.agent.prompt`

Cada operación recibe un descriptor tipado. El audit no deriva datos desde el comando.

El protocolo usa este orden:

1. Valida las guardas y construye el comando.
2. Agrega un registro `intent` y ejecuta `fsync`.
3. Ejecuta el proceso una vez.
4. Agrega un registro `result` y ejecuta `fsync`.
5. Revierte una escritura parcial al tamaño inicial y confirma el tamaño.
6. Detiene las mutaciones del tick si el resultado queda `ambiguous` o si falla la persistencia del resultado.

Un rollback fallido marca el audit como corrupto. El proceso no inicia cuando falla el `intent`. Un fallo del `result` detiene el tick y conserva el `intent` pendiente cuando el rollback funciona.

Un `intent` sin `result` queda `pending`. Un código cero queda `applied`. Un fallo al crear el proceso queda `not-applied`. Un timeout, una señal, una excepción posterior al inicio o un código no cero queda `ambiguous`. El reconciliador no repite ni infiere la mutación.

Cada línea usa `a4s.audit/1`. Contiene estos campos:

```text
schema, record_id, mutation_id, event, utc, operation, ids, scopes, status, code
```

`ids` contiene solo IDs semánticos. `scopes` usa `bead:`, `dispatch:`, `tab:` y `agent:`. El audit nunca contiene comando, prompt, payload, ruta, entorno, stdout, stderr ni texto de error.

El parser valida UTF-8, JSON, claves duplicadas, newline final, tamaño, versión, IDs, scopes y orden. Un audit corrupto bloquea todas las mutaciones. Un estado abierto antiguo sin `scopes` también bloquea todas las mutaciones. Un estado `pending` o `ambiguous` con scopes bloquea solo un scope que intersecta.

No existe replay automático. Una persona puede cerrar un estado abierto con este comando exacto:

```bash
skills/herdr/scripts/a4s-reconcile \
  --audit-resolve <mutation_id> \
  --decision mutation-applied \
  --confirm-human
```

La otra decisión válida es `mutation-not-applied`. La resolución agrega una línea. No modifica líneas anteriores. El comando rechaza un ID desconocido, cerrado o ya resuelto.

Este comando muestra el estado sin cambiar audit, log ni estado funcional:

```bash
skills/herdr/scripts/a4s-reconcile --audit-status
```

## Log operacional

`events.jsonl` usa `a4s.log/1`. Registra inicio del tick, lock, snapshot, gate, AttentionTicket, resultado de mutación y resultado del tick. El log es best-effort. Un fallo del log no cambia el resultado. No hay rotación ni retención.

## Lock

`--apply` mantiene un lock exclusivo durante todo el tick. `--audit-resolve` usa un lock exclusivo. `--audit-status` usa un lock compartido. Puede crear el lock en la primera ejecución. El archivo nunca se trunca.

## Uso

```bash
# Plan. No crea directorios, archivos, lock, audit, log ni tickets.
skills/herdr/scripts/a4s-reconcile --dry-run --callback <orchestrator>

# Tick con mutaciones.
skills/herdr/scripts/a4s-reconcile --apply --callback <orchestrator>

# Plan sin el gate. Este flag solo funciona con dry-run.
skills/herdr/scripts/a4s-reconcile --plan-ignoring-mc-gate --callback <orchestrator>
```

Cada consulta `bd` usa `--readonly` en dry-run. Un snapshot inválido aborta antes de una mutación.

## launchd

`dev.a4s.reconcile.plist` es una plantilla. Envía stdout y stderr a `/dev/null`. El log operacional queda en el árbol estándar.

```bash
sed -e "s#__REPO__#/ruta/a4s#g" \
    -e "s#__HOME__#$HOME#g" \
    -e "s#__CALLBACK__#<orchestrator>#g" \
  skills/herdr/scripts/dev.a4s.reconcile.plist \
  > ~/Library/LaunchAgents/dev.a4s.reconcile.plist
plutil -lint ~/Library/LaunchAgents/dev.a4s.reconcile.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.a4s.reconcile.plist
```

## Pruebas

```bash
python3 -m unittest discover -s skills/herdr/tests -t skills/herdr
```

Las pruebas usan ejecutables falsos. No contactan Beads, Herdr ni un proveedor.
