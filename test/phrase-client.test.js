'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPhraseClient } = require('../src/phrase-client')

const SECRET = 'super-secret-value'

function response (status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] },
    json: async () => body
  }
}

// routes: array of (url, init) => response | undefined, tried in order; every call is recorded.
function fakeFetch (routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, method: init.method || 'GET', body: init.body, headers: init.headers })
    for (const route of routes) {
      const result = route(href, init, calls)
      if (result) return result
    }
    throw new Error(`unrouted request ${init.method || 'GET'} ${href}`)
  }
  fn.calls = calls
  return fn
}

const tokenRoute = (expiresIn = 14400) => href =>
  href.includes('/idm/oauth/token') ? response(200, { access_token: 'jwt-1', expires_in: expiresIn }) : undefined

function makeClient (fetchImpl, extra = {}) {
  return createPhraseClient({
    projectId: 'P1',
    clientId: 'client-1',
    clientSecret: SECRET,
    fetchImpl,
    sleep: async () => {},
    ...extra
  })
}

test('exchanges client credentials once and reuses the JWT', async () => {
  const fetchImpl = fakeFetch([tokenRoute(), href => (href.includes('/locales') ? response(200, []) : undefined)])
  const client = makeClient(fetchImpl)

  await client.listLocales()
  await client.listLocales()

  const exchanges = fetchImpl.calls.filter(call => call.href.includes('/idm/oauth/token'))
  assert.equal(exchanges.length, 1)
  assert.equal(fetchImpl.calls[1].headers.Authorization, 'Bearer jwt-1')
  assert.match(String(exchanges[0].body), /grant_type=client_credentials/)
})

test('renews the JWT before it expires', async () => {
  let clock = 0
  const fetchImpl = fakeFetch([tokenRoute(7200), href => (href.includes('/locales') ? response(200, []) : undefined)])
  const client = makeClient(fetchImpl, { now: () => clock })

  await client.listLocales()
  clock = 60 * 60 * 1000 // 1h: still valid (2h life, renewed 30 min early)
  await client.listLocales()
  clock = 95 * 60 * 1000 // 95 min: inside the renewal margin
  await client.listLocales()

  assert.equal(fetchImpl.calls.filter(call => call.href.includes('/idm/oauth/token')).length, 2)
})

test('a 401 renews the JWT once and retries', async () => {
  let rejected = false
  const fetchImpl = fakeFetch([
    tokenRoute(),
    href => {
      if (!href.includes('/locales')) return undefined
      if (!rejected) { rejected = true; return response(401, {}) }
      return response(200, [{ id: 'L1', code: 'en' }])
    }
  ])
  const client = makeClient(fetchImpl)

  assert.deepEqual(await client.listLocales(), [{ id: 'L1', code: 'en' }])
  assert.equal(fetchImpl.calls.filter(call => call.href.includes('/idm/oauth/token')).length, 2)
})

test('a 429 waits for Retry-After and retries', async () => {
  const sleeps = []
  let limited = 0
  const fetchImpl = fakeFetch([
    tokenRoute(),
    href => {
      if (!href.includes('/locales')) return undefined
      if (limited++ < 2) return response(429, {}, { 'retry-after': '3' })
      return response(200, [])
    }
  ])
  const client = makeClient(fetchImpl, { sleep: async ms => sleeps.push(ms) })

  await client.listLocales()

  assert.deepEqual(sleeps, [3000, 3000])
})

test('errors carry the status but never the secret', async () => {
  const fetchImpl = fakeFetch([
    href => (href.includes('/idm/oauth/token') ? response(400, { error: `bad ${SECRET}` }) : undefined)
  ])
  const client = makeClient(fetchImpl)

  await assert.rejects(client.listLocales(), err => {
    assert.match(err.message, /HTTP 400/)
    assert.ok(!err.message.includes(SECRET))
    return true
  })
})

test('a failed exchange names the OAuth error code, still without the secret or the description', async () => {
  const fetchImpl = fakeFetch([
    href => (href.includes('/idm/oauth/token')
      ? response(400, { error: 'invalid_client', error_description: `client ${SECRET} unknown` })
      : undefined)
  ])

  await assert.rejects(makeClient(fetchImpl).listLocales(), err => {
    assert.equal(err.message, 'Phrase token exchange failed: HTTP 400 (invalid_client)')
    return true
  })
})

