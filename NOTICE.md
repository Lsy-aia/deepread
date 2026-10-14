# NOTICE

## DeepRead

DeepRead is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).

DeepRead is built on [Zotero](https://www.zotero.org/) (AGPL-3.0-or-later, Corporation for Digital Scholarship).

DeepRead contains code ported from **Vibero**, an AGPL-3.0 fork of Zotero, by its respective authors. Ported sections keep a
header note `Ported from Vibero (AGPL-3.0, a Zotero fork)`. DeepRead does not use Vibero's name, logo, or services, and
does not call any Vibero or Supabase endpoints.

## ReadFlow / RetainPDF

The built-in full-document translator (`addon/content/scripts/services/translator.js`) ports prompts, placeholder
protection, result validation and batch/retry logic from ReadFlow (RetainPDF), which is MIT-licensed. The optional
ReadFlow engine (`services/readflow.js`) talks to a separately installed ReadFlow over its local HTTP API.

```
MIT License

Copyright (c) 2026 RetainPDF contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendored third-party libraries

Copies of these files are shipped inside the add-on under `addon/content/lib/`.

| Library | Version | License | Shipped paths |
|---------|---------|---------|---------------|
| [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT | `addon/content/lib/marked/marked.js`, `addon/content/lib/marked/LICENSE` |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.47 | MIT | `addon/content/lib/katex/katex.min.js`, `katex.min.css`, `auto-render.min.js`, `fonts/*.woff2`, `LICENSE` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `addon/content/lib/pdf-lib/pdf-lib.min.js`, `LICENSE-pdf-lib` |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT | `addon/content/lib/pdf-lib/fontkit.umd.min.js`, `LICENSE-fontkit` |

All vendored libraries are MIT-licensed; their full license texts are included in the respective `LICENSE*` files.
