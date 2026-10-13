# Scrakk Studio: bug-fix and quality plan

> Audited at `670201b` (v0.1.4). This plan sits outside `docs/` on purpose:
> `docs/**` is published to docs.scrakk.art on every push to `master`, and
> this file lists unfixed security problems.

## 0. Baseline

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm test` | ✅ 133 files pass (1 skipped), 1279 tests pass (7 skipped), ~26 s |
| `node tools/i18n.mjs --check` | ✅ 0 missing / 0 stale |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities in runtime dependencies |
| `npm audit` (incl. dev) | ⚠️ 11 (3 high), all in build tooling (`electron-builder` → `node-gyp`/`@electron/get` → `undici`, `http-cache-semantics`; `vite` → `postcss` → `source-map-js`) |
| Size | ~111k lines of TS/TSX in 943 files, 130 `ipcMain.handle` channels |
| Lint / format | none configured. The code has `eslint-disable` comments, but there is no ESLint config. |
| Component (React) tests | none. Vitest runs in the `node` environment. |
| Main-process IPC handler tests | none for `ipc/fs`, `ipc/git`, `ipc/llm`, `ipc/terminal`, `ipc/extension-host`, `web/*`, `account/*`, `supabaseClient` |

How the plan is labeled:
- **Priority:** P0 = security or data loss · P1 = crash, hang or broken platform · P2 = wrong behavior · P3 = minor or cleanup.
- **Effort:** S < ½ day · M ≈ 1–2 days · L > 2 days.
- Every bug fix ships with a regression test, written to fail first. Part 2 lists them.

---

## Part 1: Bug fixes

### P0: security and data loss

#### B1. The shell-safety classifier misses `rm -rf /`, fork bombs and disk writes · S
`src/renderer/src/services/ai/policy/shell-safety.ts`

The classifier is the **only** guard on shell commands in the `bypassPermissions` and
`all_allow` modes (`shellBehavior: 'always'`). In those modes every command that isn't
rated `critical` is auto-allowed (`policy-engine.ts`, `checkShellSafetyWithMode`).
Running the current patterns gives:

| Command | Got | Expected |
| --- | --- | --- |
| `rm -rf /` | `high` (auto-allowed in "always" modes) | `critical` |
| `rm -fr /` | `high` | `critical` |
| `:(){ :\|:& };:` | `low` | `critical` |
| `echo x > /dev/sda` | `low` | `critical` |
| `RM -RF /` | `low` | `critical` |
| `git push origin main --force` | `medium` | `critical` |
| `git push --follow-tags` | `critical` (false positive) | `medium` |

Root causes:
- The `rm` regex expects the `r` flag and the `f` flag as separate tokens, so `-rf` and `-fr` never match.
- `\b:` and `\b>` need a word character right before `:` or `>`, so the start of a string or a space never matches.
- `--?f` also matches `--follow-tags`.
- Flags that come after positional arguments are never examined.
- All matching is case-sensitive.

**Fix:** tokenize each command segment, splitting on `;`, `&&`, `||`, `|` and newlines the way `autoMode.ts` already does. Then:
- Normalize case and expand combined short flags (`-rf` → `r`, `f`).
- Check the flag set wherever the flags appear in the argument list.
- Treat `/`, `~`, `$HOME`, `/*` and `--no-preserve-root` targets as critical.
- Anchor fork-bomb and device-write detection without `\b`.

Keep the result shape (`ShellSafetyResult`) unchanged.

#### B2. The webview Content Security Policy is built from the translation catalog · S
`src/main/ipc/extension-host.ts:151` (`webviewCsp`)

`default-src 'none'`, `frame-src 'none'`, `base-uri 'none'` and `form-action 'none'`
come from `t('main.default.src.none')` and the other `main.*.none` keys in
`i18n/catalogs/*/main.json`. The policy that isolates extension webviews therefore
depends on translation data:
- A machine translation (`npm run i18n -- --translate`) could change these strings.
- A missing key makes `t()` return the key name, and the browser drops it as an invalid directive.

In both cases the webview silently loses `default-src 'none'`.

**Fix:** inline these strings as constants and delete the four keys from both catalogs.
Then audit the catalogs for other non-UI strings (see A10).

#### B3. The account store can wipe stored sessions, and its writes aren't atomic · M
`src/main/account/session.ts`

- `read()` falls back to reading the file as plain text when decryption fails (`:69`). If the file is encrypted and the OS keyring isn't ready yet (common on Linux at login), `JSON.parse` fails and `read()` returns an **empty** store. The next `upsertAccount` or `setActive` then writes that near-empty store back in plain text, overwriting every other stored account.
- `writeFileSync` (`:94`) writes the file in place. A crash or power loss mid-write leaves a truncated file, which reads back as an empty store and logs the user out of every account.
- Every `getAccount()` call re-reads and decrypts the file synchronously on the main thread.

**Fix:**
1. Make `read()` return three outcomes: *ok*, *missing* and *unreadable*. Refuse to write while the store is *unreadable* (keep the session in memory and retry on the next call).
2. Write atomically: write `accounts.bin.tmp`, `fsync`, then `rename`.
3. Cache the decoded store in memory and invalidate the cache on write.

#### B4. Provider API keys sit in plain text in `localStorage` · M
`features/providers/state/ProvidersContext.tsx` and `features/providers/settings.ts`

Any script running in the renderer origin can read every API key, and so can anything
that can read the Chromium profile on disk. Account tokens already use `safeStorage`
in the main process. The LLM request already runs in the main process
(`ipc/llm.ts`), yet the renderer still sends the key over IPC with every request.

**Fix (no visible change):**
- Add a `secrets` IPC channel backed by `safeStorage`.
- Have `ipc/llm.ts` look up the key by `providerId`.
- Migrate existing keys once at boot, then delete them from `localStorage`.
- Have the renderer keep only a `hasKey` boolean.

### P1: crashes, hangs and broken platforms

#### B5. A directory watcher error can crash the main process · S
`src/main/ipc/fs.ts:229`

`fs.watch` returns an `EventEmitter` with **no `'error'` listener**. Deleting the watched
directory, or a permission error (Windows raises `EPERM` on deletion), throws an
uncaught exception in the main process. `scrakk/fs.ts:245` already handles this case
correctly.

**Fix:** add `watcher.on('error', () => closeWatcher(key, entry))` and send a final
`watchChanged` event.

#### B6. The integrated terminal is broken on Windows and leaks shells · M
`src/main/ipc/terminal.ts`

- The renderer always sends `shell: 'bash'`, and `getShell` (`:40`) maps it to `process.env.SHELL || '/bin/bash'`. Windows is a release target, and `/bin/bash` doesn't exist there, so `pty.spawn` throws.
- The working-directory fallback is `process.env.HOME || '/'` (`:50`). `HOME` usually isn't set on Windows, so this should use `os.homedir()`.
- `pty.spawn` isn't wrapped in `try`/`catch`. An invalid `cwd` (a folder deleted since the session was saved) turns into a rejected `invoke` instead of `{ success: false }`.
- `win?.webContents.send` (`:73`, `:76`) throws "Object has been destroyed" once the window is gone. That happens on macOS, where the app outlives its window. It also crashes the main process from inside the PTY data callback.
- PTYs aren't tied to their `webContents`. A renderer reload (HMR, Ctrl+R) or a closed window leaves the shells running.
- `getMonoFont` returns `Array.from(buffer)`, which turns a font of several MB into a JS number array about 10× its size on the IPC wire. It should return the `Uint8Array`.

**Fix:**
- Choose the default shell per platform: `COMSPEC`, `pwsh` or `powershell.exe` on win32, `$SHELL` elsewhere.
- Use `os.homedir()` for the default `cwd`.
- Wrap the spawn and return `{ success: false, error }` on failure.
- Guard sends with `isDestroyed()`.
- Track PTYs per `sender.id`, and kill them on `'destroyed'` and on `render-process-gone`.

#### B7. The main process has no global crash handling · S
`src/main/index.ts`

The main process registers no `uncaughtException` or `unhandledRejection` handler,
and the window has no `render-process-gone` or `unresponsive` handler. Today, B5 and
B6 take down the whole app with no record of why.

**Fix:**
- Log the error, write it to the feedback ring buffer (A7) and keep running wherever that's safe.
- On `render-process-gone`, offer a reload. Don't leave the window blank.

#### B8. Detecting repositories blocks the main thread · S
`src/main/ipc/git.ts:262`, `:290` (`GIT_IPC.detectRepos`)

This handler walks the tree with `readdirSync` and calls `execFileSync('git', ...)` for
each repository, with an 8 s timeout and up to 50 repositories. While it runs, every
window and every IPC call freezes.

**Fix:** use `fs.promises.readdir` and the existing async `run()` helper with a
concurrency limit. The output stays identical.

#### B9. Shutdown work at quit is fire-and-forget · S
`src/main/index.ts:136–139`

`void flushAllTokens()` and `void shutdownExtensionHosts()` start inside `before-quit`,
but the process exits before they finish. Refreshed tokens can be lost (the next
launch shows a "session expired" prompt), and on Windows the extension-host processes
can block the installer.

**Fix:** on the first `before-quit`, call `preventDefault()`, await both tasks under
a deadline of about 3 s, then call `app.quit()` again behind a re-entrancy flag.

### P2: wrong behavior

| # | Where | Bug | Fix | Effort |
| --- | --- | --- | --- | --- |
| B10 | `ipc/fs.ts:336` | In `execCommand`, `exitCode: error.code ?? 1` returns **strings**: `"ENOENT"` for a bad `cwd`, `"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` when output overflows (both verified). The contract types it as `number`. | Use `typeof code === 'number' ? code : 1`, the same rule `git.ts` `run()` uses, and add a `reason` field. | S |
| B11 | `ipc/llm.ts:194` | When the stream ends, the leftover `buffer` (a final `data:` line with no trailing newline) is dropped and `decoder` is never flushed. In-stream `{"error":…}` payloads are ignored, so the chat ends "done" and empty. The stream isn't aborted when the sender is destroyed. A duplicate `requestId` silently replaces the previous controller. | Move the SSE line parser into a pure function in `@shared` and test it there. Flush on `done`, surface `error` chunks, abort on `sender.once('destroyed')`, and reject duplicate `requestId`s. | S |
| B12 | `ipc/llm.ts:134`, `:272`; `ipc/git.ts:146`; `web/ssrf.ts`; `web/fetch.ts` | Some user-facing error strings are hard-coded in Spanish and bypass i18n (for example "El proveedor respondió…", "tiempo agotado", "Dirección bloqueada (SSRF)"). English users see Spanish. | Add catalog keys and use `t()` with variables. | S |
| B13 | `ipc/git.ts:151` | The `401\|403` alternative in the auth-error regex matches those digits anywhere in stderr (hashes, paths, line numbers), so unrelated failures are labeled as authentication failures. | Anchor it to phrases like `\bHTTP 40[13]\b` or `returned error: 40[13]`. | S |
| B14 | `ipc/git.ts:180` | `resolveInRepo` rejects legitimate files whose names start with `..` (for example `..env.local`), because it tests `relative.startsWith('..')`. | Test `relative === '..' \|\| relative.startsWith('..' + path.sep)`. | S |
| B15 | `ipc/git.ts:208` | `hasGit()` caches `false` forever. A user who installs git while the app is running must restart it. | Cache only `true`, or let a negative result expire after about 30 s. | S |
| B16 | `web/ssrf.ts` | `web_fetch` is auto-allowed in auto mode. Gaps: (a) `URL.hostname` keeps the brackets on IPv6 literals (`[::1]`), so `isIP` fails, DNS resolution fails, and public IPv6 URLs can never be fetched; (b) IPv4-mapped addresses in hex form (`::ffff:a9fe:a9fe`) aren't recognized; (c) multicast, broadcast, `198.18/15`, `fec0::/10` and `64:ff9b::/96` are missing; (d) the address is checked by one lookup and fetched by another (DNS-rebinding window); (e) loopback is allowed, so the agent can reach local admin ports without asking. | Strip the brackets, normalize mapped addresses, add the missing ranges, and connect through an `undici` `Agent` whose `connect.lookup` enforces the same check. Then either require a prompt for loopback in auto mode, or document the choice explicitly. | M |
| B17 | `policy/policy-engine.ts:330` | `evaluateExtension` uses `path.split('.').pop()`. For `Makefile` this returns the whole path, and for `/a/proj.v2/Makefile` it returns `v2/Makefile`, so both are denied. | Use `path.extname(basename)` and decide how extensionless files are handled. | S |
| B18 | `policy/autoMode.ts:196`, `:19–27` | Auto mode allows any tool with `access === null` (fail-open). The "routine" list includes destructive subcommands: `git stash clear` and `git stash drop`, `git branch -D`, `git checkout -- .`, `git commit --amend`. It also allows interpreters (`python -c`, `node -e`) and interactive programs (`top`, `htop`) that never exit. | Make `null` access ask. Add deny-lists for subcommands and flags inside routine prefixes. Drop `top` and `htop`. Mirror any change in scrakk-cli so the two tools stay in sync. **The decision belongs to the product owner;** the plan only flags it. | S |
| B19 | `extensions/types/activitybar/logic.ts:21` | If `resolveIcon` fails, the raw manifest string is passed to `dangerouslySetInnerHTML` (`ActivityBar.tsx:233`, `:259`). The CSP blocks scripts, but HTML and CSS injection (including tracking images) from a third-party `.sef` is still possible. | Never fall back to the raw string. Sanitize SVG strings with a small allow-list (or render them through an `<img src="data:image/svg+xml…">`). | S |
| B20 | `TerminalNodesView.tsx:624–648` | `pointerup` and `pointercancel` are both registered `{ once: true }`. Whichever one doesn't fire stays attached and calls a stale `endGrab` on a later, unrelated gesture. Unmounting mid-drag also leaks `pointermove`. | Use one `AbortController` per grab and abort it in `endGrab` and on unmount. | S |
| B21 | `ipc/fs.ts:101` | `readFile` has no size limit. Opening a log or binary file of several GB stalls the main process and can run out of memory. | Add a `maxBytes` to the request (default about 50 MB) and return a typed `too-large` error the editor can show. | S |
| B22 | `ipc/fs.ts:446` | The fallback grep's `TEXT_EXTENSIONS` lists `.env`, `.gitignore`, `.dockerignore` and `.editorconfig`, but dot-files are skipped earlier, so those entries are dead code. The fallback also duplicates `EXCLUDED_DIRS` from `searchFiles`. | Share one constant. Decide whether dot-files are searchable. | S |
| B23 | `ipc/fs.ts` writeFile / encodings write | Saves write the file in place (truncate, then write). A crash during save destroys the user's file. | Write to a temporary file in the same directory, then `rename`, preserving the file mode. | S |
| B24 | `main/index.ts:116` | `will-navigate` only intercepts `http(s)` URLs. A navigation to `file:` or to an unknown scheme still happens inside the app window. | Deny every navigation that isn't to the app's own URL. | S |

