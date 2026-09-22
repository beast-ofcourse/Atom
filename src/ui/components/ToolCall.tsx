// ToolCall: first-class committed tool presentation — one bordered widget
// per tool call (opencode parity).
//
// Lifecycle interface (shared across all families):
//   ToolCallModel { kind, name, target, status, durationMs, summary, diff, ... }
// Execution never touches this file — App normalizes raw label/result/ms
// into the model via ui/tool-model, and this component only consumes the
// normalized model.
//
// Visual contract (widget):
//   Frame: round border, color by status (green ok / red failed /
//          yellow denied-cancelled-running / gray queued; ask_question uses
//          the magenta question frame). xs terminals keep the border with
//          zero padding.
//   Header: [statusGlyph] name — kind status · duration · via · — summary · Ctrl+O
//   Body: dim audit line (`⚙ name target` byte-identical for tests) +
//         shared one-line summary (never raw output) + capped inline preview
//         (≤6 lines) + diff/error.
//   Raw tool output never dumps; full output lives in Ctrl+O inspector
//   (committed <Static> rows freeze — in-place expand is impossible there).
//   States: queued ○ / running ◉ / success ✓ / failed ✕ / cancelled ◌ / denied ⊘
import React from "react";
import { Box, Text } from "ink";
import { SideBySideDiffView } from "../side-by-side.js";
import { ErrorCard, classifyToolError, type ClassifiedError } from "../errors.js";
import { ToolLine } from "../markdown.js";
import type { Turn } from "../transcript.js";
import { theme } from "../theme.js";
import { frameContentWidth, useTerminalSize, widgetWidth } from "../layout.js";
import {
  borderColorFor,
  formatDuration,
  kindLabel,
  modelFromTurn,
  statusColor,
  statusGlyph,
  statusText,
  TOOL_PREVIEW_LINES,
  type ToolCallModel,
  type ToolKind,
  type ToolStatus,
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

// Frame color: status-driven, with the question-tool override (interaction
// renders in the magenta question frame so Q/A reads as dialogue, not work).
function frameColor(name: string, status: ToolStatus): string {
  if (name === "ask_question") return theme.border.question;
  return borderColorFor(status);
}

// Shared one-line summary (all kinds, one language): dim, hanging indent,
// hidden when it would duplicate the audit target. Replaces the per-kind
// presenters — the model already derives kind-specific summaries.
function WidgetSummary({ model }: { model: ToolCallModel }) {
  if (!model.summary || model.summary === model.target) return null;
  return (
    <Box flexDirection="row">
      <Text dimColor>{theme.spacing.rowIndent}</Text>
      <Box flexGrow={1}>
        <Text dimColor wrap="wrap">{model.summary}</Text>
      </Box>
    </Box>
  );
}

// Capped inline preview: the bridge to the inspector. Only for output
// families (terminal/file/search/web/generic); todo shows counts, ask shows
// the answer — both already in the header/summary line.
function WidgetPreview({ model }: { model: ToolCallModel }) {
  if (model.kind !== "terminal" && model.kind !== "file" && model.kind !== "search" && model.kind !== "web" && model.kind !== "generic") return null;
  if (!model.resultPreview) return null;
  const lines = model.resultPreview.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const shown = lines.slice(0, TOOL_PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((ln, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>{theme.spacing.rowIndent}</Text>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate">{ln.trim().length > 120 ? `${ln.trim().slice(0, 117)}${theme.symbol.ellipsis}` : ln.trim()}</Text>
          </Box>
        </Box>
      ))}
      {hidden > 0 ? (
        <Text dimColor wrap="truncate">
          {theme.spacing.rowIndent}
          {theme.symbol.ellipsis} {hidden} more line{hidden === 1 ? "" : "s"} {theme.symbol.descSeparator} Ctrl+O
        </Text>
      ) : null}
    </Box>
  );
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

  // Non-audit tool outputs (todo_get echoes, warnings, retries, cancel)
  // stay as plain ToolLine — they are not tool calls with a lifecycle
  // header. This preserves the byte-identical audit contract for audit
  // lines while avoiding a frame for chatter.
  if (!isAudit && !classified) {
    return <ToolLine content={turn.content} error={turn.error} ms={turn.ms} via={turn.approvalVia} />;
  }

  // Build normalized model for audit-line calls (success or failed).
  // For paired errors, derive from the error turn with label context; for
  // successes, derive from the audit turn itself.
  const modelSourceTurn = classified && label ? turn : rawLabelTurn;
  const modelLabel = classified && label ? label : undefined;
  const model = modelFromTurn(modelSourceTurn, modelLabel ?? null, result ?? null);

  // Responsive frame: very narrow hides kind/via/Ctrl+O to avoid wrapping
  // and drops padding; the border stays (identity survives xs).
  let columns = 100;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 100;
  }
  const isVeryNarrow = columns < 50;
  const isNarrow = columns < 70;
  const width = widgetWidth(columns);

  const glyph = statusGlyph(model.status);
  const color = statusColor(model.status);
  const dur = formatDuration(model.durationMs);
  const via = model.approvalVia;
  const frame = frameColor(model.name, model.status);
  const padX = isVeryNarrow ? 0 : theme.spacing.widgetPadX;
  // The diff is a child of THIS bordered box, so it budgets against the
  // box's content width — not the terminal, which is far wider than the
  // 100-col-capped frame on wide windows (its panes would be clipped).
  const bodyWidth = frameContentWidth(width, padX);

  if (classified) {
    const labelDiff = label?.diff;
    return (
      <Box flexDirection="column" borderStyle={theme.border.style} borderColor={frame} paddingX={padX} width={width}>
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
            columns={bodyWidth}
          />
        ) : null}
        <ToolResult classified={classified} />
        {classified.inspectable && !isVeryNarrow ? <Text dimColor wrap="truncate">  Ctrl+O for full output</Text> : null}
      </Box>
    );
  }

  const turnDiff = turn.diff;
  const hasExpandable = !!turnDiff || !!model.resultPreview;
  // Header carries kind/status/duration/via plus the summary suffix and the
  // inspector hint. ToolLine below keeps `⚙ name target` byte-identical
  // (pinned by tests); the shared summary + capped preview render inside
  // the frame instead of a third text row.
  const inlineSummary = model.summary && model.summary !== model.target ? model.summary : null;
  return (
    <Box flexDirection="column" borderStyle={theme.border.style} borderColor={frame} paddingX={padX} width={width}>
      <Text wrap="truncate">
        <Text color={color} bold>{glyph}</Text>{" "}
        <Text bold wrap="truncate">{model.name}</Text>{" "}
        <Text dimColor wrap="truncate">
          {!isVeryNarrow ? `${kindLabel(model.kind)} ` : ""}{statusText(model.status)}
          {dur ? ` ${theme.symbol.separator} ${dur}` : ""}
          {!isNarrow && via ? ` ${theme.symbol.separator} via ${via}` : ""}
          {inlineSummary ? ` ${theme.symbol.descSeparator} ${inlineSummary}` : ""}
          {hasExpandable && !isVeryNarrow ? ` ${theme.symbol.separator} Ctrl+O` : ""}
        </Text>
      </Text>
      <ToolLine content={model.rawLabel} ms={model.durationMs} via={isNarrow ? null : via} />
      <WidgetSummary model={model} />
      <WidgetPreview model={model} />
      {turnDiff && !turn.error ? (
        <SideBySideDiffView
          oldText={turnDiff.oldText}
          newText={turnDiff.newText}
          lang={turnDiff.lang}
          path={turnDiff.path}
          columns={bodyWidth}
        />
      ) : null}
    </Box>
  );
});

