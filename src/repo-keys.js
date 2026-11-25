'use strict'

// Which keys are still in use ANYWHERE, so that nothing still live is ever deleted from Phrase.
//
// A key a developer removed on one branch may still be in use by the code another branch deploys (development is
// deployed to the dev environment, master to production, and a release may sit between). So the keys to keep are the
// union of the working tree and every branch listed in the repo's `refs`, read straight from git.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { workingTreeKeys, fileOf, keysOf } = require('./files')

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

function keysAtRef ({ set, ref, root, run = git }) {
  try {
    run(root, ['rev-parse', '--verify', `${ref}^{commit}`])
  } catch (err) {
    throw new Error(`Cannot find "${ref}" in git (git fetch?): refusing to guess which keys it still uses`)
  }
  // git reports the real path of the repo; the config's path may go through a symlink (/var -> /private/var on a Mac)
  const top = fs.realpathSync(run(root, ['rev-parse', '--show-toplevel']).trim())
  const dir = fs.existsSync(set.dir) ? fs.realpathSync(set.dir) : set.dir
  const keys = new Set()
  set.locales.forEach(code => {
    const relative = path.relative(top, path.join(dir, path.basename(fileOf(set, code)))).split(path.sep).join('/')
    let text
    try {
      text = run(root, ['show', `${ref}:${relative}`])
    } catch (err) {
      return // the file is not in that branch (a language or key space added later): it has no keys there
    }
    keysOf(set, JSON.parse(text)).forEach(key => keys.add(key))
  })
  return keys
}

// The working tree's keys plus every ref's. `refs` is what the repo's config lists, or --refs.
function keysToKeep ({ set, refs, root, run }) {
  const keep = workingTreeKeys(set)
  refs.forEach(ref => keysAtRef({ set, ref, root, run }).forEach(key => keep.add(key)))
  return keep
}

module.exports = { keysAtRef, keysToKeep }
