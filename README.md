# Chrome Use：给 DeepSeek Harness 一个真实的 Chrome

[English](README.en.md)

让 DSH 的模型使用你电脑上的 Google Chrome：打开网页、读内容、点击、填表、选下拉、上传文件、处理弹窗、截图。支持 macOS 和 Windows。

底层是 Chrome 官方的 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)。这个插件负责把它接进 DSH：按需加载、连接哪个 Chrome、不同系统上的路径、隐私默认值和按网站询问。

## 两种用法

| | 独立 Chrome（默认） | 我的 Chrome |
| --- | --- | --- |
| 是什么 | 单独的 Chrome 配置，在这里登录过的账号下次还在 | 你正在用的那个 Chrome，带着全部登录状态和标签页 |
| 适合 | 查资料、测网页、只交给模型特定账号 | 需要用你已登录的账号时 |
| 准备工作 | 不用准备 | Chrome 144 或更新版本，勾选一次，每次连接时点一次允许 |

需要哪种直接说就行，模型会自己选：

```text
用 Chrome 打开 example.com，告诉我页面标题
用我自己的 Chrome 看看 GitHub 上有没有新通知
```

不需要 Chrome 扩展，也不用安装别的东西。

## 安装

先[安装 Google Chrome](https://www.google.com/chrome/)。

这个插件还没有发布到 npm。npm 上同名的 `dsh-chrome-use` 是另一个项目，不要用这个名字安装。

在插件目录运行 `pnpm pack` 得到安装包，再从本地安装：

```bash
dsh plugin --profile web add /绝对路径/dsh-chrome-use-0.1.0.tgz
```

重启 DSH 后生效。本地开发时，先在插件目录运行 `pnpm install`，再用 `link:/插件目录的绝对路径` 安装。

## 连接你正在用的 Chrome

第一次让模型用你的 Chrome 时：

1. 插件会在 Chrome 里打开 `chrome://inspect/#remote-debugging`。
2. 勾选 **Allow remote debugging for this browser instance**，然后告诉模型继续。
3. 模型开始操作时，Chrome 会弹窗询问是否允许连接，点 **Allow**。
4. 模型第一次打开某个网站时，DSH 会询问你。完全访问模式下 DSH 不询问。

**macOS：** 如果模型说系统不让读取 Chrome 的文件夹，到「系统设置 → 隐私与安全性 → 文件和文件夹」里，允许 DeepSeek Harness 访问 Google Chrome。

连接你的 Chrome 后，模型能看到这个 Chrome 配置里的所有标签页。使用前请读 [SECURITY.md](SECURITY.md)。

## 配置

插件页目前没有配置表单。需要改配置时，在 profile 的 `cordis.patch.yml` 里加一行（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`），改完重启 DSH：

```yaml
- id: chrome-use
  name: dsh-chrome-use
  config:
    userDataDir: /Volumes/外置盘/chrome-profile
```

这种写法会替换整行配置，没写的项用默认值。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `defaultTarget` | `dedicated` | 模型没指定时用哪个 Chrome，可选 `dedicated`、`my_chrome` |
| `allowMyChrome` | `true` | 是否允许连接你的 Chrome |
| `askBeforeNewSite` | `true` | 在你的 Chrome 里第一次打开某网站时是否询问。headless 模式没人能回答，会拒绝新网站，无人值守时要关掉 |
| `headless` | `false` | 独立 Chrome 不显示窗口 |
| `userDataDir` | DSH 数据目录下的 `chrome-use/chrome-profile` | 独立 Chrome 的配置目录，可能有几百 MB |
| `executablePath` | 自动查找 | Chrome 不在默认位置时指定 |
| `toolset` | `standard` | `standard` 26 个工具，`slim` 3 个，`full` 再加性能、内存和设备模拟 |
| `fileRoots` | `[]` | 除系统临时目录外，还允许上传和保存文件的目录 |
| `toolCallTimeoutSeconds` | `180` | 单次操作的超时秒数，第一次操作要等你点允许 |
| `extraArgs` | `[]` | 传给 chrome-devtools-mcp 的额外参数，比如 `--blockedUrlPattern=*://*.bank.example/*` |

## 费用

没调用 `chrome_use` 时，只多一个工具定义。调用之后这个 DSH 进程里的会话都会带上浏览器工具，`standard` 约 6000 token，每次请求都算（通常有缓存）。大网页的快照可能有一两万 token。用不到时可以让模型调用 `chrome_use` 的 `action=stop` 断开。

如果模型不支持图片，截图会看不到，但它仍能靠页面快照工作。

## 常见问题

**提示浏览器已经在运行：** 另一个 DSH 窗口正在用独立配置。关掉它，或者让那边断开。

**第一次操作超时：** Chrome 的 Allow 弹窗没点。点完让模型再试一次。

**多个会话同时用：** 同一个 DSH 进程里的会话共用一个浏览器连接。切换目标会影响所有会话。

**Chrome 和 Edge：** 上游只正式支持 Google Chrome。其他 Chromium 浏览器可以用 `executablePath` 试，但不保证能用。

## 开发

```bash
pnpm install
pnpm run check
node scripts/e2e-dsh.mjs
```

- `pnpm run check`：单元测试，加上用真实无头 Chrome 跑的冒烟测试。
- `scripts/e2e-dsh.mjs`：在真实的 DSH 里跑完整流程，用脚本扮演模型，不需要账号。

## 致谢

浏览器能力全部来自 Google Chrome DevTools 团队的 chrome-devtools-mcp（Apache-2.0）。本项目与 Google 无关。

## 许可证

MIT
