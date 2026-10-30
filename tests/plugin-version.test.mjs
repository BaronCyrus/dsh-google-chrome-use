import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  compareSemver,
  createPluginManager,
  createVersionChannel,
  installFailure,
  PACKAGE_NAME,
  parseSemver,
  REGISTRY_LATEST_URL,
  releaseAgeRefusal,
  resolvePnpm,
} from '../src/plugin-version.js'

async function writeManifest(path, manifest) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(manifest))
}

async function tempHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'chrome-use-version-'))
  // A killed pnpm can hold its working directory for a moment, on Windows especially.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

/** A DSH home whose `web` profile installed the package from npm. */
async function npmInstall(root, version = '1.0.3') {
  const installed = join(root, 'profiles', 'web', 'node_modules', PACKAGE_NAME, 'package.json')
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), { dependencies: { [PACKAGE_NAME]: version } })
  await writeManifest(installed, { name: PACKAGE_NAME, version })
  return pathToFileURL(installed)
}

/** A DSH home whose `web` profile links a local checkout. */
async function linkInstall(root, version = '1.0.3') {
  const checkout = join(root, 'checkout')
  await writeManifest(join(checkout, 'package.json'), { name: PACKAGE_NAME, version })
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), { dependencies: { [PACKAGE_NAME]: 'link:../../checkout' } })
  await mkdir(join(root, 'profiles', 'web', 'node_modules'), { recursive: true })
  await symlink(checkout, join(root, 'profiles', 'web', 'node_modules', PACKAGE_NAME), 'junction')
  return pathToFileURL(join(checkout, 'package.json'))
}

const registryOk = version => async () => ({ ok: true, async json() { return { version } } })

/** What a successful pnpm leaves behind. */
async function installRecorder({ args, cwd }) {
  await writeManifest(join(cwd, 'node_modules', PACKAGE_NAME, 'package.json'), { name: PACKAGE_NAME, version: args.at(-1).split('@').at(-1) })
  return { code: 0, stdout: '', stderr: '' }
}

test('semver parsing and comparison decide whether an update is offered', () => {
  assert.deepEqual(parseSemver(' 1.0.3 '), { major: 1, minor: 0, patch: 3, pre: undefined })
  assert.equal(parseSemver('v1.0.3'), undefined)
  assert.equal(parseSemver('1.0'), undefined)
  assert.equal(compareSemver('1.0.3', '1.0.4'), -1)
  assert.equal(compareSemver('1.0.4', '1.0.3'), 1)
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareSemver('not-a-version', '1.0.3'), undefined)
})

test('a read combines the running version, the copy on disk, npm and the owning profile', async (t) => {
  const root = await tempHome(t)
  let observed
  const manager = createPluginManager({
    dshHome: root,
    runningVersion: '1.0.3',
    ownPackageJsonUrl: await npmInstall(root),
    fetchImpl: (url, init) => {
      observed = { url, redirect: init.redirect, encoding: init.headers['accept-encoding'] }
      return registryOk('1.0.4')()
    },
  })
  assert.deepEqual(await manager.read(), {
    current: '1.0.3',
    installed: '1.0.3',
    latest: '1.0.4',
    updateAvailable: true,
    restartNeeded: false,
    install: { kind: 'npm', profile: 'web' },
  })
  assert.deepEqual(observed, { url: REGISTRY_LATEST_URL, redirect: 'error', encoding: 'identity' })
})

test('a read without npm still reports the running version and offers nothing', async (t) => {
  const root = await tempHome(t)
  const ownPackageJsonUrl = await npmInstall(root)
  for (const fetchImpl of [
    async () => { throw new TypeError('fetch failed') },
    async () => ({ ok: false }),
    registryOk('not-a-version'),
    async () => ({ ok: true, async json() { throw new SyntaxError('not JSON') } }),
  ]) {
    const info = await createPluginManager({ dshHome: root, runningVersion: '1.0.3', ownPackageJsonUrl, fetchImpl }).read()
    assert.equal(info.current, '1.0.3')
    assert.equal(info.latest, undefined)
    assert.equal(info.updateAvailable, false)
  }
})

