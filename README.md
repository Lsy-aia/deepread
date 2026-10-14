# DeepRead：Zotero AI 精读插件

DeepRead 是一个免费、开源的 Zotero 插件，支持 Zotero 7–10。它把 Vibero 的 AI 精读能力做成了普通插件，可以直接装进官方 Zotero 使用：

- **不需要账号、积分或订阅。** 解析和大模型服务都用你自己的 API Key。
- **PDF 内容只发往你在设置里配置的服务。** 插件不会连接其他任何服务器。

## 功能（v0.3）

| 功能 | 说明 |
|---|---|
| **AI 精读** | 在阅读器工具栏点「AI 精读」，插件会依次完成以下步骤：<br>• 用 MinerU 解析 PDF 结构<br>• 把每个段落对齐到原文位置<br>• 逐页调用大模型，为每段生成摘要和要点，并给出每个要点的翻译 |
| **悬停段落卡片** | 鼠标停在段落上，旁边会弹出卡片，显示段落摘要、要点和要点译文：<br>• 悬停某个要点，会高亮它在原文中对应的句子<br>• 点击要点可以切换重要度（普通 / 蓝色 / 红色），重要的要点会在 PDF 中一直高亮显示 |
| **原位翻译** | 按住 `Alt` 键再悬停段落，译文会直接覆盖在原段落的位置上显示 |
| **速读卡** | 右侧栏显示 5 部分速读卡：论文标题、研究背景、核心创新点、实验结果、结论与价值。点击其中的要点，会跳回它对应的原文 |
| **AI 大纲** | 右侧栏按需生成层级大纲，每一节附一句总结，点击可以跳转到该节 |
| **AI 对话** | 基于全文（含页码）回答问题：<br>• 支持 Markdown 和 LaTeX 公式<br>• 回答里的 `(p. N)` 可以点击跳转<br>• 对话按文献保存在本地 |
| **页边卡片** | 默认开启，可在工具栏「▾」菜单中关闭。开启后：<br>• PDF 右侧出现卡片栏，每张卡片对齐对应段落，滚动和缩放时跟随<br>• 单击卡片展开译文；双击段落摘要可以直接编辑<br>• 悬停卡片会在原文中高亮对应段落<br>• 卡片可以隐藏，隐藏后可在菜单里恢复 |
| **我的理解** | 在页边卡片上点「✎」，可以写下自己对这一段的理解、疑问或联想：<br>• 「我的理解」始终展开显示，不会折叠<br>• 会和闪卡一起导出到 Zotero 笔记 |
| **闪卡** | 选中文字后点「闪卡」，或在段落卡片上点「卡」，AI 会出题并给出答案：<br>• 闪卡挂在对应段落的页边卡片里：AI 答案默认折叠，点击翻面；你给闪卡写的「我的理解」始终显示<br>• 「闪卡」面板支持复习模式、编辑、让 AI 生成答案、定位原文，以及一键导出为 Zotero 笔记 |
| **代码面板** | 自动从论文中识别 GitHub 仓库，也可以按标题搜索或手动粘贴地址：<br>• 查看仓库信息、README 和文件树<br>• 加载 DeepWiki 文档并向 DeepWiki 提问。问题和仓库名会发送到 deepwiki.com；GitHub Token 是可选的 |
| **选段翻译 / 问 AI** | 选中文字后，弹出菜单里多出两个按钮：<br>•「翻译」：显示译文后可以复制，或存为高亮批注<br>•「问 AI」：把选中内容作为引用发进 AI 对话 |

## 安装

1. 下载或自己构建 `deepread-x.y.z.xpi`。构建方法：`npm install && npm run vendor && npm run build`，产物在 `build/` 目录下。
2. 在 Zotero 中打开「工具 → 插件」，点齿轮图标，选「从文件安装附加组件…」，然后选中这个 `.xpi` 文件。

## 配置（设置 → DeepRead）

