# A4S

A4S convierte trabajo multi-repo recurrente en capacidades incrementales para outer harnesses.

Las piezas sólo entran en la narrativa cuando son usables; las integraciones no definen la categoría de A4S.

El monorepo reúne capacidades que pueden evolucionar a ritmos distintos. Cada una documenta su alcance y sus requisitos sin prometer una suite completa, cobertura universal ni autonomía.

## Capacidades

- [`.workspace/`](.workspace/) contiene la configuración efectiva y el conocimiento gobernado de este workspace.
- [`profiles/`](profiles/) publica perfiles reutilizables de configuración.
- [`methods/`](methods/) contiene métodos de trabajo opt-in.
- [`skills/`](skills/) distribuye workflows portátiles y sus herramientas deterministas.
- [Roadmap](skills/roadmap/) publica un workflow Markdown sobre Beads para Plan, árbol pendiente, Doctor y loop secuencial, sin reclamar un runtime personalizado.
- [`agents/`](agents/) conserva roles portátiles con provenance explícita.
- [`output-styles/`](output-styles/) define contratos de interacción.
- [`src/`](src/) contiene el runtime experimental E0 y sus adapters.
- [`packages/pi-rule-compiler/`](packages/pi-rule-compiler/) contiene una extensión Pi para compaction y propuestas de reglas review-only.
- [`packages/typesafe/`](packages/typesafe/) contiene la superficie TypeSafe/Jev canónica gobernada por ADR 0020.
- [`test/`](test/) verifica runtime y contratos del repositorio.

## Integraciones

Pi, Herdr, TypeSafe, Jev, Rootline y Backscroll se integran mediante contratos explícitos. Una capacidad puede requerir una integración concreta; esas dependencias no definen la categoría de A4S ni convierten el monorepo en un runtime propio.

## Modelo

```text
Engineering Handbook 1.4
        → especialización
profiles/pablontiv/PROFILE.md
        → instancia efectiva
.workspace/config.yaml
        → materialización
capacidades A4S + integraciones externas
```

La configuración, los artefactos portátiles, los paquetes y el runtime experimental conservan límites explícitos. Los providers externos conservan su propia autoridad; A4S no los reemplaza ni se define por ellos.

## Dirección vigente

- [North Star](.workspace/docs/adr/0021-adoptar-monorepo-incremental-para-outer-harnesses.md)
- [Gate runtime-first](.workspace/docs/adr/0009-evaluar-runtime-externo-antes-de-construir-control-plane.md)
- [Arquitectura v0.9](.workspace/docs/specs/a4s-architecture-spec-v0.9.md)
- [Referencias a proyectos relacionados](.workspace/docs/references/related-projects.md)

Los ADRs y diseños del antiguo repositorio Handbook se preservan como historia en [`.workspace/docs/history/handbook/`](.workspace/docs/history/handbook/); no forman un segundo decision log.

## Verificación

Runtime TypeScript:

```sh
npm ci
npm test
npm run typecheck
```

Contratos de artefactos portátiles:

```sh
python -m pip install --disable-pip-version-check --no-deps -r requirements-test.txt
python -m unittest discover -s test -p "test_*.py" -v
python -m unittest discover -s profiles/pablontiv/tests -t profiles/pablontiv -p "test_*.py" -v
```

Cada skill conserva sus dependencias, helpers, fixtures y tests dentro de su propio directorio. [`skills/remove-gentle-context/`](skills/remove-gentle-context/) requiere un Python 3.11+ executable disponible como `python`, `python3` o un comando equivalente de la plataforma.

## Licencias

El código original de A4S no se distribuye bajo una licencia de reutilización (`UNLICENSED`); su lectura pública no concede permiso para copiarlo, modificarlo ni redistribuirlo. El alcance se aclara en [`NOTICE`](NOTICE). Los artefactos trasladados desde `pablontiv/handbook` conservan su licencia MIT en [`LICENSES/handbook-MIT.txt`](LICENSES/handbook-MIT.txt), y algunos subárboles incluyen licencias propias que prevalecen para esos artefactos.