test('an update that landed before a restart shows up, and is not offered again', async (t) => {
  const root = await tempHome(t)
  const manager = createPluginManager({
    dshHome: root,
    runningVersion: '1.0.3',
    ownPackageJsonUrl: await npmInstall(root, '1.0.4'),
    fetchImpl: registryOk('1.0.4'),
  })
  const info = await manager.read()
  assert.equal(info.current, '1.0.3')
  assert.equal(info.installed, '1.0.4')
  assert.equal(info.restartNeeded, true)
  assert.equal(info.updateAvailable, false)
})

test('a linked checkout is reported and never updated in place', async (t) => {
  const root = await tempHome(t)
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await linkInstall(root),
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => assert.fail('pnpm must not run for a linked install'),
  })
  assert.deepEqual((await manager.read()).install, { kind: 'link', profile: 'web' })
  await assert.rejects(() => manager.update(), /only update an install from npm/)
})

test('an update installs the exact version in the owning profile, under its release-age policy', async (t) => {
  const root = await tempHome(t)
  const calls = []
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    argv: ['/node', '/dsh/bin.js'],
    fetchImpl: registryOk('1.0.4'),
    runCommand: async (call) => {
      calls.push(call)
      return installRecorder(call)
    },
  })
  assert.deepEqual(await manager.update(), { version: '1.0.4', profile: 'web' })
  assert.equal(calls[0].command, 'pnpm')
  // No minimumReleaseAge override: pnpm would then refuse every later plugin install in the profile.
  assert.deepEqual(calls[0].args, ['add', '--save-exact', `${PACKAGE_NAME}@1.0.4`])
  assert.equal(calls[0].cwd, join(root, 'profiles', 'web'))
})

test('the desktop app installs with its bundled pnpm and never opens another window', async (t) => {
  const root = await tempHome(t)
  const pnpm = join(root, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
  await writeManifest(pnpm, {})
  const hostEntry = join(root, 'app.asar', 'dsh-desktop-host', 'lib', 'index.js')
  const argv = ['/app/DeepSeek Harness', hostEntry, join(root, 'app.asar', 'dsh'), join(root, 'profiles', 'desktop'), join(root, 'runtime', 'primary-runtime'), pnpm, join(root, 'runtime', 'bin')]
  const calls = []
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    execPath: '/app/DeepSeek Harness',
    argv,
    env: { PATH: '/usr/bin' },
    fetchImpl: registryOk('1.0.4'),
    runCommand: async (call) => {
      calls.push(call)
      return installRecorder(call)
    },
  })
  await manager.update()
  assert.equal(calls[0].command, '/app/DeepSeek Harness')
  assert.deepEqual(calls[0].args, [pnpm, 'add', '--save-exact', `${PACKAGE_NAME}@1.0.4`])
  assert.deepEqual(calls[0].env, { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
  assert.ok(!calls[0].args.includes(hostEntry))
})

test('only a real pnpm file among the host\'s arguments counts', async (t) => {
  const root = await tempHome(t)
  const pnpm = join(root, 'pnpm', 'bin', 'pnpm.mjs')
  await writeManifest(pnpm, {})
  assert.equal(resolvePnpm(['/node', pnpm]), pnpm)
  assert.equal(resolvePnpm(['C:\\node.exe', '--expose-internals', '/dsh/bin.js']), undefined)
  assert.equal(resolvePnpm(['/node', '/somewhere/pnpm-not-really']), undefined)
  assert.equal(resolvePnpm(['/node', join(root, 'missing', 'pnpm.mjs')]), undefined)
})

test('an update that installs nothing is a failure, not a success', async (t) => {
  const root = await tempHome(t)
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    fetchImpl: registryOk('1.0.4'),
    settleDelayMs: 1,
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  await assert.rejects(() => manager.update(), /did not install the requested version/)
})

test('a second update waits for the first to end', async (t) => {
  const root = await tempHome(t)
  let release
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    fetchImpl: registryOk('1.0.4'),
    runCommand: async (call) => {
      await new Promise((resolve) => { release = resolve })
      return installRecorder(call)
    },
  })
  const first = manager.update()
  await assert.rejects(() => manager.update(), /already running/)
  while (release === undefined) await new Promise(resolve => setImmediate(resolve))
  release()
  assert.equal((await first).version, '1.0.4')
})

