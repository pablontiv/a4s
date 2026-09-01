---
tipo: adr
estado: accepted
fecha: "2026-09-01"
contexto: "El servidor IPC E0 usa sockets Unix con rutas de filesystem. Node puede desvincular la ruta del socket durante el cierre del listener, incluso si otro proceso o una carrera reemplazó esa ruta por un endpoint diferente. Además, una falla de arranque antes de establecer propiedad no debe limpiar una ruta que el servidor no llegó a poseer."
decision: "La propiedad de un socket Unix se establece solamente después de escuchar correctamente y capturar su identidad de filesystem. Durante el cierre, el endpoint actual se preserva temporalmente para evitar desvinculación implícita por ruta, se cierra el listener y luego se restaura el endpoint para que la limpieza explícita desvincule únicamente si la identidad actual coincide con la identidad capturada."
alternativas: "Mantener limpieza por ruta; depender de server.close(); validar solo existencia de ruta."
consecuencias: "La limpieza de sockets Unix queda protegida contra reemplazos de identidad y las fallas previas a la propiedad no eliminan endpoints ajenos. La implementación agrega una operación rename/restore durante el cierre Unix y mantiene a Windows fuera de esta ruta porque las named pipes no usan limpieza de filesystem."
---

## Contexto

El transporte IPC de E0 expone un endpoint local por ejecución. En Unix, ese endpoint es una ruta de socket. La revisión de Task 4 detectó que una falla de arranque podía ejecutar limpieza antes de establecer propiedad, y que la limpieza por ruta podía eliminar un endpoint que ya no pertenecía al servidor.

## Decisión

Capturar la identidad del socket Unix después de `listen()` exitoso y usarla como autoridad para la limpieza. Durante `stop()` o un cierre por error posterior a `listen()`, mover temporalmente cualquier entrada presente en la ruta del endpoint antes de cerrar el listener, restaurarla después del cierre y ejecutar limpieza explícita solo cuando `dev` e `ino` coincidan con la identidad capturada.

Windows named pipes quedan excluidas de esta lógica porque no dependen de una ruta de filesystem que deba desvincularse.

## Alternativas descartadas

- **Limpieza por ruta**: descartada porque una ruta puede ser reemplazada por otro endpoint entre `listen()` y `close()`.
- **Confiar en `server.close()`**: descartada porque se verificó que puede desvincular la ruta por nombre antes de que la aplicación pueda comparar identidad.
- **No limpiar sockets Unix**: descartada porque dejaría endpoints propios obsoletos y rompería arranques posteriores.

## Consecuencias

- La propiedad se vuelve explícita y verificable por identidad de filesystem.
- La limpieza posterior a fallas antes de establecer propiedad queda deshabilitada.
- El cierre Unix requiere una preservación temporal con `rename()`, pero solo en el borde de apagado y sin impacto en el flujo de mensajes.
