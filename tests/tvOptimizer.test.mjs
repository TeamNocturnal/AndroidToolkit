import test from 'node:test'
import assert from 'node:assert/strict'
import { ANIMATION_KEYS, createTvOptimizer } from '../src/lib/tvOptimizer.js'

function fixture({ values = ['1', '1', '1'], maker = 'Sony', television = true, failWrite = 0, sdk = '29', demo = null, owner = '0', apps = [], cacheSupported = false, running = [], cacheFails = false } = {}) {
  const state = Object.fromEntries(ANIMATION_KEYS.map((key, i) => [key, values[i]]))
  const calls = []
  let writes = 0
  const props = { 'ro.product.model': 'BRAVIA 4K UR3', 'ro.product.manufacturer': maker, 'ro.serialno': 'test-hardware', 'ro.build.version.release': '10', 'ro.build.version.sdk': sdk }
  const appStates = Object.fromEntries(apps.map(app => [app.id, app.state || '0']))
  const run = async args => {
    calls.push(args)
    assert.equal(args[0], '-s')
    assert.equal(args[1], 'test-tv:5555')
    const [cmd, ...rest] = args.slice(3)
    let stdout = ''
    if (cmd === 'getprop') stdout = props[rest[0]] || ''
    if (cmd === 'am' && rest[0] === 'get-current-user') stdout = owner
    if (cmd === 'pm') {
      if (rest[0] === 'list' && rest[1] === 'features') stdout = television ? 'feature:android.software.leanback\n' : 'feature:android.hardware.type.handheld\n'
      else if (rest[0] === 'help') stdout = cacheSupported ? '  clear [--user USER_ID] [--cache-only] PACKAGE' : ' clear [--user USER_ID] PACKAGE'
      else if (rest[0] === 'list') stdout = apps.filter(app => (!rest.includes('-s') || app.preloaded) && (!rest.includes('-e') || ['0', '1'].includes(appStates[app.id]))).map(app => `package:${app.id}`).join('\n')
      else if (rest[0] === 'clear') {
        assert.ok(rest.includes('--cache-only'))
        return { ok: !cacheFails, stdout: cacheFails ? '' : 'Success', stderr: cacheFails ? 'Failed' : '' }
      } else {
        writes++
        if (writes === failWrite) return { ok: false, stdout: '', stderr: 'permission denied' }
        appStates[rest.at(-1)] = { 'default-state': '0', enable: '1', 'disable-user': '3' }[rest[0]]
      }
    }
    if (cmd === 'dumpsys') {
      const id = rest[1]
      stdout = `Packages:\n  Package [${id}] (test):\n    User 0: installed=true hidden=false suspended=false enabled=${appStates[id]}\n`
    }
    if (cmd === 'ps') stdout = 'USER PID PPID NAME\n' + running.map(name => `u0 123 1 ${name}`).join('\n')
    if (cmd === 'cat') stdout = 'MemTotal: 2230328 kB\nMemAvailable: 622704 kB'
    if (cmd === 'df') stdout = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/data 6577704 3425444 3004804 54% /data'
    if (cmd === 'wm') stdout = 'Physical size: 1920x1080'
    if (cmd === 'settings') {
      const [verb, , key, value] = rest
      if (verb === 'get') stdout = key === 'device_demo_mode' ? demo || 'null' : state[key] ?? 'null'
      else {
        writes++
        if (writes === failWrite) return { ok: false, stdout: '', stderr: 'permission denied' }
        state[key] = verb === 'delete' ? null : value
      }
    }
    return { ok: true, stdout, stderr: '' }
  }
  return { state, appStates, calls, props, optimizer: createTvOptimizer(run), run, get writes() { return writes } }
}

