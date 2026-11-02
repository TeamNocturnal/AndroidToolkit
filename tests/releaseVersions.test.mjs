import test from 'node:test'
import assert from 'node:assert/strict'
import { currentChannelTag, compareVersions, hasReleaseUpdate, defaultReleaseChannel } from '../src/lib/releaseVersions.js'

test('beta build metadata maps to its release tag', () => {
  assert.equal(currentChannelTag('3.1.0_beta-20261102-180000', 'beta'), 'v3.1.0-beta-20261102-180000')
  assert.equal(currentChannelTag('3.1.0_nightly-20261102-180000', 'beta'), '')
})

test('nightly packages default to the nightly update channel', () => {
  assert.equal(defaultReleaseChannel('3.1.0_nightly-20261102-180000'), 'nightly')
  assert.equal(defaultReleaseChannel('3.1.0_beta-20261102-180000'), 'beta')
  assert.equal(defaultReleaseChannel('3.1.0'), 'beta')
})

test('a newer beta build updates within the same app version', () => {
  const installed = '3.1.0_beta-20261102-180000'
  assert(hasReleaseUpdate({ tag_name: 'v3.1.0-beta-20261103-180000' }, 'beta', '3.1.0', installed))
  assert(!hasReleaseUpdate({ tag_name: 'v3.1.0-beta-20261102-180000' }, 'beta', '3.1.0', installed))
  assert(!hasReleaseUpdate({ tag_name: 'v3.1.0-beta-20261101-180000' }, 'beta', '3.1.0', installed))
})

test('nightly build metadata and ordinary version updates still work', () => {
  assert(hasReleaseUpdate({ tag_name: 'v3.1.0-nightly-20261103-180000' }, 'nightly', '3.1.0', '3.1.0_nightly-20261102-180000'))
  assert(!hasReleaseUpdate({ tag_name: 'v3.1.0-stable' }, 'stable', '3.1.0'))
  assert(hasReleaseUpdate({ tag_name: 'v3.1.1-stable' }, 'stable', '3.1.0'))
  assert(compareVersions('3.1.0_beta-20261102-180000', '3.1.0-beta-20261101-180000') > 0)
})
