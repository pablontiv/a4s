# Lens 3: Resilience and concurrency

Apply the common [diagnostic contract](../CONTRACT.md).

- **Objective:** establish that the system retains valid state under interruption, resource exhaustion and concurrent access.
- **Analysis unit:** a stateful operation (write, migration, synchronization, rebuild or recovery) combined with an injected failure.
- **First step:** define each operation's invariant: what must remain true after failure and restart, for example, "fully applied or not applied at all."
- **Failures to inject:** abrupt termination (`kill -9`) at intermediate points; disk full; revoked permissions; a file locked by another process; two or more simultaneous processes accessing the same state; a signal during cleanup.
- **Criteria:** invariant broken after restart; corruption; orphaned locks blocking the next execution; silent loss; non-idempotent retries; recovery that does not converge; errors without actionable messages.
- **Method:** inject each failure and check the invariant after restarting. Repeat concurrency checks several times; an intermittent failure remains suspected until reproduced at least twice.
- **Additional restrictions:** use only a disposable container or directory. Simulate disk full with a size-limited filesystem such as tmpfs or a loop image, never by filling the actual host disk. Terminate only processes started by this lens.