### P3: minor items, batched

- `social/service.ts:994`: every typing notification creates a new Realtime channel and removes it 2 s later. Reuse one channel per peer and throttle.
- The main window's CSP lacks `object-src 'none'` and `base-uri 'self'`. Add both.
- `npm audit` reports issues in dev tooling only. Bump `electron-builder` and `vite` when updates are available, and turn on Dependabot (see A9).

---

## Part 2: Test plan (no behavior change)

### T0. Regression tests for Part 1 (one per bug, written to fail first)

| Bug | Test file | Kind |
| --- | --- | --- |
| B1 | `tests/shell-safety.test.ts` | table-driven: about 60 commands × expected level, covering both false positives and false negatives |
| B2 | `tests/webview-csp.test.ts` | snapshot of `webviewCsp()`; assert it contains `default-src 'none'` under both locales and with a key missing |
| B3 | `tests/account-session.test.ts` | `vi.mock('electron')` with a fake `safeStorage`. Cases: keyring unavailable → write refused; truncated file → previous store kept; atomic rename |
| B5, B21–B23 | `tests/ipc-fs.test.ts` | handlers through a fake `ipcMain` (T1), using real temporary directories |
| B6 | `tests/ipc-terminal.test.ts` | `vi.mock('node-pty')`. Cases: per-platform shell, spawn failure, sender destroyed |
| B8, B13–B15 | `tests/ipc-git.test.ts` | temporary git repositories, nested repositories, error-message fixtures |
| B10 | in `tests/ipc-fs.test.ts` | bad `cwd`, `maxBuffer` overflow, timeout |
| B11 | `tests/llm-sse.test.ts` | the pure SSE parser: split chunks, no trailing newline, `error` payloads, multi-byte UTF-8 across chunk boundaries |
| B16 | `tests/ssrf.test.ts` | table of IPv4 and IPv6 literals and mapped forms; `lookup` mocked so tests stay offline |
| B17, B18 | extend `tests/auto-mode.test.ts` and add `tests/policy-engine.test.ts` | table-driven |
| B19 | `tests/activitybar-icons.test.ts` | an icon that fails to resolve never reaches HTML |

