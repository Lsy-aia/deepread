// Copies the browser builds of vendored front-end libraries from node_modules
// into addon/content/lib/. Idempotent: target folders are cleaned first.
// Run with: npm run vendor
import { cpSync, copyFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const lib = (...p) => join(root, "addon", "content", "lib", ...p);

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`vendor: missing ${path} (did you run npm install?)`);
  return path;
}

function copyInto(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(requireFile(src), dest);
  console.log(`  ${src.slice(root.length + 1)} -> ${dest.slice(root.length + 1)}`);
}

// ---- marked (MIT): UMD build defines the global `marked` when run as a classic script.
const markedDir = lib("marked");
rmSync(markedDir, { recursive: true, force: true });
console.log("marked:");
copyInto(nm("marked", "lib", "marked.umd.js"), join(markedDir, "marked.js"));
copyInto(nm("marked", "LICENSE"), join(markedDir, "LICENSE"));

// ---- KaTeX (MIT): core JS/CSS, auto-render contrib, and woff2 fonts only.
const katexDir = lib("katex");
rmSync(katexDir, { recursive: true, force: true });
console.log("katex:");
const katexDist = nm("katex", "dist");
copyInto(join(katexDist, "katex.min.js"), join(katexDir, "katex.min.js"));
copyInto(join(katexDist, "katex.min.css"), join(katexDir, "katex.min.css"));
copyInto(join(katexDist, "contrib", "auto-render.min.js"), join(katexDir, "auto-render.min.js"));
const fontsSrc = join(katexDist, "fonts");
const fontsDest = join(katexDir, "fonts");
mkdirSync(fontsDest, { recursive: true });
const woff2 = readdirSync(requireFile(fontsSrc)).filter((f) => f.endsWith(".woff2"));
if (woff2.length === 0) throw new Error("vendor: no .woff2 fonts found in katex dist");
for (const f of woff2) copyFileSync(join(fontsSrc, f), join(fontsDest, f));
console.log(`  dist/fonts/*.woff2 (${woff2.length} files) -> ${fontsDest.slice(root.length + 1)}`);
copyInto(nm("katex", "LICENSE"), join(katexDir, "LICENSE"));

// ---- pdf-lib + @pdf-lib/fontkit (MIT): UMD builds define globals PDFLib / fontkit.
const pdfDir = lib("pdf-lib");
rmSync(pdfDir, { recursive: true, force: true });
console.log("pdf-lib:");
copyInto(nm("pdf-lib", "dist", "pdf-lib.min.js"), join(pdfDir, "pdf-lib.min.js"));
copyInto(nm("pdf-lib", "LICENSE.md"), join(pdfDir, "LICENSE-pdf-lib"));
copyInto(nm("@pdf-lib", "fontkit", "dist", "fontkit.umd.min.js"), join(pdfDir, "fontkit.umd.min.js"));
// @pdf-lib/fontkit ships no LICENSE file (package.json: MIT, fork of fontkit by Devon Govett); write the MIT text.
writeFileSync(join(pdfDir, "LICENSE-fontkit"), `MIT License

Copyright (c) 2014-present Devon Govett (fontkit) and Andrew Dillon, Hopding (@pdf-lib/fontkit fork)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`);

console.log("vendor: done");
