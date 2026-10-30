/**
 * The one browser connection this plugin owns: which browser it reaches, what
 * the user still has to do before it can, and when its server runs.
 */

import { mkdir } from 'node:fs/promises'
import { buildGuide } from './guide.js'
import { REMOTE_DEBUGGING_PAGE } from './platform.js'
import { SERVER_ENV, buildServerArgs } from './server-args.js'

/** Chrome may have just started from the page we opened; give it time to come up. */
const PROBE_ATTEMPTS = 5
const PROBE_INTERVAL_MS = 1000

/** Retries should not pile up tabs while the user is still reading the first one. */
const REOPEN_PAGE_AFTER_MS = 60_000

/** The tools that send the browser to a URL of the model's choosing. */
const NAVIGATION_TOOLS = new Set(['mcp__chrome__new_page', 'mcp__chrome__navigate_page'])

function siteOf(url) {
  if (typeof url !== 'string') return undefined
  try {
    const { protocol, origin } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? origin : undefined
  } catch {
    return undefined
  }
}

function needsUser(reason, target, message) {
  return { status: 'needs_user_action', reason, target, message }
}

export class ChromeSession {
  /**
   * @param deps.config - the plugin's settings.
   * @param deps.cliPath - the Chrome DevTools MCP entry script.
   * @param deps.mount - starts the MCP server; resolves to its fiber once its tools are registered.
   * @param deps.platform - `findChrome`, `probeMyChrome`, `openRemoteDebuggingPage`, `dedicatedProfileDir` and `tempDir`, bound to the host.
   * @param deps.sleep - waits between probes.
   */
  constructor({ config, cliPath, mount, platform, sleep }) {
    this.config = config
    this.cliPath = cliPath
    this.mount = mount
    this.platform = platform
    this.sleep = sleep
    this.connection = undefined
    this.pageOpenedAt = -Infinity
    this.approvedSites = new Set()
    this.queue = Promise.resolve()
  }

  /** Serve one operation at a time: sessions share this connection, and a mount takes seconds. */
  enqueue(operation) {
    const run = this.queue.then(operation)
    this.queue = run.catch(() => {})
    return run
  }

  /** @returns the connection state as the model sees it. */
  status() {
    const { connection, config } = this
    if (connection === undefined) {
      return { status: 'stopped', target: config.defaultTarget, message: 'Chrome is not connected. Call chrome_use to connect it.' }
    }
    return { status: 'ready', target: connection.target, message: `Connected to ${describe(connection.target)}. The mcp__chrome__* tools are available.` }
  }

  /** Connect to a browser, replacing a connection to the other one. */
  start(target = this.config.defaultTarget) {
    return this.enqueue(async () => {
      if (this.connection?.target === target) return this.ready(target, false)
      const blocked = target === 'my_chrome' ? await this.prepareMyChrome() : await this.prepareDedicated()
      if (blocked !== undefined) return blocked
      await this.disconnect()
      const fiber = await this.mount({
        args: buildServerArgs({
          cliPath: this.cliPath,
          target,
          config: this.config,
          userDataDir: this.userDataDir(),
        }),
        env: SERVER_ENV,
        toolCallTimeoutMs: this.config.toolCallTimeoutSeconds * 1000,
      })
      this.connection = { target, fiber }
      return this.ready(target, true)
    })
  }

  /** Close the connection, and the dedicated browser with it. */
  stop() {
    return this.enqueue(async () => {
      await this.disconnect()
      return { status: 'stopped', target: this.config.defaultTarget, message: 'Chrome is disconnected and the mcp__chrome__* tools are gone.' }
    })
  }

  ready(target, connected) {
    return {
      status: 'ready',
      target,
      message: `${connected ? 'Connected to' : 'Already connected to'} ${describe(target)}. The mcp__chrome__* tools are available from your next step.`,
      guide: buildGuide({ target, tempDir: this.platform.tempDir(), fileRoots: this.config.fileRoots }),
    }
  }