### T1. Make main-process IPC testable · M
Each `registerXIpc()` currently closes over `ipcMain` and Electron singletons. Without changing behavior:
- Split each one into `createXHandlers(deps) → Record<channel, handler>` plus a thin `registerXIpc()` that wires it up.
- Add `tests/helpers/fake-electron.ts`, providing a fake `ipcMain` that records handlers, a `WebContents` stub with `isDestroyed`, `send` and `once('destroyed')`, a fake `safeStorage`, and `app.getPath` pointing at a temporary directory.
- Order of work: `fs` → `git` → `llm` → `terminal` → `extension-host` → `account` → `web`.

### T2. Contract tests for preload and IPC · S
A test that imports `src/preload/index.ts` with `electron` mocked, and checks:
- every channel the preload uses has a handler registered by `registerAll()`;
- every `on(...)` subscription returns a working unsubscribe.

This catches renamed channels and leaked listeners.

### T3. React component tests · M
- Add `happy-dom` and `@testing-library/react` as dev dependencies. Opt in per file with `// @vitest-environment happy-dom`, so the 134 existing node tests don't change.
- First targets:
  - UI primitives: `Modal`, `ToggleSwitch`, `SegmentedTabs`, `ContextMenu`;
  - `AppErrorBoundary` and `PanelErrorBoundary` (render a component that throws, then check the fallback and the reset);
  - the Markdown renderer (sanitization: `<script>`, `onerror`, `javascript:` links);
  - the chat message list and tool rows;
  - the permission confirmation flow (`confirmation-bus`).
