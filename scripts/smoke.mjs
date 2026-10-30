/**
 * Drive real Chrome through the same server command the plugin starts, in a
 * throwaway profile with no window. Runs the same on macOS and Windows:
 *
 *   node scripts/smoke.mjs
 *
 * It needs Google Chrome and no DSH, model or credentials.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentHost, findChrome } from '../src/platform.js'
import { SERVER_ENV, buildServerArgs } from '../src/server-args.js'

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>冒烟测试</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('out').textContent='提交:'+document.getElementById('name').value+'/'+document.getElementById('city').value+'/'+document.getElementById('agree').checked">
<label for="name">姓名</label><input id="name">
<label for="city">城市</label><select id="city"><option value="">请选择</option><option value="sh">上海</option></select>
<label><input id="agree" type="checkbox">同意</label>
<button type="submit">提交</button></form><p id="out"></p>
<label for="file">附件</label><input id="file" type="file">
<label for="search">搜索</label><input id="search" onkeydown="if(event.key==='Enter')document.getElementById('entered').textContent='回车:'+this.value"><p id="entered"></p>
<button onclick="document.getElementById('asked').textContent=confirm('确定吗')?'确定':'取消'">弹窗</button><p id="asked"></p></body></html>`

const STEP_TIMEOUT_MS = 90_000

class McpServer {
  constructor(command, args, env) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    let buffer = ''
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk
      for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
        const line = buffer.slice(0, end).trim()
        if (line === '') continue
        const message = JSON.parse(line)
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      }
    })
    this.exited = new Promise(resolve => this.child.once('exit', code => resolve(code)))
  }

  request(method, params) {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out\n${this.stderr}`)), STEP_TIMEOUT_MS)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
    })
  }

  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.ok(!result.isError, `${name} failed: ${text}`)
    return { text, images: result.content.filter(block => block.type === 'image') }
  }
}

const chromePath = findChrome(currentHost())
assert.ok(chromePath, 'Google Chrome is not installed')
console.log(`platform: ${process.platform}, node: ${process.version}`)
console.log(`chrome: ${chromePath}`)

const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(PAGE)
}).listen(0, '127.0.0.1')
await new Promise(resolve => site.once('listening', resolve))
const url = `http://127.0.0.1:${site.address().port}/`

const profile = await mkdtemp(join(tmpdir(), 'chrome-use-smoke-'))
const config = { toolset: 'standard', headless: true, executablePath: '', fileRoots: [], extraArgs: [] }
const args = buildServerArgs({
  cliPath: fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')),
  target: 'dedicated',
  config,
  userDataDir: profile,
})
const server = new McpServer(process.execPath, args, SERVER_ENV)

try {
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-google-chrome-use-smoke', version: '0' },
  })
  server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version}`)

  const { tools } = await server.request('tools/list', {})
  const names = tools.map(tool => tool.name)
  for (const required of ['new_page', 'take_snapshot', 'fill', 'click', 'press_key', 'upload_file', 'handle_dialog', 'evaluate_script', 'take_screenshot']) {
    assert.ok(names.includes(required), `missing tool ${required}`)
  }
  assert.ok(!names.includes('performance_start_trace'), 'the standard toolset should leave performance tools out')
  console.log(`tools: ${names.length}, schema ${JSON.stringify(tools).length} chars`)

  const opened = await server.call('new_page', { url })
  const pageId = Number(/(\d+): .*\[selected\]/.exec(opened.text)?.[1])
  assert.ok(Number.isInteger(pageId), `no selected page in: ${opened.text}`)

  const snapshot = (await server.call('take_snapshot', { pageId })).text
  const uid = (pattern) => {
    const match = pattern.exec(snapshot)
    assert.ok(match, `${pattern} not in snapshot:\n${snapshot}`)
    return match[1]
  }
  await server.call('fill', { pageId, uid: uid(/uid=(\S+) textbox "姓名"/), value: '张三' })
  await server.call('fill', { pageId, uid: uid(/uid=(\S+) combobox "城市"/), value: '上海' })
  await server.call('click', { pageId, uid: uid(/uid=(\S+) checkbox "同意"/) })
  await server.call('click', { pageId, uid: uid(/uid=(\S+) button "提交"/) })
  const out = await server.call('evaluate_script', { pageId, function: '() => document.getElementById("out").textContent' })
  assert.match(out.text, /提交:张三\/sh\/true/)
  console.log('form: filled, selected, ticked and submitted')

  const script = source => server.call('evaluate_script', { pageId, function: `() => ${source}` })

  const upload = join(tmpdir(), `chrome-use-smoke-${process.pid}.txt`)
  await writeFile(upload, 'hello')
  await server.call('upload_file', { pageId, uid: uid(/uid=(\S+) (?:button|textbox) "附件/), filePaths: [upload] })
  await rm(upload)
  assert.match((await script('document.getElementById("file").files[0]?.name')).text, new RegExp(basename(upload).replace(/\./g, '\\.')))
  console.log('upload: a file from the system temp directory reached the page')

  const fresh = (await server.call('take_snapshot', { pageId })).text
  const freshUid = (pattern) => {
    const match = pattern.exec(fresh)
    assert.ok(match, `${pattern} not in snapshot:\n${fresh}`)
    return match[1]
  }
  await server.call('fill', { pageId, uid: freshUid(/uid=(\S+) textbox "搜索"/), value: '关键词' })
  await server.call('press_key', { pageId, key: 'Enter' })
  assert.match((await script('document.getElementById("entered").textContent')).text, /回车:关键词/)
  console.log('keyboard: Enter reached the page')

  await server.call('click', { pageId, uid: freshUid(/uid=(\S+) button "弹窗"/) })
  await server.call('handle_dialog', { pageId, action: 'accept' })
  assert.match((await script('document.getElementById("asked").textContent')).text, /确定/)
  console.log('dialog: accepted')

  const shot = await server.call('take_screenshot', { pageId })
  assert.equal(shot.images[0]?.mimeType, 'image/jpeg')
  console.log(`screenshot: ${shot.images[0].mimeType}, ${shot.images[0].data.length} base64 chars`)

  const saved = join(tmpdir(), `chrome-use-smoke-${process.pid}.jpeg`)
  await server.call('take_screenshot', { pageId, filePath: saved })
  assert.ok((await stat(saved)).size > 0)
  await rm(saved)
  console.log(`screenshot: saved under the path the guide names (${tmpdir()})`)

  server.child.stdin.end()
  const code = await Promise.race([server.exited, new Promise(resolve => setTimeout(() => resolve('still running'), 20_000))])
  assert.equal(code, 0, 'the server should exit once its client disconnects')
  console.log('server: exited with its client')
  console.log('SMOKE PASSED')
} catch (error) {
  console.error(`SMOKE FAILED: ${error.stack}\n--- server stderr ---\n${server.stderr}`)
  process.exitCode = 1
} finally {
  server.child.kill()
  site.close()
  // Chrome may hold its profile briefly after exiting, on Windows especially.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {})
}
