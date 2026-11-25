'use strict'

// The one command every repo uses: `socio-local-i18n <command>`, run from the repo's root (the repos' package.json
// scripts are `i18n:push`, `i18n:pull`, ...). The key spaces and their files come from the repo's i18n.config.js.
//
//   push           add the keys Phrase lacks (with their English value) and fill missing translations.
//                  Never changes a value already in Phrase. --overwrite: bootstrap only, the repo's values replace Phrase's.
//   pull           copy Phrase's values into the repo's files (values only, never keys). --show lists each change.
//   status         what a push would add, what is unused, how many values Phrase changed. Changes nothing.
//   prune          delete from Phrase the keys no branch uses any more. A dry run unless --yes. --refs=a,b overrides the config.
//   create-space   create a key space's tag in the Phrase project (a push never does).
//   migrate-tags   one-time, per project: tag keys that were pushed before keys were tagged.
//   sync-local     what the sync Lambda publishes, written to a local folder.
//
// Options: --space=<key space>|all (default all), --dry-run, --show, --yes, --force, --refs=<a,b>.

const fs = require('fs')
const path = require('path')
const { loadConfig, setsFromArgs } = require('./config')
const { loadEnvFiles } = require('./env')
const { clientFromEnv } = require('./cli-client')
const { readSpace, fileOf, keysOf } = require('./files')
const { pushStrings } = require('./push')
const { pullStrings, serialize } = require('./pull')
const { spaceStatus } = require('./status')
const { pruneKeys } = require('./prune')
const { keysToKeep } = require('./repo-keys')
const { tagExistingKeys } = require('./tag-existing')
const { syncProject } = require('./sync')
const { fileStore } = require('./store')
const { spaceOf } = require('./spaces')

