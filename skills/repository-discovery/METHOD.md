# Continuous diagnosis

- **Owner:** A4S.
- **Contribution:** portable, opt-in repository diagnosis through independent lenses, with stable findings across audits.
- **Verification:** each audit delivers a summary and detailed evidence; it does not claim automatic enforcement.
- **Portability:** neutral to repository and execution environment; each repository opts in under its own policies.

**Input:** an operator or an authorized automated coordinator requests a repository diagnosis through specified lenses.

## Composition

Each audit combines:

1. [CONTRACT.md](CONTRACT.md): how to work and what to deliver, common to every lens.
2. A [lens module](lenses/): what to evaluate, its analysis unit and criteria.

The invocation declares interactive or unattended mode. Unattended work also specifies an absolute evidence directory and previous-result paths, when available. Record the repository, detected default branch and exact commit. See [SKILL.md](SKILL.md) for coordination, independent validation, consolidation and operator-approved backlog handoff.

## Lenses

Filenames remain stable; module content and new reports use English.

| Lens | Module | Suggested cadence |
|---|---|---|
| 0. Functional coverage | [lenses/0-cobertura-funcional.md](lenses/0-cobertura-funcional.md) | After each local integration into the default branch |
| 1. Trust boundaries | [lenses/1-limites-de-confianza.md](lenses/1-limites-de-confianza.md) | Weekly and when inputs or parsers change |
| 2. Data integrity and lifecycle | [lenses/2-integridad-y-ciclo-de-vida-de-datos.md](lenses/2-integridad-y-ciclo-de-vida-de-datos.md) | Weekly and when storage changes |
| 3. Resilience and concurrency | [lenses/3-resiliencia-y-concurrencia.md](lenses/3-resiliencia-y-concurrencia.md) | Weekly, in a disposable container |
| 4. Supply chain and publication | [lenses/4-cadena-de-suministro-y-publicacion.md](lenses/4-cadena-de-suministro-y-publicacion.md) | Each release |

## Additional research directions

These lenses need prerequisites not required by the modules above; they are not part of the shipped lens set:

- **Performance and capacity:** requires a baseline. The first audit establishes it; findings begin with the second.
- **External contract compatibility:** evaluates formats, APIs and schemas consumed by the system and requires their reference contracts.
- **Portability:** requires a CI matrix; it cannot be established from one machine.
- **Result quality:** applies to search or ranking systems and needs a curated reference dataset.

## Ratchet effect

Every verified finding proposes a deterministic test, benchmark or fixture. The operator decides which enter the repository through the normal reviewed delivery process. Over time those checks catch known failures and the lens can focus on new risks. A proposal alone is not an implemented regression check.

**Output:** the audit summary and the detailed evidence persisted when the mode or operator requires it, followed by the explicit validation and publication boundaries in [SKILL.md](SKILL.md).
