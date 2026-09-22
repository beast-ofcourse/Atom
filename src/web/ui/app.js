/* ATOM WebUI workspace client — vanilla JS, no dependencies.
 *
 * Server contract (see src/web/server.ts + src/web/events.ts):
 * - REST: /api/providers, /api/sessions(+/:id), /:id/messages, /cancel,
 *   /approve, /answer. Sessions carry cwd/provider/model/effort/mode.
 * - SSE: /:id/events. Every agent fact renders from these events — the
 *   client fabricates nothing (no fake thinking, tool, or status rows).
 * Correlation note: tool_call (approve args) / tool_started / tool_result
 * share no single id, so the timeline pairs them FIFO by tool name — the
 * same order the loop commits them in (see runLoopWithChat commit funnel).
 */

const $ = (id) => document.getElementById(id);
const els = {
  sessions: $("session-list"),
  workspace: $("workspace"),
  providers: $("provider"),
  models: $("model"),
  effort: $("effort"),
  mode: $("mode"),
  conn: $("conn"),
  status: $("status"),
  error: $("error"),
  sr: $("sr-status"),
  empty: $("empty-state"),
  transcript: $("transcript"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  attach: $("attach"),
  fileInput: $("file-input"),
  modal: $("modal"),
  modalTitle: $("modal-title"),
  modalBody: $("modal-body"),
  modalActions: $("modal-actions"),
  newSession: $("new-session"),
  sidebar: $("sidebar"),
  right: $("right"),
  scrim: $("scrim"),
  opNow: $("op-now"),
  counts: $("tool-counts"),
  timeline: $("timeline"),
  files: $("files"),
  commands: $("commands"),
  errors: $("errors"),
  viewer: $("viewer"),
  viewerPath: $("viewer-path"),
  viewerMeta: $("viewer-meta"),
  viewerBody: $("viewer-body"),
  tabUnified: $("tab-unified"),
  tabSide: $("tab-side"),
};

const state = {
  sessionId: null,
  providers: [],
  busy: false,
  es: null,
  draftEl: null,
  thinkingEl: null,
  thinkingSummary: null,
  reasoningLabel: "",
  // Right-panel model, rebuilt per session (all entries derive from events).
  entries: [],
  pendingMeta: [],
  // Execution timeline: one turn group per user message. Nodes derive only
  // from streamed events — the client invents no steps.
  turnGroups: [],
  currentTurn: null,
  // File diffs by path (latest per path, capped) + error list (capped).
  diffs: new Map(),
  errors: [],
  viewerPath: null,
  viewerTab: "unified",
  // Unsent composer text per session id — switching sessions preserves
  // drafts instead of wiping them. Cleared on send.
  drafts: {},
};

/* ---- paint scheduler: high-frequency token/thinking/timeline events
 * coalesce to one render per animation frame, so long-running turns stay
 * smooth. The FINAL text always renders exactly (finalizeDraft bypasses the
 * queue), so throttling can never lose content. ---- */
const paint = { queued: false, draft: null, thinking: null, timeline: false };

function requestPaint() {
  if (paint.queued) return;
  paint.queued = true;
  const flush = () => {
    paint.queued = false;
    if (paint.draft !== null) {
      const t = paint.draft;
      paint.draft = null;
      renderDraft(t);
    }
    if (paint.thinking !== null) {
      const t = paint.thinking;
      paint.thinking = null;
      renderThinking(t);
    }
    if (paint.timeline) {
      paint.timeline = false;
      renderAgent();
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 64);
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/* ---------------- empty-session onboarding ----------------
 * Static guidance only (never agent facts): shown when the selected session
 * has no turns yet, dismissed by the first rendered row. Starter buttons
 * fill the composer — sending still goes through the normal submit path. */

function hideEmpty() {
  if (els.empty && !els.empty.hidden) els.empty.hidden = true;
}

function showEmpty() {
  if (els.empty) els.empty.hidden = false;
}

if (els.empty) {
  els.empty.addEventListener("click", (e) => {
    const btn =
      e.target && e.target.closest ? e.target.closest("[data-prompt]") : null;
    if (!btn) return;
    els.input.value = btn.dataset.prompt;
    els.input.style.height = "";
    els.input.style.height = Math.min(220, els.input.scrollHeight) + "px";
    els.input.focus();
  });
}

/* ---------------- markdown (presentation only; input is server text) ---------------- */

const CODE_FENCE = /```(\w*)\n([\s\S]*?)(?:```|$)/g;

function highlight(code, lang) {
  const text = String(code);
  const l = (lang || "").toLowerCase();
  const cLike = new Set([
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "mts",
    "cts",
    "go",
    "rs",
    "java",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "swift",
    "kt",
    "kts",
    "php",
  ]);
  const pyLike = new Set(["py", "pyi", "rb"]);
  const shLike = new Set(["sh", "bash", "zsh", "console", "shell"]);
  const dataLike = new Set(["json", "jsonc", "yaml", "yml", "toml"]);
  // Family ids from the server (previewLangFromPath) select directly.
  const isC = l === "c" || cLike.has(l);
  const isPy = l === "py" || pyLike.has(l);
  const isSh = l === "sh" || shLike.has(l);
  const isData = l === "data" || dataLike.has(l);
  let keywords = [];
  let commentRe = null;
  let allowBacktick = false;
  if (isC) {
    keywords = [
      "const",
      "let",
      "var",
      "function",
      "return",
      "if",
      "else",
      "for",
      "while",
      "do",
      "switch",
      "case",
      "break",
      "continue",
      "new",
      "class",
      "extends",
      "import",
      "export",
      "from",
      "default",
      "try",
      "catch",
      "finally",
      "throw",
      "typeof",
      "instanceof",
      "async",
      "await",
      "this",
      "null",
      "undefined",
      "true",
      "false",
      "void",
      "delete",
      "in",
      "of",
      "yield",
      "static",
      "struct",
      "enum",
      "impl",
      "fn",
      "mut",
      "pub",
      "match",
      "use",
      "trait",
      "interface",
      "public",
      "private",
      "protected",
      "namespace",
      "using",
      "virtual",
      "override",
      "template",
      "func",
      "chan",
      "select",
      "defer",
      "range",
      "package",
      "self",
      "Self",
    ];
    commentRe = "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)";
    allowBacktick = true;
  } else if (isPy) {
    keywords = [
      "def",
      "return",
      "if",
      "elif",
      "else",
      "for",
      "while",
      "in",
      "not",
      "and",
      "or",
      "is",
      "None",
      "True",
      "False",
      "import",
      "from",
      "as",
      "class",
      "with",
      "lambda",
      "pass",
      "raise",
      "try",
      "except",
      "finally",
      "self",
      "async",
      "await",
      "yield",
      "assert",
      "print",
    ];
    commentRe = "(#[^\\n]*)";
  } else if (isSh) {
    keywords = [
      "if",
      "then",
      "else",
      "elif",
      "fi",
      "for",
      "while",
      "do",
      "done",
      "case",
      "esac",
      "function",
      "return",
      "exit",
      "export",
      "local",
      "echo",
      "cd",
      "set",
      "source",
      "in",
    ];
    commentRe = "(#[^\\n]*)";
  } else if (isData) {
    keywords = ["true", "false", "null"];
    commentRe = null;
  } else {
    return esc(text);
  }
  const strRe = allowBacktick
    ? "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)"
    : "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')";
  const parts = [];
  if (commentRe) parts.push(commentRe);
  parts.push(strRe);
  parts.push("(\\b\\d+(?:\\.\\d+)?\\b)");
  if (keywords.length) parts.push("\\b(" + keywords.join("|") + ")\\b");
  const re = new RegExp(parts.join("|"), "g");
  let out = "";
  let last = 0;
  let m;
  const groupClass = (g) => {
    if (commentRe && g[1] !== undefined) return "tok-c";
    const si = commentRe ? 2 : 1;
    if (g[si] !== undefined) return "tok-s";
    if (g[si + 1] !== undefined) return "tok-n";
    return "tok-k";
  };
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    out += '<span class="' + groupClass(m) + '">' + esc(m[0]) + "</span>";
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function renderInline(text) {
  // Inline code spans first (placeholder-shielded from further formatting).
  const codes = [];
  let out = String(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return "\x01" + (codes.length - 1) + "\x01";
  });
  out = esc(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  out = out.replace(
    /\x01(\d+)\x01/g,
    (_, i) => '<code class="inline">' + esc(codes[Number(i)]) + "</code>",
  );
  return out;
}

function renderMarkdown(text) {
  const blocks = [];
  const fenced = String(text).replace(CODE_FENCE, (_, lang, code) => {
    blocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
    return "\x00" + (blocks.length - 1) + "\x00";
  });
  const lines = fenced.split("\n");
  let html = "";
  let i = 0;
  const flushList = (items, ordered) => {
    html += ordered ? "<ol>" : "<ul>";
    for (const it of items) html += "<li>" + renderInline(it) + "</li>";
    html += ordered ? "</ol>" : "</ul>";
  };
  let para = [];
  const flushPara = () => {
    if (para.length) {
      const joined = para.join("\n");
      if (/^\x00\d+\x00$/.test(joined.trim())) {
        html += joined + "\n";
      } else {
        html += "<p>" + para.map(renderInline).join("<br>") + "</p>";
      }
      para = [];
    }
  };
  const isTableRow = (ln) => /^\|.*\|\s*$/.test(ln);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\x00\d+\x00$/.test(line.trim())) {
      flushPara();
      html += line + "\n";
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      html +=
        "<h" +
        h[1].length +
        ">" +
        renderInline(h[2]) +
        "</h" +
        h[1].length +
        ">";
      i += 1;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flushPara();
      html += "<hr>";
      i += 1;
      continue;
    }
    if (/^&gt;|^>/.test(line)) {
      flushPara();
      const quotes = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quotes.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      html +=
        "<blockquote>" +
        quotes.map(renderInline).join("<br>") +
        "</blockquote>";
      continue;
    }
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      flushPara();
      const cells = (r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => renderInline(c.trim()));
      html +=
        "<table><thead><tr>" +
        cells(line)
          .map((c) => "<th>" + c + "</th>")
          .join("") +
        "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        html +=
          "<tr>" +
          cells(lines[i])
            .map((c) => "<td>" + c + "</td>")
            .join("") +
          "</tr>";
        i += 1;
      }
      html += "</tbody></table>";
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const items = [];
      while (i < lines.length) {
        const m2 = ordered
          ? lines[i].match(/^\d+[.)]\s+(.*)$/)
          : lines[i].match(/^[-*]\s+(.*)$/);
        if (!m2) break;
        items.push(m2[1]);
        i += 1;
      }
      flushList(items, ordered);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  html = html.replace(/^\x00(\d+)\x00$/gm, (_, n) => {
    const b = blocks[Number(n)];
    const label = b.lang ? esc(b.lang) : "code";
    return (
      '<div class="codeblock"><div class="code-head"><span>' +
      label +
      '</span><button class="copy" type="button">copy</button></div><pre><code>' +
      highlight(b.code, b.lang) +
      "</code></pre></div>"
    );
  });
  return html;
}

