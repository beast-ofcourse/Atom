// PermissionPrompt: tool-approval dialog as a UI concept.
//
// Contract:
//   props.toolName — tool id (headline); props.description — pre-formatted
//   audit description from decideApproval path (never recomputed in render).
//   props.selected — highlighted option 0..3 (App owns keyboard).
//   props.diff — approval preview (capped in ApprovalBox, null = label only).
// Delegates to ApprovalBox; owns no policy, no fs, no resolvers.
import React from "react";
import { ApprovalBox, type ApprovalBoxProps } from "../modals.js";

export type PermissionPromptProps = ApprovalBoxProps;

export const PermissionPrompt = React.memo(function PermissionPrompt(props: PermissionPromptProps) {
  return <ApprovalBox {...props} />;
});
