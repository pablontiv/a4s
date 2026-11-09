# Lens 0: Functional coverage

Apply the common [diagnostic contract](../CONTRACT.md).

- **Objective:** find unreachable, broken, untested or undocumented paths, as well as repeated, duplicated or divergent paths.
- **Analysis unit:** an end-to-end path from an entry point (command, endpoint, screen or public function) to its observable effect.
- **First step:** inventory every entry point and evaluate every path in that inventory. Record uncovered paths as not evaluated. Partition work by module or entry point.
- **Criteria:**
  - Per path: reachable; works; has unit tests; documented in README, docs or skills when present. Also record other automated coverage and its type; it does not replace unit tests.
  - Between paths: repeated/duplicated paths achieve the same outcome by different routes; divergent paths should behave alike but do not.
- For the claim that a path works, distinguish execution evidence from code reading.
- **Summary additions:** list repeated, duplicated and divergent paths, and functions with problems.
- **Detail additions:** a dedicated section for repeated, duplicated and divergent paths.