/* ---------------- transcript ---------------- */

/* ---------------- transcript ----------------
 * Long conversations cap the rendered rows (oldest dropped first) so the
 * DOM stays bounded; the full record stays on the server (GET session).
 * Live draft/thinking lanes cap their rendered text for the same reason —
 * finals always render in full. */

// Max committed rows kept in the DOM; max chars rendered per live frame.
const TRANSCRIPT_ROW_CAP = 400;
const LIVE_RENDER_CAP = 20000;
let prunedRows = 0;

function pruneTranscript() {
  const kids = els.transcript.children;
  while (kids.length > TRANSCRIPT_ROW_CAP) {
    els.transcript.removeChild(kids[0]);
    prunedRows += 1;
  }
  let note = document.getElementById("prune-note");
  if (prunedRows > 0) {
    if (!note) {
      note = document.createElement("div");
      note.id = "prune-note";
      note.className = "list-empty";
      els.transcript.prepend(note);
    }
    note.textContent =
      prunedRows + " earlier row(s) not rendered (full history on the server)";
  } else if (note) {
    note.remove();
  }
}

function capLive(text) {
  if (text.length <= LIVE_RENDER_CAP) return { text, capped: false };
  return {
    text: text.slice(-LIVE_RENDER_CAP),
    capped: true,
  };
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function addUserRow(content, echo) {
  hideEmpty();
  const div = document.createElement("div");
  div.className = "msg user";
  if (echo) div.dataset.echo = "1";
  div.innerHTML = '<div class="role">You</div><div class="body"></div>';
  div.querySelector(".body").innerHTML = renderMarkdown(content);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  pruneTranscript();
  return div;
}

function addAssistantRow(content) {
  hideEmpty();
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML =
    '<div class="role">ATOM</div><div class="body">' +
    renderMarkdown(content) +
    "</div>";
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  pruneTranscript();
  return div;
}

function addToolRow(label, isError, args, result) {
  hideEmpty();
  const div = document.createElement("div");
  div.className = "msg tool-row" + (isError ? " err" : "");
  const dot = isError ? "fail" : "ok";
  div.innerHTML =
    '<div class="body"><details class="tool"><summary><span class="dot ' +
    dot +
    '"></span>' +
    esc(label) +
    "</summary>" +
    '<div class="tool-detail"></div></details></div>';
  const detail = div.querySelector(".tool-detail");
  if (args) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(args, null, 2);
    detail.appendChild(pre);
  }
  if (typeof result === "string" && result.length) {
    const cap = 2000;
    const pre = document.createElement("pre");
    pre.textContent =
      result.length > cap
        ? result.slice(0, cap) +
          "\n… (showing first " +
          cap +
          " of " +
          result.length +
          " chars)"
        : result;
    detail.appendChild(pre);
  }
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  pruneTranscript();
  return div;
}

function setDraft(text) {
  // Hot path (per token chunk): store + schedule, never render synchronously.
  paint.draft = text;
  requestPaint();
}

