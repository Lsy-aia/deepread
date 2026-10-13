// Packages addon/ into build/deepread-<version>.xpi (contents of addon/ at the zip root).
// Requires the system `zip` CLI. Run with: npm run build
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = join(root, "addon");
const manifestPath = join(addonDir, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`build: missing ${manifestPath}`);

const { version } = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!version) throw new Error("build: addon/manifest.json has no version");

const buildDir = join(root, "build");
const outPath = join(buildDir, `deepread-${version}.xpi`);
mkdirSync(buildDir, { recursive: true });
// zip updates existing archives in place; start from scratch so no stale entries survive.
rmSync(outPath, { force: true });

// Run zip from inside addon/ so entries are stored relative to it (manifest.json at root).
execFileSync("zip", ["-r", "-X", "-q", outPath, ".", "-x", "*.DS_Store"], {
  cwd: addonDir,
  stdio: "inherit",
});

const size = statSync(outPath).size;
console.log(`built ${outPath}`);
console.log(`size ${size} bytes (${(size / 1024).toFixed(1)} KiB)`);