// Live ToolCall: ephemeral queued/running presentation for the dynamic zone.
// Same bordered frame as the committed card (running/queued tint) so the
// transition settles without a visual jump. Consumes normalized live model,
// not execution internals. `verb` is the `◉ Reading path` activity tail
// (pinned by tests) — the header carries identity, the tail carries action.
export type LiveToolCallProps = {
  name: string;
  target?: string;
  kind?: ToolKind;
  status: "queued" | "running";
  durationMs?: number;
  verb?: string;
};

export const LiveToolCall = React.memo(function LiveToolCall({ name, target, kind, status, durationMs, verb }: LiveToolCallProps) {
  const k: ToolKind = kind ?? (name ? ((): ToolKind => {
    const n = name.toLowerCase();
    if (n === "bash" || n === "bash_output") return "terminal";
    if (n === "read" || n === "write" || n === "edit") return "file";
    if (n === "grep" || n === "glob") return "search";
    if (n === "webfetch" || n === "websearch") return "web";
    if (n.startsWith("todo")) return "todo";
    return "generic";
  })() : "generic");
  let columns = 100;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 100;
  }
  const isVeryNarrow = columns < 50;
  const glyph = status === "queued" ? theme.symbol.toolQueued : theme.symbol.toolRunning;
  const color = status === "queued" ? undefined : theme.color.warning;
  const dur = formatDuration(durationMs);
  return (
    <Box
      flexDirection="column"
      borderStyle={theme.border.style}
      borderColor={status === "queued" ? theme.border.tool.queued : theme.border.tool.running}
      paddingX={isVeryNarrow ? 0 : theme.spacing.widgetPadX}
      width={widgetWidth(columns)}
    >
      <Text wrap="truncate">
        <Text color={color}>{glyph}</Text> <Text bold>{name}</Text>{" "}
        <Text dimColor>
          {!isVeryNarrow ? `${kindLabel(k)} ` : ""}{status}
          {dur ? ` ${theme.symbol.separator} ${dur}` : ` ${theme.symbol.ellipsis}`}
          {target ? ` ${theme.symbol.descSeparator} ${target}` : ""}
        </Text>
      </Text>
      {verb && !isVeryNarrow ? <Text dimColor wrap="truncate">  {verb}</Text> : null}
    </Box>
  );
});
