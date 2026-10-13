---
title: "ADR 0001: provider keys in the main process"
group: dev
order: 41
summary: "Why provider API keys are stored encrypted in the main process and never returned to the renderer."
---
# ADR 0001: provider keys in the main process

**Status:** Accepted

## Context

Provider keys were kept in `localStorage`. Any script running in the renderer
origin could read them, and so could anyone with access to the browser profile.
The account tokens already used `safeStorage` in the main process.

## Decision

- Keys are stored with `safeStorage` in the main process, in a file under the
  user data folder.
- The renderer can save, delete and **list** which providers have a key. It
  never receives a key value back.
- The LLM handler looks up the key by provider id when it starts a stream.
- A key is **never written in plain text**. If encryption is unavailable, the
  save is refused and the user is told.
- An unreadable file (for example, the keyring is not ready yet) is not
  overwritten.

## Consequences

- On systems without an available keyring, users cannot save keys until one is
  available. This is deliberate.
- Keys saved before this change are moved on the next start. A key is removed
  from `localStorage` only after the store accepts it.
