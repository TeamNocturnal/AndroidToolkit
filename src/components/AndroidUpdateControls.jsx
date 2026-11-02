import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { createAndroidUpdateTools } from '../lib/androidUpdates'

const updates = createAndroidUpdateTools(args => invoke('run_adb', { args }))
async function backupLocation(serial) {
  const folder = await join(await downloadDir(), 'Android Toolkit', 'Update Controls')
  await mkdir(folder, { recursive: true })
  return join(folder, `updates-${Array.from(serial).map(char => char.charCodeAt(0).toString(16)).join('-')}.json`)
}

export default function AndroidUpdateControls({ serial, connected, externalBusy = false, onBusy }) {
  const [report, setReport] = useState(null)
  const [backup, setBackup] = useState(null)
  const [includeUpdater, setIncludeUpdater] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const lock = useRef(false)
  const disabled = !connected || externalBusy || busy
  const canChange = !!report && (report.automaticSupported || includeUpdater && report.packages.length > 0)

  useEffect(() => {
    let canceled = false
    if (serial) backupLocation(serial).then(async path => {
      if (await exists(path)) {
        const saved = JSON.parse(await readTextFile(path))
        if (!canceled && !saved.restored) setBackup(saved)
      }
    }).catch(() => {})
    return () => { canceled = true }
  }, [serial])

  async function action(task) {
    if (disabled || lock.current) return
    lock.current = true
    setBusy(true)
    onBusy?.(true)
    setMessage('Checking the selected device…')
    try { setMessage(await task()) }
    catch (error) { setMessage(String(error.message || error).slice(0, 600)) }
    finally { lock.current = false; setBusy(false); onBusy?.(false) }
  }
  async function change(mode) {
    const result = await updates.apply(serial, mode, includeUpdater, async snapshot => {
      const path = await backupLocation(serial)
      const contents = JSON.stringify(snapshot, null, 2)
      await writeTextFile(path, contents)
      if (await readTextFile(path) !== contents) throw new Error('The restore backup could not be verified. No updates changed.')
      setBackup(snapshot)
    }, report.identity)
    setReport(result.report)
    if (result.unchanged) return 'The detected update controls already have these settings.'
    if (mode === 'allow') return 'Detected update controls allowed again. This does not download or install an update.'
    return result.report.packages.some(pkg => pkg.state === '3') && includeUpdater
      ? 'Detected updater apps disabled and verified. Other update paths may remain; check the device’s update settings.'
      : 'Automatic-install preference paused and verified. This is not a full update block; downloads, manual updates, or vendor updates may continue.'
  }

  return <section className="tv-tool-card android-update-card" aria-label="System update controls">
    <h3>System updates</h3>
    <p className="tv-tool-description">Detect this device’s update controls, then block its supported updater or pause automatic installation. Works across Android phones, tablets, TVs, sticks, and headsets; available methods depend on firmware.</p>
    <div className="tv-tool-actions">
      <button className="btn-ghost" disabled={disabled} onClick={() => action(async () => {
        setReport(null)
        setReport(await updates.inspect(serial))
        return 'Update controls scanned. No settings changed.'
      })}>Scan update controls</button>
      <button className="btn-ghost" disabled={disabled} onClick={() => action(() => updates.openSettings(serial))}>Open update settings</button>
    </div>
    {report && <>
      <p><strong>{report.profile.label}</strong> · {report.identity.model} · Android {report.android}</p>
      <p>Automatic-install preference: <strong>{!report.automaticSupported ? 'Not detected' : report.automatic === '1' ? 'Paused' : report.automatic === '0' ? 'Allowed' : 'System default'}</strong></p>
      {report.packages.length > 0 ? <>
        <label className="tv-update-option"><input type="checkbox" disabled={disabled} checked={includeUpdater} onChange={event => setIncludeUpdater(event.target.checked)} /> Include detected updater apps</label>
        <ul className="tv-update-packages">{report.packages.map(pkg => <li key={pkg.id}><code>{pkg.id}</code> — {pkg.state === '3' ? 'Disabled for primary profile' : 'Enabled/default'}</li>)}</ul>
      </> : <p className="tv-tool-description">No separate updater app can be safely disabled by this tool on the detected firmware. Google Play services and app stores stay enabled.</p>}
      {report.profile.note && <p className="tv-tool-description">{report.profile.note}</p>}
      {!!report.unavailable.length && <p>Some detected updater apps have protected or unsupported states and were excluded.</p>}
      {!canChange && <p>Use the device’s own update settings; no supported automatic control was detected.</p>}
    </>}
    <div className="tv-tool-actions">
      <button className="btn-warning" disabled={disabled || !canChange} onClick={() => action(() => change('block'))}>{report?.packages.length && includeUpdater ? 'Block detected updater' : 'Pause auto-install'}</button>
      <button className="btn-ghost" disabled={disabled || !canChange} onClick={() => action(() => change('allow'))}>Allow updates</button>
      <button className="btn-ghost" disabled={disabled || !backup} onClick={() => action(async () => {
        await updates.restore(serial, backup)
        await writeTextFile(await backupLocation(serial), JSON.stringify({ ...backup, restored: true }, null, 2))
        setBackup(null)
        setReport(await updates.inspect(serial))
        return 'The settings from before the last change were restored and verified.'
      })}>Undo last change</button>
    </div>
    <p className="tv-tool-description">Blocking firmware updates also delays security fixes. Use only while no update is downloading or installing. These controls do not cancel an update in progress or change Play Store / app auto-updates. New firmware can reset them.</p>
    {message && <p role="status" className="tv-tool-status">{message}</p>}
  </section>
}