function renderDraft(text) {
  if (!state.draftEl) {
    state.draftEl = document.createElement("div");
    state.draftEl.className = "msg assistant";
    state.draftEl.innerHTML =
      '<div class="role">ATOM · streaming</div><div class="body"></div>';
    els.transcript.appendChild(state.draftEl);
  }
  state.draftEl.querySelector(".body").innerHTML = renderMarkdown(
    liveSlice(text),
  );
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// Live lanes render a bounded tail (per-frame markdown cost stays flat no
// matter how long the stream runs). Fences are rebalanced so a cut can never
// swallow the tail into an unclosed code block; the final message below
// always renders complete.
function liveSlice(text) {
  const c = capLive(text);
  if (!c.capped) return c.text;
  let body =
    "… (live view capped — the completed message renders in full)\n" + c.text;
  if ((body.match(/```/g) || []).length % 2 === 1) body += "\n```";
  return body;
}

function finalizeDraft(content) {
  // A queued paint must never resurrect the draft after the final lands.
  paint.draft = null;
  paint.thinking = null;
  if (state.draftEl) {
    state.draftEl.remove();
    state.draftEl = null;
  }
  collapseThinking();
  addAssistantRow(content);
}

function setThinking(text) {
  // Hot path (per reasoning delta): store + schedule, like the draft.
  paint.thinking = text;
  const turn = ensureTurn();
  const node = ensureThinkingNode(turn);
  node.preview = text.slice(0, 160);
  paint.timeline = true;
  requestPaint();
}

function renderThinking(text) {
  if (!state.thinkingEl) {
    state.thinkingEl = document.createElement("div");
    state.thinkingEl.className = "msg";
    state.thinkingEl.innerHTML =
      '<details class="thinking" open><summary>thinking</summary><div class="body"></div></details>';
    els.transcript.appendChild(state.thinkingEl);
    state.thinkingSummary = state.thinkingEl.querySelector("summary");
  }
  state.thinkingEl.querySelector(".body").innerHTML = renderMarkdown(
    liveSlice(text),
  );
  if (state.reasoningLabel)
    state.thinkingSummary.textContent = "thinking · " + state.reasoningLabel;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function collapseThinking() {
  if (state.thinkingEl) {
    const d = state.thinkingEl.querySelector("details");
    if (d) d.removeAttribute("open");
    state.thinkingEl = null;
    state.thinkingSummary = null;
  }
}

function clearLive() {
  paint.draft = null;
  paint.thinking = null;
  if (state.draftEl) {
    state.draftEl.remove();
    state.draftEl = null;
  }
  if (state.thinkingEl) {
    const d = state.thinkingEl.querySelector("details");
    if (d) d.removeAttribute("open");
    state.thinkingEl = null;
    state.thinkingSummary = null;
  }
  state.reasoningLabel = "";
}

function setStatus(text, busy) {
  els.status.textContent = text;
  els.status.classList.toggle("busy", !!busy);
}

function showError(message) {
  els.error.hidden = !message;
  els.error.textContent = message || "";
  if (message) announce("Error: " + message);
}

function setConn(live) {
  els.conn.textContent = live ? "● connected" : "○ disconnected — retrying…";
  els.conn.classList.toggle("live", live);
  els.conn.classList.toggle("down", !live);
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.stop.disabled = !busy;
  if (busy) {
    showError("");
    setStatus("thinking", true);
  }
}

/* ---------------- right panel: agent model from real events ---------------- */

function toolDetail(name, args) {
  const a = args || {};
  const s = (v) => (typeof v === "string" ? v : "");
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return s(a.path);
    case "bash":
      return s(a.command).slice(0, 160);
    case "bash_output":
      return s(a.taskId);
    case "grep":
      return (s(a.pattern) + (a.include ? " " + a.include : "")).slice(0, 160);
    case "glob":
      return s(a.pattern).slice(0, 160);
    case "webfetch":
      return s(a.url).slice(0, 160);
    case "websearch":
      return s(a.query).slice(0, 160);
    // Todo labels mirror todo-shared.describeTodoCall (static browser bundle
    // has no access to that module — keep these two arms in sync with it).
    case "todowrite":
      return (Array.isArray(a.todos) ? a.todos.length : 0) + " task(s)";
    case "todo_update":
      return (
        "#" +
        String(a.index === undefined ? "?" : a.index) +
        (a.status ? " → " + a.status : "")
      );
    case "ask_question":
      return s(a.question).slice(0, 160);
    case "update_goal":
      return String(a.status === undefined ? "" : a.status);
    default:
      return "";
  }
}

function lastOpen(name) {
  for (let idx = state.entries.length - 1; idx >= 0; idx--) {
    const e = state.entries[idx];
    if (e.name === name && e.state === "running") return e;
  }
  return null;
}

function bashExit(result) {
  try {
    const o = JSON.parse(String(result));
    if (o && typeof o.exitCode === "number") return o.exitCode;
  } catch {
    /* not a JSON envelope — unknown */
  }
  return null;
}

// One shared cap-note builder for committed result text (center rows and
// timeline nodes must agree instead of each inventing a truncation line).
function capNote(result, resultChars, truncated) {
  return truncated
    ? result + "\n… (truncated: " + resultChars + " chars total)"
    : result;
}

function renderAgent() {
  // Now: latest phase/operation or idle.
  // Counts.
  let running = 0,
    ok = 0,
    fail = 0,
    denied = 0;
  for (const e of state.entries) {
    if (e.state === "running") running += 1;
    else if (e.state === "ok") ok += 1;
    else if (e.state === "fail") fail += 1;
    else if (e.state === "denied") denied += 1;
  }
  els.counts.textContent =
    state.entries.length === 0 && !state.busy
      ? "no tool calls yet"
      : running +
        " running · " +
        ok +
        " ok · " +
        fail +
        " failed" +
        (denied ? " · " + denied + " denied" : "");
  // Execution timeline (turn groups with live nodes; string-built in one
  // pass so high-frequency streams never thrash the DOM node by node).
  els.timeline.innerHTML = renderTimeline();
  // Files. Reads come from tool_result entries; creates/modifies come from
  // file_diff events (op + pre-computed hunks). Rows with a diff open the
  // diff viewer on click. ATOM has no delete tool and bash side effects are
  // opaque by design — deletions never appear here (see file_diff docs).
  const seenPaths = new Set();
  const fileRows = [];
  for (
    let idx = state.entries.length - 1;
    idx >= 0 && fileRows.length < 50;
    idx--
  ) {
    const e = state.entries[idx];
    if (
      (e.name !== "read" && e.name !== "write" && e.name !== "edit") ||
      !e.detail
    )
      continue;
    if (seenPaths.has(e.detail)) continue;
    seenPaths.add(e.detail);
    const diff = state.diffs.get(e.detail);
    fileRows.push({
      op: diff ? diff.op : "read",
      path: e.detail,
      state: e.state,
      hasDiff: !!diff,
    });
  }
  fileRows.reverse();
  els.files.innerHTML =
    fileRows.length === 0
      ? '<div class="list-empty">no file access yet</div>'
      : "";
  for (const r of fileRows) {
    const div = document.createElement("div");
    div.className = "file-row" + (r.hasDiff ? " clickable" : "");
    const dot = r.state === "running" ? "run" : r.state;
    const badge =
      r.op === "created"
        ? "created"
        : r.op === "modified"
          ? "modified"
          : "read";
    div.innerHTML =
      '<span class="dot ' +
      dot +
      '"></span><span class="badge ' +
      badge +
      '">' +
      badge +
      "</span> " +
      esc(r.path);
    if (r.hasDiff) {
      div.dataset.diffpath = r.path;
      div.title = "Show diff";
      // Keyboard path to diff review (the row is a div, so expose the
      // button contract explicitly — same openViewer as the mouse path).
      div.tabIndex = 0;
      div.setAttribute("role", "button");
      div.setAttribute("aria-label", "Show diff for " + r.path);
      div.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openViewer(r.path, div);
        }
      });
    }
    els.files.appendChild(div);
  }
  // Commands: COMMAND / OUTPUT / STATUS, output line-capped + scrollable.
  const cmds = state.entries.filter((e) => e.name === "bash" && e.detail);
  els.commands.innerHTML =
    cmds.length === 0 ? '<div class="list-empty">no commands yet</div>' : "";
  for (const e of cmds.slice(-20)) {
    const div = document.createElement("div");
    div.className = "cmd-row";
    const dot = e.state === "running" ? "run" : e.state;
    const status =
      e.state === "running"
        ? '<div class="cmd-status">STATUS · running…</div>'
        : e.exitCode === null || e.exitCode === undefined
          ? '<div class="cmd-status">STATUS ' +
            (e.state === "fail" ? "✕ failed" : "· done") +
            "</div>"
          : e.exitCode === 0
            ? '<div class="cmd-status ok">STATUS ✓ completed (exit 0)</div>'
            : '<div class="cmd-status bad">STATUS ✕ failed (exit ' +
              e.exitCode +
              ")</div>";
    div.innerHTML =
      '<div class="cmd-line"><span class="dot ' +
      dot +
      '"></span><span>$ ' +
      esc(e.detail) +
      "</span></div>" +
      status;
    if (e.result) {
      // Long output renders capped (first lines) inside a scrollable,
      // collapsed block — never the full dump in the DOM.
      const outLines = String(e.result).split("\n");
      const lineCap = 300;
      const shown = outLines.slice(0, lineCap).join("\n");
      const rest = outLines.length - Math.min(outLines.length, lineCap);
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent =
        "OUTPUT (" +
        outLines.length +
        " lines" +
        (e.resultChars ? ", " + e.resultChars + " chars total" : "") +
        ")";
      const pre = document.createElement("pre");
      pre.textContent =
        shown + (rest > 0 ? "\n… (" + rest + " more lines not rendered)" : "");
      det.appendChild(sum);
      det.appendChild(pre);
      div.appendChild(det);
    }
    els.commands.appendChild(div);
  }
  // Errors: failed tool results + turn errors, newest last, capped.
  els.errors.innerHTML =
    state.errors.length === 0 ? '<div class="list-empty">no errors</div>' : "";
  for (const er of state.errors.slice(-20)) {
    const div = document.createElement("div");
    div.className = "err-row";
    div.innerHTML =
      '<span class="dot fail"></span><span>' +
      esc(er.title) +
      (er.detail ? '<div class="tl-detail">' + esc(er.detail) + "</div>" : "") +
      "</span>";
    els.errors.appendChild(div);
  }
}

function setOp(text) {
  els.opNow.textContent = text;
}

function trackToolCall(d) {
  state.entries.push({
    name: d.name,
    detail: toolDetail(d.name, d.args),
    args: d.args,
    state: d.decision === "no" ? "denied" : "running",
    via: d.via || "",
    result: null,
    resultChars: 0,
    exitCode: null,
  });
  if (state.entries.length > 1000)
    state.entries.splice(0, state.entries.length - 1000);
  state.pendingMeta.push({ name: d.name, args: d.args });
  if (state.pendingMeta.length > 200)
    state.pendingMeta.splice(0, state.pendingMeta.length - 200);
  // Timeline node (pre-execution args — the only place they exist early).
  // Structure only (see trackToolResult) — no result bodies.
  const turn = ensureTurn();
  turn.nodes.push({
    type: "tool",
    name: d.name,
    label: d.description || d.name,
    detail: toolDetail(d.name, d.args),
    state: d.decision === "no" ? "denied" : "running",
  });
  paint.timeline = true;
  requestPaint();
}

function trackToolResult(d) {
  const e = lastOpen(d.name);
  const capped = capNote(d.result, d.resultChars, d.truncated);
  if (e) {
    e.state = d.isError ? "fail" : "ok";
    e.detail = e.detail || toolDetail(d.name, d.args);
    e.args = e.args || d.args;
    e.result = capped;
    e.resultChars = d.resultChars || 0;
    if (d.name === "bash") e.exitCode = bashExit(d.result);
  } else {
    state.entries.push({
      name: d.name,
      detail: toolDetail(d.name, d.args),
      args: d.args,
      state: d.isError ? "fail" : "ok",
      via: "",
      result: capped,
      resultChars: d.resultChars || 0,
      exitCode: d.name === "bash" ? bashExit(d.result) : null,
    });
    if (state.entries.length > 1000)
      state.entries.splice(0, state.entries.length - 1000);
  }
  state.pendingMeta.push({ name: d.name, args: d.args });
  if (state.pendingMeta.length > 200)
    state.pendingMeta.splice(0, state.pendingMeta.length - 200);
  // Errors panel: failed commits, newest last (capped at render).
  if (d.isError) {
    state.errors.push({
      title: d.name + " failed",
      detail: String(d.result || "").slice(0, 300),
    });
    if (state.errors.length > 50)
      state.errors.splice(0, state.errors.length - 50);
  }
  // Timeline node update (commit-order result). Nodes carry structure only
  // (name/detail/status) — result bodies live in the center rows and the
  // files/commands panels, so thousand-call turns don't bloat the timeline.
  const turn = ensureTurn();
  const node = lastOpenToolNode(turn, d.name);
  if (node) {
    node.state = d.isError ? "fail" : "ok";
    node.detail = node.detail || toolDetail(d.name, d.args);
  } else {
    turn.nodes.push({
      type: "tool",
      name: d.name,
      label: d.name,
      detail: toolDetail(d.name, d.args),
      state: d.isError ? "fail" : "ok",
    });
  }
  paint.timeline = true;
  requestPaint();
}

function takeMeta(name) {
  for (let idx = 0; idx < state.pendingMeta.length; idx++) {
    if (state.pendingMeta[idx].name === name) {
      return state.pendingMeta.splice(idx, 1)[0].args;
    }
  }
  return null;
}

/* ---- execution timeline: turn groups with live nodes ----
 * One group opens per user message and closes on done/error/cancelled.
 * Every node derives from a streamed event: thinking nodes from thinking
 * TEXT (phase "thinking" alone never creates one — a POST without exposed
 * reasoning shows no thinking row), tool nodes from tool_call/started/
 * result, retry nodes from phase "retry", round markers from subsequent
 * model rounds. Nothing here is synthesized. */

function openTurn(userText) {
  const turn = {
    user: userText || "",
    state: "working",
    nodes: [],
    startedAt: Date.now(),
    endedAt: null,
    open: true,
  };
  state.turnGroups.push(turn);
  if (state.turnGroups.length > 50)
    state.turnGroups.splice(0, state.turnGroups.length - 50);
  state.currentTurn = turn;
  paint.timeline = true;
  requestPaint();
  return turn;
}

function ensureTurn() {
  const cur = state.currentTurn;
  if (cur && cur.state === "working") return cur;
  return openTurn("");
}

/* ---------------- screen-reader announcer ----------------
 * The transcript streams tokens per-frame, so it stays off the live region
 * (a polite region over the whole transcript would re-announce on every
 * chunk). Discrete turn facts — completions, failures, approvals, questions,
 * errors — announce here instead. Visual rendering is untouched. */

function announce(text) {
  if (!els.sr) return;
  els.sr.textContent = "";
  els.sr.textContent = text;
}

function closeTurn(finalState, note) {
  const turn = state.currentTurn;
  if (turn && turn.state === "working") {
    turn.state = finalState;
    turn.endedAt = Date.now();
    if (note) turn.nodes.push({ type: "final", text: note });
    if (note) announce("Turn " + note.toLowerCase() + ".");
    // Density: finished turns collapse so a long session stays scannable —
    // the running turn keeps streaming open, failures stay open for
    // attention, and every head remains one click/keypress from expanding.
    if (finalState === "done" || finalState === "cancelled") {
      turn.open = false;
    }
  }
  state.currentTurn = null;
  paint.timeline = true;
  requestPaint();
}

function ensureThinkingNode(turn) {
  for (let idx = turn.nodes.length - 1; idx >= 0; idx--) {
    if (turn.nodes[idx].type === "thinking") return turn.nodes[idx];
  }
  const node = { type: "thinking", preview: "" };
  turn.nodes.push(node);
  return node;
}

function lastOpenToolNode(turn, name) {
  for (let idx = turn.nodes.length - 1; idx >= 0; idx--) {
    const n = turn.nodes[idx];
    if (n.type === "tool" && n.name === name && n.state === "running") return n;
  }
  return null;
}

function turnElapsed(turn) {
  const end = turn.endedAt || Date.now();
  return Math.max(0, Math.round((end - turn.startedAt) / 1000));
}

// Live elapsed ticker: updates only the open turn's head, once a second.
setInterval(() => {
  const turn = state.currentTurn;
  if (!turn || turn.state !== "working") return;
  const el = document.querySelector(
    '[data-turn-elapsed="' + turn.startedAt + '"]',
  );
  if (el) el.textContent = turnElapsed(turn) + "s";
}, 1000);

function renderTimeline() {
  if (state.turnGroups.length === 0) {
    return '<div class="tl-empty">timeline fills as ATOM works</div>';
  }
  let html = "";
  for (const turn of state.turnGroups) {
    const head = turn.user ? esc(turn.user.slice(0, 80)) : "Working";
    const stateLabel =
      turn.state === "working"
        ? "Working"
        : turn.state === "done"
          ? "Completed"
          : turn.state;
    const dot =
      turn.state === "working"
        ? "run"
        : turn.state === "done"
          ? "ok"
          : turn.state === "cancelled"
            ? "denied"
            : "fail";
    html +=
      '<div class="turn"><button type="button" class="turn-head" data-turn="' +
      turn.startedAt +
      '" aria-expanded="' +
      (turn.open === false ? "false" : "true") +
      '">' +
      '<span class="dot ' +
      dot +
      '"></span><span class="turn-title">' +
      esc(stateLabel) +
      (turn.user ? ": " + head : "") +
      '</span><span class="turn-time" data-turn-elapsed="' +
      turn.startedAt +
      '">' +
      turnElapsed(turn) +
      "s</span>" +
      '<span class="turn-caret">' +
      (turn.open === false ? "▸" : "▾") +
      "</span></button>";
    if (turn.open !== false) {
      html += '<div class="turn-body">';
      for (const n of turn.nodes) html += renderNode(n);
      html += "</div>";
    }
    html += "</div>";
  }
  return html;
}

function renderNode(n) {
  if (n.type === "thinking") {
    return (
      '<div class="tl-row run"><span class="dot run"></span><span><div>Thinking…</div>' +
      (n.preview
        ? '<div class="tl-detail">' +
          esc(n.preview) +
          (n.preview.length >= 160 ? "…" : "") +
          "</div>"
        : "") +
      "</span></div>"
    );
  }
  if (n.type === "retry") {
    return (
      '<div class="tl-row run"><span class="dot run"></span><span><div>↻ retrying…</div>' +
      (n.detail ? '<div class="tl-detail">' + esc(n.detail) + "</div>" : "") +
      "</span></div>"
    );
  }
  if (n.type === "round") {
    return '<div class="tl-round">── next step ──</div>';
  }
  if (n.type === "final") {
    return (
      '<div class="tl-row ' +
      (n.ok === false ? "fail" : "ok") +
      '"><span class="dot ' +
      (n.ok === false ? "fail" : "ok") +
      '"></span><span>' +
      esc(n.text) +
      "</span></div>"
    );
  }
  if (n.type === "tool") {
    const dot = n.state === "running" ? "run" : n.state;
    let inner = '<div class="tl-detail">' + esc(n.name) + "</div>";
    if (n.detail) inner += '<div class="tl-detail">' + esc(n.detail) + "</div>";
    return (
      '<details class="tl-tool ' +
      dot +
      '"' +
      (n.state === "running" ? " open" : "") +
      "><summary><span" +
      ' class="dot ' +
      dot +
      '"></span>' +
      esc(n.label || n.name) +
      "</summary><div>" +
      inner +
      "</div></details>"
    );
  }
  return "";
}

/* ---------------- file diffs + viewer ----------------
 * file_diff events carry server-computed hunks/rows (src/ui/diff.ts engine)
 * over capped texts — the browser only renders. Diffs never trigger tool
 * execution; opening a diff is a pure render of streamed evidence. */

function onFileDiff(d) {
  if (!d.path) return;
  state.diffs.set(d.path, d);
  if (state.diffs.size > 20) {
    const oldest = state.diffs.keys().next().value;
    state.diffs.delete(oldest);
  }
  paint.timeline = true;
  requestPaint();
}

let viewerReturnFocus = null;

function openViewer(filePath, invoker) {
  const d = state.diffs.get(filePath);
  if (!d) return;
  state.viewerPath = filePath;
  els.viewerPath.textContent = filePath;
  const bits = [];
  bits.push(
    d.op === "created"
      ? "created"
      : d.op === "modified"
        ? "modified"
        : String(d.op || ""),
  );
  bits.push("+" + (d.adds || 0) + " −" + (d.dels || 0));
  if (d.isNewFile) bits.push("new file");
  if (d.truncated) bits.push("texts truncated for transfer");
  if (d.rowsTruncated) bits.push("rows truncated for display");
  els.viewerMeta.textContent = bits.join(" · ");
  els.tabUnified.classList.toggle("active", state.viewerTab !== "side");
  els.tabSide.classList.toggle("active", state.viewerTab === "side");
  renderViewer();
  els.viewer.hidden = false;
  viewerReturnFocus =
    invoker && document.contains(invoker) ? invoker : null;
  document.getElementById("viewer-close").focus();
}

function closeViewer() {
  const hadFocus = els.viewer.contains(document.activeElement);
  els.viewer.hidden = true;
  state.viewerPath = null;
  if (hadFocus && viewerReturnFocus && document.contains(viewerReturnFocus)) {
    viewerReturnFocus.focus();
  }
  viewerReturnFocus = null;
}

function renderViewer() {
  const d = state.diffs.get(state.viewerPath);
  if (!d) {
    els.viewerBody.innerHTML = '<div class="list-empty">diff unavailable</div>';
    return;
  }
  els.viewerBody.innerHTML =
    state.viewerTab === "side" ? renderSideBySide(d) : renderUnified(d);
}

// Unified view from server hunks: @@ headers, per-side line numbers,
// changed-line backgrounds, syntax-highlighted line text.
function renderUnified(d) {
  const lang = d.lang || "";
  const hunks = (d.hunks || []).slice(0, 60);
  let html = "";
  for (const h of hunks) {
    html +=
      '<div class="hunk-head">@@ -' +
      h.oldStart +
      "," +
      h.oldLines +
      " +" +
      h.newStart +
      "," +
      h.newLines +
      " @@</div>";
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const ln of h.lines || []) {
      if (ln.kind === "context") {
        html += diffLine("ctx", oldNo, newNo, ln.text, lang);
        oldNo += 1;
        newNo += 1;
      } else if (ln.kind === "del") {
        html += diffLine("del", oldNo, null, ln.text, lang);
        oldNo += 1;
      } else {
        html += diffLine("add", null, newNo, ln.text, lang);
        newNo += 1;
      }
    }
  }
  if ((d.hunks || []).length > hunks.length) {
    html +=
      '<div class="list-empty">… ' +
      ((d.hunks || []).length - hunks.length) +
      " more hunks not rendered</div>";
  }
  return html || '<div class="list-empty">no changes</div>';
}

