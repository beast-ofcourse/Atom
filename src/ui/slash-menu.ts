// Slash-menu engine: command registry + matchers + menu builders.
//
// Deep module extracted from App.tsx (TUI root). Pure — no React, no state,
// no imports — so ui/mentions and App share the single fuzzyScore instead of
// the local copy mentions carried to avoid an App cycle.
export type SlashCommand = { name: string; description: string };

// Single registry for the "/" autocomplete menu and the exact-command path.
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/model",
    description:
      "Open the model picker (/model <text> filters, /model refresh re-probes servers).",
  },
  {
    name: "/provider",
    description: "Pick AI provider, paste API key once, chat.",
  },
  {
    name: "/effort",
    description:
      "Open the reasoning-effort picker (Auto/Low/Medium/High/Max; Auto lets the model decide).",
  },
  { name: "/tools", description: "List the tools with one-line descriptions." },
  {
    name: "/mcp",
    description:
      "Manage MCP servers (Space toggles enable/disable, Esc closes).",
  },
  {
    name: "/skill",
    description:
      "List skills in a picker, or invoke (/skill:name, /skill <name>).",
  },
  {
    name: "/mode",
    description:
      "Print the current permission mode (Tab cycles normal → yolo → plan).",
  },
  {
    name: "/trust",
    description:
      "Toggle session trust: auto-approve write/edit/bash without full yolo (/trust again revokes).",
  },
  {
    name: "/allow",
    description:
      "Pre-approve a tool pattern this session (e.g. /allow bash:npm test*).",
  },
  {
    name: "/deny",
    description:
      "Forbid a tool pattern this session — deny wins over trust/yolo (e.g. /deny bash:rm *).",
  },
  {
    name: "/rules",
    description: "List session allow/deny rules (/rules clear wipes them).",
  },
  {
    name: "/clear",
    description:
      "Clear the conversation history (keeps session token totals; drops file checkpoints).",
  },
  {
    name: "/new",
    description:
      "Start a brand-new session (full fresh conversation + counters reset, previous kept for /resume).",
  },
  {
    name: "/rename",
    description: "Rename the current session (/rename <name>).",
  },
  {
    name: "/compact",
    description:
      "Summarize older turns into one summary (optional focus text: /compact focus…).",
  },
  {
    name: "/context",
    description:
      "Show context usage by source (system, tools, history, skills).",
  },
  {
    name: "/queue",
    description: "List queued follow-ups (/queue clear wipes them).",
  },
  {
    name: "/steer",
    description: "Steer the running turn, or send when idle (/steer <text>).",
  },
  {
    name: "/autoscroll",
    description:
      "Toggle following new output (on by default; bare toggles, on|off sets it; off freezes the view mid-turn).",
  },
  {
    name: "/goal",
    description:
      "Set (and start working, like a normal message), show, pause, resume, or clear the session goal (/goal <objective>; bare shows it; /goal pause|resume; /goal clear ends it). The model manages it with matching tools (create on /goal intent only; pause/resume/clear in matching state).",
  },
  {
    name: "/thinking",
    description:
      "Show or hide model thinking in the TUI (rendering only; the turn is untouched).",
  },
  {
    name: "/theme",
    description:
      "List themes (bare) or switch live (/theme ember|classic; unknown names fall back to ember).",
  },
  {
    name: "/resume",
    description:
      "Restore the last saved session (turns, history, settings, usage).",
  },
  {
    name: "/session",
    description:
      "Switch the active session (interactive picker, most recent first).",
  },
  {
    name: "/fork",
    description:
      "Fork this session into a new one and switch to it (/fork [n] drops the last n messages first).",
  },
  {
    name: "/revert",
    description:
      "Undo to a checkpoint — restores conversation + files (/revert [n] goes n checkpoints back).",
  },
  {
    name: "/telemetry",
    description:
      "Show the local observability summary (sessions, tokens, tools).",
  },
  {
    name: "/usage",
    description:
      "Show the per-POST usage ledger for this session (turn steps + compaction POSTs).",
  },
  {
    name: "/dashboard",
    description:
      "Write the local observability dashboard page and show its path.",
  },
  {
    name: "/rewind",
    description:
      "Restore files to a session checkpoint (files only; shell side effects are never snapshotted).",
  },
  {
    name: "/reload",
    description:
      "Reload config, skills, extensions, MCP servers, and instruction files — pick up edits without restarting (conversation, session, trust, and mode kept).",
  },
  { name: "/help", description: "List commands with one-liners." },
  { name: "/exit", description: "Exit Atom." },
  { name: "/quit", description: "Exit Atom." },
];

