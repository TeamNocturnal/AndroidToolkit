import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, join } from '@tauri-apps/api/path'
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { createTvOptimizer } from '../lib/tvOptimizer'
import { createTvDeviceTools, TV_SETTINGS } from '../lib/tvDeviceTools'
import TvDnsCard from './TvDnsCard'
import AndroidUpdateControls from './AndroidUpdateControls'

const runAdb = args => invoke('run_adb', { args })
const tools = createTvDeviceTools(runAdb, createTvOptimizer(runAdb).inspect)
const gib = value => value == null ? 'Unavailable' : `${(value / 1048576).toFixed(2)} GiB`

function ToolCard({ title, description, children }) {
  return <section className="tv-tool-card"><h3>{title}</h3><p className="tv-tool-description">{description}</p>{children}</section>
}

export default function TvDeviceTools({ serial, connected, externalBusy, onBusy, showUpdateControls = true }) {
  const [health, setHealth] = useState(null)
  const [network, setNetwork] = useState(null)
  const [ping, setPing] = useState(null)
  const [display, setDisplay] = useState(null)
  const [frame, setFrame] = useState(null)
  const [preview, setPreview] = useState('')
  const [status, setStatus] = useState({})
  const lock = useRef(false)
  const disabled = !connected || externalBusy

  useEffect(() => {
    if (!frame) return
    const bytes = Uint8Array.from(atob(frame), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [frame])

  async function action(section, task) {
    if (disabled || lock.current) return
    lock.current = true
    onBusy(true)
    setStatus(old => ({ ...old, [section]: 'Working…' }))
    try {
      const message = await task()
      setStatus(old => ({ ...old, [section]: message || 'Check complete. No settings changed.' }))
    } catch (error) { setStatus(old => ({ ...old, [section]: String(error.message || error).slice(0, 350) })) }
    finally { lock.current = false; onBusy(false) }
  }
  const notice = section => status[section] && <p role="status" className="tv-tool-status">{status[section]}</p>
  const unavailable = report => !!report?.unavailable.length && <p>Unavailable: {report.unavailable.join(', ')}.</p>
  const button = (label, section, task) => <button className="btn-ghost" aria-label={{ '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right' }[label] || label} disabled={disabled} onClick={() => action(section, task)}>{label}</button>

  return <div className="tv-tools-grid">
    <ToolCard title="Network check" description="Inspect the connection and test whether the device can reach the internet.">
      <div className="tv-tool-actions">
        {button('Check network', 'network', async () => { setNetwork(await tools.network(serial)) })}
        {button('Test connection', 'network', async () => { setPing(await tools.ping(serial)); return 'Ping test complete. This is not a speed test; some networks block ping.' })}
      </div>
      {network && <><dl className="tv-tool-values"><dt>IPv4</dt><dd>{network.addresses.join(' · ') || 'Not reported'}</dd>
        <dt>Gateway</dt><dd>{network.gateway || 'Not reported'}</dd><dt>Private DNS</dt><dd>{network.dnsMode}{network.dnsHostname && ` · ${network.dnsHostname}`}</dd></dl>{unavailable(network)}</>}
      {ping && <p>Packet loss: {ping.lossPercent}% · Average reply: {ping.averageMs == null ? 'No reply' : `${ping.averageMs} ms`}</p>}
      <p className="tv-tool-description">Sends three pings to Cloudflare (1.1.1.1) only when you choose Test connection.</p>
      {notice('network')}
    </ToolCard>
    <ToolCard title="Device health" description="Check storage, available memory, uptime, and Android version.">
      {button('Check device', 'health', async () => { setHealth(await tools.health(serial)) })}
      {health && <><dl className="tv-tool-values">
        <dt>Device</dt><dd>{health.manufacturer} {health.model}</dd>
        <dt>Android</dt><dd>{health.android} · API {health.sdk}</dd>
        <dt>Free storage</dt><dd>{gib(health.freeStorageKiB)}</dd>
        <dt>Available RAM</dt><dd>{gib(health.availableKiB)} / {gib(health.totalKiB)}</dd>
        <dt>Uptime</dt><dd>{health.uptimeHours == null ? 'Unavailable' : `${health.uptimeHours.toFixed(1)} hours`}</dd>
        <dt>Security patch</dt><dd>{health.securityPatch || 'Not reported'}</dd>
      </dl>{unavailable(health)}
      {button('Save health report', 'health', async () => {
        const path = await join(await downloadDir(), `TV-health-${Date.now()}.json`)
        await writeTextFile(path, JSON.stringify(health, null, 2))
        return `Saved to ${path}`
      })}</>}
      {notice('health')}
    </ToolCard>
    <ToolCard title="Remote control" description="Navigate the selected TV from this computer. Buttons affect the TV immediately.">
      <div className="tv-remote-pad">
        <span />{button('↑', 'remote', () => tools.remote(serial, 'up'))}<span />
        {button('←', 'remote', () => tools.remote(serial, 'left'))}{button('OK', 'remote', () => tools.remote(serial, 'select'))}{button('→', 'remote', () => tools.remote(serial, 'right'))}
        <span />{button('↓', 'remote', () => tools.remote(serial, 'down'))}<span />
      </div>
      <div className="tv-tool-actions">{[['Home', 'home'], ['Back', 'back'], ['Play / Pause', 'playPause'], ['Volume −', 'volumeDown'], ['Volume +', 'volumeUp'], ['Mute', 'mute']].map(([label, key]) => <button className="btn-ghost" key={key} disabled={disabled} onClick={() => action('remote', () => tools.remote(serial, key))}>{label}</button>)}</div>
      {notice('remote')}
    </ToolCard>
    <ToolCard title="Background apps" description="Ask Android to close eligible background processes when needed. Apps may restart automatically.">
      {button('Close background apps', 'background', () => tools.closeBackground(serial))}
      <p className="tv-tool-description">Background playback or other app activity may stop. This does not clear app data or change background-process limits.</p>
      {notice('background')}
    </ToolCard>
    <ToolCard title="Settings shortcuts" description="Open a settings page on the TV. Availability depends on its firmware.">
      <div className="tv-tool-actions">{Object.entries(TV_SETTINGS).map(([key, item]) => <button className="btn-ghost" key={key} disabled={disabled} onClick={() => action('settings', () => tools.settings(serial, key))}>{item.label}</button>)}</div>
      {notice('settings')}
    </ToolCard>
    <ToolCard title="Display check" description="Inspect interface resolution and scaling before making adjustments.">
      {button('Check display', 'display', async () => { setDisplay(await tools.display(serial)) })}
      {display && <><dl className="tv-tool-values"><dt>Reported size</dt><dd>{display.physicalSize || 'Unavailable'}</dd>
        <dt>Size override</dt><dd>{display.overrideSize || 'None reported'}</dd><dt>Density</dt><dd>{display.physicalDensity || 'Unavailable'}</dd>
        <dt>Density override</dt><dd>{display.overrideDensity || 'None reported'}</dd></dl>{unavailable(display)}</>}
      <p className="tv-tool-description">Android interface size is separate from HDMI output, HDR, and video resolution.</p>{notice('display')}
      <div className="tv-tool-actions">{[['4K interface', '4k'], ['1080p interface', '1080p'], ['Reset size', 'reset']].map(([label, size]) => <button className="btn-ghost" key={size} disabled={disabled} onClick={() => action('display', async () => {
        const message = await tools.resize(serial, size)
        setDisplay(await tools.display(serial))
        return message
      })}>{label}</button>)}</div>
      <p className="tv-tool-description">A 4K interface can increase rendering load. Reset size removes the size override.</p>
    </ToolCard>
    <TvDnsCard serial={serial} disabled={disabled} action={task => action('dns', task)} status={status.dns} />
    <ToolCard title="Screenshot" description="Capture the current TV screen for troubleshooting. Protected video may appear black.">
      <div className="tv-tool-actions">{button('Capture screen', 'screen', async () => {
        await tools.verify(serial)
        const result = await invoke('capture_screen_frame', { serial })
        if (!result?.ok || !result.b64) throw new Error(result?.stderr || 'Screenshot unavailable.')
        setFrame(result.b64)
        return 'Screen captured. Save a copy if you need it; captures can contain personal information.'
      })}
      {frame && button('Save PNG', 'screen', async () => {
        const path = await join(await downloadDir(), `TV-screen-${Date.now()}.png`)
        await writeFile(path, Uint8Array.from(atob(frame), char => char.charCodeAt(0)))
        return `Saved to ${path}`
      })}</div>
      {preview && <img className="tv-screen-preview" src={preview} alt="Captured TV screen" onError={() => setStatus(old => ({ ...old, screen: 'The image preview could not load. Try capturing again.' }))} />}{notice('screen')}
    </ToolCard>
    {showUpdateControls && <AndroidUpdateControls key={serial || 'no-update-device'} serial={serial} connected={connected} externalBusy={externalBusy} onBusy={onBusy} />}
  </div>
}
