'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spaceStatus } = require('../src/status')
const { makeSet } = require('../src/config')

const SET = makeSet('web', { dir: '/repo/web', locales: ['en', 'fr'] })
const wrap = flat => Object.fromEntries(Object.entries(flat).map(([key, message]) => [key, { message }]))

function client ({ tags = ['web'], phrase = {} } = {}) {
  return {
    listTags: async () => tags.map(name => ({ name })),
    listLocales: async () => [{ id: 'L-en', code: 'en' }, { id: 'L-fr', code: 'fr' }],
    downloadLocale: async id => wrap(phrase[id] || {})
  }
}

test('status says what a push would add, what is unused, and how many values Phrase changed', async () => {
  const files = { en: { a: 'A', n: 'new' }, fr: { a: 'A-fr' } }
  const c = client({ phrase: { 'L-en': { a: 'A', stale: 'old', kept: 'k' }, 'L-fr': { a: 'A-phrase' } } })

  const status = await spaceStatus({ client: c, set: SET, filesByLocale: files, keep: new Set(['kept']) })

  assert.deepEqual(status.toAdd, ['n'])
  assert.deepEqual(status.unused, ['stale'])
  assert.deepEqual(status.changedValues, [{ code: 'en', values: 0 }, { code: 'fr', values: 1 }])
})

test('a key space the Phrase project does not have yet is reported, not an error', async () => {
  const status = await spaceStatus({ client: client({ tags: [] }), set: SET, filesByLocale: { en: { a: 'A' } } })

  assert.deepEqual(status, { exists: false, repoKeys: 1 })
})