function diffLine(cls, oldNo, newNo, text, lang) {
  return (
    '<div class="dline ' +
    cls +
    '"><span class="dno">' +
    (oldNo === null ? "" : oldNo) +
    '</span><span class="dno">' +
    (newNo === null ? "" : newNo) +
    "</span>" +
    '<span class="dcode">' +
    highlight(text, lang) +
    "</span></div>"
  );
}

// Before/after view from server rows: paired lines share a row, unpaired
// lines take a row with an empty opposite cell (same contract as the TUI).
function renderSideBySide(d) {
  const lang = d.lang || "";
  const rows = d.rows || [];
  let html =
    '<div class="sbs"><div class="sbs-head"><span>before</span><span>after</span></div>';
  for (const r of rows) {
    if (r.kind === "context") {
      html +=
        '<div class="sbs-row"><div class="sbs-cell"><span class="dno">' +
        r.oldNo +
        '</span><span class="dcode">' +
        highlight(r.text, lang) +
        "</span></div>" +
        '<div class="sbs-cell"><span class="dno">' +
        r.newNo +
        '</span><span class="dcode">' +
        highlight(r.text, lang) +
        "</span></div></div>";
    } else {
      const left =
        r.oldText === null || r.oldText === undefined
          ? '<div class="sbs-cell empty"></div>'
          : '<div class="sbs-cell del"><span class="dno">' +
            r.oldNo +
            '</span><span class="dcode">' +
            highlight(r.oldText, lang) +
            "</span></div>";
      const right =
        r.newText === null || r.newText === undefined
          ? '<div class="sbs-cell empty"></div>'
          : '<div class="sbs-cell add"><span class="dno">' +
            r.newNo +
            '</span><span class="dcode">' +
            highlight(r.newText, lang) +
            "</span></div>";
      html += '<div class="sbs-row">' + left + right + "</div>";
    }
  }
  return html + "</div>";
}

/* ---------------- modals / requests ----------------
 * Approval + question dialogs demand a decision, so they never dismiss on
 * Esc — but keyboard users must land in them: showModal focuses the first
 * action, Tab cycles inside the dialog, and hideModal returns focus to the
 * element that opened it. Visuals and decision flow are untouched. */

let modalReturnFocus = null;

function showModal(title, body, actions) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = body;
  els.modalActions.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.onclick = () => {
      hideModal();
      a.onClick();
    };
    els.modalActions.appendChild(b);
  }
  els.modal.hidden = false;
  const active = document.activeElement;
  if (active && active !== document.body && document.contains(active)) {
    modalReturnFocus = active;
  }
  const first = els.modalActions.querySelector("button");
  if (first) first.focus();
}

function hideModal() {
  const hadFocus = els.modal.contains(document.activeElement);
  els.modal.hidden = true;
  els.modalActions.innerHTML = "";
  if (hadFocus && modalReturnFocus && document.contains(modalReturnFocus)) {
    modalReturnFocus.focus();
  }
  modalReturnFocus = null;
}

els.modal.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || els.modal.hidden) return;
  const btns = els.modalActions.querySelectorAll("button");
  if (btns.length === 0) return;
  const first = btns[0];
  const last = btns[btns.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON: keep {} */
  }
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function onApprovalRequest(d) {
  const diff = d.diff && typeof d.diff === "object" ? d.diff : null;
  const hasHunks = !!(diff && Array.isArray(diff.hunks) && diff.hunks.length > 0);
  showModal("Approval: " + d.name, d.description || "", [
    { label: "Allow once", onClick: () => approve(d.id, "once") },
    { label: "Always allow " + d.name, onClick: () => approve(d.id, "always") },
    { label: "Deny", onClick: () => approve(d.id, "no") },
  ]);
  // Structured review body: description + args stay plain text, the staged
  // change renders through the shared unified-diff renderer (same classes as
  // the diff viewer). A legacy raw-text diff falls back to JSON, never blank.
  els.modalBody.innerHTML = "";
  if (d.description) {
    const desc = document.createElement("div");
    desc.className = "modal-desc";
    desc.textContent = d.description;
    els.modalBody.appendChild(desc);
  }
  if (d.args) {
    const pre = document.createElement("pre");
    pre.className = "modal-args";
    pre.textContent = JSON.stringify(d.args, null, 2).slice(0, 2000);
    els.modalBody.appendChild(pre);
  }
  if (hasHunks) {
    const meta = document.createElement("div");
    meta.className = "modal-diff-meta";
    const bits = [];
    if (diff.path) bits.push(diff.path);
    bits.push("+" + (diff.adds || 0) + " −" + (diff.dels || 0));
    if (diff.isNewFile) bits.push("new file");
    if (diff.truncated) bits.push("texts truncated for transfer");
    meta.textContent = bits.join(" · ");
    els.modalBody.appendChild(meta);
    const body = document.createElement("div");
    body.className = "modal-diff";
    body.innerHTML = renderUnified(diff);
    els.modalBody.appendChild(body);
  } else if (diff) {
    const pre = document.createElement("pre");
    pre.className = "modal-args";
    pre.textContent = JSON.stringify(diff, null, 2).slice(0, 4000);
    els.modalBody.appendChild(pre);
  }
  announce("Approval requested: " + d.name + ".");
}

