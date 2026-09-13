// ErrorMessage: fatal/error-line presentation.
//
// Contract:
//   props.message — already-formatted error text (no prefix added here beyond
//                   the pinned `error> ` marker the App emits).
// Presentation only: classification of tool errors lives in ui/errors
// (ErrorCard) and is owned by ToolCall, not here.
import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";

export type ErrorMessageProps = { message: string };

export const ErrorMessage = React.memo(function ErrorMessage({ message }: ErrorMessageProps) {
  return <Text color={theme.color.error}>error&gt; {message}</Text>;
});
