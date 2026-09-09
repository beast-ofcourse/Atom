// SkillRegistry tests: cached metadata with per-entry mtime+size
// invalidation. Fixtures live in fresh temp dirs (never the repo, never
// $HOME). Times are forced via utimes where determinism matters.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createSkillRegistry,
  discoverSkills,
  loadSkillBody,
} from "../src/skills.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-skill-reg-"));
  dirs.push(d);
  return d;
}

async function writeSkill(
  root: string,
  sub: ".claude" | ".agents",
  name: string,
  body: string
): Promise<string> {
  const dir = path.join(root, sub, "skills", name);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fsp.writeFile(file, body, "utf8");
  return file;
}

async function touch(file: string, atMs: number): Promise<void> {
  const d = new Date(atMs);
  await fsp.utimes(file, d, d);
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("initial + cached discovery", () => {
  test("first refresh matches discoverSkills exactly", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, ".claude", "deploy", `---\ndescription: Ship it.\n---\n\nBody.\n`);
    await writeSkill(home, ".agents", "lint", `---\ndescription: Lint all.\n---\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    // Empty snapshot before any refresh (no I/O).
    expect(reg.snapshot()).toEqual({ skills: [], warnings: [] });
    const first = await reg.refresh();
    const fresh = await discoverSkills({ projectDir: project, homeDir: home });
    expect(first.skills).toEqual(fresh.skills);
    expect(first.warnings).toEqual(fresh.warnings);
    expect(first.stats.added).toBe(2);
    expect(first.stats.reused).toBe(0);
    expect(first.stats.reloaded).toBe(0);
    expect(first.stats.removed).toBe(0);
  });

  test("unchanged refresh reuses everything (no re-reads)", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, ".claude", "deploy", `---\ndescription: Ship it.\n---\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    await reg.refresh();
    const second = await reg.refresh();
    expect(second.stats.reused).toBe(1);
    expect(second.stats.reloaded).toBe(0);
    expect(second.stats.added).toBe(0);
    expect(second.stats.removed).toBe(0);
    expect(second.skills).toEqual((await reg.refresh()).skills);
    expect(reg.snapshot().skills).toHaveLength(1);
  });
});

