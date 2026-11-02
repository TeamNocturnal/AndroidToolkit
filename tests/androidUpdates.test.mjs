import test from 'node:test'
import assert from 'node:assert/strict'
import { createAndroidUpdateTools } from '../src/lib/androidUpdates.js'
import { androidUpdateProfile, AUTOMATIC_UPDATE_KEY } from '../src/data/androidUpdateProfiles.js'

function fixture({ manufacturer = 'samsung', brand = manufacturer, sdk = '34', ab = 'true', owner = '0', initial = null, packages = { 'com.wssyncmldm': '0', 'com.sec.android.soagent': '1' }, failPackage = '', ignored = false, hardware = 'device-id' } = {}) {
  const id = { manufacturer, brand, model: 'Test device', hardwareId: hardware }
  const states = { ...packages }
  let automatic = initial
  let fail = failPackage
  const calls = []
  const run = async args => {
    assert.deepEqual(args.slice(0, 3), ['-s', 'device:5555', 'shell'])
    const command = args.slice(3)
    calls.push(command)
    const [type, operation, , key, value] = command
    let stdout = ''
    if (type === 'getprop') stdout = {
      'ro.product.manufacturer': id.manufacturer, 'ro.product.brand': id.brand,
      'ro.product.model': id.model, 'ro.serialno': id.hardwareId, 'ro.boot.serialno': id.hardwareId,
      'ro.build.version.sdk': sdk, 'ro.build.version.release': '14',
      'ro.build.ab_update': ab, 'ro.virtual_ab.enabled': 'false',
    }[operation] || ''
    if (type === 'am') stdout = owner
    if (type === 'settings') {
      assert.equal(key, AUTOMATIC_UPDATE_KEY)
      if (operation === 'get') stdout = automatic === null ? 'null' : automatic
      else if (!ignored) automatic = operation === 'delete' ? null : value
    }
    if (type === 'pm') {
      if (operation === 'list') stdout = Object.keys(states).map(pkg => `package:${pkg}`).join('\n')
      else {
        const pkg = command.at(-1)
        assert.ok(Object.hasOwn(states, pkg))
        if (pkg === fail) { fail = ''; return { ok: true, stdout: 'Error: Cannot disable a protected package' } }
        if (!ignored) states[pkg] = { 'disable-user': '3', enable: '1', 'default-state': '0' }[operation]
      }
    }
    if (type === 'dumpsys') {
      const pkg = command[2]
      stdout = `Package [${pkg}] (123):\n  User 0: installed=true hidden=false suspended=false enabled=${states[pkg]}\n`
    }
    return { ok: true, stdout, stderr: '' }
  }
  const writes = () => calls.filter(command => command[0] === 'settings' && command[1] !== 'get' || command[0] === 'pm' && command[1] !== 'list')
  return { id, states, calls, run, writes, tools: createAndroidUpdateTools(run), get automatic() { return automatic }, set automatic(value) { automatic = value } }
}

test('inspection is read-only and matches updater apps to the detected manufacturer', async () => {
  const f = fixture({ packages: { 'com.wssyncmldm': '0', 'com.amazon.device.software.ota': '0', 'com.google.android.gms': '0' } })
  const report = await f.tools.inspect('device:5555')
  assert.equal(report.profile.id, 'samsung')
  assert.deepEqual(report.packages.map(pkg => pkg.id), ['com.wssyncmldm'])
  assert.equal(f.writes().length, 0)
})

test('Google-based ONN exposes the automatic preference without disabling Google services or notifications', async () => {
  const f = fixture({ manufacturer: 'onn', packages: { 'com.google.android.gms': '0', 'com.android.vending': '0', 'com.onn.updatenotification': '0' } })
  const report = await f.tools.inspect('device:5555')
  assert.equal(report.profile.id, 'onn')
  assert.equal(report.automaticSupported, true)
  assert.deepEqual(report.packages, [])
  await f.tools.apply('device:5555', 'block', true, async () => {}, f.id)
  assert.equal(f.automatic, '1')
  assert.ok(f.writes().every(command => command[0] === 'settings'))
})

test('brand catalog has generic fallbacks and never guesses an updater by its name', async () => {
  for (const brand of ['amazon', 'samsung', 'motorola', 'oneplus', 'oppo', 'realme', 'vivo', 'asus', 'sony', 'tcl', 'alcatel', 'lge', 'xiaomi', 'huawei', 'honor', 'onn', 'nvidia', 'google', 'hisense', 'philips', 'lenovo', 'nokia', 'zte', 'oculus', 'Unknown OEM']) {
    assert.ok(androidUpdateProfile(brand, brand).label)
    const f = fixture({ manufacturer: brand, packages: { 'com.random.updater': '0' } })
    assert.deepEqual((await f.tools.inspect('device:5555')).packages, [])
  }
})

test('MIUI updater stays protected even when installed', async () => {
  const f = fixture({ manufacturer: 'Xiaomi', packages: { 'com.android.updater': '0' } })
  const report = await f.tools.inspect('device:5555')
  assert.equal(report.packages.length, 0)
  assert.match(report.profile.note, /unsafe/)
  await f.tools.apply('device:5555', 'block', true, async () => {}, f.id)
  assert.equal(f.states['com.android.updater'], '0')
})

test('backup precedes writes; blocking and Undo preserve exact package states and unset preference', async () => {
  const f = fixture()
  let saved
  await f.tools.apply('device:5555', 'block', true, async snapshot => { assert.equal(f.writes().length, 0); saved = snapshot }, f.id)
  assert.equal(f.automatic, '1')
  assert.deepEqual(f.states, { 'com.wssyncmldm': '3', 'com.sec.android.soagent': '3' })
  await f.tools.restore('device:5555', saved)
  assert.equal(f.automatic, null)
  assert.deepEqual(f.states, { 'com.wssyncmldm': '0', 'com.sec.android.soagent': '1' })
})

