# @a4s/synagent-bus

Broker MQTT local y durable de Synagent. Es una aplicación separada de
`@a4s/synagent`: este paquete posee el proceso Aedes y su estado LevelDB;
`@a4s/synagent` conserva el contrato canónico y los adaptadores de Claude y Pi.

## Instalación global

```sh
npm install --global @a4s/synagent-bus
synagent-bus
```

El bin requiere Node 22.19 o posterior y escucha exclusivamente en
`127.0.0.1`. Imprime `BROKER READY :<puerto>` sólo después de reservar el
listener, crear/abrir LevelDB e inicializar Aedes. Si el puerto ya está ocupado,
termina con código 0 y `BROKER ALREADY RUNNING`; no abre la base ni degrada a
memoria.

## Uso y desarrollo

```sh
synagent-bus [puerto] [dbdir-legado]
synagent-bus 1885 --db /ruta/al/estado
SYNAGENT_DB=/ruta/al/estado synagent-bus

# desde el monorepo; los argumentos se reenvían
npm run bus -- 0 --db /tmp/synagent-dev-db
npm test --workspace @a4s/synagent-bus
npm run typecheck --workspace @a4s/synagent-bus
```

La precedencia de la base es `--db`, segundo argumento legado,
`SYNAGENT_DB`, default. Los defaults son:

- macOS: `~/Library/Application Support/a4s/synagent/mqtt-db`;
- Linux: `${XDG_STATE_HOME:-~/.local/state}/a4s/synagent/mqtt-db`.

El directorio se crea con acceso del usuario (`0700`) cuando el sistema de
archivos lo permite. `SYNAGENT_PORT` es un override operativo opcional para el
puerto por defecto; el argumento posicional tiene precedencia. `SIGINT` y
`SIGTERM` cierran listener, broker y base limpiamente.

## Logging operacional

El broker escribe JSONL separado de stdout/stderr en
`${XDG_STATE_HOME:-$HOME/.local/state}/a4s/log/synagent-bus/<instance>/operational.jsonl`.
`A4S_SYNAGENT_BUS_LOG_DIR` permite cambiar sólo la raíz de logs. Los IDs de
instancia, operación y correlación pueden fijarse con
`A4S_SERVICE_INSTANCE_ID`, `A4S_OPERATION_ID` y `A4S_CORRELATION_ID`; el broker
genera los valores que falten. El logger normaliza el identificador de instancia
como un componente.
Verifica la ruta contra la raíz léxica y la raíz real disponible. Rechaza un
directorio de instancia que sea symlink o no sea un directorio. También rechaza
un archivo que sea symlink o no sea regular. Fuerza `0700` en el directorio.
Abre el archivo en append con `O_NOFOLLOW` cuando está disponible. Aplica
`fchmod(0600)` antes del primer byte. Si no puede garantizar la seguridad,
omite el logging. No usa un fallback inseguro.

Cada línea incluye severidad OTel, identidad de recurso, identidad del harness,
estado de flush, estado de pérdida, fase permitida y taxonomía de error. Los
eventos cubren el inicio, readiness, instancia existente, cierre y error del
broker.

`a4s.logging.flush_status=sync_requested` indica que el cierre siguiente
solicita `fsync`. Las demás líneas no solicitan un sync individual. Un fallo de
`fsync` no puede cambiar una línea ya escrita. Esta es una limitación del primer
JSONL local.

El logger comprueba el tipo, inode y la contención real. Aun existe una ventana
TOCTOU portable ante un reemplazo concurrente del path. Este candidato no usa
APIs no portables para cerrar esa ventana.

Los registros no contienen mensajes externos crudos, stack traces, payloads
MQTT, tokens, entorno, argv completo ni rutas de base. El JSONL nunca se escribe
a los canales de protocolo, por lo que conserva sin cambios las líneas
`BROKER READY` y `BROKER ALREADY RUNNING`.

## Límites y seguridad

No hay auth, TLS ni ACL. Cualquier proceso local puede publicar y falsificar un
remitente, por lo que el listener no debe exponerse fuera de loopback. MQTT no
aporta replay histórico, event sourcing, alta disponibilidad ni ACK semántico
fenceado. Una única instancia debe poseer cada directorio LevelDB.
