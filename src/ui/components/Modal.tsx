// QuestionPrompt: ask_question dialog as a UI concept.
//
// Contract:
//   props.question/options/allowCustom/askCustom/askSelIndex — QuestionBox
//   shape (App owns keyboard + resolvers).
// Delegates to QuestionBox; owns no policy, no resolvers.
// (Generic bordered shells stay in ui/pickers — PickerShell is the single
// shell source; this file owns the question-dialog concept, not another shell.)
import React from "react";
import { QuestionBox, type QuestionBoxProps } from "../modals.js";

export type QuestionPromptProps = QuestionBoxProps;

export const QuestionPrompt = React.memo(function QuestionPrompt(props: QuestionPromptProps) {
  return <QuestionBox {...props} />;
});
