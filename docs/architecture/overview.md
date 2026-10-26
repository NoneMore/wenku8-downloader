# 当前架构概览

本文概述 wenku8-downloader **已经实现的**模块、主要数据流和跨模块边界，用于源码导航；具体行为由源码、测试和运行证据确认。共享规则见 [项目治理约定](../governance.md)。

## 系统边界

wenku8-downloader 是 Node.js / TypeScript 的命令行轻小说下载器。它访问 Wenku8 站点，获取详情、目录、章节及图片，在本地可恢复工作区保留下载资料，随后生成 EPUB 3。

主要外部边界是：用户与 CLI、站点认证及 HTTP 请求、登录时的独立浏览器、本地文件系统、可选的外部 EPUBCheck 工具。发布包通过 `package.json` 的 `bin` 暴露 `wenku8` 命令；`src/index.ts` 另导出下载器、站点客户端、EPUB 构建器及领域类型。

## 模块职责

| 位置                                                                                                                                                           | 当前职责                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`src/cli.ts`](../../src/cli.ts)、[`src/cli/`](../../src/cli/)                                                                                                 | 命令解析、交互界面、登录态、进度与 EPUBCheck 调用                  |
| [`src/auth/`](../../src/auth/)                                                                                                                                 | 账号登录编排、独立浏览器验证、会话验证与用户级持久化               |
| [`src/domain/`](../../src/domain/)                                                                                                                             | Book、Volume、Chapter、Asset 等数据模型、ID、错误和完整性校验      |
| [`src/site/`](../../src/site/)                                                                                                                                 | 站点 URL、GBK/GB18030 文本与 HTML 结构解析                         |
| [`src/site/illustrations.ts`](../../src/site/illustrations.ts)                                                                                                 | Wenku8 完整段落插图标记与旧 URL 碎片检测                           |
| [`src/domain/illustration-layout.ts`](../../src/domain/illustration-layout.ts)                                                                                 | 源块摘要、严格映射校验及整体块移动，不解释站点标记或访问网络       |
| [`src/service/illustration-layout.ts`](../../src/service/illustration-layout.ts)、[`illustration-inspection.ts`](../../src/service/illustration-inspection.ts) | 布局准备和诊断、离线源缓存检查与图片文件核验                       |
| [`src/http/client.ts`](../../src/http/client.ts)                                                                                                               | 请求队列、Cookie 请求、超时、限速、重试、429 冷却、curl 回退和统计 |
| [`src/service/downloader.ts`](../../src/service/downloader.ts)                                                                                                 | 详情与章节下载的编排、整轮重试、图片任务聚合、EPUB 生成            |
| [`src/storage/`](../../src/storage/)                                                                                                                           | Manifest、缓存及工作区、文件路径处理                               |
| [`src/assets/image-store.ts`](../../src/assets/image-store.ts)                                                                                                 | 图片获取、解码验证、格式规范化与缓存复用                           |
| [`src/epub/`](../../src/epub/)                                                                                                                                 | XHTML/导航渲染、资源清单、ZIP 打包及包内引用检查                   |

关键依赖关系示意：

```text
CLI (src/cli.ts)
  ├─ 用户目录 (src/cli/paths.ts)
  ├─ 账号登录 / 浏览器 / 会话 (src/auth/)
  └─ Downloader (src/service/downloader.ts)
       ├─ Wenku8Client (src/site/client.ts)
       │    ├─ Parser (src/site/parser.ts)
       │    └─ HttpClient (src/http/client.ts)
       ├─ BookWorkspace (src/storage/workspace.ts)
       ├─ ImageStore (src/assets/image-store.ts)
       │    └─ HttpClient
       └─ EpubBuilder (src/epub/builder.ts)
            ├─ Domain completeness validation
            └─ EPUB render / package

Domain types and errors are used across layers.
```

此图只表示主要职责与依赖，不是完整的逐函数调用图。

## 典型下载数据流

1. CLI 解析书籍 ID、网络选项、工作区与输出路径，从用户配置目录加载程序管理的账号会话；没有会话时提示先执行 `wenku8 login`。
2. `Downloader` 打开对应 `BookWorkspace`，尝试复用已经标记完成且文件存在的详情/目录资料。
3. `Wenku8Client` 通过 `HttpClient` 获取站点数据，由 `src/site/parser.ts` 解析详情、目录与章节，形成领域模型。
4. `Downloader` 并行调度章节，失败时根据选项重试。章节仍有失败则终止下载并报告，而不是继续交付缺章结果。
5. `ImageStore` 获取封面、插图，检验能否解码，将不兼容的图片格式转换为支持的格式；相关资源写入工作区。
6. 书稿和资源登记完成后，`EpubBuilder` 执行完整性校验，渲染 XHTML / 导航 / 资源表，检查图片引用，生成 EPUB。

