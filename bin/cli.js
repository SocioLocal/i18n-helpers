#!/usr/bin/env node
'use strict'

require('../src/cli').main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
