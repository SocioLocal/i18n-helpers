'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findOrphans, pruneKeys } = require('../src/prune')
const { keysAtRef, keysToKeep } = require('../src/repo-keys')
const { makeSet } = require('../src/config')

const SET = makeSet('web', { dir: '/repo/web', locales: ['en', 'fr'] })
const key = (id, name, tags = ['web']) => ({ id, name, tags })

function fakeClient (keys, { deleteResult } = {}) {
  const deleted = []
  const pages = []
  return {
    deleted,
    pages,
    listKeys: async ({ page, perPage, q }) => { pages.push(q); return keys.slice((page - 1) * perPage, page * perPage) },
    deleteKeys: async args => { deleted.push(args.q); return deleteResult ? deleteResult(args) : args.q.replace('ids:', '').split(',').length }
  }
}

test('an orphan is a tagged key that no key to keep has; untagged keys are never candidates', async () => {
  const client = fakeClient([key('1', 'a'), key('2', 'gone'), key('3', 'other', ['email']), key('4', 'x', [])])

  const { tagged, orphans } = await findOrphans({ client, set: SET, keep: new Set(['a']) })

  assert.deepEqual(client.pages, ['tags:web'])
  assert.equal(tagged, 4)
  assert.deepEqual(orphans, [{ id: '2', name: 'gone' }])
})

test('it refuses to run with nothing to keep, which is what an empty file looks like', async () => {
  await assert.rejects(findOrphans({ client: fakeClient([key('1', 'a')]), set: SET, keep: new Set() }), /No keys to keep/)
})

test('a prune is a dry run unless told otherwise: nothing is deleted', async () => {
  const client = fakeClient([key('1', 'a'), key('2', 'gone')])

  const result = await pruneKeys({ client, set: SET, keep: new Set(['a']) })

  assert.equal(result.dryRun, true)
  assert.deepEqual(result.orphans.map(o => o.name), ['gone'])
  assert.deepEqual(client.deleted, [])
})

test('a real prune deletes the orphans by id, in batches of 100', async () => {
  const keys = [key('keep', 'a')]
  for (let i = 0; i < 120; i++) keys.push(key(`o${i}`, `old.${i}`))
  for (let i = 0; i < 500; i++) keys.push(key(`k${i}`, `used.${i}`))
  const client = fakeClient(keys)
  const keep = new Set(['a', ...Array.from({ length: 500 }, (_, i) => `used.${i}`)])

  const result = await pruneKeys({ client, set: SET, keep, dryRun: false })

  assert.equal(result.deleted, 120)
  assert.equal(client.deleted.length, 2)
  assert.equal(client.deleted[0].split(',').length, 100)
})

test('it refuses to delete a large share of a key space at once unless forced', async () => {
  const client = fakeClient([key('1', 'a'), key('2', 'b'), key('3', 'c'), key('4', 'd')])

  await assert.rejects(pruneKeys({ client, set: SET, keep: new Set(['a']), dryRun: false }), /Refusing to delete 3 of the 4 "web" keys at once/)
  assert.deepEqual(client.deleted, [])
  const forced = await pruneKeys({ client, set: SET, keep: new Set(['a']), dryRun: false, force: true })
  assert.equal(forced.deleted, 3)
})

test('a short count from Phrase is flagged, not hidden', async () => {
  const lines = []
  const client = fakeClient([key('1', 'a'), key('2', 'b')], { deleteResult: () => 0 })

  await pruneKeys({ client, set: SET, keep: new Set(['a']), dryRun: false, force: true, log: m => lines.push(m) })

  assert.ok(lines.some(line => /WARNING: Phrase deleted 0 of the 1 keys/.test(line)))
})

test('the keys to keep are the working tree\'s plus every deployed branch\'s, read from git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-git-'))
  const set = makeSet('web', { dir: path.join(root, 'i18n'), locales: ['en', 'fr'] })
  const git = (...args) => require('child_process').execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const write = (code, data) => { fs.mkdirSync(set.dir, { recursive: true }); fs.writeFileSync(path.join(set.dir, `${code}.json`), JSON.stringify(data)) }
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  write('en', { shared: 'x', live: { onlyOnMaster: 'y' } }); write('fr', { shared: 'x' })
  git('add', '.'); git('commit', '-q', '-m', 'master')
  git('checkout', '-q', '-b', 'development')
  write('en', { shared: 'x', fresh: 'z' }) // development removed `live.onlyOnMaster` and added `fresh`

  assert.deepEqual([...keysAtRef({ set, ref: 'master', root })].sort(), ['live.onlyOnMaster', 'shared'])
  assert.deepEqual([...keysToKeep({ set, refs: ['master'], root })].sort(), ['fresh', 'live.onlyOnMaster', 'shared'])
  assert.throws(() => keysToKeep({ set, refs: ['origin/nope'], root }), /Cannot find "origin\/nope" in git/)
})
