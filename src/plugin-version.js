/**
 * The plugin's own version, for the settings page, and the update it offers.
 *
 * DSH's Plugins page only offers an update for official plugins; anything else
 * has to be removed and installed again. So the update installs the exact
 * version itself, with the pnpm DSH uses, in the profile that owns this copy.
 * It runs under the profile's own minimumReleaseAge: a version forced past it
 * would sit in the lockfile, and pnpm would then refuse every later plugin
 * install in that profile until the version is old enough.
 *
 * The latest version comes from npm, while pnpm installs from the profile's own
 * install source, which can lag behind a fresh release or be out of reach. Both
 * are reported as such. pnpm's output never leaves this module.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import own from '../package.json' with { type: 'json' }

export const PACKAGE_NAME = own.name
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

const VERSION_TIMEOUT_MS = 10_000
const UPDATE_TIMEOUT_MS = 180_000
const SETTLE_DELAY_MS = 250

const UPDATE_TIMED_OUT = 'Chrome Use update timed out'
const RELEASE_AGE_ERROR = /ERR_PNPM_(?:NO_MATURE_MATCHING_VERSION|MINIMUM_RELEASE_AGE_VIOLATION)/u
const RELEASE_AGE_ENTRY = /(\S+@\S+) was published at (\S+?), within the minimumReleaseAge cutoff \((\S+?)\)/gu
// pnpm's codes for a version its install source does not list or serve yet.
const NOT_SYNCED = /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version found|ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - 404/u
const UNREACHABLE = /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bFETCH_ERROR\b|socket hang up/u
const REGISTRY_URL = /(?:while fetching it from|GET)\s+(https?:\/\/\S+)/u
// A colour-forcing environment can wrap pnpm's lines in ANSI escapes.
const ANSI = /\u001b\[[0-9;]*m/gu

/**
 * Recognize pnpm refusing a version younger than its minimumReleaseAge.
 * @param output - the install's stdout and stderr.
 * @param finishedAt - when the install ended; pnpm drew its cutoff then.
 * @returns undefined for any other output; otherwise `{ availableAt }`, when the
 *   youngest refused entry clears, if pnpm said.
 */
export function releaseAgeRefusal(output, finishedAt) {
  const text = String(output ?? '').replace(ANSI, '')
  if (!RELEASE_AGE_ERROR.test(text)) return undefined
  let availableAt
  for (const [, , published, cutoff] of text.matchAll(RELEASE_AGE_ENTRY)) {
    const clears = Date.parse(published) + (finishedAt - Date.parse(cutoff))
    if (Number.isFinite(clears) && (availableAt === undefined || clears > availableAt)) availableAt = clears
  }
  return availableAt === undefined ? {} : { availableAt }
}

/** The host of the registry URL one pnpm line names, never its path or credentials. */
function registryHost(line) {
  const match = REGISTRY_URL.exec(line)
  if (match === null) return {}
  try {
    const { host } = new URL(match[1].replace(/[.,:;)\]]+$/u, ''))
    return host === '' ? {} : { registry: host }
  } catch {
    return {}
  }
}

/**
 * Recognize why pnpm could not fetch the new version. Only a line naming this
 * package counts as not synced; another package's 404 is not this update's.
 * @returns `{ reason: 'syncing' | 'unreachable', registry? }`, or undefined for
 *   any other failure.
 */
export function installFailure(output) {
  const lines = String(output ?? '').replace(ANSI, '').split('\n')
  const syncing = lines.find(line => NOT_SYNCED.test(line) && line.includes(PACKAGE_NAME))
  if (syncing !== undefined) return { reason: 'syncing', ...registryHost(syncing) }
  const unreachable = lines.find(line => UNREACHABLE.test(line))
  if (unreachable !== undefined) return { reason: 'unreachable', ...registryHost(unreachable) }
  return undefined
}

/** Parse a strict `x.y.z[-pre][+build]` version; anything else is undefined. */
export function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] }
}

/** Compare two versions: -1/0/1, or undefined when either side is not semver. */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

async function readManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Only a registry install may be updated in place; a local checkout is its owner's. */
function classifySpec(spec) {
  if (/^(?:link|file):/u.test(spec)) return 'link'
  if (/^(?:\d|[~^*])/u.test(spec)) return 'npm'
  return 'unknown'
}

/**
 * Find the profile that owns this running copy: pnpm's links resolve to the same
 * real path on both sides. When none matches, fall back to the only profile that
 * declares the dependency at all.
 */
export async function findInstall({ dshHome, ownPackageJsonUrl }) {
  const ownReal = await realpath(fileURLToPath(ownPackageJsonUrl)).catch(() => undefined)
  const entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true }).catch(() => [])
  const declared = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileDir = join(dshHome, 'profiles', entry.name)
    const spec = (await readManifest(join(profileDir, 'package.json')))?.dependencies?.[PACKAGE_NAME]
    if (typeof spec !== 'string') continue
    declared.push({ kind: classifySpec(spec), profile: entry.name })
    const installed = await realpath(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json')).catch(() => undefined)
    if (ownReal !== undefined && installed === ownReal) return declared.at(-1)
  }
  return declared.length === 1 ? declared[0] : { kind: 'unknown' }
}

