## DeepRead - English

deepread-toolbar-run = AI Deep Read

deepread-pane-summary-header =
    .label = Summary
deepread-pane-summary-sidenav =
    .tooltiptext = Summary
deepread-pane-outline-header =
    .label = AI Outline
deepread-pane-outline-sidenav =
    .tooltiptext = AI Outline
deepread-pane-chat-header =
    .label = AI Chat
deepread-pane-chat-sidenav =
    .tooltiptext = AI Chat
deepread-section-button-regenerate =
    .tooltiptext = Regenerate
deepread-section-button-clear-chat =
    .tooltiptext = Clear chat

## Preferences

deepread-pref-show =
    .label = Show
deepread-pref-hide =
    .label = Hide
deepread-pref-test =
    .label = Test connection

deepread-pref-llm-title = LLM
deepread-pref-llm-preset = Provider preset
deepread-pref-llm-preset-custom =
    .label = Custom
deepread-pref-llm-preset-hint = Choosing a preset fills in the base URL and model; then enter your API key. Any OpenAI-compatible endpoint works.
deepread-pref-llm-baseurl = Base URL
deepread-pref-llm-apikey = API key
deepread-pref-llm-model = Model
deepread-pref-llm-chatmodel = Chat model
deepread-pref-llm-chatmodel-input =
    .placeholder = Leave empty to use the same model
deepread-pref-llm-jsonmode = JSON mode
deepread-pref-llm-jsonmode-object =
    .label = json_object (most compatible)
deepread-pref-llm-jsonmode-schema =
    .label = json_schema (strict; server must support it)
deepread-pref-llm-jsonmode-none =
    .label = none (do not send response_format)
deepread-pref-llm-temperature = Temperature
deepread-pref-llm-concurrency = Concurrency (1–64)
deepread-pref-llm-extraheaders = Extra headers (JSON, optional)

deepread-pref-parser-title = PDF structure parsing
deepread-pref-parser-provider = Parser service
deepread-pref-parser-provider-builtin =
    .label = Built-in (PDF text layer, no service — recommended)
deepread-pref-parser-provider-grobid =
    .label = GROBID local service (lightweight, CPU)
deepread-pref-parser-provider-mineru =
    .label = MinerU official API
deepread-pref-parser-provider-selfhost =
    .label = Self-hosted / third-party MinerU-compatible service
deepread-pref-parser-builtin-hint = Uses the text layer embedded in the PDF to recognize paragraphs, headings, figures and formulas. Fast, free, and no file upload. Suits most born-digital papers; scanned PDFs have no text layer, so Deep Read cannot process them. For complex tables or many formulas, try GROBID or MinerU instead.
deepread-pref-parser-grobid-hint = GROBID is an open-source parsing service built for academic papers. It needs only a CPU and about 1–2 GB of RAM. Start it with Docker by running scripts/grobid.sh start in the plugin source directory.
deepread-pref-parser-grobid-url = Service URL
deepread-pref-parser-mineru-hint = Get a token at https://mineru.net/apiManage.
deepread-pref-parser-token = Token
deepread-pref-parser-mineru-model = Parsing model
deepread-pref-parser-mineru-language = Document language
deepread-pref-parser-mineru-ocr =
    .label = Enable OCR
deepread-pref-parser-mineru-formula =
    .label = Recognize formulas
deepread-pref-parser-mineru-table =
    .label = Recognize tables
deepread-pref-parser-selfhost-hint = Address of mineru-api or a compatible service (POST address/file_parse).
deepread-pref-parser-selfhost-url = Service URL
deepread-pref-parser-selfhost-token = Token (optional)
deepread-pref-parser-selfhost-backend = Backend

deepread-pref-translate-title = Full-document translation
deepread-pref-translate-hint = Translate the whole paper inside Zotero: the translation can be shown in place in the reader ("translation view"), or exported as a side-by-side or in-place translated PDF. No other software is needed; translation uses the LLM settings above.
deepread-pref-translate-engine = Engine
deepread-pref-translate-engine-builtin =
    .label = Built-in (lightweight, recommended)
deepread-pref-translate-engine-readflow =
    .label = ReadFlow (install and enable below)
deepread-pref-translate-fontpath = Export font
deepread-pref-translate-fontpath-input =
    .placeholder = Empty = find a CJK system font automatically
deepread-pref-translate-fontpath-hint = Font for the translated text in exported PDFs. Use a TrueType-outline .ttf or .ttc (e.g. Microsoft YaHei, WenQuanYi); CFF fonts such as Noto Sans CJK cannot be embedded.

deepread-pref-readflow-title = ReadFlow engine (optional)
deepread-pref-readflow-enabled =
    .label = Enable the ReadFlow engine
deepread-pref-readflow-autostart =
    .label = Start ReadFlow automatically when needed
deepread-pref-readflow-apppath = App path
deepread-pref-readflow-apppath-input =
    .placeholder = Empty = find automatically (e.g. /opt/ReadFlow/readflow)
deepread-pref-readflow-hint = If ReadFlow is installed, you can use it here: ReadFlow handles recognition, translation and typesetting to produce a layout-preserving translated PDF. When not enabled, ReadFlow is never contacted.
deepread-pref-readflow-baseurl = Service URL
deepread-pref-readflow-apikey = API Key
deepread-pref-readflow-apikey-hint = The ReadFlow desktop app uses retain-pdf-desktop by default; for a self-hosted service, enter the key you configured.
deepread-pref-readflow-mode = Default output
deepread-pref-readflow-mode-dual =
    .label = Side by side (original | translation)
deepread-pref-readflow-mode-inplace =
    .label = In place (layout preserved)
deepread-pref-readflow-mode-hint = You can also pick a different output for a single run from the toolbar menu.
deepread-pref-readflow-ocr = Recognition
deepread-pref-readflow-ocr-local =
    .label = Local (text layer first)

deepread-pref-reading-title = Reading
deepread-pref-language = Output language
deepread-pref-filter-author =
    .label = Filter author/affiliation blocks
deepread-pref-view-highlights =
    .label = Show highlights in the PDF
deepread-pref-view-hovercards =
    .label = Show key-point cards on hover
deepread-pref-view-translation =
    .label = Show translation popup
deepread-pref-chat-maxcontext = Chat max context characters

deepread-pref-privacy-title = Privacy
deepread-pref-privacy-note = API keys are stored in Zotero preferences on this computer. PDF content is sent only to the services you configure here. The built-in full-document translation calls the LLM above directly; only the optional ReadFlow engine registers the LLM key in the local ReadFlow key store (label deepread-llm) so ReadFlow can call the model.

deepread-pane-flashcards-header =
    .label = Flashcards
deepread-pane-flashcards-sidenav =
    .tooltiptext = Flashcards
deepread-pane-code-header =
    .label = Code
deepread-pane-code-sidenav =
    .tooltiptext = Code

deepread-pref-update-title = Version & updates
deepread-pref-update-current =
    .value = Current version
deepread-pref-update-check =
    .label = Check for updates
deepread-pref-update-hint = DeepRead checks for updates automatically once a day. 
deepread-pref-update-releases = Release notes
