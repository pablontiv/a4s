# Lente 3: Resiliencia y concurrencia
- Objetivo: comprobar que el sistema conserva un estado válido ante
  interrupciones, recursos agotados y acceso simultáneo.
- Unidad de análisis: una operación con estado (escritura, migración,
  sincronización, reconstrucción, recuperación) combinada con un fallo
  inyectado.
- Primer paso: para cada operación, define su invariante, es decir, qué debe
  ser cierto después de un fallo y un reinicio (p. ej. "se aplicó completa o
  no se aplicó").
- Fallos a inyectar: terminación abrupta (kill -9) en puntos intermedios ·
  disco lleno · permisos revocados · archivo bloqueado por otro proceso · dos
  o más procesos simultáneos sobre el mismo estado · señal durante la limpieza.
- Criterios: invariante roto tras reinicio · corrupción · locks huérfanos que
  bloquean la siguiente ejecución · pérdida silenciosa · reintento no
  idempotente · recuperación que no converge · error sin mensaje accionable.
- Método: inyecta cada fallo y verifica el invariante después de reiniciar.
  Repite varias veces las pruebas de concurrencia; un fallo intermitente es
  sospechado hasta reproducirlo al menos dos veces.
- Restricciones propias: solo en contenedor o directorio desechable. Simula
  el disco lleno con un sistema de archivos de tamaño fijo (tmpfs o imagen
  loop), nunca llenando el disco real. Termina solo los procesos que inició
  esta lente.
