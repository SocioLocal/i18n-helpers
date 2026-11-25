'use strict'

// A key space's files in a repo, and its keys. Read here, in one place, for push, pull, status and prune.

const fs = require('fs')
const path = require('path')
const { flatten } = require('./sync')

const fileOf = (set, code) => path.join(set.dir, `${code}.json`)

function readSpace (set) {
  const filesByLocale = {}
  set.locales.forEach(code => { filesByLocale[code] = JSON.parse(fs.readFileSync(fileOf(set, code), 'utf8')) })
  return filesByLocale
}

// The dotted key names of a file, whatever the key space's shape.
const keysOf = (set, file) => Object.keys(set.shape === 'flat' ? file : flatten(file))

// Every key any of the space's language files has in the working tree.
function workingTreeKeys (set) {
  const keys = new Set()
  Object.values(readSpace(set)).forEach(file => keysOf(set, file).forEach(key => keys.add(key)))
  return keys
}

module.exports = { fileOf, readSpace, keysOf, workingTreeKeys }
