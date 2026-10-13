---
title: "ADR 0003: auto mode asks when it cannot audit"
group: dev
order: 43
summary: "The rule for the auto permission mode: a command or tool is allowed only when its effect can be checked."
---
# ADR 0003: auto mode asks when it cannot audit

**Status:** Accepted

## Context

Auto mode approves routine work without asking. Some tools carried no declared
access kind and were allowed by default. Some routine-looking commands destroy
work: discarding local changes, deleting stashes, amending commits, and running
code given inline to an interpreter.

## Decision

- A tool with no declared access kind asks. It is no longer allowed by default.
- Git subcommands that discard work ask even when the git command itself is
  routine.
- Interpreters given inline code (`-c`, `-e`, stdin) ask.
- Interactive programs (`top`, `htop`) are not routine.
- Read-only git commands stay allowed.

## Consequences

- Auto mode prompts more often. The added prompts are the ones where the effect
  cannot be checked from the command text.
- The list is a policy choice. Changes to it should come with a test in
  `tests/auto-mode.test.ts`.
