# Coding standards

`AGENTS.md` defines mandatory tooling, validation, type-safety and documentation rules. The configured Oxlint rules and Oxfmt settings are authoritative for mechanically enforced style.

## Domain and boundaries

Use `GLOSSARY.md` terminology. Keep wallet behavior behind the wallet package's public interface; web routes and server functions adapt requests and responses. The root wallet entry is device-safe; server implementation stays behind `@workspace/wallet/server` and `*.server.ts`. Preserve the production boundary checks.

Validate external inputs with the existing Effect schemas and retain branded domain values. Compose wallet effects through the existing service and layer interfaces. Represent expected domain outcomes with the existing tagged result conventions; do not collapse distinct outcomes into generic failures.

Keep private signing keys on the device side. Preserve permanent username binding, replayable orders and ledger-based settlement. A submission acknowledgement or missing RPC history does not prove settlement or failure.

## Change design and verification

Prefer a small public interface that owns complete behavior. Add abstractions for demonstrated needs, and preserve existing package ownership when extending behavior.

For every change, retain tests only for distinct intended behavior through public interfaces: each must fail on a regression and remain valid through behavior-preserving refactors. Prune duplicate coverage and tests of removed code, platform guarantees, types, mocks themselves or implementation details. Use independent expected outcomes; rewrite valuable coverage around observable behavior and remove production code used only by pruned tests. For stateful wallet changes, cover relevant replay, concurrency and failure cases using the existing harness. Use `packages/wallet/README.md` for the isolated test database workflow. Scope verification to the affected behavior in addition to the mandatory repository checks.

Use `@effect/vitest` for wallet tests: ordinary `it` for synchronous cases and Effect-returning tests with `yield*` for effectful cases. Share services with scoped test layers; use fresh layers for dependency overrides. Keep database suites serial and on the live clock while wallet code and SQL use wall time; use `TestClock` only for code that reads Effect's clock.