- Stub `window.api` with a typed fake generated from `WindowApi`.

### T4. Coverage reporting and a ratchet · S
- Add `@vitest/coverage-v8` and an `npm run test:coverage` script.
- Publish the coverage summary in CI.
- Set per-directory thresholds at **today's level**. Raise them as tests land; never lower them.
- Initial target: `src/main/ipc/**`, `services/ai/policy/**` and `src/main/web/**` at ≥ 80 % of lines.

### T5. End-to-end smoke tests in Electron · M
- Use Playwright's `_electron.launch()` against `out/main/index.js`. Chromium is already available in CI images; on Linux, run under `xvfb-run`.
- Smoke script:
  1. boot with no console errors;
  2. open a fixture folder;
  3. open a file, edit it, save it, and verify the bytes on disk;
  4. open a terminal and run `echo` (on win32 too, which covers B6);
  5. git panel shows status for a fixture repository;
  6. reload the window → no orphaned PTYs (B6) and no crash.
- Gate on PRs only for the Linux job at first. Run it nightly for Windows and macOS.

### T6. Cross-platform CI for unit tests · M
- `release.yml` skips the tests on Windows because `grammar-cli` breaks test collection under win32 (`.ts` imported from `.mjs`). Fix that collection problem, for example by moving the CLI under the `tools/` tsconfig and importing it through a `.ts` shim, or by marking it `skipIf(win32)` at **file** level. Then run `npm test` on `windows-latest` and `macos-latest` in `ci.yml`.
- POSIX-only cases already use `skipIf`. Keep it that way, and add a check that win32 skips don't exceed a set budget.

