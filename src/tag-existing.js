#!/usr/bin/env node
'use strict'

// NS-6591: ONE-TIME migration per key space. Every key in Phrase should carry a tag naming its key space (see
// sync.js), but some keys were pushed before keys were tagged (the editor's, a few of the email's), and an upload
// only tags the keys it creates. This tags them.
//
// It does not use Phrase's search by name, which ignores case (`common.*` finds the editor's 81 keys AND the web's
// `Common.cancel`) and has only a trailing wildcard. It lists every key with its id, decides in code, by the exact
// name, which are the editor's, and tags those by id (`ids:` is a documented search term): no ambiguity, and the
// odd key the editor's file has (`is not supported yet"`) is handled like the rest.
//
// A key belongs to the key space if its exact name is in the repo's English file for it, or (only for a set that lists
// `segments`, like the editor, whose Phrase-only keys the repo never had) starts, in exactly that case, with one. A key that
// already carries another tag is not touched: it is reported, because it belongs to two key spaces.
//
//
// Run it once per Phrase project (dev first), with `socio-local-i18n migrate-tags`. Safe to run again: a tagged key is
// left alone. Once every project has been migrated this file can be deleted.

const { unwrapMessages, flatten } = require('./sync')

const PAGE_SIZE = 100
const BATCH_SIZE = 100

async function listAllKeys (client) {
  const keys = []
  for (let page = 1; ; page++) {
    const batch = await client.listKeys({ page, perPage: PAGE_SIZE })
    keys.push(...batch)
    if (batch.length < PAGE_SIZE) return keys
  }
}

async function tagExistingKeys ({ client, tag, ownKeys, otherKeys, segments = [], dryRun = false, log = () => {} }) {
  const ownSet = new Set(ownKeys)
  const otherSet = new Set(otherKeys)
  const isOwnKey = name => ownSet.has(name) || segments.includes(name.split('.')[0])

  const keys = await listAllKeys(client)
  const candidates = keys.filter(key => isOwnKey(key.name))
  const alreadyTagged = candidates.filter(key => (key.tags || []).includes(tag))
  const toTag = candidates.filter(key => (key.tags || []).length === 0)
  // a key that looks like ours but has another tag (a web key, say) is in two key spaces: leave it, say so
  const conflicts = candidates.filter(key => (key.tags || []).length > 0 && !(key.tags || []).includes(tag))
  const present = new Set(keys.map(key => key.name))
  const missingInPhrase = ownKeys.filter(name => !present.has(name))
  const lookalikes = toTag.filter(key => otherSet.has(key.name))

  const plan = {
    inProject: keys.length,
    ownKeys: candidates.length,
    alreadyTagged: alreadyTagged.length,
    toTag: toTag.length,
    conflicts: conflicts.map(key => ({ name: key.name, tags: key.tags })),
    missingInPhrase,
    lookalikes: lookalikes.map(key => key.name)
  }
  // never tag a key that is also another key space's, whatever its tags say
  const ids = toTag.filter(key => !otherSet.has(key.name)).map(key => key.id)
  if (dryRun) return { plan, tagged: 0, carrying: null, extras: [] }

  let tagged = 0
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const affected = await client.tagKeys({ q: `ids:${batch.join(',')}`, tags: tag })
    tagged += affected
    log(`  tagged ${affected} of ${batch.length} (${Math.min(i + BATCH_SIZE, ids.length)} of ${ids.length})`)
    if (affected !== batch.length) log(`  WARNING: Phrase tagged ${affected} of the ${batch.length} keys asked for`)
  }

  // verify against what Phrase now says carries the tag, in English
  const locales = await client.listLocales()
  const english = locales.find(l => l.code === 'en')
  const carrying = Object.keys(unwrapMessages(await client.downloadLocale(english.id, { fileFormat: 'json', tags: tag })))
  // keys that carry the tag but are not in the repo's file: expected for the few only Phrase has, suspicious if many
  const extras = carrying.filter(name => !ownSet.has(name))
  return { plan, tagged, carrying: carrying.length, extras }
}

module.exports = { tagExistingKeys, listAllKeys }
