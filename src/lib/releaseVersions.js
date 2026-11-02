export function normalizeVersionTag(version) {
  return String(version || '').trim().replace(/^v/i, '')
}

function parseComparableVersion(value) {
  const normalized = normalizeVersionTag(value).replace(/_(beta|nightly)-/gi, '-$1-')
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]?([0-9A-Za-z.-]+))?$/)
  if (!match) return null

  const prerelease = String(match[4] || '')
    .split(/[.-]/)
    .filter(Boolean)
    .map(token => (/^\d+$/.test(token) ? Number(token) : token.toLowerCase()))

  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease,
  }
}

export function compareVersions(a, b) {
  const left = parseComparableVersion(a)
  const right = parseComparableVersion(b)
  if (!left || !right) return normalizeVersionTag(a).localeCompare(normalizeVersionTag(b))

  for (const key of ['major', 'minor', 'patch']) {
    const delta = left[key] - right[key]
    if (delta !== 0) return delta
  }

  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l - r
      continue
    }
    if (typeof l === 'number') return -1
    if (typeof r === 'number') return 1
    const delta = String(l).localeCompare(String(r))
    if (delta !== 0) return delta
  }

  return 0
}

export function extractReleaseVersion(release) {
  const candidates = [
    release?.tag_name,
    release?.name,
    ...(release?.assets || []).map(asset => asset?.name),
  ].filter(Boolean)

  for (const value of candidates) {
    const match = String(value).match(/v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/i)
    if (match?.[1]) return normalizeVersionTag(match[1])
  }
  return ''
}

export function currentChannelTag(displayVersion, channel) {
  const match = String(displayVersion).match(/^(.+?)_(beta|nightly)-(\d{8}-\d{6})$/i)
  return match && match[2].toLowerCase() === channel
    ? `v${normalizeVersionTag(match[1])}-${channel}-${match[3]}`
    : ''
}

export function defaultReleaseChannel(displayVersion) {
  return currentChannelTag(displayVersion, 'nightly') ? 'nightly' : 'beta'
}

export function hasReleaseUpdate(release, channel, currentVersion, displayVersion = currentVersion) {
  if (!release) return false
  const installedTag = currentChannelTag(displayVersion, channel)
  if (installedTag) return compareVersions(extractReleaseVersion(release), installedTag) > 0
  if (channel === 'nightly') return true
  return compareVersions(extractReleaseVersion(release) || currentVersion, currentVersion) > 0
}