async function approve(approvalId, decision) {
  try {
    await postJSON("/api/sessions/" + state.sessionId + "/approve", {
      id: approvalId,
      decision,
    });
  } catch (e) {
    showError("approve failed: " + e.message);
  }
}

function onQuestionRequest(d) {
  const actions = (d.options || []).map((opt) => ({
    label: opt,
    onClick: () => answer(d.id, opt),
  }));
  if (d.allowCustom) {
    actions.push({
      label: "Custom…",
      onClick: () => {
        const v = window.prompt(d.question || "Answer");
        if (v) answer(d.id, v);
      },
    });
  }
  const title = d.total > 1 ? "ATOM asks (Q " + d.index + "/" + d.total + ")" : "ATOM asks";
  showModal(title, d.question || "", actions);
  announce("ATOM asks: " + (d.question || "").slice(0, 200));
}

async function answer(questionId, answerText) {
  try {
    await postJSON("/api/sessions/" + state.sessionId + "/answer", {
      id: questionId,
      answer: answerText,
    });
  } catch (e) {
    showError("answer failed: " + e.message);
  }
}

/* ---------------- SSE dispatch ---------------- */

function onEvent(evt) {
  let msg;
  try {
    msg = JSON.parse(evt.data);
  } catch {
    return;
  }
  const d = msg.data || {};
  switch (msg.kind) {
    case "token":
      setDraft(d.text || "");
      setOp("writing response");
      break;
    case "thinking":
      setThinking(d.text || "");
      setOp("thinking");
      break;
    case "reasoning":
      state.reasoningLabel = d.reasoning || "";
      break;
    case "phase":
      setStatus(d.detail ? d.phase + " · " + d.detail : d.phase, true);
      if (d.phase === "tool" && d.detail) setOp("tool · " + d.detail);
      else if (d.phase === "retry") {
        setOp("retrying · " + (d.detail || ""));
        // Retry rows are real transport events (see MAX_RETRIES in zen.ts).
        ensureTurn().nodes.push({ type: "retry", detail: d.detail || "" });
        paint.timeline = true;
        requestPaint();
      } else if (d.phase === "thinking") {
        setOp("thinking");
        // A new model round after tool work has already streamed: the
        // "Running next step..." marker. Non-creating on purpose: the first
        // POST's thinking phase must never open a group by itself (the user
        // message event owns that), and a marker without a group is dropped.
        const t = state.currentTurn;
        if (
          t &&
          t.state === "working" &&
          t.nodes.length > 0 &&
          t.nodes[t.nodes.length - 1].type !== "round"
        ) {
          t.nodes.push({ type: "round" });
          paint.timeline = true;
          requestPaint();
        }
      } else if (d.phase === "streaming") setOp("writing response");
      break;
    case "tool_delta":
      setOp("tool · " + d.name);
      break;
    case "tool_started": {
      setOp("tool · " + d.name);
      const e = lastOpen(d.name);
      if (!e) {
        state.entries.push({
          name: d.name,
          detail: "",
          args: null,
          state: "running",
          via: "",
          result: null,
          resultChars: 0,
          exitCode: null,
        });
        paint.timeline = true;
        requestPaint();
      }
      // Timeline: a started call with no approve-time node (read-only tools
      // never consult approve) opens its node here; name-only until the
      // result event fills in args. Structure only (no result bodies).
      const turn = ensureTurn();
      if (!lastOpenToolNode(turn, d.name)) {
        turn.nodes.push({
          type: "tool",
          name: d.name,
          label: d.name,
          detail: "",
          state: "running",
        });
        paint.timeline = true;
        requestPaint();
      }
      break;
    }
    case "tool_finished": {
      const e = lastOpen(d.name);
      if (e && !e.result) {
        // Finalizer for calls whose result event never arrives (e.g. the
        // stream ends between commit and result); the result path above wins
        // whenever both arrive.
        e.state = d.isError ? "fail" : e.state;
        paint.timeline = true;
        requestPaint();
      }
      break;
    }
    case "tool_call":
      trackToolCall(d);
      setOp(
        d.decision === "no" ? "tool denied · " + d.name : "tool · " + d.name,
      );
      break;
    case "tool_result":
      trackToolResult(d);
      break;
    case "file_diff":
      onFileDiff(d);
      break;
    case "tool_activity":
      addToolRow(
        d.label || "",
        !!d.isError,
        takeMeta(extractName(d.label)),
        d.result,
      );
      break;
    case "usage":
      break;
    case "warning":
      addToolRow("⚠ " + (d.message || ""), false, null, null);
      break;
    case "approval_request":
      onApprovalRequest(d);
      break;
    case "approval_resolved":
      hideModal();
      break;
    case "question_request":
      onQuestionRequest(d);
      break;
    case "question_resolved":
      hideModal();
      break;
    case "message":
      // Live user echoes and tool rows already rendered (composer echo /
      // tool_activity); assistant finals render here and close the turn.
      // Every user message opens a timeline group.
      if (d.role === "assistant") {
        finalizeDraft(d.content || "");
        // Failed turns commit their streamed text as a marked partial row
        // before the error event — close those as failed, not completed.
        if (
          (d.content || "").indexOf("request failed before completing") === -1
        ) {
          closeTurn("done", "Completed");
        } else {
          closeTurn("fail", "Failed — partial output preserved");
        }
      } else if (d.role === "user") {
        adoptEcho(d.content || "");
        openTurn(d.content || "");
      }
      break;
    case "error":
      clearLive();
      hideModal();
      closeTurn(
        "fail",
        "Failed: " + (d.message || "turn failed").slice(0, 160),
      );
      state.errors.push({
        title: "turn failed",
        detail: String(d.message || "").slice(0, 300),
      });
      if (state.errors.length > 50)
        state.errors.splice(0, state.errors.length - 50);
      showError(d.message || "turn failed");
      setBusy(false);
      setOp("error");
      paint.timeline = true;
      requestPaint();
      break;
    case "done":
      clearLive();
      hideModal();
      // The assistant final already closed the turn via message; this is the
      // backstop for turns that end without one.
      closeTurn("done", "Completed");
      setBusy(false);
      setStatus("idle", false);
      setOp("idle");
      paint.timeline = true;
      requestPaint();
      refreshSessions();
      break;
    case "cancelled":
      clearLive();
      hideModal();
      closeTurn("cancelled", "Cancelled");
      addToolRow(d.notice || "(cancelled)", false, null, null);
      setBusy(false);
      setStatus("idle", false);
      setOp("idle");
      paint.timeline = true;
      requestPaint();
      break;
    default:
      break;
  }
}

// Adopt the optimistic composer echo when the server echoes the same user
// text (avoids a duplicate row); render a stored row otherwise (reconnect
// replay, where no echo exists).
function adoptEcho(content) {
  const last = els.transcript.lastChild;
  if (last && last.dataset && last.dataset.echo === "1") {
    const body = last.querySelector(".body");
    if (body && body.textContent === content) {
      delete last.dataset.echo;
      return;
    }
  }
  addUserRow(content, false);
}

// The center tool row shows the committed label; the tool name rides the
// label prefix ("⚙ <name> ..."). The meta queue (real args) is matched by
// that name — never parsed for values, only routed.
function extractName(label) {
  const m = /^⚙\s+([a-z0-9_-]+)/.exec(String(label || ""));
  return m ? m[1] : "";
}

function connectEvents() {
  if (state.es) {
    try {
      state.es.close();
    } catch {
      /* ignore */
    }
  }
  if (!state.sessionId) return;
  const es = new EventSource("/api/sessions/" + state.sessionId + "/events");
  state.es = es;
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  const kinds = [
    "token",
    "thinking",
    "phase",
    "tool_delta",
    "tool_started",
    "tool_finished",
    "tool_call",
    "tool_activity",
    "tool_result",
    "file_diff",
    "usage",
    "reasoning",
    "warning",
    "approval_request",
    "approval_resolved",
    "question_request",
    "question_resolved",
    "message",
    "error",
    "done",
    "cancelled",
  ];
  for (const k of kinds) es.addEventListener(k, onEvent);
}

/* ---------------- slash commands ----------------
 * TUI parity for the commands that map to real WebUI capabilities (the
 * registry, matcher, and exact-wins semantics mirror src/App.tsx
 * SLASH_COMMANDS/filterSlashCommands/fuzzyScore — ported, not imported:
 * the browser cannot import the TUI module, and the server must not pull
 * React/Ink. Commands without a WebUI backend (/goal, /compact, /allow,
 * …) are omitted rather than faked; /help states the list. */

const WEB_COMMANDS = [
  {
    name: "/model",
    description: "List models, or switch (/model <name>).",
    takesArg: true,
  },
  {
    name: "/provider",
    description: "Switch provider (/provider <id>).",
    takesArg: true,
  },
  {
    name: "/effort",
    description: "Set reasoning effort (/effort auto|low|medium|high|max).",
    takesArg: true,
  },
  {
    name: "/mode",
    description: "Set permission mode (/mode normal|yolo|plan).",
    takesArg: true,
  },
  {
    name: "/tools",
    description: "List the tools with one-line descriptions.",
    takesArg: false,
  },
  {
    name: "/skill",
    description: "List skills in a picker, or invoke (/skill:name, /skill <name>).",
    takesArg: true,
  },
  {
    name: "/mcp",
    description: "Manage MCP servers (Space toggles enable/disable, Esc closes).",
    takesArg: false,
  },
  {
    name: "/thinking",
    description: "Show or hide model thinking in this view.",
    takesArg: false,
  },
  {
    name: "/rename",
    description: "Rename the current session (/rename <name>).",
    takesArg: true,
  },
  { name: "/new", description: "Start a brand-new session.", takesArg: false },
  { name: "/help", description: "List WebUI commands.", takesArg: false },
];

// Ported from src/App.tsx fuzzyScore: subsequence match with
// gap/start/word-boundary scoring (lower is better; null = no match).
function fuzzyScore(query, target) {
  const q = String(query).toLowerCase();
  const t = String(target).toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    score += last === -1 ? found : found - last - 1;
    if (found === 0 || /[-_/:]/.test(t[found - 1])) score -= 2;
    if (found === last + 1) score -= 1;
    last = found;
    ti = found + 1;
  }
  return score;
}

