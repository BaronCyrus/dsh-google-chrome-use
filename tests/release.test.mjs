import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

import { parseReleaseNotes, readReleaseNotes } from '../scripts/release-notes.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const ON_A_TAG = "github.event_name == 'push'"
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = () => JSON.parse(read('package.json'))
const workflow = () => parse(read('.github/workflows/publish.yml'))
const step = (job, name) => job.steps.find(entry => entry.name === name)
const NOTES = '# v1.2.9：修复某个问题\n\n修复说明。\n'

test('every release notes file names its own version', () => {
  const files = readdirSync(new URL('../docs/releases/', import.meta.url)).filter(name => name.endsWith('.md'))
  assert.ok(files.length > 0)
  for (const name of files) {
    const version = /^v(\d+\.\d+\.\d+)\.md$/u.exec(name)?.[1]
    assert.ok(version, `${name}: notes are named v<version>.md`)
    assert.match(readReleaseNotes(version).title, new RegExp(`^v${version.replaceAll('.', '\\.')}：\\S`, 'u'), name)
  }
})

test('the version in package.json has its GitHub Release notes before it can be tagged', () => {
  const { version } = manifest()
  assert.doesNotThrow(() => readReleaseNotes(version), `write docs/releases/v${version}.md`)
})

test('notes split into the release title and body', () => {
  assert.deepEqual(parseReleaseNotes(NOTES, '1.2.9'), { title: 'v1.2.9：修复某个问题', body: '修复说明。\n' })
  assert.equal(parseReleaseNotes(NOTES.replaceAll('\n', '\r\n'), '1.2.9').title, 'v1.2.9：修复某个问题')
})

test('malformed or mismatched notes are refused with the reason', () => {
  const cases = [
    [NOTES.replace('# v1.2.9：', '# v1.2.9: '), /must start with "# v1\.2\.9：<title>"/u],
    [NOTES.replace('# v1.2.9：修复某个问题', '# v1.2.9：'), /must start with/u],
    [NOTES.replace('# v1.2.9：', '# v1.2.8：'), /titled v1\.2\.8, not v1\.2\.9/u],
    ['# v1.2.9：标题\n\n   \n', /have no body/u],
    ['修复说明。', /must start with/u],
  ]
  for (const [text, reason] of cases) assert.throws(() => parseReleaseNotes(text, '1.2.9'), reason)
  assert.throws(() => parseReleaseNotes(NOTES, 'v1.2.9'), /plain version/u)
  assert.throws(() => readReleaseNotes('0.0.0'), /docs\/releases\/v0\.0\.0\.md is missing/u)
})