/** pnpm 11 refusing a version requested before its release age. */
const TOO_NEW = `[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:
  ${PACKAGE_NAME}@1.0.4 was published at 2026-10-16T19:16:25.489Z, within the minimumReleaseAge cutoff (2026-10-16T03:19:30.745Z)`
/** The lockfile check refusing an install in a profile that already holds a version too new. */
const LOCKFILE_VIOLATION = `✗ Lockfile failed supply-chain policy check (2 entries in 1.3s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:
  ${PACKAGE_NAME}@1.0.4 was published at 2026-10-16T19:15:26.000Z, within the minimumReleaseAge cutoff (2026-10-16T03:18:55.442Z)
  dsh-chat-manager@1.5.13 was published at 2026-10-16T14:05:23.291Z, within the minimumReleaseAge cutoff (2026-10-16T03:18:55.442Z)`

test('a release-age refusal says when pnpm will accept the youngest refused version', () => {
  const finishedAt = Date.parse('2026-10-17T03:19:30.745Z')
  assert.deepEqual(releaseAgeRefusal(TOO_NEW, finishedAt), { availableAt: Date.parse('2026-10-17T19:16:25.489Z') })
  assert.deepEqual(releaseAgeRefusal(`\u001b[31m${LOCKFILE_VIOLATION}\u001b[39m`, Date.parse('2026-10-17T03:18:55.442Z')),
    { availableAt: Date.parse('2026-10-17T19:15:26.000Z') })
  assert.deepEqual(releaseAgeRefusal('[ERR_PNPM_NO_MATURE_MATCHING_VERSION] something unparseable', finishedAt), {})
  assert.equal(releaseAgeRefusal(`ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/${PACKAGE_NAME}: Not Found`, finishedAt), undefined)
  assert.equal(releaseAgeRefusal(undefined, finishedAt), undefined)
})

test('an update pnpm holds back for its release age is pending, not failed', async (t) => {
  const root = await tempHome(t)
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    now: () => Date.parse('2026-10-17T03:19:30.745Z'),
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => ({ code: 1, stdout: '', stderr: TOO_NEW }),
  })
  assert.deepEqual(await manager.update(), {
    version: '1.0.4', profile: 'web', pending: true, availableAt: Date.parse('2026-10-17T19:16:25.489Z'),
  })
})

/** What DSH's bundled pnpm 11.28.5 prints shortly after a release. */
const MIRROR_NOT_SYNCED = `? Verifying lockfile against supply-chain policies (1 entry)...
\u001b[32m✓\u001b[39m Lockfile passes supply-chain policies (1 entry in 2ms)
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for ${PACKAGE_NAME}@1.0.4 while fetching it from https://registry.npmmirror.com/
This error happened while installing a direct dependency of /Users/someone/.dsh/profiles/desktop`
const TARBALL_NOT_SERVED = `[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-1.0.4.tgz: Not Found - 404`
const SOURCE_UNREACHABLE = `[ERR_PNPM_META_FETCH_FAIL] GET https://registry.npmjs.org/${PACKAGE_NAME}: fetch failed`

