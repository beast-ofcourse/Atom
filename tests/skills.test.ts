// Skill discovery + registry tests. Fixtures live in fresh temp dirs (never
// the repo, never $HOME): projectDir and homeDir are always injected, so a
// machine with real ~/.claude/skills can never leak into assertions.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AUTO_SKILL_BODY_CAP, capSkillBodyForAuto, discoverSkills, loadSkillBody, matchSkills, parseAllowedTools, resolveSkills, skillsListText } from "../src/skills.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-skills-"));
  dirs.push(d);
  return d;
}

async function writeSkill(root: string, name: string, body: string): Promise<string> {
  const dir = path.join(root, ".claude", "skills", name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

async function writeAgentSkill(root: string, name: string, body: string): Promise<string> {
  const dir = path.join(root, ".agents", "skills", name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("discoverSkills", () => {
  test("finds project + global skills with frontmatter name/description", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const projDir = await writeSkill(
      project,
      "deploy",
      `---\ndescription: Ship it to prod.\n---\n\n# Deploy\n\nRun the steps.\n`
    );
    await writeSkill(
      home,
      "review",
      `---\nname: reviewer\ndescription: Review code.\n---\n\nBody.\n`
    );
    const { skills, warnings } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(warnings).toEqual([]);
    expect(skills).toEqual([
      {
        name: "deploy",
        description: "Ship it to prod.",
        dir: projDir,
        source: "project",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
      },
      {
        name: "reviewer",
        description: "Review code.",
        dir: path.join(home, ".claude", "skills", "review"),
        source: "global",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
      },
    ]);
  });

  test("folded + quoted frontmatter values", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(
      project,
      "long",
      `---\ndescription: >-\n  First line\n  second line\n---\n\nBody.\n`
    );
    await writeSkill(home, "q", `---\ndescription: 'Do: things, now.'\n---\n\nBody.\n`);
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills.map((s) => s.description)).toEqual(["First line second line", "Do: things, now."]);
  });

  test("body-only files default name to dir, description to first paragraph", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "plain", `# Plain skill\n\nDoes plain things well.\n\nMore detail.\n`);
    const { skills, warnings } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(warnings).toEqual([]);
    expect(skills).toEqual([
      {
        name: "plain",
        description: "Does plain things well.",
        dir: path.join(project, ".claude", "skills", "plain"),
        source: "project",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
      },
    ]);
  });

  test("unclosed frontmatter is malformed: warned and skipped", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "open", `---\ndescription: never closed\n\nReal first para.\n`);
    const { skills, warnings } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"open"');
    expect(warnings[0]).toContain("unclosed frontmatter");
  });

  test("missing SKILL.md warns; empty skill warns; missing dirs are silent", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await fsp.mkdir(path.join(project, ".claude", "skills", "broken"), { recursive: true });
    await writeSkill(project, "empty", `---\nname: empty\n---\n`);
    const { skills, warnings } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"broken"');
    expect(warnings[0]).toContain("cannot read SKILL.md");
    expect(warnings[1]).toContain('"empty"');
    // home has no skills dir at all: silent, no warning.
    expect(warnings.every((w) => !w.includes("(global)"))).toBe(true);
  });

  test("non-directory entries ignored; same base scanned once", async () => {
    const project = await tmpDir();
    await writeSkill(project, "a", `---\ndescription: A.\n---\n\nBody.\n`);
    await fsp.writeFile(path.join(project, ".claude", "skills", "stray.md"), "# stray", "utf8");
    const once = await discoverSkills({ projectDir: project, homeDir: project });
    expect(once.skills).toHaveLength(1);
    expect(once.skills[0]?.source).toBe("project");
  });

  test("finds .agents/skills at project + global levels (skills.sh installs)", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const projDir = await writeAgentSkill(
      project,
      "ship",
      `---\ndescription: Ship it via agents.\n---\n\nBody.\n`
    );
    await writeAgentSkill(
      home,
      "lint",
      `---\ndescription: Lint everything.\n---\n\nBody.\n`
    );
    const { skills, warnings } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(warnings).toEqual([]);
    expect(skills).toEqual([
      {
        name: "ship",
        description: "Ship it via agents.",
        dir: projDir,
        source: "project",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
      },
      {
        name: "lint",
        description: "Lint everything.",
        dir: path.join(home, ".agents", "skills", "lint"),
        source: "global",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
      },
    ]);
  });

  test("same-level .claude copy wins over .agents duplicate", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "dup", `---\ndescription: Claude copy.\n---\n\nBody.\n`);
    await writeAgentSkill(project, "dup", `---\ndescription: Agents copy.\n---\n\nBody.\n`);
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills).toHaveLength(2);
    const { skills: resolved, notes } = resolveSkills(skills);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.description).toBe("Claude copy.");
    expect(notes.join("\n")).toContain('"dup"');
  });
});

