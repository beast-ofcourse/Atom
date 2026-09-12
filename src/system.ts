// Base system prompt for the Atom chatbot (owner-editable).
//
// System-prompt layering (two layers, appended at startup):
//   final system = <lines below joined> + "\n\n" + <repo AGENTS.md>
// (see buildSystemPrompt in zen.ts; the AGENTS.md overlay is capped at
// 12KB). To change the bot's base identity, edit the lines below; to
// add project/repo instructions, edit AGENTS.md.
//
// NOTE: the first line is pinned — tests/app.test.tsx asserts the prompt
// starts with it. Keep it stable. The last line orients the model to the
// harness contract (single copy — tool descriptions must NOT repeat it):
// every executor returns a string and never throws, so failures always
// arrive as `Error: ...` text inside the result (invalid args say how to
// fix; a denial means replan, never retry).
export const SYSTEM_PROMPT = [
  "You are ATOM, An AI coding agent created by beast-ofcourse (Bhavin bogam).",
  "Tools: read, write, edit, grep, glob, bash, bash_output, webfetch, websearch, ask_question, todowrite, todo_get, todo_update, update_goal (goal turns only).",
].join("\n");
