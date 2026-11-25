'use strict'

// NS-6591: publishes the translations of the Phrase project, one file per key space and language.
//
// Every key in Phrase carries a tag naming the KEY SPACE it belongs to (`web`, `editor`, `email`): the tag is put
// there by whatever pushes the key, and it is the only thing that says which app a key is for. The sync is
// therefore one rule: for each key space, download the keys with its tag and publish them as
// `<key space>/<language>.json`, in the shape its readers use (spaces.js). Downloads use Phrase's flat "json" format
// because a nested download loses keys that are both text and a parent (the editor has 239); the nesting is done here.
//
// A key space nobody has pushed yet has no tag in Phrase, which is not an error: it simply has no files.

const { SPACES, spaceNames } = require('./spaces')

const MANIFEST_KEY = 'locales.json'

function unwrapMessages (chromeJson) {
  const flat = {}
  Object.entries(chromeJson).forEach(([key, value]) => {
    flat[key] = value && typeof value === 'object' ? value.message : value
  })
  return flat
}

// { a: { b: 'x' } } -> { 'a.b': 'x' }
function flatten (node, prefix = '', out = {}) {
  Object.entries(node).forEach(([key, value]) => {
    if (value && typeof value === 'object') flatten(value, `${prefix}${key}.`, out)
    else out[`${prefix}${key}`] = value
  })
  return out
}

function countLeaves (node) {
  if (node === null || typeof node !== 'object') return 1
  return Object.values(node).reduce((sum, child) => sum + countLeaves(child), 0)
}

// "a.b.c" -> { a: { b: { c } } }. A key that is both a string and a parent cannot be nested, so it
// throws instead of dropping a value: a sync that cannot represent the data must not publish it.
function nest (flat) {
  const root = {}
  const conflicts = []
  Object.keys(flat).sort().forEach(key => {
    const parts = key.split('.')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (typeof node[part] === 'string') {
        conflicts.push(parts.slice(0, i + 1).join('.'))
        return
      }
      node = node[part] = node[part] || {}
    }
    const leaf = parts[parts.length - 1]
    if (typeof node[leaf] === 'object') {
      conflicts.push(key)
      return
    }
    node[leaf] = flat[key]
  })
  if (conflicts.length) {
    throw new Error(`Cannot nest keys that are both text and a parent: ${[...new Set(conflicts)].slice(0, 10).join(', ')}`)
  }
  return root
}

// A key space nobody has pushed yet has no tag in the project, and Phrase answers 400 "could not be found"
// for it. That means "no keys", not a failure.
function isMissingTag (err) {
  return err.status === 400 && /could not be found/.test(err.message)
}

// Everything is checked before anything is written, so a bad sync leaves the live files untouched.
async function publish ({ outputs, store, maxDropRatio = 0.2 }) {
  const toWrite = []
  for (const [path, data] of Object.entries(outputs)) {
    const count = countLeaves(data)
    const previous = await store.get(path)
    const previousCount = previous ? countLeaves(previous) : 0
    if (count === 0) {
      if (previousCount > 0) throw new Error(`Refusing to publish ${path}: no keys (live file has ${previousCount})`)
      continue
    }
    if (previousCount > 0 && count < previousCount * (1 - maxDropRatio)) {
      throw new Error(`Refusing to publish ${path}: ${count} keys, live file has ${previousCount}`)
    }
    toWrite.push([path, data])
  }
  for (const [path, data] of toWrite) await store.put(path, JSON.stringify(data))
  return toWrite.map(([path, data]) => ({ path, keys: countLeaves(data) }))
}

// The key spaces to publish are the registry's (spaces.js): adding one is adding it there.
const DEFAULT_APPS = spaceNames()

// What an app needs to know about the languages: which ones have text, and how complete each is. Coverage is the
// share of the English keys a language has, per key space. A language with no text at all is left out.
function buildManifest ({ counts, now }) {
  const english = counts.en || {}
  const coverage = (keys, total) => (total > 0 ? Math.round((keys / total) * 100) / 100 : null)
  return {
    updatedAt: now().toISOString(),
    locales: Object.keys(counts)
      .filter(code => Object.values(counts[code]).some(keys => keys > 0))
      .sort()
      .map(code => ({
        code,
        apps: Object.fromEntries(Object.keys(counts[code]).map(app => [
          app,
          { keys: counts[code][app], coverage: coverage(counts[code][app], english[app] || 0) }
        ]))
      }))
  }
}

// Each key space is published in the shape its readers use (spaces.js): nested for the web app and the emails, flat
// for the editor, whose keys cannot be nested. A key space that cannot be nested fails the whole sync, before anything
// is written, so the last good files stay live and the failure is seen, not silently ignored by every browser.
function shapeFor (app, flatKeys, code) {
  const space = SPACES[app]
  if (!space) throw new Error(`"${app}" is not a key space (spaces.js has ${spaceNames().join(', ')})`)
  if (space.shape === 'flat') return flatKeys
  try {
    return nest(flatKeys)
  } catch (err) {
    throw new Error(`${app}/${code}: ${err.message}`)
  }
}

async function syncProject ({ client, store, apps = DEFAULT_APPS, maxDropRatio, now = () => new Date() }) {
  const locales = await client.listLocales()
  const outputs = {}
  const counts = {}
  for (const locale of locales) {
    counts[locale.code] = {}
    for (const app of apps) {
      let keys = {}
      try {
        keys = unwrapMessages(await client.downloadLocale(locale.id, { fileFormat: 'json', tags: app }))
      } catch (err) {
        if (!isMissingTag(err)) throw err
      }
      outputs[`${app}/${locale.code}.json`] = shapeFor(app, keys, locale.code)
      counts[locale.code][app] = Object.keys(keys).length
    }
  }
  const written = await publish({ outputs, store, maxDropRatio })
  // Written last, and only when everything else was: it must never announce a language whose files were refused.
  const manifest = buildManifest({ counts, now })
  await store.put(MANIFEST_KEY, JSON.stringify(manifest))
  return [...written, { path: MANIFEST_KEY, keys: manifest.locales.length }]
}

module.exports = { unwrapMessages, nest, flatten, countLeaves, publish, buildManifest, syncProject, shapeFor, MANIFEST_KEY, DEFAULT_APPS }
