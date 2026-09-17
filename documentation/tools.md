# Tools

13 local tool executors (`src/tools.ts`). Node builtins plus global fetch only. Every executor returns a string and never throws across the tool boundary: failures come back as `Error: ...` strings so the model can react.

Source of truth for names and shapes is `TOOL_DEFINITIONS` in `src/tools/registry.ts` (re-exported through the `src/tools.ts` barrel). The validator and loop build their `Available: ...` lists from it.

## Extension tools

Extensions can register brand-new model-callable tools via `api.registerTool({ name, description, parameters, execute, requireApproval? })` (`src/extensions.ts`, store in `src/tools/custom.ts`). From the model's perspective they behave exactly like builtins: they appear in the tool definitions sent on every chat POST (`allToolDefinitions()`, including the Anthropic/Gemini adapters), validate args inline (`Error: invalid call: ...`, never runs on bad args), dispatch through the shared loop with identical cancellation semantics, and a throwing implementation degrades to an `Error:` result string. They carry no scheduler effect metadata, so they always execute as serial singletons. Approval default is fail-closed: custom tools require approval unless the registration opts out with `requireApproval: false` (reserved for pure side-effect-free helpers). Names must match `[A-Za-z0-9_-]{1,64}` and must not collide with builtins or each other — violations throw loudly at registration.

## The 13 tools

| Tool | What it does | Permission in normal mode |
|---|---|---|
| `read` | Read files (UTF-8 text, or PNG/JPEG/GIF/WebP as vision input), list directories. Args: `path`, optional 1-based `offset`/`limit` (text only) | auto |
| `write` | Create or overwrite files (creates parent dirs). Silent pre-mutation snapshot for rewind | asks |
| `edit` | Exact-match patch. Fails on no match, on multiple matches without `replaceAll`, on stale read | asks |
| `grep` | Line-regex search under `dir` (a directory, or a single file to search just it). Case-sensitive; `(?i)` prefix = case-insensitive. `include` glob with `{a,b}` (e.g. `*.{ts,tsx}`), `outputMode`: `content`, `files_with_matches`, `count` | auto |
| `glob` | List paths matching pattern (`*`, `?`, `**`, `{a,b}`) under `dir` (a directory, or a single file to test just it), newest-first | auto |
| `bash` | Shell command. JSON result with `exitCode`, `stdout`, `stderr`. Optional `runInBackground` | asks |
| `bash_output` | Poll a background shell task by `taskId` | auto |
| `webfetch` | Fetch a page as `markdown`, `text`, or `html`. http upgrades to https. Gated by the network SSRF policy (see below) | auto |
| `websearch` | Keyless discovery via DuckDuckGo HTML endpoint. `query`, optional `numResults`, `site` | auto |
| `ask_question` | Interactive picker for clarifications. Single shape (`question` + at least 2 `options`) or batch `questions[1-5]` shown one-by-one with `Q i/N` progress; `allowCustom` per question; Esc cancels the current question | n/a (is interaction) |
| `todowrite` | Replace the session task checklist | auto |
| `todo_get` | Read the session task checklist | auto |
| `todo_update` | Update one checklist item by index | auto |

Read-only set: `read`, `grep`, `glob`, `webfetch`, `websearch`, `bash_output`, `todowrite`, `todo_get`, `todo_update`. Approval set: `write`, `edit`, `bash`. `ask_question` never needs approval because it is user interaction.

## Caps and truncation

| Path | Cap | Behavior |
|---|---|---|
| `read` output | ~64KB | Head plus truncation note. Full text spills to `<tmpdir>/atom-overflow/` with a `read` pointer |
| `read` image | 8 MiB per image | PNG/JPEG/GIF/WebP attach as vision input (see below); larger images refused with downscale guidance |
| `bash` stdout/stderr | ~8KB each | Each stream capped independently, JSON flags `stdoutTruncated`/`stderrTruncated`, overflow pointer on spill |
| `bash_output` streams | ~8KB each | Same spill behavior for background stdout/stderr |
| `webfetch` download | ~1MB | Noted as `[truncated: download exceeded ~1MB]` |
| `webfetch` output | ~64KB | Same overflow-file pointer as `read` |
| `grep` content | 100 matches | Lines over 200 chars shortened with an ellipsis. `file:line: text` shape |
| `grep` files/count | 100 files | `files_with_matches` is newest-first with a `Found N file(s)` header. `count` adds per-file `file:count` plus totals covering every match |
| `glob` | 200 matches | Newest-first by mtime, recency as relevance proxy |
| `websearch` | default 8, max 20 | Numbered title plus url plus snippet blocks, or `No results.` Query capped at 500 chars |
| `bash` timeout | default 60000ms, uncapped (AI decides; 0 = no timeout) | `timedOut` flag in the JSON result |
| `bash_output` wait | default 5000ms, uncapped (AI decides; 0 returns immediately) | Polls about every 100ms until exit or wait expiry |
| Background tasks | 20 records | Oldest evicted first, temp files pruned best-effort |
| Agentic loop | uncapped by default | optional cap via `ATOM_MAX_TOOL_STEPS`, clamped 5-100 |
| Parallel writes | per-file keys (symlink-aware) | disjoint files batch, same file strictly ordered |

Count-cap notes (`grep`/`glob` over-cap) and prompt-assembly caps (skills, compact, AGENTS.md, history) do not spill: re-query to narrow.

## Path handling

