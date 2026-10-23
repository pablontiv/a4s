# Diagnóstico continuo

- **Owner:** A4S.
- **Contribución:** diagnóstico portátil y opt-in de un repositorio a través de
  lentes independientes, con hallazgos estables entre ejecuciones.
- **Verificación:** cada ejecución entrega un resumen y un detalle con
  evidencia; no se declara enforcement automático.
- **Portabilidad:** neutral al runtime y al repositorio; cada repositorio lo
  activa con sus propias reglas.

**Entrada:** el operador o un pipeline pide diagnosticar un repositorio con una
lente concreta.

## Composición

Cada ejecución combina dos piezas:

1. [`CONTRACT.md`](CONTRACT.md): cómo se trabaja y qué se entrega. Es común a
   todas las lentes.
2. Un módulo de [`lenses/`](lenses/): qué se evalúa, con qué unidad de análisis
   y con qué criterios.

La invocación indica el modo (interactivo o desatendido). En modo desatendido
indica también el directorio de salida y, si existe, la ruta de los resultados
previos.

## Lentes

| Lente | Archivo | Cadencia sugerida |
|---|---|---|
| 0. Cobertura funcional | [`lenses/0-cobertura-funcional.md`](lenses/0-cobertura-funcional.md) | Cada PR o merge |
| 1. Límites de confianza | [`lenses/1-limites-de-confianza.md`](lenses/1-limites-de-confianza.md) | Semanal y al tocar entradas o parsers |
| 2. Integridad y ciclo de vida de datos | [`lenses/2-integridad-y-ciclo-de-vida-de-datos.md`](lenses/2-integridad-y-ciclo-de-vida-de-datos.md) | Semanal y al tocar almacenamiento |
| 3. Resiliencia y concurrencia | [`lenses/3-resiliencia-y-concurrencia.md`](lenses/3-resiliencia-y-concurrencia.md) | Semanal, en contenedor desechable |
| 4. Cadena de suministro y publicación | [`lenses/4-cadena-de-suministro-y-publicacion.md`](lenses/4-cadena-de-suministro-y-publicacion.md) | Por release |

## Segunda ola (pendiente)

Estas lentes necesitan algo que las primeras no requieren:

- **Rendimiento y capacidad:** necesita una línea base. Su primera ejecución
  solo la establece; los hallazgos empiezan desde la segunda.
- **Compatibilidad de contratos externos:** cualquier formato, API o esquema que
  el sistema consume.
- **Portabilidad:** necesita una matriz de CI; no se puede hacer desde una sola
  máquina.
- **Calidad de resultados:** solo aplica a sistemas de búsqueda o ranking y
  necesita un conjunto de referencia curado.

## Efecto trinquete

Cada hallazgo verificado propone una verificación determinista (test, benchmark
o fixture). El operador decide cuáles entran al repositorio. Con el tiempo, lo
ya conocido lo detectan esas verificaciones y la lente se dedica a explorar lo
nuevo.

**Salida:** el resumen de la ejecución, y el detalle persistido cuando el modo
o el operador lo indican.
