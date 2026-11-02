import test from 'node:test'
import assert from 'node:assert/strict'
import { addPackagePaths, packageFilename, downloadFilename, installPackage, mapSearchResults, needsBrowserDownload } from '../src/lib/appPackages.js'

test('Windows and Unix file imports share a deduplicated package queue', () => {
  const queue = addPackagePaths([], ['C:\\Downloads\\app.apk', '/tmp/splits.apks', '/tmp/archive.apkm', '/tmp/no.txt', 'C:\\Downloads\\app.apk'], () => 'id')
  assert.equal(queue.length, 3)
  assert.equal(queue[0].name, 'app.apk')
  assert.equal(addPackagePaths(queue, ['C:\\Downloads\\app.apk']).length, 3)
  assert.equal(packageFilename('/tmp/app.xapk'), 'app.xapk')
})

test('search metadata preserves unknown architectures and manual-download reasons', () => {
  const [result] = mapSearchResults([{ name: 'Example', source: 'uptodown', pageUrl: 'https://example.org/app', manualReason: 'Browser check' }])
  assert.deepEqual(result.arch, [])
  assert.equal(result.apkUrl, null)
  assert.equal(result.manualReason, 'Browser check')
  assert.equal(result.verified, false)
  assert.equal(downloadFilename({ filename: 'release-arm64.apk', pkg: 'owner/repo' }), 'release-arm64.apk')
})

test('local APKs and bundles use the validated package installer', async () => {
  const calls = []
  await installPackage({ serial: 'tv', item: { path: 'C:\\Downloads\\app.apkm' }, invoke: async (...args) => { calls.push(args); return { ok: true } } })
  assert.deepEqual(calls, [['install_app_package', { serial: 'tv', path: 'C:\\Downloads\\app.apkm' }]])
})

test('downloads keep their actual asset name and target device', async () => {
  let call
  await installPackage({ serial: 'chosen-tv', item: { path: 'https://example.org/file', name: 'arm64.apk' }, invoke: async (...args) => { call = args; return { ok: true } } })
  assert.deepEqual(call, ['install_from_url', { serial: 'chosen-tv', url: 'https://example.org/file', filename: 'arm64.apk' }])
})

test('failed installs preserve the Android error instead of reporting success', async () => {
  await assert.rejects(installPackage({ serial: 'tv', item: { path: '/bad.apk' }, invoke: async () => ({ ok: false, stdout: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]' }) }), /UPDATE_INCOMPATIBLE/)
  await assert.rejects(installPackage({ serial: '', item: { path: '/app.apk' }, invoke: async () => { throw new Error('must not run') } }), /Choose a connected device/)
})

test('opening a local Android installer is not a completed install', async () => {
  let opened
  const result = await installPackage({ serial: 'android-local', local: true, item: { path: '/app.apk' }, invoke: async () => ({ ok: true, localPath: '/app.apk' }), openLocal: async path => { opened = path } })
  assert.equal(opened, '/app.apk')
  assert.equal(result.installerOpened, true)
})

test('browser import is offered for download blocks, not signature or version failures', () => {
  assert(needsBrowserDownload('Download returned HTTP 403'))
  assert(needsBrowserDownload('This file is not a valid APK'))
  assert(!needsBrowserDownload('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'))
  assert(!needsBrowserDownload('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'))
})
