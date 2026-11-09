# Lens 1: Trust boundaries

Apply the common [diagnostic contract](../CONTRACT.md).

- **Objective:** find where an untrusted input or actor can produce effects the system does not intend to allow.
- **Analysis unit:** a trust boundary admitting external arguments, files, paths, environment variables, network traffic, IPC, plugins or deserialized data, and the path to sensitive sinks it can reach: filesystem, shell, SQL, code evaluation, network or memory allocation.
- **First step:** build a threat model of actors, assets, inputs, boundaries and trust assumptions. Include it in the report and relate findings to it.
- **Criteria:**
  - Path traversal, symlinks, or absolute/special paths accepted without normalization.
  - Shell, SQL, template or command-argument injection.
  - Unbounded parsing or deserialization of untrusted formats.
  - Unlimited size, depth or count, including catastrophic regular expressions.
  - Time-of-check/time-of-use races.
  - Excessive permissions on created files or directories.
  - Secrets in code, configuration, logs or error messages.
- **Method:** trace each boundary's inputs to sinks and identify the protecting validation. Verify with a minimal proof of concept against the disposable local copy in the temporary directory.
- **Additional restrictions:** proofs of concept target only the local copy. Report secrets redacted, showing type and location but never their value.
