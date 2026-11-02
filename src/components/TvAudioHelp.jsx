import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { createTvOptimizer } from '../lib/tvOptimizer'
import { createTvAudioTools } from '../lib/tvAudio'

const runAdb = args => invoke('run_adb', { args })
const audioTools = createTvAudioTools(runAdb, createTvOptimizer(runAdb).inspect)
const buttonStyle = { padding: '6px 12px', fontSize: 11 }

export default function TvAudioHelp({ serial, connected, externalBusy, onBusy }) {
  const [report, setReport] = useState(null)
  const [app, setApp] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const lock = useRef(false)
  async function action(task) {
    if (!connected || externalBusy || lock.current) return
    lock.current = true
    setBusy(true)
    onBusy(true)
    setMessage('Checking the selected TV…')
    try { await task() }
    catch (error) { setMessage(`Could not complete: ${String(error.message || error).slice(0, 400)}`) }
    finally { lock.current = false; setBusy(false); onBusy(false) }
  }
  const disabled = !connected || busy || externalBusy
  return <section aria-label="Audio sync help" style={{ marginBottom: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.7 }}>
    <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Audio lag / lip-sync help</h3>
    <p>For sound that falls behind the picture, capture a check while the delay is happening. Menu-speed optimization does not repair audio sync. These controls run only when you click them.</p>
    <button className="btn-ghost" style={buttonStyle} disabled={disabled} onClick={() => action(async () => {
      setReport(await audioTools.diagnose(serial))
      setApp('')
      setMessage('Audio check captured. No playback or audio settings were changed.')
    })}>Check Audio</button>
    {report && <div style={{ marginTop: 10 }}>
      <div>Time since restart: {report.uptimeHours == null ? 'Unavailable' : `${(report.uptimeHours / 24).toFixed(1)} days`}</div>
      <div>Audio route: {report.route} · Surround setting: {report.outputMode}</div>
      <div>Audio-buffer counters above zero: {report.nonzeroUnderrunCounters ?? 'Unavailable'} · Recent warnings: {report.unavailable.includes('Recent audio warnings') ? 'Unavailable' : report.warningCount}</div>
      <p style={{ color: 'var(--text-muted)' }}>This snapshot cannot measure lip-sync delay or prove a cause. Zero warnings do not rule out an app, decoder, HDMI, TV, or receiver issue. Raw media titles and log messages are not displayed or saved.</p>
      {!!report.unavailable.length && <p>Unavailable checks: {report.unavailable.join(', ')}.</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label>Playback app{' '}<select aria-label="Playback app to restart" disabled={disabled} value={app} onChange={e => setApp(e.target.value)}>
          <option value="">Choose the app with the delay</option>
          {report.apps.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <button className="btn-ghost" style={buttonStyle} disabled={disabled || !app} onClick={() => action(async () => setMessage(await audioTools.restartApp(serial, app)))}>Restart Playback App</button>
      </div>
      <p style={{ color: 'var(--text-muted)' }}>Restarting the selected app stops its current video and reopens the app. Its settings and sign-in data are kept.</p>
    </div>}
    <button className="btn-ghost" style={{ ...buttonStyle, marginTop: 8 }} disabled={disabled} onClick={() => action(async () => setMessage(await audioTools.restartDevice(serial)))}>Restart Selected TV / Stick</button>
    <p style={{ color: 'var(--text-muted)' }}>A device restart stops playback and briefly disconnects debugging. It is never scheduled or applied as part of Optimize.</p>
    <details><summary>Checks for a 5.1 receiver or soundbar</summary>
      <ol>
        <li>When the delay occurs, try another app or audio track. If restarting only the affected app fixes it, keep that observation for troubleshooting.</li>
        <li>Check for updates to the player, TV/stick, and receiver or soundbar.</li>
        <li>Review audio format compatibility. Temporarily test PCM stereo through the device’s sound settings; this reduces surround sound during the test. Return to your previous setting afterward.</li>
        <li>If using ARC/eARC, test the TV’s speakers or a direct HDMI connection to isolate the receiver/soundbar path. Check dialogue enhancement and volume-leveling options where available.</li>
        <li>For audio already behind the picture, adding more audio delay can make it worse. Use a player’s advance-audio adjustment only if available; a fixed offset may not suit random drift.</li>
      </ol>
      <button className="btn-ghost" style={buttonStyle} onClick={() => openUrl('https://support.google.com/chromecast/answer/15653636?hl=en')}>Google audio-sync troubleshooting ↗</button>
    </details>
    {message && <p role="status">{message}</p>}
  </section>
}
