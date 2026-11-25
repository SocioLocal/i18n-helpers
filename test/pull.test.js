'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { applyValues, pullStrings, serialize } = require('../src/pull')
const { makeSet } = require('../src/config')

const SETS = {
  web: makeSet('web', { dir: '/repo/web', locales: ['en', 'fr', 'nl'] }),
  editor: makeSet('editor', { dir: '/repo/editor', locales: ['en', 'fr', 'it', 'nl'], segments: ['action', 'common'] })
}

const wrap = flat => Object.fromEntries(Object.entries(flat).map(([key, message]) => [key, { message }]))

test('a pull changes the values of keys the repo has and nothing else', () => {
  const repo = { Common: { save: 'Save', cancel: 'Cancel' }, title: 'Title' }
  const phrase = { 'Common.save': 'Save changes', 'Common.cancel': 'Cancel', 'onboarding.terms.noun.store': 'Store' }

  const { node, stats } = applyValues(repo, phrase)

  assert.deepEqual(node, { Common: { save: 'Save changes', cancel: 'Cancel' }, title: 'Title' })
  assert.equal(stats.updated, 1)
  assert.equal(stats.unchanged, 1)
  assert.equal(stats.missingInPhrase, 1)
  assert.deepEqual(stats.updatedKeys, ['Common.save'])
})

test('a pull keeps the key order of the repo file', () => {
  const repo = { z: 'z', a: { y: 'y', b: 'b' }, m: 'm' }
  const { node } = applyValues(repo, { z: 'Z!', 'a.b': 'B!' })

  assert.deepEqual(Object.keys(node), ['z', 'a', 'm'])
  assert.deepEqual(Object.keys(node.a), ['y', 'b'])
})

test('an empty value in Phrase never blanks the repo text', () => {
  const { node, stats } = applyValues({ a: 'Keep me' }, { a: '' })

  assert.deepEqual(node, { a: 'Keep me' })
  assert.equal(stats.missingInPhrase, 1)
})

test('non-string values in the repo file are left alone', () => {
  const repo = { list: ['a', 'b'], n: 3, a: 'x' }
  assert.deepEqual(applyValues(repo, { list: 'nope', n: 'nope', a: 'y' }).node, { list: ['a', 'b'], n: 3, a: 'y' })
})

test('the web tag is requested, and a locale Phrase lacks is reported, not failed', async () => {
  const requested = []
  const client = {
    listLocales: async () => [{ id: 'L-en', code: 'en' }],
    downloadLocale: async (id, options) => {
      requested.push(options)
      return wrap({ a: 'A from Phrase', 'only.in.phrase': 'x' })
    }
  }

  const results = await pullStrings({ client, set: SETS.web, filesByLocale: { en: { a: 'A' }, fr: { a: 'A' } } })

  assert.deepEqual(requested, [{ fileFormat: 'json', tags: 'web' }])
  assert.deepEqual(results.map(r => [r.code, r.found]), [['en', true], ['fr', false]])
  assert.equal(results[0].onlyInPhrase, 1)
  assert.equal(results[0].content.a, 'A from Phrase')
})

const { applyFlatValues } = require('../src/pull')

test('a flat pull changes values of keys the repo has, keeps order, and adds nothing', () => {
  const repo = { 'action.align': 'Align', 'action.align.bottom': 'Bottom', zebra: 'Z' }
  const { node, stats } = applyFlatValues(repo, { 'action.align': 'Aligner', 'action.align.bottom': 'Bottom', 'libraries.new': 'N' })

  assert.deepEqual(node, { 'action.align': 'Aligner', 'action.align.bottom': 'Bottom', zebra: 'Z' })
  assert.deepEqual(Object.keys(node), ['action.align', 'action.align.bottom', 'zebra'])
  assert.deepEqual([stats.updated, stats.unchanged, stats.missingInPhrase], [1, 1, 1])
})

test('the editor set is pulled by its own tag, like every set', async () => {
  const requested = []
  const client = {
    listLocales: async () => [{ id: 'L-en', code: 'en' }],
    downloadLocale: async (id, options) => {
      requested.push(options)
      return wrap({ 'action.align': 'Aligner' })
    }
  }

  const [result] = await pullStrings({ client, set: SETS.editor, filesByLocale: { en: { 'action.align': 'Align' } } })

  assert.deepEqual(requested, [{ fileFormat: 'json', tags: 'editor' }])
  assert.equal(result.content['action.align'], 'Aligner')
  assert.equal(result.onlyInPhrase, 0)
})

test('a key space nobody has pushed yet is "nothing there yet", not a failure', async () => {
  const missing = Object.assign(new Error("Phrase GET /x failed: HTTP 400: Invalid Download Options. Parameter tags 'web' could not be found."), { status: 400 })
  const client = { listLocales: async () => [{ id: 'L-en', code: 'en' }], downloadLocale: async () => { throw missing } }

  const [result] = await pullStrings({ client, set: SETS.web, filesByLocale: { en: { a: 'A' } } })

  assert.deepEqual([result.code, result.found, result.noTaggedKeys], ['en', true, true])
})

test('any other download error is not swallowed by the pull', async () => {
  const client = { listLocales: async () => [{ id: 'L-en', code: 'en' }], downloadLocale: async () => { throw Object.assign(new Error('boom'), { status: 500 }) } }

  await assert.rejects(pullStrings({ client, set: SETS.web, filesByLocale: { en: { a: 'A' } } }), /boom/)
})

test('a pull remembers what each changed value was and became, so it can be reviewed', () => {
  const { stats } = applyValues({ a: { x: 'repo text', y: 'same' } }, { 'a.x': 'Phrase text', 'a.y': 'same' })

  assert.deepEqual(stats.changes, [{ key: 'a.x', from: 'repo text', to: 'Phrase text' }])
  assert.deepEqual(stats.updatedKeys, ['a.x'])
})
