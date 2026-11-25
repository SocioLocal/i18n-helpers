'use strict'

// One look at where a key space and the Phrase project stand, without changing either: what a push would add, what is
// only in Phrase and unused, and how many values Phrase has changed. Costs a few requests (one download per language).

const { unwrapMessages } = require('./sync')
const { keysOf } = require('./files')
const { pullStrings } = require('./pull')

async function spaceStatus ({ client, set, filesByLocale, keep }) {
  const repoKeys = keysOf(set, filesByLocale.en)
  const tags = await client.listTags()
  if (!tags.some(tag => tag.name === set.tag)) {
    return { exists: false, repoKeys: repoKeys.length }
  }
  const locales = await client.listLocales()
  const english = locales.find(locale => locale.code === 'en')
  const inPhrase = Object.keys(unwrapMessages(await client.downloadLocale(english.id, { fileFormat: 'json', tags: set.tag })))
  const phrase = new Set(inPhrase)
  const repo = new Set(repoKeys)
  const pulls = await pullStrings({ client, set, filesByLocale })
  return {
    exists: true,
    repoKeys: repoKeys.length,
    phraseKeys: inPhrase.length,
    toAdd: repoKeys.filter(key => !phrase.has(key)),
    unused: inPhrase.filter(key => !repo.has(key) && !(keep && keep.has(key))),
    changedValues: pulls.filter(pull => pull.found && !pull.noTaggedKeys).map(pull => ({ code: pull.code, values: pull.updated }))
  }
}

module.exports = { spaceStatus }
