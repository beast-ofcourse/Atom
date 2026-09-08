// Build-output test: `npm run build` emits runnable dist with the shebang
// intact, and `node dist/cli.js --help` works (no TTY needed for --help).
// Builds first when dist is missing so a fresh clone stays green.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";

const distCli = path.resolve(process.cwd(), "dist", "cli.js");

function ensureBuilt(): void {
  if (existsSync(distCli)) return;
  execSync("npm run build", {
    cwd: process.cwd(),
    timeout: 180000,
    stdio: "pipe",
  });
}

describe("build output", () => {
  test("dist/cli.js exists with shebang and --help works", () => {
    ensureBuilt();
    expect(existsSync(distCli)).toBe(true);
    const firstLine =
      readFileSync(distCli, "utf8").split("\n", 1)[0] ?? "";
    expect(firstLine.trim()).toBe("#!/usr/bin/env node");
    const out = execFileSync(process.execPath, [distCli, "--help"], {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(out).toContain("Atom chatbot");
  }, 180000);
});