describe("skillsListText", () => {
  test("header, rows with source, warnings ride along", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "deploy", `---\ndescription: Ship it.\n---\n\nBody.\n`);
    await fsp.mkdir(path.join(project, ".claude", "skills", "broken"), { recursive: true });
    const out = await skillsListText(project, home);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Skills (1):");
    expect(lines[1]).toBe("/skill:deploy [project]");
    expect(lines[2]).toContain("⚠");
    expect(lines[2]).toContain('"broken"');
  });

  test("empty registry explains itself", async () => {
    const out = await skillsListText(await tmpDir(), await tmpDir());
    expect(out.split("\n")[0]).toBe("Skills (0):");
    expect(out).toContain(".claude/skills/");
  });

  test("model-only skills show with an [auto-only] tag", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "bg", `---\ndescription: Background lore.\nuser-invocable: false\n---\n\nLore.\n`);
    const out = await skillsListText(project, home);
    expect(out.split("\n")[1]).toBe("/skill:bg [project] [auto-only]");
  });
});

describe("invocation contract fields", () => {
  test("user-invocable / disable-model-invocation / allowed-tools parse", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(
      project,
      "ops",
      `---\ndescription: Ops stuff.\ndisable-model-invocation: yes\nallowed-tools: Read, Grep read\n---\n\nBody.\n`
    );
    await writeSkill(home, "quiet", `---\ndescription: Quiet lore.\nuser-invocable: no\n---\n\nBody.\n`);
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: "ops",
      userInvocable: true,
      modelInvocable: false,
      allowedTools: ["read", "grep"],
    });
    expect(skills[1]).toMatchObject({ name: "quiet", userInvocable: false, modelInvocable: true });
  });

  test("unrecognized booleans fall back to defaults", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "w", `---\ndescription: W.\nuser-invocable: maybe\n---\n\nBody.\n`);
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    expect(skills[0]).toMatchObject({ userInvocable: true, modelInvocable: true, allowedTools: [] });
  });

  test("parseAllowedTools splits on spaces and commas, dedupes", async () => {
    expect(parseAllowedTools(undefined)).toEqual([]);
    expect(parseAllowedTools("Read, Grep read  Bash,,")).toEqual(["read", "grep", "bash"]);
  });
});

describe("loadSkillBody", () => {
  test("inlines mentioned references, skips missing, guards traversal", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const dir = path.join(project, ".claude", "skills", "doc");
    await fsp.mkdir(path.join(dir, "references"), { recursive: true });
    await fsp.writeFile(
      path.join(dir, "SKILL.md"),
      `---\ndescription: Doc helper.\n---\n\nSee references/api.md and references/gone.md for details.\n`,
      "utf8"
    );
    await fsp.writeFile(path.join(dir, "references", "api.md"), "# API\n\nEndpoints.\n", "utf8");
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    const loaded = await loadSkillBody(skills[0]!);
    expect(loaded.included).toEqual(["references/api.md"]);
    expect(loaded.text).toContain("See references/api.md");
    expect(loaded.text).toContain("# API");
    // traversal mention is dropped, never read outside the skill dir
    await fsp.writeFile(
      path.join(dir, "SKILL.md"),
      `---\ndescription: Doc helper.\n---\n\nSee references/../../outside.md.\n`,
      "utf8"
    );
    const again = await loadSkillBody(skills[0]!);
    expect(again.included).toEqual([]);
  });

  test("loadSkillBody tiers: references inline by default, body-only on demand", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const dir = path.join(project, ".claude", "skills", "doc");
    await fsp.mkdir(path.join(dir, "references"), { recursive: true });
    await fsp.writeFile(
      path.join(dir, "SKILL.md"),
      `---\ndescription: Doc helper.\n---\n\nSee references/api.md for details.\n`,
      "utf8"
    );
    await fsp.writeFile(path.join(dir, "references", "api.md"), "# API\n\nEndpoints.\n", "utf8");
    const { skills } = await discoverSkills({ projectDir: project, homeDir: home });
    const full = await loadSkillBody(skills[0]!);
    expect(full.included).toEqual(["references/api.md"]);
    expect(full.text).toContain("# API");
    const tier2 = await loadSkillBody(skills[0]!, { inlineRefs: false });
    expect(tier2.included).toEqual([]);
    expect(tier2.text).toContain("See references/api.md");
    expect(tier2.text).not.toContain("# API");
  });

  test("capSkillBodyForAuto truncates huge bodies with a read pointer", async () => {
    const short = "x".repeat(100);
    expect(capSkillBodyForAuto(short, "/s/dir")).toBe(short);
    const huge = "y".repeat(AUTO_SKILL_BODY_CAP + 500);
    const capped = capSkillBodyForAuto(huge, "/s/dir");
    expect(capped.length).toBeLessThan(huge.length);
    expect(capped).toContain("[truncated: auto-loaded skill body exceeded 12KB");
    expect(capped).toContain("/s/dir/SKILL.md");
  });

  test("unreadable SKILL.md yields empty text, never throws", async () => {
    const loaded = await loadSkillBody({
      name: "ghost",
      description: "Ghost.",
      dir: path.join(await tmpDir(), "nope"),
      source: "project",
      userInvocable: true,
      modelInvocable: true,
      allowedTools: [],
    });
    expect(loaded).toEqual({
      info: expect.objectContaining({ name: "ghost" }),
      text: "",
      included: [],
    });
  });
});

