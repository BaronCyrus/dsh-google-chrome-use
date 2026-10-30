import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Config, apply, inject, name } from '../src/index.js'
import { chromeUserDataDir } from '../src/platform.js'

/** The parts of a Cordis context the plugin touches, with the tool registry recording. */
function fakeContext({ approval } = {}) {
  const tools = new Map()
  const plugins = []
  const listeners = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    on: (event, listener) => listeners.set(event, listener),
    get: name => (name === 'approval' ? approval : undefined),
    plugin(plugin, config) {
      plugins.push({ plugin, config })
      const fiber = Promise.resolve()
      fiber.dispose = async () => {}
      return fiber
    },
  }
  return { ctx, tools, plugins, listeners }
}

test('the package loads as a DSH bundle row', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, new RegExp(`name: '${manifest.name}'`))
  assert.equal(name, manifest.name)
  assert.deepEqual(inject, ['tools'])
  assert.equal(manifest.dependencies['chrome-devtools-mcp'], '1.12.0')
})

test('the default settings are the safe ones', () => {
  const config = Config({})
  assert.equal(config.defaultTarget, 'dedicated')
  assert.equal(config.headless, false)
  assert.equal(config.toolset, 'standard')
  assert.deepEqual(config.fileRoots, [])
})

test('only chrome_use is registered until a task asks for the browser', () => {
  const { ctx, tools, plugins } = fakeContext()
  apply(ctx, Config({}))
  assert.deepEqual([...tools.keys()], ['chrome_use'])
  assert.equal(plugins.length, 0)
})

test('the tool explains itself and offers both browsers', () => {
  const { ctx, tools } = fakeContext()
  apply(ctx, Config({ defaultTarget: 'my_chrome' }))
  const tool = tools.get('chrome_use')
  assert.match(tool.description, /Without a target this uses my_chrome/)
  const schema = JSON.stringify(tool.parameters)
  assert.match(schema, /dedicated/)
  assert.match(schema, /my_chrome/)
})

test('status reports without starting anything, and results render for the model', async () => {
  const { ctx, tools, plugins } = fakeContext()
  apply(ctx, Config({}))
  const tool = tools.get('chrome_use')
  assert.equal((await tool.execute({ action: 'status' }, {})).status, 'stopped')
  assert.equal(plugins.length, 0)
  const [content] = tool.output.render({}, { status: 'ready', target: 'dedicated', message: 'Connected.', guide: 'How to.' })
  assert.equal(content.text, '[ready, dedicated] Connected.\n\nHow to.')
  const [blocked] = tool.output.render({}, { status: 'needs_user_action', reason: 'chrome_missing', target: 'dedicated', message: 'Install it.' })
  assert.equal(blocked.text, '[needs_user_action: chrome_missing, dedicated] Install it.')
})

test('starting mounts DSH\'s MCP client on the Node that runs DSH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chrome-use-plugin-'))
  try {
    const { ctx, tools, plugins } = fakeContext()
    apply(ctx, Config({ userDataDir: join(dir, 'profile'), executablePath: process.execPath, headless: true }))
    const tool = tools.get('chrome_use')
    const value = await tool.execute({}, {})
    assert.equal(value.status, 'ready')
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].plugin.name, 'mcp-client')
    const { transport, serverName, command, args, env, failOnStartupError, toolCallTimeoutMs } = plugins[0].config
    assert.equal(transport, 'stdio')
    assert.equal(serverName, 'chrome')
    assert.equal(command, process.execPath)
    assert.match(args[0], /chrome-devtools-mcp\.js$/)
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(failOnStartupError, true)
    assert.equal(toolCallTimeoutMs, 180_000)
    assert.equal((await tool.execute({ action: 'status' }, {})).target, 'dedicated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A plugin connected to a fake user's Chrome, with its port file and a listening port. */
async function connectedToMyChrome(t, approval) {
  const home = await mkdtemp(join(tmpdir(), 'chrome-use-gate-'))
  const server = createServer(socket => socket.destroy()).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const dir = chromeUserDataDir({ platform: process.platform, env: { ...process.env, LOCALAPPDATA: join(home, 'AppData', 'Local') }, home })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/x\n`)
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') })
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  })
  const { ctx, tools, listeners } = fakeContext({ approval })
  apply(ctx, Config({ executablePath: process.execPath }))
  const result = await tools.get('chrome_use').execute({ target: 'my_chrome' }, {})
  assert.equal(result.status, 'ready')
  return { preExecute: listeners.get('tools/pre-execute'), execute: listeners.get('tools/execute') }
}

const allow = async () => ({ kind: 'allow' })
const navigation = { name: 'mcp__chrome__new_page', arguments: { url: 'https://mail.example.com/' }, agent: { session: {} } }

test('a new site in the user\'s Chrome goes to DSH\'s approval, once', async (t) => {
  const { preExecute, execute } = await connectedToMyChrome(t, { effectivePolicy: () => 'ask' })
  const decision = await preExecute(navigation, allow)
  assert.equal(decision.kind, 'ask')
  assert.match(decision.displayReason.zh, /mail\.example\.com/)
  assert.match(decision.displayReason.en, /mail\.example\.com/)

  await execute(navigation, async () => ({}))
  assert.equal((await preExecute(navigation, allow)).kind, 'allow')
})

test('a rejected site is asked about again', async (t) => {
  const { preExecute } = await connectedToMyChrome(t, { effectivePolicy: () => 'ask' })
  assert.equal((await preExecute(navigation, allow)).kind, 'ask')
  assert.equal((await preExecute(navigation, allow)).kind, 'ask')
})

test('a session that asks nothing, like full access, is not blocked', async (t) => {
  const { preExecute } = await connectedToMyChrome(t, { effectivePolicy: () => 'never' })
  assert.equal((await preExecute(navigation, allow)).kind, 'allow')
})

test('a host without approvals is not blocked', async (t) => {
  const { preExecute } = await connectedToMyChrome(t, undefined)
  assert.equal((await preExecute(navigation, allow)).kind, 'allow')
})
