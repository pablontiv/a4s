# Contrato de diagnóstico
Este contrato se combina con un módulo de lente. La lente define qué se
evalúa; este contrato define cómo se trabaja y qué se entrega.

# Objetivo
Diagnosticar la rama por defecto del repositorio (detéctala con git en lugar
de asumir main o master) a través de la lente indicada, para encontrar
hallazgos con evidencia. El resultado sirve para priorizar correcciones, así
que importa más la evidencia que el volumen.

# Modo
- Interactivo: hay un operador presente que lee el resumen.
- Desatendido: ejecución programada o de pipeline, sin operador.
Si no se indica, asume interactivo.

# Definiciones
- Unidad de análisis: la define la lente.
- Hallazgo: una unidad, o un grupo de unidades, que incumple un criterio de
  la lente, con evidencia.
- Verificado: reproducido por ejecución. Sospechado: sustentado solo por
  lectura de código o evidencia indirecta.

# Aplicabilidad
Antes de empezar, confirma que la lente aplica al repositorio (p. ej. una
lente de datos persistidos en un repo que no persiste datos). Si no aplica,
declara la razón y termina con ese único resultado.

# Restricciones (no negociables)
- El repositorio es de solo lectura: conserva la rama actual y el working tree
  tal como están (sin checkout, sin cambios). Si el checkout está en otra rama,
  extrae la rama por defecto a la carpeta temporal (p. ej. con `git archive`) y
  audita esa copia. Declara la rama y el commit auditados.
- Compilaciones, fixtures, bases de datos, ejecuciones e2e y resultados
  temporales van solo en la carpeta temporal del sistema o del harness, y sus
  efectos se quedan dentro de ella.
- Escrituras en el repo: en modo interactivo, solo el dump (su markdown y su
  JSONL) y solo si el operador lo pide. En modo desatendido, ninguna; los
  resultados van al directorio de salida de la ejecución.
- Trabaja de forma autónoma y sin preguntas durante el diagnóstico. Ante una
  ambigüedad, elige la interpretación más razonable y regístrala. En modo
  interactivo, las únicas excepciones son la solicitud de recursos y la
  confirmación de la ruta del dump.

# Recursos externos
- Usa dobles de prueba o instancias locales en lugar de servicios externos o
  bases compartidas, y deja intactos los procesos que no iniciaste.
- Si una unidad solo puede validarse con un recurso real, anótala y continúa
  con el resto.
  - Interactivo: al terminar, presenta en una única solicitud la lista de
    recursos necesarios y qué validarías con cada uno. Con la confirmación,
    usa solo los recursos aprobados y actualiza los hallazgos.
  - Desatendido: registra esas unidades como "no evaluada: requiere <recurso>".

# Método (a tu criterio)
- Divide el trabajo en unidades según la unidad de análisis de la lente y
  paralelízalas con subagentes si el entorno lo permite, hasta ocho a la vez.
- Si una unidad termina por timeout, el único reintento permitido es dividirla
  en partes más pequeñas y ejecutar cada parte una vez. Si alguna parte vuelve
  a fallar, regístrala como "no evaluada".
- Prefiere la evidencia por ejecución sobre la lectura del código. Indica qué
  método usaste en cada caso.
- Guarda el detalle completo de cada hallazgo en la carpeta temporal a medida
  que avanzas, para que puedas persistirlo aunque tu contexto se compacte.

# Resultados previos
- Busca resultados de diagnósticos anteriores de la misma lente: en modo
  interactivo, en la carpeta de research del repo; en modo desatendido, en la
  ruta que indique la invocación.
- Si existen, consolida: conserva los hallazgos previos que sigan vigentes,
  marca los resueltos, añade los nuevos y asigna a cada uno su estado temporal.
  Lo que entregues es siempre el resultado consolidado.

# Esquema de hallazgo
- id: huella estable de lente + ubicación + criterio (la misma causa produce
  el mismo id en cada ejecución)
- lente y unidad de análisis
- ubicación: archivo:línea, o componente si no aplica
- severidad:
  - crítica: pérdida o exposición de datos, o ejecución no autorizada, sin
    condiciones especiales
  - alta: lo mismo bajo una condición plausible, o una función principal que falla
  - media: falla con impacto acotado o con alternativa disponible
  - baja: deuda, inconsistencia o riesgo teórico
- evidencia y pasos para reproducir
- estado: verificado / sospechado
- estado temporal: nuevo / persistente / resuelto / regresión (requiere
  resultados previos; sin ellos, todo es nuevo)
- verificación propuesta: el test, benchmark o fixture determinista que
  detectaría este hallazgo en el futuro

# Entregables
- Resumen: rama y commit, lente, conteo por criterio y severidad, la lista de
  hallazgos críticos y altos, cambios respecto a la ejecución previa (si
  existe), unidades no evaluadas, solicitud de recursos (si aplica) y 2–4
  líneas de investigación nuevas, distintas de este diagnóstico. Cada lente
  puede añadir elementos al resumen.
- Detalle: inventario de unidades evaluadas, hallazgos con el esquema anterior
  agrupados por criterio, índice de funciones o componentes con hallazgos
  (la granularidad la define la lente; por defecto, funciones), supuestos
  tomados y unidades no evaluadas. En dos formatos: markdown legible y JSONL
  con un hallazgo por línea. Cada lente puede añadir secciones al detalle.
- Interactivo: muestra el resumen en pantalla. Solo si el operador lo pide,
  persiste el detalle en la carpeta de research del repo. Detéctala por
  convención (.workspace/, docs/research, research/, o lo que indique
  CLAUDE.md o AGENTS.md); si no existe, propón una ruta y espera confirmación.
- Desatendido: escribe resumen y detalle en el directorio de salida de la
  ejecución.
