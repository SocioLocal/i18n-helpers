'use strict'

// The credentials come from the environment, never from a committed file. For a developer they are kept in `.env.local`
// (or `.env`) in the repo's root, which is git-ignored: PHRASE_PROJECT_ID, PHRASE_CLIENT_ID, PHRASE_CLIENT_SECRET.
// The environment wins over the files, and nothing here ever prints a value.

const fs = require('fs')
const path = require('path')

function parse (text) {
  const values = {}
  text.split('\n').forEach(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || match[1].startsWith('#')) return
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  })
  return values
}

function loadEnvFiles (root, env = process.env) {
  ;['.env.local', '.env'].forEach(name => {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) return
    Object.entries(parse(fs.readFileSync(file, 'utf8'))).forEach(([key, value]) => {
      if (env[key] === undefined) env[key] = value
    })
  })
}

module.exports = { loadEnvFiles, parse }
