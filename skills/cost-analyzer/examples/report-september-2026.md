# Ejemplo de salida — septiembre 2026

Generado por `python3 assets/report.py --since 2026-09-01 --until 2026-09-21 --no-prs --no-beads`.

## Cuadro S1–S4

```
=== 4 ESCENARIOS (Pi) === desde 2026-09-01 hasta 2026-09-21 $13408

escenario                                       sess      costo      %   $/sess  tok/sess
S1: solo (un agente, todo)                       863 $    2260  16.9% $      3     3.7M
S2: solo + subagentes                             18 $    1159   8.6% $     64    54.5M
S3: orquestador + minions (sin subagentes)       247 $    2401  17.9% $     10    12.1M
S4: orquestador + minions con subagentes          55 $    7588  56.6% $    138   148.3M
```

## Por día

```
fecha          S1   S2   S3   S4    total     S1$     S2$     S3$      S4$   S4%
2026-09-04    149    2    7   19$    1223$    182$     26$    175$     841   69%
2026-09-08    119    1    8    2$    1009$     73$      7$     11$     918   91%
2026-09-17    146    4    7    7$    1324$     61$    324$    103$     836   63%
2026-09-18    107    3   83   20$    4263$    123$    228$    183$    3728   87%  ← ADR0015
2026-09-19     12    0    0    0$      40$     40$      0$      0$       0    0%
2026-09-21      3    0    1    1$     502$      2$      0$     71$     430   86%
```

## Outcomes por escenario (18-sept, sin PRs/beads)

```
escenario     N   commits  commits/sess   PRs  beads  sub_n  max_fan
S1 solo     107       207          1.93     0      0      0        0
S2 subags     3        29          9.67     0      0     17        1
S3 orq       83         8          0.10     0      0      0        0
S4 orq+sub   20        16          0.80     0      0     61        2
```

## Costo por outcome (18-sept)

```
escenario         $   $/commit     $/PR  $/bead  $/sub_n
S1 solo      $   123     $  0.59    $  -    $  -    $  -
S2 subags    $   228     $  7.86    $  -    $  -    $13.41
S3 orq       $   183     $ 22.88    $  -    $  -    $  -
S4 orq+sub   $  3728     $233.00    $  -    $  -    $61.11
```

## Lectura

- **S4 = 56.6% del gasto, 87% del gasto del 18-sept (día del ADR 0015)**
- **S1 entrega 1.93 commits/sesión a $0.59/commit** (el más eficiente)
- **S4 entrega 0.80 commits/sesión a $233/commit** (el más caro, 400× más que S1)
- **S3 orquesta sin entregar casi nada** (0.10 commits/sess) — coherente con su rol de dispatcher
- **S2 entrega 9.67 commits/sesión** pero a $7.86/commit (intermedio)
- **S4 con 0.80 commits/sesión pero $3728 de gasto = claramente ineficiente**

Con PRs y beads habilitados, el cuadro incluye `$/PR` y `$/bead` para que la comparación sea completa (no solo commits).
