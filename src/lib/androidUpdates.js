import { allowedUpdatePackages, androidUpdateProfile, AUTOMATIC_UPDATE_KEY } from '../data/androidUpdateProfiles.js'

const locks = new Set()
const packageIds = text => new Set(text.split(/\r?\n/).filter(line => /^package:[\w.]+$/.test(line)).map(line => line.slice(8)))
const sameIdentity = (a, b) => ['manufacturer', 'brand', 'model', 'hardwareId'].every(key => a?.[key] === b?.[key])
const enabledStates = new Set(['0', '1', '3'])

export function createAndroidUpdateTools(runAdb) {
  async function shell(serial, args) {
    if (!serial) throw new Error('Connect and select an Android device first.')
    const result = await runAdb(['-s', serial, 'shell', ...args])
    if (result?.ok !== true || /error:|permission denial|securityexception|exception occurred|cannot disable|not allowed/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)) throw new Error(String(result?.stderr || result?.stdout || 'Update control failed.').trim().slice(0, 300))
    return String(result.stdout || '').trim()
  }
  const prop = (serial, key) => shell(serial, ['getprop', key])
  async function identity(serial) {
    const manufacturer = await prop(serial, 'ro.product.manufacturer')
    const brand = await prop(serial, 'ro.product.brand')
    const model = await prop(serial, 'ro.product.model')
    let hardwareId = await prop(serial, 'ro.serialno')
    if (!hardwareId || hardwareId === 'unknown') hardwareId = await prop(serial, 'ro.boot.serialno')
    if (!manufacturer || !brand || !model || !hardwareId || hardwareId === 'unknown') throw new Error('Cannot identify this device reliably. Update changes are unavailable.')
    return { manufacturer, brand, model, hardwareId }
  }
  async function guard(serial, id) {
    if (!sameIdentity(await identity(serial), id)) throw new Error('The selected device changed. Scan update controls again.')
    if (await shell(serial, ['am', 'get-current-user']) !== '0') throw new Error('Switch to the primary device profile before changing updates.')
  }
  async function preference(serial) {
    const value = await shell(serial, ['settings', 'get', 'global', AUTOMATIC_UPDATE_KEY])
    if (!['null', '0', '1'].includes(value)) throw new Error('The automatic-update preference is not recognized.')
    return value === 'null' ? null : value
  }
  async function packageState(serial, id) {
    const output = await shell(serial, ['dumpsys', 'package', id])
    const start = output.indexOf(`Package [${id}]`)
    const block = start < 0 ? '' : output.slice(start).split(/\n\s*Package \[/)[0]
    const user = block.match(/\bUser 0:([^]*?)(?=\n\s*User \d+:|$)/)?.[1] || ''
    const state = user.match(/\benabled=([0-4])\b/)?.[1]
    if (!/\binstalled=true\b/.test(user) || !/\bhidden=false\b/.test(user) || /\bsuspended=true\b/.test(user) || !enabledStates.has(state)) throw new Error(`Updater state cannot be safely changed: ${id}.`)
    return state
  }
  async function inspect(serial) {
    const id = await identity(serial)
    const sdkText = await prop(serial, 'ro.build.version.sdk')
    if (!/^\d+$/.test(sdkText) || Number(sdkText) < 21) throw new Error('This is not a supported Android connection.')
    const android = await prop(serial, 'ro.build.version.release')
    const ab = await prop(serial, 'ro.build.ab_update')
    const virtualAb = await prop(serial, 'ro.virtual_ab.enabled')
    const automatic = await preference(serial)
    const system = packageIds(await shell(serial, ['pm', 'list', 'packages', '-s', '--user', '0']))
    const packages = []
    const unavailable = []
    for (const pkg of allowedUpdatePackages(id).filter(pkg => system.has(pkg))) {
      try { packages.push({ id: pkg, state: await packageState(serial, pkg) }) }
      catch { unavailable.push(pkg) }
    }
    const automaticSupported = Number(sdkText) >= 26 && (ab === 'true' || virtualAb === 'true' || automatic !== null)
    return { identity: id, android, profile: androidUpdateProfile(id.manufacturer, id.brand), automatic, automaticSupported, packages, unavailable, checkedAt: new Date().toISOString() }
  }
  async function write(serial, change, value) {
    if (change.kind === 'preference') {
      await shell(serial, ['settings', value === null ? 'delete' : 'put', 'global', AUTOMATIC_UPDATE_KEY, ...(value === null ? [] : [value])])
      if (await preference(serial) !== value) throw new Error('The firmware did not keep the automatic-update preference.')
    } else {
      const command = { '0': 'default-state', '1': 'enable', '3': 'disable-user' }[value]
      await shell(serial, ['pm', command, '--user', '0', change.id])
      if (await packageState(serial, change.id) !== value) throw new Error(`Updater change did not take effect: ${change.id}.`)
    }
  }
  const read = (serial, change) => change.kind === 'preference' ? preference(serial) : packageState(serial, change.id)
  async function validate(serial, snapshot) {
    if (snapshot?.version !== 1 || !snapshot.identity || !Array.isArray(snapshot.changes) || !snapshot.changes.length) throw new Error('Invalid update-control backup.')
    await guard(serial, snapshot.identity)
    const report = await inspect(serial)
    const seen = new Set()
    for (const item of snapshot.changes) {
      const key = item.kind === 'preference' ? 'preference' : item.id
      if (seen.has(key)) throw new Error('Duplicate update-control backup entry.')
      seen.add(key)
      if (item.kind === 'preference') {
        if (!report.automaticSupported || ![null, '0', '1'].includes(item.before) || !['0', '1'].includes(item.after)) throw new Error('Invalid update preference backup.')
      } else if (item.kind !== 'package' || !allowedUpdatePackages(report.identity).includes(item.id) || !report.packages.some(pkg => pkg.id === item.id) || !enabledStates.has(item.before) || !enabledStates.has(item.after)) throw new Error('Invalid updater app backup.')
      const current = await read(serial, item)
      if (current !== item.before && current !== item.after) throw new Error('Update settings changed outside this tool. Scan and review before restoring.')
    }
  }
  async function restoreChanges(serial, snapshot) {
    await validate(serial, snapshot)
    for (const item of [...snapshot.changes].reverse()) {
      await guard(serial, snapshot.identity)
      const current = await read(serial, item)
      if (current !== item.before && current !== item.after) throw new Error('Update settings changed during restore.')
      if (current !== item.before) await write(serial, item, item.before)
    }
  }
  async function exclusive(serial, task) {
    if (locks.has(serial)) throw new Error('An update-control change is already running for this device.')
    locks.add(serial)
    try { return await task() } finally { locks.delete(serial) }
  }
  async function apply(serial, mode, disableUpdater, saveBackup, reviewedIdentity) {
    return exclusive(serial, async () => {
      if (!['block', 'allow'].includes(mode)) throw new Error('Choose Block or Allow updates.')
      const report = await inspect(serial)
      if (!sameIdentity(report.identity, reviewedIdentity)) throw new Error('The device differs from the reviewed scan. Scan update controls again.')
      if (typeof disableUpdater !== 'boolean') throw new Error('Choose whether to include detected updater apps.')
      await guard(serial, report.identity)
      const changes = []
      const desired = mode === 'block' ? '1' : '0'
      if (report.automaticSupported && report.automatic !== desired) changes.push({ kind: 'preference', before: report.automatic, after: desired })
      if (disableUpdater) for (const pkg of report.packages) {
        const after = mode === 'block' ? '3' : '1'
        if (mode === 'block' ? pkg.state !== '3' : pkg.state === '3') changes.push({ kind: 'package', id: pkg.id, before: pkg.state, after })
      }
      if (!report.automaticSupported && (!disableUpdater || !report.packages.length)) throw new Error('No supported update-control method was detected on this firmware.')
      if (!changes.length) return { unchanged: true, report }
      const snapshot = { version: 1, identity: report.identity, changes, createdAt: new Date().toISOString() }
      if (typeof saveBackup !== 'function') throw new Error('A restore backup is required before changing updates.')
      await saveBackup(snapshot)
      await validate(serial, snapshot)
      for (const item of changes) if (await read(serial, item) !== item.before) throw new Error('Update state changed during backup. No changes made.')
      try {
        for (const item of changes) {
          await guard(serial, report.identity)
          if (await read(serial, item) !== item.before) throw new Error('Update settings changed while applying. Operation stopped.')
          await write(serial, item, item.after)
        }
      } catch (error) {
        try { await restoreChanges(serial, snapshot) }
        catch (rollback) { throw new Error(`${error.message} Restore incomplete: ${rollback.message} Keep the backup and reconnect this device.`) }
        throw new Error(`${error.message} Previous update settings restored.`)
      }
      try { return { snapshot, report: await inspect(serial) } }
      catch { throw new Error('Update settings were changed and verified, but the refreshed scan failed. The Undo backup is kept; reconnect and scan again.') }
    })
  }
  async function restore(serial, snapshot) { return exclusive(serial, () => restoreChanges(serial, snapshot)) }
  async function openSettings(serial) {
    await identity(serial)
    try { await shell(serial, ['am', 'start', '-a', 'android.settings.SYSTEM_UPDATE_SETTINGS']) }
    catch {
      await shell(serial, ['am', 'start', '-a', 'android.settings.SETTINGS'])
      return 'Opened Settings instead. Find System update under System or About on this firmware.'
    }
    return 'System update settings requested on the device. Menu availability depends on firmware.'
  }
  return { inspect, apply, restore, openSettings }
}
