# Lens 4: Supply chain and publication

Apply the common [diagnostic contract](../CONTRACT.md).

- **Objective:** establish that builds and distributions contain what is expected, and that dependencies, CI, installation and update mechanisms resist tampering.
- **Analysis unit:** a supply-chain link: direct dependency, installation script, CI workflow, published artifact or update mechanism.
- **Criteria:**
  - Dependencies without lockfiles or pinned versions.
  - Known dependency vulnerabilities, using ecosystem tools such as osv-scanner, npm audit, pip-audit, cargo audit or govulncheck.
  - Install-time scripts such as postinstall, build.rs or setup.py without clear justification.
  - CI actions not pinned to a commit SHA, overprivileged tokens, or triggers executing untrusted code with access to secrets.
  - Download-and-execute installers without checksum or signature verification.
  - Artifacts lacking checksums, signatures or attestations; unreproducible builds.
  - Automatic updates accepting artifacts without verification.
- **Method:** begin with a static, local, network-free inventory. Vulnerability lookup and published-artifact verification require network access; treat them as external resources under the common contract. For installers and updates, serve a tampered artifact from a local server in the temporary directory and establish that it is rejected.
- **Additional restrictions:** remote access is read-only: no publication, tags or releases.
