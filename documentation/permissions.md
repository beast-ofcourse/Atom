# Permissions and Modes

Three modes plus scoped session rules. No path sandbox: the permission system is the control plane.

## Modes

Default is `normal`:

- Read-only tools auto-run in every mode
- Approval tools (`write`, `edit`, `bash`) pause for approval in normal mode: `y` once, `a` always this session, `t` trust all write/edit/bash, `n` deny
- Every auto-approved call still renders its audit line
- `Tab` is the only mode switcher (cycles normal → yolo → plan → normal). `/yolo` and `/plan` are retired as typed commands — typing them explains this instead of switching. `/mode` prints the current mode
- Yolo mode never asks; plan mode is read-only (write/edit/bash blocked pre-execution with a replan note)

`/trust` is a session trust tier between normal and yolo:

- First `/trust` auto-approves all three approval tools at once without global yolo
- Status shows `+trust`
- Second `/trust` revokes
- In-memory only, never saved

## Scoped rules

Finer than all-or-nothing trust. Session-only, in-memory, never saved.

```text
/allow <tool[:glob]>
/deny <tool[:glob]>
/rules
/rules clear
```

Examples:

```text
/allow bash:npm test*
/allow write:src/**
/deny bash:rm *
```

- Bare `/allow bash` matches any bash args. Bare tool name matches any call to that tool
- The glob matches the tool primary string, the same primary shown in the audit line: path for `read`/`write`/`edit`, pattern for `glob`/`grep`, command for `bash`, url/query for `webfetch`/`websearch`, taskId for `bash_output`, question for `ask_question`. Other tools have no primary, so only tool-only rules match them
- Glob dialect: `*` matches any sequence (including `/` and spaces), `?` matches exactly one char, everything else literal. Case-sensitive
- Tool names are single lowercase tokens. Anything else is rejected loudly rather than stored as a never-matching rule

## Precedence

One ordered rule lives in `src/policy.ts` (`decidePolicy` — tool request → policy → approval if needed → execution): deny wins over everything (including plan mode); plan mode passes approval-gated calls through to the execute gate, which refuses mutations with a replan note; then allow rules, yolo, session trust, always-allowed, and skill grants; otherwise the normal prompt flow applies. Covered by `tests/policy.test.ts`.

Skill-grant trust: only global (user-controlled `~/.claude|~/.agents`) skills arm turn-scoped grants. Project-local skill content is untrusted — it never silently escalates to `write`/`edit`/`bash` (sensitive names are reported, reads still auto-run). See [Skills](skills.md).

Rules only take effect on approval-gated calls (`write`/`edit`/`bash`) because read-only tools never consult approval. A rule naming another tool is accepted but inert.

Implementation is the pure module `src/permissions.ts`. Matching and parsing there have unit coverage in `tests/permissions.test.ts`.

## Denials

A denial returns the standard denial result and the model replans. Do not retry the denied call. Explain briefly and offer an alternative path.

## Security notes

- File tools reach anywhere on the machine. Treat sensitive locations as untrusted input
- Absolute symlinked paths show `link → target` in the activity line, so redirected reads/writes are visible
- Shell output passes through secret scrubbing: live provider-key env values are replaced with `[redacted]` before the model (or spill files) ever see them. Stored `auth.json` keys are not covered — never print session/auth files
- Never print full keys, never log them, never commit them. Masked display is last4 only
- Session files under `~/.atom/` can contain pasted secrets if typed as chat. Never print their contents, never commit them
