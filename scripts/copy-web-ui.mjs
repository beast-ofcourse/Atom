// Copy the WebUI static assets (src/web/ui/) into the compiled output
// (dist/web/ui/) so the served frontend ships with the package. The server
// (src/web/server.ts) serves them adjacent to the compiled module; under
// tsx/vitest it serves the src tree directly, so this step only matters for
// `npm run build` output. No dependencies, fails loudly on missing sources.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, "src", "web", "ui");
const outDir = path.join(root, "dist", "web", "ui");
const FILES = ["index.html", "app.js", "styles.css"];

mkdirSync(outDir, { recursive: true });
for (const file of FILES) {
  const src = path.join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`copy-web-ui: missing source ${src}`);
    process.exit(1);
  }
  copyFileSync(src, path.join(outDir, file));
}
console.log(`copy-web-ui: ${FILES.length} files → ${outDir}`);