describe("invalidation", () => {
  test("modified skill reloads only itself", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const file = await writeSkill(project, ".claude", "deploy", `---\ndescription: Ship it.\n---\n\nBody.\n`);
    await writeSkill(project, ".claude", "steady", `---\ndescription: Steady.\n---\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    await reg.refresh();
    // Rewrite with a different size AND a forced newer mtime (deterministic).
    await fsp.writeFile(file, `---\ndescription: Ship it to production now.\n---\n\nBody.\n`, "utf8");
    await touch(file, Date.now() + 60_000);
    const next = await reg.refresh();
    expect(next.skills.find((s) => s.name === "deploy")?.description).toBe(
      "Ship it to production now."
    );
    expect(next.stats.reloaded).toBe(1);
    expect(next.stats.reused).toBe(1);
  });

  test("mtime-only change (same size) still reloads", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const file = await writeSkill(project, ".claude", "w", `---\ndescription: W works well.\n---\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    await reg.refresh();
    // Same byte length, forced newer mtime.
    await fsp.writeFile(file, `---\ndescription: W works well!\n---\n\nBody.\n`, "utf8");
    await touch(file, Date.now() + 60_000);
    const next = await reg.refresh();
    expect(next.skills.find((s) => s.name === "w")?.description).toBe("W works well!");
    expect(next.stats.reloaded).toBe(1);
    expect(next.stats.reused).toBe(0);
  });

  test("added skill appears; deleted skill (and its warning) disappears", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    const empty = await reg.refresh();
    expect(empty.skills).toEqual([]);
    await writeSkill(project, ".agents", "late", `---\ndescription: Arrived late.\n---\n\nBody.\n`);
    const added = await reg.refresh();
    expect(added.skills.map((s) => s.name)).toEqual(["late"]);
    expect(added.stats.added).toBe(1);
    await fsp.rm(path.join(project, ".agents", "skills", "late"), { recursive: true, force: true });
    const removed = await reg.refresh();
    expect(removed.skills).toEqual([]);
    expect(removed.stats.removed).toBe(1);
  });

  test("vanished root drops silently; other roots intact", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, ".claude", "keep", `---\ndescription: Keep me.\n---\n\nBody.\n`);
    await writeSkill(project, ".agents", "drop", `---\ndescription: Drop me.\n---\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    expect((await reg.refresh()).skills.map((s) => s.name).sort()).toEqual(["drop", "keep"]);
    await fsp.rm(path.join(project, ".agents", "skills"), { recursive: true, force: true });
    const next = await reg.refresh();
    expect(next.skills.map((s) => s.name)).toEqual(["keep"]);
    expect(next.warnings).toEqual([]);
  });
});

describe("malformed skills", () => {
  test("unclosed frontmatter warns, replays from cache, clears on fix", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const file = await writeSkill(project, ".claude", "open", `---\ndescription: never closed\n\nBody.\n`);
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    const first = await reg.refresh();
    expect(first.skills).toEqual([]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("unclosed frontmatter");
    // Unchanged: same warning replayed, entry reused (no re-parse needed).
    const second = await reg.refresh();
    expect(second.warnings).toEqual(first.warnings);
    expect(second.stats.reused).toBe(1);
    expect(second.stats.reloaded).toBe(0);
    // Fixed file: warning clears, skill appears.
    await fsp.writeFile(file, `---\ndescription: Now valid.\n---\n\nBody here.\n`, "utf8");
    await touch(file, Date.now() + 60_000);
    const fixed = await reg.refresh();
    expect(fixed.warnings).toEqual([]);
    expect(fixed.skills.map((s) => s.name)).toEqual(["open"]);
    expect(fixed.stats.reloaded).toBe(1);
  });

  test("missing SKILL.md warns; appearing file is parsed (never stuck)", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    const dir = path.join(project, ".claude", "skills", "broken");
    await fsp.mkdir(dir, { recursive: true });
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    const first = await reg.refresh();
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("cannot read SKILL.md");
    const second = await reg.refresh();
    expect(second.warnings).toEqual(first.warnings);
    await fsp.writeFile(path.join(dir, "SKILL.md"), `---\ndescription: Healed.\n---\n\nBody.\n`, "utf8");
    const healed = await reg.refresh();
    expect(healed.warnings).toEqual([]);
    expect(healed.skills.map((s) => s.name)).toEqual(["broken"]);
  });
});

describe("lazy bodies stay lazy", () => {
  test("refresh output never contains body text; loadSkillBody loads on demand", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(
      project,
      ".claude",
      "doc",
      `---\ndescription: Doc helper.\n---\n\nBODYMARKER-SECRET-XYZ and references/api.md details.\n`
    );
    await fsp.mkdir(path.join(project, ".claude", "skills", "doc", "references"), { recursive: true });
    await fsp.writeFile(
      path.join(project, ".claude", "skills", "doc", "references", "api.md"),
      "REFMARKER-SECRET-XYZ",
      "utf8"
    );
    const reg = createSkillRegistry({ projectDir: project, homeDir: home });
    const found = await reg.refresh();
    // Metadata only: neither the body marker nor the reference content leaks.
    expect(JSON.stringify(found)).not.toContain("BODYMARKER-SECRET-XYZ");
    expect(JSON.stringify(found)).not.toContain("REFMARKER-SECRET-XYZ");
    // On demand: full body plus inlined references, as before.
    const loaded = await loadSkillBody(found.skills[0]!);
    expect(loaded.text).toContain("BODYMARKER-SECRET-XYZ");
    expect(loaded.text).toContain("REFMARKER-SECRET-XYZ");
    expect(loaded.included).toEqual(["references/api.md"]);
  });
});