test('pnpm\'s output says whether the install source is still syncing or out of reach', () => {
  assert.deepEqual(installFailure(MIRROR_NOT_SYNCED), { reason: 'syncing', registry: 'registry.npmmirror.com' })
  assert.deepEqual(installFailure(TARBALL_NOT_SERVED), { reason: 'syncing', registry: 'registry.npmjs.org' })
  assert.deepEqual(installFailure(SOURCE_UNREACHABLE), { reason: 'unreachable', registry: 'registry.npmjs.org' })
  assert.deepEqual(installFailure('getaddrinfo ENOTFOUND registry.npmjs.org'), { reason: 'unreachable' })
  // Only the host leaves this module, never credentials or a path.
  assert.deepEqual(installFailure(`[ERR_PNPM_META_FETCH_FAIL] GET https://user:secret@npm.corp.example:8443/${PACKAGE_NAME}: fetch failed`), { reason: 'unreachable', registry: 'npm.corp.example:8443' })
  // Another package's 404 and any other failure are not this update's.
  assert.equal(installFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/left-pad/-/left-pad-9.9.9.tgz: Not Found - 404'), undefined)
  assert.equal(installFailure('pnpm exploded with secret-ish output'), undefined)
  assert.equal(installFailure(undefined), undefined)
})

test('an install source that lags or is out of reach is reported, and anything else stays generic', async (t) => {
  const root = await tempHome(t)
  const ownPackageJsonUrl = await npmInstall(root)
  const managerFor = runCommand => createPluginManager({ dshHome: root, ownPackageJsonUrl, fetchImpl: registryOk('1.0.4'), runCommand })
  assert.deepEqual(await managerFor(async () => ({ code: 1, stdout: '', stderr: MIRROR_NOT_SYNCED })).update(), {
    version: '1.0.4', profile: 'web', failed: 'syncing', registry: 'registry.npmmirror.com',
  })
  assert.deepEqual(await managerFor(async () => ({ code: 1, stdout: SOURCE_UNREACHABLE, stderr: '' })).update(), {
    version: '1.0.4', profile: 'web', failed: 'unreachable', registry: 'registry.npmjs.org',
  })
  await assert.rejects(
    () => managerFor(async () => ({ code: 1, stdout: '', stderr: 'pnpm exploded with secret-ish output' })).update(),
    error => error.message === 'Chrome Use update failed',
  )
  // A pnpm that would not even start, as on Windows without the desktop app's own.
  await assert.rejects(
    () => managerFor(async () => { throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) }).update(),
    error => error.message === 'Chrome Use update failed',
  )
})

test('an install without an owning profile refuses to guess one', async (t) => {
  const root = await tempHome(t)
  const stray = join(root, 'elsewhere', 'package.json')
  await writeManifest(stray, { name: PACKAGE_NAME, version: '1.0.3' })
  const manager = createPluginManager({ dshHome: root, ownPackageJsonUrl: pathToFileURL(stray), fetchImpl: registryOk('1.0.4') })
  assert.deepEqual((await manager.read()).install, { kind: 'unknown' })
  await assert.rejects(() => manager.update(), /only update an install from npm/)
})

test('a pnpm that hangs past the bound reads as an unreachable source', async (t) => {
  const root = await tempHome(t)
  // Started by the real spawn: Node reports the bound as its own AbortError, which must not hide the reason.
  const pnpm = join(root, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  await mkdir(join(pnpm, '..'), { recursive: true })
  await writeFile(pnpm, 'setInterval(() => {}, 1000)\n')
  const manager = createPluginManager({
    dshHome: root,
    ownPackageJsonUrl: await npmInstall(root),
    fetchImpl: registryOk('1.0.4'),
    execPath: process.execPath,
    argv: [process.execPath, pnpm],
    updateTimeoutMs: 300,
  })
  assert.deepEqual(await manager.update(), { version: '1.0.4', profile: 'web', failed: 'unreachable' })
})

test('the channel answers its two endpoints and says nothing about why a request failed', async () => {
  const projection = { current: '1.0.3', latest: '1.0.4' }
  const handler = createVersionChannel({
    read: async () => projection,
    update: async () => ({ version: '1.0.4', profile: 'web' }),
  })
  assert.deepEqual(await handler('plugin/version', {}), { ok: true, value: projection })
  assert.deepEqual(await handler('plugin/update', {}), { ok: true, value: { version: '1.0.4', profile: 'web' } })

  const refusal = { ok: false, error: { code: 'chrome-use/request-failed', message: 'Chrome Use request failed', details: {} } }
  assert.deepEqual(await handler('toString', {}), refusal)
  const failing = createVersionChannel({
    read: async () => { throw new Error('leaked internals') },
    update: async () => { throw new Error('leaked internals') },
  })
  assert.deepEqual(await failing('plugin/version', {}), refusal)
  assert.deepEqual(await failing('plugin/update', {}), refusal)
})
