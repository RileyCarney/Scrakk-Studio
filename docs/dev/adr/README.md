---
title: "Architecture decisions"
group: dev
order: 40
summary: "Index of the architecture decision records (ADRs): why the key decisions in the app were made."
---
# Architecture decisions

An ADR records one decision, its context, and its consequences. They are short
and stay where the code is, so the reasoning does not live only in chat history.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-provider-keys-in-main.md) | Provider API keys live in an encrypted main-process store | Accepted |
| [0002](0002-layer-rules.md) | Module layering is checked by a test, with a ratcheted debt list | Accepted |
| [0003](0003-auto-mode-allowlist.md) | Auto mode asks whenever access cannot be audited | Accepted |
