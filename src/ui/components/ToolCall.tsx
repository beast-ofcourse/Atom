// ToolCall: first-class committed tool presentation.
//
// Lifecycle interface (shared across all families):
//   ToolCallModel { kind, name, target, status, durationMs, summary, diff, ... }
// Specialized presenters (Terminal/File/Search/Web/Todo/Generic) consume the
// same model but render a kind-specific summary line. Execution never touches
// this file — App normalizes raw label/result/ms into the model via
// ui/tool-model, and this component only consumes the normalized model.
//
// Visual contract:
//   Header: [statusGlyph] name — kind status · duration · via token
//   Body: dim audit line (`⚙ name target` byte-identical for tests) + kind-
//         specific summary (compact, never raw output) + diff/error.
//   Raw tool output never dumps; full output lives in Ctrl+O inspector.
//   States: queued ○ / running ◉ / success ✓ / failed ✕ / cancelled⊘ / denied⊘
import React from "react";
import { Box, Text } from "ink";
import { SideBySideDiffView } from "../side-by-side.js";
import { ErrorCard, classifyToolError, type ClassifiedError } from "../errors.js";
import { ToolLine } from "../markdown.js";
import type { Turn } from "../transcript.js";
import { theme } from "../theme.js";
import { useTerminalSize } from "../layout.js";
import {
  formatDuration,
  kindLabel,
  modelFromTurn,
  statusColor,
  statusGlyph,
  statusText,
  type ToolCallModel,
  type ToolKind,
} from "../tool-model.js";

export type ToolCallProps = {
  turn: Turn;
  label?: Turn;
  // Optional: full result string for richer summary (when available via
  // inspector). When absent, summary falls back to target.
  result?: string | null;
};

export type ToolResultProps = { classified: ClassifiedError };

export const ToolResult = React.memo(function ToolResult({ classified }: ToolResultProps) {
  return <ErrorCard classified={classified} />;
});

