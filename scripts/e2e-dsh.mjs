/**
 * Run the whole plugin inside a real DSH process, with no model account: a
 * scripted OpenAI-compatible server plays the model, while DSH, the plugin, the
 * MCP server and Chrome are all real. Everything lives in a throwaway DSH_HOME.
 *
 *   node scripts/e2e-dsh.mjs
 *   node scripts/e2e-dsh.mjs --headed
 *   DSH_E2E_COMMAND='["/path/to/dsh"]' node scripts/e2e-dsh.mjs
 *
 * It checks that the browser tools stay hidden until chrome_use is called, that
 * they appear on the next step of the same turn, and that a form can be filled
 * and a screenshot read back through them. my_chrome runs against a separate
 * Chrome started under a fake home directory, so it never touches the Chrome of
 * whoever runs this; that one debugs through a port, so Chrome's Allow dialog
 * is the part it cannot cover. Chrome has no window unless --headed asks for
 * one, which leaves the plugin on its default.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { chromeUserDataDir, currentHost, findChrome } from '../src/platform.js'

const { values: { headed } } = parseArgs({ options: { headed: { type: 'boolean', default: false } } })

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const RUN_TIMEOUT_MS = 240_000
const MARKER = 'E2E-RESULT'

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>E2E 表单</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('out').textContent='提交成功:'+document.getElementById('name').value">
<label for="name">姓名</label><input id="name"><button type="submit">提交</button></form><p id="out"></p></body></html>`

function dshCommand() {
  if (process.env.DSH_E2E_COMMAND) return JSON.parse(process.env.DSH_E2E_COMMAND)
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim()
  return [process.execPath, join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

/** What the scripted model does next, given the tool results so far. */
function nextStep(target, url, results) {
  const page = () => Number(/(\d+): .*\[selected\]/.exec(results.join('\n'))?.[1])
  const uid = (pattern) => {
    const match = pattern.exec(results.at(-1))
    assert.ok(match, `${pattern} not found in: ${results.at(-1)}`)
    return match[1]
  }
  switch (results.length) {
    case 0: return { tool: 'chrome_use', args: { target } }
    case 1: return { tool: 'mcp__chrome__new_page', args: { url } }
    case 2: return { tool: 'mcp__chrome__take_snapshot', args: { pageId: page() } }
    case 3: return { tool: 'mcp__chrome__fill', args: { pageId: page(), uid: uid(/uid=(\S+) textbox "姓名"/), value: '张三' } }
    case 4: return { tool: 'mcp__chrome__take_snapshot', args: { pageId: page() } }
    case 5: return { tool: 'mcp__chrome__click', args: { pageId: page(), uid: uid(/uid=(\S+) button "提交"/) } }
    case 6: return { tool: 'mcp__chrome__evaluate_script', args: { pageId: page(), function: '() => document.getElementById("out").textContent' } }
    case 7: return { tool: 'mcp__chrome__take_screenshot', args: { pageId: page() } }
    case 8: return { tool: 'mcp__chrome__evaluate_script', args: { pageId: page(), function: '() => navigator.userAgent' } }
    default: return { text: `${MARKER}: ${/提交成功:\S+?"/.exec(results.join('\n'))?.[0] ?? 'no result'}` }
  }
}

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

/**
 * Whether a Chrome is running on this profile: it holds this file until it exits.
 * On macOS the file is a symlink to nowhere, which existsSync cannot see.
 */
function chromeHoldsProfile(profileDir) {
  const lock = join(profileDir, process.platform === 'win32' ? 'lockfile' : 'SingletonLock')
  return lstatSync(lock, { throwIfNoEntry: false }) !== undefined
}

