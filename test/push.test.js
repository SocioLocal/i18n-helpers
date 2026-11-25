'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planUploads, pushStrings, waitForUpload } = require('../src/push')
const { makeSet } = require('../src/config')

const SETS = {
  web: makeSet('web', { dir: '/repo/web', locales: ['en', 'fr', 'nl'] }),
  editor: makeSet('editor', { dir: '/repo/editor', locales: ['en', 'fr', 'it', 'nl'], segments: ['action', 'common'] })
}

const FILES = {
  nl: { a: { x: 'nl-x', y: 'nl-y' }, stale: 'only in nl' },
  en: { a: { x: 'en-x', y: 'en-y' }, b: 'en-b' },
  fr: { a: { x: 'fr-x' } }
}

test('English is planned first, and by default no existing Phrase value is overwritten', () => {
  const plan = planUploads({ filesByLocale: FILES })

  assert.deepEqual(plan.map(p => p.code), ['en', 'fr', 'nl'])
  assert.deepEqual(plan.map(p => p.updateTranslations), [false, false, false])
})

test('bootstrap mode makes every locale overwrite Phrase', () => {
  const plan = planUploads({ filesByLocale: FILES, overwrite: true })

  assert.deepEqual(plan.map(p => p.updateTranslations), [true, true, true])
})

test('keys a locale has but English lacks are left out and counted', () => {
  const plan = planUploads({ filesByLocale: FILES })
  const nl = plan.find(p => p.code === 'nl')

  assert.deepEqual(JSON.parse(nl.content), { a: { x: 'nl-x', y: 'nl-y' } })
  assert.equal(nl.skippedNotInEnglish, 1)
  assert.equal(nl.keys, 2)
})

test('a dry run uploads nothing and needs no client', async () => {
  const results = await pushStrings({ client: null, set: SETS.web, filesByLocale: FILES, dryRun: true })

  assert.deepEqual(results.map(r => [r.code, r.keys, r.uploaded]), [['en', 3, false], ['fr', 1, false], ['nl', 2, false]])
  assert.ok(results.every(r => r.content === undefined))
})

test('the English file is required', async () => {
  await assert.rejects(pushStrings({ client: null, set: SETS.web, filesByLocale: { fr: {} }, dryRun: true }), /English file is the source/)
})

function fakeClient ({ states = ['success'], localeCodes = ['en', 'fr', 'nl'], tags = ['web', 'editor'] } = {}) {
  const uploads = []
  const polls = {}
  return {
    uploads,
    listLocales: async () => localeCodes.map(code => ({ id: `id-${code}`, code })),
    listTags: async () => tags.map(name => ({ name })),
    uploadFile: async args => {
      uploads.push(args)
      return { id: `up-${args.localeId}` }
    },
    getUpload: async id => {
      polls[id] = (polls[id] || 0) + 1
      const state = states[Math.min(polls[id] - 1, states.length - 1)]
      return { id, state, summary: { translation_keys_created: 2 }, error_message: state === 'error' ? 'bad file' : null }
    }
  }
}

test('a real push uploads nested_json tagged web, waits for each upload, and reports the summaries', async () => {
  const client = fakeClient({ states: ['processing', 'success'] })

  const results = await pushStrings({ client, set: SETS.web, filesByLocale: FILES, sleep: async () => {} })

  assert.deepEqual(client.uploads.map(u => [u.localeId, u.updateTranslations]), [['id-en', false], ['id-fr', false], ['id-nl', false]])
  assert.ok(client.uploads.every(u => u.fileFormat === 'nested_json' && u.tags === 'web'))
  assert.ok(results.every(r => r.uploaded && r.summary.translation_keys_created === 2))
})

test('a real push in bootstrap mode asks Phrase to update existing translations', async () => {
  const client = fakeClient()

  await pushStrings({ client, set: SETS.web, filesByLocale: FILES, overwrite: true, sleep: async () => {} })

  assert.ok(client.uploads.every(u => u.updateTranslations === true))
})

test('a locale the project lacks is skipped, not failed', async () => {
  const client = fakeClient({ localeCodes: ['en', 'fr'] })
  const logs = []

  const results = await pushStrings({ client, set: SETS.web, filesByLocale: FILES, sleep: async () => {}, log: m => logs.push(m) })

  assert.deepEqual(results.map(r => [r.code, r.uploaded]), [['en', true], ['fr', true], ['nl', false]])
  assert.match(logs[0], /no such locale/)
})

test('an upload that ends in error stops the push with Phrase\'s reason', async () => {
  const client = fakeClient({ states: ['error'] })
  await assert.rejects(pushStrings({ client, set: SETS.web, filesByLocale: FILES, sleep: async () => {} }), /failed: bad file/)
})

test('waitForUpload gives up after the allowed attempts', async () => {
  const client = fakeClient({ states: ['processing'] })
  await assert.rejects(waitForUpload(client, 'up-1', { sleep: async () => {}, attempts: 3 }), /did not finish in time/)
})


test('a flat set keeps its dotted keys as they are, including keys that are also parents', () => {
  const files = {
    en: { 'action.align': 'Align', 'action.align.bottom': 'Bottom' },
    fr: { 'action.align': 'Aligner', 'action.align.bottom': 'Bas', 'only.fr': 'x' }
  }
  const plan = planUploads({ filesByLocale: files, shape: 'flat' })

  assert.deepEqual(JSON.parse(plan[1].content), { 'action.align': 'Aligner', 'action.align.bottom': 'Bas' })
  assert.equal(plan[1].skippedNotInEnglish, 1)
})

test('the editor set uploads as simple_json tagged editor; the web set as nested_json tagged web', async () => {
  const editorClient = fakeClient()
  await pushStrings({ client: editorClient, set: SETS.editor, filesByLocale: { en: { 'a.b': 'x', a: 'y' } }, sleep: async () => {} })
  assert.deepEqual([editorClient.uploads[0].fileFormat, editorClient.uploads[0].tags], ['simple_json', 'editor'])

  const webClient = fakeClient()
  await pushStrings({ client: webClient, set: SETS.web, filesByLocale: { en: { a: 'x' } }, sleep: async () => {} })
  assert.deepEqual([webClient.uploads[0].fileFormat, webClient.uploads[0].tags], ['nested_json', 'web'])
})

test('a push to a key space the Phrase project does not have yet is an error, and uploads nothing', async () => {
  const client = fakeClient({ tags: ['editor'] })

  await assert.rejects(
    pushStrings({ client, set: SETS.web, filesByLocale: { en: { a: 'x' } }, sleep: async () => {} }),
    /The "web" key space does not exist in this Phrase project yet.*create-space web/
  )
  assert.deepEqual(client.uploads, [])
})

test('a dry run needs no Phrase project at all, not even to check the key space', async () => {
  const result = await pushStrings({ client: null, set: SETS.web, filesByLocale: { en: { a: 'x' } }, dryRun: true })

  assert.equal(result[0].uploaded, false)
})
