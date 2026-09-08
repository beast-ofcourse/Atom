# Permissions and Modes

Two modes plus scoped session rules. No path sandbox: the permission system is the control plane.

## Modes

Default is `normal`:

- Read-only tools auto-run in every mode
- Approval tools (`write`, `edit`, `bash`) pause for approval in normal mode: `y` once, `a` always this session, `t` trust all write/edit/bash, `n` deny
- Every auto-approved call still renders its audit line
- `Tab` toggles normal/yolo. `/yolo` toggles too. `/mode` prints the current mode
- Yolo mode never asks

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

Deny is checked first and wins over everything: yolo, session trust, always, and skill grants. Then the first allow match auto-approves. Otherwise the normal prompt flow applies.

Rules only take effect on approval-gated calls (`write`/`edit`/`bash`) because read-only tools never consult approval. A rule naming another tool is accepted but inert.

Implementation is the pure module `src/permissions.ts`. Matching and parsing there have unit coverage in `tests/permissions.test.ts`.

## Denials

A denial returns the standard denial result and the model replans. Do not retry the denied call. Explain briefly and offer an alternative path.

## Security notes

- File tools reach anywhere on the machine. Treat sensitive locations as untrusted input
- Never print full keys, never log them, never commit them. Masked display is last4 only
- Session files under `~/.atom/` can contain pasted secrets if typed as chat. Never print their contents, never commit them
