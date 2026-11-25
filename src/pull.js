'use strict'

// NS-6591: pull the VALUES from Phrase into the repo's translation files (web UI and editor).
//
// The repo owns the keys (they link up with the code) and Phrase owns the values, so a pull only updates the
// value of a key the repo file already has. It never adds a key (Phrase also holds terms created in admin and
// keys of other sets, which do not belong in these files) and never removes one, and it keeps the file's key
// order, so a pull produces a diff of changed values only. An empty or missing value in Phrase leaves the
// repo's text alone. This is the "pull" of the old push, pull, deploy routine: it keeps the bundled fallback
// current.

const { unwrapMessages, flatten } = require('./sync')

function newStats () {
  return { updated: 0, unchanged: 0, missingInPhrase: 0, updatedKeys: [], changes: [] }
}

function applyLeaf (path, value, phraseFlat, stats) {
  const fromPhrase = phraseFlat[path]
  if (typeof value !== 'string' || typeof fromPhrase !== 'string' || fromPhrase === '') {
    stats.missingInPhrase++
    return value
  }
  if (fromPhrase === value) {
    stats.unchanged++
    return value
  }
  stats.updated++
  stats.updatedKeys.push(path)
  stats.changes.push({ key: path, from: value, to: fromPhrase })
  return fromPhrase
}

// Nested file (the web UI).
function applyValues (repoNode, phraseFlat, prefix = '', stats = newStats()) {
  const result = {}
  Object.keys(repoNode).forEach(key => {
    const value = repoNode[key]
    const path = `${prefix}${key}`
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? applyValues(value, phraseFlat, `${path}.`, stats).node
      : applyLeaf(path, value, phraseFlat, stats)
  })
  return { node: result, stats }
}

// Flat file (the editor): the keys already are the paths.
function applyFlatValues (repoFlat, phraseFlat) {
  const stats = newStats()
  const result = {}
  Object.keys(repoFlat).forEach(key => {
    result[key] = applyLeaf(key, repoFlat[key], phraseFlat, stats)
  })
  return { node: result, stats }
}

// A key space nobody has pushed yet has no tag in the project, and Phrase answers 400 "could not be found" for it.
// That means "nothing there yet", not a failure.
const isMissingTag = err => err.status === 400 && /could not be found/.test(err.message)

// The Phrase values of a set, flat: the keys that carry its tag. Null when the tag does not exist yet.
async function fetchSetValues (client, locale, set) {
  try {
    return unwrapMessages(await client.downloadLocale(locale.id, { fileFormat: 'json', tags: set.tag }))
  } catch (err) {
    if (isMissingTag(err)) return null
    throw err
  }
}

// filesByLocale: { en: <parsed repo file>, ... }. Returns one entry per locale, with the new content and
// counts. Nothing is written here.
async function pullStrings ({ client, set, filesByLocale }) {
  const locales = await client.listLocales()
  const results = []
  for (const [code, repoFile] of Object.entries(filesByLocale)) {
    const locale = locales.find(l => l.code === code)
    if (!locale) {
      results.push({ code, found: false })
      continue
    }
    const phrase = await fetchSetValues(client, locale, set)
    if (phrase === null) {
      results.push({ code, found: true, noTaggedKeys: true })
      continue
    }
    const { node, stats } = set.shape === 'flat' ? applyFlatValues(repoFile, phrase) : applyValues(repoFile, phrase)
    const repoKeys = new Set(Object.keys(set.shape === 'flat' ? repoFile : flatten(repoFile)))
    const onlyInPhrase = Object.keys(phrase).filter(key => !repoKeys.has(key)).length
    results.push({ code, found: true, content: node, ...stats, onlyInPhrase })
  }
  return results
}

// The repo files are 2-space JSON with a trailing newline.
const serialize = node => `${JSON.stringify(node, null, 2)}\n`

module.exports = { applyValues, applyFlatValues, pullStrings, serialize }
