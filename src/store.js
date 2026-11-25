'use strict'

// The "bucket" for a sync that runs on a laptop: a folder. The sync Lambda's local mode and `sync-local` both use it.

const fs = require('fs')
const path = require('path')

function fileStore (dir) {
  return {
    async get (file) {
      try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } catch (err) { return null }
    },
    async put (file, body) {
      const target = path.join(dir, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, body)
    }
  }
}

module.exports = { fileStore }
