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

## Plugin Herdr

El mismo directorio es un plugin Herdr instalable desde GitHub:

```sh
herdr plugin install pablontiv/a4s/packages/synagent-bus
# desarrollo local
herdr plugin link "$PWD/packages/synagent-bus"
herdr plugin action invoke ensure --plugin a4s.synagent-bus
```

Al arrancar el servidor, el hook one-shot `ensure` crea o reutiliza el único
space `Synagent`, con cwd estable en el home del usuario, y abre el entrypoint
`bus` como tab `Bus` sin cambiar el foco. Un space preexistente único se adopta
sin cerrar ni modificar sus tabs previos. La acción global `ensure` ejecuta la
misma operación. El estado de coordinación (`runtime.json` y un lock con PID,
timestamp y token) vive en `HERDR_PLUGIN_STATE_DIR`; un lock cuyo PID ya no
existe se recupera tras un crash. La base MQTT sigue en la ruta de estado del
usuario indicada arriba. Para un override de plugin, define `SYNAGENT_PORT` o
`SYNAGENT_DB` en el entorno del servidor Herdr antes del arranque.

`ensure` falla cerrado si existen varios spaces `Synagent`, si un listener no
puede atribuirse al pane registrado, o si pane, proceso y listener no pueden
verificarse conjuntamente. Si el pane registrado sigue presente pero el broker
terminó, cierra únicamente ese pane de plugin y su tab de un solo pane antes de
abrir el reemplazo; rehúsa reparar un tab que contenga otros panes. No usa el
workspace enfocado y no es un supervisor continuo: la reparación ocurre al
volver a ejecutar la acción o al reiniciar Herdr.

## Límites y seguridad

No hay auth, TLS ni ACL. Cualquier proceso local puede publicar y falsificar un
remitente, por lo que el listener no debe exponerse fuera de loopback. MQTT no
aporta replay histórico, event sourcing, alta disponibilidad ni ACK semántico
fenceado. Una única instancia debe poseer cada directorio LevelDB.
