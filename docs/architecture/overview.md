# 当前架构概览

本文概述 wenku8-downloader **已经实现的**模块、主要数据流和跨模块边界，用于源码导航；具体行为由源码、测试和运行证据确认。共享规则见 [项目治理约定](../governance.md)。

## 系统边界

wenku8-downloader 是 Node.js / TypeScript 的命令行轻小说下载器。它访问 Wenku8 站点，获取详情、目录、章节及图片，在本地可恢复工作区保留下载资料，随后生成 EPUB 3。

主要外部边界是：用户与 CLI、站点 HTTP 请求及用户 Cookie、本地文件系统、可选的外部 EPUBCheck 工具。发布包通过 `package.json` 的 `bin` 暴露 `wenku8` 命令；`src/index.ts` 另导出下载器、站点客户端、EPUB 构建器及领域类型。

## 模块职责

| 位置 | 当前职责 |
| --- | --- |
| [`src/cli.ts`](../../src/cli.ts)、[`src/cli/`](../../src/cli/) | 命令解析、交互界面、登录态、进度与 EPUBCheck 调用 |
| [`src/domain/`](../../src/domain/) | Book、Volume、Chapter、Asset 等数据模型、ID、错误和完整性校验 |
| [`src/site/`](../../src/site/) | 站点 URL、GBK/GB18030 文本与 HTML 结构解析 |
| [`src/http/client.ts`](../../src/http/client.ts) | 请求队列、Cookie 请求、超时、限速、重试、429 冷却、curl 回退和统计 |
| [`src/service/downloader.ts`](../../src/service/downloader.ts) | 详情与章节下载的编排、整轮重试、图片任务聚合、EPUB 生成 |
| [`src/storage/`](../../src/storage/) | Manifest、缓存及工作区、文件路径处理 |
| [`src/assets/image-store.ts`](../../src/assets/image-store.ts) | 图片获取、解码验证、格式规范化与缓存复用 |
| [`src/epub/`](../../src/epub/) | XHTML/导航渲染、资源清单、ZIP 打包及包内引用检查 |

关键依赖关系示意：

```text
CLI (src/cli.ts)
  ├─ Cookie / 用户目录 (src/cli/cookie.ts)
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

1. CLI 解析书籍 ID、Cookie、网络选项、工作区与输出路径。
2. `Downloader` 打开对应 `BookWorkspace`，尝试复用已经标记完成且文件存在的详情/目录资料。
3. `Wenku8Client` 通过 `HttpClient` 获取站点数据，由 `src/site/parser.ts` 解析详情、目录与章节，形成领域模型。
4. `Downloader` 并行调度章节，失败时根据选项重试。章节仍有失败则终止下载并报告，而不是继续交付缺章结果。
5. `ImageStore` 获取封面、插图，检验能否解码，将不兼容的图片格式转换为支持的格式；相关资源写入工作区。
6. 书稿和资源登记完成后，`EpubBuilder` 执行完整性校验，渲染 XHTML / 导航 / 资源表，检查图片引用，生成 EPUB。

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

Manifest schema、资源状态、缓存复用及目录语义均属于兼容性边界。变更它们时，评估旧工作区迁移和中断后的恢复行为，而不只是检查新版本单次运行是否成功。

## 站点与网络边界

- `Wenku8Client` 负责站点地址、正文/目录/搜索接口与编码处理；页面结构差异应尽量封装在 `src/site/` 并覆盖解析测试。
- `HttpClient` 集中封装队列并发、每秒请求上限、重试、超时、HTTP 429 冷却及按当前条件启用的 curl 回退，避免下载、图片与 CLI 各自建立不一致的网络策略。
- [`src/cli/cookie.ts`](../../src/cli/cookie.ts) 解析显式 Cookie、环境变量及本地文件，管理用户配置目录中的 Cookie。该凭证不应提交进仓库或写入公开日志。
- 站点可用性、防护与使用条件是外部约束，不能假定 HTML 或认证机制永远稳定。

## EPUB 与完整性边界

- [`src/domain/validate.ts`](../../src/domain/validate.ts) 对卷章、正文、图片引用和封面关联进行完整性检查。
- `Downloader` 单独负责章节下载失败的终止处理；`EpubBuilder` 默认再校验书稿完整性。
- `EpubBuilder` 的 `allowMissingImages` 选项会放宽其完整性验证；CLI 的 `--allow-missing-images` 对应此行为。修改相关语义时应特别检查对产物完整性的影响。
- [`src/assets/image-store.ts`](../../src/assets/image-store.ts) 通过 sharp 校验图片并对非 JPEG/PNG/GIF 图片进行规范化。
- [`src/epub/builder.ts`](../../src/epub/builder.ts) 创建 EPUB 文件树、清单、导航与打包输出，验证图片路径，并保证 ZIP 内首个 `mimetype` 条目不压缩。
- [`src/cli/epubcheck.ts`](../../src/cli/epubcheck.ts) 调用系统安装的 EPUBCheck；CI 的独立 Job 在测试环境安装并使用 EPUBCheck。

## 测试、构建与变更影响

[README「本地开发」](../../README.md#本地开发) 是日常命令的主要入口。`package.json` 定义 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 和聚合命令 `pnpm check`；[GitHub CI](../../.github/workflows/ci.yml) 在 push / PR 上执行常规检查、打包预检与 EPUBCheck 环境下的测试。

按修改模块优先检查就近测试：

- [站点解析](../../src/site/parser.test.ts)、[HTTP 客户端](../../src/http/client.test.ts)
- [下载编排与恢复](../../src/service/downloader.test.ts)
- [存储](../../src/storage/workspace.test.ts)、[路径](../../src/storage/paths.test.ts)
- [完整性](../../src/domain/validate.test.ts)、[EPUB](../../src/epub/builder.test.ts)、[Cookie](../../src/cli/cookie.test.ts)

此文档只维护**已实现的高层架构结果**。若实现改变了模块职责、持久化数据契约或重要行为边界，应更新受影响章节；具体的历史架构取舍另通过 ADR 保存，不在此重复其理由。

