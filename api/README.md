# Scrakk Studio API

A REST API for the Scrakk account and social features: email/OTP login,
profiles, Terms acceptance, friends, direct messages, shared code files,
presence and releases. It runs on Node's built-in `http` module and has no
framework. It reuses the editor's own contracts from `src/shared`.

The API runs on one of two stores. Both have the same behavior:

| Store | Use it for | How it works |
| --- | --- | --- |
| `memory` (default) | local development, tests, the Postman suite | Keeps everything in RAM and copies the rules in `docs/backend/*.sql`: handle rules, friendship-gated DMs, rate limits and file quotas. Data is lost on restart. |
| `supabase` | a REST layer over the real backend | Uses the publishable key plus **the caller's JWT**, so RLS and the `security definer` RPCs decide what is allowed, as they do in the IDE. Login goes through the CLI's OTP API, and file sharing goes through the `social-file` Edge Function. It never uses the `service_role` key. |

## Run it

```bash
npm install
npm run api                               # http://127.0.0.1:8787, memory store
SCRAKK_API_STORE=supabase npm run api     # against the Supabase project
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCRAKK_API_PORT` / `PORT` | `8787` | Port to listen on |
| `SCRAKK_API_HOST` | `127.0.0.1` | Interface to bind (`0.0.0.0` in containers) |
| `SCRAKK_API_STORE` | `memory` | `memory` or `supabase` |
| `SCRAKK_API_EXPOSE_OTP` | `true` | Memory store only: return the login code as `devCode` |
| `SCRAKK_API_CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `SCRAKK_API_LOG` | `true` | One log line per request |
| `SCRAKK_SUPABASE_URL` / `SCRAKK_SUPABASE_KEY` | the IDE's public values | Supabase project + publishable key |
| `SCRAKK_API_BASE` | `https://api.scrakk.art/api` | CLI auth API that sends and verifies the OTP |

## Conventions

- JSON in, JSON out. Authenticated routes need `Authorization: Bearer <accessToken>`.
- List endpoints return `{ "items": [...] }`.
- Errors always use this shape, with a stable `code` that clients can switch on:
  `{ "error": { "code": "handle_taken", "message": "…", "details": { … } } }`
- Every response has an `X-Request-Id` header. If the request sends one, it is echoed back.
- Status codes: `400` malformed input, `401` no or invalid token, `403` not allowed
  (for example `not_friends` or `not_sender`), `404` not found or not visible to you,
  `409` conflict (`handle_taken`, `file_quota_full`), `410` expired file,
  `422` failed validation, `429` rate limited.

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | – | Liveness, version, active store |
| GET | `/v1/legal` | – | Current Terms version + links |
| POST | `/v1/auth/otp` | – | `{ email }` → `202 { sent, email, devCode? }` |
| POST | `/v1/auth/verify` | – | `{ email, code, consent?: { version, locale } }` → session |
| POST | `/v1/auth/refresh` | – | `{ refreshToken }` → new session (refresh tokens rotate) |
| POST | `/v1/auth/logout` | ✓ | Revokes the access token → `204` |
| GET | `/v1/me` | ✓ | Profile + `legal` state |
| PATCH | `/v1/me` | ✓ | Partial update: `displayName`, `handle`, `avatarUrl`, `bio`, `gender`, `customStatus`, `customStatusEmoji`, `customStatusExpiresAt` (`null` clears a field) |
| GET | `/v1/me/legal` | ✓ | `{ version, acceptedAt, locale, current }` |
| POST | `/v1/me/legal` | ✓ | `{ version, locale? }`: records acceptance (the server sets the timestamp) |
| GET | `/v1/users/search?q=` | ✓ | Handle or display name, min 2 chars, max 10 results |
| GET | `/v1/friends` | ✓ | Friends, each with `since` |
| DELETE | `/v1/friends/:userId` | ✓ | Unfriend → `204` / `404 friend_not_found` |
| GET | `/v1/friend-requests` | ✓ | Pending requests (`incoming` / `outgoing`) |
| POST | `/v1/friend-requests` | ✓ | `{ userId }` → `201 pending`, or `200 accepted` / `already_friends` |
| POST | `/v1/friend-requests/:id/accept` | ✓ | Recipient only |
| POST | `/v1/friend-requests/:id/reject` | ✓ | Recipient only |
| GET | `/v1/conversations/:peerId/messages?limit=&before=` | ✓ | `{ items, hasMore }`, oldest to newest; page back with `before=<items[0].id>` |
| POST | `/v1/conversations/:peerId/messages` | ✓ | `{ body, replyTo? }`. Friends only, 1–4000 chars, 7 msgs / 5 s |
| POST | `/v1/conversations/:peerId/read` | ✓ | Marks the peer's messages read → `{ updated }` |
| POST | `/v1/conversations/:peerId/files` | ✓ | `{ name, lang?, content, replyTo? }`. Shares a code file (≤ 512 KiB, ≤ 10 000 lines, 15 live per conversation) |
| PATCH | `/v1/messages/:id` | ✓ | `{ body }`. Sender only, text messages only |
| DELETE | `/v1/messages/:id` | ✓ | Sender only → `204` |
| GET | `/v1/messages/:id/file` | ✓ | `{ meta, content }` for a shared file (participants only) |
| DELETE | `/v1/messages/:id/file` | ✓ | Deletes the file and its message (sender only) |
| GET | `/v1/presence` | ✓ | Your presence + your friends' |
| PUT | `/v1/presence` | ✓ | `{ status: online\|away\|busy\|offline, activity?: { project?, file? } }` |
| GET | `/v1/releases?limit=&prerelease=` | – | Published releases, newest first |
| GET | `/v1/releases/latest` | – | Newest release |
| GET | `/v1/releases/:tag` | – | `v0.1.4` or `0.1.4` |

