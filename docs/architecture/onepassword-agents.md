# 1Password Agents (#693)

**Decision: descartar.**

The hypothesis was that 1Password Agents injects secrets to agents more safely
than the current age-based scheme. The 22 October 2026 product fills a partner
sign-in form after an on-device approval, and the password remains in
1Password. Native OMP is outside that partner list. This repository already
leaves credentials with the operator. The age ciphertext and named vault item
recorded for the operator's dotfiles and ynab already cover secrets an agent
must leave untouched. No path in this tree consumes an injected secret.

## Evidence

The radar source is
[the 1Password status](https://x.com/1Password/status/2113276767582498943).
This run did not receive that post body from the X API. The claims below are
the launch press release and product page for the same product, dated
22 October 2026.

The [press release](https://1password.com/press/2026/october/1password-for-agents-trust-layer-personal-ai-agents)
says the agent signs in without receiving or seeing the credential. The person
sees which credential is requested and why, and approves on their own device.
1Password fills the sign-in form. The password stays in 1Password. Launch
partners are Muse, Claude Duet, ChatGPT Work and dots, Grok Bot, and Townie.
Partners named as still in progress are Browserbase, Browser Use, Dana,
Instinct, KERNEL, Perplexity, Ramp, Tomo, and Wajo.

The [product page](https://1password.com/personal-ai-agent-integrations)
describes Agentic Autofill: after approval, 1Password fills the password or
one-time code into the sign-in page, and the agent sees that access was
granted. Personal integrations are for Individual and Family accounts on
1password.com. Accounts on 1password.eu and 1password.ca are unsupported.
Availability varies by partner.

Native OMP roles, Dagu, and this repository's station are absent from that
partner list. A station credential, a model provider key, and a Git credential
are operator material, held under the assignment-authority rule in
[AGENTS.md](../../AGENTS.md).

The developer surface that places a secret in a process is a separate product.
The [SDK tutorial](https://www.1password.dev/sdks/ai-agent) resolves
`op://vault/item/field` with `secrets.resolve` from controller code.
Authentication is the bearer `OP_SERVICE_ACCOUNT_TOKEN`, scoped to the vaults
granted to that service account. [`op inject`](https://www.1password.dev/cli/secret-references)
and [`op run`](https://www.1password.dev/cli/secrets-scripts) write the resolved
value into a file or the process environment. The tutorial keeps references in
non-dynamic controller code so the model does not invent them. The resolved
plaintext still enters the calling process, where an OMP tool that prints its
environment can copy it into the transcript. The March 2026
[Unified Access](https://1password.com/press/2026/mar/1password-unified-access)
announcement describes injection through partner control planes (Runlayer,
Natoma) and a later plan to issue scoped workload credentials at runtime.
That is an enterprise product integration.

This tree has no consumer for either surface. Apart from the citations in
this file, the checkout contains no `op://` reference, no service-account
token name, no `secrets.age` path, and no `.age` file. [AGENTS.md](../../AGENTS.md) keeps
credentials and external services operator-owned. Publication, local links,
service configuration, and Dagu human-task actions require explicit assignment
authority. [Private installation](../operations/private-install.md) copies an
OMP config into a smoke profile and leaves the credentials in place. The
[walkthrough](../operations/v1-walkthrough.md) records that no credential
files were copied.

The radar inventory of 27 October 2026 records the operator patterns this
spike was told to align with. This run's GitHub token returns 404 for those
private repositories, so the trees were not opened and were not edited:

| Record | Standing pattern |
| --- | --- |
| ynab | `YNAB_TOKEN` comes from the 1Password item in vault Familiar. The operator holds the item. |
| dotfiles | chezmoi plus age, with env helpers (dotfiles#8). Ciphertext can be versioned. The age identity stays with the operator. |

Reading a dotfiles checkout yields ciphertext until the operator applies the
age identity. A service-account token placed where `op` can run authorizes
every item that token can read for the life of the token, with no per-login
approval on the operator's device. That boundary is wider than ciphertext plus
an operator-held identity, and wider than the Agents product's one-login
device approval.

## Why there is no skill

A skill that called `op read`, `op inject`, or `secrets.resolve` would adopt
the injection API and place plaintext where the agent can observe it. A skill
that called Agentic Autofill would require a partner integration this
repository does not ship, and a vault session this repository must not store.
The operator-owned credential rule, the Familiar vault item, and age
ciphertext already keep the secret with the operator. Radar asked for a
comparison. The standing rule stays: the operator supplies a credential for
an authorized action.

## Dogfood

Station admission is blocked by the Dagu pin hold. This CloudAgent change is
the decision record only. It leaves the Dagu pin, `answers.json`, station
install, and #685 unchanged. Installing 1Password or an age identity would
require vault material, which stays out of the tree and out of the pull
request. No `op` binary was installed, no age key was generated, and the
private ynab and dotfiles repositories were not modified.