export function filterSlashCommands(prefix: string): SlashCommand[] {
  const q = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  // Exact match wins outright: a fully-typed command collapses the menu
  // to itself, so prefix-siblings (/mode vs /model, /skill vs /skill:name
  // rows) never read as duplicates and Enter stays deterministic. Partial
  // input keeps the prefix-then-fuzzy tiers below untouched.
  const full = `/${q}`;
  const exact = SLASH_COMMANDS.find((c) => c.name === full);
  if (exact) return [exact];
  const pre: SlashCommand[] = [];
  const fuzzy: { c: SlashCommand; s: number }[] = [];
  for (const c of SLASH_COMMANDS) {
    const name = c.name.slice(1);
    if (name.startsWith(q)) {
      pre.push(c);
      continue;
    }
    const s = fuzzyScore(q, name);
    if (s !== null) fuzzy.push({ c, s });
  }
  // Prefix tier keeps registry order (stable, muscle memory); fuzzy tier
  // ranks by score, ties by name.
  fuzzy.sort((a, b) => a.s - b.s || (a.c.name < b.c.name ? -1 : 1));
  return [...pre, ...fuzzy.map((f) => f.c)];
}

// Busy-gate shared by the slash menu and the palette: /compact sets the
// pending flag for turn-end drain; /queue + /steer manage the running turn;
// /autoscroll, /thinking, and /theme only flip view flags (never touch the
// turn);
// /goal only flips session goal state (never touches the turn);
// /rename only renames the store record + title state (the later turn-end
// persist preserves the title, so it never races the turn).
// Every other command waits idle.
export function slashRunsWhileBusy(name: string): boolean {
  return (
    name === "/compact" ||
    name === "/queue" ||
    name === "/steer" ||
    name === "/autoscroll" ||
    name === "/thinking" ||
    name === "/theme" ||
    name === "/goal" ||
    name === "/rename"
  );
}

// Fuzzy subsequence match with gap/start/word-boundary scoring (lower is
// better; null = no match). Pure — shared by the command filter, the skill
// tier, and the palette, so there is exactly one matcher.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi]!, ti);
    if (found === -1) return null;
    score += last === -1 ? found : found - last - 1;
    if (found === 0 || /[-_/:]/.test(t[found - 1]!)) score -= 2;
    if (found === last + 1) score -= 1;
    last = found;
    ti = found + 1;
  }
  return score;
}

// Slash-menu item: a built-in command, or a skill surfaced as the namespaced
// `/skill:name` command (Claude-Code-style explicit invocation). `skill`
// carries the bare skill name for skill entries; commands leave it unset.
// Skill rows show the name only (no description — the menu stays scannable).
export type MenuItem = { name: string; description: string; skill?: string };

// Max skill rows in the menu: the command list always renders whole, skills
// narrow as you type — the menu can never take over the screen.
export const SLASH_MENU_SKILL_CAP = 8;

export type SkillPickerEntry = {
  name: string;
  userInvocable: boolean;
  source: string;
};

export type SlashMenu = { items: MenuItem[]; moreSkills: number };

// Pure filter for the /skill picker (unit-tested): case-insensitive
// substring over the skill name (a search popup narrows harder than the
// prefix-only slash menu). Empty query returns everything as-is.
export function filterSkillPicker(
  entries: SkillPickerEntry[],
  query: string,
): SkillPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

