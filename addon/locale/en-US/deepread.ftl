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
deepread-pref-privacy-note = API keys are stored in Zotero preferences on this computer only. PDF content is sent only to the services you configure here.

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
