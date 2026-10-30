import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ChromeSession } from '../src/session.js'

const CONFIG = {
  defaultTarget: 'dedicated',
  allowMyChrome: true,
  askBeforeNewSite: true,
  headless: false,
  userDataDir: '',
  executablePath: '',
  toolset: 'standard',
  fileRoots: [],
  toolCallTimeoutSeconds: 180,
  extraArgs: [],
}

/** A session with a fake server, fake Chrome and scripted probe answers. */
async function harness({ config = {}, probes = ['ready'], chrome = '/chrome', mount } = {}) {
  // `null` stands for "not installed": undefined would pick the default above.
  const dir = await mkdtemp(join(tmpdir(), 'chrome-use-session-'))
  const log = { mounted: [], disposed: 0, opened: [], sleeps: 0, probes: 0 }
  const session = new ChromeSession({
    config: { ...CONFIG, ...config },
    cliPath: '/cli.js',
    mount: mount ?? (async (options) => {
      log.mounted.push(options)
      return { dispose: async () => { log.disposed++ } }
    }),
    platform: {
      findChrome: () => chrome ?? undefined,
      probeMyChrome: async () => {
        const state = probes[Math.min(log.probes, probes.length - 1)]
        log.probes++
        return { state }
      },
      openRemoteDebuggingPage: path => log.opened.push(path),
      dedicatedProfileDir: () => join(dir, 'nested', 'profile'),
      tempDir: () => '/system/temp',
    },
    sleep: async () => { log.sleeps++ },
  })
  return { session, log, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('the dedicated browser starts without asking anything of the user', async () => {
  const { session, log, dir, cleanup } = await harness()
  try {
    const result = await session.start()
    assert.equal(result.status, 'ready')
    assert.equal(result.target, 'dedicated')
    assert.match(result.guide, /take_snapshot/)
    assert.match(result.guide, /separate Chrome profile/)
    assert.equal(log.mounted.length, 1)
    assert.ok(log.mounted[0].args.includes(`--userDataDir=${join(dir, 'nested', 'profile')}`))
    assert.equal(log.mounted[0].toolCallTimeoutMs, 180_000)
    assert.ok((await stat(join(dir, 'nested', 'profile'))).isDirectory())
  } finally {
    await cleanup()
  }
})

test('starting twice keeps one server', async () => {
  const { session, log, cleanup } = await harness()
  try {
    await session.start()
    const again = await session.start('dedicated')
    assert.equal(again.status, 'ready')
    assert.match(again.message, /Already connected/)
    assert.equal(log.mounted.length, 1)
  } finally {
    await cleanup()
  }
})

test('sessions that start together share one server', async () => {
  const { session, log, cleanup } = await harness()
  try {
    const results = await Promise.all([session.start(), session.start(), session.start()])
    assert.ok(results.every(result => result.status === 'ready'))
    assert.equal(log.mounted.length, 1)
  } finally {
    await cleanup()
  }
})

test('my_chrome connects at once when Chrome already accepts connections', async () => {
  const { session, log, cleanup } = await harness({ probes: ['ready'] })
  try {
    const result = await session.start('my_chrome')
    assert.equal(result.status, 'ready')
    assert.match(result.guide, /click Allow/)
    assert.ok(log.mounted[0].args.includes('--autoConnect'))
    assert.deepEqual(log.opened, [])
  } finally {
    await cleanup()
  }
})

test('my_chrome opens the settings page and asks the user when debugging is off', async () => {
  const { session, log, cleanup } = await harness({ probes: ['not_enabled'] })
  try {
    const result = await session.start('my_chrome')
    assert.equal(result.status, 'needs_user_action')
    assert.equal(result.reason, 'enable_remote_debugging')
    assert.match(result.message, /chrome:\/\/inspect\/#remote-debugging/)
    assert.deepEqual(log.opened, ['/chrome'])
    assert.equal(log.mounted.length, 0)
  } finally {
    await cleanup()
  }
})

test('my_chrome notices when Chrome comes up with debugging already allowed', async () => {
  const { session, log, cleanup } = await harness({ probes: ['not_enabled', 'not_enabled', 'ready'] })
  try {
    const result = await session.start('my_chrome')
    assert.equal(result.status, 'ready')
    assert.equal(log.opened.length, 1)
    assert.equal(log.sleeps, 2)
  } finally {
    await cleanup()
  }
})

test('retrying does not open another settings tab or wait again', async () => {
  const { session, log, cleanup } = await harness({ probes: ['not_enabled'] })
  try {
    await session.start('my_chrome')
    const sleeps = log.sleeps
    const again = await session.start('my_chrome')
    assert.equal(again.reason, 'enable_remote_debugging')
    assert.equal(log.opened.length, 1)
    assert.equal(log.sleeps, sleeps)
  } finally {
    await cleanup()
  }
})

test('the retry connects once the user has allowed debugging', async () => {
  const { session, log, cleanup } = await harness({ probes: ['not_enabled', 'not_enabled', 'not_enabled', 'not_enabled', 'not_enabled', 'not_enabled', 'ready'] })
  try {
    assert.equal((await session.start('my_chrome')).status, 'needs_user_action')
    assert.equal((await session.start('my_chrome')).status, 'ready')
    assert.equal(log.mounted.length, 1)
  } finally {
    await cleanup()
  }
})

test('a macOS folder permission refusal gets its own instructions', async () => {
  const { session, log, cleanup } = await harness({ probes: ['denied'] })
  try {
    const result = await session.start('my_chrome')
    assert.equal(result.reason, 'grant_file_access')
    assert.match(result.message, /Privacy & Security/)
    assert.deepEqual(log.opened, [])
  } finally {
    await cleanup()
  }
})

test('the user can forbid connecting to their Chrome', async () => {
  const { session, log, cleanup } = await harness({ config: { allowMyChrome: false } })
  try {
    const result = await session.start('my_chrome')
    assert.equal(result.reason, 'my_chrome_disabled')
    assert.equal(log.mounted.length, 0)
    assert.equal(log.probes, 0)
  } finally {
    await cleanup()
  }
})

test('a missing Chrome is reported instead of failing later', async () => {
  const { session, log, cleanup } = await harness({ chrome: null })
  try {
    assert.equal((await session.start('dedicated')).reason, 'chrome_missing')
    assert.equal((await session.start('my_chrome')).reason, 'chrome_missing')
    assert.equal(log.mounted.length, 0)
  } finally {
    await cleanup()
  }
})

test('a configured executable counts as installed', async () => {
  const { session, cleanup } = await harness({ chrome: null, config: { executablePath: '/my/chrome' } })
  try {
    assert.equal((await session.start('dedicated')).status, 'ready')
  } finally {
    await cleanup()
  }
})

test('a profile directory that cannot be created is explained', async () => {
  const { session, log, dir, cleanup } = await harness()
  try {
    const file = join(dir, 'a-file')
    await writeFile(file, '')
    session.config = { ...session.config, userDataDir: join(file, 'profile') }
    const result = await session.start('dedicated')
    assert.equal(result.reason, 'profile_unavailable')
    assert.match(result.message, /external disk/)
    assert.equal(log.mounted.length, 0)
  } finally {
    await cleanup()
  }
})

test('switching browsers replaces the server', async () => {
  const { session, log, cleanup } = await harness()
  try {
    await session.start('dedicated')
    const result = await session.start('my_chrome')
    assert.equal(result.target, 'my_chrome')
    assert.equal(log.disposed, 1)
    assert.equal(log.mounted.length, 2)
  } finally {
    await cleanup()
  }
})

test('a switch the user has not enabled yet keeps the current connection', async () => {
  const { session, log, cleanup } = await harness({ probes: ['not_enabled'] })
  try {
    await session.start('dedicated')
    assert.equal((await session.start('my_chrome')).status, 'needs_user_action')
    assert.equal(log.disposed, 0)
    assert.equal(session.status().target, 'dedicated')
  } finally {
    await cleanup()
  }
})

test('stop closes the server and status follows', async () => {
  const { session, log, cleanup } = await harness()
  try {
    assert.equal(session.status().status, 'stopped')
    await session.start()
    assert.equal(session.status().status, 'ready')
    assert.equal((await session.stop()).status, 'stopped')
    assert.equal(log.disposed, 1)
    assert.equal(session.status().status, 'stopped')
    await session.stop()
    assert.equal(log.disposed, 1)
  } finally {
    await cleanup()
  }
})

test('a server that fails to start leaves nothing connected and can be retried', async () => {
  let attempts = 0
  const { session, cleanup } = await harness({
    mount: async () => {
      attempts++
      if (attempts === 1) throw new Error('server failed')
      return { dispose: async () => {} }
    },
  })
  try {
    await assert.rejects(session.start(), /server failed/)
    assert.equal(session.status().status, 'stopped')
    assert.equal((await session.start()).status, 'ready')
  } finally {
    await cleanup()
  }
})

test('the guide names the exact directories file tools can reach', async () => {
  const { session, cleanup } = await harness({ config: { fileRoots: ['/data/uploads'] } })
  try {
    assert.match((await session.start()).guide, /only reach \/system\/temp, \/data\/uploads;/)
  } finally {
    await cleanup()
  }
})

test('in the user\'s Chrome a site is asked about once, and only for navigations', async () => {
  const { session, cleanup } = await harness({ probes: ['ready'] })
  try {
    await session.start('my_chrome')
    const open = { url: 'https://mail.example.com/inbox' }
    assert.equal(session.siteToApprove('mcp__chrome__new_page', open), 'https://mail.example.com')
    assert.equal(session.siteToApprove('mcp__chrome__navigate_page', open), 'https://mail.example.com')
    assert.equal(session.siteToApprove('mcp__chrome__take_snapshot', { pageId: 1 }), undefined)
    assert.equal(session.siteToApprove('chrome_use', open), undefined)

    session.noteSiteApproved('mcp__chrome__new_page', open)
    assert.equal(session.siteToApprove('mcp__chrome__navigate_page', { url: 'https://mail.example.com/sent' }), undefined)
    assert.equal(session.siteToApprove('mcp__chrome__new_page', { url: 'https://bank.example.com/' }), 'https://bank.example.com')
  } finally {
    await cleanup()
  }
})

test('navigating without a web URL asks nothing', async () => {
  const { session, cleanup } = await harness({ probes: ['ready'] })
  try {
    await session.start('my_chrome')
    for (const args of [{ type: 'back' }, { url: 'about:blank' }, { url: 'not a url' }, { url: 42 }]) {
      assert.equal(session.siteToApprove('mcp__chrome__navigate_page', args), undefined)
    }
  } finally {
    await cleanup()
  }
})

test('the dedicated browser asks about no sites', async () => {
  const { session, cleanup } = await harness()
  try {
    await session.start('dedicated')
    assert.equal(session.siteToApprove('mcp__chrome__new_page', { url: 'https://example.com' }), undefined)
  } finally {
    await cleanup()
  }
})

test('site approval can be turned off', async () => {
  const { session, cleanup } = await harness({ probes: ['ready'], config: { askBeforeNewSite: false } })
  try {
    await session.start('my_chrome')
    assert.equal(session.siteToApprove('mcp__chrome__new_page', { url: 'https://example.com' }), undefined)
  } finally {
    await cleanup()
  }
})

test('reconnecting forgets the approved sites', async () => {
  const { session, cleanup } = await harness({ probes: ['ready'] })
  try {
    const open = { url: 'https://example.com' }
    await session.start('my_chrome')
    session.noteSiteApproved('mcp__chrome__new_page', open)
    await session.stop()
    await session.start('my_chrome')
    assert.equal(session.siteToApprove('mcp__chrome__new_page', open), 'https://example.com')
  } finally {
    await cleanup()
  }
})