test('Allow reenables detected user-disabled updaters and Undo returns the prior state', async () => {
  const f = fixture({ initial: '1', packages: { 'com.wssyncmldm': '3', 'com.sec.android.soagent': '0' } })
  let saved
  await f.tools.apply('device:5555', 'allow', true, async snapshot => { saved = snapshot }, f.id)
  assert.equal(f.automatic, '0')
  assert.equal(f.states['com.wssyncmldm'], '1')
  assert.equal(f.states['com.sec.android.soagent'], '0')
  await f.tools.restore('device:5555', saved)
  assert.equal(f.automatic, '1')
  assert.equal(f.states['com.wssyncmldm'], '3')
})

test('a package-only method works without inventing an automatic-update setting', async () => {
  const f = fixture({ sdk: '25', ab: 'false', packages: { 'com.wssyncmldm': '0' } })
  await f.tools.apply('device:5555', 'block', true, async () => {}, f.id)
  assert.equal(f.states['com.wssyncmldm'], '3')
  assert.equal(f.automatic, null)
  assert.ok(!f.writes().some(command => command[0] === 'settings'))
})

test('unsupported firmware refuses a block rather than reporting success', async () => {
  const f = fixture({ manufacturer: 'Unknown', ab: 'false', packages: {} })
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => {}, f.id), /No supported/)
  assert.equal(f.writes().length, 0)
})

test('backup failure blocks all update changes', async () => {
  const f = fixture()
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => { throw new Error('disk full') }, f.id), /disk full/)
  assert.equal(f.writes().length, 0)
})

test('a protected second updater rolls back earlier changes without trying another blocking trick', async () => {
  const f = fixture({ failPackage: 'com.sec.android.soagent' })
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => {}, f.id), /Previous update settings restored/)
  assert.equal(f.automatic, null)
  assert.deepEqual(f.states, { 'com.wssyncmldm': '0', 'com.sec.android.soagent': '1' })
  assert.ok(!f.calls.some(command => command.includes('hide') || command.includes('uninstall')))
})

test('silently ignored writes fail verification', async () => {
  const f = fixture({ ignored: true })
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => {}, f.id), /did not keep/)
})

test('reviewed identity, primary profile, and post-backup identity guards prevent writes to another device', async () => {
  const f = fixture()
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => {}, { ...f.id, hardwareId: 'old-tv' }), /reviewed scan/)
  await assert.rejects(f.tools.apply('device:5555', 'block', true, async () => { f.id.hardwareId = 'replacement' }, { ...f.id }), /device changed/)
  assert.equal(f.writes().length, 0)
  const g = fixture({ owner: '10' })
  await assert.rejects(g.tools.apply('device:5555', 'block', true, async () => {}, g.id), /primary/)
  assert.equal(g.writes().length, 0)
})

test('unsupported package states are visible but excluded from all changes', async () => {
  const f = fixture({ packages: { 'com.wssyncmldm': '2' } })
  const report = await f.tools.inspect('device:5555')
  assert.equal(report.packages.length, 0)
  assert.deepEqual(report.unavailable, ['com.wssyncmldm'])
  await f.tools.apply('device:5555', 'allow', true, async () => {}, f.id)
  assert.equal(f.states['com.wssyncmldm'], '2')
})

test('unselected updater apps remain untouched', async () => {
  const f = fixture()
  await f.tools.apply('device:5555', 'block', false, async () => {}, f.id)
  assert.deepEqual(f.states, { 'com.wssyncmldm': '0', 'com.sec.android.soagent': '1' })
})

test('Undo refuses injected core packages, arbitrary preferences, duplicates, and later manual changes', async () => {
  const f = fixture()
  let saved
  await f.tools.apply('device:5555', 'block', true, async snapshot => { saved = snapshot }, f.id)
  const before = f.writes().length
  await assert.rejects(f.tools.restore('device:5555', { ...saved, changes: [{ kind: 'package', id: 'com.google.android.gms', before: '0', after: '3' }] }), /Invalid updater/)
  await assert.rejects(f.tools.restore('device:5555', { ...saved, changes: [{ kind: 'preference', before: 'reboot', after: '1' }] }), /Invalid update preference/)
  await assert.rejects(f.tools.restore('device:5555', { ...saved, changes: [saved.changes[0], saved.changes[0]] }), /Duplicate/)
  f.automatic = '0'
  await assert.rejects(f.tools.restore('device:5555', saved), /outside this tool/)
  assert.equal(f.writes().length, before)
})

test('unknown options and missing hardware identity cannot mutate updates', async () => {
  const f = fixture()
  await assert.rejects(f.tools.apply('device:5555', 'root-block', true, async () => {}, f.id), /Choose Block/)
  await assert.rejects(f.tools.apply('device:5555', 'block', 'true', async () => {}, f.id), /Choose whether/)
  const g = fixture({ hardware: 'unknown' })
  await assert.rejects(g.tools.inspect('device:5555'), /identify/)
  assert.equal(g.writes().length, 0)
})

test('concurrent update changes across tool instances are rejected for the same serial', async () => {
  const f = fixture()
  let release
  let ready
  const atBackup = new Promise(resolve => { ready = resolve })
  const task = f.tools.apply('device:5555', 'block', true, async () => { ready(); await new Promise(resolve => { release = resolve }) }, f.id)
  await atBackup
  await assert.rejects(createAndroidUpdateTools(f.run).apply('device:5555', 'allow', true, async () => {}, f.id), /already running/)
  release()
  await task
})
