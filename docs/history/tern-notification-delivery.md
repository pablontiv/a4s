# Tern notification delivery probe

Historical observation, not a scheduling guarantee. The [current communication protocol](../../packages/omp-dagu/README.md#communication-protocol) remains authoritative.

In the [PASS probe](https://github.com/pablontiv/a4s/issues/965#issuecomment-6891533774) on Tern 0.9.18 / OMP 18.20.2, a busy pane recorded the message **immediately** with `steering:true` and could background its active tool to handle it; delivery was not deferred until turn end. Offline fixtures verify matching, not live scheduling.
