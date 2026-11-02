export const TV_REMOTE_KEYS = {
  up: 19, down: 20, left: 21, right: 22, select: 23,
  home: 3, back: 4, playPause: 85, volumeDown: 25, volumeUp: 24, mute: 164,
}

export const TV_SETTINGS = {
  settings: { label: 'All settings', action: 'android.settings.SETTINGS' },
  network: { label: 'Network', action: 'android.settings.WIFI_SETTINGS' },
  display: { label: 'Display', action: 'android.settings.DISPLAY_SETTINGS' },
  sound: { label: 'Sound', action: 'android.settings.SOUND_SETTINGS' },
  apps: { label: 'Apps', action: 'android.settings.APPLICATION_SETTINGS' },
  bluetooth: { label: 'Bluetooth', action: 'android.settings.BLUETOOTH_SETTINGS' },
  accessibility: { label: 'Accessibility', action: 'android.settings.ACCESSIBILITY_SETTINGS' },
  storage: { label: 'Storage', action: 'android.settings.INTERNAL_STORAGE_SETTINGS' },
  about: { label: 'About', action: 'android.settings.DEVICE_INFO_SETTINGS' },
}

export function parseNetworkCheck(addresses, routes, mode, hostname) {
  return {
    addresses: addresses.split(/\r?\n/).map(line => {
      const match = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\//)
      return match && match[1] !== 'lo' ? `${match[1]}: ${match[2]}` : null
    }).filter(Boolean),
    gateway: routes.match(/^default via ([\d.]+)(?: dev (\S+))?/m)?.[1] || null,
    dnsMode: { off: 'Off', opportunistic: 'Automatic', hostname: 'Provider hostname' }[mode] || 'Not reported',
    dnsHostname: mode === 'hostname' && hostname && hostname !== 'null' ? hostname : null,
  }
}

export function createTvDeviceTools(runAdb, inspectTv) {
  async function checked(serial, args) {
    if (!serial) throw new Error('Connect and select a TV first.')
    const result = await runAdb(['-s', serial, 'shell', ...args])
    if (result?.ok !== true || /error:|permission denial|securityexception|exception occurred/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)) {
      throw new Error(String(result?.stderr || result?.stdout || 'Device command failed.').trim().slice(0, 240))
    }
    return String(result.stdout || '').trim()
  }
  async function optional(serial, name, args, unavailable) {
    try { return await checked(serial, args) }
    catch { unavailable.push(name); return '' }
  }
  async function verify(serial) {
    const features = await checked(serial, ['pm', 'list', 'features'])
    const characteristics = await checked(serial, ['getprop', 'ro.build.characteristics'])
    if (!/^feature:android\.(?:hardware\.type\.television|software\.leanback(?:_only)?)(?:=|$)/m.test(features) && !characteristics.split(',').includes('tv')) {
      throw new Error('Select an Android TV, box, or streaming stick.')
    }
  }
  async function health(serial) {
    const report = await inspectTv(serial)
    const unavailable = []
    const uptime = await optional(serial, 'Uptime', ['cat', '/proc/uptime'], unavailable)
    const patch = await optional(serial, 'Security patch', ['getprop', 'ro.build.version.security_patch'], unavailable)
    const seconds = Number(uptime.split(/\s+/)[0])
    return { model: report.identity.model, manufacturer: report.identity.manufacturer, android: report.android,
      sdk: report.sdk, totalKiB: report.totalKiB, availableKiB: report.availableKiB,
      freeStorageKiB: report.freeStorageKiB, uptimeHours: uptime && Number.isFinite(seconds) ? seconds / 3600 : null,
      securityPatch: patch || null, unavailable, capturedAt: new Date().toISOString() }
  }
  async function network(serial) {
    await verify(serial)
    const unavailable = []
    const addresses = await optional(serial, 'IP addresses', ['ip', '-o', '-4', 'addr', 'show'], unavailable)
    const routes = await optional(serial, 'Gateway', ['ip', 'route', 'show', 'table', 'all'], unavailable)
    const mode = await optional(serial, 'Private DNS mode', ['settings', 'get', 'global', 'private_dns_mode'], unavailable)
    const hostname = await optional(serial, 'Private DNS hostname', ['settings', 'get', 'global', 'private_dns_specifier'], unavailable)
    return { ...parseNetworkCheck(addresses, routes, mode, hostname), unavailable, capturedAt: new Date().toISOString() }
  }
  async function ping(serial) {
    await verify(serial)
    const result = await runAdb(['-s', serial, 'shell', 'ping', '-c', '3', '-W', '2', '1.1.1.1'])
    const output = String(result?.stdout || '')
    const loss = output.match(/([\d.]+)% packet loss/)
    if (!loss || /permission denied|not found/i.test(`${output}\n${result?.stderr || ''}`)) throw new Error('Ping is unavailable or blocked on this firmware/network.')
    const latency = output.match(/(?:rtt|round-trip)[^=]*=\s*[\d.]+\/([\d.]+)\//)
    return { lossPercent: Number(loss[1]), averageMs: latency ? Number(latency[1]) : null }
  }
  async function display(serial) {
    await verify(serial)
    const unavailable = []
    const size = await optional(serial, 'Interface size', ['wm', 'size'], unavailable)
    const density = await optional(serial, 'Interface density', ['wm', 'density'], unavailable)
    return { physicalSize: size.match(/Physical size:\s*(\d+x\d+)/)?.[1] || null,
      overrideSize: size.match(/Override size:\s*(\d+x\d+)/)?.[1] || null,
      physicalDensity: density.match(/Physical density:\s*(\d+)/)?.[1] || null,
      overrideDensity: density.match(/Override density:\s*(\d+)/)?.[1] || null, unavailable }
  }
  async function remote(serial, key) {
    if (!Object.hasOwn(TV_REMOTE_KEYS, key)) throw new Error('Unknown remote button.')
    await verify(serial)
    await checked(serial, ['input', 'keyevent', String(TV_REMOTE_KEYS[key])])
    return 'Button sent. Device and HDMI audio controls may handle volume differently.'
  }
  async function settings(serial, name) {
    if (!Object.hasOwn(TV_SETTINGS, name)) throw new Error('Unknown settings shortcut.')
    await verify(serial)
    await checked(serial, ['am', 'start', '-a', TV_SETTINGS[name].action])
    return 'Settings requested on the TV. If this page is unavailable on your firmware, open All settings.'
  }
  async function resize(serial, size) {
    const sizes = { '4k': '3840x2160', '1080p': '1920x1080', reset: 'reset' }
    if (!Object.hasOwn(sizes, size)) throw new Error('Choose a listed interface size.')
    await verify(serial)
    await checked(serial, ['wm', 'size', sizes[size]])
    const result = await display(serial)
    if (result.unavailable.includes('Interface size') || (size === 'reset' ? result.overrideSize !== null : (result.overrideSize || result.physicalSize) !== sizes[size])) throw new Error('The interface size could not be verified. Check the TV before trying again.')
    return size === 'reset' ? 'Interface size override removed.' : 'Interface size read back. HDMI and streaming resolution are unchanged.'
  }
  async function closeBackground(serial) {
    await verify(serial)
    await checked(serial, ['am', 'kill-all'])
    return 'Background cleanup requested. Android decides which eligible processes to close; apps may restart.'
  }
  return { health, network, ping, display, remote, settings, verify, resize, closeBackground }
}
