import test from 'node:test'
import assert from 'node:assert/strict'
import { createTvDnsTools } from '../src/lib/tvDns.js'
import { TV_DNS_PROVIDERS, isDnsHostname, tvDnsTarget } from '../src/data/tvDnsProviders.js'

function fixture({ sdk = '34', owner = '0', ignore = false, failModeOnce = false, initial = {} } = {}) {
  const state = { private_dns_mode: null, private_dns_specifier: null, ...initial }
  const calls = []
  let hardware = 'tv-hardware'
  let fail = failModeOnce
  const run = async args => {
    assert.deepEqual(args.slice(0, 3), ['-s', 'tv:5555', 'shell'])
    const command = args.slice(3)
    calls.push(command)
    let stdout = ''
    if (command[0] === 'getprop') stdout = command[1] === 'ro.build.version.sdk' ? sdk : hardware
    if (command[0] === 'am') stdout = owner
    if (command[0] === 'settings') {
      const [, operation, , key, value] = command
      if (operation === 'get') stdout = state[key] === null ? 'null' : state[key]
      else {
        if (fail && key === 'private_dns_mode') { fail = false; return { ok: true, stdout: 'Error: Permission denial' } }
        if (!ignore) state[key] = operation === 'delete' ? null : value
      }
    }
    return { ok: true, stdout, stderr: '' }
  }
  const writes = () => calls.filter(call => call[0] === 'settings' && ['put', 'delete'].includes(call[1]))
  return { state, calls, writes, tools: createTvDnsTools(run, async () => {}), changeDevice: () => { hardware = 'another-tv' }, failNextMode: () => { fail = true } }
}

test('provider profiles use Android hostnames and distinguish filtering options', () => {
  for (const provider of TV_DNS_PROVIDERS) if (provider.host) assert.ok(isDnsHostname(provider.host))
  assert.deepEqual(tvDnsTarget('google'), { mode: 'hostname', host: 'dns.google' })
  assert.equal(tvDnsTarget('cloudflare-family').host, 'family.cloudflare-dns.com')
  assert.equal(tvDnsTarget('adguard-family').host, 'family.adguard-dns.com')
  assert.equal(tvDnsTarget('custom', 'My.Profile.Example').host, 'my.profile.example')
  for (const host of ['1.1.1.1', 'https://dns.google/dns-query', 'dns.google; reboot', '', 'dns.google:853']) assert.throws(() => tvDnsTarget('custom', host), /hostname/)
  assert.throws(() => tvDnsTarget('missing'), /Choose/)
})

test('DNS inspection is read-only and preserves an unset system default', async () => {
  const f = fixture()
  assert.deepEqual((await f.tools.inspect('tv:5555')).state, { mode: null, host: null })
  assert.equal(f.writes().length, 0)
})

test('verified backup precedes DNS writes and restore deletes originally absent settings', async () => {
  const f = fixture()
  let saved
  await f.tools.apply('tv:5555', 'google', '', async backup => { assert.equal(f.writes().length, 0); saved = backup })
  assert.equal(f.state.private_dns_mode, 'hostname')
  assert.equal(f.state.private_dns_specifier, 'dns.google')
  await f.tools.restore('tv:5555', saved)
  assert.deepEqual(f.state, { private_dns_mode: null, private_dns_specifier: null })
})

test('Automatic and Off remove the old provider hostname and can be restored exactly', async () => {
  for (const id of ['automatic', 'off']) {
    const f = fixture({ initial: { private_dns_mode: 'hostname', private_dns_specifier: 'dns.google' } })
    let saved
    await f.tools.apply('tv:5555', id, '', async backup => { saved = backup })
    assert.equal(f.state.private_dns_specifier, null)
    assert.equal(f.state.private_dns_mode, id === 'off' ? 'off' : 'opportunistic')
    await f.tools.restore('tv:5555', saved)
    assert.equal(f.state.private_dns_specifier, 'dns.google')
    assert.equal(f.state.private_dns_mode, 'hostname')
  }
})

test('invalid input and failed backup cannot change DNS', async () => {
  const f = fixture()
  await assert.rejects(f.tools.apply('tv:5555', 'custom', '8.8.8.8', async () => {}), /hostname/)
  await assert.rejects(f.tools.apply('tv:5555', 'google', '', async () => { throw new Error('disk full') }), /disk full/)
  await assert.rejects(f.tools.apply('tv:5555', 'google', ''), /backup is required/)
  assert.equal(f.writes().length, 0)
})

test('secondary profiles and old firmware refuse DNS writes', async () => {
  for (const options of [{ owner: '10' }, { sdk: '27' }]) {
    const f = fixture(options)
    await assert.rejects(f.tools.apply('tv:5555', 'google', '', async () => {}), /primary|Android 9/)
    assert.equal(f.writes().length, 0)
  }
})

test('identity or settings changes during backup stop every DNS write', async () => {
  const f = fixture()
  await assert.rejects(f.tools.apply('tv:5555', 'google', '', async () => f.changeDevice()), /device changed/)
  assert.equal(f.writes().length, 0)
  const g = fixture()
  await assert.rejects(g.tools.apply('tv:5555', 'google', '', async () => { g.state.private_dns_mode = 'off' }), /DNS changed/)
  assert.equal(g.writes().length, 0)
})

test('partial writes roll back to the exact original DNS state', async () => {
  const f = fixture({ failModeOnce: true })
  await assert.rejects(f.tools.apply('tv:5555', 'google', '', async () => {}), /Previous DNS settings restored/)
  assert.deepEqual(f.state, { private_dns_mode: null, private_dns_specifier: null })
})

test('ignored firmware writes fail verification instead of reporting DNS applied', async () => {
  const f = fixture({ ignore: true })
  await assert.rejects(f.tools.apply('tv:5555', 'google', '', async () => {}), /did not keep/)
})

test('restore refuses a different TV, later changes, or injected backup values', async () => {
  const f = fixture()
  let saved
  await f.tools.apply('tv:5555', 'google', '', async backup => { saved = backup })
  const before = f.writes().length
  f.state.private_dns_mode = 'off'
  await assert.rejects(f.tools.restore('tv:5555', saved), /DNS has changed/)
  f.changeDevice()
  await assert.rejects(f.tools.restore('tv:5555', saved), /device changed/)
  await assert.rejects(f.tools.restore('tv:5555', { ...saved, before: { mode: 'hostname', host: 'dns.google; reboot' } }), /invalid/)
  assert.equal(f.writes().length, before)
})

test('an already selected provider is a no-op and preserves existing backup', async () => {
  const f = fixture({ initial: { private_dns_mode: 'hostname', private_dns_specifier: 'dns.google' } })
  assert.deepEqual(await f.tools.apply('tv:5555', 'google', '', async () => { throw new Error('must not save') }), { unchanged: true })
  assert.equal(f.writes().length, 0)
})

test('a failed restore returns DNS to the setting in use before Restore', async () => {
  const f = fixture()
  let saved
  await f.tools.apply('tv:5555', 'google', '', async backup => { saved = backup })
  f.failNextMode()
  await assert.rejects(f.tools.restore('tv:5555', saved), /returned to the setting used before Restore/)
  assert.equal(f.state.private_dns_mode, 'hostname')
  assert.equal(f.state.private_dns_specifier, 'dns.google')
})
