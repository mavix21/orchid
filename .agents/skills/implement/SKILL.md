---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title, then create the ticket's branch as `AGENTS.md` describes before changing anything. If the reference is ambiguous, ask.

Build each slice directly and verify it by running it. Call the Skill tool with "tdd" for slices that touch fund safety, as the Testing section of `CODING_STANDARDS.md` defines it, at pre-agreed seams.

Run typechecking regularly, affected test files regularly, and the full test suite once at the end.

Commit your work to the ticket's branch, or to the current branch when there is no ticket.

Once done, call the Skill tool with "cross-review" to review the work before pushing or opening a PR.
