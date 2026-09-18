# A4S

A4S convierte la coordinación frágil de agentes en trabajo durable, estructurado y verificable.

El repositorio reúne en un solo producto la configuración de orquestación, los métodos de trabajo, los artefactos portátiles y el runtime que los materializa.

## Componentes

- [`.workspace/`](.workspace/) contiene la configuración efectiva y el conocimiento gobernado de este workspace.
- [`profiles/`](profiles/) publica perfiles reutilizables de configuración.
- [`methods/`](methods/) contiene métodos de trabajo opt-in.
- [`skills/`](skills/) distribuye workflows portátiles y sus herramientas deterministas.
- [`agents/`](agents/) conserva roles portátiles con provenance explícita.
- [`output-styles/`](output-styles/) define contratos de interacción.
- [`src/`](src/) implementa el runtime E0 y sus adapters sin mover su layout histórico.
- [`packages/`](packages/) aloja providers autocontenidos como el compilador de reglas para Pi.
- [`test/`](test/) verifica runtime y contratos del repositorio.

## Modelo

```text
Engineering Handbook 1.4
        → especialización
profiles/pablontiv/PROFILE.md
        → instancia efectiva
.workspace/config.yaml
        → materialización
A4S runtime + providers externos
```

La configuración y el runtime pertenecen al mismo producto, pero siguen siendo capas distintas. Los providers externos —Pi, Herdr, Firstmate, Rootline, Backscroll y otros— conservan su propia autoridad y se integran mediante contratos explícitos.

## Dirección vigente

- [North Star](.workspace/docs/adr/0001-a4s-north-star.md)
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

El código original de A4S conserva su situación previa. Los artefactos trasladados desde `pablontiv/handbook` conservan su licencia MIT en [`LICENSES/handbook-MIT.txt`](LICENSES/handbook-MIT.txt), además de las licencias específicas incluidas por algunos artefactos.
