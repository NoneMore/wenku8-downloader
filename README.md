# wenku8

一个可恢复、图片完整性优先的轻小说 EPUB 下载器。

## 特性

- 下载详情、目录、章节、封面和插图后再生成 EPUB
- 章节与图片均支持断点恢复
- 图片经过格式、尺寸和解码校验
- WebP、AVIF 等格式自动转为兼容性更好的 JPEG
- 默认拒绝生成缺章或缺图的电子书
- 输出 EPUB 3，并支持调用官方 EPUBCheck 校验
- 原始 HTML、结构化书稿和资源 manifest 均保留在工作区
- 交互模式支持搜索、选择下载、返回上级菜单和更清晰的任务进度反馈

## 用户使用

### 环境要求

需要 Node.js 22.13 或更高版本。推荐直接使用 Node.js 24 LTS。

### 安装

```bash
npm install -g wenku8
```

也可以不全局安装，直接用 npx 运行：

```bash
npx wenku8 --help
```

安装后确认 CLI 可用：

```bash
wenku8 --version
wenku8 doctor
```

### 快速开始

```bash
# 首次使用先登录账号
wenku8 login

# 进入交互模式
wenku8

# 或直接下载
wenku8 download 1973
```

`wenku8 login` 会在终端提示输入站点账号（用户名或邮箱）和密码。需要验证码或 Cloudflare 验证时，会自动打开独立浏览器窗口；请在窗口内完成验证和登录，程序会自动接收登录态，检查 CLI 可以使用后保存。后续搜索、查看详情、下载等命令自动复用登录态，无需复制 Cookie。

浏览器验证需要图形界面。程序优先使用已安装的 Chrome、Edge，也支持 Playwright Chromium；没有这些浏览器时，可执行 `npx playwright@1.64.1 install chromium` 安装。浏览器登录最多等待 5 分钟，期间可用 Ctrl+C 取消；请保留窗口直至终端报告完成。密码不会保存。

### 常用命令

```bash
# 交互模式
wenku8

# 搜索
wenku8 search "小说名"
wenku8 search "作者名" --author
wenku8 search "小说名" --download

# 榜单
wenku8 toplist day
wenku8 toplist month
wenku8 toplist all --download

# 轻小说大赏
wenku8 sugoi 2026
wenku8 sugoi 2005 --download

# 查看详情
wenku8 info 1973
wenku8 info 1973 --json

# 下载并生成 EPUB
wenku8 download 1973
wenku8 download https://www.wenku8.net/book/1973.htm

# 中断后继续
wenku8 resume 1973

# 查看工作区状态
wenku8 status 1973
wenku8 status 1973 --json

# 离线检查插图位置线索（无需登录）
wenku8 illustrations 1973 --json

# 恢复明确 URL 引用，或按核验过的本地映射移动插图
wenku8 download 1973 --relocate-illustrations
wenku8 download 1973 --illustration-map ./illustrations.json

# 使用官方 EPUBCheck 校验
wenku8 validate ~/Library/Application\ Support/wenku8/downloads/小说名.epub

# 检查运行环境
wenku8 doctor

# 登录或清理登录态
wenku8 login
wenku8 config
wenku8 logout
```

### 常用下载选项

```text
-o, --output <directory>      EPUB 输出目录，默认在用户配置目录 downloads/
-w, --work-dir <directory>    可恢复工作区目录，默认在用户配置目录 workspace/
-c, --concurrency <number>    网络并发数
-r, --rate-limit <number>     每秒最多请求数，默认 1
--chapter-retry-rounds <n>    章节失败后的整轮自动重试次数，默认 2
--chapter-retry-delay <ms>    章节自动重试轮次之间的等待时间，默认 15000
--allow-missing-images        明确允许生成缺图版本
--http-stats                  打印 Node/curl、429 和自动重试统计
--verbose-progress            显示每个章节的详细进度日志
```