Profiles, messages, friends and presence use the same shapes as `src/shared/account.ts`
and `src/shared/social.ts` (`AccountProfile`, `DirectMessage`, `Friend`, `FriendRequest`,
`UserPresence`).

### Example

```bash
curl -s -X POST localhost:8787/v1/auth/otp -H 'Content-Type: application/json' \
  -d '{"email":"ana@example.com"}'
# {"sent":true,"email":"ana@example.com","devCode":"483920"}

curl -s -X POST localhost:8787/v1/auth/verify -H 'Content-Type: application/json' \
  -d '{"email":"ana@example.com","code":"483920"}'
# {"accessToken":"sk_at_…","refreshToken":"sk_rt_…","tokenType":"Bearer","expiresIn":3600,"user":{…}}

curl -s localhost:8787/v1/me -H 'Authorization: Bearer sk_at_…'
```

## Postman test suite

`api/postman/` contains:

- `scrakk-studio-api.postman_collection.json` has 70 requests and about 390 assertions in 8 ordered folders:
  meta, auth, profile & legal, friends, messages, shared files, presence and cleanup.
  Each run signs up two new users (A and B) and tests every endpoint, both the
  normal path and the error cases. A collection-level script also checks every
  response for the `X-Request-Id` header, a JSON body, the error shape and a
  response time under 2 s.
- `scrakk-studio-api.local.postman_environment.json` holds `baseUrl`
  (`http://127.0.0.1:8787`) and optional overrides for runs against real inboxes.

**One command** (starts a temporary in-memory API on a free port, runs the suite
with Newman, and exits with Newman's status code, so it works in CI):

```bash
npm run api:postman
npm run api:postman -- --base-url http://127.0.0.1:8787   # use an API that is already running
npm run api:postman -- -n 3 --reporters cli,junit          # extra args go to Newman
```

**In the Postman app:** start `npm run api`, import both files, select the
*Scrakk Studio API — Local* environment and run the collection with the
Collection Runner. Keep the default request order. Variables move from one
request to the next (tokens, user ids, message ids), and each run uses new
identities, so you can run it again against the same server.

**Against Supabase:** login codes arrive by email, so the run can't be fully
automatic. Set `signupEmailA` / `signupEmailB` to real inboxes in the environment.
Run *01 Auth* until the codes are sent, put them in `otpCodeA` / `otpCodeB`,
then run the rest. Checks that only apply to the memory store, such as the
OTP resend rate limit and the reuse of a rotated refresh token, skip themselves.

## Layout

```
api/
  server.ts            entry point (npm run api)
  src/app.ts           routes + dispatcher (CORS, request ids, error envelope)
  src/http.ts          ApiError, JSON body parsing, router
  src/validation.ts    input rules (shared with the IDE + SQL migrations)
  src/config.ts        environment
  src/store/types.ts   Store contract
  src/store/memory.ts  in-memory store
  src/store/supabase.ts Supabase store
  postman/             collection, environment, runner
```

Vitest coverage is in `tests/api.test.ts`. Typecheck with `npm run typecheck`,
which also checks `api/tsconfig.json`.
