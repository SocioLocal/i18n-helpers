'use strict'

// A repo's side of the key spaces: which of the registry's key spaces it owns (spaces.js) and where their files are.
// It lives in the repo as `i18n.config.js`:
//
//   module.exports = {
//     spaces: {
//       web: { dir: 'src/assets/i18n', locales: ['en', 'fr', 'nl'] },
//       editor: { dir: 'src/app/.../internationalization', locales: ['en', 'fr', 'it', 'nl'] }
//     },
//     // the branches whose code is live somewhere (or about to be): `prune` never deletes a key any of them still has
//     refs: ['origin/master', 'origin/development'],
//     // (per key space) `sharedWith: ['sociolocal-react-native']`: other repos use this key space's keys too, which this repo
//     // cannot see, so `prune` leaves it alone (it would delete keys they use)
//     // where `sync-local` writes what the sync Lambda would publish (a web repo serves it from there)
//     localOutDir: 'src/assets/i18n-live'
//   }
//
// Paths are relative to the repo. The tag, the shape and the upload format come from the registry, never from here.

const fs = require('fs')
const path = require('path')
const { spaceOf, spaceNames } = require('./spaces')

// The working description of one key space of a repo: the registry's facts plus where its files are.
function makeSet (name, { dir, locales, segments = [], sharedWith = [] }) {
  const space = spaceOf(name)
  if (!dir) throw new Error(`Key space "${name}" needs a dir`)
  if (!Array.isArray(locales) || !locales.includes('en')) throw new Error(`Key space "${name}" needs locales that include "en", the source language`)
  return { name, tag: space.tag, shape: space.shape, uploadFormat: space.uploadFormat, dir, locales, segments, sharedWith }
}

function loadConfig (root = process.cwd()) {
  const file = path.join(root, 'i18n.config.js')
  if (!fs.existsSync(file)) throw new Error(`No i18n.config.js in ${root}: run this from the repo's root`)
  const raw = require(file)
  const sets = {}
  Object.entries(raw.spaces || {}).forEach(([name, space]) => {
    sets[name] = makeSet(name, { ...space, dir: path.resolve(root, space.dir) })
  })
  if (!Object.keys(sets).length) throw new Error(`i18n.config.js lists no key spaces (the key spaces are ${spaceNames().join(', ')})`)
  return {
    root,
    sets,
    refs: raw.refs || [],
    localOutDir: raw.localOutDir ? path.resolve(root, raw.localOutDir) : null
  }
}

// `--space=<key space>|all` (default all) -> the sets to work on. "all" leaves out one whose files are not there
// (a checkout without the editor), but naming it asks for it anyway.
function setsFromArgs (config, argv, exists = dir => fs.existsSync(dir)) {
  const arg = argv.find(a => a.startsWith('--space='))
  const wanted = arg ? arg.slice('--space='.length) : 'all'
  if (wanted === 'all') return Object.values(config.sets).filter(set => exists(set.dir))
  if (!config.sets[wanted]) throw new Error(`This repo has no key space "${wanted}": use ${[...Object.keys(config.sets), 'all'].join(', ')}`)
  return [config.sets[wanted]]
}

module.exports = { makeSet, loadConfig, setsFromArgs }