不带子命令运行 `wenku8` 会进入交互模式，默认展示“搜索下载”、五个榜单入口、“轻小说大赏”、“检查环境”和“退出”。搜索下载支持按小说名模糊搜索、作者名搜索，或直接输入小说 ID；小说 ID 输入也兼容从浏览器复制的详情页 URL。轻小说大赏支持选择 2026 到 2005 年。交互子菜单支持选择“返回上级”，输入类页面可留空或输入 `q` 返回；下载或环境检查执行完成后会直接退出 CLI。

榜单命令别名：

```text
day    今日热榜       sort=dayvisit
month  本月热点       sort=monthvisit
all    热门轻小说     sort=allvisit
good   最受关注       sort=goodnum
new    新书一览       sort=postdate
```

## HTTP 代理

登录、浏览器验证和全部下载请求支持无需认证的 HTTP 代理；默认自动继承启动进程的环境变量。

PowerShell：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
wenku8 login
wenku8 download 1973
```

POSIX shell：

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1
wenku8 login
wenku8 download 1973
```

`HTTPS_PROXY=http://127.0.0.1:7890` 表示访问 HTTPS 目标时使用该 HTTP 代理，HTTPS 连接仍验证目标证书。

| 配置            | 行为                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `--proxy <url>` | 本次全部使用指定代理，忽略环境代理与 `NO_PROXY`                                                               |
| `--no-proxy`    | 本次全部直连，忽略环境代理与系统代理                                                                          |
| 未传选项        | 按目标协议读取 `HTTP_PROXY` / `HTTPS_PROXY`，缺失时使用 `ALL_PROXY`，命中 `NO_PROXY` 时直连，否则无配置即直连 |

所有变量也支持小写名称；同名变量的大小写值同时存在时，非空小写值优先，空白值按未设置处理。`HTTP_PROXY` 不作为 HTTPS 目标的兜底。代理配置只作用于本次运行，不写入登录态或工作区。全局选项可放在子命令前后，也适用于交互模式：

```sh
wenku8 --proxy http://127.0.0.1:7890 login
wenku8 download 1973 --proxy http://127.0.0.1:7890
wenku8 --proxy http://127.0.0.1:7890
wenku8 --no-proxy info 1973
```

`--proxy` 和 `--no-proxy` 不能同时使用。代理失败会报告错误，不自动改为直连。改变网络出口后，站点可能要求重新登录或验证。

`NO_PROXY` 是逗号分隔的列表，支持域名及其子域名、精确 IPv4 / IPv6（IPv6 不带方括号）以及独立的 `*`。例如 `example.test` 或 `.example.test` 均匹配本域及 `a.example.test`，不匹配 `notexample.test`；匹配忽略域名大小写、覆盖所有端口，不通过 DNS 将域名与 IP 相互匹配。空条目忽略；`*` 全部直连。localhost 和回环地址需要显式列入列表才会绕过代理。暂不支持端口限定、CIDR 网段和 `*.example.test` 等模式；自动模式遇到这些条目会明确报错。

本版只接受 `http://host[:port]`，省略端口使用 80；不支持代理认证、`https://` 代理服务器、SOCKS、PAC 或自动发现系统代理。纯离线命令及帮助、版本输出不受无效代理环境变量影响。

库调用可通过 `new Wenku8Client({ proxy: 'http://127.0.0.1:7890' })` 指定代理，`proxy: false` 强制直连，省略 `proxy` 自动继承环境。需要显式结束客户端连接时调用 `await client.http.close()`。

## 登录态

搜索、榜单、详情和下载等联网命令需要程序保存的账号登录态。首次使用、会话失效或升级自手动 Cookie 版本后，执行：

```bash
wenku8 login
```

账号密码仅用于本次登录。验证可用的会话写入用户配置目录中的 `session.json`，保存已验证的 Node/curl 传输、浏览器 User-Agent 及 Cookie 的域、路径、有效期和安全属性。后续命令复用通过检查的传输。会话文件属于敏感凭证，不要分享或提交到仓库。npm 包更新、重新安装或全局安装不会将它打入包产物：

