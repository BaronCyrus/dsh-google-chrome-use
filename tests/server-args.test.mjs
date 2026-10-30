import assert from 'node:assert/strict'
import test from 'node:test'

import { SERVER_ENV, buildServerArgs } from '../src/server-args.js'

const CONFIG = { toolset: 'standard', headless: false, executablePath: '', fileRoots: [], extraArgs: [] }

function args(target, config = {}) {
  return buildServerArgs({ cliPath: '/cli.js', target, config: { ...CONFIG, ...config }, userDataDir: 'C:\\Users\\Ada\\profile dir' })
}

test('the server script comes first, so Node runs it', () => {
  assert.equal(args('dedicated')[0], '/cli.js')
})

test('nothing is reported to Google, on either target', () => {
  for (const target of ['dedicated', 'my_chrome']) {
    const list = args(target)
    assert.ok(list.includes('--no-usage-statistics'))
    assert.ok(list.includes('--no-performance-crux'))
    assert.ok(list.includes('--redactNetworkHeaders'))
  }
  assert.equal(SERVER_ENV.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1')
  assert.equal(SERVER_ENV.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1')
})

test('Electron runs the server as plain Node', () => {
  assert.equal(SERVER_ENV.ELECTRON_RUN_AS_NODE, '1')
})

test('the dedicated browser keeps its own profile, and a path with spaces stays one argument', () => {
  const list = args('dedicated')
  assert.ok(list.includes('--userDataDir=C:\\Users\\Ada\\profile dir'))
  assert.ok(list.includes('--headless=false'))
  assert.ok(!list.includes('--autoConnect'))
  assert.ok(args('dedicated', { headless: true }).includes('--headless=true'))
})

test('my_chrome attaches to the running Chrome and never launches or points at a profile', () => {
  const list = args('my_chrome', { executablePath: '/chrome' })
  assert.ok(list.includes('--autoConnect'))
  assert.ok(list.includes('--fileNavigations=false'))
  assert.ok(!list.some(item => item.startsWith('--userDataDir')))
  assert.ok(!list.some(item => item.startsWith('--headless')))
  assert.ok(!list.some(item => item.startsWith('--executablePath')))
})

test('a custom Chrome only applies to the dedicated browser', () => {
  assert.ok(args('dedicated', { executablePath: '/chrome' }).includes('--executablePath=/chrome'))
})

test('toolsets select the server categories', () => {
  const standard = args('dedicated')
  for (const flag of ['--categoryPerformance=false', '--categoryEmulation=false', '--categoryMemory=false']) assert.ok(standard.includes(flag))
  assert.ok(args('dedicated', { toolset: 'slim' }).includes('--slim'))
  assert.ok(!args('dedicated', { toolset: 'full' }).some(flag => flag.startsWith('--category')))
})

test('file roots and extra arguments reach the server', () => {
  const list = args('dedicated', { fileRoots: ['/a', '/b c'], extraArgs: ['--blockedUrlPattern=*://x/*'] })
  assert.ok(list.includes('--filesystemRoot=/a'))
  assert.ok(list.includes('--filesystemRoot=/b c'))
  assert.equal(list.at(-1), '--blockedUrlPattern=*://x/*')
})
