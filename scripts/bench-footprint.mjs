// Install-footprint bench (Performance Gate v2, task 0A): tarball size from
// `npm pack --dry-run --json` plus unpacked bytes from a dist/ walk.
// Usage: node scripts/bench-footprint.mjs
// Prints one JSON line per case: {"case":"pack",...} and {"case":"dist",...}.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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

// npm pack --json emits an array with files: [{path, size}], unpackedSize.
function packJson() {
  // npm on win32 is npm.cmd; Node ≥20.12 refuses to spawn .cmd without a
  // shell (EINVAL), so invoke the command as a shell string on all platforms.
  const raw = execFileSync("npm pack --dry-run --json", {
    shell: true,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  const arr = JSON.parse(raw);
  const entry = Array.isArray(arr) ? arr[0] : arr;
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error(
      `npm pack --json shape unexpected: topKeys=${Object.keys(entry ?? {}).join(",")}`,
    );
  }
  return entry;
}

const pack = packJson();
const tarballBytes = pack.files.reduce((n, f) => n + (f.size ?? 0), 0);
if (tarballBytes === 0) {
  throw new Error("pack files present but every size missing/0");
}
console.log(JSON.stringify({
  script: "bench-footprint",
  case: "pack",
  tarballBytes,
  unpackedSize: pack.unpackedSize ?? null,
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