`download` 的可选插图布局在加载源章节后准备：站点检测器识别完整 URL 和符号标记，领域模块对原坐标和源块摘要建立整体映射计划；图片仍统一经过 `ImageStore` 获取并绑定资源，核实映射所需实际字节摘要后才移动块。EPUB 层继续只处理普通图片块。编号不会自动解释为图库序号；旧下载包已拆散的 URL 标记只报告限制。

`illustrations` 命令走独立的只读检查路径，不加载会话或调用 `BookWorkspace.open()`。它以 Manifest v1、缓存目录与完成的源章节为输入，检查本地图片字节并输出版本化报告；缺项产生部分或错误状态。`book.json` 仅能辅助查找资源文件，不作为检查的章节来源。

仅恢复 URL 时跳过映射身份规划及应用阶段的复制；显式映射继续校验章节 URL 唯一。源章节摘要在一次准备调用中计算后复用。离线候选检查刻意执行完整像素解码，比 `ImageStore` 现有缓存复用的元数据检查更严格，以拒绝只有文件头可读的损坏图片。

## 恢复与持久化边界

CLI 默认使用用户配置目录中的 `workspace/` 和 `downloads/`，可通过 `--work-dir`、`--output` 修改。直接以库方式调用 `Downloader` 时，其未指定目录的默认行为以 `Downloader.download()` 的实现为准，不应推定与 CLI 完全相同。

典型工作区布局：

```text
workspace/<book-id>/
├── manifest.json       # 各资源状态与元数据
├── book.json           # 结构化书稿
├── raw/                # 详情、目录、章节原始 HTML
├── chapters/           # 可复用章节
├── assets/             # 封面与插图
└── epub/package/       # EPUB 打包前的文件树
```

- [`src/storage/schema.ts`](../../src/storage/schema.ts) 当前定义 Manifest `version: 1` 及 `pending / running / complete / failed` 等资源状态。
- [`src/storage/workspace.ts`](../../src/storage/workspace.ts) 管理 Manifest 读写、工作区目录和文件缓存；文件写入采用临时文件后重命名，Manifest 写入以 Promise 链串行化。
- [`src/storage/paths.ts`](../../src/storage/paths.ts) 对输出文件名做规范化，工作区另有路径越界检查。
- 编排层依据持久化记录和文件存在情况复用资源；`ImageStore` 会对被复用的图片重新检查数据。
- 可选插图布局只派生本次 `book.json` 和 `illustration-layout.json`，不覆盖 `raw/`、`chapters/` 或升级 Manifest。映射绑定原始块坐标、章节摘要和图片文件摘要，每次重新校验；未启用布局时从源章节生成原排列。书稿及布局报告在映射校验后、EPUB 构建前写入，表示最近一次布局尝试，不用于恢复或判断导出完成；后续构建失败可保留旧 EPUB，成功状态以构建结果及 Manifest 为准。

Manifest schema、资源状态、缓存复用及目录语义均属于兼容性边界。变更它们时，评估旧工作区迁移和中断后的恢复行为，而不只是检查新版本单次运行是否成功。

## 站点与网络边界

- `Wenku8Client` 负责站点地址、正文/目录/搜索接口与编码处理；页面结构差异应尽量封装在 `src/site/` 并覆盖解析测试。
- `HttpClient` 集中封装队列并发、每秒请求上限、重试、超时、HTTP 429 冷却及按当前条件启用的 curl 回退，避免下载、图片与 CLI 各自建立不一致的网络策略。
- [`src/http/proxy.ts`](../../src/http/proxy.ts) 使用 `proxy-from-env` 为 Node 选择环境代理，补足 IP 字面量的有效 CIDR 排除；代理、显式直连或 CIDR 排除的 dispatcher 在响应或失败后自行释放，未配置代理时保留普通 fetch。curl 自动模式保留原生环境和配置，仅在显式代理或直连时覆盖必要选项。HTTP 层将配置、确定的代理连接或认证失败及 Node 代理内部超时归为通用不可恢复错误，由既有终止路径传播；调用方取消保留原原因并停止重试。
- CLI 的 `--proxy` / `--no-proxy` 适用于普通命令、交互和登录交接，不持久化。浏览器通过 Playwright 原生代理按 HTTPS 登录页选定代理或直连，再由 Chromium 处理绕过；不维护转发服务，也不承诺三套传输的全部边缘行为一致。
- [`src/auth/login.ts`](../../src/auth/login.ts) 使用账号密码完成站点认证，必要时交给 [`src/auth/browser.ts`](../../src/auth/browser.ts) 启动 Playwright 管理的独立可见浏览器。浏览器正常提交站点表单，人工验证由用户完成；结束时自动关闭浏览器上下文，不读取日常浏览器资料。
- [`src/site/auth.ts`](../../src/site/auth.ts) 封装登录表单、GBK 提交编码、账号页面证据及登录失效页面的识别。认证后必须用实际 CLI HTTP 传输验证账号页面，才能保存新会话；浏览器成功不代表交接必然成功。
- [`src/auth/session.ts`](../../src/auth/session.ts) 在用户配置目录的 `session.json` 保存版本为 `1` 的 CookieJar、User-Agent、已验证的 Node/curl 传输和会话 ID，不保存账号密码。受限权限临时文件与原子替换保护既有会话；文件锁内校验会话 ID，并将本次响应的 Cookie 增量（含删除）合并到当前磁盘状态，避免不同进程的旧快照覆盖。此版本独立于工作区 Manifest 版本。
- Node 与 curl 按域、路径、有效期和安全属性使用 CookieJar，逐跳回收响应 Cookie；浏览器交接时两个候选传输分别使用独立快照，仅保存验证成功的一份。直接账号登录使用 Node，不要求预装 curl。会发送会话或认证信息的请求禁止 HTTPS 重定向降级 HTTP；不携带凭证的公共资源保留原有跳转能力。认证 POST 不自动重试，也不跟随要求保留 POST 的 307/308 重定向。Cookie 落盘失败直接报告，不重发已完成请求。CLI 不接受手动 Cookie 参数、环境变量或文件导入；库方式仍可在 HTTP 配置中提供内部 Cookie。凭证不得提交进仓库或写入公开日志。
- 普通联网命令通过登录表单、错误页及验证页结构识别明确的认证阻断，不按小说中的“验证码”等文字判断。认证错误沿下载包回退、章节及图片路径向上传播；章节下载停止后保留工作区，提示重新登录，不在下载期间自动弹出浏览器。
- 站点可用性、防护与使用条件是外部约束，不能假定 HTML 或认证机制永远稳定。