/** The fake model. It records every request made with the tool list of an agent turn. */
function fakeModel(target, pageUrl, profileDir) {
  const turns = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.statusCode = 404
      response.end('{}')
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (part) => { body += part })
    request.on('end', () => {
      const payload = JSON.parse(body)
      const tools = (payload.tools ?? []).map(tool => tool.function.name)
      response.setHeader('content-type', 'text/event-stream')
      // Title generation and the like run without the agent's tools.
      if (!tools.includes('chrome_use')) {
        response.end(`${chunk({ role: 'assistant', content: 'Chrome test' })}${chunk({}, 'stop')}data: [DONE]\n\n`)
        return
      }
      const results = payload.messages.filter(message => message.role === 'tool').map(message => textOf(message.content))
      const sawImage = JSON.stringify(payload.messages).includes('"image_url"')
      let step
      try {
        step = nextStep(target, pageUrl, results)
      } catch (error) {
        step = { text: `${MARKER}: script failed: ${error.message}` }
      }
      turns.push({ tools, results, sawImage, step, chromeRunning: chromeHoldsProfile(profileDir) })
      if (step.text) {
        response.end(`${chunk({ role: 'assistant', content: step.text })}${chunk({}, 'stop')}data: [DONE]\n\n`)
        return
      }
      const call = { index: 0, id: `call_${results.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }
      response.end(`${chunk({ role: 'assistant', content: null, tool_calls: [call] })}${chunk({}, 'tool_calls')}data: [DONE]\n\n`)
    })
  })
  return { server, turns }
}

function run(command, args, env, cwd, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (part) => { stdout += part })
    child.stderr.on('data', (part) => { stderr += part })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`dsh ${args.join(' ')} timed out\n--- stdout\n${stdout}\n--- stderr\n${stderr}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return check()
}

/** Point a Chrome at the folder a fake user's Chrome would use, with debugging on. */
function startExistingChrome(fakeHome, pageUrl) {
  const host = { platform: process.platform, env: fakeUserEnv(fakeHome), home: fakeHome }
  const userDataDir = chromeUserDataDir(host)
  const chrome = spawn(findChrome(currentHost()), [
    ...(headed ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check', '--use-mock-keychain',
    '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, pageUrl,
  ], { stdio: 'ignore' })
  return { chrome, portFile: join(userDataDir, 'DevToolsActivePort') }
}

function fakeUserEnv(fakeHome) {
  return { HOME: fakeHome, USERPROFILE: fakeHome, LOCALAPPDATA: join(fakeHome, 'AppData', 'Local') }
}

async function scenario(target, command) {
  console.log(`--- ${target} ---`)
  const home = await mkdtemp(join(tmpdir(), 'chrome-use-e2e-'))
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(PAGE)
  })
  const pageUrl = `http://127.0.0.1:${await listen(site)}/`
  const dshHome = join(home, 'dsh')
  const dedicatedProfile = join(dshHome, 'chrome-use', 'chrome-profile')
  const { server: model, turns } = fakeModel(target, pageUrl, dedicatedProfile)
  const modelPort = await listen(model)

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    E2E_FAKE_MODEL_KEY: 'not-a-real-key',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  const taskEnv = target === 'my_chrome' ? { ...env, ...fakeUserEnv(home) } : env

  const patchFile = join(home, 'e2e.patch.yml')
  await writeFile(patchFile, `
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      e2e:
        apiKeyEnv: E2E_FAKE_MODEL_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        models:
          - id: e2e-model
            name: E2E model
            contextWindow: 200000
            maxTokens: 4096
            input: [text, image]
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: e2e
    model: e2e-model
# Nobody can answer an approval in a headless run, so it would refuse every new site.
- id: chrome-use
  name: dsh-google-chrome-use
  config:${headed ? '' : `
    headless: true`}
    askBeforeNewSite: false
`)

  let existing
  try {
    const version = await run(command, ['--version'], env, home)
    console.log(`dsh: ${version.stdout.trim()} on ${process.platform}`)

    const init = await run(command, ['--profile', 'headless', '--dump-config'], env, home)
    assert.equal(init.code, 0, init.stderr)

    const add = await run(command, ['plugin', '--profile', 'headless', 'add', process.env.DSH_E2E_PLUGIN ?? `link:${PLUGIN_DIR.replace(/[\\/]$/, '')}`], env, home)
    assert.equal(add.code, 0, `plugin add failed\n${add.stdout}\n${add.stderr}`)

    const dump = await run(command, ['--profile', 'headless', '--patch', patchFile, '--dump-config'], env, home)
    assert.equal(dump.code, 0, dump.stderr)
    assert.match(dump.stdout, /# == dsh-google-chrome-use/)
    console.log('plugin: installed, and its bundle layer is in the profile')

    if (target === 'my_chrome') {
      existing = startExistingChrome(home, pageUrl)
      assert.ok(await waitUntil(() => existsSync(existing.portFile), 30_000), 'the existing Chrome did not open its debugging port')
    }

    const task = await run(command, ['--profile', 'headless', '--patch', patchFile, 'Fill in the test form and report the result.'], taskEnv, home)
    if (process.env.DSH_E2E_VERBOSE) console.log(`--- stdout\n${task.stdout}\n--- stderr\n${task.stderr}`)
    assert.equal(task.code, 0, `the task failed\n--- stdout\n${task.stdout}\n--- stderr\n${task.stderr}`)

    assert.ok(turns.length >= 10, `the agent stopped after ${turns.length} steps\n${task.stdout}\n${task.stderr}`)
    const first = turns[0]
    assert.ok(first.tools.includes('chrome_use'), 'chrome_use should be offered from the start')
    assert.ok(!first.tools.some(tool => tool.startsWith('mcp__chrome__')), 'browser tools should stay hidden until chrome_use runs')
    console.log(`step 1: ${first.tools.length} tools, chrome_use offered, no browser tools`)

    const second = turns[1]
    const revealed = second.tools.filter(tool => tool.startsWith('mcp__chrome__'))
    assert.ok(revealed.includes('mcp__chrome__take_snapshot'), 'browser tools should appear on the next step')
    assert.match(second.results[0], new RegExp(`\\[ready, ${target}\\]`))
    assert.match(second.results[0], /take_snapshot/)
    console.log(`step 2: ${revealed.length} browser tools appeared, and the guide arrived`)

    const last = turns.at(-1)
    assert.match(last.results.join('\n'), /提交成功:张三/)
    // DSH 0.1's headless profile has no attachment store, so it withholds images.
    if (version.stdout.startsWith('0.1.')) console.log(`screenshot: ${last.sawImage ? 'reached the model' : 'withheld by this DSH version'}`)
    else assert.ok(last.sawImage, 'the screenshot should reach the model as an image')
    assert.match(task.stdout, new RegExp(`${MARKER}: 提交成功:张三`))
    console.log('form: filled and submitted through DSH')

    const userAgent = last.results.at(-1)
    assert.equal(userAgent.includes('HeadlessChrome'), !headed, `headed is ${headed}, and the user agent says: ${userAgent}`)
    console.log(`mode: ${headed ? 'with a window' : 'no window'}`)

    if (target === 'my_chrome') {
      assert.equal(existing.chrome.exitCode, null, 'disconnecting must leave the user\'s Chrome running')
      assert.match(turns[2].results[1], new RegExp(pageUrl.replace(/[/.]/g, '\\$&')), 'the existing tab should be visible')
      console.log('cleanup: the existing Chrome kept running after DSH exited, with its own tab visible')
    } else {
      assert.ok(last.chromeRunning, 'Chrome should hold its profile while the agent works')
      assert.ok(await waitUntil(() => !chromeHoldsProfile(dedicatedProfile), 20_000), 'Chrome should close when DSH exits')
      console.log('cleanup: Chrome closed when DSH exited')
    }
    console.log(`${target} PASSED`)
    return true
  } catch (error) {
    console.error(`${target} FAILED: ${error.stack}`)
    for (const [index, turn] of turns.entries()) {
      console.error(`  step ${index + 1}: ${JSON.stringify(turn.step).slice(0, 200)} | last result: ${(turn.results.at(-1) ?? '').slice(0, 300)}`)
    }
    return false
  } finally {
    existing?.chrome.kill()
    site.close()
    model.close()
    // Chrome may hold its profile briefly after exiting, on Windows especially.
    await new Promise(resolve => setTimeout(resolve, 1000))
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {})
  }
}

const command = dshCommand()
const passed = []
for (const target of ['dedicated', 'my_chrome']) passed.push(await scenario(target, command))
if (passed.every(Boolean)) console.log('E2E PASSED')
else process.exitCode = 1