### T7. Property and fuzz tests for the parsers · S
Use `fast-check` on:
- `shared/git-parse.ts` (porcelain v2 status, log and numstat with odd file names: spaces, unicode, newlines, `->`);
- `compatibility/vscode/jsonc.ts`;
- the SSE parser (B11);
- `shared/encodings.ts` (EOL normalization round-trips);
- the `autoMode` tokenizer.

### T8. Backend (Supabase) tests · M
The migrations live in `docs/backend/*.sql`, outside Supabase's migration tooling. That means no row-level-security (RLS) tests, and they are part of the published docs folder.
- Move them to `supabase/migrations/`, keeping their order and names, so `supabase db reset` replays them.
- Add pgTAP tests (`supabase test db`):
  - you can only read your own messages and friendships;
  - rate-limit and integrity guards (`0017`, `0018`);
  - the `is_codefile_body` privilege boundary (`0022`, `0024`), which is the 42501 class of bug that keeps recurring in the social code;
  - legal consents are recorded per account (`0026`).
- Run the tests in CI with the Supabase CLI and a throwaway Postgres instance.

### T9. Performance regression guard · S
`tools/perf/baseline.mjs` already exists. Run it in CI against the stored baseline and **report** the difference without failing the build. Fail only on a regression of more than 20 % in startup or first paint.

---

