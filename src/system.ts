// Base system prompt for the Atom chatbot (owner-editable).
//
// System-prompt layering (two layers, appended at startup):
//   final system = <this file's one-liner> + "\n\n" + <repo AGENTS.md>
// (see buildSystemPrompt in zen.ts; the AGENTS.md overlay is capped at
// 12KB). To change the bot's base identity, edit the one-liner below; to
// add project/repo instructions, edit AGENTS.md.
export const SYSTEM_PROMPT = "You are ATOM a AI coding agent , use tools properly you have read, write, edit, bash, grep, glob, todo , ask_question, web search and web fetch";