// Ported from src/App.tsx filterSlashCommands: exact match wins outright,
// then prefix tier (registry order), then fuzzy by score.
function filterSlashCommands(prefix) {
  const q = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  const full = "/" + q;
  const exact = WEB_COMMANDS.find((c) => c.name === full);
  if (exact) return [exact];
  const pre = [];
  const fuzzy = [];
  for (const c of WEB_COMMANDS) {
    const name = c.name.slice(1);
    if (name.startsWith(q)) {
      pre.push(c);
      continue;
    }
    const s = fuzzyScore(q, name);
    if (s !== null) fuzzy.push({ c, s });
  }
  fuzzy.sort((a, b) => a.s - b.s || (a.c.name < b.c.name ? -1 : 1));
  return [...pre, ...fuzzy.map((f) => f.c)];
}

const slash = { open: false, items: [], index: 0 };

function slashMenuEl() {
  let el = document.getElementById("slash-menu");
  if (!el) {
    el = document.createElement("div");
    el.id = "slash-menu";
    el.setAttribute("role", "listbox");
    document.querySelector(".composer-box").prepend(el);
  }
  return el;
}

function closeSlash() {
  slash.open = false;
  slash.items = [];
  slash.index = 0;
  const el = document.getElementById("slash-menu");
  if (el) el.remove();
}

function renderSlash() {
  const el = slashMenuEl();
  el.innerHTML = "";
  slash.items.slice(0, 8).forEach((c, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "slash-row" + (i === slash.index ? " active" : "");
    row.setAttribute("role", "option");
    row.innerHTML =
      "<span class='slash-name'>" +
      esc(c.name) +
      "</span><span class='slash-desc'>" +
      esc(c.description) +
      "</span>";
    row.onmousedown = (e) => {
      // mousedown (not click): the textarea blur would close the menu first.
      e.preventDefault();
      acceptSlash(i);
    };
    el.appendChild(row);
  });
}

function updateSlashMenu() {
  const v = els.input.value;
  if (!v.startsWith("/") || state.busy) {
    if (slash.open) closeSlash();
    return;
  }
  const first = v.split(/\s/)[0];
  slash.items = filterSlashCommands(first);
  if (slash.items.length === 0) {
    if (slash.open) closeSlash();
    return;
  }
  slash.open = true;
  slash.index = Math.min(slash.index, slash.items.length - 1);
  renderSlash();
}

function acceptSlash(i) {
  const c = slash.items[i === undefined ? slash.index : i];
  if (!c) return;
  if (c.takesArg) {
    els.input.value = c.name + " ";
    closeSlash();
    els.input.focus();
  } else {
    els.input.value = "";
    closeSlash();
    runSlashCommand(c.name, "");
  }
}

function addInfoRow(text) {
  hideEmpty();
  const div = document.createElement("div");
  div.className = "msg tool-row";
  div.innerHTML = '<div class="body"></div>';
  div.querySelector(".body").textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  pruneTranscript();
}

async function runSlashCommand(name, arg) {
  if (!state.sessionId) return;
  switch (name) {
    case "/help": {
      addInfoRow(
        "WebUI commands:\n" +
          WEB_COMMANDS.map((c) => c.name + " — " + c.description).join("\n") +
          "\n(TUI-only commands like /goal, /compact, /allow are not available in the WebUI.)",
      );
      break;
    }
    case "/tools": {
      try {
        const tools = await getJSON("/api/tools");
        addInfoRow(
          "Tools (" +
            tools.length +
            "):\n" +
            tools.map((t) => t.name + " — " + t.description).join("\n"),
        );
      } catch (e) {
        showError("tools failed: " + e.message);
      }
      break;
    }
    case "/thinking": {
      els.transcript.classList.toggle("hide-thinking");
      addInfoRow(
        "thinking is now " +
          (els.transcript.classList.contains("hide-thinking")
            ? "hidden"
            : "shown") +
          " (view only — turns are untouched).",
      );
      break;
    }
    case "/new": {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: els.providers.value,
            model: els.models.value,
            effort: els.effort.value,
            mode: els.mode.value,
          }),
        });
        const rec = await res.json();
        await refreshSessions();
        await selectSession(rec.id);
      } catch (e) {
        showError("new session failed: " + e.message);
      }
      break;
    }
    case "/rename": {
      if (!arg) {
        addInfoRow("usage: /rename <name>");
        break;
      }
      try {
        const res = await fetch("/api/sessions/" + state.sessionId, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: arg }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        addInfoRow("renamed to “" + arg + "”.");
        refreshSessions();
      } catch (e) {
        showError("rename failed: " + e.message);
      }
      break;
    }
    case "/model": {
      if (!arg) {
        const p = state.providers.find((x) => x.id === els.providers.value);
        const models = p ? [p.defaultModel].concat(p.fallbackModels || []) : [];
        addInfoRow(
          "Models for " +
            els.providers.value +
            ":\n" +
            [...new Set(models.filter(Boolean))].join("\n") +
            "\n(use /model <name>)",
        );
        break;
      }
      await applySlashSetting({ model: arg }, "model");
      break;
    }
    case "/provider": {
      if (!arg) {
        addInfoRow(
          "Providers:\n" +
            state.providers
              .map((p) => p.id + (p.needsKey && !p.hasKey ? " (no key)" : ""))
              .join("\n") +
            "\n(use /provider <id>)",
        );
        break;
      }
      const hit =
        state.providers.find((p) => p.id === arg) ||
        state.providers.find((p) => p.id.indexOf(arg) === 0);
      if (!hit) {
        addInfoRow("unknown provider “" + arg + "”. Use /provider to list.");
        break;
      }
      els.providers.value = hit.id;
      refreshModels();
      await applySlashSetting(
        { provider: hit.id, model: hit.defaultModel || els.models.value },
        "provider",
      );
      break;
    }
    case "/effort": {
      const levels = ["auto", "low", "medium", "high", "max"];
      if (levels.indexOf(arg) === -1) {
        addInfoRow("usage: /effort " + levels.join("|"));
        break;
      }
      els.effort.value = arg;
      await applySlashSetting({ effort: arg }, "effort");
      break;
    }
    case "/mode": {
      const modes = ["normal", "yolo", "plan"];
      if (modes.indexOf(arg) === -1) {
        addInfoRow("usage: /mode " + modes.join("|"));
        break;
      }
      els.mode.value = arg;
      await applySlashSetting({ mode: arg }, "mode");
      break;
    }
    case "/skill": {
      // Bare opens the picker (what /skills did); with a name it invokes
      // directly — same contract as the TUI unified /skill command.
      if (!arg) {
        openSkillPicker();
        break;
      }
      await invokeSkill(arg.replace(/^:/, ""));
      break;
    }
    case "/mcp": {
      openMcpPicker();
      break;
    }
    default:
      break;
  }
}

async function applySlashSetting(patch, label) {
  try {
    const res = await fetch("/api/sessions/" + state.sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "HTTP " + res.status);
    }
    const rec = await res.json();
    if (patch.provider) {
      els.providers.value = rec.provider;
      refreshModels();
    }
    if (patch.model) els.models.value = rec.model;
    if (patch.effort) els.effort.value = rec.effort;
    if (patch.mode) els.mode.value = rec.mode;
    addInfoRow(
      label +
        " → " +
        (patch.provider || patch.model || patch.effort || patch.mode),
    );
    refreshSessions();
  } catch (e) {
    showError(label + " failed: " + e.message);
  }
}

// Route a submitted line: exact slash command → local execution, unknown
// slash → inline error (mirrors the TUI: unknown commands never reach the
// model), anything else → normal turn.
function trySlashSubmit(text) {
  if (!text.startsWith("/")) return false;
  const space = text.indexOf(" ");
  const cmd = space === -1 ? text : text.slice(0, space);
  const arg = space === -1 ? "" : text.slice(space + 1).trim();
  // Retired alias (TUI parity): /skills merged into /skill's picker.
  if (cmd === "/skills") {
    runSlashCommand("/skill", arg);
    return true;
  }
  // Namespaced form: /skill:name invokes directly (TUI parity).
  if (cmd.startsWith("/skill:")) {
    const name = cmd.slice("/skill:".length) + (arg ? " " + arg : "");
    runSlashCommand("/skill", name.split(/\s+/)[0]);
    return true;
  }
  const hit = WEB_COMMANDS.find((c) => c.name === cmd);
  if (!hit) {
    const sug = filterSlashCommands(cmd)
      .slice(0, 3)
      .map((c) => c.name)
      .join(", ");
    addInfoRow(
      "unknown command “" +
        cmd +
        "”." +
        (sug ? " Did you mean: " + sug + "?" : "") +
        " Use /help.",
    );
    return true;
  }
  if (hit.takesArg && !arg) {
    runSlashCommand(hit.name, "");
  } else {
    runSlashCommand(hit.name, arg);
  }
  return true;
}

/* ---------------- sessions / settings / composer ---------------- */

async function refreshProviders() {
  state.providers = await getJSON("/api/providers");
  els.providers.innerHTML = "";
  for (const p of state.providers) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + (p.needsKey && !p.hasKey ? " (no key)" : "");
    els.providers.appendChild(o);
  }
}

function refreshModels() {
  const p = state.providers.find((x) => x.id === els.providers.value);
  const models = p ? [p.defaultModel].concat(p.fallbackModels || []) : [];
  const seen = [...new Set(models.filter(Boolean))];
  els.models.innerHTML = "";
  for (const m of seen) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    els.models.appendChild(o);
  }
}

async function refreshSessions() {
  const list = await getJSON("/api/sessions");
  els.sessions.innerHTML = "";
  for (const s of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "session" + (s.id === state.sessionId ? " active" : "");
    b.innerHTML =
      "<div>" +
      esc(s.title || s.id) +
      "</div>" +
      '<div class="sub">' +
      esc(
        s.provider +
          " · " +
          (s.model || "no model") +
          " · " +
          relTime(s.updatedAt),
      ) +
      "</div>";
    b.onclick = () => selectSession(s.id);
    els.sessions.appendChild(b);
  }
}

function resetAgent() {
  state.entries = [];
  state.pendingMeta = [];
  state.turnGroups = [];
  state.currentTurn = null;
  state.diffs = new Map();
  state.errors = [];
  state.viewerPath = null;
  els.viewer.hidden = true;
  setOp("idle");
  paint.timeline = true;
  requestPaint();
}

