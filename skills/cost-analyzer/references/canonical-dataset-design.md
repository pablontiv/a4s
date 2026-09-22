# Diseño: dataset canónico de sesiones y vistas de eficiencia

**Estado:** proposed
**Fecha:** 2026-09-21
**Scope:** `~/.agents/skills/cost-analyzer/`

## Objetivo

Unificar sesiones de **Pi**, **Claude Code** y **Codex** en un solo ledger canónico. Las vistas no reparsean logs: filtran y agregan el mismo dataset.

El sistema debe responder:

1. ¿Qué harness entrega más outcomes por costo/tokens? (`pi` vs `claude` vs `codex`)
2. Dentro de Pi, ¿qué extensión es más eficiente? (`pi-subagents-j0k3r` vs `pi-subagents`)
3. Dentro de Pi, ¿qué topología funciona mejor? (S1–S4)
4. ¿Cómo se distribuye ese resultado por modelo/proveedor?

## Decisiones

### 1. Ledger único

Cada parser produce `SessionRecord`; ningún reporte lee JSONL directamente.

```python
@dataclass(frozen=True)
class SessionRecord:
    id: str | None
    harness: Literal['pi', 'claude', 'codex']
    source_path: str
    schema_version: str
    started_at: datetime | None
    ended_at: datetime | None
    cwd: str | None
    model: str | None
    provider: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_native_usd: float | None
    topology: Literal['S1', 'S2', 'S3', 'S4'] | None
    pi_extension: Literal['pi-subagents-j0k3r', 'pi-subagents', 'mixed/unknown'] | None
    commits: frozenset[str]
    prs: frozenset[int]
    beads_closed: frozenset[str]
```

`topology` y `pi_extension` son `None` para Claude/Codex: esas dimensiones solo son válidas en Pi.

### 2. Parsers por fuente, no por vista

| Harness | Raíz | Fuente de costo | Topología / extensión |
|---|---|---|---|
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `usage.cost.total` | Sí |
| Claude | `~/.claude/projects/**/*.jsonl` | No nativa en log | No |
| Codex | `~/.codex/{sessions,archived_sessions}/**/*.jsonl` | No nativa en log | No |

Cada parser debe tolerar líneas inválidas y sesiones sin timestamps. El identificador de harness proviene de la raíz de almacenamiento, no de un campo interno como `originator`, porque Codex puede registrar `originator: Claude Code`.

### 3. Costos: real primero, estimado separado

- `cost_native_usd` es el único costo que puede llamarse “real”. Actualmente Pi lo provee.
- Claude/Codex muestran tokens y outcomes, pero `cost_native_usd = null` hasta tener una fuente verificable.
- Una fase futura puede añadir `cost_estimated_usd` con una tabla de precios versionada; nunca se mezcla ni sustituye el costo nativo.
- Las vistas comparativas deben reportar cobertura: `sesiones_con_costo / sesiones_totales`.

### 4. Commits y outcomes

- Los commits se deduplican por SHA **dentro de cada cohorte/vista**.
- Un mismo SHA puede aparecer en harness distintos; esto no prueba causalidad.
- PRs y beads siguen siendo outcomes auxiliares. No equivalen automáticamente a valor: pueden ser docs, pruebas no solicitadas o trabajo rehecho.
- El ledger conserva evidencia bruta por sesión; una posterior clasificación de “valor aceptado” debe añadirse como dimensión separada, no inferirse de commits.

### 5. Vistas

#### Harness overview

Agrupa por `harness`:

| harness | sesiones | costo nativo | cobertura costo | tokens | SHAs únicos | PRs | beads |

No declara ganador por dólares si cobertura de costo no es 100% o se mezclan costos nativos con estimados.

#### Pi extension overview

Filtra `harness='pi'`, excluye `pi_extension='mixed/unknown'` para ranking:

| extensión | sesiones | costo nativo | SHAs únicos | $/SHA | S1 | S2 | S3 | S4 |

Usa la frontera verificable `2026-09-04T04:43:09Z`; sesiones que la cruzan no se asignan.

#### Pi topology overview

Filtra `harness='pi'`:

| topología | sesiones | costo | SHAs únicos | $/SHA | modelo/proveedor |

#### Cross-tabs

- `Pi extensión × topología`
- `harness × modelo/proveedor`
- `Pi topología × modelo/proveedor`

No generar matrices de cardinalidad alta por defecto: usar flags específicos.

## Flujo

```text
JSONL source roots
  → source parser (Pi / Claude / Codex)
  → list[SessionRecord]  ← una fuente de verdad
  → outcome enrichment (git / gh / bd, opcional)
  → views (harness / extension / topology / crosstabs)
```

## Errores y límites

- Sesión sin timestamp: se conserva como `mixed/unknown` para extensión y queda fuera de rankings de extensión.
- Sesión sin cwd/repo: outcomes de git = vacío, no error.
- `gh`/`bd` ausentes: el reporte se degrada a tokens/commits y declara cobertura.
- Comparar periodos distintos es observacional, no A/B: cada vista presenta rango, cohorte y cobertura.

## Pruebas

1. Parser Pi conserva costo nativo y clasifica ambas serializaciones de subagent.
2. Parser Claude produce `harness='claude'`, tokens, `cost_native_usd=None`, `topology=None`.
3. Parser Codex produce `harness='codex'` aunque `originator` diga Claude Code.
4. La vista extension excluye mixed/unknown del ranking.
5. La vista harness no calcula $/SHA global si falta cobertura de costo.
6. SHAs duplicados en sesiones de una misma cohorte cuentan una vez.

## Fuera de scope

- Inferir valor real desde títulos/commits/docs/tests.
- Cobrar dólares estimados a Claude/Codex sin tabla de precios aprobada.
- Atribuir causalmente un commit a un orquestador o harness solo por proximidad temporal.
