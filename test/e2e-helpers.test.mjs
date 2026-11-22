import assert from 'node:assert/strict'
import test from 'node:test'

import { explainFailure, isBuildGate } from '../scripts/e2e.mjs'

// These two helpers only exist because the installer's first failure mode was
// misreported: the real cause was pnpm refusing a git package's build script,
// but the check printed the last 400 characters of stderr, which happened to be
// the tail of a temp path ("bhelper-e2e"). A reader could not act on that.

test('isBuildGate recognises the pnpm git prepare gate, and only that', () => {
  const real = [
    'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in /tmp/x/profiles/p/pnpm-workspace.yaml, then re-run',
    ' ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  The git-hosted package "x@1.0.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  ]
  for (const text of real) assert.equal(isBuildGate(text), true, text)

  const other = [
    'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: Not Found',
    'dsh: pnpm failed in profile directory /tmp/x',
    '',
  ]
  for (const text of other) assert.equal(isBuildGate(text), false, text)
})

test('explainFailure quotes the error lines, not whatever happens to be last', () => {
  // The shape that produced the useless message: the actionable error is in the
  // middle, and the tail is a fragment of a filesystem path.
  const stderr = [
    'Progress: resolved 1, reused 0, downloaded 0',
    ' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-nope: Not Found - 404',
    'dsh: pnpm failed in profile directory C:\\Temp\\wbh-e2e-home-P7lNDT\\profiles\\wbhelper-e2e',
  ].join('\n')
  const reason = explainFailure(stderr)
  assert.match(reason, /ERR_PNPM_FETCH_404/)
  assert.doesNotMatch(reason, /^bhelper-e2e$/)
})

test('explainFailure falls back to the last real lines when nothing is tagged', () => {
  const stderr = 'one\ntwo\nthree'
  assert.equal(explainFailure(stderr), 'one | two | three')
})

test('explainFailure never returns an empty string', () => {
  for (const input of ['', '\n\n', '   \n  ']) {
    assert.equal(explainFailure(input), '(no output)', JSON.stringify(input))
  }
})

test('explainFailure caps the message so a wall of output cannot flood the report', () => {
  const stderr = Array.from({ length: 40 }, (_, i) => ` ERR_PNPM_THING  line ${i} ${'x'.repeat(80)}`).join('\n')
  const reason = explainFailure(stderr)
  assert.ok(reason.length <= 600, `length ${reason.length}`)
  assert.match(reason, /line 39/)
})