test('an API error names the parameters and Phrase\'s own message', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute(),
    href => (href.includes('/download') ? response(400, { message: 'Unknown tag' }) : undefined)
  ])

  await assert.rejects(makeClient(fetchImpl).downloadLocale('L1', { fileFormat: 'json', tags: 'nope' }), err => {
    assert.match(err.message, /\[file_format=json&tags=nope\] failed: HTTP 400: Unknown tag/)
    return true
  })
})

test('uploadFile sends a multipart form with the file, format, locale, tags and update flag', async () => {
  const fetchImpl = fakeFetch([tokenRoute(), (href, init) => (init.method === 'POST' && href.endsWith('/uploads') ? response(201, { id: 'U1' }) : undefined)])

  const created = await makeClient(fetchImpl).uploadFile({
    localeId: 'L-en', fileName: 'en.json', content: '{"a":"b"}', fileFormat: 'nested_json', tags: 'web', updateTranslations: true
  })

  const call = fetchImpl.calls.find(c => c.href.endsWith('/uploads'))
  const form = call.body
  assert.equal(created.id, 'U1')
  assert.ok(form instanceof FormData)
  assert.equal(form.get('file_format'), 'nested_json')
  assert.equal(form.get('locale_id'), 'L-en')
  assert.equal(form.get('tags'), 'web')
  assert.equal(form.get('update_translations'), 'true')
  assert.equal(form.get('skip_upload_tags'), 'true')
  assert.equal(await form.get('file').text(), '{"a":"b"}')
  assert.equal(form.get('file').name, 'en.json')
  assert.equal(call.headers['Content-Type'], undefined, 'fetch must set the multipart boundary itself')
})

test('download passes the format and tags', async () => {
  const fetchImpl = fakeFetch([tokenRoute(), href => (href.includes('/download') ? response(200, {}) : undefined)])
  await makeClient(fetchImpl).downloadLocale('L1', { fileFormat: 'json', tags: 'editor' })

  const url = new URL(fetchImpl.calls[1].href)
  assert.equal(url.pathname, '/v2/projects/P1/locales/L1/download')
  assert.equal(url.searchParams.get('file_format'), 'json')
  assert.equal(url.searchParams.get('tags'), 'editor')
})

test('upsertKeyText creates a missing key with its English text', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute(),
    (href, init) => (href.includes('/keys?') && init.method === 'GET' ? response(200, []) : undefined),
    (href, init) => (init.method === 'POST' && href.endsWith('/keys') ? response(201, { id: 'K1' }) : undefined)
  ])

  await makeClient(fetchImpl).upsertKeyText({
    name: 'onboarding.clients.acme.id_label', text: 'Store ID', description: 'ID label', tags: 'onboarding-client', localeId: 'L-en'
  })

  const post = fetchImpl.calls.find(call => call.method === 'POST' && call.href.endsWith('/keys'))
  assert.deepEqual(JSON.parse(post.body), {
    name: 'onboarding.clients.acme.id_label',
    description: 'ID label',
    tags: 'onboarding-client',
    data_type: 'string',
    default_translation_content: 'Store ID'
  })
})

test('upsertKeyText updates the English translation of an existing key', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute(),
    (href, init) => (href.includes('/keys?') && init.method === 'GET' ? response(200, [{ id: 'K1', name: 'a.b' }]) : undefined),
    href => (href.includes('/keys/K1/translations') ? response(200, [{ id: 'T-en', locale: { id: 'L-en' } }]) : undefined),
    (href, init) => (init.method === 'PATCH' && href.endsWith('/translations/T-en') ? response(200, { id: 'T-en' }) : undefined)
  ])

  await makeClient(fetchImpl).upsertKeyText({ name: 'a.b', text: 'New', localeId: 'L-en' })

  const patch = fetchImpl.calls.find(call => call.method === 'PATCH')
  assert.deepEqual(JSON.parse(patch.body), { content: 'New' })
})