test('read-only inspection identifies Sony and parses available memory and storage', async () => {
  const f = fixture()
  const report = await f.optimizer.inspect('test-tv:5555')
  assert.equal(report.profile, 'Sony BRAVIA')
  assert.equal(report.availableKiB, 622704)
  assert.equal(report.freeStorageKiB, 3004804)
  assert.equal(f.writes, 0)
})
test('already tuned ONN is a no-op and preserves faster/off animations', async () => {
  const f = fixture({ maker: 'onn', values: ['0.5', '0', '0.25'] })
  const result = await f.optimizer.optimize('test-tv:5555', '0.5', () => assert.fail('No backup needed'))
  assert.equal(result.report.profile, 'ONN')
  assert.equal(result.changed, 0)
  assert.equal(f.writes, 0)
})
test('backup precedes writes; restore returns exact originals, including absent settings', async () => {
  const f = fixture({ values: ['2', null, '1.5'] })
  let snapshot
  const result = await f.optimizer.optimize('test-tv:5555', '0.5', async backup => {
    assert.equal(f.writes, 0)
    snapshot = backup
  })
  assert.equal(result.changed, 3)
  assert.deepEqual(Object.values(f.state), ['0.5', '0.5', '0.5'])
  await f.optimizer.restore('test-tv:5555', snapshot)
  assert.deepEqual(Object.values(f.state), ['2', null, '1.5'])
})
test('failed backup blocks every device write', async () => {
  const f = fixture()
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0', async () => { throw new Error('Disk full') }), /Disk full/)
  assert.equal(f.writes, 0)
})
test('failed second write rolls back earlier changes', async () => {
  const f = fixture({ failWrite: 2 })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', async () => {}), /Original settings restored/)
  assert.deepEqual(Object.values(f.state), ['1', '1', '1'])
})
test('non-TV device is refused without writes', async () => {
  const f = fixture({ television: false })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', async () => {}), /Select an Android TV/)
  assert.equal(f.writes, 0)
})
test('malformed setting is refused before backup', async () => {
  const f = fixture({ values: ['Permission denied', '1', '1'] })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', () => assert.fail('No backup')), /Unexpected animation/)
  assert.equal(f.writes, 0)
})
test('restore rejects a different hardware device even at the same IP', async () => {
  const f = fixture()
  let snapshot
  await f.optimizer.optimize('test-tv:5555', '0.5', async saved => { snapshot = saved })
  f.props['ro.serialno'] = 'another-tv'
  const before = f.writes
  await assert.rejects(f.optimizer.restore('test-tv:5555', snapshot), /different device/)
  assert.equal(f.writes, before)
})
test('restore refuses to overwrite a subsequent manual adjustment', async () => {
  const f = fixture()
  let snapshot
  await f.optimizer.optimize('test-tv:5555', '0.5', async saved => { snapshot = saved })
  f.state[ANIMATION_KEYS[0]] = '0.25'
  const before = f.writes
  await assert.rejects(f.optimizer.restore('test-tv:5555', snapshot), /changed outside/)
  assert.equal(f.writes, before)
})
test('tampered backup cannot write arbitrary settings', async () => {
  const f = fixture()
  const snapshot = { version: 1, identity: {}, changes: [{ key: 'private_dns_mode', before: null, after: '0' }] }
  await assert.rejects(f.optimizer.restore('test-tv:5555', snapshot), /Invalid optimization backup/)
  assert.equal(f.writes, 0)
})
test('successful exit with permission exception is still rejected', async () => {
  const optimizer = createTvOptimizer(async () => ({ ok: true, stdout: 'SecurityException: permission denial', stderr: '' }))
  await assert.rejects(optimizer.inspect('test-tv:5555'), /SecurityException/)
})
test('identity change while saving backup blocks all writes', async () => {
  const f = fixture()
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0', async () => { f.props['ro.serialno'] = 'another-tv' }), /Device changed/)
  assert.equal(f.writes, 0)
})

test('unreadable hardware identity blocks writes', async () => {
  const f = fixture()
  f.props['ro.serialno'] = ''
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', async () => {}), /Cannot identify/)
  assert.equal(f.writes, 0)
})