/**
 * The desktop host names its bundled pnpm in its own arguments, and `dsh plugin`
 * refuses the desktop profile, so that is the pnpm to run. Anchored to the file
 * name so a directory that merely contains the word cannot match.
 */
export function resolvePnpm(argv) {
  return argv.find(entry => /[\\/]pnpm\.(?:mjs|cjs|js)$/u.test(entry) && existsSync(entry))
}

function runPnpm({ command, args, cwd, env }, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs)
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env, signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8192) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
    child.once('error', error => reject(signal.aborted ? new Error(UPDATE_TIMED_OUT) : error))
    child.once('close', (code) => {
      if (!signal.aborted) resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * @param options.dshHome - the DSH data directory, which holds the profiles.
 * @param options.runningVersion - the version this process loaded, which the
 *   copy on disk stops matching once an update lands.
 * @param options.argv - the host's arguments, which may name its bundled pnpm.
 * @returns `{ read(signal), update() }`.
 */
export function createPluginManager({
  dshHome,
  runningVersion = own.version,
  ownPackageJsonUrl = new URL('../package.json', import.meta.url),
  // Another plugin may wrap fetch and later undo that, so resolve it per call.
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  runCommand = runPnpm,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  now = Date.now,
  updateTimeoutMs = UPDATE_TIMEOUT_MS,
  settleDelayMs = SETTLE_DELAY_MS,
}) {
  const pnpm = resolvePnpm(argv)
  // execPath is the desktop app's own binary there, which must not open another window.
  const launcher = pnpm === undefined
    ? { command: 'pnpm', prefix: [], env }
    : { command: execPath, prefix: [pnpm], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  let updating = false

  const fetchLatest = async (signal) => {
    const timeout = AbortSignal.timeout(VERSION_TIMEOUT_MS)
    const response = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { 'accept': 'application/json', 'accept-encoding': 'identity' },
      redirect: 'error',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) throw new Error('Chrome Use version check failed')
    const { version } = await response.json()
    if (parseSemver(version) === undefined) throw new Error('Chrome Use version check failed')
    return version
  }

  // A zero exit only proves the command ran: pnpm can skip a version and still exit zero.
  const confirmInstalled = async (profileDir, expected) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const manifest = await readManifest(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'))
      if (manifest?.version === expected) return
      if (attempt < 3) await new Promise((resolve) => { setTimeout(resolve, settleDelayMs) })
    }
    throw new Error('Chrome Use update did not install the requested version')
  }

  return {
    /** Without npm, `latest` is simply absent: the running version is still worth showing. */
    async read(signal) {
      const [manifest, install, latest] = await Promise.all([
        readManifest(fileURLToPath(ownPackageJsonUrl)),
        findInstall({ dshHome, ownPackageJsonUrl }),
        fetchLatest(signal).catch(() => undefined),
      ])
      const installed = manifest?.version ?? runningVersion
      return {
        current: runningVersion,
        installed,
        latest,
        updateAvailable: latest !== undefined && compareSemver(latest, installed) === 1,
        restartNeeded: installed !== runningVersion,
        install,
      }
    },

    /** Not tied to the page that asked: leaving it must not kill pnpm mid-install. */
    async update() {
      if (updating) throw new Error('Chrome Use update is already running')
      updating = true
      try {
        const { kind, profile } = await findInstall({ dshHome, ownPackageJsonUrl })
        if (kind !== 'npm') throw new Error('Chrome Use can only update an install from npm')
        const version = await fetchLatest()
        const profileDir = join(dshHome, 'profiles', profile)
        let result
        try {
          result = await runCommand({
            command: launcher.command,
            args: [...launcher.prefix, 'add', '--save-exact', `${PACKAGE_NAME}@${version}`],
            cwd: profileDir,
            env: launcher.env,
          }, { timeoutMs: updateTimeoutMs })
        } catch (error) {
          // pnpm hung past the bound: its install source did not answer.
          if (error?.message === UPDATE_TIMED_OUT) return { version, profile, failed: 'unreachable' }
          throw new Error('Chrome Use update failed')
        }
        if (result.code !== 0) {
          const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
          const refusal = releaseAgeRefusal(output, now())
          if (refusal !== undefined) return { version, profile, pending: true, ...refusal }
          const failure = installFailure(output)
          if (failure === undefined) throw new Error('Chrome Use update failed')
          return { version, profile, failed: failure.reason, ...(failure.registry === undefined ? {} : { registry: failure.registry }) }
        }
        await confirmInstalled(profileDir, version)
        return { version, profile }
      } finally {
        updating = false
      }
    },
  }
}

/**
 * The handler behind the settings page. DSH validates all three error fields,
 * and nothing here says more than that the request failed.
 */
export function createVersionChannel(manager) {
  const endpoints = {
    'plugin/version': (_payload, signal) => manager.read(signal),
    'plugin/update': () => manager.update(),
  }
  return async (endpoint, payload, signal) => {
    try {
      if (!Object.hasOwn(endpoints, endpoint)) throw new Error('Unknown endpoint')
      return { ok: true, value: await endpoints[endpoint](payload, signal) }
    } catch {
      return { ok: false, error: { code: 'chrome-use/request-failed', message: 'Chrome Use request failed', details: {} } }
    }
  }
}
