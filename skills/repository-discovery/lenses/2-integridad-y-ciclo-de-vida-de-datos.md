# Lens 2: Data integrity and lifecycle

Apply the common [diagnostic contract](../CONTRACT.md).

- **Objective:** establish that persisted data is saved intact, recovered correctly, and actually disappears when the system says it has been deleted.
- **Analysis unit:** a persisted data type and its entire lifecycle: creation → derived copies (indexes, caches, journals/WAL, logs, temporary files, backups and snapshots) → update → deletion or purge.
- **First step:** inventory everything the system writes to disk and the data each location contains.
- **Criteria:**
  - Deleted data surviving in a derived copy.
  - Sensitive data in logs, temporary files, error messages or telemetry.
  - Non-atomic writes leaving partial state.
  - Lossy migrations or migrations without recovery paths.
  - Reads without integrity validation, silently accepting corruption.
  - Data-file permissions broader than necessary.
- **Method:** use synthetic data containing unique canary strings. Exercise the lifecycle; after every deletion or purge search for canaries across everything the process wrote, including binary files. A finding is verified when a canary remains where it should not, or corruption is reproducible.
- **Additional restrictions:** synthetic data only. The operator's real data is outside the diagnosis even when accessible on the machine.
