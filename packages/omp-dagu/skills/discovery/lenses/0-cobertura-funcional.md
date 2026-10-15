# Lente 0: Cobertura funcional
- Objetivo: encontrar trayectorias no accesibles, que no funcionen, sin
  pruebas o sin documentar, y trayectorias repetidas, duplicadas o divergentes.
- Unidad de análisis: trayectoria, el camino completo desde un punto de
  entrada (comando, endpoint, pantalla, función pública) hasta su efecto
  observable.
- Primer paso: inventaría todos los puntos de entrada y evalúa todas las
  trayectorias del inventario; las que no cubras se registran como no
  evaluadas. Divide el trabajo por módulo o punto de entrada.
- Criterios:
  - Por trayectoria: accesible · funciona · tiene pruebas unitarias ·
    documentada (README, docs, skills si existen). Registra además otras
    pruebas automatizadas que la cubran (indica el tipo); no sustituyen a las
    unitarias.
  - Entre trayectorias: repetida/duplicada (logran lo mismo por caminos
    distintos) · divergente (deberían comportarse igual y no lo hacen).
- Para "funciona", indica si la evidencia viene de ejecución o de lectura.
- En el resumen: la lista de trayectorias repetidas, duplicadas y divergentes,
  y la lista de funciones con problemas.
- En el detalle: sección propia de trayectorias repetidas, duplicadas y
  divergentes.
