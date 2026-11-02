import { useEffect, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as chooseFile } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { addPackagePaths } from '../lib/appPackages'

export default function PackageDownloadHelp({ app, onImport, onClose }) {
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)

  function accept(paths) {
    const items = addPackagePaths([], paths)
    if (!items.length) { setError('Choose an APK, APKM, APKS, or XAPK file.'); return }
    onImport(items)
  }

  useEffect(() => {
    let disposed = false
    let stop = () => {}
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter' || payload.type === 'over') setDragging(true)
      if (payload.type === 'leave') setDragging(false)
      if (payload.type === 'drop') {
        setDragging(false)
        const items = addPackagePaths([], payload.paths || [])
        if (items.length) onImport(items)
        else setError('Drop an APK, APKM, APKS, or XAPK file.')
      }
    }).then(fn => { if (disposed) fn(); else stop = fn }).catch(e => setError(String(e)))
    return () => { disposed = true; stop() }
  }, [onImport])

  async function browse() {
    try {
      const paths = await chooseFile({ multiple: true, filters: [{ name: 'Android packages', extensions: ['apk', 'apkm', 'apks', 'xapk'] }] })
      if (paths) accept(Array.isArray(paths) ? paths : [paths])
    } catch (e) { setError(String(e)) }
  }

  return <div className="package-help-overlay" onClick={onClose}>
    <section className="package-help-dialog" role="dialog" aria-modal="true" aria-labelledby="package-help-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
      <div className="panel-header-row"><h2 id="package-help-title">Download {app.name}</h2><button className="btn-ghost" autoFocus onClick={onClose} aria-label="Close download instructions">×</button></div>
      <p>{app.manualReason || 'This website requires you to finish the download in your browser.'}</p>
      <ol><li>Open the website and choose the APK or complete APK bundle for your device.</li><li>Download the file to your computer.</li><li>Return here and drop the file below, or choose Browse. Review it in Install APK, then install.</li></ol>
      <button className="btn-primary" disabled={!app.pageUrl} onClick={() => openUrl(app.pageUrl).catch(e => setError(String(e)))}>Open website ↗</button>
      <button className={`drop-zone package-import-zone${dragging ? ' drop-zone-active' : ''}`} onClick={browse}>Drop the downloaded package here<br /><span>or Browse files</span></button>
      <p className="package-update-note">Installing a newer version replaces the matching app and keeps its data. Android checks the package signature; incompatible updates remain blocked.</p>
      {error && <p role="alert" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </section>
  </div>
}
