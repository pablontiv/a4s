---
tipo: adr
estado: accepted
fecha: "2026-09-01"
contexto: "Node desvincula automáticamente la ruta física de un socket Unix creado por net.Server.close() y no expone una opción pública cleanup:false. Si esa ruta física también es el endpoint canónico anunciado, el cierre puede eliminar o sobrescribir endpoints ajenos bajo concurrencia."
decision: "Separar el endpoint canónico anunciado de la ruta física que posee Node: el servidor escucha en un socket privado dentro del directorio mode 0700 de la ejecución y publica el endpoint canónico como symlink a esa ruta privada. El cierre solo deja que Node limpie la ruta privada y no mueve, restaura ni sobrescribe el endpoint canónico."
alternativas: "Renombrar/restaurar el endpoint canónico durante close(); usar limpieza por identidad dev/ino sobre la ruta canónica; depender de APIs internas de Node; usar herramientas externas para fixtures de socket."
consecuencias: "Node solo puede autolimpiar la ruta privada que creó. El endpoint canónico puede quedar como symlink obsoleto tras una detención limpia y se retira en el siguiente arranque únicamente si apunta al patrón privado de a4sd y no acepta conexiones. Las pruebas de sockets Unix usan únicamente APIs incorporadas de Node."
---

## Contexto

El transporte IPC de E0 expone un endpoint local por ejecución. En Unix, ese endpoint es una ruta de filesystem. La revisión de Task 4 confirmó un hecho de plataforma: Node v26 no expone una API pública para desactivar la limpieza automática de rutas de sockets Unix durante `server.close()`. Por lo tanto, si Node escucha directamente en la ruta canónica anunciada, el cierre puede desvincular esa ruta por nombre sin que la aplicación pueda protegerla de reemplazos concurrentes.

La corrección previa intentó preservar la ruta con `rename()` antes del cierre y restaurarla después. Ese mecanismo era inseguro porque movía una ruta sin demostrar propiedad, dejaba libre la ruta canónica durante el cierre y podía sobrescribir un endpoint creado concurrentemente al restaurar.

## Decisión

El servidor ya no escucha directamente en el endpoint canónico Unix. En su lugar:

1. crea el directorio de ejecución con modo `0700`;
2. prepara el endpoint canónico rechazando endpoints activos;
3. escucha en una ruta física privada y corta dentro del mismo directorio;
4. publica el endpoint canónico como symlink relativo hacia esa ruta privada;
5. durante `stop()`, cierra el `net.Server` y permite que Node elimine solo la ruta privada;
6. no renombra, restaura, sobrescribe ni desvincula el endpoint canónico en el borde de apagado.

La limpieza del endpoint canónico queda limitada al arranque: si existe una ruta obsoleta, solo se retira cuando es observablemente inactiva. Para symlinks, además debe apuntar al patrón privado de `a4sd`; un symlink ajeno inactivo se rechaza en lugar de modificarse. Los sockets Unix obsoletos creados por procesos terminados anormalmente se prueban con conexión local y se eliminan solo si no aceptan conexiones.

Windows named pipes quedan excluidas porque no usan una ruta de filesystem que Node desvincule con esta semántica.

## Alternativas descartadas

- **Renombrar/restaurar la ruta canónica durante `close()`**: descartada porque crea una ventana en la que otro proceso puede crear un endpoint y luego ser sobrescrito por la restauración.
- **Limpieza por identidad `dev`/`ino` sobre el endpoint canónico durante apagado**: descartada porque sigue dependiendo de una comprobación previa a una mutación posterior sobre una ruta compartida.
- **Usar opciones internas o no documentadas de Node**: descartada porque Node v26 no ofrece `cleanup:false` público para este caso y depender de internals rompería compatibilidad.
- **Usar Python o herramientas de shell para fixtures de sockets Unix**: descartada porque la cobertura debe ser Node-only y no puede saltarse silenciosamente en plataformas Unix soportadas.

## Consecuencias

- Node queda como propietario exclusivo de una ruta física privada, por lo que su autolimpieza no puede eliminar directamente el endpoint canónico anunciado.
- El endpoint canónico permanece presente durante el cierre del listener y no se sobrescribe si otro endpoint aparece concurrentemente.
- Un apagado limpio puede dejar un symlink canónico obsoleto hasta que se elimine el directorio de ejecución o hasta el siguiente arranque, donde se limpia bajo condiciones observables.
- La implementación agrega una indirection por symlink en Unix, sin impacto en Windows.
- Las regresiones de propiedad y sockets obsoletos se prueban con procesos Node hijos terminados con `SIGKILL`, sin dependencias externas ni saltos silenciosos en Unix.
