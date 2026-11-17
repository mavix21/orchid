# Project rules

Use Bun for package management and scripts.

After every change, run `bun lint` and fix every error in the source before continuing. Before committing, run `bun run typecheck`, `bun run fmt:check`, and `bun run build`; all must pass.

The configured @shadcn/lint and anti-slop rules are mandatory. Fix code rather than bypassing checks: never add oxlint-disable comments, lower severity, edit lint configuration to evade a finding, or add overrides or ignores. Preserve the existing authorized exceptions for generated UI primitives.

Use official documentation and installed package APIs. Do not introduce any/unknown, type assertions, suppression comments, or library patches to silence errors.

Keep no temporary records in any tracked file (.md, .txt, .json or otherwise): no test results, command outputs, evidence, review rounds, decision logs or dated status notes. Results go in the PR description, decisions in commit messages or the PR.

Docs describe only code that exists. Write no docs for unbuilt designs. Keep docs minimal and update them in place; delete a doc that goes stale instead of growing it.

Never write code comments, including JSDoc, inline explanations, TODOs, or commented-out code. Convey meaning and functionality through precise names, domain language from `GLOSSARY.md`, and clear code structure. Preserve executable shebangs, machine-required migration separators, and existing tool directives in generated files; these are not prose comments.

## Agent skills

### Issue tracker

Use GitHub Issues in `mavix21/orchid` for tickets and specs. Read `docs/agents/issue-tracker.md` before tracker operations.

### Triage labels

Use the five canonical roles in `docs/agents/triage-labels.md` when triaging issues.

### Domain docs

Use the single-context `GLOSSARY.md`. Read `docs/agents/domain.md` before domain exploration or terminology changes.

### Coding standards and pull requests

Read `CODING_STANDARDS.md` before implementation or code review. Read `docs/agents/pull-requests.md` before preparing a PR.

Repository rules take precedence over installed skill defaults. Keep research, handoffs, plans, review evidence and decision logs outside tracked files; put durable work requirements in GitHub Issues, results in PR descriptions, and decisions in commits or PRs.