No path sandbox. Relative paths resolve against cwd. Absolute paths and `..` escapes are allowed anywhere on the machine, including sensitive locations like `~/.ssh/`. Treat those contents as untrusted. Never exfiltrate or commit secrets. The permission mode is the control plane. See [Permissions](permissions.md).

## Image input (vision)

`read` on a PNG, JPEG, GIF, or WebP file (detected by magic bytes, up to 8 MiB) attaches it as vision input: the result reads `Image read successfully: <path> (<mime>, <bytes> bytes, attached as vision input)` plus a `[media:<id> ...]` token. History, transcript, and `session.json` carry only that short token (images live under `~/.atom/media/`, pruned after 7 days); at POST time the token expands to provider-native image blocks (OpenAI `image_url`, Anthropic base64 `image` blocks, Gemini `inline_data`). Context accounting charges the deterministic base64 wire cost per token, so the load stays honest. Compaction summaries and the goal judge always strip images to `[image omitted: ...]` markers (text-only, cheap). A model that rejects image input (400 naming images) retries once automatically with images stripped. Anything else binary — PDF, AVIF, BMP, audio, video — is refused with convert-first guidance (e.g. `pdftoppm`/`pdftotext`); oversize images are refused with downscale guidance. Covered by `tests/media.test.ts`.

## Network policy (`webfetch` SSRF gate)

Every URL — the initial one and every redirect hop — classifies into a zone (`public`, `localhost`, `private` RFC1918/CGNAT/TEST-NET, `link-local` incl. cloud metadata `169.254.169.254`, `blocked` for unparseable/unresolvable) and is checked against the `network` policy from `atom.json` (defaults: public + localhost allowed). Redirects are followed manually (cap 5, loop-detected, credentialed/scheme-changing targets refused) so a public URL can never bounce to metadata or the LAN unseen; each hop re-resolves DNS and the worst zone wins for multi-address hosts. IP-literal tricks (octal/hex forms, IPv4-mapped IPv6) classify by their real address. Known limitation: DNS rebind between check and fetch (TOCTOU) would need connection-level IP pinning, which global fetch does not offer. See [Configuration](configuration.md). Covered by `tests/policy.test.ts`.

Only empty/non-string paths and null bytes are rejected.

## Safety guards

- Read-tracking: `read` records a sha1 per resolved file. `edit` refuses with a stale-read error when the file changed since the last read. `write`/`edit` refresh the record. Files never read this session have no record.
- Pre-mutation snapshots: `write`/`edit` capture prior bytes for `/rewind`. See [Sessions](sessions.md).
- Validation: malformed args return `Error: invalid call: ... Fix the arguments and retry.` The tool never ran. Runtime failures return plain `Error: ...`.
- Binary skip: `grep` skips unreadable files and files containing null bytes.

## Task checklist invariants (runtime-enforced)

Beyond prompt guidance, the harness refuses impossible states as invalid calls (list untouched):

- At most one `in_progress` item — complete or pause the current one first (both `todowrite` rewrites and `todo_update` patches).
- A `todowrite` rewrite never silently reopens a completed item; reopening is an explicit `todo_update` status patch.
- Completing the last open item clears the list.

## Verification gate (runtime-enforced)

The system prompt forbids unverified finishes, and the loop enforces it: after a successful `write`/`edit` to a **code path** (source extensions — docs, configs, and data never arm the gate), final text does not end the turn until a verification command **passes** (`exitCode: 0`; a failing run keeps the gate armed so the model fixes forward). Instead the turn continues with a verification follow-up, up to 3 nag rounds or the step budget — then it ends labeled: `(blocked: …)` on spent budget, `(unverified: …)` naming the files and the reason otherwise. Cancellation always wins immediately; Ctrl+C/Esc behavior is unchanged.

## Background shell

`bash` with `runInBackground: true` returns immediately with `{backgroundTaskId, status: "running", hint}`. Poll with `bash_output` (`taskId`, optional `timeoutMs`). Result JSON carries `taskId`, `running`, `exitCode` (null while running), `stdout`, `stderr`, `timedOut`.

## Scheduling (effect-aware parallelism)

One assistant message's `tool_calls` run under a conservative scheduler (`src/scheduler.ts`, planned by `planToolBatches` in `src/zen.ts` — a thin wrapper over `planBatches` — executed by the shared loop core in `src/agent/loop.ts`):

- Each tool declares effects — `filesystem: none | read | write`, `network: none | read | write`, `process: none | spawn`, plus `interactive`, `exclusive` (shared ambient state), and `deterministic`. Missing metadata fails safe to serial.
- Batchable reads (`read`/`grep`/`glob` over files, `webfetch`/`websearch` over network, `bash_output` per task) always run concurrently — parallel by default, same target included, since pure reads can never race each other.
- Writes batch on disjoint canonical files and run concurrently; same-file mutations, read/write pairs on the same file, process spawns, interactive prompts, and todo-state tools are always serial singletons so program order holds. Target-scoped write batching across *related* paths (e.g. a directory scan racing a write inside it) is a deliberate non-goal.
- Results commit in original call order (one transcript entry per call); cancel stops between batches and a mid-batch throw aborts with no partial commits; approval still happens per call. Covered by `tests/scheduler.test.ts` (planning) and `tests/parallel-calls.test.ts` (ordering, timing, serial pins).

Windows note: background spawns attached (detached children drop output on Windows). POSIX uses detached process groups. Observable contract is the same: immediate return, independent run, output to temp files under the OS temp dir.
