import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

test('beta release uses the nightly layout and the current versioned notes', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/beta-release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const script = workflow.match(/          script: \|\n([\s\S]*?)(?=\n  publish-tauri:)/)?.[1]
  assert(script, 'Release script is present')
  assert(workflow.includes('BETA_TAG="v${APP_VERSION}-beta-${BETA_STAMP}"'))
  assert(workflow.includes('BUILD_VERSION="${APP_VERSION}_beta-${BETA_STAMP}"'))
  assert(!workflow.includes('Rewrite app version for Windows'))
  const rendered = script.replace(/^ {12}/gm, '')
    .replaceAll('${{ steps.meta.outputs.beta_tag }}', 'v3.1.0-beta-20261102-180000')
    .replaceAll('${{ steps.meta.outputs.app_version }}', '3.1.0')
    .replaceAll('${{ steps.meta.outputs.beta_stamp }}', '20261102-180000')
  let release
  const outputs = {}
  const context = { repo: { owner: 'TeamNocturnal', repo: 'AndroidToolkit' }, sha: 'a'.repeat(40), ref: 'refs/heads/beta' }
  const github = {
    paginate: async () => [
      { tag_name: 'v3.0.0-beta-20260421-023534', prerelease: true },
      { tag_name: 'v2.0.4-stable', prerelease: false },
    ],
    rest: { repos: {
      listReleases() {},
      compareCommits: async () => ({ data: { html_url: 'https://github.com/TeamNocturnal/AndroidToolkit/compare/base...head', commits: [{ sha: 'b'.repeat(40), commit: { message: 'Improve beta app workflows' } }] } }),
      createRelease: async value => { release = value; return { data: { id: 123 } } },
    } },
  }
  const core = { setOutput: (key, value) => { outputs[key] = value }, warning: message => { throw new Error(message) } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await new AsyncFunction('context', 'github', 'core', 'require', rendered)(context, github, core, createRequire(import.meta.url))
  assert.equal(release.name, 'v3.1.0 beta-20261102-180000')
  assert.equal(release.tag_name, 'v3.1.0-beta-20261102-180000')
  assert.equal(release.target_commitish, context.sha)
  assert.equal(release.prerelease, true)
  assert.equal(release.draft, false)
  assert.equal(outputs.release_id, '123')
  assert.deepEqual([...release.body.matchAll(/^#{2,3} .+$/gm)].map(match => match[0]), [
    '## Android Toolkit v3.1.0', '### Build Info', '### Changelog', '### Install Notes', '### Downloads',
  ])
  assert(release.body.includes('Enabled all six app search providers'))
  assert(!release.body.includes('Previous build:'))
  assert(release.body.includes('Improve beta app workflows'))
})

async function renderNightly(previousTag) {
  const workflow = (await readFile(new URL('../.github/workflows/nightly-release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const script = workflow.match(/          script: \|\n([\s\S]*?)(?=\n  publish-tauri:)/)?.[1]
  assert(script)
  assert(workflow.includes('ref: nightly'))
  assert(workflow.includes('ref: ${{ needs.create-nightly-release.outputs.commit_sha }}'))
  const buildSha = 'c'.repeat(40)
  const rendered = script.replace(/^ {12}/gm, '')
    .replaceAll('${{ steps.meta.outputs.nightly_tag }}', 'v3.1.0-nightly-20261102-180000')
    .replaceAll('${{ steps.meta.outputs.app_version }}', '3.1.0')
    .replaceAll('${{ steps.meta.outputs.nightly_stamp }}', '20261102-180000')
    .replaceAll('${{ steps.meta.outputs.commit_sha }}', buildSha)
  let release
  const context = { repo: { owner: 'TeamNocturnal', repo: 'AndroidToolkit' }, sha: 'a'.repeat(40), ref: 'refs/heads/main' }
  const github = {
    paginate: async () => [
      { tag_name: previousTag, prerelease: true },
      { tag_name: 'v2.0.4-stable', prerelease: false },
    ],
    rest: { repos: {
      listReleases() {},
      compareCommits: async ({ head }) => {
        assert.equal(head, buildSha)
        return { data: { html_url: 'https://github.com/TeamNocturnal/AndroidToolkit/compare/base...head', commits: [{ sha: 'b'.repeat(40), commit: { message: 'Improve nightly app workflows' } }] } }
      },
      createRelease: async value => { release = value; return { data: { id: 124 } } },
    } },
  }
  const core = { setOutput() {}, warning: message => { throw new Error(message) } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await new AsyncFunction('context', 'github', 'core', 'require', rendered)(context, github, core, createRequire(import.meta.url))
  assert.equal(release.target_commitish, buildSha)
  assert.equal(release.name, 'v3.1.0 nightly-20261102-180000')
  assert.equal(release.tag_name, 'v3.1.0-nightly-20261102-180000')
  assert.equal(release.prerelease, true)
  assert(release.body.includes('Improve nightly app workflows'))
  assert.deepEqual([...release.body.matchAll(/^#{2,3} .+$/gm)].map(match => match[0]), [
    '## Android Toolkit v3.1.0', '### Build Info', '### Changelog', '### Install Notes', '### Downloads',
  ])
  return release
}

test('the next nightly includes the 3.1.0 notes and uses the checked-out nightly commit', async () => {
  const release = await renderNightly('v2.0.4-nightly-20261101-180000')
  assert(release.body.includes('Enabled all six app search providers'))
  assert(release.body.includes('Merged the 3.1.0 beta improvements'))
})

test('later nightlies summarize new commits without repeating the whole version changelog', async () => {
  const release = await renderNightly('v3.1.0-nightly-20261101-180000')
  assert(!release.body.includes('Enabled all six app search providers'))
})

test('the legacy package check cannot publish duplicate nightly releases', async () => {
  const workflow = await readFile(new URL('../.github/workflows/nightly-build.yml', import.meta.url), 'utf8')
  assert(!/^  push:/m.test(workflow))
  assert(workflow.includes('workflow_dispatch:'))
  assert(!workflow.includes('action-gh-release'))
})
