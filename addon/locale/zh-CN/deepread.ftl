## DeepRead - 简体中文

deepread-toolbar-run = AI 精读

deepread-pane-summary-header =
    .label = 速读卡
deepread-pane-summary-sidenav =
    .tooltiptext = 速读卡
deepread-pane-outline-header =
    .label = AI 大纲
deepread-pane-outline-sidenav =
    .tooltiptext = AI 大纲
deepread-pane-chat-header =
    .label = AI 对话
deepread-pane-chat-sidenav =
    .tooltiptext = AI 对话
deepread-section-button-regenerate =
    .tooltiptext = 重新生成
deepread-section-button-clear-chat =
    .tooltiptext = 清空对话

## Preferences

deepread-pref-show =
    .label = 显示
deepread-pref-hide =
    .label = 隐藏
deepread-pref-test =
    .label = 测试连接

deepread-pref-llm-title = 大模型 (LLM)
deepread-pref-llm-preset = 服务预设
deepread-pref-llm-preset-custom =
    .label = 自定义
deepread-pref-llm-preset-hint = 选择预设会自动填入接口地址和模型名，随后请填写 API Key。支持任何 OpenAI 兼容接口。
deepread-pref-llm-baseurl = 接口地址
deepread-pref-llm-apikey = API Key
deepread-pref-llm-model = 模型
deepread-pref-llm-chatmodel = 对话模型
deepread-pref-llm-chatmodel-input =
    .placeholder = 留空则同上
deepread-pref-llm-jsonmode = JSON 模式
deepread-pref-llm-jsonmode-object =
    .label = json_object（兼容性最好）
deepread-pref-llm-jsonmode-schema =
    .label = json_schema（严格结构，需服务支持）
deepread-pref-llm-jsonmode-none =
    .label = none（不发送 response_format）
deepread-pref-llm-temperature = 温度
deepread-pref-llm-concurrency = 并发数 (1–64)
deepread-pref-llm-extraheaders = 额外请求头 (JSON，可选)

deepread-pref-parser-title = PDF 结构解析
deepread-pref-parser-provider = 解析服务
deepread-pref-parser-provider-builtin =
    .label = 内置解析（PDF 文本层，无需服务，推荐）
deepread-pref-parser-provider-grobid =
    .label = GROBID 本地服务（轻量，CPU）
deepread-pref-parser-provider-mineru =
    .label = MinerU 官方 API
deepread-pref-parser-provider-selfhost =
    .label = 自建 / 第三方 MinerU 兼容服务
deepread-pref-parser-builtin-hint = 直接使用 PDF 自带的文字层识别段落、标题、图表和公式，速度快、免费、不上传文件。适合大多数电子版论文；扫描版 PDF 没有文字层，无法使用精读功能。复杂表格和公式较多时可改用 GROBID 或 MinerU。
deepread-pref-parser-grobid-hint = GROBID 是专为学术论文设计的开源解析服务，仅需 CPU 和约 1–2 GB 内存。用 Docker 启动：在插件源码目录运行 scripts/grobid.sh start。
deepread-pref-parser-grobid-url = 服务地址
deepread-pref-parser-mineru-hint = 请在 https://mineru.net/apiManage 申请 Token。
deepread-pref-parser-token = Token
deepread-pref-parser-mineru-model = 解析模型
deepread-pref-parser-mineru-language = 文档语言
deepread-pref-parser-mineru-ocr =
    .label = 启用 OCR
deepread-pref-parser-mineru-formula =
    .label = 识别公式
deepread-pref-parser-mineru-table =
    .label = 识别表格
deepread-pref-parser-selfhost-hint = 填写 mineru-api 或兼容服务的地址（POST 地址/file_parse）。
deepread-pref-parser-selfhost-url = 服务地址
deepread-pref-parser-selfhost-token = Token（可选）
deepread-pref-parser-selfhost-backend = 后端

deepread-pref-readflow-title = 整篇翻译（ReadFlow）
deepread-pref-readflow-hint = 通过本机的 ReadFlow 服务生成保留排版的整篇译文 PDF，并保存为条目附件。翻译使用上方「大模型」的设置。使用前请先打开 ReadFlow（或部署其后端服务）。
deepread-pref-readflow-baseurl = 服务地址
deepread-pref-readflow-apikey = API Key
deepread-pref-readflow-apikey-hint = ReadFlow 桌面版默认是 retain-pdf-desktop；自行部署的服务填写你设置的 Key。
deepread-pref-readflow-mode = 默认输出
deepread-pref-readflow-mode-dual =
    .label = 双栏对照（左原文·右译文）
deepread-pref-readflow-mode-inplace =
    .label = 原位译文（保留排版）
deepread-pref-readflow-mode-hint = 每次翻译时也可以在工具栏菜单里临时选择。
deepread-pref-readflow-ocr = 文档识别
deepread-pref-readflow-ocr-local =
    .label = 本地（文字层优先）

deepread-pref-reading-title = 阅读
deepread-pref-language = 输出语言
deepread-pref-filter-author =
    .label = 过滤作者/单位信息块
deepread-pref-view-highlights =
    .label = 在 PDF 中显示高亮
deepread-pref-view-hovercards =
    .label = 悬停显示要点卡片
deepread-pref-view-translation =
    .label = 显示翻译弹窗
deepread-pref-chat-maxcontext = 对话最大上下文字符数

deepread-pref-privacy-title = 隐私
deepread-pref-privacy-note = API Key 保存在本机的 Zotero 设置中；PDF 内容只会发送到您在此处配置的服务。使用整篇翻译时，大模型 Key 会登记到本机 ReadFlow 的密钥库（名称 deepread-llm），由 ReadFlow 调用模型。

deepread-pane-flashcards-header =
    .label = 闪卡
deepread-pane-flashcards-sidenav =
    .tooltiptext = 闪卡
deepread-pane-code-header =
    .label = 代码
deepread-pane-code-sidenav =
    .tooltiptext = 代码

deepread-pref-update-title = 版本与更新
deepread-pref-update-current =
    .value = 当前版本
deepread-pref-update-check =
    .label = 检查更新
deepread-pref-update-hint = 插件每天会自动检查一次更新。
deepread-pref-update-releases = 查看更新日志