  async disconnect() {
    const fiber = this.connection?.fiber
    this.connection = undefined
    this.approvedSites.clear()
    await fiber?.dispose()
  }

  /**
   * @returns the site a browser tool call would open for the first time in the
   * user's own Chrome, or undefined when the call needs no approval.
   */
  siteToApprove(toolName, args) {
    if (this.connection?.target !== 'my_chrome' || !this.config.askBeforeNewSite) return undefined
    if (!NAVIGATION_TOOLS.has(toolName)) return undefined
    const site = siteOf(args.url)
    return site === undefined || this.approvedSites.has(site) ? undefined : site
  }

  /** Remember a site whose navigation is going ahead, so it is only asked about once. */
  noteSiteApproved(toolName, args) {
    const site = this.siteToApprove(toolName, args)
    if (site !== undefined) this.approvedSites.add(site)
  }

  userDataDir() {
    return this.config.userDataDir || this.platform.dedicatedProfileDir()
  }

  chromePath() {
    return this.config.executablePath || this.platform.findChrome()
  }

  missingChrome(target) {
    return needsUser('chrome_missing', target, 'Google Chrome was not found. Ask the user to install it from https://www.google.com/chrome/, or to set executablePath on the chrome-use row of their DSH profile\'s cordis.patch.yml if it is installed somewhere unusual.')
  }

  /** @returns what keeps the dedicated browser from starting, or undefined when nothing does. */
  async prepareDedicated() {
    if (this.chromePath() === undefined) return this.missingChrome('dedicated')
    const dir = this.userDataDir()
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      return needsUser('profile_unavailable', 'dedicated', `The Chrome profile directory ${dir} cannot be created (${error.code}). If it is on an external disk, the disk may not be connected. Otherwise ask the user to change userDataDir on the chrome-use row of their DSH profile's cordis.patch.yml.`)
    }
  }

  /** @returns what the user still has to do before their Chrome can connect, or undefined when nothing. */
  async prepareMyChrome() {
    const target = 'my_chrome'
    if (!this.config.allowMyChrome) {
      return needsUser('my_chrome_disabled', target, 'Connecting to the user\'s own Chrome is turned off (allowMyChrome on the chrome-use row of their DSH profile\'s cordis.patch.yml). Tell the user; only they can turn it on. Do not work around it.')
    }
    const chromePath = this.chromePath()
    if (chromePath === undefined) return this.missingChrome(target)

    let probe = await this.platform.probeMyChrome()
    if (probe.state === 'not_enabled') {
      const opened = this.openPageOnce(chromePath)
      for (let attempt = 0; opened && probe.state === 'not_enabled' && attempt < PROBE_ATTEMPTS; attempt++) {
        await this.sleep(PROBE_INTERVAL_MS)
        probe = await this.platform.probeMyChrome()
      }
    }
    if (probe.state === 'ready') return
    if (probe.state === 'denied') {
      return needsUser('grant_file_access', target, 'macOS is keeping DSH out of Chrome\'s data folder, and it does not ask on its own. Ask the user to open System Settings > Privacy & Security > Files & Folders and turn on Google Chrome under DeepSeek Harness (under their terminal app if they run DSH from one), then call chrome_use again.')
    }
    return needsUser('enable_remote_debugging', target, `Chrome is not accepting connections yet. ${REMOTE_DEBUGGING_PAGE} has been opened in Chrome. Ask the user to tick "Allow remote debugging for this browser instance" there (Chrome 144 or later) and tell you when it is done, then call chrome_use with target=my_chrome again. Do not switch to the dedicated browser instead when the task needs their accounts.`)
  }

  openPageOnce(chromePath) {
    const now = Date.now()
    if (now - this.pageOpenedAt < REOPEN_PAGE_AFTER_MS) return false
    this.pageOpenedAt = now
    this.platform.openRemoteDebuggingPage(chromePath)
    return true
  }
}

function describe(target) {
  return target === 'my_chrome' ? 'the user\'s own Chrome' : 'the dedicated Chrome profile'
}
