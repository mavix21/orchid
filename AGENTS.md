# Project rules

Use Bun for package management and scripts.

After every change, run `bun lint` and fix every error in the source before continuing. Before committing, run `bun run typecheck`, `bun run fmt:check`, and `bun run build`; all must pass.

The configured @shadcn/lint and anti-slop rules are mandatory. Fix code rather than bypassing checks: never add oxlint-disable comments, lower severity, edit lint configuration to evade a finding, or add overrides or ignores. Preserve the existing authorized exceptions for generated UI primitives.

Use official documentation and installed package APIs. Do not introduce any/unknown, type assertions, suppression comments, or library patches to silence errors.

Do not write temporary documentation in markdown: no test results, command outputs, evidence, review rounds, decision logs or dated status notes. Results go in the PR description, decisions in commit messages or the PR. Markdown is only for durable docs that describe the current system; update them in place, never append history.