test('a silently ignored setting write fails verification', async () => {
  const f = fixture()
  const optimizer = createTvOptimizer(args => args[3] === 'settings' && args[4] === 'put'
    ? Promise.resolve({ ok: true, stdout: '', stderr: '' }) : f.run(args))
  await assert.rejects(optimizer.optimize('test-tv:5555', '0.5', async () => {}), /Could not verify.*Original settings restored/)
  assert.deepEqual(Object.values(f.state), ['1', '1', '1'])
})

test('a disconnected device during rollback reports incomplete restore', async () => {
  const f = fixture()
  let disconnected = false
  const optimizer = createTvOptimizer(async args => {
    if (args[3] === 'settings' && args[4] === 'put') disconnected = true
    return disconnected ? { ok: false, stdout: '', stderr: 'Device offline' } : f.run(args)
  })
  await assert.rejects(optimizer.optimize('test-tv:5555', '0.5', async () => {}), /Automatic restore incomplete.*Device offline/)
})

const optionalApp = { id: 'com.netflix.ninja', preloaded: true }
test('optional preloads are disabled only when selected and restore to exact default state', async () => {
  const f = fixture({ apps: [optionalApp, { id: 'com.google.android.play.games', preloaded: true, state: '1' }] })
  let snapshot
  await f.optimizer.optimize('test-tv:5555', { animations: false, disablePackages: [optionalApp.id] }, async saved => { snapshot = saved })
  assert.equal(f.appStates[optionalApp.id], '3')
  assert.equal(f.appStates['com.google.android.play.games'], '1')
  await f.optimizer.restore('test-tv:5555', snapshot)
  assert.equal(f.appStates[optionalApp.id], '0')
})
test('no bundled apps are selected by the default recipe', async () => {
  const f = fixture({ apps: [optionalApp] })
  await f.optimizer.optimize('test-tv:5555', { animations: true }, async () => {})
  assert.equal(f.appStates[optionalApp.id], '0')
  assert.ok(!f.calls.some(args => args.includes('disable-user')))
})
test('package failure rolls back settings and earlier package changes', async () => {
  const f = fixture({ apps: [optionalApp], failWrite: 4 })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', { animations: true, disablePackages: [optionalApp.id] }, async () => {}), /Original settings restored/)
  assert.deepEqual(Object.values(f.state), ['1', '1', '1'])
  assert.equal(f.appStates[optionalApp.id], '0')
})
test('unknown packages and core services are refused before writes', async () => {
  for (const id of ['com.android.systemui', 'com.google.android.kidslauncher', 'com.google.android.tvrecommendations', 'com.sony.dtv.demo', 'com.amazon.tv.launcher', 'com.onn.updatenotification', 'vendor.unknown']) {
    const f = fixture()
    await assert.rejects(f.optimizer.optimize('test-tv:5555', { disablePackages: [id] }, async () => {}), /Only listed optional/)
    assert.equal(f.writes, 0)
  }
})
test('user-installed and already-disabled apps are excluded from bundled-app cleanup', async () => {
  for (const app of [{ ...optionalApp, preloaded: false }, { ...optionalApp, state: '3' }]) {
    const f = fixture({ apps: [app] })
    await assert.rejects(f.optimizer.optimize('test-tv:5555', { disablePackages: [app.id] }, async () => {}), /selection changed/)
    assert.equal(f.writes, 0)
  }
})
test('managed retail demo mode is detected and never changed', async () => {
  const f = fixture({ demo: '1' })
  assert.equal((await f.optimizer.inspect('test-tv:5555')).demoMode, '1')
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', async () => {}), /retail demo mode/)
  assert.equal(f.writes, 0)
})
test('a missing demo flag stays unknown rather than being reported off', async () => {
  const f = fixture()
  assert.equal((await f.optimizer.inspect('test-tv:5555')).demoMode, null)
})
test('secondary Android users cannot alter owner apps or global settings', async () => {
  const f = fixture({ owner: '10' })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', '0.5', async () => {}), /primary owner/)
  assert.equal(f.writes, 0)
})
test('cache cleanup requires firmware support and never falls back to clearing app data', async () => {
  const f = fixture({ apps: [optionalApp] })
  await assert.rejects(f.optimizer.optimize('test-tv:5555', { animations: false, cachePackages: [optionalApp.id] }, async () => {}), /Cache-only cleanup is unavailable/)
  assert.ok(!f.calls.some(args => args[3] === 'pm' && args[4] === 'clear'))
})
test('cache-only cleanup preserves sign-in data and reports successful commands', async () => {
  const f = fixture({ apps: [optionalApp], sdk: '34', cacheSupported: true })
  const result = await f.optimizer.optimize('test-tv:5555', { animations: false, cachePackages: [optionalApp.id] }, () => assert.fail('No reversible change'))
  assert.deepEqual(result.cacheResults, [{ id: optionalApp.id, ok: true }])
  assert.deepEqual(f.calls.find(args => args[4] === 'clear'), ['-s', 'test-tv:5555', 'shell', 'pm', 'clear', '--user', '0', '--cache-only', optionalApp.id])
})
test('running apps are skipped during cache cleanup', async () => {
  const f = fixture({ apps: [optionalApp], sdk: '34', cacheSupported: true, running: [`${optionalApp.id}:player`] })
  const result = await f.optimizer.optimize('test-tv:5555', { animations: false, cachePackages: [optionalApp.id] }, async () => {})
  assert.equal(result.cacheResults[0].skipped, true)
  assert.ok(!f.calls.some(args => args[4] === 'clear'))
})
test('cache failures remain visible and do not claim successful cleanup', async () => {
  const f = fixture({ apps: [optionalApp], sdk: '34', cacheSupported: true, cacheFails: true })
  const result = await f.optimizer.optimize('test-tv:5555', { animations: false, cachePackages: [optionalApp.id] }, async () => {})
  assert.equal(result.cacheResults[0].ok, false)
})
test('brand-independent recipe covers Android TV makers and generic OEMs', async () => {
  for (const maker of ['Sony', 'TCL', 'Hisense', 'Philips', 'Xiaomi', 'Redmi', 'NVIDIA', 'onn', 'Google', 'Amazon', 'Sharp', 'Panasonic', 'Toshiba', 'JVC', 'Skyworth', 'Haier', 'Nokia', 'Thomson', 'realme', 'MECOOL', 'Homatics', 'RockTek', 'Dune HD', 'Dynalink', 'Generic OEM']) {
    const f = fixture({ maker, values: ['0.5', '0.5', '0.5'] })
    const result = await f.optimizer.optimize('test-tv:5555', { animations: true }, async () => {})
    assert.equal(result.changed, 0, maker)
    assert.equal(f.writes, 0, maker)
  }
})
test('legacy backups cannot inject package operations', async () => {
  const f = fixture()
  const snapshot = { version: 1, changes: [{ key: ANIMATION_KEYS[0], before: '1', after: '0.5' }], packages: [{ id: optionalApp.id, before: '3', after: '0' }] }
  await assert.rejects(f.optimizer.restore('test-tv:5555', snapshot), /Invalid optimization backup/)
  assert.equal(f.writes, 0)
})

test('valid package help with Android nonzero exit status still enables capability detection', async () => {
  const f = fixture({ sdk: '34' })
  const optimizer = createTvOptimizer(args => args[3] === 'pm' && args[4] === 'help'
    ? Promise.resolve({ ok: false, stdout: 'Package manager (package) commands:\n  clear [--user USER_ID] [--cache-only] PACKAGE', stderr: '' }) : f.run(args))
  assert.equal((await optimizer.inspect('test-tv:5555')).cacheSupported, true)
})
