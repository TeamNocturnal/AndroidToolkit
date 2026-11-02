import test from 'node:test'
import assert from 'node:assert/strict'
import { createTvDeviceTools, parseNetworkCheck } from '../src/lib/tvDeviceTools.js'

function fixture({ tv = true, denied = '', loss = 0, pingOutput = true } = {}) {
  const calls = []
  const run = async args => {
    calls.push(args)
    assert.deepEqual(args.slice(0, 3), ['-s', 'tv:5555', 'shell'])
    const cmd = args.slice(3).join(' ')
    if (denied && cmd.startsWith(denied)) return { ok: true, stdout: 'Error: Permission denial', stderr: '' }
    const output = {
      'pm list features': tv ? 'feature:android.software.leanback' : 'feature:android.hardware.touchscreen',
      'getprop ro.build.characteristics': tv ? 'tv' : 'phone',
      'cat /proc/uptime': '3600.00 4000.00',
      'getprop ro.build.version.security_patch': '2026-01-01',
      'ip -o -4 addr show': '1: lo    inet 127.0.0.1/8 scope host lo\n2: wlan0    inet 192.168.1.24/24 brd 192.168.1.255 scope global wlan0',
      'ip route show table all': 'default via 192.168.1.1 dev wlan0 table wlan0',
      'settings get global private_dns_mode': 'hostname',
      'settings get global private_dns_specifier': 'dns.example.com',
      'wm size': 'Physical size: 3840x2160\nOverride size: 1920x1080',
      'wm density': 'Physical density: 320\nOverride density: 240',
    }
    if (cmd.startsWith('ping ')) return { ok: loss < 100, stdout: pingOutput ? `3 packets transmitted, ${loss === 100 ? 0 : 3} received, ${loss}% packet loss\n${loss === 100 ? '' : 'rtt min/avg/max/mdev = 5.00/8.25/12.00/1.00 ms'}` : '', stderr: '' }
    return { ok: true, stdout: output[cmd] || '', stderr: '' }
  }
  const inspect = async () => ({ identity: { manufacturer: 'ONN', model: 'TV' }, android: '14', sdk: '34', totalKiB: 3000000, availableKiB: 500000, freeStorageKiB: 12000000 })
  return { calls, tools: createTvDeviceTools(run, inspect) }
}

test('device checks report health, network and interface overrides without changing settings', async () => {
  const f = fixture()
  assert.equal((await f.tools.health('tv:5555')).uptimeHours, 1)
  const network = await f.tools.network('tv:5555')
  assert.deepEqual(network.addresses, ['wlan0: 192.168.1.24'])
  assert.equal(network.gateway, '192.168.1.1')
  assert.equal(network.dnsHostname, 'dns.example.com')
  const display = await f.tools.display('tv:5555')
  assert.equal(display.overrideSize, '1920x1080')
  assert.equal(display.overrideDensity, '240')
  assert.ok(f.calls.every(args => !['put', 'input', 'start', 'clear', 'kill-all'].some(word => args.includes(word))))
})

test('missing diagnostics remain unavailable instead of showing healthy defaults', async () => {
  const f = fixture({ denied: 'ip' })
  const report = await f.tools.network('tv:5555')
  assert.deepEqual(report.addresses, [])
  assert.equal(report.gateway, null)
  assert.deepEqual(report.unavailable, ['IP addresses', 'Gateway'])
  assert.equal(parseNetworkCheck('', '', '', '').dnsMode, 'Not reported')
  const display = await fixture({ denied: 'wm' }).tools.display('tv:5555')
  assert.equal(display.physicalSize, null)
  assert.equal(display.physicalDensity, null)
})

test('ping reports packet loss even with Android nonzero exit and never calls it a speed test', async () => {
  assert.deepEqual(await fixture().tools.ping('tv:5555'), { lossPercent: 0, averageMs: 8.25 })
  assert.deepEqual(await fixture({ loss: 100 }).tools.ping('tv:5555'), { lossPercent: 100, averageMs: null })
  await assert.rejects(fixture({ pingOutput: false }).tools.ping('tv:5555'), /unavailable or blocked/)
})

test('remote buttons and settings shortcuts only send fixed allowlisted commands to the selected TV', async () => {
  const f = fixture()
  await f.tools.remote('tv:5555', 'home')
  assert.deepEqual(f.calls.at(-1).slice(3), ['input', 'keyevent', '3'])
  await f.tools.settings('tv:5555', 'network')
  assert.deepEqual(f.calls.at(-1).slice(3), ['am', 'start', '-a', 'android.settings.WIFI_SETTINGS'])
  const count = f.calls.length
  await assert.rejects(f.tools.remote('tv:5555', '3; reboot'), /Unknown/)
  await assert.rejects(f.tools.settings('tv:5555', 'toString'), /Unknown/)
  assert.equal(f.calls.length, count)
})

test('non-TV devices and permission failures block interactive commands', async () => {
  const f = fixture({ tv: false })
  await assert.rejects(f.tools.remote('tv:5555', 'home'), /Select an Android TV/)
  assert.ok(!f.calls.some(args => args.includes('input')))
  await assert.rejects(fixture({ denied: 'am' }).tools.settings('tv:5555', 'settings'), /Permission denial/)
  await assert.rejects(f.tools.network(''), /Connect and select/)
})

test('visible interface controls use fixed sizes and verify the reported result', async () => {
  const f = fixture()
  await f.tools.resize('tv:5555', '1080p')
  assert.ok(f.calls.some(args => args.slice(3).join(' ') === 'wm size 1920x1080'))
  const count = f.calls.length
  await assert.rejects(f.tools.resize('tv:5555', '4k; reboot'), /listed interface size/)
  assert.equal(f.calls.length, count)
  await assert.rejects(f.tools.resize('tv:5555', '4k'), /could not be verified/)
})

test('background cleanup is explicit, TV-only, and does not clear app data', async () => {
  const f = fixture()
  await f.tools.closeBackground('tv:5555')
  assert.deepEqual(f.calls.at(-1).slice(3), ['am', 'kill-all'])
  assert.ok(!f.calls.some(args => args.includes('clear')))
  const phone = fixture({ tv: false })
  await assert.rejects(phone.tools.closeBackground('tv:5555'), /Select an Android TV/)
  assert.ok(!phone.calls.some(args => args.includes('kill-all')))
})