// Pure snapshot equality for the skill-menu cache (unit-tested): refreshes
// that discover nothing new must keep the previous array identity, or every
// mount//skills//clear//new refresh schedules a pointless App render.
export type SkillMenuEntry = { name: string; description: string };

export function sameSkillMenuSnapshot(
  a: SkillMenuEntry[],
  b: SkillMenuEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name || a[i]!.description !== b[i]!.description)
      return false;
  }
  return true;
}

// Pure menu builder (unit-tested): matching commands first (prefix tier in
// stable order, then fuzzy by score), then matching skills as `/skill:name`
// entries (prefix tier stable, then fuzzy). Skills join only once the query
// is non-trivial (input length ≥ 2 — a bare `/` lists commands only), and
// match by skill-name prefix, full `/skill:name` prefix, or fuzzy on the
// name. Skill rows carry a truncated description for discovery. Pure — the
// App feeds it the cached registry snapshot.
export const SKILL_MENU_DESC_CHARS = 60;

export function buildSlashMenu(
  input: string,
  skills: Array<{ name: string; description: string }>,
  extensions: Array<{ name: string; description: string }> = [],
): SlashMenu {
  const items: MenuItem[] = filterSlashCommands(input).map((c) => ({
    name: c.name,
    description: c.description,
  }));
  if (input.length < 2) return { items, moreSkills: 0 };
  // Extension slash commands (ticket 04): prefix tier in registration
  // order (registration order is deterministic), then fuzzy by score —
  // listed after builtins (exact dispatch routes builtins first, so an
  // extension never shadows) and before skills.
  const q = input.slice(1);
  const extPrefix: Array<{ name: string; description: string }> = [];
  const extFuzzy: {
    e: { name: string; description: string };
    score: number;
  }[] = [];
  for (const e of extensions) {
    const entry = `/${e.name}`;
    if (e.name.startsWith(q) || entry.startsWith(input)) {
      extPrefix.push(e);
      continue;
    }
    const score = fuzzyScore(q, e.name);
    if (score !== null) extFuzzy.push({ e, score });
  }
  extFuzzy.sort((a, b) => a.score - b.score || (a.e.name < b.e.name ? -1 : 1));
  for (const e of [...extPrefix, ...extFuzzy.map((f) => f.e)]) {
    const desc =
      e.description.length > SKILL_MENU_DESC_CHARS
        ? `${e.description.slice(0, SKILL_MENU_DESC_CHARS)}…`
        : e.description;
    items.push({ name: `/${e.name}`, description: desc });
  }
  const skillQ = q.startsWith("skill:") ? q.slice("skill:".length) : q;
  const pushSkill = (
    s: { name: string; description: string },
    shown: { n: number },
    more: { n: number },
  ) => {
    const entry = `/skill:${s.name}`;
    const desc =
      s.description.length > SKILL_MENU_DESC_CHARS
        ? `${s.description.slice(0, SKILL_MENU_DESC_CHARS)}…`
        : s.description;
    if (shown.n < SLASH_MENU_SKILL_CAP) {
      items.push({ name: entry, description: desc, skill: s.name });
      shown.n += 1;
    } else {
      more.n += 1;
    }
  };
  const shown = { n: 0 };
  const more = { n: 0 };
  const fuzzy: { s: { name: string; description: string }; score: number }[] =
    [];
  for (const s of skills) {
    const entry = `/skill:${s.name}`;
    if (s.name.startsWith(skillQ) || entry.startsWith(input)) continue;
    const score = fuzzyScore(skillQ, s.name);
    if (score !== null) fuzzy.push({ s, score });
  }
  for (const s of skills) {
    const entry = `/skill:${s.name}`;
    if (!s.name.startsWith(skillQ) && !entry.startsWith(input)) continue;
    pushSkill(s, shown, more);
  }
  fuzzy.sort((a, b) => a.score - b.score || (a.s.name < b.s.name ? -1 : 1));
  for (const f of fuzzy) pushSkill(f.s, shown, more);
  return { items, moreSkills: more.n };
}