### 大模型

任何 OpenAI 兼容接口都可以用。插件内置了以下服务的预设：

- DeepSeek
- 阿里云百炼
- 智谱
- 火山方舟
- 硅基流动
- OpenRouter
- OpenAI
- Ollama 本地

选好预设后填 API Key 即可，然后点「测试连接」确认。

关于「JSON 模式」：

- 默认选 `json_object`，兼容性最好。
- 如果服务商支持严格 JSON Schema，可以改成 `json_schema`。
- 如果服务商不支持你选的模式，插件会自动降级。

### PDF 结构解析

有四种方式，默认使用第一种：

- **内置解析（推荐）**：直接用 PDF 自带的文字层识别段落、标题、图表和公式。不需要任何服务，免费、离线、一篇论文约 1 秒。扫描版 PDF 没有文字层，无法使用精读功能。
- **GROBID 本地服务**：专为学术论文设计，只需 CPU 和约 1–2 GB 内存。用 Docker 启动：`scripts/grobid.sh start`（当前用户需要在 docker 组里）。服务地址默认是 `http://127.0.0.1:8070`。

- **MinerU 官方 API**：在 <https://mineru.net/apiManage> 申请 Token 后填入。免费额度以官网为准。
- **自建或第三方 MinerU 兼容服务**：填入 `mineru-api` 的地址（插件会调用 `POST /file_parse`）。如果服务需要鉴权，再填 Token。

### 阅读

- 选择摘要和翻译的输出语言。
- 选择是否显示高亮、悬停卡片和翻译。

## 费用参考

- **MinerU**：按页计费或计入免费额度。
- **大模型**：
  - 精读时每页 1 次请求；另有 1 次请求生成速读卡，1 次请求过滤作者信息块。
  - AI 大纲需要你手动生成，每次 1 次请求。
  - AI 对话每发一句消耗一次请求。上下文默认最多带 12 万字符的全文，可以在设置里调小。

## 数据存放

| 数据 | 位置 |
|---|---|
| 精读结果和对话 | Zotero 数据目录下的 `deepread.sqlite` |
| MinerU 原始解析结果 | Zotero 数据目录下的 `deepread/mineru/<库ID>_<条目Key>/` |
| API Key | Zotero 本机偏好设置，以明文保存 |

要删除某篇文献的结果，在工具栏「▾」菜单中选「删除本文精读结果」。

## 开发

```bash
npm install && npm run vendor          # 拷贝 marked / KaTeX 到 addon/content/lib
node test/llm.test.mjs                 # LLM 客户端单元测试
node test/pipeline-smoke.mjs           # 流水线冒烟测试（含合成端到端）
python3 test/build-fixture.py          # 生成离线测试用的 MinerU 夹具
scripts/e2e.sh test/e2e/basic.js       # 在隔离的无头 Zotero 10 中跑端到端测试（假 MinerU + 假大模型）
scripts/e2e.sh test/e2e/ui.js          # 设置页 / 工具栏 UI 测试
npm run build                          # 打包 build/deepread-<version>.xpi
```

端到端测试使用 `.test-profile/` 下独立的配置目录和数据目录，不会读写你自己的 Zotero 资料库。

各模块的约定和接口见 `docs/DEV_NOTES.md`，流水线移植说明见 `docs/PIPELINE_PORT.md`。

## 路线图

- **下一步**：接入 ReadFlow 的整篇保留排版翻译

## 许可与致谢

- 本插件采用 **AGPL-3.0-or-later** 许可，见 `LICENSE`。
- 解析与提示词流水线移植自 Vibero。Vibero 是 Zotero 的 AGPL-3.0 分支，著作权归原作者所有。本插件不使用 Vibero 的名称、标识或任何服务。
- 本插件基于 Zotero（AGPL-3.0）开发。
- 打包了 marked（MIT）和 KaTeX（MIT）两个第三方库，详见 `NOTICE.md`。