// Per-kind specialized summary presenters (shared lifecycle interface).
// Each receives the normalized model and returns a compact dim line or null.
// They must NOT dump raw output — only a one-line summary.
function TerminalPresenter({ model }: { model: ToolCallModel }) {
  // Summary already derived per terminal (test counts or first line).
  if (!model.summary) return null;
  // Avoid duplicating the rawLabel target when summary is same as target.
  if (model.summary === model.target) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function FilePresenter({ model }: { model: ToolCallModel }) {
  // File tools: the diff (when present) carries the real change; the summary
  // line carries the proof-of-work (`50 lines` for a read) — compact, never
  // raw output. Hidden only when it would duplicate the audit target.
  if (!model.summary || model.summary === model.target) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function SearchPresenter({ model }: { model: ToolCallModel }) {
  if (!model.summary || model.summary === model.target) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function WebPresenter({ model }: { model: ToolCallModel }) {
  if (!model.summary || model.summary === model.target) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function parseTodosFromResult(result: string | null): Array<{ status: string; content: string }> {
  if (!result) return [];
  const lines = result.split("\n");
  const todos: Array<{ status: string; content: string }> = [];
  for (const line of lines) {
    const m = line.match(/^\s*\d+\.\s+(?:[✅🔧○]\s+)?\[(pending|in_progress|completed)\]\s*(.*)$/i);
    if (m) todos.push({ status: m[1]!.toLowerCase(), content: (m[2] ?? "").trim() });
  }
  return todos;
}

function TodoMark({ status }: { status: string }) {
  if (status === "completed") return <Text color={theme.color.success}>[✓] </Text>;
  if (status === "in_progress") return <Text color={theme.color.warning}>[•] </Text>;
  return <Text dimColor>[ ] </Text>;
}

function TodoPresenter({ model, result }: { model: ToolCallModel; result?: string | null }) {
  const todos = parseTodosFromResult(result ?? model.resultPreview ?? model.summary);
  // If we can parse a structured list, render opencode-style BlockTool # Todos
  if (todos.length > 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold># Todos</Text>
        {todos.map((t, i) => (
          <Box key={`${i}-${t.content}`} flexDirection="row">
            <TodoMark status={t.status} />
            <Text color={t.status === "in_progress" ? theme.color.warning : undefined} dimColor={t.status !== "in_progress"} wrap="wrap">
              {t.content}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }
  if (!model.summary) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function GenericPresenter({ model }: { model: ToolCallModel }) {
  if (!model.summary || model.summary === model.target) return null;
  return <Text dimColor wrap="wrap">  {model.summary}</Text>;
}

function PresenterForKind({ model, result }: { model: ToolCallModel; result?: string | null }) {
  switch (model.kind) {
    case "terminal": return <TerminalPresenter model={model} />;
    case "file": return <FilePresenter model={model} />;
    case "search": return <SearchPresenter model={model} />;
    case "web": return <WebPresenter model={model} />;
    case "todo": return <TodoPresenter model={model} result={result} />;
    case "vision":
    case "generic": return <GenericPresenter model={model} />;
  }
}

function isAuditLabelContent(content: string): boolean {
  return content.startsWith(`${theme.symbol.toolMark} `);
}

export const ToolCall = React.memo(function ToolCall({ turn, label, result }: ToolCallProps) {
  const classified = classifyToolError(turn, label ?? null);
  // For paired error, the audit label carries the tool identity; for lone
  // turns, `turn` itself is the label.
  const rawLabelTurn = label ?? turn;
  const isAudit = isAuditLabelContent(rawLabelTurn.content) || isAuditLabelContent(turn.content);

  // Non-audit tool outputs (todo echoes, warnings, retries, cancel) stay
  // as plain ToolLine — they are not tool calls with a lifecycle header.
  // This preserves the byte-identical audit contract for audit lines while
  // avoiding a header for chatter.
  if (!isAudit && !classified) {
    // Distinguish todo success echoes (multi-line) — keep dim.
    return <ToolLine content={turn.content} error={turn.error} ms={turn.ms} via={turn.approvalVia} />;
  }

  // Build normalized model for audit-line calls (success or failed).
  // For paired errors, derive from the error turn with label context; for
  // successes, derive from the audit turn itself.
  const modelSourceTurn = classified && label ? turn : rawLabelTurn;
  const modelLabel = classified && label ? label : undefined;
  const model = modelFromTurn(modelSourceTurn, modelLabel ?? null, result ?? null);

  // Responsive header: very narrow hides kind/via/Ctrl+O to avoid wrapping.
  let columns = 100;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 100;
  }
  const isVeryNarrow = columns < 50;
  const isNarrow = columns < 70;

  const glyph = statusGlyph(model.status);
  const color = statusColor(model.status);
  const dur = formatDuration(model.durationMs);
  const via = model.approvalVia;

  if (classified) {
    const labelDiff = label?.diff;
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={color} bold>{glyph}</Text>{" "}
          <Text bold wrap="truncate">{model.name}</Text>{" "}
          <Text dimColor wrap="truncate">
            {!isVeryNarrow ? `${kindLabel(model.kind)} ` : ""}{statusText(model.status)}
            {dur ? ` ${theme.symbol.separator} ${dur}` : ""}
            {!isNarrow && via ? ` ${theme.symbol.separator} via ${via}` : ""}
          </Text>
        </Text>
        {label ? <ToolLine content={label.content} ms={label.ms} via={isNarrow ? null : label.approvalVia} /> : null}
        {labelDiff && !label?.error ? (
          <SideBySideDiffView
            oldText={labelDiff.oldText}
            newText={labelDiff.newText}
            lang={labelDiff.lang}
            path={labelDiff.path}
          />
        ) : null}
        <ToolResult classified={classified} />
        {classified.inspectable && !isVeryNarrow ? <Text dimColor wrap="truncate">  Ctrl+O for full output</Text> : null}
      </Box>
    );
  }

  const turnDiff = turn.diff;
  const hasExpandable = !!turnDiff || !!model.resultPreview;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={color} bold>{glyph}</Text>{" "}
        <Text bold wrap="truncate">{model.name}</Text>{" "}
        <Text dimColor wrap="truncate">
          {!isVeryNarrow ? `${kindLabel(model.kind)} ` : ""}{statusText(model.status)}
          {dur ? ` ${theme.symbol.separator} ${dur}` : ""}
          {!isNarrow && via ? ` ${theme.symbol.separator} via ${via}` : ""}
          {hasExpandable && !isVeryNarrow ? ` ${theme.symbol.separator} Ctrl+O` : ""}
        </Text>
      </Text>
      <ToolLine content={model.rawLabel} ms={model.durationMs} via={isNarrow ? null : via} />
      <PresenterForKind model={model} result={result} />
      {turnDiff && !turn.error ? (
        <SideBySideDiffView
          oldText={turnDiff.oldText}
          newText={turnDiff.newText}
          lang={turnDiff.lang}
          path={turnDiff.path}
        />
      ) : null}
    </Box>
  );
});

// Live ToolCall: ephemeral queued/running presentation for the dynamic zone.
// Shares the same header shape as the committed card so the transition is
// smooth. Consumes normalized live model, not execution internals.
export type LiveToolCallProps = {
  name: string;
  target?: string;
  kind?: ToolKind;
  status: "queued" | "running";
  durationMs?: number;
};

export const LiveToolCall = React.memo(function LiveToolCall({ name, target, kind, status, durationMs }: LiveToolCallProps) {
  const k: ToolKind = kind ?? (name ? ((): ToolKind => {
    const n = name.toLowerCase();
    if (n === "bash" || n === "bash_output") return "terminal";
    if (n === "read" || n === "write" || n === "edit") return "file";
    if (n === "grep" || n === "glob") return "search";
    if (n === "webfetch" || n === "websearch") return "web";
    if (n.startsWith("todo")) return "todo";
    return "generic";
  })() : "generic");
  const glyph = status === "queued" ? theme.symbol.toolQueued : theme.symbol.toolRunning;
  const color = status === "queued" ? undefined : theme.color.warning;
  const dur = formatDuration(durationMs);
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">
        <Text color={color}>{glyph}</Text> {name} {kindLabel(k)} {status} {dur ? `${theme.symbol.separator} ${dur}` : theme.symbol.ellipsis}
      </Text>
      {target ? <Text dimColor wrap="wrap">  {target}</Text> : null}
    </Box>
  );
});