test('upsertKeyText treats a 422 on create as "another save won the race" and updates', async () => {
  let lookups = 0
  const fetchImpl = fakeFetch([
    tokenRoute(),
    (href, init) => {
      if (!(href.includes('/keys?') && init.method === 'GET')) return undefined
      return response(200, lookups++ === 0 ? [] : [{ id: 'K9', name: 'a.b' }])
    },
    (href, init) => (init.method === 'POST' ? response(422, { errors: [{ field: 'name', message: 'has already been taken' }] }) : undefined),
    href => (href.includes('/keys/K9/translations') ? response(200, [{ id: 'T9', locale: { id: 'L-en' } }]) : undefined),
    (href, init) => (init.method === 'PATCH' ? response(200, { id: 'T9' }) : undefined)
  ])

  await makeClient(fetchImpl).upsertKeyText({ name: 'a.b', text: 'Text', localeId: 'L-en' })

  assert.ok(fetchImpl.calls.some(call => call.method === 'PATCH' && call.href.endsWith('/translations/T9')))
})

test('a 429 waits until Phrase says its limit resets (X-Rate-Limit-Reset), not a fixed few seconds', async () => {
  const sleeps = []
  const waits = []
  let limited = 0
  const fetchImpl = fakeFetch([
    tokenRoute(),
    href => {
      if (!href.includes('/locales')) return undefined
      if (limited++ < 1) return response(429, {}, { 'x-rate-limit-reset': String(1000 + 120) })
      return response(200, [])
    }
  ])
  const client = makeClient(fetchImpl, { now: () => 1000 * 1000, sleep: async ms => sleeps.push(ms), maxWaitMs: 5 * 60 * 1000, onWait: (ms, why) => waits.push([ms, why]) })

  await client.listLocales()

  assert.deepEqual(sleeps, [121000])
  assert.deepEqual(waits, [[121000, 'Phrase answered HTTP 429']])
})

test('a server\'s client does not wait minutes: a long reset fails at once, with the time to wait', async () => {
  const sleeps = []
  const fetchImpl = fakeFetch([tokenRoute(), href => (href.includes('/locales') ? response(429, {}, { 'x-rate-limit-reset': String(1000 + 120) }) : undefined)])
  const client = makeClient(fetchImpl, { now: () => 1000 * 1000, sleep: async ms => sleeps.push(ms) })

  await assert.rejects(client.listLocales(), err => {
    assert.equal(err.status, 429)
    assert.match(err.message, /resets in 121 seconds/)
    assert.equal(err.retryAfterMs, 121000)
    return true
  })
  assert.deepEqual(sleeps, [])
})

test('maxRetries bounds how many times a refused request is tried again', async () => {
  const sleeps = []
  let calls = 0
  const fetchImpl = fakeFetch([tokenRoute(), href => (href.includes('/locales') ? (calls++, response(503, {})) : undefined)])
  const client = makeClient(fetchImpl, { maxRetries: 2, sleep: async ms => sleeps.push(ms) })

  await assert.rejects(client.listLocales(), /HTTP 503/)

  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test('the tools\' client waits for the limit to reset and says so, reading its credentials from the environment', async () => {
  const { clientFromEnv } = require('../src/cli-client')
  const lines = []
  assert.throws(() => clientFromEnv({}, m => lines.push(m)), /needs projectId, clientId and clientSecret/)

  let limited = 0
  const originalFetch = global.fetch
  const sleeps = []
  global.fetch = async url => {
    if (String(url).includes('/idm/oauth/token')) return response(200, { access_token: 'jwt', expires_in: 14400 })
    return limited++ < 1 ? response(429, {}, { 'retry-after': '90' }) : response(200, [])
  }
  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn, ms) => { sleeps.push(ms); return realSetTimeout(fn, 0) }
  try {
    const client = clientFromEnv({ PHRASE_PROJECT_ID: 'P', PHRASE_CLIENT_ID: 'c', PHRASE_CLIENT_SECRET: 's' }, m => lines.push(m))
    await client.listLocales()
  } finally {
    global.fetch = originalFetch
    global.setTimeout = realSetTimeout
  }

  assert.ok(sleeps.includes(90000))
  assert.deepEqual(lines, ["  Phrase answered HTTP 429: waiting 90s for Phrase's rate limit to reset..."])
})
