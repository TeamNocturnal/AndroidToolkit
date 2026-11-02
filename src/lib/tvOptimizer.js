import { TV_OPTIONAL_APPS } from '../data/tvOptimizationCatalog.js'

export const ANIMATION_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
const optionalIds = new Set(TV_OPTIONAL_APPS.map(app => app.id))
const packageLines = text => new Set(text.split(/\r?\n/).filter(line => /^package:[a-zA-Z0-9_.]+$/.test(line)).map(line => line.slice(8)))

function settingValue(value) {
  const raw = String(value).trim()
  if (raw === 'null') return null
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw))) {
    throw new Error('Unexpected animation setting; no changes made.')
  }
  return raw
}

export function createTvOptimizer(runAdb) {
  async function shell(serial, args) {
    if (!serial) throw new Error('Connect a device first.')
    const result = await runAdb(['-s', serial, 'shell', ...args])
    if (result?.ok !== true || /permission denial|securityexception|error:|exception occurred/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)) {
      throw new Error((result?.stderr || result?.stdout || 'Device command failed.').trim())
    }
    return String(result.stdout || '').trim()
  }
  const prop = (serial, name) => shell(serial, ['getprop', name])
  async function identity(serial) {
    const model = await prop(serial, 'ro.product.model')
    const manufacturer = await prop(serial, 'ro.product.manufacturer')
    let hardwareId = await prop(serial, 'ro.serialno')
    if (!hardwareId || hardwareId === 'unknown') hardwareId = await prop(serial, 'ro.boot.serialno')
    if (!model || !manufacturer || !hardwareId || hardwareId === 'unknown') {
      throw new Error('Cannot identify this device reliably. Optimization is unavailable.')
    }
    return { model, manufacturer, hardwareId }
  }
  function sameDevice(a, b) {
    return a?.model === b?.model && a?.manufacturer === b?.manufacturer && a?.hardwareId === b?.hardwareId
  }
  async function readSettings(serial) {
    const values = {}
    for (const key of ANIMATION_KEYS) values[key] = settingValue(await shell(serial, ['settings', 'get', 'global', key]))
    return values
  }
  async function inspect(serial) {
    const id = await identity(serial)
    const features = await shell(serial, ['pm', 'list', 'features'])
    const characteristics = await prop(serial, 'ro.build.characteristics')
    if (!features.split(/\r?\n/).some(line => /^feature:android\.(hardware\.type\.television|software\.leanback|software\.leanback_only)(?:=|$)/.test(line)) && !characteristics.split(',').includes('tv')) {
      throw new Error('Select an Android TV or Google TV device. This preset is for televisions and streaming boxes.')
    }
    const profile = /sony/i.test(id.manufacturer) ? 'Sony BRAVIA' : /onn/i.test(`${id.manufacturer} ${id.model}`) ? 'ONN' : 'Android TV'
    const android = await prop(serial, 'ro.build.version.release')
    const sdk = await prop(serial, 'ro.build.version.sdk')
    if (!/^\d+$/.test(sdk) || Number(sdk) < 21) throw new Error('This device does not expose a supported Android TV platform.')
    const memory = await shell(serial, ['cat', '/proc/meminfo'])
    const storage = await shell(serial, ['df', '-k', '/data'])
    const display = await shell(serial, ['wm', 'size'])
    const settings = await readSettings(serial)
    const totalKiB = Number(memory.match(/^MemTotal:\s+(\d+)/m)?.[1]) || null
    const availableKiB = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) || null
    const disk = storage.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(cols => /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[3]))
    const demoMode = await shell(serial, ['settings', 'get', 'global', 'device_demo_mode'])
    let packageHelp = ''
    try {
      const help = await runAdb(['-s', serial, 'shell', 'pm', 'help'])
      // Some Android builds return a nonzero exit status for valid help output.
      if (help?.ok === true || /^Package manager \(package\) commands:/m.test(help?.stdout || '') && !String(help?.stderr || '').trim()) packageHelp = String(help.stdout || '')
    } catch {
      // Unsupported help makes optional cache cleanup unavailable.
    }
    const installed = packageLines(await shell(serial, ['pm', 'list', 'packages', '--user', '0']))
    const preloaded = packageLines(await shell(serial, ['pm', 'list', 'packages', '-s', '--user', '0']))
    const enabled = packageLines(await shell(serial, ['pm', 'list', 'packages', '-e', '--user', '0']))
    const apps = TV_OPTIONAL_APPS.filter(app => installed.has(app.id)).map(app => ({ ...app, preloaded: preloaded.has(app.id), enabled: enabled.has(app.id) }))
    const cacheSupported = /^\s*clear\s+.*\[--cache-only\].*PACKAGE/m.test(packageHelp) && Number(sdk) >= 33
    return { identity: id, profile, android, sdk, totalKiB, availableKiB, freeStorageKiB: disk ? Number(disk[3]) : null, display, settings, demoMode: ['0', '1'].includes(demoMode) ? demoMode : null, cacheSupported, apps, scannedAt: new Date().toISOString() }
  }
  async function ownerOnly(serial) {
    if (await shell(serial, ['am', 'get-current-user']) !== '0') throw new Error('Switch the TV to its primary owner profile before optimizing or restoring.')
  }
  async function packageState(serial, pkg) {
    if (!optionalIds.has(pkg)) throw new Error('This app is protected or is not in the optional-app catalog.')
    const output = await shell(serial, ['dumpsys', 'package', pkg])
    const start = output.indexOf(`Package [${pkg}]`)
    const block = start < 0 ? '' : output.slice(start).split(/\n\s*Package \[/)[0]
    const user = block.match(/\bUser 0:([^]*?)(?=\n\s*User \d+:|$)/)?.[1] || ''
    const state = user.match(/\benabled=([0-4])\b/)?.[1]
    if (!/\binstalled=true\b/.test(user) || !/\bhidden=false\b/.test(user) || /\bsuspended=true\b/.test(user) || state == null) throw new Error(`Cannot verify the owner-profile state of ${pkg}.`)
    return state
  }
  async function writePackage(serial, pkg, state) {
    const command = { '0': 'default-state', '1': 'enable', '3': 'disable-user' }[state]
    if (!command) throw new Error('Unsupported app state.')
    await shell(serial, ['pm', command, '--user', '0', pkg])
    if (await packageState(serial, pkg) !== state) throw new Error(`Could not verify app state: ${pkg}.`)
  }
  async function writeSetting(serial, key, value) {
    await shell(serial, value === null ? ['settings', 'delete', 'global', key] : ['settings', 'put', 'global', key, value])
    const actual = settingValue(await shell(serial, ['settings', 'get', 'global', key]))
    if (actual !== value && !(actual !== null && value !== null && Number(actual) === Number(value))) {
      throw new Error(`Could not verify ${key}.`)
    }
  }
  function validateSnapshot(snapshot) {
    if (![1, 2].includes(snapshot?.version) || !Array.isArray(snapshot.changes) || snapshot.changes.length > ANIMATION_KEYS.length || (snapshot.version === 1 && !snapshot.changes.length)) throw new Error('Invalid optimization backup.')
    const keys = new Set()
    if (snapshot.version === 1 && snapshot.packages != null) throw new Error('Invalid optimization backup.')
    for (const change of snapshot.changes) {
      if (!ANIMATION_KEYS.includes(change.key) || keys.has(change.key) || typeof change.after !== 'string' || !['0', '0.5'].includes(change.after)) throw new Error('Invalid optimization backup.')
      keys.add(change.key)
      if (change.before !== null && typeof change.before !== 'string') throw new Error('Invalid original setting.')
      settingValue(change.before === null ? 'null' : change.before)
    }
    if (snapshot.version === 2) {
      if (!Array.isArray(snapshot.packages) || snapshot.packages.length > TV_OPTIONAL_APPS.length || !snapshot.changes.length && !snapshot.packages.length) throw new Error('Invalid optimization backup.')
      const seen = new Set()
      for (const item of snapshot.packages) {
        if (!optionalIds.has(item.id) || seen.has(item.id) || !['0', '1'].includes(item.before) || item.after !== '3') throw new Error('Invalid app backup.')
        seen.add(item.id)
      }
    }
  }
  async function restore(serial, snapshot) {
    validateSnapshot(snapshot)
    if (!sameDevice(await identity(serial), snapshot.identity)) throw new Error('This backup belongs to a different device.')
    await ownerOnly(serial)
    const current = await readSettings(serial)
    for (const change of snapshot.changes) {
      const actual = current[change.key]
      const matches = expected => actual === expected || (actual !== null && expected !== null && Number(actual) === Number(expected))
      if (!matches(change.before) && !matches(change.after)) throw new Error('Animation settings changed outside this optimizer. Rescan and review before restoring.')
    }
    for (const item of snapshot.packages || []) {
      const state = await packageState(serial, item.id)
      if (state !== item.before && state !== item.after) throw new Error('App state changed outside this optimizer. Review the app before restoring.')
    }
    for (const item of [...(snapshot.packages || [])].reverse()) await writePackage(serial, item.id, item.before)
    for (const change of [...snapshot.changes].reverse()) await writeSetting(serial, change.key, change.before)
  }
  async function optimize(serial, options, saveSnapshot) {
    const config = typeof options === 'string' ? { animations: true, scale: options } : options
    if (!config || typeof config !== 'object' || !['0.5', '0'].includes(config.scale || '0.5')) throw new Error('Unsupported animation preset.')
    const scale = config.scale || '0.5'
    const disabledIds = [...new Set(config.disablePackages || [])]
    const cacheIds = [...new Set(config.cachePackages || [])]
    if ([...disabledIds, ...cacheIds].some(id => !optionalIds.has(id))) throw new Error('Only listed optional apps can be changed.')
    const report = await inspect(serial)
    await ownerOnly(serial)
    if (report.demoMode === '1') throw new Error('Android reports retail demo mode. Exit it through the manufacturer’s settings before optimizing. No changes made.')
    const changes = config.animations === false ? [] : ANIMATION_KEYS.flatMap(key => {
      const before = report.settings[key]
      // Preserve animations already faster than the chosen preset, including off.
      return (before === null ? 1 : Number(before)) > Number(scale) ? [{ key, before, after: scale }] : []
    })
    const packages = []
    for (const id of disabledIds) {
      const app = report.apps.find(app => app.id === id)
      if (!app?.preloaded || !app.enabled) throw new Error('The app selection changed. Scan again before disabling bundled apps.')
      const before = await packageState(serial, id)
      if (!['0', '1'].includes(before)) throw new Error('The app is already disabled or has an unsupported state. Scan again.')
      packages.push({ id, before, after: '3' })
    }
    if (cacheIds.length && !report.cacheSupported) throw new Error('Cache-only cleanup is unavailable on this firmware. Use the TV’s Settings → Apps → Clear cache.')
    for (const id of cacheIds) {
      if (!report.apps.some(app => app.id === id && app.enabled) || !['0', '1'].includes(await packageState(serial, id))) throw new Error('The cache selection changed. Scan again.')
    }
    const snapshot = { version: 2, serial, identity: report.identity, createdAt: new Date().toISOString(), changes, packages }
    const reversibleCount = changes.length + packages.length
    // A durable backup must succeed before any write reaches the TV.
    if (reversibleCount) await saveSnapshot(snapshot)
    if (!sameDevice(await identity(serial), snapshot.identity)) throw new Error('Device changed after backup. No settings were written.')
    await ownerOnly(serial)
    try {
      for (const change of changes) await writeSetting(serial, change.key, change.after)
      for (const item of packages) await writePackage(serial, item.id, item.after)
    } catch (error) {
      try {
        await restore(serial, snapshot)
      } catch (rollbackError) {
        throw new Error(`${error.message} Automatic restore incomplete: ${rollbackError.message} Keep the backup and reconnect this device.`)
      }
      throw new Error(`${error.message} Original settings restored.`)
    }
    const cacheResults = []
    for (const id of cacheIds) {
      try {
        if (!sameDevice(await identity(serial), report.identity)) throw new Error('Device changed; cleanup stopped.')
        await ownerOnly(serial)
        const processes = await shell(serial, ['ps', '-A'])
        if (!/\bPID\b/.test(processes.split(/\r?\n/)[0] || '')) throw new Error('Cannot verify running apps; cache cleanup stopped.')
        if (processes.split(/\r?\n/).some(line => {
          const name = line.trim().split(/\s+/).at(-1)
          return name === id || name?.startsWith(`${id}:`)
        })) {
          cacheResults.push({ id, ok: false, skipped: true, error: 'App is running; skipped to protect playback.' })
          continue
        }
        const result = await shell(serial, ['pm', 'clear', '--user', '0', '--cache-only', id])
        if (result !== 'Success') throw new Error('Cache cleanup was not confirmed.')
        cacheResults.push({ id, ok: true })
      } catch (error) {
        cacheResults.push({ id, ok: false, error: error.message })
        break
      }
    }
    return { report: { ...report, settings: await readSettings(serial), apps: report.apps.map(app => packages.some(item => item.id === app.id) ? { ...app, enabled: false } : app) }, changed: reversibleCount, cacheResults }
  }
  return { inspect, optimize, restore }
}
