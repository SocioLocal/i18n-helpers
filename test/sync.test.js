'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { unwrapMessages, nest, flatten, publish, buildManifest, syncProject } = require('../src/sync')

const wrap = flat => Object.fromEntries(Object.entries(flat).map(([key, message]) => [key, { message }]))
const FIXED_NOW = () => new Date(Date.UTC(2026, 10, 25, 3, 0, 0))

function memoryStore (initial = {}) {
  const files = { ...initial }
  return {
    files,
    async get (file) { return files[file] ? JSON.parse(files[file]) : null },
    async put (file, body) { files[file] = body }
  }
}

test('unwrapMessages keeps only the message text', () => {
  assert.deepEqual(unwrapMessages({ 'a.b': { message: 'x', description: 'ignored' } }), { 'a.b': 'x' })
})

test('nest builds the nested structure and flatten reverses it', () => {
  const nested = { a: { b: '1', c: { d: '2' } }, e: '3' }
  assert.deepEqual(nest({ 'a.b': '1', 'a.c.d': '2', e: '3' }), nested)
  assert.deepEqual(flatten(nested), { 'a.b': '1', 'a.c.d': '2', e: '3' })
})

test('nest refuses a key that is both text and a parent, in either order', () => {
  assert.throws(() => nest({ 'action.align': 'Align', 'action.align.bottom': 'Bottom' }), /both text and a parent/)
  assert.throws(() => nest({ 'action.align.bottom': 'Bottom', 'action.align': 'Align' }), /both text and a parent/)
})

test('publish writes nothing if any output is refused', async () => {
  const store = memoryStore({ 'web/fr.json': JSON.stringify({ a: '1', b: '2', c: '3', d: '4', e: '5' }) })
  await assert.rejects(
    publish({ outputs: { 'web/en.json': { a: '1' }, 'web/fr.json': { a: '1' } }, store }),
    /Refusing to publish web\/fr.json: 1 keys, live file has 5/
  )
  assert.equal(store.files['web/en.json'], undefined)
})

test('publish refuses to replace a live file with an empty one but skips a new empty one', async () => {
  const store = memoryStore({ 'web/en.json': JSON.stringify({ a: '1' }) })
  await assert.rejects(publish({ outputs: { 'web/en.json': {} }, store }), /no keys/)
  const written = await publish({ outputs: { 'web/it.json': {}, 'editor/it.json': { x: 'y' } }, store })
  assert.deepEqual(written, [{ path: 'editor/it.json', keys: 1 }])
})

// A Phrase project fake: keys by tag, per locale
function projectClient ({ locales = [{ id: 'L1', code: 'en' }], keysByTag, missingTags = [] }) {
  const calls = []
  return {
    calls,
    listLocales: async () => locales,
    downloadLocale: async (id, options) => {
      calls.push({ id, ...options })
      if (missingTags.includes(options.tags)) {
        throw Object.assign(new Error(`Phrase GET /download failed: HTTP 400: Parameter tags '${options.tags}' could not be found.`), { status: 400 })
      }
      const forLocale = keysByTag[options.tags] || {}
      return wrap(forLocale[id] || forLocale)
    }
  }
}

test('every key space is downloaded by its tag and published in the shape its readers use', async () => {
  const client = projectClient({
    keysByTag: {
      web: { 'onboarding.title': 'Welcome' },
      editor: { 'action.align': 'Align', 'action.align.bottom': 'Bottom' },
      email: { 'welcome.subject': 'Hi' }
    }
  })
  const store = memoryStore()

  const written = await syncProject({ client, store })

  // web and email are published nested, the editor flat (spaces.js)
  assert.deepEqual(JSON.parse(store.files['web/en.json']), { onboarding: { title: 'Welcome' } })
  assert.deepEqual(JSON.parse(store.files['editor/en.json']), { 'action.align': 'Align', 'action.align.bottom': 'Bottom' })
  assert.deepEqual(JSON.parse(store.files['email/en.json']), { welcome: { subject: 'Hi' } })
  assert.deepEqual(written.map(file => file.path), ['web/en.json', 'editor/en.json', 'email/en.json', 'locales.json'])
  assert.deepEqual(client.calls.map(call => call.tags), ['web', 'editor', 'email'])
  assert.ok(client.calls.every(call => call.fileFormat === 'json'))
})

