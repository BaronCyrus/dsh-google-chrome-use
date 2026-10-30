/**
 * Where Chrome lives on each operating system, and how to tell whether the
 * Chrome the user is running accepts a debugging connection.
 *
 * Every function takes the host explicitly, so the Windows and macOS branches
 * are testable on either system.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** The page where the user allows debugging of the Chrome they are running. */
export const REMOTE_DEBUGGING_PAGE = 'chrome://inspect/#remote-debugging'

/** The file Chrome writes into its user data directory once debugging is allowed. */
const PORT_FILE = 'DevToolsActivePort'

/** A file every Chrome profile folder has, whether or not debugging is allowed. */
const ALWAYS_PRESENT_FILE = 'Local State'

const PORT_CONNECT_TIMEOUT_MS = 1500

/** @returns the host this process runs on. */
export function currentHost() {
  return { platform: process.platform, env: process.env, home: homedir() }
}

function pathFor(host) {
  return host.platform === 'win32' ? win32 : posix
}

/** @returns the places Google Chrome's stable channel installs itself, most likely first. */
export function chromeInstallPaths(host) {
  const path = pathFor(host)
  if (host.platform === 'darwin') {
    const inApplications = 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    return [path.join('/', inApplications), path.join(host.home, inApplications)]
  }
  if (host.platform === 'win32') {
    const roots = [
      host.env.ProgramFiles ?? 'C:\\Program Files',
      host.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      host.env.LOCALAPPDATA ?? path.join(host.home, 'AppData', 'Local'),
    ]
    return roots.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** @returns the installed Chrome executable, or undefined when there is none. */
export function findChrome(host, exists = isExecutable) {
  return chromeInstallPaths(host).find(file => exists(file))
}

/** @returns the user data directory of the Chrome the user runs. */
export function chromeUserDataDir(host) {
  const path = pathFor(host)
  if (host.platform === 'darwin') return path.join(host.home, 'Library', 'Application Support', 'Google', 'Chrome')
  if (host.platform === 'win32') {
    return path.join(host.env.LOCALAPPDATA ?? path.join(host.home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  }
  return path.join(host.env.XDG_CONFIG_HOME ?? path.join(host.home, '.config'), 'google-chrome')
}

/** @returns the default home of the dedicated profile, under the DSH data directory. */
export function dshHomeDir(host) {
  return host.env.DSH_HOME?.trim() || pathFor(host).join(host.home, '.dsh')
}

export function dedicatedProfileDir(host) {
  return pathFor(host).join(dshHomeDir(host), 'chrome-use', 'chrome-profile')
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function isRefused(error) {
  return error.code === 'EPERM' || error.code === 'EACCES'
}

/**
 * macOS refuses files that exist but reports the port file as merely missing
 * until debugging is on. Checking a file that is always there lets the user
 * fix the permission first, instead of finding out after ticking the checkbox.
 */
async function macosKeepsUsOut(dir) {
  try {
    await (await open(posix.join(dir, ALWAYS_PRESENT_FILE), 'r')).close()
    return false
  } catch (error) {
    return isRefused(error)
  }
}

/**
 * Check whether the running Chrome accepts debugging connections, without
 * opening one: Chrome asks the user to allow each connection, and that request
 * belongs to the first real browser action.
 * @returns `ready`; `not_enabled` when Chrome is closed or debugging is off;
 * or `denied` when macOS keeps this process out of Chrome's folder.
 */
export async function probeMyChrome(host) {
  const dir = chromeUserDataDir(host)
  const file = pathFor(host).join(dir, PORT_FILE)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const mac = host.platform === 'darwin'
    return { state: mac && (isRefused(error) || await macosKeepsUsOut(dir)) ? 'denied' : 'not_enabled', file }
  }
  // A crash can leave the file behind, so the port itself has the last word.
  const port = Number(text.split('\n')[0])
  const listening = Number.isInteger(port) && port > 0 && port < 65536 && await canConnect(port)
  return listening ? { state: 'ready', port } : { state: 'not_enabled', file }
}

/** @returns this process's environment without credentials or DSH's own variables. */
export function browserEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && !key.startsWith('DSH_') && key !== 'ELECTRON_RUN_AS_NODE'))
}

/** Show the remote debugging page in the user's Chrome, starting Chrome if it is closed. */
export function openRemoteDebuggingPage(host, chromePath, run = spawn) {
  const [command, args] = host.platform === 'darwin'
    ? ['open', ['-a', chromePath.slice(0, chromePath.indexOf('.app') + 4), REMOTE_DEBUGGING_PAGE]]
    : [chromePath, [REMOTE_DEBUGGING_PAGE]]
  const child = run(command, args, { detached: true, stdio: 'ignore', env: browserEnv(host.env) })
  child.on('error', () => {})
  child.unref()
}
