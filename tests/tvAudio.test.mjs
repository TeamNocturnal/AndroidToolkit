import test from 'node:test'
import assert from 'node:assert/strict'
import { createTvAudioTools, summarizeTvAudio } from '../src/lib/tvAudio.js'

function fixture({ missingActivity = false, hardwareId = 'hardware', owner = '0', denyLogs = false } = {}) {
  const calls = []
  const run = async args => {
    calls.push(args)
    assert.equal(args[1], 'tv:5555')
    let stdout = ''
    if (args[2] === 'reboot') return { ok: true, stdout: '', stderr: '' }
    const [command, ...rest] = args.slice(3)
    if (command === 'cat') stdout = '1598400.00 5000000.00'
    if (command === 'dumpsys' && rest[0] === 'audio') stdout = '- STREAM_MUSIC:\n  Devices: hdmi(400)\n- STREAM_ALARM:\n Devices: speaker'
    if (command === 'dumpsys' && rest[0] === 'media.audio_flinger') stdout = 'underruns=0\nunderruns=3'
    if (command === 'settings') stdout = '0'
    if (command === 'logcat') return { ok: !denyLogs, stdout: denyLogs ? '' : 'W/AudioTrack( 123): underrun', stderr: denyLogs ? 'Permission denied' : '' }
    if (command === 'pm') stdout = 'package:org.xbmc.kodi\npackage:com.android.systemui\n'
    if (command === 'cmd') stdout = missingActivity ? 'No activity found' : 'org.xbmc.kodi/.Main'
    if (command === 'getprop') stdout = hardwareId
    if (command === 'am' && rest[0] === 'get-current-user') stdout = owner
    return { ok: true, stdout, stderr: '' }
  }
  const inspect = async () => ({ identity: { hardwareId: 'hardware' } })
  return { calls, tools: createTvAudioTools(run, inspect) }
}

test('audio check is read-only and exposes summaries without raw log text', async () => {
  const f = fixture()
  const report = await f.tools.diagnose('tv:5555')
  assert.equal(report.uptimeHours, 444)
  assert.equal(report.route, 'hdmi(400)')
  assert.equal(report.outputMode, 'Automatic')
  assert.equal(report.nonzeroUnderrunCounters, 1)
  assert.equal(report.warningCount, 1)
  assert.deepEqual(report.apps, [{ id: 'org.xbmc.kodi', name: 'Kodi' }])
  assert.ok(!JSON.stringify(report).includes('underrun"'))
  assert.ok(!f.calls.some(args => args.includes('force-stop') || args.includes('reboot') || args.includes('put')))
})
test('missing diagnostic permissions are shown as unavailable rather than zero errors', async () => {
  const f = fixture({ denyLogs: true })
  const report = await f.tools.diagnose('tv:5555')
  assert.ok(report.unavailable.includes('Recent audio warnings'))
})
test('app restart resolves and validates the TV launch activity before stopping playback', async () => {
  const f = fixture()
  const message = await f.tools.restartApp('tv:5555', 'org.xbmc.kodi')
  const stopped = f.calls.findIndex(args => args.includes('force-stop'))
  const resolved = f.calls.findIndex(args => args.includes('resolve-activity'))
  assert.ok(resolved >= 0 && stopped > resolved)
  assert.deepEqual(f.calls.at(-1), ['-s', 'tv:5555', 'shell', 'am', 'start', '--user', '0', '-n', 'org.xbmc.kodi/.Main'])
  assert.match(message, /requested/)
  assert.ok(!f.calls.some(args => args.includes('clear')))
})
test('no launch activity leaves the app running', async () => {
  const f = fixture({ missingActivity: true })
  await assert.rejects(f.tools.restartApp('tv:5555', 'org.xbmc.kodi'), /left running/)
  assert.ok(!f.calls.some(args => args.includes('force-stop')))
})
test('recovery refuses core apps and hardware or profile changes', async () => {
  const f = fixture()
  await assert.rejects(f.tools.restartApp('tv:5555', 'com.android.systemui'), /listed playback app/)
  for (const config of [{ hardwareId: 'other' }, { owner: '10' }]) {
    const changed = fixture(config)
    await assert.rejects(changed.tools.restartApp('tv:5555', 'org.xbmc.kodi'), /device changed|primary TV profile/)
    await assert.rejects(changed.tools.restartDevice('tv:5555'), /device changed|primary TV profile/)
    assert.ok(!changed.calls.some(args => args.includes('force-stop') || args[2] === 'reboot'))
  }
})
test('explicit device restart targets only the selected TV and reports a request', async () => {
  const f = fixture()
  assert.match(await f.tools.restartDevice('tv:5555'), /restart requested/)
  assert.deepEqual(f.calls.at(-1), ['-s', 'tv:5555', 'reboot'])
})
test('empty audio metrics remain unknown and never imply a measured sync delay', () => {
  const report = summarizeTvAudio({})
  assert.equal(report.uptimeHours, null)
  assert.equal(report.route, 'Not reported')
  assert.equal(report.nonzeroUnderrunCounters, null)
  assert.ok(!('latency' in report))
})