describe("matchSkills", () => {
  function info(over: Record<string, unknown> = {}) {
    return {
      name: "x",
      description: "does things",
      dir: "/tmp/x",
      source: "project",
      userInvocable: true,
      modelInvocable: true,
      allowedTools: [],
      ...over,
    } as never;
  }

  test("wholeWords kills substring false positives", async () => {
    function info(over: Record<string, unknown> = {}) {
      return {
        name: "x",
        description: "does things",
        dir: "/tmp/x",
        source: "project",
        userInvocable: true,
        modelInvocable: true,
        allowedTools: [],
        ...over,
      } as never;
    }
    const tester = info({ name: "test-suite", description: "Run checks" });
    // Substring mode: "test"⊂"latest" and "suite"⊂"suites" → 2 hits → match.
    expect(matchSkills("read the latest news suites", [tester], { minHits: 2 }).map((s) => (s as { name: string }).name)).toEqual([
      "test-suite",
    ]);
    // Whole-word mode: neither "latest" nor "suites" is the word → no match.
    expect(matchSkills("read the latest news suites", [tester], { minHits: 2, wholeWords: true })).toEqual([]);
    // Whole-word mode still matches real words (name + desc hits).
    expect(
      matchSkills("run the test suite now", [tester], { minHits: 2, wholeWords: true }).map(
        (s) => (s as { name: string }).name
      )
    ).toEqual(["test-suite"]);
  });

  test("threshold, ordering, cap, and model-invocation gate", async () => {
    const a = info({ name: "deploy", description: "Ship the app to production servers" });
    const b = info({ name: "review", description: "Review code for production readiness" });
    const quiet = info({ name: "lore", description: "Ship lore", modelInvocable: false });
    // "production" alone is one hit — below the default threshold of 2.
    expect(matchSkills("fix production bug", [a, b, quiet])).toEqual([]);
    // two distinct hits match; best score first; cap respected.
    const both = matchSkills("ship the app to production for review", [a, b, quiet]);
    expect(both.map((s) => (s as { name: string }).name)).toEqual(["deploy", "review"]);
    const capped = matchSkills("ship the app to production for review", [a, b, quiet], { max: 1 });
    expect(capped).toHaveLength(1);
    // model-invocation-off skills never match, however relevant.
    expect(matchSkills("ship lore everywhere", [quiet])).toEqual([]);
  });
});

describe("resolveSkills", () => {
  function info(over: Record<string, unknown> = {}) {
    return {
      name: "x",
      description: "d",
      dir: "/tmp/x",
      source: "project",
      userInvocable: true,
      modelInvocable: true,
      allowedTools: [],
      ...over,
    } as never;
  }

  test("global wins over project with a visible note; order kept", async () => {
    const proj = info({ name: "deploy", description: "old", dir: "/p/deploy", source: "project" });
    const glob = info({ name: "deploy", description: "new", dir: "/g/deploy", source: "global" });
    const other = info({ name: "aaa", description: "first", dir: "/p/aaa", source: "project" });
    const { skills, notes } = resolveSkills([proj, other, glob] as never);
    expect(skills.map((s) => (s as { name: string }).name)).toEqual(["deploy", "aaa"]);
    expect((skills[0] as { description: string }).description).toBe("new");
    expect(notes).toEqual(['skill "deploy": global wins over project']);
  });

  test("disk changes are visible on rescan without restarting", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    expect((await discoverSkills({ projectDir: project, homeDir: home })).skills).toEqual([]);
    await writeSkill(project, "late", `---\ndescription: Arrived late.\n---\n\nBody.\n`);
    const after = await discoverSkills({ projectDir: project, homeDir: home });
    expect(after.skills.map((s) => s.name)).toEqual(["late"]);
    await fsp.rm(path.join(project, ".claude", "skills", "late"), { recursive: true, force: true });
    expect((await discoverSkills({ projectDir: project, homeDir: home })).skills).toEqual([]);
  });
});
