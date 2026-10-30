import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import TestRenderer from 'react-test-renderer'

const { act, create } = TestRenderer
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const text = node => (typeof node === 'string' ? node : node.children.map(text).join(''))
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (_match, name) => String(values[name]))
const settle = () => act(async () => { await new Promise(resolve => setImmediate(resolve)) })

const npmInfo = { current: '1.0.3', installed: '1.0.3', latest: '1.0.4', updateAvailable: true, restartNeeded: false, install: { kind: 'npm', profile: 'desktop' } }

/** Load the page the way DSH does, and render it against a channel answering from `answers`. */
async function renderPage(t, answers) {
  let client
  const window = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, manifest.name)
        client = spec.factory((name) => {
          assert.equal(name, 'react', 'the page may only require what DSH shares')
          return react
        })
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window,
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })

  const calls = []
  const rpc = {
    async call(channel, endpoint) {
      assert.equal(channel, '/chrome-use')
      calls.push(endpoint)
      const answer = answers[endpoint]
      if (answer === undefined) return { ok: false, error: { code: 'x', message: 'not under test', details: {} } }
      return { ok: true, value: structuredClone(typeof answer === 'function' ? answer() : answer) }
    },
  }
  let copy
  let section
  client.apply({
    locale: {
      register(_namespace, locales) { copy = locales },
      bind: () => key => copy.zh[key],
    },
    effect: fn => fn(),
    get: name => (name === 'connection' ? { rpc } : undefined),
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'settings.section')
        fn()
      },
      register: (spec, component) => { section = { spec, component } },
    },
  })
  assert.deepEqual([...client.inject], ['slots', 'locale', 'connection'])

  let root
  await act(async () => { root = create(react.createElement(section.component, section.spec.inject())) })
  await settle()
  t.after(() => act(async () => root.unmount()))

  const button = label => root.root.findAll(node => node.type === 'button' && text(node) === label)
  return {
    calls,
    copy,
    section,
    zh: copy.zh,
    button,
    wholeText: () => text(root.root.find(node => node.type === 'section')),
    async click(label) {
      await act(async () => button(label)[0].props.onClick())
      await settle()
    },
  }
}

test('the page registers under Settings, in both languages', async (t) => {
  const page = await renderPage(t, { 'plugin/version': npmInfo })
  assert.equal(page.section.spec.id, 'chrome-use')
  assert.equal(page.section.spec.label(), 'Chrome Use')
  assert.deepEqual(Object.keys(page.copy.en).sort(), Object.keys(page.copy.zh).sort())
})

test('a new version from npm can be installed with one click, and then asks for a restart', async (t) => {
  let info = npmInfo
  const page = await renderPage(t, {
    'plugin/version': () => info,
    'plugin/update': () => {
      info = { ...npmInfo, installed: '1.0.4', updateAvailable: false, restartNeeded: true }
      return { version: '1.0.4', profile: 'desktop' }
    },
  })
  assert.match(page.wholeText(), /v1\.0\.3/)
  assert.ok(page.wholeText().includes(fill(page.zh.available, { version: '1.0.4' })))
  await page.click(page.zh.update)
  assert.deepEqual(page.calls, ['plugin/version', 'plugin/update', 'plugin/version'])
  assert.ok(page.wholeText().includes(fill(page.zh.restart, { version: '1.0.4' })))
  assert.equal(page.button(page.zh.update).length, 0)
  // The process still runs 1.0.3, so it must not read as up to date.
  assert.ok(page.wholeText().includes(page.zh.running))
  assert.ok(!page.wholeText().includes(page.zh.upToDate))
})

test('nothing to install means no update button', async (t) => {
  const page = await renderPage(t, { 'plugin/version': { ...npmInfo, latest: '1.0.3', updateAvailable: false } })
  assert.ok(page.wholeText().includes(page.zh.upToDate))
  assert.equal(page.button(page.zh.update).length, 0)
  assert.equal(page.button(page.zh.check).length, 1)
})

test('without npm the page still shows the running version', async (t) => {
  const page = await renderPage(t, { 'plugin/version': { ...npmInfo, latest: undefined, updateAvailable: false } })
  assert.match(page.wholeText(), /v1\.0\.3/)
  assert.ok(page.wholeText().includes(page.zh.latestUnknown))
  assert.equal(page.button(page.zh.update).length, 0)
})

test('only an install from npm gets the button', async (t) => {
  const linked = await renderPage(t, { 'plugin/version': { ...npmInfo, install: { kind: 'link', profile: 'desktop' } } })
  assert.equal(linked.button(linked.zh.update).length, 0)
  assert.ok(linked.wholeText().includes(linked.zh.linked))

  const unknown = await renderPage(t, { 'plugin/version': { ...npmInfo, install: { kind: 'unknown' } } })
  assert.equal(unknown.button(unknown.zh.update).length, 0)
  assert.ok(unknown.wholeText().includes(unknown.zh.manual))
})

test('an update that installed nothing says why and can be tried again', async (t) => {
  const availableAt = Date.parse('2026-10-18T19:16:25.489Z')
  const outcomes = [
    [{ version: '1.0.4', profile: 'desktop', pending: true, availableAt }, zh => fill(zh.coolingUntil, { version: '1.0.4', time: new Date(availableAt).toLocaleString() })],
    [{ version: '1.0.4', profile: 'desktop', pending: true }, zh => fill(zh.cooling, { version: '1.0.4' })],
    [{ version: '1.0.4', profile: 'desktop', failed: 'syncing', registry: 'registry.npmmirror.com' }, zh => fill(zh.syncingFrom, { version: '1.0.4', registry: 'registry.npmmirror.com' })],
    [{ version: '1.0.4', profile: 'desktop', failed: 'syncing' }, zh => fill(zh.syncing, { version: '1.0.4' })],
    [{ version: '1.0.4', profile: 'desktop', failed: 'unreachable', registry: 'registry.npmjs.org' }, zh => fill(zh.unreachableFrom, { version: '1.0.4', registry: 'registry.npmjs.org' })],
    [{ version: '1.0.4', profile: 'desktop', failed: 'unreachable' }, zh => fill(zh.unreachable, { version: '1.0.4' })],
  ]
  for (const [outcome, expected] of outcomes) {
    const page = await renderPage(t, { 'plugin/version': npmInfo, 'plugin/update': outcome })
    await page.click(page.zh.update)
    assert.ok(page.wholeText().includes(expected(page.zh)), page.wholeText())
    assert.equal(page.button(page.zh.update).length, 1)
  }

  const failing = await renderPage(t, { 'plugin/version': npmInfo })
  await failing.click(failing.zh.update)
  assert.ok(failing.wholeText().includes(failing.zh.updateFailed))
  assert.equal(failing.button(failing.zh.update).length, 1)
})

test('a page that cannot read the version says so', async (t) => {
  const page = await renderPage(t, {})
  assert.ok(page.wholeText().includes(page.zh.readFailed))
  assert.equal(page.button(page.zh.check).length, 1)
})
