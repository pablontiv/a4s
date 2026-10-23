# Lente 1: Límites de confianza
- Objetivo: encontrar dónde una entrada o un actor no confiable puede producir
  efectos que el sistema no pretende permitir.
- Unidad de análisis: un límite de confianza (punto por donde entra algo
  externo: argumentos, archivos, rutas, variables de entorno, red, IPC,
  plugins, datos deserializados) y su recorrido hasta los sumideros sensibles
  que alcanza (sistema de archivos, shell, SQL, evaluación de código, red,
  asignación de memoria).
- Primer paso: construye el modelo de amenazas (actores, activos, entradas,
  límites y supuestos de confianza) e inclúyelo en el informe. Los hallazgos
  se refieren a él.
- Criterios:
  - Rutas: traversal, enlaces simbólicos, rutas absolutas o especiales
    aceptadas sin normalizar
  - Inyección: shell, SQL, plantillas, argumentos de comandos
  - Parsing o deserialización de formatos no confiables sin límites
  - Consumo sin límite: tamaño, profundidad, cantidad, expresiones regulares
    catastróficas
  - Condiciones de carrera entre verificación y uso (TOCTOU)
  - Permisos excesivos en archivos o directorios creados
  - Secretos en código, configuración, logs o mensajes de error
- Método: por cada límite, rastrea la entrada hasta sus sumideros y localiza
  la validación que la protege. Para verificar, construye una prueba de
  concepto mínima contra la copia local en la carpeta temporal.
- Restricciones propias: pruebas de concepto solo contra la copia local.
  Registra los secretos enmascarados (tipo y ubicación, sin el valor).
