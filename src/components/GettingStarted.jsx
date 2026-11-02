const tasks = [
  { id: 'install', title: 'Install an app', description: 'Install APK or XAPK files from your computer.' },
  { id: 'manage', title: 'Manage apps', description: 'Review installed apps, launch them, or remove extras.' },
  { id: 'backups', title: 'Back up & restore', description: 'Save a backup before making changes.' },
  { id: 'advanced', title: 'General tools', description: 'Controls and diagnostics for any connected Android device.' },
]

export default function GettingStarted({ platform, device, connectedCount, onOpenPanel }) {
  const connected = device?.status === 'device'
  return <div className="panel-content">
    <div className="panel-header-row"><div><div className="panel-header-accent" /><h1 className="panel-header">Getting Started</h1></div></div>
    <div className="panel-scroll">
      <div className="setup-intro">
        <div><h2>Connect a device. Choose a task.</h2><p>Manage apps, transfer files, and work with Android phones, TVs, streaming devices, and Quest headsets.</p></div>
        <button className="btn-primary" onClick={() => onOpenPanel('devices')}>{connected ? 'Open devices' : 'Connect a device'}</button>
      </div>
      <ol className="setup-steps">
        <li><span className="setup-step-number">1</span><div><h3>Prepare your device</h3><p>Enable Developer Options and USB debugging. For Wi-Fi, enable Wireless or Network debugging if your device offers it.</p><p className="setup-muted">Menu names vary. Setup guides are available in Help &amp; Docs and the TV / Quest sections.</p></div></li>
        <li><span className="setup-step-number">2</span><div><h3>Connect and approve</h3><p>Open Devices, choose USB or Wi-Fi, and accept this computer’s debugging prompt on the device. Pair with a code only when the device asks for one.</p>{platform === 'windows' && <button className="btn-ghost" onClick={() => onOpenPanel('drivers')}>USB not detected? Open drivers</button>}{platform === 'linux' && <button className="btn-ghost" onClick={() => onOpenPanel('help')}>USB connection help</button>}</div></li>
        <li><span className="setup-step-number">3</span><div><h3>Select it and continue</h3><p>Choose the connected device in Devices. Tools use that selection. Open Phone Tools, TV &amp; Streaming, or Quest Tools for device-specific tasks.</p><p className="setup-connection-status">{connected ? `Selected: ${device.model} · ${connectedCount} connected` : connectedCount ? `${connectedCount} connected. Select a device to continue.` : 'No device connected yet.'}</p></div></li>
      </ol>
      <h2 className="workflow-section-title">After connecting</h2>
      <div className="setup-task-grid">{tasks.map(task => <button className="setup-task-card" key={task.id} onClick={() => onOpenPanel(task.id)}><strong>{task.title}</strong><span>{task.description}</span></button>)}</div>
      <div className="setup-help-link"><span>Need setup instructions or troubleshooting?</span><button className="btn-ghost" onClick={() => onOpenPanel('help')}>Help &amp; Docs</button></div>
    </div>
  </div>
}
