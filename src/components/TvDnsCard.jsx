import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { TV_DNS_PROVIDERS } from '../data/tvDnsProviders'
import { createTvDeviceTools } from '../lib/tvDeviceTools'
import { createTvDnsTools } from '../lib/tvDns'

const runAdb = args => invoke('run_adb', { args })
const dns = createTvDnsTools(runAdb, createTvDeviceTools(runAdb).verify)
const groups = [...new Set(TV_DNS_PROVIDERS.map(item => item.group))]
async function backupPath(serial) {
  const folder = await join(await downloadDir(), 'Android Toolkit', 'TV DNS')
  await mkdir(folder, { recursive: true })
  return join(folder, `dns-${Array.from(serial).map(char => char.charCodeAt(0).toString(16)).join('-')}.json`)
}
const describeState = state => state.mode === 'hostname' ? state.host : { off: 'Private DNS off', opportunistic: 'Automatic' }[state.mode] || 'System default (not explicitly set)'

export default function TvDnsCard({ serial, disabled, action, status }) {
  const [selection, setSelection] = useState('')
  const [custom, setCustom] = useState('')
  const [current, setCurrent] = useState(null)
  const [backup, setBackup] = useState(null)
  const provider = TV_DNS_PROVIDERS.find(item => item.id === selection)

  useEffect(() => {
    let canceled = false
    if (serial) backupPath(serial).then(async path => {
      if (await exists(path)) {
        const saved = JSON.parse(await readTextFile(path))
        if (!canceled && !saved.restored) setBackup(saved)
      }
    }).catch(() => {})
    return () => { canceled = true }
  }, [serial])

  async function apply(id) {
    const result = await dns.apply(serial, id, custom, async value => {
      const path = await backupPath(serial)
      const contents = JSON.stringify(value, null, 2)
      await writeTextFile(path, contents)
      if (await readTextFile(path) !== contents) throw new Error('The DNS backup could not be verified. No changes made.')
      setBackup(value)
    })
    if (result.backup) setCurrent({ hardwareId: result.backup.hardwareId, state: result.backup.after })
    return result.unchanged ? 'These DNS settings are already saved.' : 'DNS settings saved. Check a streaming app on the TV; use Automatic if access stops.'
  }

  return <section className="tv-tool-card tv-dns-card" aria-label="Private DNS">
    <h3>Private DNS</h3>
    <p className="tv-tool-description">Choose who resolves internet addresses for this TV, with optional ad, security, or adult-content filtering.</p>
    <label className="tv-dns-label">Provider &amp; filter
      <select aria-label="DNS provider and filter" disabled={disabled} value={selection} onChange={event => setSelection(event.target.value)}>
        <option value="">Choose a provider…</option>
        {groups.map(group => <optgroup key={group} label={group}>{TV_DNS_PROVIDERS.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.group === 'Device defaults' ? item.name : `${item.group} — ${item.name}`}</option>)}</optgroup>)}
      </select>
    </label>
    {provider && <div className="tv-dns-description"><strong>{provider.group === 'Device defaults' ? provider.name : `${provider.group} — ${provider.name}`}</strong><p>{provider.description}</p>
      {provider.host && <code>{provider.host}</code>}
      {provider.source && <button className="btn-ghost" onClick={() => openUrl(provider.source)}>Provider details ↗</button>}
    </div>}
    {provider?.custom && <label className="tv-dns-label">Private DNS hostname
      <input aria-label="Custom DNS hostname" disabled={disabled} value={custom} placeholder="Paste your provider or profile hostname" onChange={event => setCustom(event.target.value)} />
    </label>}
    <div className="tv-tool-actions">
      <button className="btn-primary" disabled={disabled || !provider || provider.custom && !custom.trim()} onClick={() => action(() => apply(selection))}>Apply DNS</button>
      <button className="btn-ghost" disabled={disabled} onClick={() => action(async () => { setCurrent(await dns.inspect(serial)); return 'Current DNS settings read. No changes made.' })}>Check current</button>
      <button className="btn-ghost" disabled={disabled} onClick={() => action(() => apply('automatic'))}>Use Automatic</button>
      <button className="btn-ghost" disabled={disabled || !backup} onClick={() => action(async () => {
        await dns.restore(serial, backup)
        setCurrent({ hardwareId: backup.hardwareId, state: backup.before })
        await writeTextFile(await backupPath(serial), JSON.stringify({ ...backup, restored: true }, null, 2))
        setBackup(null)
        return 'Previous DNS settings restored and read back.'
      })}>Restore previous</button>
    </div>
    {current && <p>Current setting: <strong>{describeState(current.state)}</strong></p>}
    <p className="tv-tool-description">Requires Android 9+ and firmware support. Filters cannot remove every ad or block all adult content. VPNs and apps using their own DNS may bypass them.</p>
    <p className="tv-tool-description">Changes only this TV. If a filter disrupts an app, use Automatic or restore your previous setting. Private DNS is also available in the TV’s network settings.</p>
    {status && <p role="status" className="tv-tool-status">{status}</p>}
  </section>
}
