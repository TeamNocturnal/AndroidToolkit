export function parseConnectedDevices(output) {
  const lines = String(output || '').split(/\r?\n/)
  const header = lines.findIndex(line => line.trim() === 'List of devices attached')
  if (header < 0) throw new Error('Could not read the connected-device list. Check ADB and try again.')
  const devices = new Map()
  for (const line of lines.slice(header + 1)) {
    const [serial, state, ...details] = line.trim().split(/\s+/)
    if (!serial || serial.startsWith('*')) continue
    const status = state === 'no' && details[0] === 'permissions' ? 'no_permissions' : state
    if (!['device', 'unauthorized', 'offline', 'recovery', 'sideload', 'bootloader', 'no_permissions'].includes(status)) continue
    const fields = Object.fromEntries(details.filter(value => value.includes(':')).map(value => {
      const split = value.indexOf(':')
      return [value.slice(0, split), value.slice(split + 1)]
    }))
    devices.set(serial, {
      serial, status, model: fields.model?.replaceAll('_', ' ') || 'Unknown Device',
      product: fields.product || '', transport_id: fields.transport_id || null,
      transport: serial.startsWith('emulator-') ? 'Emulator' : serial.includes(':') || serial.includes('._tcp') ? 'Wi-Fi' : 'USB',
    })
  }
  return [...devices.values()]
}

export async function discoverConnectedDevices(runAdb) {
  const result = await runAdb(['devices', '-l'])
  if (result?.ok !== true) throw new Error(String(result?.stderr || 'Could not refresh connected devices.').trim())
  return parseConnectedDevices(result.stdout)
}

export async function inspectConnectedDevices(devices, inspect, { timeoutMs = 15000 } = {}) {
  return Promise.all(devices.map(async device => {
    if (device.status !== 'device') return { device, report: null, error: device.status === 'unauthorized' ? 'Allow USB/Wi-Fi debugging on this device, then scan again.' : `Device is ${device.status.replaceAll('_', ' ')}. Reconnect it in normal Android mode, then scan again.` }
    let timer
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Device did not respond in time. Reconnect it and scan again.')), timeoutMs) })
      return { device, report: await Promise.race([inspect(device.serial), timeout]), error: null }
    }
    catch (error) { return { device, report: null, error: String(error.message || error).slice(0, 300) } }
    finally { clearTimeout(timer) }
  }))
}