async function selectSession(id) {
  // Preserve the outgoing composer draft — switching sessions must never
  // eat typed text. Drafts live in memory (per session id), restored below.
  if (state.sessionId && els.input.value) {
    state.drafts[state.sessionId] = els.input.value;
  }
  state.sessionId = id;
  clearLive();
  hideModal();
  showError("");
  els.transcript.innerHTML = "";
  hideEmpty();
  prunedRows = 0;
  resetAgent();
  const rec = await getJSON("/api/sessions/" + id);
  els.workspace.textContent = rec.cwd || "—";
  els.workspace.title = rec.cwd || "";
  els.providers.value = rec.provider;
  refreshModels();
  if (rec.model) els.models.value = rec.model;
  els.effort.value = rec.effort || "auto";
  els.mode.value = rec.mode || "normal";
  for (const t of rec.turns || []) {
    if (t.role === "user") {
      addUserRow(t.content, false);
      openTurn(t.content);
    } else if (t.role === "assistant") {
      addAssistantRow(t.content);
      closeTurn(
        t.content.indexOf("request failed before completing") === -1
          ? "done"
          : "fail",
        t.content.indexOf("request failed before completing") === -1
          ? "Completed"
          : "Failed — partial output preserved",
      );
    } else {
      // Stored tool rows carry only the committed label (args live in the
      // event stream, not the store) — the label renders verbatim, and a
      // cancelled-turn line closes the group it belongs to.
      addToolRow(t.content, !!t.error, null, null);
      if (t.content.indexOf("(cancelled)") !== -1) {
        closeTurn("cancelled", "Cancelled");
      } else if (state.currentTurn && state.currentTurn.state === "working") {
        state.currentTurn.nodes.push({
          type: "tool",
          name: extractName(t.content),
          label: t.content,
          detail: "",
          state: t.error ? "fail" : "ok",
        });
      }
    }
  }
  paint.timeline = true;
  requestPaint();
  if ((rec.turns || []).length === 0) showEmpty();
  // Restore this session's draft, if the user left one behind.
  const draft = state.drafts[id] || "";
  els.input.value = draft;
  els.input.style.height = "";
  if (draft) {
    els.input.style.height = Math.min(220, els.input.scrollHeight) + "px";
  }
  if (rec.pendingApproval) onApprovalRequest(rec.pendingApproval);
  else if (rec.pendingQuestion) onQuestionRequest(rec.pendingQuestion);
  setBusy(!!rec.busy);
  if (rec.busy) setOp("working…");
  else setStatus("idle", false);
  connectEvents();
  refreshSessions();
  closeOverlays();
}

async function applySettings() {
  if (!state.sessionId || state.busy) return;
  try {
    await fetch("/api/sessions/" + state.sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: els.providers.value,
        model: els.models.value,
        effort: els.effort.value,
        mode: els.mode.value,
      }),
    });
  } catch (e) {
    showError("settings failed: " + e.message);
  }
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || !state.sessionId || state.busy) return;
  els.input.value = "";
  delete state.drafts[state.sessionId];
  els.input.style.height = "";
  closeSlash();
  // Slash commands execute locally (settings, lists, view toggles) and
  // never start a model turn; unknown slash input is an inline error.
  if (trySlashSubmit(text)) return;
  const echo = addUserRow(text, true);
  setBusy(true);
  try {
    await postJSON("/api/sessions/" + state.sessionId + "/messages", {
      content: text,
    });
  } catch (err) {
    try {
      echo.remove();
    } catch {
      /* already gone */
    }
    showError(err.message);
    setBusy(false);
    setStatus("idle", false);
  }
});

els.input.addEventListener("keydown", (e) => {
  // Slash-menu keyboard flow (mirrors the TUI): arrows move, Tab accepts
  // the highlight into the input, Enter sends, Esc closes.
  if (slash.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slash.index = (slash.index + 1) % slash.items.length;
      renderSlash();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slash.index = (slash.index - 1 + slash.items.length) % slash.items.length;
      renderSlash();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      acceptSlash();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
  if (e.key === "Escape" && !els.viewer.hidden) closeViewer();
});

els.input.addEventListener("input", () => {
  els.input.style.height = "";
  els.input.style.height = Math.min(220, els.input.scrollHeight) + "px";
  if (state.sessionId) {
    if (els.input.value) state.drafts[state.sessionId] = els.input.value;
    else delete state.drafts[state.sessionId];
  }
  updateSlashMenu();
});

els.stop.addEventListener("click", async () => {
  if (!state.sessionId) return;
  try {
    await postJSON("/api/sessions/" + state.sessionId + "/cancel", {});
  } catch (e) {
    showError("cancel failed: " + e.message);
  }
});

// File attachment (frontend-only assistance, like paste): the chosen file's
// text is inserted into the composer as a fenced block. ATOM itself learns
// it through the message — no backend feature is assumed.
els.attach.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const f = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  if (!f) return;
  const cap = 32768;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    if (text.indexOf("\x00") !== -1) {
      insertAtCursor(
        "\n\nAttached " +
          f.name +
          " (" +
          f.size +
          " bytes, binary — describe it or paste relevant text).\n",
      );
      return;
    }
    const ext = (f.name.split(".").pop() || "").toLowerCase().slice(0, 12);
    const body =
      text.length > cap
        ? text.slice(0, cap) +
          "\n… (truncated: " +
          text.length +
          " chars total)"
        : text;
    insertAtCursor(
      "\n\nAttached " + f.name + ":\n```" + ext + "\n" + body + "\n```\n",
    );
  };
  reader.onerror = () => showError("could not read " + f.name);
  reader.readAsText(f);
});

function insertAtCursor(snippet) {
  const start = els.input.selectionStart || els.input.value.length;
  const end = els.input.selectionEnd || start;
  els.input.value =
    els.input.value.slice(0, start) + snippet + els.input.value.slice(end);
  els.input.focus();
}

els.newSession.addEventListener("click", async () => {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: els.providers.value,
      model: els.models.value,
      effort: els.effort.value,
      mode: els.mode.value,
    }),
  });
  const rec = await res.json();
  await refreshSessions();
  await selectSession(rec.id);
});

for (const el of [els.providers, els.models, els.effort, els.mode]) {
  el.addEventListener("change", () => {
    if (el === els.providers) refreshModels();
    applySettings();
  });
}

// Copy buttons inside rendered code blocks (event delegation — rows stream in).
els.transcript.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest(".copy") : null;
  if (!btn) return;
  const code = btn.closest(".codeblock");
  const text = code ? code.querySelector("code").textContent : "";
  const done = () => {
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* clipboard unavailable */
    }
    ta.remove();
    done();
  }
});

// Turn-group expand/collapse in the execution timeline.
els.timeline.addEventListener("click", (e) => {
  const head =
    e.target && e.target.closest ? e.target.closest(".turn-head") : null;
  if (!head) return;
  const key = Number(head.dataset.turn);
  const turn = state.turnGroups.find((t) => t.startedAt === key);
  if (turn) {
    turn.open = turn.open === false ? true : false;
    paint.timeline = true;
    requestPaint();
  }
});

// File rows with diffs open the viewer; viewer tabs + close.
els.files.addEventListener("click", (e) => {
  const row =
    e.target && e.target.closest ? e.target.closest("[data-diffpath]") : null;
  if (!row) return;
  openViewer(row.dataset.diffpath, row);
});
$("viewer-close").addEventListener("click", closeViewer);
els.viewer.addEventListener("click", (e) => {
  if (e.target === els.viewer) closeViewer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.viewer.hidden) closeViewer();
});
els.tabUnified.addEventListener("click", () => {
  state.viewerTab = "unified";
  els.tabUnified.classList.add("active");
  els.tabSide.classList.remove("active");
  renderViewer();
});
els.tabSide.addEventListener("click", () => {
  state.viewerTab = "side";
  els.tabSide.classList.add("active");
  els.tabUnified.classList.remove("active");
  renderViewer();
});

/* ---------------- theme (light / dark, OS-respected, persisted) ---------------- */

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function paintThemeButton() {
  const btn = $("theme-toggle");
  if (btn)
    btn.textContent =
      currentTheme() === "light" ? "Theme: light" : "Theme: dark";
}

function setTheme(next) {
  document.documentElement.dataset.theme = next === "light" ? "light" : "dark";
  try {
    localStorage.setItem("atom-theme", currentTheme());
  } catch {
    /* private mode — session default stands */
  }
  paintThemeButton();
}

$("theme-toggle").addEventListener("click", () => {
  setTheme(currentTheme() === "light" ? "dark" : "light");
});

/* ---------------- responsive overlays ---------------- */
function closeOverlays() {
  if (window.innerWidth <= 820) els.sidebar.classList.add("hidden-narrow");
  if (window.innerWidth <= 1240) els.right.classList.add("hidden-narrow");
  els.scrim.hidden = true;
}

function syncScrim() {
  const sideOpen =
    !els.sidebar.classList.contains("hidden-narrow") &&
    window.innerWidth <= 820;
  const rightOpen =
    !els.right.classList.contains("hidden-narrow") && window.innerWidth <= 1240;
  els.scrim.hidden = !(sideOpen || rightOpen);
}

$("menu-open").addEventListener("click", () => {
  els.sidebar.classList.remove("hidden-narrow");
  syncScrim();
});
$("menu-close").addEventListener("click", closeOverlays);
$("panel-toggle").addEventListener("click", () => {
  els.right.classList.toggle("hidden-narrow");
  syncScrim();
});
$("panel-close").addEventListener("click", closeOverlays);
els.scrim.addEventListener("click", closeOverlays);
window.addEventListener("resize", () => {
  if (window.innerWidth > 820) els.sidebar.classList.remove("hidden-narrow");
  if (window.innerWidth > 1240) els.right.classList.remove("hidden-narrow");
  syncScrim();
});

/* ---------------- skill + MCP pickers (TUI /skill + /mcp parity) ----------------
 * Overlays mirroring the TUI pickers in src/App.tsx:
 * - /skill: snapshot-on-open catalog, type-to-filter, Enter/click loads the
 *   skill into the session (full body to history, one transcript line).
 * - /mcp: snapshot-on-open server list, Space/click toggles enable/disable
 *   (persisted + reconnected, row re-syncs so the paint never lies).
 * Idle-only like the TUI — a mid-turn toggle/load would race the loop. */

const picker = {
  open: null, // "skill" | "mcp" | null
  skills: [],
  filter: "",
  index: 0,
  mcp: [],
  mcpIndex: 0,
};

function pickerRoot() {
  let el = document.getElementById("picker");
  if (!el) {
    el = document.createElement("div");
    el.id = "picker";
    el.hidden = true;
    el.innerHTML =
      '<div id="picker-card" role="dialog" aria-modal="true">' +
      '<div id="picker-title"></div>' +
      '<input id="picker-filter" type="text" autocomplete="off" spellcheck="false">' +
      '<div id="picker-list"></div>' +
      "</div>";
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target === el) closePicker();
    });
    el.addEventListener("keydown", onPickerKey);
  }
  return el;
}

function closePicker() {
  picker.open = null;
  const el = document.getElementById("picker");
  if (el) el.hidden = true;
  if (document.activeElement && document.activeElement.id === "picker-filter") {
    els.input.focus();
  }
}

