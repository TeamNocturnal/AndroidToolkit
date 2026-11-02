const PACKAGE_FILE = /\.(apk|apkm|apks|xapk)$/i

export function packageFilename(path) {
  return String(path).split(/[\\/]/).pop() || 'app.apk'
}

export function addPackagePaths(queue, paths, makeId = () => crypto.randomUUID()) {
  const existing = new Set(queue.map(item => item.path))
  const fresh = paths.filter(path => typeof path === 'string' && PACKAGE_FILE.test(path) && !existing.has(path) && existing.add(path))
  return [...queue, ...fresh.map(path => ({ id: makeId(), name: packageFilename(path), path, status: 'pending', error: null }))]
}

export function downloadFilename(result) {
  return packageFilename(result.filename || `${result.pkg || result.name || 'app'}.apk`).replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function installError(result) {
  return result?.stderr?.trim() || result?.stdout?.trim() || 'Installation failed. Check the device connection and package compatibility.'
}

export function needsBrowserDownload(error) {
  return /download|HTTP|website|valid APK|Android package|unreadable response|stream error/i.test(String(error))
}

export async function installPackage({ invoke, serial, item, local = false, openLocal }) {
  if (!serial) throw new Error('Choose a connected device first')
  const remote = /^https:\/\//i.test(item.path)
  const result = remote
    ? await invoke('install_from_url', { serial, url: item.path, filename: item.name })
    : await invoke('install_app_package', { serial, path: item.path })
  if (!result?.ok) throw new Error(installError(result))
  if (local && result.localPath) {
    await openLocal(result.localPath)
    return { ...result, installerOpened: true }
  }
  return result
}

export function mapSearchResults(rows = []) {
  return rows.map((pkg, index) => ({
    id: `${pkg.source}_${index}`, name: pkg.name || pkg.packageName || 'Android app',
    pkg: pkg.packageName || pkg.repository || '', version: pkg.suggestedVersionName || '',
    date: pkg.lastUpdated ? new Date(pkg.lastUpdated * 1000).toISOString().slice(0, 10) : '',
    summary: pkg.summary || '', source: pkg.source, arch: pkg.architectures || [],
    verified: pkg.verified === true, apkUrl: pkg.apkUrl || null, pageUrl: pkg.pageUrl || null,
    filename: pkg.filename, manualReason: pkg.manualReason || '',
  }))
}
