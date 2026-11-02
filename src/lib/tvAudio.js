export const TV_PLAYBACK_APPS = [
  { id: 'com.netflix.ninja', name: 'Netflix' },
  { id: 'com.amazon.amazonvideo.livingroom', name: 'Prime Video' },
  { id: 'com.disney.disneyplus', name: 'Disney+' },
  { id: 'com.google.android.youtube.tv', name: 'YouTube' },
  { id: 'com.plexapp.android', name: 'Plex' },
  { id: 'org.xbmc.kodi', name: 'Kodi' },
  { id: 'tv.pluto.android', name: 'Pluto TV' },
  { id: 'com.nuvio.tv', name: 'Nuvio' },
  { id: 'com.syncler', name: 'Syncler' },
  { id: 'com.stremio.one', name: 'Stremio' },
  { id: 'org.smarttube.stable', name: 'SmartTube' },
  { id: 'ar.tvplayer.tv', name: 'TiviMate' },
]

const audioModes = { '0': 'Automatic', '1': 'Surround disabled', '2': 'Surround always enabled', '3': 'Manual formats' }
const enabledPackages = output => new Set(output.split(/\r?\n/).filter(line => line.startsWith('package:')).map(line => line.slice(8).trim()))

export function summarizeTvAudio({ uptime = '', audio = '', flinger = '', mode = '', warnings = '' }) {
  const seconds = Number(uptime.trim().split(/\s+/)[0])
  const music = audio.split(/- STREAM_MUSIC:/)[1]?.split(/\n- STREAM_/)[0] || ''
  const route = music.match(/Devices:\s*([^\r\n]+)/)?.[1]?.trim() || 'Not reported'
  const counters = [...flinger.matchAll(/\bunderruns?\s*[=:]\s*(\d+)/gi)].map(match => Number(match[1]))
  const warningLines = warnings.split(/\r?\n/).filter(line => /^[WE]\/(?:AudioTrack|AudioFlinger|AudioPolicyManager|CCodec|MediaCodec)\b/.test(line))
  return {
    uptimeHours: Number.isFinite(seconds) && seconds >= 0 && uptime.trim() ? seconds / 3600 : null,
    route, outputMode: audioModes[mode.trim()] || 'Not reported',
    nonzeroUnderrunCounters: counters.length ? counters.filter(value => value > 0).length : null,
    warningCount: warningLines.length,
  }
}

export function createTvAudioTools(runAdb, inspectTv) {
  async function checked(args) {
    const result = await runAdb(args)
    if (result?.ok !== true || /error:|permission denial|securityexception|exception occurred/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)) throw new Error(String(result?.stderr || result?.stdout || 'Device command failed.').trim().slice(0, 300))
    return String(result.stdout || '').trim()
  }
  const shell = (serial, args) => checked(['-s', serial, 'shell', ...args])
  async function enabledApps(serial) {
    const enabled = enabledPackages(await shell(serial, ['pm', 'list', 'packages', '-e', '--user', '0']))
    return TV_PLAYBACK_APPS.filter(app => enabled.has(app.id))
  }
  async function verifyTarget(serial, identity) {
    let hardwareId = await shell(serial, ['getprop', 'ro.serialno'])
    if (!hardwareId || hardwareId === 'unknown') hardwareId = await shell(serial, ['getprop', 'ro.boot.serialno'])
    if (!hardwareId || hardwareId !== identity.hardwareId) throw new Error('The selected device changed. Scan again before recovery.')
    if (await shell(serial, ['am', 'get-current-user']) !== '0') throw new Error('Switch to the primary TV profile before recovery.')
  }
  async function diagnose(serial) {
    await inspectTv(serial)
    const unavailable = []
    async function optional(name, args) {
      try { return await shell(serial, args) }
      catch { unavailable.push(name); return '' }
    }
    const uptime = await optional('Uptime', ['cat', '/proc/uptime'])
    const audio = await optional('Audio route', ['dumpsys', 'audio'])
    const flinger = await optional('Audio counters', ['dumpsys', 'media.audio_flinger'])
    const mode = await optional('Surround mode', ['settings', 'get', 'global', 'encoded_surround_output'])
    const warnings = await optional('Recent audio warnings', ['logcat', '-d', '-v', 'brief', '-t', '300', 'AudioTrack:W', 'AudioFlinger:W', 'AudioPolicyManager:W', 'CCodec:W', 'MediaCodec:W', '*:S'])
    const apps = await enabledApps(serial)
    return { ...summarizeTvAudio({ uptime, audio, flinger, mode, warnings }), apps, unavailable, capturedAt: new Date().toISOString() }
  }
  async function restartApp(serial, id) {
    if (!TV_PLAYBACK_APPS.some(app => app.id === id)) throw new Error('Choose a listed playback app.')
    const report = await inspectTv(serial)
    if (!(await enabledApps(serial)).some(app => app.id === id)) throw new Error('This playback app is no longer enabled on the selected device.')
    const resolved = await shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LEANBACK_LAUNCHER', '-p', id])
    const component = resolved.split(/\r?\n/).find(line => line.startsWith(`${id}/`) && /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(line))
    if (!component) throw new Error('No TV launch activity was found. The app was left running.')
    await verifyTarget(serial, report.identity)
    await shell(serial, ['am', 'force-stop', '--user', '0', id])
    await shell(serial, ['am', 'start', '--user', '0', '-n', component])
    return 'Playback app restart requested. Resume the video and check whether the sound is in sync.'
  }
  async function restartDevice(serial) {
    const report = await inspectTv(serial)
    await verifyTarget(serial, report.identity)
    await checked(['-s', serial, 'reboot'])
    return 'Device restart requested. Playback will stop and debugging will disconnect briefly. Scan again after the TV or stick restarts.'
  }
  return { diagnose, restartApp, restartDevice }
}