```text
macOS   ~/Library/Application Support/wenku8/session.json
Linux   ${XDG_CONFIG_HOME:-~/.config}/wenku8/session.json
Windows %APPDATA%\wenku8\session.json
```

可以用 `wenku8 config` 查看实际路径，用 `wenku8 logout` 清除本工具的登录态。退出登录不会删除 EPUB、下载工作区或日常浏览器资料，也不代表注销站点其他会话。登录浏览器使用临时独立会话，完成、取消或失败时关闭，不读取日常浏览器资料。

本次移除了 `--cookie`、`--cookie-file`、`WENKU8_COOKIE` 及 `.wenku8-cookie` 导入；旧用户配置目录的 `cookie` 文件也不再读取。已有文件不会自动删除，升级后需要重新运行一次账号登录。

普通联网命令遇到会话失效或 Cloudflare 验证会明确报错，不在下载中自动打开浏览器。请重新运行 `wenku8 login`，成功后重试原命令或使用 `resume` 继续。浏览器内登录成功但 CLI 无法使用会话时，登录命令报告交接失败，并保留原有登录态；本工具不尝试绕过站点防护。

登录需要交互终端，遇到浏览器验证还需要图形环境；不提供密码参数、密码环境变量或无人值守自动重登。没有会话时不会发起下载请求。

## 数据与恢复

默认不再把 EPUB 和工作区写入当前目录，而是写入用户级目录，方便长期管理已下载小说：

```text
macOS   ~/Library/Application Support/wenku8/downloads
Linux   ${XDG_CONFIG_HOME:-~/.config}/wenku8/downloads
Windows %APPDATA%\wenku8\downloads
```

可恢复工作区默认为同一用户目录下的 `workspace/<book-id>/`：

```text
manifest.json          每个网络资源的状态、尝试次数、大小和 SHA-256
book.json              规范化后的完整书稿
raw/                   原始详情、目录和章节 HTML
chapters/              可复用的结构化章节
assets/                已解码并校验的封面和插图
epub/package/          EPUB 构建前的可检查目录
```

所有文件先写入临时文件，再原子替换目标文件。重新执行 `download` 或 `resume` 时，已完成资源不会重复下载。

## 图片完整性

正文中的每个图片引用必须对应一个已下载、可解码且登记在 EPUB manifest 中的本地文件。源站仅提供 `【图片】` 占位符却没有图片地址时，默认构建失败并报告具体卷章。

`--allow-missing-images` 仅用于用户明确接受不完整产物的情况。

### 插图位置与本地映射

默认保持源章节的排列。`download --relocate-illustrations` 只恢复独立段落中的完整 `[IMG]URL[/IMG]` 或 `IMG]URL[/IMG]` 图片地址；编号标记不会自动匹配图库次序。旧下载包若已把 URL 标记拆散，保留现存块并报告恢复限制。

`wenku8 illustrations <book> --json` 离线读取源缓存，输出标记、图片出现位置、章节摘要、可用图片文件摘要及本地相对路径。它不改写工作区，也不使用已经重排的 `book.json` 章节。退出码 `0` 表示检查完整，`2` 表示部分可检查，`1` 表示缺少可信的必要输入；检查完整不代表插图已全部定位。可用的符号标记包括 `（插图008）`、`第一章 插图001`、`插图001_fmt` 等固定格式；普通正文和未支持的标签保持原文。

离线检查会完整解码候选图片；即使文件头可读，像素数据损坏仍判为不可用，因此检查大图可能需要更多时间。完整但不支持的 IMG 标记不会被当作旧缓存碎片。

用户核对图片与自己的排版参考后，可将报告中的坐标和摘要填写为映射文件。下面的字段说明为占位值，实际摘要须使用检查报告中的 64 位 SHA-256：

