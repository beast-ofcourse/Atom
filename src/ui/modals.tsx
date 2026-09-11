// Modal leaves: the tool-approval and ask_question dialogs. Prop-driven.
// All paint comes from ui/theme tokens. The approval tool-call description
// arrives pre-formatted (describeToolCall stays in App) so this module
// couples to no tool internals — the approval-redesign chunk owns it.
import React from "react";
import { Box, Text } from "ink";
import { SideBySideDiffView } from "./side-by-side.js";
import type { DiffPreview } from "./diff.js";
import { theme } from "./theme.js";

export type ApprovalBoxProps = {
  toolName: string;
  description: string;
  // Highlighted option (0..3): allow-once, always-this-tool,
  // trust-all, deny. Controlled by App (keyboard lives there).
  selected: number;
  // Unified diff preview for write/edit approvals (null/absent = no
  // preview — the one-line description above is the whole story).
  // Capped so the modal stays compact; the full change applies on [y].
  diff?: DiffPreview | null;
};

// Retained for compatibility (no longer applied — the approval preview
// renders the full diff; smoothness comes from the per-mount memo + word
// fallbacks, not from a row cap).
export const APPROVAL_DIFF_MAX_LINES = Infinity;

export const APPROVAL_OPTIONS = ["once", "always", "trustAll", "no"] as const;
export type ApprovalOption = (typeof APPROVAL_OPTIONS)[number];

// Command/file preview: the audit description minus its `⚙ name` prefix
// (the tool name already headlines above). Falls back to the full text
// when the shape is unexpected — never invents content.
export function approvalPreview(toolName: string, description: string): string {
  const prefix = `⚙ ${toolName} `;
  if (description.startsWith(prefix)) return description.slice(prefix.length);
  return description;
}

export function approvalTitle(toolName: string): string {
  return toolName.length > 0 ? toolName[0]!.toUpperCase() + toolName.slice(1) : toolName;
}

// Render-count probes for the flicker tests: the 1s busy tick and unrelated
// parent churn must skip both modals (only changed props repaint — nav
// selection still paints exactly once per keypress).
export const approvalRenderProbe = { count: 0 };
export const questionRenderProbe = { count: 0 };

export const ApprovalBox = React.memo(function ApprovalBox({ toolName, description, selected, diff }: ApprovalBoxProps) {
  approvalRenderProbe.count += 1;
  const rows: { label: string; option: ApprovalOption }[] = [
    // Labels keep the historical [y]/[a]/[t]/[n] shortcuts (pinned by tests
    // + muscle memory): arrows are additive, shortcuts never move.
    { label: "[y]es once", option: "once" },
    { label: `[a]lways allow ${toolName} this session`, option: "always" },
    { label: "[t]rust all write/edit/bash this session", option: "trustAll" },
    { label: "[n]o — deny this call", option: "no" },
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle={theme.border.style}
      borderColor={theme.border.approval}
      paddingX={theme.spacing.pickerPadX}
    >
      <Text bold color={theme.color.warning}>
        {theme.symbol.warningMark} Atom permission — allow this tool?
      </Text>
      <Text bold>{approvalTitle(toolName)}</Text>
      <Text color={theme.color.code}>{approvalPreview(toolName, description)}</Text>
      {diff ? <SideBySideDiffView oldText={diff.oldText} newText={diff.newText} lang={diff.lang} /> : null}
      {rows.map((r, i) => (
        <Text key={r.option} color={i === selected ? theme.color.selection : undefined}>
          {i === selected ? `${theme.symbol.select} ` : theme.spacing.rowIndent}
          {r.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ + Enter selects · y/a/t/n shortcuts · Esc denies</Text>
    </Box>
  );
});

export type QuestionBoxProps = {
  question: string;
  options: string[];
  allowCustom: boolean;
  askCustom: string;
  askSelIndex: number;
};

export const QuestionBox = React.memo(function QuestionBox({ question, options, allowCustom, askCustom, askSelIndex }: QuestionBoxProps) {
  questionRenderProbe.count += 1;
  return (
    <Box
      flexDirection="column"
      borderStyle={theme.border.style}
      borderColor={theme.border.question}
      paddingX={theme.spacing.pickerPadX}
    >
      <Text bold>Atom question — {question}</Text>
      {options.map((o, i) => (
        <Text key={`${o}-${i}`} color={i === askSelIndex ? theme.color.questionSelection : undefined}>
          {i === askSelIndex ? `${theme.symbol.select} ` : theme.spacing.rowIndent}
          {o}
        </Text>
      ))}
      {allowCustom ? (
        <Text dimColor>
          Type a custom answer + Enter to send it
          {askCustom ? `: ${askCustom}` : ""} · ↑/↓ + Enter picks · Esc cancels
        </Text>
      ) : (
        <Text dimColor>↑/↓ + Enter to pick · Esc cancels</Text>
      )}
    </Box>
  );
});
