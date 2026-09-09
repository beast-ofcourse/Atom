// Typed error presentation for transcript tool turns. The loop commits
// terse error text (first lines, markers); this module classifies it into
// seven visual states and renders compact cards — never walls. Full
// diagnostics live where they already do: failed tool results are retained
// verbatim in the Ctrl+O inspector store, so cards point there instead of
// dumping output. Pure (classify + parse) + presentational (card).
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { Turn } from "./transcript.js";

export type ErrorKind =
  | "tool"
  | "denial"
  | "network"
  | "model"
  | "cancelled"
  | "config"
  | "internal";

export type ClassifiedError = {
  kind: ErrorKind;
  title: string;
  detail: string;
  hint: string | null;
  inspectable: boolean;
};

// The audit label grammar (`⚙ name target`) carries the tool identity the
// error detail alone lacks. Paired in TranscriptView (adjacent turns).
export function parseToolLabel(label: string): { name: string; target: string } {
  const mark = `${theme.symbol.toolMark} `;
  const stripped = (label.startsWith(mark) ? label.slice(mark.length) : label).trim();
  const space = stripped.indexOf(" ");
  if (space === -1) return { name: stripped, target: "" };
  return { name: stripped.slice(0, space), target: stripped.slice(space + 1).trim() };
}

export function titleCase(name: string): string {
  return name.length > 0 ? name[0]!.toUpperCase() + name.slice(1) : name;
}

const NETWORK_RE =
  /HTTP (429|500|502|503|504)|connection reset|fetch failed|network|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN|socket hang up/i;
const MODEL_RE = /Empty reply|Truncated stream|malformed|unexpected payload|no .* usage|invalid response/i;
const CONFIG_RE = /Missing API key|no API key|not configured|invalid baseURL|auth/i;

// Classify a tool-role turn. Returns null when the turn is not an error
// presentation (normal audit lines, warnings, retries, boundaries, todo
// output, and the pinned `(cancelled)` line, which keeps its legacy look).
export function classifyToolError(turn: Turn, label: Turn | null): ClassifiedError | null {
  const content = turn.content;
  if (content.startsWith("(cancelled)")) return null;
  if (!turn.error) {
    if (/^Missing API key/i.test(content.trim())) {
      return {
        kind: "config",
        title: "Setup needed",
        detail: content.trim(),
        hint: "Run /provider to paste a key, then resend.",
        inspectable: false,
      };
    }
    return null;
  }
  const detail = content.replace(/^[↳\s]+/, "");
  if (/denied by user/i.test(detail)) {
    const tool = detail.split(":").pop()?.trim() ?? "";
    return {
      kind: "denial",
      title: tool ? `Denied — ${titleCase(tool)}` : "Denied",
      detail,
      hint: "Approve next time, or pre-approve with /allow.",
      inspectable: false,
    };
  }
  if (NETWORK_RE.test(detail)) {
    return {
      kind: "network",
      title: "Network failed",
      detail,
      hint: "Auto-retried — check the connection, then resend.",
      inspectable: false,
    };
  }
  if (MODEL_RE.test(detail)) {
    return {
      kind: "model",
      title: "Model failed",
      detail,
      hint: "Resend to retry the request.",
      inspectable: false,
    };
  }
  if (CONFIG_RE.test(detail)) {
    return {
      kind: "config",
      title: "Setup needed",
      detail,
      hint: "Run /provider to paste a key, then resend.",
      inspectable: false,
    };
  }
  if (/panic|invariant|unexpected|internal/i.test(detail)) {
    return {
      kind: "internal",
      title: "Internal error",
      detail,
      hint: "Please report this with the transcript.",
      inspectable: false,
    };
  }
  // Default: a failed tool call. The audit line above already names the
  // tool + target (paired by TranscriptView), so the card title stays
  // short; the full result waits in the inspector store.
  if (label) {
    const { name } = parseToolLabel(label.content);
    return {
      kind: "tool",
      title: `${titleCase(name) || "Tool"} failed`,
      detail,
      hint: "Ctrl+O opens the full output in the inspector.",
      inspectable: true,
    };
  }
  return {
    kind: "tool",
    title: "Tool failed",
    detail,
    hint: "Ctrl+O opens the full output in the inspector.",
    inspectable: true,
  };
}

const KIND_GLYPH: Record<ErrorKind, string> = {
  tool: "✕",
  denial: "⊘",
  network: "⚠",
  model: "✕",
  cancelled: "",
  config: "→",
  internal: "‼",
};

const KIND_COLOR: Record<ErrorKind, string | undefined> = {
  tool: theme.color.toolError,
  denial: theme.color.warning,
  network: theme.color.warning,
  model: theme.color.toolError,
  cancelled: undefined,
  config: theme.color.user,
  internal: theme.color.toolError,
};

// Compact card: bold titled first line, one detail line, one dim hint line.
// No boxes, no walls — three lines max per error.
export function ErrorCard({ classified }: { classified: ClassifiedError }) {
  return (
    <Box flexDirection="column">
      <Text bold color={KIND_COLOR[classified.kind]}>
        {KIND_GLYPH[classified.kind]} {classified.title}
      </Text>
      <Text>
        {"  "}
        {classified.detail}
      </Text>
      {classified.hint ? <Text dimColor>  {classified.hint}</Text> : null}
    </Box>
  );
}
