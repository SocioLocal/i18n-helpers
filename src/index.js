'use strict'

// What the apps that deploy this (the sync Lambda, the API) use at run time. The command line is bin/cli.js.
const { createPhraseClient } = require('./phrase-client')
const { syncProject, publish, nest, flatten, MANIFEST_KEY } = require('./sync')
const { SPACES, spaceNames } = require('./spaces')
const { fileStore } = require('./store')

module.exports = { createPhraseClient, syncProject, publish, nest, flatten, MANIFEST_KEY, SPACES, spaceNames, fileStore }