test('the script prints the title, writes the body, and exits 1 on missing notes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chrome-use-release-notes-'))
  try {
    const bodyFile = join(directory, 'body.md')
    const { version } = manifest()
    const title = execFileSync(process.execPath, [SCRIPT, version, '--body-file', bodyFile], { encoding: 'utf8' })
    const notes = readReleaseNotes(version)
    assert.equal(title, `${notes.title}\n`)
    assert.equal(readFileSync(bodyFile, 'utf8'), notes.body)
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '0.0.0'], { stdio: 'pipe' }), error => error.status === 1 && /is missing/u.test(String(error.stderr)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('nothing reaches npm or a GitHub Release before the checks and every CI job', () => {
  const { jobs } = workflow()
  assert.deepEqual(Object.keys(jobs), ['package', 'test', 'publish', 'release', 'trusted-publisher'])
  assert.equal(jobs.test.needs, 'package')
  assert.equal(jobs.test.uses, './.github/workflows/ci.yml')
  assert.ok('workflow_call' in parse(read('.github/workflows/ci.yml')).on, 'publish.yml can call CI')
  assert.equal(jobs.publish.needs, 'test')
  assert.equal(jobs.release.needs, 'publish')
  const at = name => jobs.package.steps.findIndex(entry => entry.name === name)
  const handOff = at('Hand the tarball to the later jobs')
  for (const name of ['Refuse a tag that does not match package.json', 'Refuse a version without its GitHub Release notes', 'Refuse a version npm already has']) {
    assert.ok(at(name) >= 0 && at(name) < handOff, `${name} comes before the hand-off`)
  }
})

test('only a tag publishes or creates a release, and a manual run asks npm instead', () => {
  const { jobs, on } = workflow()
  assert.deepEqual(Object.keys(on), ['push', 'workflow_dispatch'])
  assert.deepEqual(on.push, { tags: ['v*'] })
  assert.equal(step(jobs.publish, 'Publish').if, ON_A_TAG)
  assert.equal(jobs.release.if, ON_A_TAG)
  assert.equal(jobs['trusted-publisher'].if, "github.event_name == 'workflow_dispatch'")
  const publishing = Object.entries(jobs).flatMap(([name, job]) => (job.steps ?? []).filter(entry => /\bnpm publish\b/u.test(entry.run ?? '')).map(entry => [name, entry]))
  assert.deepEqual(publishing.map(([name]) => name), ['package', 'publish'])
  assert.match(publishing[0][1].run, /--dry-run$/u, 'the package job only rehearses')
  assert.equal(publishing[0][1].if, ON_A_TAG)
  assert.doesNotMatch(publishing[1][1].run, /--dry-run/u)
})

test('only the jobs that need more than reading get it, and they run no dependency code', () => {
  const { jobs, permissions } = workflow()
  assert.deepEqual(permissions, { contents: 'read' })
  assert.deepEqual(jobs.publish.permissions, { 'id-token': 'write' })
  assert.deepEqual(jobs['trusted-publisher'].permissions, { 'id-token': 'write' })
  assert.deepEqual(jobs.release.permissions, { contents: 'write' })
  for (const name of ['package', 'test']) assert.equal(jobs[name].permissions, undefined, name)

  assert.deepEqual(jobs.publish.steps.filter(entry => entry.uses).map(entry => entry.uses), ['actions/setup-node@v4', 'actions/download-artifact@v4'])
  assert.deepEqual(jobs.release.steps.filter(entry => entry.uses).map(entry => entry.uses), ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/download-artifact@v4'])
  assert.equal(jobs.release.steps[0].with['persist-credentials'], false)
  for (const name of ['package', 'publish', 'release', 'trusted-publisher']) {
    for (const entry of jobs[name].steps.filter(item => item.run)) {
      assert.doesNotMatch(entry.run, /\bpnpm (?:install|add|exec|dlx|run)\b|\bnpm (?:install|ci|exec|run)\b|\bnpx\b/u, `${name}: ${entry.name}`)
    }
  }
})

test('the package job can pack without installing anything', () => {
  const { scripts } = manifest()
  for (const lifecycle of ['prepack', 'prepare', 'prepublish', 'prepublishOnly', 'postpack']) assert.equal(scripts[lifecycle], undefined, lifecycle)
})

test('the tarball survives the hand-off', () => {
  const { jobs } = workflow()
  const handOff = step(jobs.package, 'Hand the tarball to the later jobs')
  // upload-artifact@v4 silently skips .artifacts without this.
  assert.equal(handOff.with['include-hidden-files'], true)
  assert.equal(handOff.with['if-no-files-found'], 'error')
  for (const name of ['publish', 'release']) {
    const download = jobs[name].steps.find(entry => entry.uses === 'actions/download-artifact@v4')
    assert.equal(download.with.name, handOff.with.name, name)
    assert.equal(download.with.path, '.artifacts', name)
  }
})

test('nothing in the workflow switches npm from OIDC to token auth', () => {
  for (const job of Object.values(workflow().jobs)) {
    for (const entry of job.steps ?? []) {
      assert.equal(entry.with?.['registry-url'], undefined, `${entry.name ?? entry.uses}: a registry-url means token auth`)
      assert.equal(entry.env?.NODE_AUTH_TOKEN, undefined)
    }
  }
  assert.doesNotMatch(read('.github/workflows/publish.yml'), /NODE_AUTH_TOKEN:|secrets\./u)
})

test('the release job makes the GitHub Release from the notes and the tarball', () => {
  const create = step(workflow().jobs.release, 'Create the release with the tarball npm published')
  assert.equal(create.env.GH_TOKEN, '${{ github.token }}')
  assert.match(create.run, /title="\$\(node scripts\/release-notes\.mjs "\$version" --body-file "\$notes"\)"/u)
  assert.match(create.run, /gh release create "\$GITHUB_REF_NAME" "\.artifacts\/dsh-google-chrome-use-\$version\.tgz" --verify-tag --latest --title "\$title" --notes-file "\$notes"/u)
  assert.match(create.run, /if gh release view "\$GITHUB_REF_NAME"/u, 'a release made by hand is left unchanged')
})
