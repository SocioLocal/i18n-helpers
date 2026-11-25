'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { tagExistingKeys, listAllKeys } = require('../src/tag-existing')
const { makeSet } = require('../src/config')

const SETS = {
  web: makeSet('web', { dir: '/repo/web', locales: ['en', 'fr', 'nl'] }),
  editor: makeSet('editor', { dir: '/repo/editor', locales: ['en', 'fr', 'it', 'nl'], segments: [
    'action', 'block', 'color', 'common', 'component', 'dialog', 'editor', 'element', 'error', 'input',
    'libraries', 'meta', 'notification', 'preset', 'property', 'scope', 'typography', 'variables', 'warning'
  ] })
}

// the editor, as this repo's settings describe it
const tagExistingEditorKeys = ({ editorKeys, webKeys, ...rest }) =>
  tagExistingKeys({ ...rest, tag: 'editor', ownKeys: editorKeys, otherKeys: webKeys, segments: SETS.editor.segments })

const wrap = flat => Object.fromEntries(Object.entries(flat).map(([key, message]) => [key, { message }]))

// keys: [{ id, name, tags }]; the client pages them 100 at a time like Phrase
function fakeClient ({ keys, carrying = {}, tagResult } = {}) {
  const tagged = []
  const pages = []
  return {
    tagged,
    pages,
    listKeys: async ({ page, perPage }) => { pages.push([page, perPage]); return keys.slice((page - 1) * perPage, page * perPage) },
    listLocales: async () => [{ id: 'L-en', code: 'en' }],
    tagKeys: async args => { tagged.push(args); return tagResult ? tagResult(args) : args.q.replace('ids:', '').split(',').length },
    downloadLocale: async () => wrap(carrying)
  }
}

const key = (id, name, tags = []) => ({ id, name, tags })
const EDITOR_KEYS = ['action.align', 'action.align.bottom', 'property.x', 'is not supported yet"']
const WEB_KEYS = ['Common.cancel', 'Editor.addTextToClipboard', 'onboarding.title']

test('every page of keys is read', async () => {
  const keys = Array.from({ length: 230 }, (_, i) => key(`k${i}`, `x.${i}`))
  const client = fakeClient({ keys })

  assert.equal((await listAllKeys(client)).length, 230)
  assert.deepEqual(client.pages, [[1, 100], [2, 100], [3, 100]])
})

test('a dry run reads and plans but writes nothing', async () => {
  const client = fakeClient({ keys: [key('1', 'action.align'), key('2', 'onboarding.title', ['web'])] })

  const { plan, tagged } = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS, dryRun: true })

  assert.deepEqual(client.tagged, [])
  assert.equal(tagged, 0)
  assert.equal(plan.toTag, 1)
})

test('it tags the editor\'s keys by id, matching exact names, including the odd one', async () => {
  const client = fakeClient({
    keys: [key('1', 'action.align'), key('2', 'is not supported yet"'), key('3', 'onboarding.title', ['web'])],
    carrying: { 'action.align': 'Align', 'is not supported yet"': 'x' }
  })

  const result = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS })

  assert.deepEqual(client.tagged, [{ q: 'ids:1,2', tags: 'editor' }])
  assert.equal(result.tagged, 2)
})

test('names are matched in exactly their case: the web\'s Common.cancel is not the editor\'s common.*', async () => {
  const client = fakeClient({
    keys: [key('1', 'common.add'), key('2', 'Common.cancel', ['web']), key('3', 'Editor.addTextToClipboard', ['web']), key('4', 'editor.title')],
    carrying: { 'common.add': 'Add', 'editor.title': 'T' }
  })

  const result = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS })

  assert.deepEqual(client.tagged, [{ q: 'ids:1,4', tags: 'editor' }])
  assert.deepEqual(result.plan.lookalikes, [])
})

test('a key that is also a web key is never tagged, whatever its tags say', async () => {
  const client = fakeClient({ keys: [key('1', 'Common.cancel'), key('2', 'action.align')], carrying: { 'action.align': 'A' } })

  const result = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: [...WEB_KEYS, 'common.cancel'] })

  assert.ok(!client.tagged.some(t => t.q.includes('ids:1')))
  assert.equal(result.tagged, 1)
})

test('a key that already has the tag is left alone, and one with another tag is reported', async () => {
  const client = fakeClient({
    keys: [key('1', 'action.align', ['editor']), key('2', 'action.align.bottom', ['web']), key('3', 'property.x')],
    carrying: { 'action.align': 'A', 'property.x': 'P' }
  })

  const { plan } = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS })

  assert.deepEqual(client.tagged, [{ q: 'ids:3', tags: 'editor' }])
  assert.equal(plan.alreadyTagged, 1)
  assert.deepEqual(plan.conflicts, [{ name: 'action.align.bottom', tags: ['web'] }])
})

test('editor keys only Phrase has are tagged too, by their first segment', async () => {
  const client = fakeClient({
    keys: [key('1', 'libraries.ly.img.vectorpath.label')],
    carrying: { 'libraries.ly.img.vectorpath.label': 'Vector' }
  })

  const result = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS })

  assert.equal(result.tagged, 1)
  assert.deepEqual(result.extras, ['libraries.ly.img.vectorpath.label'])
})

test('keys of the repo\'s editor file that Phrase does not have are reported', async () => {
  const client = fakeClient({ keys: [key('1', 'action.align')], carrying: { 'action.align': 'A' } })

  const { plan } = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS })

  assert.deepEqual(plan.missingInPhrase, ['action.align.bottom', 'property.x', 'is not supported yet"'])
})

test('keys are tagged in batches of 100 and a short count from Phrase is flagged', async () => {
  const keys = Array.from({ length: 250 }, (_, i) => key(`k${i}`, `property.p${i}`))
  const logs = []
  const client = fakeClient({ keys, tagResult: args => (args.q.includes('k249') ? 49 : args.q.replace('ids:', '').split(',').length) })

  const result = await tagExistingEditorKeys({ client, editorKeys: EDITOR_KEYS, webKeys: WEB_KEYS, log: m => logs.push(m) })

  assert.equal(client.tagged.length, 3)
  assert.equal(result.tagged, 249)
  assert.ok(logs.some(m => /WARNING: Phrase tagged 49 of the 50/.test(m)))
})

test('the email key space: its own exact names are tagged, the old camelCase keys and other key spaces are not', async () => {
  const client = fakeClient({
    keys: [
      key('1', 'ai-suggested-posts.subject'),
      key('2', 'welcome.subject'),
      key('3', 'postIsRejected.subject'),
      key('4', 'onboarding.title', ['web']),
      key('5', 'action.align')
    ],
    carrying: { 'ai-suggested-posts.subject': 'S', 'welcome.subject': 'W' }
  })

  const result = await tagExistingKeys({
    client,
    tag: 'email',
    ownKeys: ['ai-suggested-posts.subject', 'welcome.subject'],
    otherKeys: ['onboarding.title', 'action.align']
  })

  assert.deepEqual(client.tagged, [{ q: 'ids:1,2', tags: 'email' }])
  assert.equal(result.tagged, 2)
  assert.deepEqual(result.extras, [])
})

test('with no segments, a key is only ever matched by its exact name', async () => {
  const client = fakeClient({ keys: [key('1', 'welcome.subject'), key('2', 'welcome.other')], carrying: { 'welcome.subject': 'W' } })

  await tagExistingKeys({ client, tag: 'email', ownKeys: ['welcome.subject'], otherKeys: [] })

  assert.deepEqual(client.tagged, [{ q: 'ids:1', tags: 'email' }])
})
