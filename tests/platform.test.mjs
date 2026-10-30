import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REMOTE_DEBUGGING_PAGE,
  browserEnv,
  chromeInstallPaths,
  chromeUserDataDir,
  dedicatedProfileDir,
  findChrome,
  openRemoteDebuggingPage,
  probeMyChrome,
} from '../src/platform.js'

const MAC = { platform: 'darwin', env: {}, home: '/Users/ada' }
const WINDOWS = {
  platform: 'win32',
  env: {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
  },
  home: 'C:\\Users\\Ada',
}

test('Chrome is looked for in the usual macOS places', () => {
  assert.deepEqual(chromeInstallPaths(MAC), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ])
})

test('Chrome is looked for in the system and per-user Windows places', () => {
  assert.deepEqual(chromeInstallPaths(WINDOWS), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ])
})

test('Windows paths fall back when the environment is sparse', () => {
  const host = { platform: 'win32', env: {}, home: 'C:\\Users\\Ada' }
  assert.equal(chromeInstallPaths(host)[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  assert.equal(chromeUserDataDir(host), 'C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\User Data')
})

test('findChrome returns the first installed location and nothing when none exists', () => {
  const secondOnly = file => file.includes('(x86)')
  assert.equal(findChrome(WINDOWS, secondOnly), 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')
  assert.equal(findChrome(WINDOWS, () => false), undefined)
})

test('the user data directory matches each system', () => {
  assert.equal(chromeUserDataDir(MAC), '/Users/ada/Library/Application Support/Google/Chrome')
  assert.equal(chromeUserDataDir(WINDOWS), 'C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\User Data')
})

test('the dedicated profile lives under the DSH data directory', () => {
  assert.equal(dedicatedProfileDir(MAC), '/Users/ada/.dsh/chrome-use/chrome-profile')
  assert.equal(dedicatedProfileDir(WINDOWS), 'C:\\Users\\Ada\\.dsh\\chrome-use\\chrome-profile')
  assert.equal(dedicatedProfileDir({ ...MAC, env: { DSH_HOME: '/data/dsh' } }), '/data/dsh/chrome-use/chrome-profile')
  assert.equal(dedicatedProfileDir({ ...MAC, env: { DSH_HOME: '  ' } }), '/Users/ada/.dsh/chrome-use/chrome-profile')
})

/** A host whose Chrome data folder is a temporary directory on this machine. */
async function hostWithPortFile(content) {
  const home = await mkdtemp(join(tmpdir(), 'chrome-use-'))
  const host = { platform: 'darwin', env: {}, home }
  if (content !== undefined) {
    const dir = chromeUserDataDir(host)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'DevToolsActivePort'), content)
  }
  return { host, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('no port file means debugging is off or Chrome is closed', async () => {
  const { host, cleanup } = await hostWithPortFile()
  try {
    assert.equal((await probeMyChrome(host)).state, 'not_enabled')
  } finally {
    await cleanup()
  }
})

test('a port file left by a crash does not count as ready', async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  const { host, cleanup } = await hostWithPortFile(`${port}\n/devtools/browser/abc\n`)
  try {
    assert.equal((await probeMyChrome(host)).state, 'not_enabled')
  } finally {
    await cleanup()
  }
})

test('a garbled port file does not count as ready', async () => {
  const { host, cleanup } = await hostWithPortFile('not a port\n')
  try {
    assert.equal((await probeMyChrome(host)).state, 'not_enabled')
  } finally {
    await cleanup()
  }
})

test('a listening port means Chrome accepts connections', async () => {
  const server = createServer(socket => socket.destroy()).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { host, cleanup } = await hostWithPortFile(`${server.address().port}\n/devtools/browser/abc\n`)
  try {
    assert.deepEqual(await probeMyChrome(host), { state: 'ready', port: server.address().port })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await cleanup()
  }
})

test('credentials and DSH variables stay out of the browser environment', () => {
  assert.deepEqual(
    browserEnv({ PATH: '/bin', Path: 'C:\\Windows', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'x', DSH_HOME: 'x', ELECTRON_RUN_AS_NODE: '1' }),
    { PATH: '/bin', Path: 'C:\\Windows' },
  )
})

function recordingSpawn() {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.unref = () => {}
    return child
  }
  return { calls, run }
}

test('macOS opens the page through the app bundle', () => {
  const { calls, run } = recordingSpawn()
  openRemoteDebuggingPage(MAC, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', run)
  assert.equal(calls[0].command, 'open')
  assert.deepEqual(calls[0].args, ['-a', '/Applications/Google Chrome.app', REMOTE_DEBUGGING_PAGE])
})

test('Windows opens the page through chrome.exe, without a shell', () => {
  const { calls, run } = recordingSpawn()
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  openRemoteDebuggingPage(WINDOWS, chrome, run)
  assert.equal(calls[0].command, chrome)
  assert.deepEqual(calls[0].args, [REMOTE_DEBUGGING_PAGE])
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(calls[0].options.detached, true)
})
