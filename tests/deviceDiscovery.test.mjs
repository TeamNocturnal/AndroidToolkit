import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConnectedDevices, discoverConnectedDevices, inspectConnectedDevices } from '../src/lib/deviceDiscovery.js'

test('discovers all USB, Wi-Fi, emulator, and authorization states', () => {
  const devices = parseConnectedDevices(`* daemon started successfully
List of devices attached
usb123 device product:phone model:Pixel_9 transport_id:1
192.168.1.10:5555 device product:tv model:Android_TV transport_id:2
adb-box._adb-tls-connect._tcp device model:Streaming_Box transport_id:3
pending unauthorized transport_id:4
sleeping offline transport_id:5
emulator-5554 device model:Emulator transport_id:6
recover recovery
transfer sideload
permissions no permissions (user in plugdev group)
`)
  assert.equal(devices.length, 9)
  assert.equal(devices[0].transport, 'USB')
  assert.equal(devices[1].model, 'Android TV')
  assert.equal(devices[2].transport, 'Wi-Fi')
  assert.equal(devices[5].transport, 'Emulator')
  assert.equal(devices[8].status, 'no_permissions')
})
test('deduplicates serials and accepts an empty valid inventory', () => {
  assert.deepEqual(parseConnectedDevices('List of devices attached\n'), [])
  assert.equal(parseConnectedDevices('List of devices attached\nx offline\nx device model:TV\n').length, 1)
  assert.equal(parseConnectedDevices('List of devices attached\nx offline\nx device model:TV\n')[0].status, 'device')
})
test('failed discovery is not mistaken for no devices', async () => {
  await assert.rejects(discoverConnectedDevices(async () => ({ ok: false, stderr: 'ADB unavailable' })), /ADB unavailable/)
  assert.throws(() => parseConnectedDevices('cannot connect to daemon'), /Could not read/)
})
test('discovery explicitly refreshes the live ADB inventory', async () => {
  const devices = await discoverConnectedDevices(async args => {
    assert.deepEqual(args, ['devices', '-l'])
    return { ok: true, stdout: 'List of devices attached\nfirst device\nsecond device\n' }
  })
  assert.equal(devices.length, 2)
})
test('scans every authorized device while retaining unsupported and failed entries', async () => {
  const devices = parseConnectedDevices('List of devices attached\ntv1 device\ntv2 device\nphone device\nbroken device\npending unauthorized\nsleeping offline\n')
  const calls = []
  const results = await inspectConnectedDevices(devices, async serial => {
    calls.push(serial)
    if (serial === 'phone') throw new Error('Select an Android TV device')
    if (serial === 'broken') throw new Error('Connection lost')
    return { identity: { manufacturer: 'TV Maker' }, serial }
  })
  assert.deepEqual(calls.sort(), ['broken', 'phone', 'tv1', 'tv2'])
  assert.equal(results.length, 6)
  assert.equal(results.filter(result => result.report).length, 2)
  assert.match(results[2].error, /Android TV/)
  assert.match(results[3].error, /Connection lost/)
  assert.match(results[4].error, /Allow USB/)
  assert.equal(results[5].report, null)
})

test('an unresponsive device cannot hide completed scans of other devices', async () => {
  const devices = parseConnectedDevices('List of devices attached\nworking device\nhanging device\n')
  const results = await inspectConnectedDevices(devices, serial => serial === 'hanging' ? new Promise(() => {}) : Promise.resolve({ serial }), { timeoutMs: 10 })
  assert.equal(results[0].report.serial, 'working')
  assert.match(results[1].error, /did not respond/)
})
