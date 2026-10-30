/**
 * dsh-google-chrome-use: Google Chrome for DeepSeek Harness, through Chrome DevTools MCP.
 *
 * The plugin registers one tool, chrome_use. Calling it starts the MCP server
 * and publishes the browser tools through DSH's own MCP client, so screenshots
 * and tool results follow the normal paths, and a session that never needs a
 * browser carries none of those tool definitions.
 */

import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { currentHost, dedicatedProfileDir, findChrome, openRemoteDebuggingPage, probeMyChrome } from './platform.js'
import { ChromeSession } from './session.js'

export const name = 'dsh-google-chrome-use'

export const inject = ['tools']

export const Config = Schema.object({
  defaultTarget: Schema.union([
    Schema.const('dedicated').description('独立 Chrome（Dedicated profile）'),
    Schema.const('my_chrome').description('我正在用的 Chrome（My Chrome）'),
  ]).default('dedicated').description('未指定时连接哪个 Chrome。Which Chrome to use when a task does not say.'),
  allowMyChrome: Schema.boolean().default(true).description('允许连接你正在用的 Chrome，它带着你的登录状态和打开的标签页。Allow connecting to the Chrome you use, with your logins and open tabs.'),
  askBeforeNewSite: Schema.boolean().default(true).description('在你的 Chrome 里第一次打开某个网站前先询问；完全访问模式下 DSH 不询问。Ask before opening a site for the first time in your Chrome; DSH never asks in full access mode.'),
  headless: Schema.boolean().default(false).description('独立 Chrome 不显示窗口。Run the dedicated profile without a window.'),
  userDataDir: Schema.string().default('').description('独立 Chrome 的配置目录，登录状态保存在这里；留空用 DSH 数据目录下的 chrome-use。Dedicated profile directory, where its logins are kept.'),
  executablePath: Schema.string().default('').description('Chrome 可执行文件；留空自动查找。Chrome executable; empty finds it automatically.'),
  toolset: Schema.union([
    Schema.const('standard').description('标准：操作、导航、调试、网络（Standard）'),
    Schema.const('slim').description('精简：只有导航、脚本和截图（Slim）'),
    Schema.const('full').description('完整：再加性能、内存和设备模拟（Full）'),
  ]).default('standard').description('提供给模型的浏览器工具。Which browser tools the model gets.'),
  fileRoots: Schema.array(String).default([]).description('除系统临时目录外，还允许 upload_file 读取的目录。Directories upload_file may read besides the system temp directory.'),
  toolCallTimeoutSeconds: Schema.number().min(10).default(180).description('单次浏览器操作的超时秒数；第一次操作要等你在 Chrome 里点允许。Timeout of one browser action; the first one waits for you to click Allow in Chrome.'),
  extraArgs: Schema.array(String).default([]).description('传给 chrome-devtools-mcp 的额外参数，例如 --blockedUrlPattern=*://*.example.com/*。Extra chrome-devtools-mcp arguments.'),
})

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    target: { type: 'string', required: true },
    message: { type: 'string', required: true },
    reason: { type: 'string' },
    guide: { type: 'string' },
  },
}

export function apply(ctx, config) {
  const host = currentHost()
  const session = new ChromeSession({
    config,
    cliPath: fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')),
    mount: ({ args, env, toolCallTimeoutMs }) => mountServer(ctx, { args, env, toolCallTimeoutMs }),
    platform: {
      findChrome: () => findChrome(host),
      probeMyChrome: () => probeMyChrome(host),
      openRemoteDebuggingPage: chromePath => openRemoteDebuggingPage(host, chromePath),
      dedicatedProfileDir: () => dedicatedProfileDir(host),
      tempDir: tmpdir,
    },
    sleep,
  })

  ctx.tools.register(defineTool({
    name: 'chrome_use',
    description: 'Use Google Chrome on this computer: open websites, read pages, click, type, fill forms, upload files, take screenshots. '
      + 'Call this before any task that needs a real browser. It connects Chrome, adds the mcp__chrome__* browser tools from your next step on, and returns how to use them. '
      + 'target=dedicated is a separate Chrome profile that keeps its own logins. '
      + 'target=my_chrome is the Chrome the user is already using, with their accounts: use it only when the task needs those accounts or the user asks for it. '
      + `Without a target this uses ${config.defaultTarget}. action=status reports the connection, and action=stop closes it.`,
    parameters: {
      action: { type: 'string', enum: ['start', 'status', 'stop'], description: 'Defaults to start.' },
      target: { type: 'string', enum: ['dedicated', 'my_chrome'], description: 'Which Chrome to connect.' },
    },
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args) {
      if (args.action === 'status') return session.status()
      if (args.action === 'stop') return session.stop()
      return session.start(args.target)
    },
  }))

  // Only an explicit navigation can be checked here; a click can still follow a
  // link to another site, which is why this does not replace the guide's rules.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const site = session.siteToApprove(exec.name, exec.arguments)
    if (site === undefined || !canAskUser(ctx, exec)) return next()
    return {
      kind: 'ask',
      reason: `Open ${site} in the user's own Chrome, where they are logged in.`,
      displayReason: {
        en: `Open ${site} in your own Chrome, where you are logged in? Once allowed, this connection will not ask about this site again.`,
        zh: `在你自己的 Chrome（带着登录状态）里打开 ${site}？允许后，本次连接不再询问这个网站。`,
      },
    }
  })
  ctx.on('tools/execute', async (exec, next) => {
    session.noteSiteApproved(exec.name, exec.arguments)
    return next()
  })
}

/** In a session whose user chose not to be asked, an ask would just be refused. */
function canAskUser(ctx, exec) {
  return exec.agent !== undefined && ctx.get('approval')?.effectivePolicy(exec.agent.session) === 'ask'
}

/**
 * Start the server under this plugin's fiber, so unloading the plugin also
 * stops the server and closes the browser it launched.
 */
async function mountServer(ctx, { args, env, toolCallTimeoutMs }) {
  const fiber = ctx.plugin(McpClient, McpClient.Config({
    transport: 'stdio',
    serverName: 'chrome',
    command: process.execPath,
    args,
    env,
    toolCallTimeoutMs,
    failOnStartupError: true,
  }))
  try {
    await fiber
  } catch (error) {
    await fiber.dispose()
    throw error
  }
  return fiber
}

function renderResult({ status, target, reason, message, guide }) {
  const head = reason === undefined ? `[${status}, ${target}]` : `[${status}: ${reason}, ${target}]`
  return guide === undefined ? `${head} ${message}` : `${head} ${message}\n\n${guide}`
}