## Part 3: Architecture hardening (behavior-preserving)

### A1. Linting and formatting · S → M
- ESLint flat config with `typescript-eslint` (type-aware), `eslint-plugin-react-hooks`, `eslint-plugin-import` (`no-cycle`) and `no-restricted-imports` for layering (A2), plus Prettier with the current style (no semicolons, single quotes, width about 100).
- Rollout:
  1. add the config with every new rule set to `warn`;
  2. format the codebase in one isolated commit and record it in `.git-blame-ignore-revs`;
  3. promote rules to `error` one at a time, each in its own PR.
- Rules worth having early: `react-hooks/exhaustive-deps`, `@typescript-eslint/no-floating-promises` (the codebase has many `void` promises; this makes the intent explicit), `no-empty` with `allowEmptyCatch: false` (see A7).

### A2. Enforce the documented layering · M
`docs/dev/architecture.md` says `services/` is framework-agnostic and contains no JSX. In practice:
- `services/` imports from `@features` **65 times**, a reverse dependency that creates import-cycle risk.
- `services/ai/tool-shell/*.tsx` and `services/extensions/types/tools/logic.tsx` contain JSX.

Plan:
- Add `dependency-cruiser`, or the ESLint rules from A1, with these boundaries:
  - `shared` imports nothing from `main`, `renderer` or `electron`;
  - `services` does not import `features`;
  - `components/ui` imports only `core` and `shared`;
  - `main` does not import `renderer`.
- Fix the existing violations: move the React views out of `services/` into `features/`, and invert the remaining dependencies with small interfaces or registries.

### A3. One IPC handling convention · M
There are 130 handlers in at least four styles: `{ success }`, `{ ok, data | error }` (git), raw throws, and `void`. Most cast their input (`request as X`) without validating it. Only `llm.ts` validates.
- Add one helper: `handle(channel, guard, fn)`. It should:
  1. check that `event.senderFrame.url` is the app origin (rejecting webviews and `scrakk-ext:`);
  2. validate input with a type guard;
  3. catch errors and return `{ ok: false, error: { code, message } }`;
  4. log failures.
- Migrate one domain at a time, keeping the response shapes so the renderer doesn't change. Only new channels use the unified envelope.
- Generate the `WindowApi` type and the channel list from a single table in `@shared`. This makes T2 automatic.

### A4. Resource lifecycle in the main process · M
Watchers, PTYs, LLM streams, Kolargrep servers, LSP clients and extension hosts each manage their own cleanup today. Some handle a destroyed `webContents` and some don't (B5, B6, B11).
- Add a small `Disposables` registry keyed by `webContents.id`. Dispose on `destroyed`, `render-process-gone` and `did-start-navigation` (reload), and run an awaited global dispose on quit (B9).
- Route every long-lived resource through it.

### A5. Break up the largest modules · L (incremental)

| File | Lines | Suggested split |
| --- | --- | --- |
| `main/extensions/host/vscodeApi.ts` | 1745 | one module per `vscode.*` namespace (window, workspace, commands, languages) |
| `features/layout/panels/GitPanel/GitPanel.tsx` | 1606 | `useGitStatus` / `useGitActions` hooks + `ChangesList`, `CommitBox`, `BranchMenu`, `HistoryView` |
| `features/editor/engines/innerta/innertaLoader.ts` | 1386 | WASM bootstrap, font loading, and an event bridge |
| `main/extensions/hostManager.ts` | 1218 | process supervisor vs. RPC routing vs. activation |
| `main/lsp/manager.ts` | 1166 | registry, routing (already separate) and restart policy |
| `features/social/state/SocialContext.tsx` | 1003 | a pure reducer in `services/social` + a thin provider |

Each split is a pure refactor. Before moving any code, add characterization tests that pin the current behavior.

### A6. One source of truth for provider settings · S
`features/providers/settings.ts` (non-React) and `ProvidersContext.tsx` (React) both read and write the same `localStorage` key. `setProviderVariant` writes the key, then React's persistence effect can overwrite it with stale state.
- Move to one store (`services/providers/store.ts`) with `get`, `set` and `subscribe`. React reads it through `useSyncExternalStore`.
- Combine with B4: keys move to the main process, and only the non-secret settings stay in this store.

