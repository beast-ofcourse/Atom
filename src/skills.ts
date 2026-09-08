// Skill discovery + registry (Claude-Code-style SKILL.md adoption).
//
// Scans the project and global skill directories for SKILL.md files,
// parses the frontmatter trigger contract (name/description), and renders
// the TUI listing. Levels and precedence (ticket 05), invocation (tickets
// 03/04), and tool grants (ticket 06) build on this registry.
//
// Node builtins only. Discovery never throws: per-skill failures come back
// as warning strings, and a missing skills directory is normal (silent).

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SkillSource = "project" | "global";

export type SkillInfo = {
  name: string;
  description: string;
  dir: string;
  source: SkillSource;
  // Invocation contract (frontmatter; Claude's documented forms accepted):
  // userInvocable=false hides the skill from manual /name invocation;
  // modelInvocable=false (disable-model-invocation) excludes it from the
  // auto-match; allowedTools are turn-scoped auto-approvals on invoke.
  userInvocable: boolean;
  modelInvocable: boolean;
  allowedTools: string[];
};

export type SkillDiscovery = {
  skills: SkillInfo[];
  warnings: string[];
};

// Split `---` frontmatter from the body. The opening marker must be the
// file's first line; a block that never closes is malformed (warned and
// skipped by discovery), not body.
function splitFrontmatter(text: string): { front: string | null; body: string; unclosed: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { front: null, body: text, unclosed: false };
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "---" || t === "...") {
      return { front: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n"), unclosed: false };
    }
  }
  return { front: null, body: text, unclosed: true };
}

// Minimal frontmatter reader: single-line `key: value` (matching quotes
// stripped) plus folded (`>`, `>-`) and literal (`|`, `|-`) continuations.
// Anything richer is out of scope — skill authors keep parsing simple.
function frontField(front: string, key: string): string | undefined {
  const lines = front.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m || m[1] !== key) continue;
    const rest = (m[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(rest)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const lj = lines[j]!;
        if (lj.trim() === "" || /^[ \t]/.test(lj)) block.push(lj.trim());
        else break;
      }
      while (block.length > 0 && block[0] === "") block.shift();
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      return rest[0] === ">" ? block.join(" ") : block.join("\n");
    }
    const q = /^(['"])(.*)\1$/.exec(rest);
    return q ? (q[2] ?? "") : rest;
  }
  return undefined;
}

function firstParagraph(body: string): string {
  const paras = body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    // Skip ATX headings: a bare "# Title" is a useless discovery string.
    .filter((p) => p.length > 0 && !/^#{1,6}\s/.test(p));
  return paras[0] ?? "";
}

// Boolean frontmatter in Claude's accepted forms (true/false plus
// yes/no/on/off/1/0, any case). Unrecognized values fall back to default.
function frontBool(front: string, key: string): boolean | undefined {
  const raw = frontField(front, key);
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return undefined;
}

// `allowed-tools` grants: space- and/or comma-separated tool names,
// lowercased and deduped. Unknown names are kept verbatim — the approval
// hook matches against real tool names, so junk grants match nothing.
export function parseAllowedTools(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim().toLowerCase();
    if (t.length > 0) seen.add(t);
  }
  return [...seen];
}

export async function discoverSkills(opts?: {
  projectDir?: string;
  homeDir?: string;
}): Promise<SkillDiscovery> {
  const projectDir = opts?.projectDir ?? process.cwd();
  const homeDir = opts?.homeDir ?? os.homedir();
  const skills: SkillInfo[] = [];
  const warnings: string[] = [];
  const seenBases = new Set<string>();
  const roots: Array<{ base: string; source: SkillSource }> = [
    { base: path.join(projectDir, ".claude", "skills"), source: "project" },
    { base: path.join(homeDir, ".claude", "skills"), source: "global" },
  ];
  for (const { base, source } of roots) {
    const resolved = path.resolve(base);
    if (seenBases.has(resolved)) continue; // e.g. repo rooted at $HOME
    seenBases.add(resolved);
    let entries;
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue; // no skills installed here — normal, silent
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of dirs) {
      const dir = path.join(base, e.name);
      let text: string;
      try {
        text = await fsp.readFile(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        warnings.push(`skill "${e.name}" (${source}): cannot read SKILL.md — skipped`);
        continue;
      }
      const { front, body, unclosed } = splitFrontmatter(text);
      if (unclosed) {
        warnings.push(`skill "${e.name}" (${source}): unclosed frontmatter — skipped`);
        continue;
      }
      const fmName = front ? frontField(front, "name") : undefined;
      const fmDesc = front ? frontField(front, "description") : undefined;
      const name = fmName && fmName.length > 0 ? fmName : e.name;
      const description = fmDesc && fmDesc.length > 0 ? fmDesc : firstParagraph(body);
      if (!description) {
        warnings.push(`skill "${name}" (${source}): no description and empty body — skipped`);
        continue;
      }
      const noModel = front ? frontBool(front, "disable-model-invocation") : undefined;
      const userOnly = front ? frontBool(front, "user-invocable") : undefined;
      skills.push({
        name,
        description,
        dir,
        source,
        userInvocable: userOnly ?? true,
        modelInvocable: !(noModel ?? false),
        allowedTools: front ? parseAllowedTools(frontField(front, "allowed-tools")) : [],
      });
    }
  }
  return { skills, warnings };
}

