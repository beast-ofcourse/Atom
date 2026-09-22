// TUI component system barrel: the composable Ink surface.
//
// Layering (presentation only — no agent logic below):
//   AppShell (layout) -> Conversation/Message (+ThinkingBlock/ToolCall) +
//   LiveZone (existing LiveTailHost, now composing ThinkingBlock +
//   MarkdownDraft + Spinner/Progress) + Composer + StatusBar +
//   PermissionPrompt / QuestionPrompt / CommandPalette +
//   Markdown/CodeBlock/ErrorMessage primitives.
//
// Existing leaves stay canonical where already clean:
//   StatusBar (ui/status-bar) + StatusBarHost, DiffView/SideBySideDiffView,
//   TodoPanel, InspectorPanel, PickerShell/Row stay as-is and are composed
//   here, not duplicated. Header is intentionally absent: the footer status
//   line is the sole info bar (startup art lives in TranscriptView Static).
export { AppShell, type AppShellProps } from "./AppShell.js";
export { Conversation, type ConversationProps } from "./Conversation.js";
export { Message, type MessageProps } from "./Message.js";
export { ThinkingBlock, LIVE_THINKING_LINES, type ThinkingBlockProps } from "./ThinkingBlock.js";
export { ToolCall, ToolResult, type ToolCallProps, type ToolResultProps } from "./ToolCall.js";
export { ErrorMessage, type ErrorMessageProps } from "./ErrorMessage.js";
export { CodeBlock, COMMITTED_CODEBLOCK_LINES, LIVE_CODEBLOCK_LINES, type CodeBlockProps } from "./CodeBlock.js";
export { MarkdownBody, MarkdownDraft, type MarkdownBodyProps, type MarkdownDraftProps } from "./Markdown.js";
export { Composer, type ComposerProps } from "./Composer.js";
export { QuestionPrompt, type QuestionPromptProps } from "./Modal.js";
export { PermissionPrompt, type PermissionPromptProps } from "./PermissionPrompt.js";
export { CommandPalette, type CommandPaletteProps } from "./CommandPalette.js";
export { Spinner, Progress, type SpinnerProps, type ProgressProps } from "./Activity.js";
export { StepBlockList, type StepBlockListProps } from "./StepBlockList.js";
export { Dock, type ActionChip, type DockProps, type DockState, type Pill } from "./Dock.js";
