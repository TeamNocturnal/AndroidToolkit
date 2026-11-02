import { isDnsHostname, tvDnsTarget } from '../data/tvDnsProviders.js'

const keys = { mode: 'private_dns_mode', host: 'private_dns_specifier' }
const same = (a, b) => a.mode === b.mode && a.host === b.host
function valid(state) {
  return state && [null, 'off', 'opportunistic', 'hostname'].includes(state.mode)
    && (state.host === null || isDnsHostname(state.host))
    && (state.mode !== 'hostname' || !!state.host)
}

export function createTvDnsTools(runAdb, verifyTv) {
  async function shell(serial, args) {
    if (!serial) throw new Error('Connect a TV first.')
    const result = await runAdb(['-s', serial, 'shell', ...args])
    if (result?.ok !== true || /error:|permission denial|securityexception|exception occurred/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)) throw new Error(String(result?.stderr || result?.stdout || 'DNS command failed.').trim().slice(0, 300))
    return String(result.stdout || '').trim()
  }
  async function identity(serial) {
    await verifyTv(serial)
    const sdk = Number(await shell(serial, ['getprop', 'ro.build.version.sdk']))
    if (!Number.isInteger(sdk) || sdk < 28) throw new Error('Private DNS requires Android 9 or later and compatible firmware.')
    let hardwareId = await shell(serial, ['getprop', 'ro.serialno'])
    if (!hardwareId || hardwareId === 'unknown') hardwareId = await shell(serial, ['getprop', 'ro.boot.serialno'])
    if (!hardwareId || hardwareId === 'unknown') throw new Error('Cannot identify this TV reliably.')
    return hardwareId
  }
  async function readState(serial) {
    const state = {}
    for (const [name, key] of Object.entries(keys)) {
      const raw = await shell(serial, ['settings', 'get', 'global', key])
      state[name] = raw === 'null' ? null : raw
    }
    if (!valid(state)) throw new Error('The current DNS settings are not recognized; no changes made.')
    return state
  }
  async function inspect(serial) {
    const hardwareId = await identity(serial)
    return { hardwareId, state: await readState(serial) }
  }
  async function guard(serial, hardwareId) {
    if (await identity(serial) !== hardwareId) throw new Error('The selected device changed. Check DNS again.')
    if (await shell(serial, ['am', 'get-current-user']) !== '0') throw new Error('Switch to the primary TV profile before changing DNS.')
  }
  async function write(serial, state) {
    const order = state.mode === 'hostname' ? ['host', 'mode'] : ['mode', 'host']
    for (const name of order) {
      await shell(serial, ['settings', state[name] === null ? 'delete' : 'put', 'global', keys[name], ...(state[name] === null ? [] : [state[name]])])
    }
    if (!same(await readState(serial), state)) throw new Error('The firmware did not keep the requested DNS settings.')
  }
  async function apply(serial, provider, customHost, saveBackup) {
    const after = tvDnsTarget(provider, customHost)
    const { hardwareId, state: before } = await inspect(serial)
    await guard(serial, hardwareId)
    if (same(before, after)) return { unchanged: true }
    const backup = { version: 1, hardwareId, before, after, createdAt: new Date().toISOString() }
    if (typeof saveBackup !== 'function') throw new Error('A restore backup is required before changing DNS.')
    await saveBackup(backup)
    await guard(serial, hardwareId)
    if (!same(await readState(serial), before)) throw new Error('DNS changed while saving the backup. Check DNS again.')
    try { await write(serial, after) }
    catch (error) {
      try { await guard(serial, hardwareId); await write(serial, before) }
      catch { throw new Error(`${error.message} Automatic rollback could not finish. Use Automatic DNS on the TV if internet access stops.`) }
      throw new Error(`${error.message} Previous DNS settings restored.`)
    }
    return { backup }
  }
  async function restore(serial, backup) {
    if (backup?.version !== 1 || !backup.hardwareId || !valid(backup.before) || !valid(backup.after)) throw new Error('The DNS restore backup is invalid.')
    await guard(serial, backup.hardwareId)
    const current = await readState(serial)
    if (same(current, backup.before)) return
    if (!same(current, backup.after)) throw new Error('DNS has changed since this backup. Check the current settings before restoring.')
    try { await write(serial, backup.before) }
    catch (error) {
      try { await guard(serial, backup.hardwareId); await write(serial, current) }
      catch { throw new Error(`${error.message} Restore rollback could not finish. Check Private DNS on the TV.`) }
      throw new Error(`${error.message} DNS was returned to the setting used before Restore.`)
    }
  }
  return { inspect, apply, restore }
}
