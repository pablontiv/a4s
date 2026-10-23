# Lente 2: Integridad y ciclo de vida de datos
- Objetivo: comprobar que los datos persistidos se guardan íntegros, se
  recuperan correctamente y desaparecen de verdad cuando el sistema dice que
  los eliminó.
- Unidad de análisis: un tipo de dato persistido y su ciclo completo:
  creación → copias derivadas (índices, cachés, journals/WAL, logs,
  temporales, backups, snapshots) → actualización → borrado o purga.
- Primer paso: inventaría todo lo que el sistema escribe a disco y qué datos
  contiene cada lugar.
- Criterios:
  - Dato eliminado que sobrevive en alguna copia derivada
  - Dato sensible en logs, temporales, mensajes de error o telemetría
  - Escrituras no atómicas que pueden dejar estado parcial
  - Migraciones con pérdida o sin camino de recuperación
  - Lectura sin validación de integridad (corrupción aceptada en silencio)
  - Permisos de archivos de datos más amplios que lo necesario
- Método: trabaja con datos sintéticos que contengan cadenas canario únicas.
  Recorre el ciclo y, después de cada borrado o purga, busca los canarios en
  todo lo que el proceso escribió, incluidos los archivos binarios.
  Verificado = canario encontrado donde ya no debería estar, o corrupción
  reproducible.
- Restricciones propias: solo datos sintéticos. Los datos reales del operador
  quedan fuera del diagnóstico aunque estén en la máquina.
