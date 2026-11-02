// Install-footprint bench (Performance Gate v2, task 0A): compressed tarball
// size from a real `npm pack --pack-destination <tmp>` (dry-run JSON reports
// only raw file sizes, not gzipped bytes), plus a dist/ upload for unpacked
// bytes. The tarball is deleted immediately after stealing.
// Usage: node scripts/bench-footprint.mjs
// Prints one JSON line per case: {"case":"pack",...} and {"case":"dist",...}.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const fileSize = (full) => statSync(full).size;
const walkDir = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else if (entry.isFile()) out.push(fileSize(full));
  }
  return out;
};

// npm pack --json emits an array with files: [{path, size}], unpackedSize,
// filename (the tarball it wrote). npm on win32 is npm.cmd; Node ≥20.12
// refuses to spawn .cmd without a shell (EINVAL), so invoke the command as a
// shell string on all platforms.
function packJson(destination) {
  const raw = execFileSync(`npm pack --pack-destination "${destination}" --json`, {
    shell: true,
    windowsHide: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  const arr = JSON.parse(raw);
  const entry = Array.isArray(arr) ? arr[0] : arr;
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0 || typeof entry.filename !== "string") {
    throw new Error(
      `npm pack --json shape unexpected: topKeys=${Object.keys(entry ?? {}).join(",")}`,
    );
  }
  return entry;
}

const destination = mkdirSync(path.join(tmpdir(), "atom-pack-"), { recursive: true });
try {
  const pack = packJson(destination);
  const tarballPath = path.join(destination, pack.filename);
  const tarballBytes = statSync(tarballPath).size;
  const packFileBytes = pack.files.reduce((n, f) => n + (f.size ?? 0), 0);
  if (tarballBytes === 0 || packFileBytes === 0) {
    throw new Error("pack files present but sizes missing/0");
  }
  const unpackedSize = pack.unpackedSize ?? null;
  console.log(JSON.stringify({
    script: "bench-footprint",
    case: "pack",
    tarballBytes,
    packFileBytes,
    unpackedSize,
    fileCount: pack.files.length,
  }));

  const distFiles = walkDir(path.resolve("dist"));
  const distBytes = distFiles.reduce((n, b) => n + b, 0);
  console.log(JSON.stringify({
    script: "bench-footprint",
    case: "dist",
    distFiles: distFiles.length,
    distBytes,
  }));
} finally {
  rmSync(destination, { recursive: true, force: true });
}