// One-shot TUI listing for /skills. Name clashes resolve with personal
// (global) winning (resolveSkills); model-only skills show with an
// [auto-only] tag instead of hiding — discoverable, but not invocable.
// The header always renders so the command is self-explanatory when empty;
// warnings ride along visibly.
export async function skillsListText(projectDir?: string, homeDir?: string): Promise<string> {
  const found = await discoverSkills({ projectDir, homeDir });
  const { skills, notes } = resolveSkills(found.skills);
  const out: string[] = [skills.length === 1 ? "Skills (1):" : `Skills (${skills.length}):`];
  for (const s of skills) {
    out.push(`/${s.name} — ${s.description} [${s.source}]${s.userInvocable ? "" : " [auto-only]"}`);
  }
  for (const n of notes) out.push(`note: ${n}`);
  for (const w of found.warnings) out.push(`⚠ ${w}`);
  if (skills.length === 0 && found.warnings.length === 0) {
    out.push("(no skills installed — add SKILL.md skills under .claude/skills/ or ~/.claude/skills/)");
  }
  return out.join("\n");
}

export type LoadedSkill = {
  info: SkillInfo;
  // SKILL.md body plus any referenced support files, ready to inject.
  text: string;
  // references/<…> + scripts/<…> paths that were inlined, in mention order.
  included: string[];
};

const SKILL_FILE_CAP = 8 * 1024;
const SKILL_INCLUDE_MAX = 3;

// references/<path> + scripts/<path> mentions inside the skill body.
const SKILL_MENTION_RE = /\b(references|scripts)\/[A-Za-z0-9_.\-/@]+/g;

// Load a skill's body plus the support files its body references (on
// demand, capped — never the whole directory). Mentioned-but-missing files
// are skipped silently; path escapes outside the skill dir are dropped.
// Never throws: an unreadable SKILL.md yields empty text.
export async function loadSkillBody(skill: SkillInfo): Promise<LoadedSkill> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(skill.dir, "SKILL.md"), "utf8");
  } catch {
    return { info: skill, text: "", included: [] };
  }
  const { body } = splitFrontmatter(raw);
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const m of body.match(SKILL_MENTION_RE) ?? []) {
    if (!seen.has(m)) {
      seen.add(m);
      mentions.push(m);
    }
  }
  const included: string[] = [];
  const parts: string[] = [];
  for (const rel of mentions.slice(0, SKILL_INCLUDE_MAX)) {
    const abs = path.resolve(skill.dir, rel);
    if (abs !== skill.dir && !abs.startsWith(skill.dir + path.sep)) continue; // traversal guard
    let content: string;
    try {
      content = await fsp.readFile(abs, "utf8");
    } catch {
      continue; // dangling mention — the body already stands alone
    }
    included.push(rel);
    const capped =
      content.length > SKILL_FILE_CAP
        ? content.slice(0, SKILL_FILE_CAP) + `\n[truncated: ${rel} exceeded 8KB]`
        : content;
    parts.push(`--- ${rel} (referenced above, inlined) ---\n${capped}`);
  }
  return { info: skill, text: parts.length > 0 ? `${body}\n\n${parts.join("\n\n")}` : body, included };
}

const MATCH_STOPWORDS = new Set(
  "a,an,the,and,or,for,with,from,that,this,these,those,into,onto,over,under,about,using,use,used,your,you,how,what,when,where,which,who,will,can,not,but,are,was,were,has,have,had,its,their,them,they,then,than,also,just,like,more,most,such,via,per,within,without,between".split(
    ","
  )
);

function contentWords(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !MATCH_STOPWORDS.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

// Deterministic description match for auto-invoke: distinct
// name+description words (len ≥ 3, stopwords dropped) hitting the
// message as substrings, at least minHits (default 2), best score first,
// capped at max (default 2) skills per turn. Skills with
// disable-model-invocation never match. Pure function — no I/O.
export function matchSkills(
  message: string,
  skills: SkillInfo[],
  opts?: { max?: number; minHits?: number }
): SkillInfo[] {
  const max = opts?.max ?? 2;
  const minHits = opts?.minHits ?? 2;
  const text = message.toLowerCase();
  const scored: Array<{ s: SkillInfo; hits: number }> = [];
  for (const s of skills) {
    if (!s.modelInvocable) continue;
    let hits = 0;
    for (const w of contentWords(`${s.name} ${s.description}`)) {
      if (text.includes(w)) hits += 1;
    }
    if (hits >= minHits) scored.push({ s, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || (a.s.name < b.s.name ? -1 : a.s.name > b.s.name ? 1 : 0));
  return scored.slice(0, Math.max(0, max)).map((e) => e.s);
}

// Level precedence (Claude rule): personal (global) wins over project on
// exact-name clashes, with a visible note of which one won. Same-level
// duplicates keep the first with a note. Pure function — no I/O.
// No cache anywhere in this module by design: every call re-scans disk,
// so adding/editing/removing skills takes effect without restarting.
export function resolveSkills(skills: SkillInfo[]): { skills: SkillInfo[]; notes: string[] } {
  const byName = new Map<string, SkillInfo>();
  const order: string[] = [];
  const notes: string[] = [];
  for (const s of skills) {
    const prev = byName.get(s.name);
    if (!prev) {
      byName.set(s.name, s);
      order.push(s.name);
      continue;
    }
    if (prev.source === s.source) {
      notes.push(`skill "${s.name}": duplicate ${s.source} entry ignored (${s.dir})`);
      continue;
    }
    const winner = s.source === "global" ? s : prev;
    const loser = s.source === "global" ? prev : s;
    byName.set(s.name, winner);
    notes.push(`skill "${s.name}": ${winner.source} wins over ${loser.source}`);
  }
  return { skills: order.map((n) => byName.get(n) as SkillInfo), notes };
}
