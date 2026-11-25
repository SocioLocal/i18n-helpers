'use strict'

// The repo owns the KEYS (they link up with the code); Phrase owns the VALUES once this is deployed.
//
// Steady state (the default): the push only creates keys Phrase does not have yet, and fills in
// translations it lacks. It never changes a value that is already in Phrase (update_translations off), so a
// translator's text is never overwritten. A developer adding a key puts its English value in the repo and
// the push carries it to Phrase; from then on that value is edited in Phrase.
//
// Bootstrap (`overwrite: true`, used before the first deploy only): the repo is still the source of truth
// for values too, as in the old push, pull, deploy routine, so every locale the repo has is pushed with
// update_translations and Phrase is made to mirror it.
//
// A locale that exists only in Phrase is never in a push, so it is never touched. Keys a locale has but
// English lacks are left out (they would create keys with no English). Every key an upload creates is tagged
// with the set's tag (`web`, `editor`).

const { flatten, nest } = require('./sync')

const SOURCE_LOCALE = 'en'

function planUploads ({ filesByLocale, overwrite = false, shape = 'nested' }) {
  const flat = file => (shape === 'flat' ? file : flatten(file))
  const sourceKeys = new Set(Object.keys(flat(filesByLocale[SOURCE_LOCALE])))
  const plan = []
  // English first: the other locales' translations attach to keys it creates.
  const codes = [SOURCE_LOCALE, ...Object.keys(filesByLocale).filter(code => code !== SOURCE_LOCALE).sort()]
  codes.forEach(code => {
    const all = flat(filesByLocale[code])
    const kept = {}
    let skipped = 0
    Object.keys(all).forEach(key => {
      if (sourceKeys.has(key)) kept[key] = all[key]
      else skipped++
    })
    plan.push({
      code,
      keys: Object.keys(kept).length,
      skippedNotInEnglish: skipped,
      updateTranslations: overwrite,
      content: JSON.stringify(shape === 'flat' ? kept : nest(kept))
    })
  })
  return plan
}

async function waitForUpload (client, id, { sleep, attempts = 90, delayMs = 2000 }) {
  for (let i = 0; i < attempts; i++) {
    const upload = await client.getUpload(id)
    if (upload.state === 'success') return upload
    if (upload.state === 'error') throw new Error(`Phrase upload ${id} failed: ${upload.error_message || 'no reason given'}`)
    await sleep(delayMs)
  }
  throw new Error(`Phrase upload ${id} did not finish in time`)
}

// An upload never creates a key space: a push to a tag the Phrase project does not have yet is an error, so a mistyped
// name (or a repo pushing to the wrong project) cannot quietly start a new one. `create-space` makes it, deliberately.
async function assertSpaceExists (client, set) {
  const tags = await client.listTags()
  if (!tags.some(tag => tag.name === set.tag)) {
    throw new Error(`The "${set.tag}" key space does not exist in this Phrase project yet. If it should, create it first: socio-local-i18n create-space ${set.tag}`)
  }
}

async function pushStrings ({
  client,
  set,
  filesByLocale,
  overwrite = false,
  dryRun = false,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {}
}) {
  if (!set) throw new Error('Say which key space to push')
  if (!filesByLocale[SOURCE_LOCALE]) throw new Error('The English file is the source and is required')
  const plan = planUploads({ filesByLocale, overwrite, shape: set.shape })
  if (dryRun) return plan.map(({ content, ...summary }) => ({ ...summary, uploaded: false }))

  await assertSpaceExists(client, set)
  const locales = await client.listLocales()
  const results = []
  for (const item of plan) {
    const locale = locales.find(l => l.code === item.code)
    if (!locale) {
      log(`Skipping ${item.code}: the Phrase project has no such locale`)
      results.push({ code: item.code, keys: item.keys, skippedNotInEnglish: item.skippedNotInEnglish, uploaded: false })
      continue
    }
    const created = await client.uploadFile({
      localeId: locale.id,
      fileName: `${item.code}.json`,
      content: item.content,
      fileFormat: set.uploadFormat,
      tags: set.tag,
      updateTranslations: item.updateTranslations
    })
    const upload = await waitForUpload(client, created.id, { sleep })
    results.push({
      code: item.code,
      keys: item.keys,
      skippedNotInEnglish: item.skippedNotInEnglish,
      uploaded: true,
      summary: upload.summary
    })
  }
  return results
}

module.exports = { planUploads, pushStrings, waitForUpload, assertSpaceExists }
