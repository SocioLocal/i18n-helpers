'use strict'

// The key spaces: the ONE place they are defined, for every repo, the sync Lambda and the apps that read the files.
//
// A key space is a kind of text with its own readers, and in Phrase it is a TAG on every key. The tag is put on a key
// by the push that creates it, and it is the only thing that says which readers a key is for. Each is published as
// `<key space>/<language>.json` in the shape its readers use:
//
//   web     the web app's UI (ngx-translate): nested.
//   editor  the IMG.LY editor, shared by the web app and the mobile app: FLAT dotted keys, 239 of which are also the
//           parent of another key, so it can only travel flat ("simple_json").
//   email   the wording of the emails the email lambda sends (template -> key -> text): nested.
//
// Adding a key space is adding it here, creating its tag in Phrase (`socio-local-i18n create-space <name>`) and
// pointing a repo's i18n.config.js at its files. A push to a key space that is not in this list, or whose tag does
// not exist in the Phrase project yet, is an error, so a mistyped name cannot quietly start a new one.

const SPACES = {
  web: { tag: 'web', shape: 'nested', uploadFormat: 'nested_json' },
  editor: { tag: 'editor', shape: 'flat', uploadFormat: 'simple_json' },
  email: { tag: 'email', shape: 'nested', uploadFormat: 'nested_json' }
}

const spaceNames = () => Object.keys(SPACES)

function spaceOf (name) {
  if (!SPACES[name]) throw new Error(`Unknown key space "${name}": the key spaces are ${spaceNames().join(', ')} (spaces.js in socio-local-i18n)`)
  return SPACES[name]
}

module.exports = { SPACES, spaceNames, spaceOf }
