'use strict'

// NS-6591: minimal Phrase Strings client for the i18n sync. No dependencies (global fetch, Node 18+).
//
// Auth: a Phrase service account (Organization settings > Service accounts) exchanges its client id and
// secret for a JWT at eu.phrase.com, which is sent as `Authorization: Bearer` to api.phrase.com/v2 (the
// EU data centre). The JWT lives about 4 hours; it is cached and renewed early, and renewed once on a 401.

const API_BASE = 'https://api.phrase.com/v2'
const TOKEN_URL = 'https://eu.phrase.com/idm/oauth/token'
const RENEW_BEFORE_EXPIRY_MS = 30 * 60 * 1000
const DEFAULT_RETRIES = 4
// A server (the lambda, the API) must not sit waiting minutes for Phrase; a command-line tool can.
const DEFAULT_MAX_WAIT_MS = 20 * 1000

function createPhraseClient ({
  projectId,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  // how many times a request that Phrase refused for load (429, 5xx) is tried again
  maxRetries = DEFAULT_RETRIES,
  // the longest the client will wait for Phrase's rate limit to reset; a longer wait fails with the time to wait
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  // told when it waits: (milliseconds, why)
  onWait = () => {}
}) {
  if (!projectId || !clientId || !clientSecret) {
    throw new Error('Phrase client needs projectId, clientId and clientSecret')
  }

  let jwt = null
  let jwtValidUntil = 0

  async function token (forceRenew) {
    if (!forceRenew && jwt && now() < jwtValidUntil) return jwt
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    })
    if (!res.ok) {
      // The status and the short OAuth error code (invalid_client, invalid_request, ...) only: never the
      // rest of the body or any header, they can carry credentials.
      let code = ''
      try {
        const body = await res.json()
        if (typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error)) code = ` (${body.error})`
      } catch (ignored) { /* no JSON body */ }
      throw new Error(`Phrase token exchange failed: HTTP ${res.status}${code}`)
    }
    const body = await res.json()
    jwt = body.access_token
    jwtValidUntil = now() + body.expires_in * 1000 - RENEW_BEFORE_EXPIRY_MS
    return jwt
  }

  // How long to wait before trying again. Phrase says when its rate limit resets (X-Rate-Limit-Reset, a UNIX
  // time in seconds, or Retry-After in seconds); without either, back off 1, 2, 4... seconds.
  function retryDelayMs (res, attempt) {
    const header = name => (res.headers && res.headers.get ? res.headers.get(name) : undefined)
    const retryAfter = Number(header('retry-after'))
    if (retryAfter > 0) return retryAfter * 1000
    const reset = Number(header('x-rate-limit-reset'))
    if (reset > 0) return Math.max(1000, reset * 1000 - now() + 1000)
    return 1000 * 2 ** attempt
  }

  async function request (path, { method = 'GET', query = {}, json, form } = {}) {
    const url = new URL(`${API_BASE}/projects/${projectId}${path}`)
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
    })

    let renewed = false
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bearer ${await token(false)}` }
      if (json !== undefined) headers['Content-Type'] = 'application/json'
      // A FormData body is left to fetch, which sets the multipart boundary itself.
      const body = form !== undefined ? form : json === undefined ? undefined : JSON.stringify(json)
      const res = await fetchImpl(url, { method, headers, body })

      if (res.status === 401 && !renewed) {
        renewed = true
        await token(true)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const wait = retryDelayMs(res, attempt)
        if (wait > maxWaitMs) {
          const error = new Error(`Phrase ${method} ${path} refused for load: HTTP ${res.status}; its limit resets in ${Math.ceil(wait / 1000)} seconds`)
          error.status = res.status
          error.retryAfterMs = wait
          throw error
        }
        onWait(wait, `Phrase answered HTTP ${res.status}`)
        await sleep(wait)
        continue
      }
      if (!res.ok) {
        // Phrase's own error text is safe to show (it never echoes credentials) and says what it objected to.
        let body = {}
        try { body = await res.json() } catch (ignored) { /* no JSON body */ }
        const reason = typeof body.message === 'string' ? `: ${body.message.slice(0, 200)}` : ''
        const params = [...url.searchParams.keys()].length ? ` [${url.searchParams.toString()}]` : ''
        const error = new Error(`Phrase ${method} ${path}${params} failed: HTTP ${res.status}${reason}`)
        error.status = res.status
        error.details = body.errors
        throw error
      }
      return res.status === 204 ? null : res.json()
    }
  }

  return {
    listLocales: () => request('/locales', { query: { per_page: 100 } }),

    // `json` is Phrase's flat format: { "a.b.c": { "message": "text" } }. Flat keeps keys that are
    // both a string and a parent (the editor has 239) intact; nested_json silently drops those.
    downloadLocale: (localeId, { fileFormat = 'json', tags } = {}) =>
      request(`/locales/${localeId}/download`, { query: { file_format: fileFormat, tags } }),

    // Uploads are accepted (201) and processed asynchronously: poll getUpload until state is success/error.
    // `tags` only tag keys the upload creates; skip_upload_tags avoids one noise tag per upload.
    uploadFile ({ localeId, fileName, content, fileFormat, tags, updateTranslations }) {
      const form = new FormData()
      form.set('file', new Blob([content], { type: 'application/json' }), fileName)
      form.set('file_format', fileFormat)
      form.set('locale_id', localeId)
      if (tags) form.set('tags', tags)
      form.set('update_translations', String(Boolean(updateTranslations)))
      form.set('skip_upload_tags', 'true')
      return request('/uploads', { method: 'POST', form })
    },

    getUpload: id => request(`/uploads/${id}`),

    // One page of the project's keys (up to 100): [{ id, name, tags, ... }].
    // `q` is a Phrase search ("tags:web"): the keys of one key space.
    listKeys: ({ page = 1, perPage = 100, q } = {}) => request('/keys', { query: { page, per_page: perPage, q } }),

    // The tags of the project, which are its key spaces: [{ name, ... }] (a project has a handful).
    listTags: () => request('/tags', { query: { per_page: 100 } }),

    // Creates a tag, deliberately: an upload never creates one (see push.js), so a mistyped key space is an error.
    createTag: name => request('/tags', { method: 'POST', json: { name } }),

    // Deletes every key matching a Phrase search (`q`, here always "ids:a,b,c") and answers how many it deleted.
    async deleteKeys ({ q }) {
      const result = await request('/keys', { method: 'DELETE', json: { q } })
      return result.records_affected
    },

    // Tags every key matching a Phrase search (`q`, e.g. "name:action.*": a wildcard works only at the end of a
    // name) and answers how many it tagged. Used once to tag keys that were pushed before keys were tagged.
    async tagKeys ({ q, tags }) {
      const result = await request('/keys/tag', { method: 'PATCH', json: { q, tags } })
      return result.records_affected
    },

    // The reverse of tagKeys, to undo a tagging that caught keys it should not have.
    async untagKeys ({ q, tags }) {
      const result = await request('/keys/tag', { method: 'DELETE', json: { q, tags } })
      return result.records_affected
    },

    // Write path for the admin sign-up forms (the upsert proven in the dev spike):
    // look the key up by name, create it with its English text, or update the English translation.
    async upsertKeyText ({ name, text, description, tags, localeId }) {
      const found = await request('/keys', { query: { q: `name:${name}`, per_page: 100 } })
      const existing = found.find(key => key.name === name)
      if (!existing) {
        try {
          return await request('/keys', {
            method: 'POST',
            json: { name, description, tags, data_type: 'string', default_translation_content: text }
          })
        } catch (err) {
          if (err.status !== 422) throw err
          // lost a race with another save: fall through to the update below
          const again = await request('/keys', { query: { q: `name:${name}`, per_page: 100 } })
          const created = again.find(key => key.name === name)
          if (!created) throw err
          return this.updateKeyText(created.id, text, localeId)
        }
      }
      return this.updateKeyText(existing.id, text, localeId)
    },

    async updateKeyText (keyId, text, localeId) {
      const translations = await request(`/keys/${keyId}/translations`, { query: { locale_id: localeId } })
      const target = translations.find(t => t.locale.id === localeId)
      if (!target) throw new Error(`Phrase key ${keyId} has no translation for locale ${localeId}`)
      return request(`/translations/${target.id}`, { method: 'PATCH', json: { content: text } })
    }
  }
}

module.exports = { createPhraseClient }