test('only the registry\'s key spaces can be published', async () => {
  const client = projectClient({ keysByTag: { web: { a: '1' }, push: { 'notification.title': 'New' } } })

  await assert.rejects(syncProject({ client, store: memoryStore(), apps: ['web', 'push'] }), /"push" is not a key space/)
})

test('a nested key space that cannot be nested fails the whole sync and leaves the live files as they were', async () => {
  const client = projectClient({ keysByTag: { web: { 'a.b': '1', a: '2' }, editor: { x: '1' } } })
  const store = memoryStore({ 'web/en.json': JSON.stringify({ a: { b: '1' } }) })

  await assert.rejects(syncProject({ client, store }), /web\/en: Cannot nest keys that are both text and a parent: a/)

  assert.deepEqual(JSON.parse(store.files['web/en.json']), { a: { b: '1' } })
  assert.equal(store.files['editor/en.json'], undefined)
})

test('a key space nobody has pushed yet has no files and is not an error', async () => {
  const client = projectClient({ keysByTag: { web: { a: '1' } }, missingTags: ['editor', 'email'] })
  const store = memoryStore()

  const written = await syncProject({ client, store })

  assert.deepEqual(written.map(file => file.path), ['web/en.json', 'locales.json'])
  assert.equal(store.files['editor/en.json'], undefined)
})

test('any other download error is not swallowed', async () => {
  const client = projectClient({ keysByTag: {} })
  client.downloadLocale = async () => { throw Object.assign(new Error('boom'), { status: 500 }) }
  await assert.rejects(syncProject({ client, store: memoryStore() }), /boom/)
})

test('keys of another tag, such as the API\'s old email keys, are never published', async () => {
  const client = projectClient({ keysByTag: { web: { a: '1' }, 'postIsRejected': { 'postIsRejected.subject': 'old' } } })
  const store = memoryStore()

  await syncProject({ client, store })

  assert.ok(!Object.values(store.files).some(body => body.includes('postIsRejected')))
})

test('the manifest lists each language with how much of English each key space covers', () => {
  const manifest = buildManifest({
    now: FIXED_NOW,
    counts: {
      nl: { web: 50, editor: 100 },
      en: { web: 100, editor: 100 },
      it: { web: 0, editor: 90 },
      xx: { web: 0, editor: 0 }
    }
  })

  assert.equal(manifest.updatedAt, '2026-11-25T03:00:00.000Z')
  assert.deepEqual(manifest.locales, [
    { code: 'en', apps: { web: { keys: 100, coverage: 1 }, editor: { keys: 100, coverage: 1 } } },
    { code: 'it', apps: { web: { keys: 0, coverage: 0 }, editor: { keys: 90, coverage: 0.9 } } },
    { code: 'nl', apps: { web: { keys: 50, coverage: 0.5 }, editor: { keys: 100, coverage: 1 } } }
  ])
})

test('the manifest cannot divide by an English key space that is empty', () => {
  const manifest = buildManifest({ now: FIXED_NOW, counts: { en: { web: 0 }, fr: { web: 2 } } })
  assert.equal(manifest.locales.find(l => l.code === 'fr').apps.web.coverage, null)
})

test('a sync publishes the manifest with the languages that have text, Italian included', async () => {
  const client = projectClient({
    locales: [{ id: 'L1', code: 'en' }, { id: 'L2', code: 'it' }],
    keysByTag: { web: { L1: { 'onboarding.title': 'Welcome', 'onboarding.sub': 'Sub' }, L2: {} }, editor: { L1: { 'action.align': 'Align' }, L2: { 'action.align': 'Allinea' } } }
  })
  const store = memoryStore()

  await syncProject({ client, store, apps: ['web', 'editor'], now: FIXED_NOW })

  const manifest = JSON.parse(store.files['locales.json'])
  assert.deepEqual(manifest.locales.map(l => [l.code, l.apps.web.keys, l.apps.editor.keys]), [['en', 2, 1], ['it', 0, 1]])
})

test('the manifest is not published when a file was refused, so it never announces a language that is missing', async () => {
  const store = memoryStore({ 'editor/en.json': JSON.stringify({ a: '1', b: '2', c: '3', d: '4', e: '5' }) })
  const client = projectClient({ keysByTag: { editor: { 'action.align': 'Align' } }, missingTags: ['web', 'email'] })

  await assert.rejects(syncProject({ client, store, now: FIXED_NOW }), /Refusing to publish/)

  assert.equal(store.files['locales.json'], undefined)
})