const flag = (argv, name) => argv.includes(`--${name}`)
const option = (argv, name) => {
  const found = argv.find(a => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}
const cut = (text, length = 110) => (text.length > length ? `${text.slice(0, length)}…` : text)
const list = (names, max = 8) => `${names.slice(0, max).join(', ')}${names.length > max ? ', …' : ''}`

const commands = {
  async push ({ config, argv, log }) {
    const dryRun = flag(argv, 'dry-run')
    const overwrite = flag(argv, 'overwrite')
    const client = dryRun ? null : clientFromEnv()
    if (!dryRun) log(`Pushing to Phrase project ${process.env.PHRASE_PROJECT_ID} (${overwrite ? 'OVERWRITE: the repo values replace the ones in Phrase' : 'keys only, no existing value is changed'})`)
    for (const set of setsFromArgs(config, argv)) {
      log(`${set.name}:`)
      const results = await pushStrings({ client, set, filesByLocale: readSpace(set), overwrite, dryRun, log })
      results.forEach(r => {
        const extra = r.summary ? ` ${JSON.stringify(r.summary)}` : ''
        log(`  ${r.code}: ${r.keys} keys${r.skippedNotInEnglish ? `, ${r.skippedNotInEnglish} skipped (not in English)` : ''}${r.uploaded ? ` uploaded${extra}` : dryRun ? ' (dry run)' : ' NOT uploaded'}`)
      })
    }
  },

  async pull ({ config, argv, log }) {
    const dryRun = flag(argv, 'dry-run')
    const show = flag(argv, 'show')
    const client = clientFromEnv()
    log(`Pulling from Phrase project ${process.env.PHRASE_PROJECT_ID}${dryRun ? ' (dry run)' : ''}`)
    for (const set of setsFromArgs(config, argv)) {
      log(`${set.name}:`)
      const results = await pullStrings({ client, set, filesByLocale: readSpace(set) })
      results.forEach(r => {
        if (!r.found) return log(`  ${r.code}: no such locale in Phrase, left alone`)
        if (r.noTaggedKeys) return log(`  ${r.code}: no keys tagged "${set.tag}" in Phrase yet: push first`)
        log(`  ${r.code}: ${r.updated} values changed, ${r.unchanged} the same, ${r.missingInPhrase} not in Phrase (kept), ${r.onlyInPhrase} only in Phrase (not added)`)
        if (show) r.changes.forEach(c => log(`      ${c.key}\n        repo:   ${cut(c.from)}\n        phrase: ${cut(c.to)}`))
        else {
          r.updatedKeys.slice(0, 5).forEach(key => log(`      ${key}`))
          if (r.updatedKeys.length > 5) log(`      … and ${r.updatedKeys.length - 5} more (--show lists them all, with both values)`)
        }
        if (!dryRun && r.updated > 0) fs.writeFileSync(fileOf(set, r.code), serialize(r.content))
      })
    }
  },

  async status ({ config, argv, log }) {
    const client = clientFromEnv()
    log(`Phrase project ${process.env.PHRASE_PROJECT_ID}`)
    const refs = option(argv, 'refs') ? option(argv, 'refs').split(',') : config.refs
    for (const set of setsFromArgs(config, argv)) {
      const keep = refs.length ? keysToKeep({ set, refs, root: config.root }) : undefined
      const s = await spaceStatus({ client, set, filesByLocale: readSpace(set), keep })
      if (!s.exists) {
        log(`${set.name}: not in this Phrase project yet (${s.repoKeys} keys in the repo): socio-local-i18n create-space ${set.name}`)
        continue
      }
      log(`${set.name}: ${s.repoKeys} keys in the repo, ${s.phraseKeys} in Phrase`)
      log(`  a push would add ${s.toAdd.length}${s.toAdd.length ? `: ${list(s.toAdd)}` : ''}`)
      const caveat = set.sharedWith.length ? ` (shared with ${set.sharedWith.join(', ')}: they may use these)` : refs.length ? '' : ' (no refs configured: only this working tree was checked)'
      log(`  unused (in Phrase, in no ${refs.length ? 'branch' : 'file'}) ${s.unused.length}${s.unused.length ? `: ${list(s.unused)}` : ''}${caveat}`)
      s.changedValues.forEach(c => log(`  ${c.code}: Phrase has changed ${c.values} values (pull --show)`))
    }
  },

  async prune ({ config, argv, log }) {
    const refs = option(argv, 'refs') ? option(argv, 'refs').split(',') : config.refs
    if (!refs.length) throw new Error('Name the branches that are live (refs in i18n.config.js, or --refs=origin/master,origin/development): prune never guesses')
    const dryRun = !flag(argv, 'yes')
    const client = clientFromEnv()
    log(`Pruning Phrase project ${process.env.PHRASE_PROJECT_ID}${dryRun ? ' (dry run: nothing is deleted without --yes)' : ''}; keys still used by: working tree, ${refs.join(', ')}`)
    for (const set of setsFromArgs(config, argv)) {
      if (set.sharedWith.length) {
        log(`${set.name}: skipped, its keys are shared with ${set.sharedWith.join(', ')}, whose code this repo cannot see (prune would delete keys they use)`)
        continue
      }
      const keep = keysToKeep({ set, refs, root: config.root })
      const result = await pruneKeys({ client, set, keep, dryRun, force: flag(argv, 'force'), log })
      log(`${set.name}: ${result.orphans.length} unused of ${result.tagged} keys${dryRun ? '' : `, ${result.deleted} deleted`}`)
      result.orphans.forEach(key => log(`    ${key.name}`))
    }
  },

  async 'create-space' ({ argv, log }) {
    const name = argv.find(a => !a.startsWith('--'))
    spaceOf(name || '')
    const client = clientFromEnv()
    const tags = await client.listTags()
    if (tags.some(tag => tag.name === name)) return log(`The "${name}" key space already exists in project ${process.env.PHRASE_PROJECT_ID}`)
    await client.createTag(name)
    log(`Created the "${name}" key space in project ${process.env.PHRASE_PROJECT_ID}`)
  },

  async 'migrate-tags' ({ config, argv, log }) {
    const dryRun = flag(argv, 'dry-run')
    const name = option(argv, 'space')
    const set = config.sets[name]
    if (!set) throw new Error(`Say which key space to tag: --space=${Object.keys(config.sets).join(' or --space=')}`)
    const own = keysOf(set, readSpace(set).en)
    const others = Object.values(config.sets).filter(o => o.name !== name && fs.existsSync(o.dir)).flatMap(o => keysOf(o, readSpace(o).en))
    const client = clientFromEnv()
    log(`${dryRun ? 'Reading' : 'Tagging in'} Phrase project ${process.env.PHRASE_PROJECT_ID} for the "${set.tag}" key space`)
    const result = await tagExistingKeys({ client, tag: set.tag, ownKeys: own, otherKeys: others, segments: set.segments, dryRun, log })
    const { plan } = result
    log(`Keys in the project: ${plan.inProject}. Keys of this key space among them: ${plan.ownKeys} (already tagged: ${plan.alreadyTagged}, to tag: ${plan.toTag}).`)
    if (plan.missingInPhrase.length) log(`In the repo's English file but not in Phrase (${plan.missingInPhrase.length}): ${list(plan.missingInPhrase.map(k => JSON.stringify(k)))}`)
    if (plan.conflicts.length) log(`Left alone, they already carry another tag (${plan.conflicts.length}): ${list(plan.conflicts.map(c => `${c.name} [${c.tags}]`))}`)
    if (plan.lookalikes.length) log(`Left alone, they are another key space's too (${plan.lookalikes.length}): ${plan.lookalikes.join(', ')}`)
    if (!dryRun) {
      log(`Now carrying the "${set.tag}" tag in English: ${result.carrying} keys (the repo's English file has ${own.length})`)
      if (result.extras.length) log(`Also carrying the tag, not in the repo's English file (${result.extras.length}): ${list(result.extras, 12)}`)
    }
  },

  async 'sync-local' ({ config, argv, log }) {
    const outDir = path.resolve(argv.find(a => !a.startsWith('--')) || config.localOutDir || '')
    if (!outDir || outDir === path.resolve('')) throw new Error('Say where to write: an argument, or localOutDir in i18n.config.js')
    const written = await syncProject({ client: clientFromEnv(), store: fileStore(outDir) })
    log(`Wrote ${written.length} files to ${outDir}`)
    written.forEach(file => log(`  ${file.path}: ${file.keys} keys`))
  }
}

async function main (argv = process.argv.slice(2), log = console.log) {
  const [name, ...rest] = argv
  const command = commands[name]
  if (!command) throw new Error(`Usage: socio-local-i18n <${Object.keys(commands).join('|')}> [options]`)
  const config = loadConfig(process.cwd())
  loadEnvFiles(config.root)
  await command({ config, argv: rest, log })
}

module.exports = { main, commands }