## EPUB 与完整性边界

- [`src/domain/validate.ts`](../../src/domain/validate.ts) 对卷章、正文、图片引用和封面关联进行完整性检查。
- `Downloader` 单独负责章节下载失败的终止处理；`EpubBuilder` 默认再校验书稿完整性。
- `EpubBuilder` 的 `allowMissingImages` 选项会放宽其完整性验证；CLI 的 `--allow-missing-images` 对应此行为。修改相关语义时应特别检查对产物完整性的影响。
- [`src/assets/image-store.ts`](../../src/assets/image-store.ts) 通过 sharp 校验图片并对非 JPEG/PNG/GIF 图片进行规范化。
- [`src/epub/builder.ts`](../../src/epub/builder.ts) 创建 EPUB 文件树、清单、导航与打包输出，验证图片路径，并保证 ZIP 内首个 `mimetype` 条目不压缩。
- 每卷生成独立 XHTML 扉页（包括默认“正文”卷及空卷），导航以“卷 → 章”嵌套并将卷名链接到扉页；正文按输入顺序依次排列卷扉页和该卷章节，空卷不生成章节子列表。此行为兼容现有书稿与 Manifest v1，已生成 EPUB 需重新构建才会包含卷扉页。
- [`src/cli/epubcheck.ts`](../../src/cli/epubcheck.ts) 调用系统安装的 EPUBCheck；CI 的独立 Job 在测试环境安装并使用 EPUBCheck。

## 测试、构建与变更影响

[README「本地开发」](../../README.md#本地开发) 是日常命令的主要入口。`package.json` 定义 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 和聚合命令 `pnpm check`；[GitHub CI](../../.github/workflows/ci.yml) 在 push / PR 上执行常规检查、打包预检与 EPUBCheck 环境下的测试。

按修改模块优先检查就近测试：

- [站点解析](../../src/site/parser.test.ts)、[认证解析](../../src/site/auth.test.ts)、[HTTP 客户端](../../src/http/client.test.ts)
- [下载编排与恢复](../../src/service/downloader.test.ts)
- [插图标记](../../src/site/illustrations.test.ts)、[映射校验](../../src/domain/illustration-layout.test.ts)、[离线检查](../../src/service/illustration-inspection.test.ts)、[布局与 EPUB 集成](../../src/service/illustration-download.test.ts)、[离线 CLI](../../src/cli/illustrations.test.ts)
- [存储](../../src/storage/workspace.test.ts)、[路径](../../src/storage/paths.test.ts)
- [完整性](../../src/domain/validate.test.ts)、[EPUB](../../src/epub/builder.test.ts)、[账号登录](../../src/auth/login.test.ts)、[会话持久化](../../src/auth/session.test.ts)、[浏览器验证](../../src/auth/browser.test.ts)

浏览器集成测试使用真实无界面 Chromium 和模拟站点页面，需预先安装浏览器；不依赖真实站点账号。真实站点登录及交接的运行证据与未验证范围记录在对应 Change 中。

此文档只维护**已实现的高层架构结果**。若实现改变了模块职责、持久化数据契约或重要行为边界，应更新受影响章节；具体的历史架构取舍另通过 ADR 保存，不在此重复其理由。
