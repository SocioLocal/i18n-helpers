# socio-local-i18n

One set of tools for SocioLocal's translations, shared by every repo that has text for Phrase (`socio-local-web`,
`socio-local-api`, the sync Lambda). It replaces the copies of these tools that each repo used to carry.

## The rules

- **A key space** is a kind of text with its own readers: `web` (the web app, nested), `editor` (IMG.LY, flat, shared by the
  web and mobile apps), `email` (the email Lambda, nested). In Phrase it is a **tag** on every key. They are defined once,
  in `src/spaces.js`; a repo says which it owns, and where the files are, in its `i18n.config.js`.
- **The repo owns the keys** (they link up with the code). A developer adds a key with an initial English value.
- **Phrase owns the values**, English included: a translator may change the initial English, and every other language is
  theirs. A push never changes a value that is already in Phrase.
- **The sync** (the Lambda in `socio-local-api`, nightly and from the admin's "Update from Phrase") publishes every key
  space as `<key space>/<language>.json`, in the shape its readers use, plus a `locales.json` manifest.

## Commands

Run from a repo's root (the repos' `package.json` has `i18n:push`, `i18n:pull`, ... scripts). Credentials
(`PHRASE_PROJECT_ID`, `PHRASE_CLIENT_ID`, `PHRASE_CLIENT_SECRET`) come from the environment or a git-ignored
`.env.local` / `.env`. Use the **dev** Phrase project until told otherwise.

| Command | What it does |
| --- | --- |
| `push` | Adds the keys Phrase lacks (English value from the repo, tagged with the key space) and fills missing translations. Errors if the key space's tag does not exist in the project. `--dry-run` needs no credentials. |
| `push --overwrite` | **Bootstrap only**, before a project's first deploy: the repo's values replace Phrase's. |
| `pull` | Copies Phrase's values into the repo's files. Values only, never keys; `--dry-run`, `--show`. |
| `status` | What a push would add, which keys are unused, how many values Phrase changed. Changes nothing. |
| `prune` | Deletes from Phrase the keys no branch uses any more. Dry run unless `--yes`. See below. |
| `create-space <name>` | Creates a key space's tag in the project. A push never does. |
| `migrate-tags --space=x` | **One-time per project**: tags keys pushed before keys were tagged. Delete once every project is done. |
| `sync-local [dir]` | What the sync Lambda publishes, written to a folder. |

Options: `--space=<key space>|all` (default all), `--dry-run`, `--show`, `--yes`, `--force`, `--refs=a,b`.

## Day to day

- **Add a key:** put it, with its English value, in the repo's English file and use it in the code. `npm run i18n:push`
  (CI does it on every commit). Translators translate it in Phrase; the nightly sync publishes it. Until then the app
  shows the English from its bundle.
- **Remove a key:** delete it from the code and the English file. It stays in Phrase (and in the published files) until
  `prune`, which only deletes a key that **no branch in `refs` still has**: development is deployed to the dev
  environment and master to production, so a key removed on one branch may still be live from another. `prune`
  also refuses to run with nothing to keep, and to delete more than 25% of a key space at once (`--force` overrides).
  A key space another repo also uses (the editor's keys are shared with `sociolocal-react-native`) is marked
  `sharedWith` in the config and `prune` skips it: it cannot see that repo's code. Pruning is deliberate, not part of a commit.
- **Add a key space:** add it to `src/spaces.js`, `create-space <name>` in each Phrase project, add it to a repo's
  `i18n.config.js`, and add its readers.

## In deployed code

The sync Lambda and the API use `require('socio-local-i18n')` (the Phrase client, `syncProject`), so in those repos it is
a normal dependency that their builds must be able to install, not a dev-only tool. The web repo uses it as a dev
dependency only. Install it from its git URL once it has a remote.

## Tests

`npm test` (Node 18+, no dependencies).
