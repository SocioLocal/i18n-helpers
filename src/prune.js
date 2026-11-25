'use strict'

// Removes from Phrase the keys no code uses any more. The push only ever adds, so a key deleted from the code would
// stay in Phrase, and in the published files, forever.
//
// Careful by design: a key is an orphan only if it carries the key space's tag AND none of the keys to keep has it
// (the working tree and every deployed branch, see repo-keys.js). It is a dry run unless told otherwise, it refuses to
// run with nothing to keep, and it refuses to delete a large share of the key space in one go, which is what a wrong
// branch or an empty file looks like.

const BATCH_SIZE = 100
const MAX_SHARE = 0.25

async function listTagged (client, tag) {
  const keys = []
  for (let page = 1; ; page++) {
    const batch = await client.listKeys({ page, perPage: 100, q: `tags:${tag}` })
    keys.push(...batch)
    if (batch.length < 100) return keys
  }
}

async function findOrphans ({ client, set, keep }) {
  if (!keep || keep.size === 0) throw new Error(`No keys to keep for "${set.name}": refusing to treat every key as unused`)
  const tagged = await listTagged(client, set.tag)
  const orphans = tagged.filter(key => (key.tags || []).includes(set.tag) && !keep.has(key.name))
  return { tagged: tagged.length, orphans: orphans.map(key => ({ id: key.id, name: key.name })) }
}

async function pruneKeys ({ client, set, keep, dryRun = true, force = false, log = () => {} }) {
  const { tagged, orphans } = await findOrphans({ client, set, keep })
  if (!dryRun && !force && orphans.length > tagged * MAX_SHARE) {
    throw new Error(`Refusing to delete ${orphans.length} of the ${tagged} "${set.tag}" keys at once (more than ${MAX_SHARE * 100}%): check the branches in "refs", or pass --force`)
  }
  let deleted = 0
  if (!dryRun) {
    for (let i = 0; i < orphans.length; i += BATCH_SIZE) {
      const batch = orphans.slice(i, i + BATCH_SIZE)
      const affected = await client.deleteKeys({ q: `ids:${batch.map(key => key.id).join(',')}` })
      deleted += affected
      log(`  deleted ${affected} of ${batch.length}`)
      if (affected !== batch.length) log(`  WARNING: Phrase deleted ${affected} of the ${batch.length} keys asked for`)
    }
  }
  return { tagged, orphans, deleted, dryRun }
}

module.exports = { findOrphans, pruneKeys }
