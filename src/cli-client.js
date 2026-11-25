'use strict'

// The Phrase client the command-line tools use: built from PHRASE_PROJECT_ID, PHRASE_CLIENT_ID and PHRASE_CLIENT_SECRET.
// Starter allows about 100 Phrase requests per 5 minutes, and a tool that lists every key can use a good part of that,
// so unlike a server it waits for the limit to reset (and says so) instead of giving up.

const { createPhraseClient } = require('./phrase-client')

function clientFromEnv (env = process.env, log = console.log) {
  return createPhraseClient({
    projectId: env.PHRASE_PROJECT_ID,
    clientId: env.PHRASE_CLIENT_ID,
    clientSecret: env.PHRASE_CLIENT_SECRET,
    maxRetries: 30,
    maxWaitMs: 6 * 60 * 1000,
    onWait: (ms, why) => log(`  ${why}: waiting ${Math.ceil(ms / 1000)}s for Phrase's rate limit to reset...`)
  })
}

module.exports = { clientFromEnv }