```json
{
  "version": 1,
  "bookId": 1973,
  "entries": [
    {
      "target": {
        "chapterUrl": "https://example.test/body.htm",
        "chapterSha256": "<目标章节摘要>",
        "blockIndex": 3,
        "marker": "（插图008）"
      },
      "image": {
        "chapterUrl": "https://example.test/gallery.htm",
        "chapterSha256": "<来源章节摘要>",
        "blockIndex": 7,
        "sourceUrl": "https://example.test/image.jpg",
        "assetSha256": "<图片文件摘要>"
      },
      "evidence": { "reference": "用户核验所用的文件、出版物或页面" }
    }
  ]
}
```

`blockIndex` 从零开始，`marker` 须与报告中的原标签逐字相同。`download --illustration-map <file>` 同时启用明确 URL 恢复；同卷内将选中的来源图片块移到目标，支持一图对应多个明确目标。未选中的图片不受影响。任何一条映射失效都终止本次生成，`--allow-missing-images` 不能跳过映射校验。程序记录核验来源，但不认证或访问 `evidence.reference`。

显式传入空或纯空白映射路径会报错，不能用来恢复默认布局；需要默认布局时省略该选项。映射字段不合法时，错误会指出首个字段路径和原因。

启用布局时，工作区的 `illustration-layout.json` 记录本次恢复、映射及未解析情况。它与 `book.json` 在映射校验通过后、EPUB 构建前写入，描述本次布局尝试；若随后缺图校验失败，旧 EPUB 可能保留，而这两个文件已更新。应以命令执行结果和 Manifest 的 EPUB 状态判断本次是否导出成功。后续生成仍从源缓存重新校验。重新运行不带新选项的 `download` 可生成原排列；源章节 JSON 和原始 HTML 保持不变。新选项只在 `download` 提供，需要继续同一布局时，重新执行相同的 `download` 命令即可复用缓存。

## 本地开发

推荐使用 Node.js 24 LTS 和 pnpm 9。

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm link --global
```

常用开发命令：

```bash
pnpm dev -- --help
pnpm typecheck
pnpm lint
pnpm test
pnpm test:governance
pnpm build
pnpm check
```

解析器使用离线 HTML fixture/样例测试；EPUB 测试会检查 ZIP 中第一个条目是未压缩的 `mimetype`。发布前建议安装 EPUBCheck 5.3 或更高版本并验证真实产物。

认证测试使用模拟页面、局部 HTTP 服务和真实浏览器，不使用真实账号。浏览器集成测试默认启动 Playwright Chromium；也可通过 `WENKU8_TEST_BROWSER=chrome` 或 `WENKU8_TEST_BROWSER=msedge` 使用已安装的浏览器。Linux CI 安装命令为 `pnpm exec playwright install --with-deps chromium`。

## 架构

```text
CLI -> Downloader -> Wenku8Client -> HttpClient
                  -> ImageStore
                  -> BookWorkspace
                  -> EpubBuilder
```

站点解析、网络调度、可恢复存储、图片处理和 EPUB 构建相互独立。站点页面结构变化时，应只调整 `src/site` 及其解析测试。

## 项目治理

本仓库以代码为已实现行为的事实依据。规格生命周期、PR 流程和 ADR 约定见 [项目治理约定](docs/governance.md)，当前模块与关键边界见 [架构概览](docs/architecture/overview.md)。编码 Agent 可从 [AGENTS.md](AGENTS.md) 获取导航。

## Docker

```bash
docker build -t wenku8 .
docker run --rm -it -v "$PWD/downloads:/books" -v "<用户配置目录>:/root/.config/wenku8" wenku8 download 1973 -w /books -o /books
```

先在有图形界面的宿主机执行 `wenku8 login`，再将 `wenku8 config` 显示的配置目录挂载进容器。镜像运行环境不提供图形登录窗口；如站点要求重新验证，需要回到宿主机登录。挂载目录包含登录凭证。

## 版权

本工具仅提供技术上的内容下载与格式转换能力。请遵守来源站点条款及当地法律，并仅下载和使用你有权访问的内容。
