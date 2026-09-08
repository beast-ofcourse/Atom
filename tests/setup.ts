// Vitest global setup: isolate every test file in a fresh temp ATOM_HOME so
// tests never read/write the developer's real ~/.atom (auth.json,
// session.json). Runs once per test file. Individual tests may override
// process.env.ATOM_HOME further (e.g. per-test temp dirs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ATOM_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "atom-test-home-")
);
