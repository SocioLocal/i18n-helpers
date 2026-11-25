'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeSet, loadConfig, setsFromArgs } = require('../src/config')
const { spaceOf, spaceNames } = require('../src/spaces')
const { parse, loadEnvFiles } = require('../src/env')

function repoWith (config, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-config-'))
  fs.writeFileSync(path.join(root, 'i18n.config.js'), `module.exports = ${JSON.stringify(config)}`)
  Object.entries(files).forEach(([name, text]) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  })
  return root
}

test('the registry is the one list of key spaces, each with its shape and upload format', () => {
  assert.deepEqual(spaceNames(), ['web', 'editor', 'email'])
  assert.deepEqual(spaceOf('editor'), { tag: 'editor', shape: 'flat', uploadFormat: 'simple_json' })
  assert.throws(() => spaceOf('webb'), /Unknown key space "webb": the key spaces are web, editor, email/)
})

test('a repo\'s config names the key spaces it owns and where their files are; the facts come from the registry', () => {
  const root = repoWith({ spaces: { email: { dir: 'locales', locales: ['en', 'fr'] } }, refs: ['origin/master'] })

  const config = loadConfig(root)

  assert.deepEqual(Object.keys(config.sets), ['email'])
  assert.deepEqual(
    { tag: config.sets.email.tag, shape: config.sets.email.shape, uploadFormat: config.sets.email.uploadFormat, dir: config.sets.email.dir },
    { tag: 'email', shape: 'nested', uploadFormat: 'nested_json', dir: path.join(root, 'locales') }
  )
  assert.deepEqual(config.refs, ['origin/master'])
})

test('a config that names a key space the registry lacks, or no English, is refused', () => {
  assert.throws(() => loadConfig(repoWith({ spaces: { push: { dir: 'x', locales: ['en'] } } })), /Unknown key space "push"/)
  assert.throws(() => makeSet('web', { dir: 'x', locales: ['fr'] }), /locales that include "en"/)
  assert.throws(() => loadConfig(repoWith({ spaces: {} })), /lists no key spaces/)
  assert.throws(() => loadConfig(os.tmpdir() + '/no-such-repo-dir'), /No i18n.config.js/)
})

test('--space picks one key space; all leaves out one whose files are missing, naming it asks for it anyway', () => {
  const config = loadConfig(repoWith({ spaces: { web: { dir: 'w', locales: ['en'] }, editor: { dir: 'e', locales: ['en'] } } }))
  const noEditor = dir => !dir.endsWith('e')

  assert.deepEqual(setsFromArgs(config, [], () => true).map(s => s.name), ['web', 'editor'])
  assert.deepEqual(setsFromArgs(config, [], noEditor).map(s => s.name), ['web'])
  assert.deepEqual(setsFromArgs(config, ['--space=editor'], noEditor).map(s => s.name), ['editor'])
  assert.throws(() => setsFromArgs(config, ['--space=email']), /no key space "email": use web, editor, all/)
})

test('credentials come from .env.local then .env, never override the environment, and are never printed', () => {
  assert.deepEqual(parse('# c\nPHRASE_PROJECT_ID=abc\nexport PHRASE_CLIENT_ID = "x y"\n\nbad line'), { PHRASE_PROJECT_ID: 'abc', PHRASE_CLIENT_ID: 'x y' })
  const root = repoWith({}, { '.env.local': 'A=local\nB=local', '.env': 'B=env\nC=env' })
  const env = { A: 'already' }

  loadEnvFiles(root, env)

  assert.deepEqual(env, { A: 'already', B: 'local', C: 'env' })
})

test('a key space shared with another repo says so, and keeps what it says', () => {
  const root = repoWith({ spaces: { editor: { dir: 'e', locales: ['en'], sharedWith: ['sociolocal-react-native'] }, web: { dir: 'w', locales: ['en'] } } })

  const { sets } = loadConfig(root)

  assert.deepEqual(sets.editor.sharedWith, ['sociolocal-react-native'])
  assert.deepEqual(sets.web.sharedWith, [])
})