function filteredSkills() {
  const q = picker.filter.toLowerCase();
  if (!q) return picker.skills;
  return picker.skills.filter(
    (s) =>
      s.name.toLowerCase().indexOf(q) !== -1 ||
      (s.description || "").toLowerCase().indexOf(q) !== -1,
  );
}

function openSkillPicker() {
  if (state.busy) {
    addInfoRow("Skills load when idle — wait for the turn to finish.");
    return;
  }
  picker.open = "skill";
  picker.filter = "";
  picker.index = 0;
  const el = pickerRoot();
  el.hidden = false;
  document.getElementById("picker-title").textContent =
    "Skills — type to filter, Enter loads, Esc closes";
  const filter = document.getElementById("picker-filter");
  filter.style.display = "";
  filter.value = "";
  filter.placeholder = "filter skills…";
  document.getElementById("picker-list").innerHTML =
    '<div class="list-empty">loading skills…</div>';
  filter.focus();
  getJSON("/api/skills").then(
    (skills) => {
      if (picker.open !== "skill") return;
      picker.skills = Array.isArray(skills) ? skills : [];
      picker.index = 0;
      renderSkillPicker();
    },
    (e) => {
      if (picker.open !== "skill") return;
      document.getElementById("picker-list").innerHTML = "";
      addInfoRow("skill discovery failed: " + e.message);
      closePicker();
    },
  );
}

function renderSkillPicker() {
  const entries = filteredSkills();
  if (picker.index >= entries.length) picker.index = Math.max(0, entries.length - 1);
  const list = document.getElementById("picker-list");
  list.innerHTML = "";
  entries.slice(0, 30).forEach((s, k) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-row" + (k === picker.index ? " active" : "");
    const left = document.createElement("span");
    left.className = "picker-name";
    left.textContent = "/skill:" + s.name;
    row.appendChild(left);
    if (!s.userInvocable) {
      const tag = document.createElement("span");
      tag.className = "picker-tag";
      tag.textContent = "auto-only";
      row.appendChild(tag);
    }
    if (s.description) {
      const desc = document.createElement("span");
      desc.className = "picker-desc";
      desc.textContent = s.description;
      row.appendChild(desc);
    }
    row.onmousedown = (e) => {
      e.preventDefault();
      pickSkill(s.name);
    };
    list.appendChild(row);
  });
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent =
      picker.skills.length === 0
        ? "No skills installed — add SKILL.md skills under .claude/skills/, .agents/skills/, or the ~/. counterparts."
        : "No skills match — backspace to widen the filter.";
    list.appendChild(empty);
  }
}

function pickSkill(name) {
  const info = picker.skills.find((s) => s.name === name);
  closePicker();
  if (info && !info.userInvocable) {
    addInfoRow('Skill "' + name + '" is model-invoked only (user-invocable: false).');
    return;
  }
  void invokeSkill(name);
}

async function invokeSkill(name) {
  if (!state.sessionId) return;
  if (state.busy) {
    addInfoRow("Skills load when idle — wait for the turn to finish.");
    return;
  }
  try {
    const res = await fetch("/api/sessions/" + state.sessionId + "/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    // The server persisted the context + transcript line; the SSE message
    // event for the tool row is render-on-reload, so paint it now for this
    // client (same text — no divergence, no double render).
    addInfoRow(data.note || name + " loaded");
  } catch (e) {
    showError("skill failed: " + e.message);
  }
}

function openMcpPicker() {
  if (state.busy) {
    addInfoRow("MCP servers load when idle — wait for the turn to finish.");
    return;
  }
  picker.open = "mcp";
  picker.mcpIndex = 0;
  const el = pickerRoot();
  el.hidden = false;
  document.getElementById("picker-title").textContent =
    "MCP servers — Space toggles, Esc closes";
  const filter = document.getElementById("picker-filter");
  filter.style.display = "none";
  document.getElementById("picker-list").innerHTML =
    '<div class="list-empty">loading servers…</div>';
  getJSON("/api/mcp").then(
    (servers) => {
      if (picker.open !== "mcp") return;
      picker.mcp = Array.isArray(servers) ? servers : [];
      picker.mcpIndex = 0;
      renderMcpPicker();
    },
    (e) => {
      if (picker.open !== "mcp") return;
      addInfoRow("could not load MCP servers: " + e.message);
      closePicker();
    },
  );
}

function renderMcpPicker() {
  if (picker.mcpIndex >= picker.mcp.length) {
    picker.mcpIndex = Math.max(0, picker.mcp.length - 1);
  }
  const list = document.getElementById("picker-list");
  list.innerHTML = "";
  picker.mcp.forEach((s, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-row" + (i === picker.mcpIndex ? " active" : "");
    const mark = document.createElement("span");
    mark.className = "picker-mark" + (s.enabled ? " on" : "");
    mark.textContent = s.enabled ? "[x]" : "[ ]";
    row.appendChild(mark);
    const nm = document.createElement("span");
    nm.className = "picker-name";
    nm.textContent = s.name;
    row.appendChild(nm);
    const detail = document.createElement("span");
    detail.className = "picker-desc";
    detail.textContent = "— " + (s.detail || "");
    row.appendChild(detail);
    row.onmousedown = (e) => {
      e.preventDefault();
      picker.mcpIndex = i;
      void toggleMcpEntry(s.name);
    };
    list.appendChild(row);
  });
  if (picker.mcp.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = 'No MCP servers configured — add one to atom.json under "mcp".';
    list.appendChild(empty);
  }
}

// Optimistic row flip, then the persisted toggle + reconnect; the list
// re-syncs from the returned entry so the paint never lies (TUI parity).
async function toggleMcpEntry(name) {
  const entry = picker.mcp.find((e) => e.name === name);
  if (!entry) return;
  const next = !entry.enabled;
  entry.enabled = next;
  entry.detail = "reconnecting…";
  renderMcpPicker();
  try {
    const res = await fetch("/api/mcp/" + encodeURIComponent(name) + "/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    const idx = picker.mcp.findIndex((e) => e.name === name);
    if (idx !== -1) picker.mcp[idx] = data;
  } catch (e) {
    addInfoRow('could not toggle MCP server "' + name + '": ' + e.message);
    // Re-sync the row from the server so a failed toggle never sticks.
    try {
      const servers = await getJSON("/api/mcp");
      if (picker.open === "mcp" && Array.isArray(servers)) {
        picker.mcp = servers;
      }
    } catch {
      // keep the optimistic row; next open re-snapshots
    }
  }
  if (picker.open === "mcp") renderMcpPicker();
}

function onPickerKey(e) {
  if (!picker.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePicker();
    return;
  }
  if (picker.open === "skill") {
    const entries = filteredSkills();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (entries.length > 0) picker.index = (picker.index + 1) % entries.length;
      renderSkillPicker();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length > 0) {
        picker.index = (picker.index - 1 + entries.length) % entries.length;
      }
      renderSkillPicker();
    } else if (e.key === "Enter") {
      const picked = entries[picker.index];
      if (picked) {
        e.preventDefault();
        pickSkill(picked.name);
      }
    }
    return;
  }
  if (picker.open === "mcp") {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (picker.mcp.length > 0) picker.mcpIndex = (picker.mcpIndex + 1) % picker.mcp.length;
      renderMcpPicker();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (picker.mcp.length > 0) {
        picker.mcpIndex = (picker.mcpIndex - 1 + picker.mcp.length) % picker.mcp.length;
      }
      renderMcpPicker();
    } else if (e.key === " " || e.key === "Enter") {
      const picked = picker.mcp[picker.mcpIndex];
      if (picked) {
        e.preventDefault();
        void toggleMcpEntry(picked.name);
      }
    }
  }
}

// Filter input lives inside the overlay: typing narrows, never submits.
document.addEventListener("input", (e) => {
  if (
    picker.open === "skill" &&
    e.target &&
    e.target.id === "picker-filter"
  ) {
    picker.filter = e.target.value;
    picker.index = 0;
    renderSkillPicker();
  }
});

/* ---------------- IDE-split layout (chat / split / review) ---------------- */
// Additive shell controls only: no turn/render logic touched. Layout persists
// in localStorage; "review" opens the latest diff via the existing viewer.
function paintLayoutButtons() {
  const layout = document.documentElement.dataset.layout || "split";
  for (const name of ["chat", "split", "review"]) {
    const btn = document.getElementById("layout-" + name);
    if (btn) btn.setAttribute("aria-pressed", layout === name ? "true" : "false");
  }
}

function setLayout(name) {
  if (name !== "chat" && name !== "split" && name !== "review") return;
  document.documentElement.dataset.layout = name;
  try {
    localStorage.setItem("atom-layout", name);
  } catch {
    /* private mode — session default stands */
  }
  paintLayoutButtons();
  if (name === "chat") closeOverlays();
  if (name === "review") {
    if (window.innerWidth <= 1240) els.right.classList.add("hidden-narrow");
    const first = els.files.querySelector("[data-diffpath]");
    if (first) first.click();
  }
  syncScrim();
}

for (const name of ["chat", "split", "review"]) {
  const btn = document.getElementById("layout-" + name);
  if (btn) btn.addEventListener("click", () => setLayout(name));
}

/* Session filter: hides non-matching rows, fabricates nothing. */
const sessionFilter = document.getElementById("session-filter");
if (sessionFilter) {
  sessionFilter.addEventListener("input", () => {
    const q = sessionFilter.value.trim().toLowerCase();
    for (const row of els.sessions.querySelectorAll(".session")) {
      row.style.display =
        !q || row.textContent.toLowerCase().includes(q) ? "" : "none";
    }
  });
}

/* Explorer live dot mirrors the existing connection label. */
function paintConnDot() {
  const dot = document.getElementById("conn-dot");
  if (!dot) return;
  dot.classList.toggle("live", els.conn.classList.contains("live"));
}
new MutationObserver(paintConnDot).observe(els.conn, {
  attributes: true,
  attributeFilter: ["class"],
});

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    paintThemeButton();
    paintLayoutButtons();
    paintConnDot();
    if (window.innerWidth <= 820) els.sidebar.classList.add("hidden-narrow");
    if (window.innerWidth <= 1240) els.right.classList.add("hidden-narrow");
    syncScrim();
    await refreshProviders();
    refreshModels();
    await refreshSessions();
    const first = els.sessions.querySelector(".session");
    if (first) first.click();
    else {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const rec = await res.json();
      await refreshSessions();
      await selectSession(rec.id);
    }
  } catch (e) {
    showError("startup failed: " + e.message);
  }
})();
