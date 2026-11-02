import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { createTvOptimizer } from '../lib/tvOptimizer'
import { tvDemoGuide } from '../data/tvOptimizationCatalog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { discoverConnectedDevices, inspectConnectedDevices } from '../lib/deviceDiscovery'
import TvAudioHelp from './TvAudioHelp'
import TvDeviceTools from './TvDeviceTools'

const optimizer = createTvOptimizer(args => invoke('run_adb', { args }))
const activeDevices = new Set()
const buttonStyle = { fontSize: 11, padding: '6px 12px' }
const gib = value => value == null ? 'Unavailable' : `${(value / 1048576).toFixed(2)} GiB`

export default function TvOptimizer(props) {
  const [results, setResults] = useState([])
  const [scanning, setScanning] = useState(false)
  const [operationBusy, setOperationBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const scanLock = useRef(false)

  async function scanAll() {
    if (scanLock.current || operationBusy || props.externalBusy) return
    scanLock.current = true
    setScanning(true)
    props.onBusy?.(true)
    setMessage('Finding connected USB and Wi-Fi devices…')
    try {
      const devices = await discoverConnectedDevices(args => invoke('run_adb', { args }))
      props.onDevicesScanned?.(devices)
      setMessage(`Checking ${devices.length} connected device${devices.length === 1 ? '' : 's'}…`)
      const next = await inspectConnectedDevices(devices, optimizer.inspect)
      setResults(next)
      setRevision(value => value + 1)
      const supported = next.filter(item => item.report).length
      setMessage(devices.length ? `Found ${devices.length} device${devices.length === 1 ? '' : 's'}; ${supported} ready for TV optimization. Scanning does not change device settings.` : 'No ADB devices found. Connect USB or Wi-Fi debugging, authorize this PC on the device, and scan again.')
    } catch (error) {
      setResults([])
      setMessage(`Scan failed: ${String(error.message || error).slice(0, 300)}`)
    } finally { scanLock.current = false; setScanning(false); props.onBusy?.(false) }
  }

  function setBusy(value) { setOperationBusy(value); props.onBusy?.(value) }
  const busy = scanning || operationBusy || props.externalBusy

  return <>
    <section aria-label="Connected device scan" style={{ padding: 14, marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <button className="btn-ghost" style={buttonStyle} disabled={busy} onClick={scanAll}>{scanning ? 'Scanning devices…' : 'Scan All Devices'}</button>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Find every device connected through USB or Wi-Fi debugging. Choose a supported TV or stick below to review its options.</p>
      {message && <p role="status" style={{ fontSize: 11 }}>{message}</p>}
      {results.map(item => <div key={item.device.serial} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border-subtle)', fontSize: 11 }}>
        <div><strong>{item.device.model}</strong> · {item.device.serial} · {item.device.transport}
          <div>{item.report ? `${item.report.identity.manufacturer} · Android ${item.report.android} · Ready` : item.error}</div>
        </div>
        {item.report && <button className="btn-ghost" style={buttonStyle} disabled={busy || !props.onSelectDevice} onClick={() => props.onSelectDevice(item.device)}>Review</button>}
      </div>)}
    </section>
    <div className="tv-primary-tools">
      <TvOptimizerDevice key={`${props.serial || 'no-device'}:${revision}`} {...props} initialReport={results.find(item => item.device.serial === props.serial)?.report || null} externalBusy={busy} onBusy={setBusy} />
      <TvAudioHelp key={props.serial || 'no-audio-device'} serial={props.serial} connected={props.connected} externalBusy={busy} onBusy={setBusy} />
    </div>
    <TvDeviceTools key={props.serial || 'no-tools-device'} serial={props.serial} connected={props.connected} externalBusy={busy} onBusy={setBusy} showUpdateControls={props.showUpdateControls} />
  </>
}

async function backupLocation(serial) {
  const folder = await join(await downloadDir(), 'Android Toolkit', 'TV Optimization')
  await mkdir(folder, { recursive: true })
  return join(folder, `tv-${Array.from(serial).map(c => c.charCodeAt(0).toString(16)).join('-')}.json`)
}

function TvOptimizerDevice({ serial, connected, devices = [], onSelectDevice, initialReport, externalBusy, onBusy }) {
  const [report, setReport] = useState(initialReport)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [animations, setAnimations] = useState(true)
  const [disableExtras, setDisableExtras] = useState(false)
  const [clearCaches, setClearCaches] = useState(false)
  const [selectedApps, setSelectedApps] = useState([])
  const [backupPath, setBackupPath] = useState('')
  const lock = useRef(false)

  useEffect(() => {
    let canceled = false
    if (serial) backupLocation(serial).then(async path => {
      const active = await exists(path) && !JSON.parse(await readTextFile(path)).restored
      if (!canceled) setBackupPath(active ? path : '')
    }).catch(() => {})
    return () => { canceled = true }
  }, [serial])

  async function location() {
    return backupLocation(serial)
  }
  async function action(task) {
    if (!connected || externalBusy || lock.current || activeDevices.has(serial)) return
    lock.current = true
    activeDevices.add(serial)
    setBusy(true)
    onBusy(true)
    setMessage('Checking device…')
    try { await task() } catch (error) { setMessage(`Could not complete: ${String(error.message || error).slice(0, 500)}`) }
    finally { lock.current = false; activeDevices.delete(serial); setBusy(false); onBusy(false) }
  }
  async function optimize() {
    const path = await location()
    if ((animations || disableExtras && selectedApps.length) && await exists(path) && !JSON.parse(await readTextFile(path)).restored) {
      setBackupPath(path)
      throw new Error('An earlier optimization backup exists. Restore it before starting another preset.')
    }
    const result = await optimizer.optimize(serial, {
      animations, scale: '0.5',
      disablePackages: disableExtras ? selectedApps : [],
      cachePackages: clearCaches ? report?.apps.filter(app => app.enabled).map(app => app.id) || [] : [],
    }, async snapshot => {
      await writeTextFile(path, JSON.stringify(snapshot, null, 2))
      // Verify the saved copy before allowing a device setting to change.
      if (await readTextFile(path) !== JSON.stringify(snapshot, null, 2)) throw new Error('Backup verification failed; no settings changed.')
      setBackupPath(path)
    })
    setReport(result.report)
    const cacheCount = result.cacheResults.filter(item => item.ok).length
    const cacheNotes = result.cacheResults.filter(item => !item.ok).map(item => `${item.id}: ${item.error}`)
    setMessage([
      result.changed ? `Verified ${result.changed} changes. Original settings and app states saved for Restore.` : 'Already tuned for the selected settings. No reversible changes needed.',
      clearCaches ? `Cache cleared for ${cacheCount} of ${report?.apps.filter(app => app.enabled).length || 0} selected apps. Temporary cache cannot be restored.` : '',
      ...cacheNotes,
    ].filter(Boolean).join('\n'))
    setSelectedApps([])
  }
  async function restore() {
    const path = await location()
    const snapshot = JSON.parse(await readTextFile(path))
    if (snapshot.restored) throw new Error('These settings have already been restored. Scan or choose a new preset.')
    await optimizer.restore(serial, snapshot)
    // Retain history; retire the active backup only after verified restore.
    const archive = `${path}.${Date.now()}.restored.json`
    await writeTextFile(archive, JSON.stringify({ ...snapshot, restoredAt: new Date().toISOString() }, null, 2))
    // Keep a restored marker at the original path so history is never deleted.
    await writeTextFile(path, JSON.stringify({ ...snapshot, restored: true }, null, 2))
    setBackupPath('')
    setReport(await optimizer.inspect(serial))
    setSelectedApps([])
    setMessage('Original settings and app states restored and verified. Cleared cache is recreated by apps as needed.')
  }
  return (
    <section style={{ padding: 16, marginBottom: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)' }} aria-label="TV optimization">
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Android TV &amp; Stick Optimize</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>One shared optimizer for Android TVs, boxes, and sticks. It checks your device automatically, backs up reversible changes, and reports what it changed or skipped.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {devices.length > 1 ? (
        <label style={{ fontSize: 11 }}>Device{' '}
          <select aria-label="TV optimization device" value={serial || ''} disabled={busy || !onSelectDevice} onChange={e => onSelectDevice(devices.find(device => device.serial === e.target.value) || null)} style={{ maxWidth: '100%', padding: '5px 8px', background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            <option value="">Choose your TV or streaming box</option>
            {devices.map(device => <option key={device.serial} value={device.serial} disabled={device.status !== 'device'}>{device.serial}{device.status !== 'device' ? ` (${device.status})` : ''}</option>)}
          </select>
        </label>
        ) : <span style={{ fontSize: 11 }}>Selected device: {serial || 'None connected'}</span>}
        <button className="btn-primary" style={buttonStyle} disabled={!connected || busy || externalBusy || !animations && !(disableExtras && selectedApps.length) && !(clearCaches && report?.cacheSupported && report.apps.some(app => app.enabled))} onClick={() => action(optimize)}>{busy ? 'Working…' : 'Optimize'}</button>
        <button className="btn-ghost" style={buttonStyle} disabled={!connected || busy || externalBusy || !backupPath} onClick={() => action(restore)}>Restore Changes</button>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 14, fontSize: 12 }}>
        <label><input type="checkbox" checked={animations} disabled={busy} onChange={e => setAnimations(e.target.checked)} /> Faster menus <span style={{ color: 'var(--text-muted)' }}>— shorten animations to 0.5×; preserve faster settings.</span></label>
        <label><input type="checkbox" checked={disableExtras} disabled={busy || !report} onChange={e => setDisableExtras(e.target.checked)} /> Disable bundled apps I choose <span style={{ color: 'var(--text-muted)' }}>— hides only selected apps and stops them running. Their data is kept; Restore brings them back.</span></label>
        {disableExtras && <div style={{ paddingLeft: 22, display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Select only apps you do not use. Each selected app will be unavailable until restored. No apps are selected automatically.</p>
          {report?.apps.filter(app => app.preloaded && app.enabled).map(app => <label key={app.id}>
            <input type="checkbox" checked={selectedApps.includes(app.id)} disabled={busy} onChange={e => setSelectedApps(items => e.target.checked ? [...items, app.id] : items.filter(id => id !== app.id))} /> {app.name}
          </label>)}
          {!report?.apps.some(app => app.preloaded && app.enabled) && <span>No enabled bundled apps from the optional-app catalog were found.</span>}
        </div>}
        <label><input type="checkbox" checked={clearCaches} disabled={busy || !report?.cacheSupported} onChange={e => setClearCaches(e.target.checked)} /> Clear temporary app caches <span style={{ color: 'var(--text-muted)' }}>— optional, supported firmware only. Keeps app data and sign-ins; skips running apps. Cache cannot be restored.</span></label>
        {clearCaches && <div style={{ paddingLeft: 22, color: 'var(--text-muted)' }}>Cache candidates: {report?.apps.filter(app => app.enabled).map(app => app.name).join(', ') || 'None'}. System services are excluded.</div>}
        {report && !report.cacheSupported && <span style={{ paddingLeft: 22, color: 'var(--text-muted)' }}>This firmware has no verified cache-only command. Use Settings → Apps → Clear cache on the device.</span>}
      </div>
      {!connected && <p style={{ fontSize: 11 }}>Connect and select your TV to scan or optimize it.</p>}
      {report && <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.8 }}>
        <strong>{report.identity.manufacturer} · Android {report.android}</strong>
        <div>Available memory: {gib(report.availableKiB)} / {gib(report.totalKiB)} · Free storage: {gib(report.freeStorageKiB)}</div>
        <div>Menu animations: {Object.values(report.settings).map(v => v === null ? 'Default' : `${v}×`).join(' / ')}</div>
        <div style={{ whiteSpace: 'pre-line' }}>Android interface size: {report.display}</div>
        <p style={{ color: 'var(--text-muted)' }}>Interface size is separate from HDMI/video playback resolution. Preserve it unless you specifically need to resize the interface.</p>
        <details style={{ marginTop: 12 }}><summary>Demo / shop mode check</summary>
          <p>{report.demoMode === '1' ? 'Android reports retail demo mode. Optimization is blocked until you exit it through the device settings.' : report.demoMode === '0' ? 'Android’s retail demo flag is off. Manufacturer-specific shop modes still need checking on the TV.' : 'Android does not report a retail-demo state. This does not confirm that the manufacturer’s shop mode is off.'}</p>
          <p>{tvDemoGuide(report.identity.manufacturer).text}</p>
          {tvDemoGuide(report.identity.manufacturer).url && <button className="btn-ghost" style={buttonStyle} onClick={() => openUrl(tvDemoGuide(report.identity.manufacturer).url)}>Manufacturer instructions ↗</button>}
          <p>Use the normal Home/Store setting. Retail-mode apps and device-management settings are protected; no factory reset is performed.</p>
        </details>
        <details style={{ marginTop: 10 }}><summary>Home-screen recommendations</summary>
          <p>On Google TV, Apps only mode is under Settings → Accounts &amp; Profiles → your profile. It hides personalized recommendations but also disables Search, Assistant, and Watchlist features. Sponsored content can remain.</p>
          <button className="btn-ghost" style={buttonStyle} onClick={() => openUrl('https://support.google.com/googletv/answer/10267283')}>Google TV instructions ↗</button>
        </details>
      </div>}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>Home screen, remote, casting, accessibility, picture settings, streaming licenses, app stores, and firmware updates are protected. Review other manufacturer apps in Apps &amp; Cleanup.</p>
      {message && <p role="status" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{message}</p>}
      {backupPath && <p style={{ fontSize: 10, overflowWrap: 'anywhere' }}>Backup: {backupPath}</p>}
    </section>
  )
}