### A7. Logging and error-handling policy · M
The source has **416 empty or silent `catch` blocks** and 149 raw `console.*` calls.
- Add a `logger` in `@shared` (levels, scope tag) with transports for the main process (rotating file in `userData/logs`) and the renderer (forwarded over IPC), plus an in-memory ring buffer that the existing feedback flow attaches.
- Write down the policy:
  - a silent `catch` is allowed only with a one-line comment saying why;
  - everything else at least calls `logger.debug`.
- Fix the critical paths first: `ipc/*`, `account/*`, `supabaseClient`, `extensions/*`.

### A8. Electron security baseline · S
- **Fuses** (`@electron/fuses` in an `afterPack` hook):
  - disable `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`;
  - enable `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`;
  - enable `EnableCookieEncryption`.
- `session.setPermissionRequestHandler` and `setPermissionCheckHandler`: deny by default, and allow only what the app uses (clipboard, possibly notifications).
- Navigation lockdown (B24), and an explicit `webview` and `frame` policy for `scrakk-ext:`.
- Check the sender on every IPC handler (A3).

### A9. CI and the supply chain · S
- In `ci.yml` and `release.yml`, use `npm ci` instead of `npm install` so builds follow the lockfile exactly.
- Pin Node in one place: `.nvmrc` plus `"engines": { "node": ">=22" }` in `package.json`. The README says 22+ and CI uses 24.
- Add these steps: `lint`, `test:coverage`, `npm audit --omit=dev --audit-level=high` (blocking), and the dependency-boundary check (A2).
- Add Dependabot (npm + GitHub Actions) and pin the actions by commit SHA.
- Make `i18n --check --strict` blocking in CI, as the comment in `ci.yml` already plans, now that coverage is 100 %.
- Add macOS to the release matrix, or document that it isn't supported. `electron-builder.yml` declares a `mac:` target, but no job builds it.

### A10. Keep code out of the translation catalogs · S
B2 shows the extractor collects non-UI string literals (for example the CSP directives; the `main.git.*` entries such as `git ls-remote` deserve a review too).
- Add a test that fails when a catalog value looks like code: a CSP directive, a quoted `'none'`, a command line with `--flags`, or a bare identifier.
- Add an ignore list or comment pragma (for example `// i18n-ignore`) to `tools/i18n-extract.mjs`.

### A11. Documentation · S
- Bring `docs/dev/architecture.md` in line with what the code actually does, after A2 and A3.
- Start `docs/dev/adr/`. Short architecture decision records (ADRs) for: the IPC envelope, the secrets location, the layering rules, and the auto-mode allow-list (B18).
- Update `docs/dev/contributing.md` to describe lint, coverage and E2E.

---

## Part 4: Order of work

Each milestone is a small set of focused PRs. Every PR stays green on `typecheck` and `test`.

**M1: Safety net and P0 fixes (week 1)**
1. T1 scaffolding (`fake-electron` helper) and T4 coverage reporting (report only).
2. B1 + table tests; B2 + CSP snapshot; B10, B13–B15 (small, already covered by the new git and fs tests).
3. B3 (account store) + tests.

**M2: Crash and platform fixes (week 2)**
4. B5, B21–B23 (fs) + `ipc-fs` tests.
5. B6 (terminal) + B7 (crash handlers) + A4 (disposables registry, introduced here).
6. B8, B9, B11, B12.
7. T6: tests running on Windows and macOS (this verifies B6).

**M3: Security hardening (week 3)**
8. B4 + A6 (secrets to the main process, one provider store).
9. B16 (SSRF), B19, B24, A8 (fuses, permission handler).
10. B17, B18, after the product owner decides on the auto-mode allow-list.

**M4: Tooling and structure (weeks 4–5)**
11. A1 lint and format (warn-only), then the format commit.
12. A2 dependency boundaries + fixing the 65 reverse imports.
13. A3 IPC helper, migrated domain by domain.
14. A9 CI updates; A10 i18n guard.

**M5: Wider tests and refactors (ongoing)**
15. T3 component tests, T5 Electron E2E, T7 property tests, T8 pgTAP.
16. A5 module splits, one per PR, each preceded by characterization tests.
17. A7 logger rollout; A11 docs and ADRs.

### Definition of done for every item
- A regression or characterization test exists and failed before the change.
- `npm run typecheck`, `npm test` and `node tools/i18n.mjs --check` pass. Once A1 and A4 land, lint and coverage must also pass at or above the ratchet.
- The changelog gets an entry in `docs/changelog/` for any change a user can notice. Security fixes are described in general terms until the release ships.
