# Chrome Use：给 DeepSeek Harness 一个真实的 Chrome

[English](README.en.md)

让 DSH 的模型使用你电脑上的 Google Chrome：打开网页、读内容、点击、填表、选下拉、上传文件、处理弹窗、截图。支持 macOS 和 Windows。

底层是 Chrome 官方的 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)。这个插件负责把它接进 DSH：按需加载、连接哪个 Chrome、不同系统上的路径、隐私默认值和按网站询问。

## 两种用法

| | 独立 Chrome（默认） | 我的 Chrome |
| --- | --- | --- |
| 是什么 | 单独的 Chrome 配置，在这里登录过的账号下次还在 | 你正在用的那个 Chrome，带着全部登录状态和标签页 |
| 适合 | 查资料、测网页、只交给模型特定账号 | 需要用你已登录的账号时 |
| 准备工作 | 不用准备 | Chrome 144 或更新版本，勾选一次，macOS 还要开一次文件夹权限，连接时点允许 |

需要哪种直接说就行，模型会自己选：

```text
用 Chrome 打开 example.com，告诉我页面标题
用我自己的 Chrome 看看 GitHub 上有没有新通知
```

不需要 Chrome 扩展，也不用安装别的东西。

## 安装

先准备好 [Google Chrome](https://www.google.com/chrome/) 和 DeepSeek Harness 桌面版（0.2.1 及以上的 0.2.x 版本）。

1. 打开桌面应用的**插件**页，点击**添加插件**，在**包名或地址**中填入：

   ```text
   dsh-google-chrome-use@0.1.0
   ```

   安装源选择**官方源**，点击**安装**。新版本刚发布的 24 小时内，DSH 的 pnpm 会因为发布冷却期暂缓安装，所以请带上版本号。

2. **完全退出并重新打开** DSH 桌面应用。只刷新页面不会加载 Host 端的新插件。

3. 在对话里说「用 Chrome 打开 example.com，告诉我页面标题」试试。

<details>
<summary>命令行和自建 profile</summary>

```bash
dsh plugin --profile web add dsh-google-chrome-use@0.1.0
```

不要对 `desktop` profile 使用这条命令，桌面版请走插件页。DSH 0.1.5 的 headless 模式没有附件存储，模型收不到截图，其他功能正常。

</details>

## 连接你正在用的 Chrome

第一次让模型用你的 Chrome 时，按它的提示做这几步：

1. **只有 macOS 需要：** 到「系统设置 → 隐私与安全性 → 文件与文件夹」，在 DeepSeek Harness 下面打开 Google Chrome（用命令行版时是你的终端程序）。不开的话插件读不到 Chrome 的文件夹，macOS 也不会主动弹窗询问。
2. 插件会在 Chrome 里打开 `chrome://inspect/#remote-debugging`。勾选 **Allow remote debugging for this browser instance**，然后告诉模型继续。
3. 模型开始操作时，Chrome 会弹窗询问是否允许连接，点 **Allow**。
4. 模型第一次打开某个网站时，DSH 会询问你。完全访问模式下 DSH 不询问。

连接后，模型每次打开页面都会收到所有标签页的标题和网址，这些内容会发给你配置的模型服务。使用前请读 [SECURITY.md](SECURITY.md)。

## 配置

插件页目前没有配置表单。需要改配置时，在 profile 的 `cordis.patch.yml` 里加一行（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`），改完重启 DSH：

```yaml
- id: chrome-use
  name: dsh-google-chrome-use
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
