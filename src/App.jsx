import { useEffect, useState, useCallback, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open as openDialog, confirm as dialogConfirm } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { readDir, readTextFile, writeTextFile, mkdir, remove, exists, stat as fsStat, copyFile } from '@tauri-apps/plugin-fs'
import { join as pathJoin, homeDir, downloadDir } from '@tauri-apps/api/path'
import './App.css'

const ANDROID_APP_ID = 'com.teamnocturnal.toolkit'
const CURRENT_VERSION = '2.0.4'
const DISPLAY_VERSION = import.meta.env.VITE_APP_BUILD_VERSION || CURRENT_VERSION
const GITHUB_RELEASES_API = 'https://api.github.com/repos/TeamNocturnal/AndroidToolkit/releases?per_page=20'
const GITHUB_RELEASES_PAGE = 'https://github.com/TeamNocturnal/AndroidToolkit/releases'
const UPDATE_CHANNEL_STORAGE_KEY = 'nocturnal_update_channel'
const UPDATE_CHANNELS = [
  { id: 'stable', label: 'Stable' },
  { id: 'nightly', label: 'Nightly' },
]

function normalizeVersionTag(version) {
  return String(version || '').trim().replace(/^v/i, '')
}

function currentNightlyTag() {
  const match = String(DISPLAY_VERSION).match(/^(\d+\.\d+\.\d+)_nightly-(\d{8}-\d{6})$/i)
  return match ? `v${match[1]}-nightly-${match[2]}` : ''
}

function compareVersions(a, b) {
  const left = normalizeVersionTag(a).split('.').map(part => parseInt(part, 10) || 0)
  const right = normalizeVersionTag(b).split('.').map(part => parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

function extractReleaseVersion(release) {
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

function pickReleaseForChannel(releases, channel) {
  if (!Array.isArray(releases)) return null
  if (channel === 'nightly') {
    return releases.find(release => (
      !release?.draft
      && (
        /^nightly-/i.test(release?.tag_name || '')
        || /nightly/i.test(release?.name || '')
      )
    )) || null
  }
  return releases.find(release => (
    !release?.draft
    && !release?.prerelease
    && /^\s*v?\d+\.\d+\.\d+/i.test(release?.tag_name || '')
  )) || null
}

function isUpdateAvailableForChannel(release, channel) {
  if (!release) return false
  const releaseVersion = extractReleaseVersion(release)
  const versionDelta = compareVersions(releaseVersion || CURRENT_VERSION, CURRENT_VERSION)
  if (channel === 'nightly') {
    const installedNightlyTag = currentNightlyTag()
    if (installedNightlyTag) {
      return normalizeVersionTag(release?.tag_name) !== normalizeVersionTag(installedNightlyTag)
    }
    return versionDelta > 0 || /^\s*v?\d+\.\d+\.\d+-nightly-/i.test(release?.tag_name || '')
  }
  return versionDelta > 0
}

async function fetchUpdateStatus(channel) {
  const response = await fetch(GITHUB_RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`)
  const releases = await response.json()
  const release = pickReleaseForChannel(releases, channel)
  const version = extractReleaseVersion(release)
  return {
    channel,
    available: isUpdateAvailableForChannel(release, channel),
    checkedAt: Date.now(),
    error: '',
    latestVersion: version,
    releaseName: release?.name || '',
    releaseTag: release?.tag_name || '',
    releaseUrl: release?.html_url || GITHUB_RELEASES_PAGE,
  }
}

function formatUpdateStatus(updateState) {
  if (updateState.status === 'checking') return 'Checking GitHub…'
  if (updateState.status === 'error') return updateState.error || 'Update check failed'
  if (!updateState.checkedAt) return 'Checks GitHub releases automatically'
  if (updateState.available) {
    return updateState.channel === 'nightly'
      ? `Nightly available${updateState.releaseTag ? ` · ${updateState.releaseTag}` : ''}`
      : 'Update available'
  }
  return updateState.channel === 'nightly'
    ? 'Nightly channel is up to date'
    : 'Stable channel is up to date'
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseBattery(stdout) {
  const m = stdout.match(/level:\s*(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

function parseDf(stdout) {
  const lines = stdout.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return null
  const parts = lines[1].trim().split(/\s+/)
  // Columns: Filesystem  1K-blocks  Used  Available  Use%  Mounted
  if (parts.length < 5) return null
  const toGb = s => Math.round(parseFloat(s) / 1024 / 1024 * 10) / 10
  const total_gb = toGb(parts[1])
  const used_gb  = toGb(parts[2])
  const avail_gb = toGb(parts[3])
  const used_pct = parseInt(parts[4].replace('%', ''), 10)
  if (isNaN(total_gb) || isNaN(used_pct)) return null
  return { used_gb, total_gb, avail_gb, used_pct }
}

function parseLsDateToken(month, day, yearOrTime) {
  if (!month || !day || !yearOrTime) return { mtime: null, label: '—' }
  const compact = `${month} ${day} ${yearOrTime}`
  const isoAttempt = Date.parse(compact)
  if (!Number.isNaN(isoAttempt)) {
    return { mtime: isoAttempt, label: compact }
  }

  const monthIndex = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .findIndex(m => m.toLowerCase() === month.toLowerCase())
  if (monthIndex === -1) return { mtime: null, label: compact }

  const now = new Date()
  let year = now.getFullYear()
  let hours = 0
  let minutes = 0

  if (yearOrTime.includes(':')) {
    const [h, m] = yearOrTime.split(':')
    hours = parseInt(h, 10) || 0
    minutes = parseInt(m, 10) || 0
    const candidate = new Date(year, monthIndex, parseInt(day, 10) || 1, hours, minutes)
    if (candidate.getTime() > now.getTime() + 86_400_000) year -= 1
  } else {
    year = parseInt(yearOrTime, 10) || year
  }

  const parsed = new Date(year, monthIndex, parseInt(day, 10) || 1, hours, minutes)
  return { mtime: Number.isNaN(parsed.getTime()) ? null : parsed.getTime(), label: compact }
}

function parseMeminfo(stdout) {
  const m = stdout.match(/MemTotal:\s*(\d+)\s*kB/i)
  if (!m) return null
  const gb = Math.round(parseInt(m[1], 10) / 1024 / 1024 * 10) / 10
  return `${gb} GB`
}

function parseResolution(stdout) {
  // dumpsys display: look for "mDisplayInfo" width x height
  const m = stdout.match(/(\d{3,4})\s*x\s*(\d{3,4})/)
  return m ? `${m[1]} × ${m[2]}` : null
}

function previewPlatformOverride() {
  try {
    const value = new URLSearchParams(window.location.search).get('preview_platform')
    if (['android', 'macos', 'windows', 'linux', 'desktop'].includes(value)) return value
  } catch {
    // Ignore malformed preview query strings.
  }
  return null
}

function isLiveViewPopupMode() {
  try {
    return new URLSearchParams(window.location.search).get('liveview_popup') === '1'
  } catch {
    // Ignore malformed popup query strings.
  }
  return false
}

function liveViewPopupSerial() {
  try {
    return new URLSearchParams(window.location.search).get('serial') || ''
  } catch {
    // Ignore malformed popup query strings.
  }
  return ''
}

function decodeBase64Bytes(value) {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + (part?.length || 0), 0)
  const next = new Uint8Array(total)
  let offset = 0
  parts.forEach(part => {
    if (!part?.length) return
    next.set(part, offset)
    offset += part.length
  })
  return next
}

function stripStartCode(unit) {
  if (unit[0] === 0 && unit[1] === 0 && unit[2] === 1) return unit.slice(3)
  if (unit[0] === 0 && unit[1] === 0 && unit[2] === 0 && unit[3] === 1) return unit.slice(4)
  return unit
}

function splitAnnexBUnits(buffer) {
  const markers = []
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      if (buffer[i + 2] === 1) {
        markers.push(i)
      } else if (buffer[i + 2] === 0 && buffer[i + 3] === 1) {
        markers.push(i)
      }
    }
  }
  if (markers.length < 2) return { units: [], remainder: buffer }
  const units = []
  for (let i = 0; i < markers.length - 1; i += 1) {
    const start = markers[i]
    const end = markers[i + 1]
    units.push(buffer.slice(start, end))
  }
  return { units, remainder: buffer.slice(markers[markers.length - 1]) }
}

function removeEmulationPrevention(bytes) {
  const out = []
  for (let i = 0; i < bytes.length; i += 1) {
    if (i >= 2 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) continue
    out.push(bytes[i])
  }
  return new Uint8Array(out)
}

function makeBitReader(bytes) {
  let bitOffset = 0
  return {
    readBit() {
      const byte = bytes[bitOffset >> 3]
      const shift = 7 - (bitOffset & 7)
      bitOffset += 1
      return (byte >> shift) & 1
    },
    readBits(count) {
      let value = 0
      for (let i = 0; i < count; i += 1) value = (value << 1) | this.readBit()
      return value
    },
    readUE() {
      let zeros = 0
      while (this.readBit() === 0) zeros += 1
      let value = 1
      for (let i = 0; i < zeros; i += 1) value = (value << 1) | this.readBit()
      return value - 1
    },
    readSE() {
      const codeNum = this.readUE()
      const sign = codeNum & 1 ? 1 : -1
      return sign * Math.ceil(codeNum / 2)
    },
  }
}

function parseSpsConfig(unit) {
  const bytes = stripStartCode(unit)
  if (!bytes?.length || (bytes[0] & 0x1f) !== 7 || bytes.length < 4) return null
  const codec = `avc1.${[bytes[1], bytes[2], bytes[3]].map(value => value.toString(16).padStart(2, '0')).join('')}`
  const rbsp = removeEmulationPrevention(bytes.slice(1))
  const reader = makeBitReader(rbsp)
  const profileIdc = reader.readBits(8)
  reader.readBits(8)
  reader.readBits(8)
  reader.readUE()

  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    const chromaFormatIdc = reader.readUE()
    if (chromaFormatIdc === 3) reader.readBit()
    reader.readUE()
    reader.readUE()
    reader.readBit()
    if (reader.readBit()) {
      const scalingCount = chromaFormatIdc !== 3 ? 8 : 12
      for (let i = 0; i < scalingCount; i += 1) {
        if (!reader.readBit()) continue
        const size = i < 6 ? 16 : 64
        let lastScale = 8
        let nextScale = 8
        for (let j = 0; j < size; j += 1) {
          if (nextScale !== 0) {
            nextScale = (lastScale + reader.readSE() + 256) % 256
          }
          lastScale = nextScale === 0 ? lastScale : nextScale
        }
      }
    }
  }

  reader.readUE()
  const picOrderCntType = reader.readUE()
  if (picOrderCntType === 0) {
    reader.readUE()
  } else if (picOrderCntType === 1) {
    reader.readBit()
    reader.readSE()
    reader.readSE()
    const count = reader.readUE()
    for (let i = 0; i < count; i += 1) reader.readSE()
  }
  reader.readUE()
  reader.readBit()
  const picWidthInMbsMinus1 = reader.readUE()
  const picHeightInMapUnitsMinus1 = reader.readUE()
  const frameMbsOnlyFlag = reader.readBit()
  if (!frameMbsOnlyFlag) reader.readBit()
  reader.readBit()
  let cropLeft = 0
  let cropRight = 0
  let cropTop = 0
  let cropBottom = 0
  if (reader.readBit()) {
    cropLeft = reader.readUE()
    cropRight = reader.readUE()
    cropTop = reader.readUE()
    cropBottom = reader.readUE()
  }
  const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * 2
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * 2
  return { codec, width, height }
}

function buildAvcDecoderConfigDescription(spsUnit, ppsUnit) {
  const sps = stripStartCode(spsUnit)
  const pps = stripStartCode(ppsUnit)
  if (!sps?.length || !pps?.length || sps.length < 4) return null

  const description = new Uint8Array(11 + sps.length + pps.length)
  let offset = 0
  description[offset++] = 1
  description[offset++] = sps[1]
  description[offset++] = sps[2]
  description[offset++] = sps[3]
  description[offset++] = 0xff
  description[offset++] = 0xe1
  description[offset++] = (sps.length >> 8) & 0xff
  description[offset++] = sps.length & 0xff
  description.set(sps, offset)
  offset += sps.length
  description[offset++] = 1
  description[offset++] = (pps.length >> 8) & 0xff
  description[offset++] = pps.length & 0xff
  description.set(pps, offset)
  return description
}

function createLiveStreamDecoder({ serial, onStatus, onFrame }) {
  const state = {
    supported: typeof window !== 'undefined' && 'VideoDecoder' in window,
    configured: false,
    decoder: null,
    remainder: new Uint8Array(0),
    accessUnit: [],
    hasVcl: false,
    latestSps: null,
    latestPps: null,
    timestampUs: 0,
    frameUs: 33_333,
  }

  if (!state.supported) {
    onStatus?.('This desktop webview does not support the VideoDecoder API.')
    return state
  }

  state.decoder = new window.VideoDecoder({
    output: frame => {
      onFrame?.(frame)
    },
    error: error => {
      state.configured = false
      onStatus?.(`Decoder error: ${error?.message || error}`)
    },
  })

  function flushAccessUnit(force = false) {
    if (!state.hasVcl || (!force && state.accessUnit.length === 0)) return
    if (!state.configured) {
      const spsConfig = state.latestSps && parseSpsConfig(state.latestSps)
      const description = buildAvcDecoderConfigDescription(state.latestSps, state.latestPps)
      if (!spsConfig || !description) return
      try {
        state.decoder.configure({
          codec: spsConfig.codec,
          description,
          optimizeForLatency: true,
          codedWidth: spsConfig.width,
          codedHeight: spsConfig.height,
        })
      } catch (error) {
        onStatus?.(`Live stream decoder unavailable; compatibility mode required: ${error?.message || error}`)
        state.accessUnit = []
        state.hasVcl = false
        return
      }
      state.configured = true
      onStatus?.(`Live stream active • ${new Date().toLocaleTimeString()}`)
    }
    const chunkData = concatBytes(...state.accessUnit)
    const isKey = state.accessUnit.some(unit => ((stripStartCode(unit)[0] || 0) & 0x1f) === 5)
    try {
      state.decoder.decode(new window.EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: state.timestampUs,
        data: chunkData,
      }))
      state.timestampUs += state.frameUs
    } catch (error) {
      onStatus?.(`Decoder rejected frame: ${error?.message || error}`)
    }
    state.accessUnit = []
    state.hasVcl = false
  }

  state.pushChunk = payload => {
    if (!payload?.data || payload.serial !== serial) return
    const next = concatBytes(state.remainder, decodeBase64Bytes(payload.data))
    const { units, remainder } = splitAnnexBUnits(next)
    state.remainder = remainder
    units.forEach(unit => {
      const nal = stripStartCode(unit)
      const nalType = nal[0] & 0x1f
      if (nalType === 7) state.latestSps = unit
      if (nalType === 8) state.latestPps = unit
      if (nalType === 5 && !state.accessUnit.length) {
        if (state.latestSps) state.accessUnit.push(state.latestSps)
        if (state.latestPps) state.accessUnit.push(state.latestPps)
      }
      if ((nalType === 1 || nalType === 5) && state.hasVcl) {
        flushAccessUnit()
      }
      state.accessUnit.push(unit)
      if (nalType === 1 || nalType === 5) state.hasVcl = true
    })
  }

  state.stop = () => {
    flushAccessUnit(true)
    state.decoder?.close()
  }

  return state
}

function parseLinuxOsRelease(text) {
  const values = {}
  String(text || '').split('\n').forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const idx = trimmed.indexOf('=')
    if (idx === -1) return
    const key = trimmed.slice(0, idx)
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  })
  return values
}

function linuxUsbSetupForDistro(osRelease) {
  const id = String(osRelease.ID || '').toLowerCase()
  const like = String(osRelease.ID_LIKE || '').toLowerCase()
  const name = osRelease.PRETTY_NAME || osRelease.NAME || 'Linux'

  if (id === 'debian' || like.includes('debian')) {
    return {
      name,
      command: `sudo apt update
sudo apt install android-sdk-platform-tools-common
sudo udevadm control --reload-rules
sudo udevadm trigger`,
      note: 'Debian provides Android USB udev rules through android-sdk-platform-tools-common.',
    }
  }

  if (id === 'arch' || like.includes('arch')) {
    return {
      name,
      command: `sudo pacman -S --needed android-udev
sudo udevadm control --reload-rules
sudo udevadm trigger`,
      note: 'Arch Linux provides Android USB udev rules through android-udev.',
    }
  }

  if (id === 'fedora' || like.includes('fedora') || like.includes('rhel')) {
    return {
      name,
      command: `sudo curl -L https://raw.githubusercontent.com/M0Rf30/android-udev-rules/master/51-android.rules -o /etc/udev/rules.d/51-android.rules
sudo chmod a+r /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload-rules
sudo udevadm trigger`,
      note: 'Fedora commonly needs a local Android udev rules file installed with admin privileges before USB adb or fastboot will work.',
    }
  }

  if (id.includes('opensuse') || like.includes('suse')) {
    return {
      name,
      command: `sudo zypper install android-udev-rules || true
sudo curl -L https://raw.githubusercontent.com/M0Rf30/android-udev-rules/master/51-android.rules -o /etc/udev/rules.d/51-android.rules
sudo chmod a+r /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload-rules
sudo udevadm trigger`,
      note: 'openSUSE package availability varies by release, so the fallback installs the maintained Android udev rules file directly.',
    }
  }

  return {
    name,
    command: `sudo curl -L https://raw.githubusercontent.com/M0Rf30/android-udev-rules/master/51-android.rules -o /etc/udev/rules.d/51-android.rules
sudo chmod a+r /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload-rules
sudo udevadm trigger`,
    note: 'Most Linux USB adb and fastboot failures come from missing udev rules. This generic fix works on many distros.',
  }
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS = {
  device:       { bg: '#1a3a1a', text: 'var(--accent-green)',  label: 'Connected' },
  unauthorized: { bg: '#3a2a0a', text: 'var(--accent-yellow)', label: 'Unauthorized' },
  offline:      { bg: '#2a1a1a', text: 'var(--accent-red)',    label: 'Offline' },
}

// ── Nav config ────────────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  {
    standalone: true,
    icon: '⭐',
    label: 'GETTING STARTED',
    items: [
      { id: 'getting-started', icon: '⭐', label: 'Getting Started' },
    ],
  },
  {
    standalone: true,
    icon: '📱',
    label: 'DEVICES',
    items: [
      { id: 'devices', icon: '📱', label: 'Connected Devices' },
    ],
  },
  {
    standalone: true,
    icon: '⚙️',
    label: 'DEVICE TOOLS',
    items: [
      { id: 'advanced', icon: '⚙️', label: 'Device Tools', badge: 'PRO' },
    ],
  },
  {
    standalone: true,
    icon: '📱',
    label: 'PHONE TOOLS',
    items: [
      { id: 'phone',    icon: '📱', label: 'Phone Tools'       },
    ],
  },
  {
    standalone: true,
    icon: '🥽',
    label: 'QUEST TOOLS',
    items: [
      { id: 'quest',    icon: '🥽', label: 'Quest Tools'       },
    ],
  },
  {
    standalone: true,
    icon: '📺',
    label: 'TV & STREAMING',
    items: [
      { id: 'tv',       icon: '📺', label: 'TV & Streaming'    },
    ],
  },
  {
    icon: '📦',
    label: 'APPS',
    items: [
      { id: 'install', icon: '📦', label: 'Install APK'  },
      { id: 'search',  icon: '🔍', label: 'Search APKs'  },
      { id: 'stores',  icon: '🏪', label: 'App Stores'   },
      { id: 'manage',  icon: '🗂️', label: 'Manage Apps'  },
      { id: 'backups',  icon: '💾', label: 'Backup & Restore'  },
    ],
  },
  {
    icon: '🧰',
    label: 'POWER TOOLS',
    items: [
      { id: 'files',    icon: '📂', label: 'File Browser'      },
      { id: 'companion', icon: '🪞', label: 'Screen Mirror' },
      { id: 'rom',      icon: '⚡', label: 'ROM Tools'         },
      { id: 'adb',      icon: '🖥️', label: 'ADB & Shell'     },
      { id: 'drivers',  icon: '🔌', label: 'Drivers'         },
    ],
  },
  {
    standalone: true,
    items: [
      { id: 'help', icon: '❓', label: 'Help & Docs' },
      { id: 'about', icon: 'ℹ️', label: 'About' },
    ],
  },
]

const ANDROID_MENU_DESCRIPTIONS = {
  'getting-started': 'Setup steps and quick links',
  install: 'Install APK and XAPK files',
  search: 'Find apps and open trusted sources',
  stores: 'Browse alternative app stores',
  manage: 'Launch, clear, and uninstall apps',
  backups: 'Toolkit backups, restore, and data exports',
  devices: 'View this device and status',
  phone: 'Phone-focused tools, tweaks, and maintenance',
  maintenance: 'Safe cleanup, storage scans, and device-care tools',
  companion: 'Live view, screenshots, and screen mirror tools',
  files: 'Browse files, move content, and manage transfers',
  adb: 'Shell commands, logs, and advanced ADB tools',
  rom: 'ROM and flashing tools',
  tv: 'TV and streaming tools',
  quest: 'Quest tools and sideloading',
  advanced: 'Root tools and advanced options',
  help: 'Setup guides and documentation',
}

const ANDROID_HIDDEN_PANELS = new Set(['drivers', 'files', 'rom', 'companion'])
const NON_WINDOWS_HIDDEN_PANELS = new Set(['drivers'])
function LinuxUsbHelperCard({ devices, ready, onOpenWireless, embedded = false, compact = false }) {
  const [linuxSetup, setLinuxSetup] = useState(() => linuxUsbSetupForDistro({}))
  const [diag, setDiag] = useState('')
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState(() => !compact)
  const usbDevices = devices.filter(d => !String(d.serial || '').includes(':'))
  const visible = usbDevices.length === 0

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    readTextFile('/etc/os-release')
      .then(text => {
        if (cancelled) return
        setLinuxSetup(linuxUsbSetupForDistro(parseLinuxOsRelease(text)))
      })
      .catch(() => {
        if (!cancelled) setLinuxSetup(linuxUsbSetupForDistro({}))
      })
    return () => {
      cancelled = true
    }
  }, [visible])

  const runDiagnostics = useCallback(async () => {
    setChecking(true)
    try {
      const [adbStart, adbDevices, fastbootDevices] = await Promise.all([
        invoke('run_adb', { args: ['start-server'] }),
        invoke('run_adb', { args: ['devices'] }),
        invoke('run_fastboot', { args: ['devices'] }),
      ])
      const blocks = [
        `$ adb start-server\n${[adbStart.stdout, adbStart.stderr].filter(Boolean).join('\n').trim() || 'ADB server started.'}`,
        `$ adb devices\n${[adbDevices.stdout, adbDevices.stderr].filter(Boolean).join('\n').trim() || 'No output'}`,
        `$ fastboot devices\n${[fastbootDevices.stdout, fastbootDevices.stderr].filter(Boolean).join('\n').trim() || 'No output'}`,
      ]
      setDiag(blocks.join('\n\n'))
    } catch (e) {
      setDiag(`Diagnostics failed.\n\n${String(e)}`)
    }
    setChecking(false)
  }, [])

  useEffect(() => {
    if (visible && !diag && !checking) runDiagnostics()
  }, [visible, diag, checking, runDiagnostics])

  if (!visible) return null

  async function copyFixCommand() {
    await navigator.clipboard.writeText(linuxSetup.command)
  }

  async function copyDiagnostics() {
    await navigator.clipboard.writeText(diag || 'No diagnostics collected yet.')
  }

  const quickSteps = [
    'Copy the command for your Linux distro.',
    'Paste it into Terminal and press Enter.',
    'Reconnect the USB cable and unlock your phone.',
  ]

  return (
    <div style={{
      margin: embedded ? '0' : '0 16px 14px',
      padding: '14px 14px 12px',
      borderRadius: 'var(--radius-md)',
      background: 'linear-gradient(135deg, rgba(245,158,11,0.10), rgba(20,184,166,0.07))',
      border: '1px solid rgba(245,158,11,0.25)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-yellow)' }}>
          Linux USB Access
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {ready ? linuxSetup.name : 'Checking devices…'}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
        Android Toolkit already includes <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>adb</code> and <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>fastboot</code> on Linux. If your phone does not appear over USB, Linux usually just needs one permissions fix.
      </div>
      {!ready && (
        <div style={{
          marginBottom: 10,
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border-subtle)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
        }}>
          Android Toolkit is still checking for connected devices. You do not need to wait here if you already know USB ADB is not working.
        </div>
      )}
      {compact ? (
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '12px 13px',
          marginBottom: 10,
        }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 8 }}>
            Fast fix for {linuxSetup.name}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginBottom: 10 }}>
            {quickSteps.map((step, index) => (
              <div key={step} style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                <span style={{ color: 'var(--accent-yellow)', fontWeight: 'var(--font-semibold)', marginRight: 6 }}>
                  {index + 1}.
                </span>
                {step}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={copyFixCommand}>Copy Fix Command</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setExpanded(value => !value)}>
              {expanded ? 'Hide Details' : 'Show Details'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={runDiagnostics} disabled={checking}>
              {checking ? 'Checking…' : 'Retry Detection'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={onOpenWireless}>Use Wireless ADB</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 10 }}>
          {[
            { step: '1', title: 'Copy the fix', body: 'Copy one command for your Linux distro.', action: () => copyFixCommand(), label: 'Copy Fix Command' },
            { step: '2', title: 'Paste into Terminal', body: 'Paste it into Terminal and press Enter. Your computer may ask for your password.', action: null, label: null },
            { step: '3', title: 'Reconnect your phone', body: 'Unplug the USB cable, plug it back in, then unlock your phone.', action: () => runDiagnostics(), label: checking ? 'Checking…' : 'Retry Detection', disabled: checking },
            { step: '4', title: 'Still stuck?', body: 'Skip USB for now and pair with Wireless ADB instead.', action: () => onOpenWireless?.(), label: 'Use Wireless ADB' },
          ].map(item => (
            <div key={item.step} style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.28)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--accent-yellow)',
                }}>
                  {item.step}
                </div>
                <div style={{ fontSize: 12, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
                  {item.title}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: item.label ? 8 : 0 }}>
                {item.body}
              </div>
              {item.label && (
                <button
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={item.action}
                  disabled={item.disabled}
                >
                  {item.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 10 }}>
        {linuxSetup.note}
      </div>
      {expanded && (
        <>
          <pre style={{
            margin: '0 0 10px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(0,0,0,0.18)',
            border: '1px solid var(--border-subtle)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: "'JetBrains Mono','Courier New',monospace",
            fontSize: 11,
            color: 'var(--text-primary)',
            lineHeight: 1.55,
          }}>
            {linuxSetup.command}
          </pre>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: diag ? 10 : 0 }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={copyFixCommand}>Copy Again</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={copyDiagnostics}>Copy Diagnostics</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={onOpenWireless}>Open Wireless ADB</button>
          </div>
        </>
      )}
      {expanded && diag && (
        <pre style={{
          margin: 0,
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border-subtle)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: "'JetBrains Mono','Courier New',monospace",
          fontSize: 11,
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
        }}>
          {diag}
        </pre>
      )}
    </div>
  )
}

function LiveVideoSurface({ serial, running, snapshotSrc = '', emptyLabel = 'Start Stream to begin live view.', maxDisplayWidth = 320, interactive = false }) {
  const canvasRef = useRef(null)
  const snapshotRef = useRef(null)
  const gestureRef = useRef(null)
  const compatibilityBusyRef = useRef(false)
  const [hasVideo, setHasVideo] = useState(false)
  const [decoderStatus, setDecoderStatus] = useState('')
  const [compatibilityMode, setCompatibilityMode] = useState(false)
  const [compatibilitySnapshotSrc, setCompatibilitySnapshotSrc] = useState('')

  const activeSnapshotSrc = compatibilitySnapshotSrc || snapshotSrc

  function activeSurfaceMetrics() {
    if (hasVideo && canvasRef.current) {
      const canvas = canvasRef.current
      return {
        node: canvas,
        width: canvas.width || 0,
        height: canvas.height || 0,
      }
    }
    if (!hasVideo && snapshotRef.current) {
      const image = snapshotRef.current
      return {
        node: image,
        width: image.naturalWidth || 0,
        height: image.naturalHeight || 0,
      }
    }
    return null
  }

  async function sendTouchCommand(args) {
    if (!serial || !interactive) return
    try {
      await invoke('run_adb', { args: ['-s', serial, 'shell', 'input', ...args.map(value => String(value))] })
    } catch (error) {
      setDecoderStatus(`Touch input failed: ${error}`)
    }
  }

  function pointerToDeviceCoords(event) {
    const metrics = activeSurfaceMetrics()
    if (!metrics?.node || !metrics.width || !metrics.height) return null
    const rect = metrics.node.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
    return {
      x: Math.round((x / rect.width) * metrics.width),
      y: Math.round((y / rect.height) * metrics.height),
    }
  }

  function handlePointerDown(event) {
    if (!interactive || !serial || !running) return
    const point = pointerToDeviceCoords(event)
    if (!point) return
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      startedAt: Date.now(),
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function handlePointerMove(event) {
    if (!interactive || !gestureRef.current || gestureRef.current.pointerId !== event.pointerId) return
    const point = pointerToDeviceCoords(event)
    if (!point) return
    gestureRef.current.endX = point.x
    gestureRef.current.endY = point.y
  }

  async function handlePointerUp(event) {
    if (!interactive || !gestureRef.current || gestureRef.current.pointerId !== event.pointerId) return
    const point = pointerToDeviceCoords(event)
    const gesture = gestureRef.current
    gestureRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const endX = point?.x ?? gesture.endX
    const endY = point?.y ?? gesture.endY
    const distance = Math.hypot(endX - gesture.startX, endY - gesture.startY)
    const duration = Math.max(80, Date.now() - gesture.startedAt)
    if (distance < 12) {
      await sendTouchCommand(['tap', gesture.startX, gesture.startY])
    } else {
      await sendTouchCommand(['swipe', gesture.startX, gesture.startY, endX, endY, duration])
    }
  }

  useEffect(() => {
    setHasVideo(false)
    setDecoderStatus('')
    setCompatibilityMode(false)
    setCompatibilitySnapshotSrc('')
    if (!serial) return undefined

    const decoder = createLiveStreamDecoder({
      serial,
      onStatus: message => {
        const nextStatus = message || ''
        setDecoderStatus(nextStatus)
        if (/(compatibility mode required|does not support the VideoDecoder API|Decoder rejected frame|Decoder error)/i.test(nextStatus)) {
          setCompatibilityMode(true)
        }
      },
      onFrame: frame => {
        const canvas = canvasRef.current
        if (!canvas) {
          frame.close()
          return
        }
        const width = frame.displayWidth || frame.codedWidth || 1
        const height = frame.displayHeight || frame.codedHeight || 1
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        const ctx = canvas.getContext('2d', { alpha: false })
        ctx?.drawImage(frame, 0, 0, width, height)
        frame.close()
        setHasVideo(true)
        setCompatibilityMode(false)
      },
    })

    let unlistenChunk
    let unlistenStatus
    listen('live-stream:chunk', event => decoder.pushChunk?.(event.payload || {})).then(fn => {
      unlistenChunk = fn
    })
    listen('live-stream:status', event => {
      const payload = event.payload || {}
      if (payload.message) setDecoderStatus(payload.message)
      if (payload.state === 'stopped') setHasVideo(false)
    }).then(fn => {
      unlistenStatus = fn
    })

    return () => {
      unlistenChunk?.()
      unlistenStatus?.()
      decoder.stop?.()
    }
  }, [serial])

  useEffect(() => {
    if (!running || !serial || hasVideo || compatibilityMode) return undefined
    const timer = window.setTimeout(() => {
      setCompatibilityMode(true)
      setDecoderStatus(current => current || 'Live decoder stalled; switching to compatibility capture mode…')
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [running, serial, hasVideo, compatibilityMode])

  useEffect(() => {
    if (!running || !serial || hasVideo || !compatibilityMode) return undefined
    let cancelled = false
    let timerId = null

    const pollFrame = async () => {
      if (cancelled || compatibilityBusyRef.current) return
      compatibilityBusyRef.current = true
      try {
        const res = await invoke('capture_screen_frame', { serial })
        if (cancelled) return
        if (!res?.ok || !res?.b64) {
          throw new Error(res?.stderr || 'Failed to capture a compatibility frame.')
        }
        const normalizedB64 = String(res.b64).trim()
        const src = normalizedB64.startsWith('data:')
          ? normalizedB64
          : `data:image/png;base64,${normalizedB64}`
        setCompatibilitySnapshotSrc(src)
        setDecoderStatus('Live stream running in compatibility capture mode.')
      } catch (error) {
        if (!cancelled) setDecoderStatus(`Compatibility capture failed: ${error}`)
      } finally {
        compatibilityBusyRef.current = false
        if (!cancelled) timerId = window.setTimeout(pollFrame, 900)
      }
    }

    pollFrame()
    return () => {
      cancelled = true
      if (timerId) window.clearTimeout(timerId)
    }
  }, [running, serial, hasVideo, compatibilityMode])

  return (
    <>
      <div style={{ minHeight: 460, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: '24px', padding: 16, position: 'relative', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            display: hasVideo ? 'block' : 'none',
            width: 'auto',
            height: 'auto',
            maxWidth: maxDisplayWidth ? `${maxDisplayWidth}px` : '100%',
            maxHeight: '100%',
            borderRadius: 20,
            border: '1px solid var(--border)',
            background: '#111',
            objectFit: 'contain',
            touchAction: interactive ? 'none' : 'auto',
            cursor: interactive && running ? 'crosshair' : 'default',
          }}
        />
        {!hasVideo && activeSnapshotSrc && (
          <img
            ref={snapshotRef}
            key={activeSnapshotSrc}
            src={activeSnapshotSrc}
            alt="Connected device preview"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              display: 'block',
              width: 'auto',
              height: 'auto',
              maxWidth: maxDisplayWidth ? `${maxDisplayWidth}px` : '100%',
              maxHeight: '100%',
              borderRadius: 20,
              border: '1px solid var(--border)',
              objectFit: 'contain',
              touchAction: interactive ? 'none' : 'auto',
              cursor: interactive && running ? 'crosshair' : 'default',
            }}
          />
        )}
        {!hasVideo && !activeSnapshotSrc && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
            {running ? 'Waiting for first video frame…' : emptyLabel}
          </div>
        )}
      </div>
      {decoderStatus && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {decoderStatus}
        </div>
      )}
      {interactive && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Click to tap, or click and drag to swipe.
        </div>
      )}
    </>
  )
}

// ── Quest Tools data ──────────────────────────────────────────────────────────

const QUEST_PACKAGES = [
  { id: 'com.oculus.horizon',       label: 'Horizon Feed',            desc: 'Social/feed system' },
  { id: 'com.facebook.horizon',     label: 'Horizon (Facebook layer)', desc: 'Facebook Horizon overlay' },
  { id: 'com.oculus.socialplatform',label: 'Social Platform',         desc: 'Friends, presence, parties' },
  { id: 'com.oculus.presence',      label: 'Presence / Online Status', desc: 'Online status broadcasting' },
  { id: 'com.facebook.services',    label: 'Facebook Background Services', desc: 'Background data sync' },
  { id: 'com.facebook.system',      label: 'Facebook System Services', desc: 'System-level FB integration' },
]

const QUEST_DNS_GROUPS = [
  {
    id: 'telemetry', label: 'Telemetry / Analytics', warn: null, defaultOn: true,
    domains: ['graph.oculus.com','analytics.facebook.com','connect.facebook.net','edge-mqtt.facebook.com','mqtt-mini.facebook.com','logging.facebook.com'],
  },
  {
    id: 'social', label: 'Presence / Social', warn: null, defaultOn: false,
    domains: ['presence.oculus.com','social.oculus.com','api.facebook.com'],
  },
  {
    id: 'auth', label: 'Auth / Account', warn: '⚠ May break login/store', defaultOn: false,
    domains: ['secure.oculus.com','auth.oculus.com','api.oculus.com'],
  },
  {
    id: 'updates', label: 'Updates / Firmware', warn: '⚠ Blocks OTA updates', defaultOn: false,
    domains: ['software.oculus.com','update.oculus.com'],
  },
  {
    id: 'media', label: 'Media / CDN', warn: null, defaultOn: false,
    domains: ['video.oculus.com','media.oculuscdn.com','cdn.oculus.com','scontent.oculuscdn.com'],
  },
]

// ── Fire TV / Streaming device data ───────────────────────────────────────────

const FIRE_TV_AMAZON_BLOAT = [
  { id: 'com.amazon.venezia',                label: 'Amazon Appstore',        desc: 'Amazon Appstore client' },
  { id: 'com.amazon.socialplatform',         label: 'Social Features',        desc: 'Amazon social layer' },
  { id: 'com.amazon.ags',                    label: 'Amazon Game Services',   desc: 'AGS SDK' },
  { id: 'com.amazon.mShop.android.shopping', label: 'Amazon Shopping',        desc: 'Amazon Shopping app' },
  { id: 'com.amazon.musicPlayerInstaller',   label: 'Amazon Music Installer', desc: 'Music app installer stub' },
  { id: 'com.audible.application',           label: 'Audible',                desc: 'Audible audiobooks' },
  { id: 'com.amazon.imdb.tv.android.app',    label: 'IMDb TV',                desc: 'IMDb streaming app' },
]
const FIRE_TV_TRACKING = [
  { id: 'com.amazon.advertising.identifierservice', label: 'Ad ID Service',          desc: 'Advertising identifier service' },
  { id: 'com.amazon.device.sync',                   label: 'Device Sync/Telemetry',  desc: 'Usage data sync to Amazon' },
]

const DEBLOAT_FILTER_PRESETS = [
  { id: 'samsung', label: 'Samsung', query: 'samsung' },
  { id: 'meta', label: 'Meta / Facebook', query: 'facebook' },
  { id: 'google', label: 'Google Extras', query: 'google.android.apps' },
  { id: 'amazon', label: 'Amazon', query: 'amazon' },
  { id: 'microsoft', label: 'Microsoft', query: 'microsoft' },
  { id: 'carrier', label: 'Carrier', query: 'verizon' },
]

const TV_DEBLOAT_FILTER_PRESETS = [
  { id: 'firetv', label: 'Fire TV', query: 'amazon' },
  { id: 'googletv', label: 'Google TV', query: 'google.android.tv' },
  { id: 'channels', label: 'Channels', query: 'channel' },
  { id: 'recommend', label: 'Recommendations', query: 'recommend' },
  { id: 'kids', label: 'Kids', query: 'kids' },
  { id: 'streaming', label: 'Streaming Promos', query: 'netflix' },
]

const DEBLOAT_RECOMMENDATION_STYLES = {
  recommended: { label: 'Recommended', color: 'var(--accent-green)', bg: 'rgba(34,197,94,0.12)' },
  advanced: { label: 'Advanced', color: 'var(--accent-yellow)', bg: 'rgba(245,158,11,0.12)' },
  caution: { label: 'Caution', color: 'var(--accent-red)', bg: 'rgba(239,68,68,0.12)' },
}

function debloatTitleFromPackage(pkg) {
  return pkg
    .split('.')
    .slice(-2)
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

function analyzeDebloatPackage(pkg, { thirdParty = false, disabled = false, manufacturer = '', model = '' } = {}) {
  const lower = pkg.toLowerCase()
  const maker = String(manufacturer || '').toLowerCase()
  const hwModel = String(model || '').toLowerCase()
  if (/(launcher|systemui|settings|telephony|provider|permissioncontroller|packageinstaller|inputmethod|imsservice|phone|dialer|bluetooth|wifihal|networkstack|framework)/.test(lower)) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'caution',
      category: 'Core system',
      reason: 'Looks tied to essential Android framework or device operation. Change only if you know the exact impact.',
      description: 'Core Android service or user-interface package.',
      safety: 'Do not remove unless you have a device-specific reason and a tested restore path.',
      impact: 'May break boot, settings, telephony, Wi-Fi, Bluetooth, installs, or the system UI.',
      warning: 'Highest-risk category.',
    }
  }
  if (/(facebook|meta|instagram|messenger|spotify|netflix|linkedin|tiktok|booking|microsoft\.office|onedrive)/.test(lower)) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'recommended',
      category: thirdParty ? 'Bundled user app' : 'Preload / marketing app',
      reason: 'Common preload or partner app that is usually safe to remove if you do not use it.',
      description: 'Partner, carrier, or manufacturer-bundled app.',
      safety: 'Usually safe to remove if you do not actively use the app.',
      impact: 'Only that app or its notifications/sign-in hooks should stop working.',
      warning: 'Reinstall may be needed if you want the app back later.',
    }
  }
  if (maker.includes('samsung')) {
    if (/(bixby|arzone|sticker|tips|gamehome|samsungpass|samsungpay|scloud|smartcapture|kidsinstaller|peel|flipboard|smartthings)/.test(lower)) {
      return {
        title: debloatTitleFromPackage(pkg),
        recommendation: 'recommended',
        category: 'Samsung optional feature',
        reason: 'Looks like a Samsung add-on or optional ecosystem app that is commonly safe to disable if unused.',
        description: 'Optional Samsung experience feature, content app, or ecosystem add-on.',
        safety: 'Generally safe if you do not use the matching Samsung feature.',
        impact: 'Can remove Samsung conveniences like Bixby, Wallet, SmartThings, cloud sync, stickers, or tips.',
        warning: 'Review if you rely on Samsung ecosystem tools.',
      }
    }
    if (/(sec.android.app.samsungapps|galaxyfinder|samsungaccount|dexonpc|oneconnect|watchmanager)/.test(lower)) {
      return {
        title: debloatTitleFromPackage(pkg),
        recommendation: 'advanced',
        category: 'Samsung ecosystem app',
        reason: 'Likely tied to a Samsung service or companion feature. Usually safe only if you do not use that Samsung feature set.',
        description: 'Samsung service app tied to account, store, watch, DeX, or device-sync features.',
        safety: 'Safe only if you know you do not use the Samsung service it belongs to.',
        impact: 'May break Galaxy Store, Samsung account sync, DeX, watch pairing, or connected accessories.',
        warning: 'Moderate risk on Samsung phones.',
      }
    }
  }
  if (maker.includes('amazon') || hwModel.includes('fire')) {
    if (/(advertising|redstone|bueller|imdb|shopping|musicplayerinstaller|ags|socialplatform)/.test(lower)) {
      return {
        title: debloatTitleFromPackage(pkg),
        recommendation: 'recommended',
        category: 'Amazon preload / ads',
        reason: 'Looks like a Fire TV or Amazon preload/ads package that is commonly removed by power users.',
        description: 'Amazon ad, storefront, shopping, or content-promotion component.',
        safety: 'Commonly removed on Fire devices by power users.',
        impact: 'Can disable promoted content, ads, or Amazon media extras.',
        warning: 'May affect storefront recommendations and some bundled media surfaces.',
      }
    }
  }
  if (/(google|onn|walmart|nvidia|sony|tcl)/.test(maker) || /(chromecast|google tv|android tv|shield|bravia|onn)/.test(hwModel)) {
    if (/(tvrecommendations|recommendation|watchnext|kidslauncher|play\.games|google\.android\.videos|google\.android\.music|youtube\.music\.tv|gamesnacks)/.test(lower)) {
      return {
        title: debloatTitleFromPackage(pkg),
        recommendation: 'recommended',
        category: 'TV content / promo app',
        reason: 'Looks like an Android TV or Google TV content, kids, media, or recommendation package that is often optional.',
        description: 'Big-screen content, recommendation, media, or kids-mode package.',
        safety: 'Usually safe to disable first if you do not use the matching media surface or recommendation rail.',
        impact: 'Can remove recommendation rows, kids experiences, or bundled media apps.',
        warning: 'Disable first so you can verify your launcher still behaves the way you want.',
      }
    }
    if (/(leanbacklauncher|tvlauncher|launcherx|tvquicksettings|dreamx|tvframeworkpackagestubs)/.test(lower)) {
      return {
        title: debloatTitleFromPackage(pkg),
        recommendation: 'caution',
        category: 'TV launcher / shell',
        reason: 'Looks tied to the Android TV launcher shell, quick settings, or TV framework package.',
        description: 'Home-screen or platform shell package for Android TV / Google TV.',
        safety: 'Do not remove unless you already have a tested replacement launcher and recovery path.',
        impact: 'May break the home screen, recommendations, settings access, or TV-specific navigation.',
        warning: 'High-risk TV package.',
      }
    }
  }
  if (/(verizon|tmobile|sprint|att|mycricket|vzw|dtignite|appselector)/.test(lower)) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'recommended',
      category: 'Carrier preload',
      reason: 'Looks like a carrier preload or app-selector package that is often safe to disable or remove for user 0.',
      description: 'Carrier setup, support, branding, or app-promo package.',
      safety: 'Usually safe to remove on unlocked or already-configured devices.',
      impact: 'May remove carrier help, promos, hotspot upsells, or account-management extras.',
      warning: 'Check first if you depend on carrier-specific visual voicemail or account tools.',
    }
  }
  if (/(amazon|bixby|samsungpass|gamehub|sticker|tips|arzone|kidsinstaller|partnerbookmark|carrier|verizon|att|tmobile|sprint)/.test(lower)) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'advanced',
      category: 'OEM / carrier feature',
      reason: 'Usually removable for power users, but it may disable an OEM feature, store, or carrier workflow.',
      description: 'Device-vendor or carrier feature package.',
      safety: 'Reasonably safe for advanced users who know the feature is unnecessary.',
      impact: 'May remove OEM convenience features, stores, help flows, or branded add-ons.',
      warning: 'Best disabled first, then remove only if the device behaves as expected.',
    }
  }
  if (thirdParty) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'recommended',
      category: 'User app',
      reason: 'User-installed package. Removing it should mainly affect that app alone.',
      description: 'Regular app installed for the current user.',
      safety: 'Generally safe to remove if you no longer use it.',
      impact: 'Only that app and its local data should be affected.',
      warning: 'Back up app data first if it matters.',
    }
  }
  if (disabled) {
    return {
      title: debloatTitleFromPackage(pkg),
      recommendation: 'advanced',
      category: 'Disabled package',
      reason: 'Already disabled for the current user. Restore is usually the safest next action if something broke.',
      description: 'Package is already disabled for user 0.',
      safety: 'Usually better to restore first and confirm behavior before changing anything else.',
      impact: 'The app is already inactive, so restoring is the low-risk action.',
      warning: 'Useful troubleshooting checkpoint if the device changed behavior earlier.',
    }
  }
  return {
    title: debloatTitleFromPackage(pkg),
    recommendation: 'advanced',
    category: 'Review manually',
    reason: 'Needs manual review. It does not match a known safe-remove pattern from Nocturnal Toolkit heuristics.',
    description: 'Unknown or device-specific package without a clear Nocturnal Toolkit match yet.',
    safety: 'Treat as review-first. Disable before deleting if you want to test.',
    impact: 'Unknown. Could be harmless, or it could belong to a feature you use.',
    warning: 'Manual review recommended before action.',
  }
}

const KODI_REPOS = [
  { id: 'crew',        name: 'The Crew Repo',   desc: 'Multi-source streaming add-ons',  url: 'https://team-crew.github.io' },
  { id: 'choromatik',  name: 'Choromatik Repo', desc: 'Netflix, Prime, Disney+ clients', url: 'https://choromatik.github.io/repo' },
  { id: 'magicdragon', name: 'Magic Dragon',    desc: 'Content aggregator add-on',       url: 'https://themagicdragon.net/repo' },
  { id: 'seren',       name: 'Seren',           desc: 'Trakt / Real-Debrid integration', url: 'https://kodiseren.github.io/repo' },
  { id: 'umbrella',    name: 'Umbrella',        desc: 'Popular all-in-one add-on',       url: 'https://a4k-openproject.github.io/a4kSubtitles/packages/' },
]

const KODI_SOURCES_PATH = '/sdcard/Android/data/org.xbmc.kodi/files/.kodi/userdata/sources.xml'

const FIRE_TV_APPS = [
  {
    id: 'matvt',
    name: 'MATVT Mouse Toggle',
    compat: '🏷 Android TV · Fire TV · ONN',
    pkg: 'io.github.virresh.matvt',
    desc: 'Open-source virtual mouse for Android TV. Use your remote as a mouse pointer to click touch-only UI elements. Essential for sideloaded apps.',
    source: 'GitHub — virresh/matvt',
    fallbackUrl: null,
  },
  {
    id: 'downloader',
    name: 'Downloader by AFTVnews',
    compat: '🏷 Fire TV Only',
    pkg: 'com.esaba.downloader',
    desc: 'The essential sideloading tool for Fire TV. Enter any URL or shortcode to download and install APKs directly on your device.',
    source: 'Amazon Appstore / aftv.news',
    fallbackUrl: 'https://www.aftv.news/how-to-install-downloader-on-fire-tv/',
  },
]

const FIRE_TV_INFO_SITES = [
  { name: 'Unlinked',   tag: 'App Store', compat: '🏷 Fire TV · Android TV', desc: 'Private app store with library codes. Enter a code to access curated app collections maintained by the community.',  url: 'https://unlinked.fun' },
  { name: 'FileSynced', tag: 'App Store', compat: '🏷 Fire TV · Android TV', desc: 'Alternative to Unlinked. Community-curated app library system with code-based access.',                             url: 'https://filesynced.com' },
  { name: 'NordVPN',    tag: 'Privacy',   compat: '🏷 All Devices',          desc: 'VPN recommended for Fire TV modding. Hides P2P traffic from your ISP. Fire TV app available via sideload or Downloader.', url: 'https://nordvpn.com' },
]

const FIRE_TV_AD_PKGS = [
  { id: 'com.amazon.avod',        label: 'Amazon Video Direct',    desc: 'Promoted video content on home screen' },
  { id: 'com.amazon.advertising', label: 'Amazon Advertising',     desc: 'Home screen ads engine' },
  { id: 'com.amazon.redstone',    label: 'Recommendations Engine', desc: 'Content recommendation ads' },
  { id: 'com.amazon.bueller',     label: 'Alexa Suggestions',      desc: 'Alexa-based ad suggestions' },
]

const TV_LAUNCHERS = [
  {
    id: 'projectivy',
    name: 'Projectivy Launcher',
    compat: '🏷 Fire TV · ONN · Shield · Mi Box',
    pkg: 'com.spocky.projengmenu',
    desc: 'Customizable ad-free Android TV launcher. Supports ONN, Shield, Mi Box, Fire TV. Dynamic colors, animated backgrounds, parental controls.',
    source: 'GitHub — spocky/miproja1',
    homeActivity: 'com.spocky.projengmenu/.MainActivity',
    fallbackUrl: null,
  },
  {
    id: 'flauncher',
    name: 'FLauncher',
    compat: '🏷 Android TV · Google TV · Chromecast',
    pkg: 'me.efesser.flauncher',
    desc: 'Open-source Flutter-based Android TV launcher. No ads, customizable categories, wallpaper support. Great for Chromecast with Google TV.',
    source: 'GitLab — flauncher/flauncher',
    homeActivity: 'me.efesser.flauncher/.MainActivity',
    fallbackUrl: null,
  },
  {
    id: 'atv-launcher',
    name: 'ATV Launcher Free',
    compat: '🏷 Android TV · Fire TV',
    pkg: 'ca.dstudio.atvlauncher.free',
    desc: 'Classic Android TV launcher with grid layout and customizable rows. Lightweight and stable.',
    source: 'APKPure — direct download blocked',
    homeActivity: 'ca.dstudio.atvlauncher.free/.MainActivity',
    fallbackUrl: 'https://apkpure.com/atv-launcher/ca.dstudio.atvlauncher.free',
  },
  {
    id: 'wolf',
    name: 'Wolf Launcher',
    compat: '🏷 Fire TV · Fire OS 6',
    pkg: null,
    desc: 'Launcher Manager for Android TV and Fire OS 6. Easily switch between launchers.',
    source: 'TechDoctorUK',
    homeActivity: null,
    fallbackUrl: 'https://www.techdoctoruk.com/launcher-manager-for-android-tv-fireos-6/',
  },
]

const MEDIA_CENTER_INFO = [
  { name: 'Real-Debrid', tag: 'Premium Service',  compat: '🏷 Works with Stremio — all devices', desc: 'Premium link resolver (~€4/mo). Pairs with Stremio + Torrentio for cached, buffer-free HD/4K streams. Highly recommended.',                                                              url: 'https://real-debrid.com' },
]

function buildKodiSourcesXml(existing, repos) {
  const blocks = repos.map(r =>
    `\n      <source>\n        <name>${r.name}</name>\n        <path pathversion="1">${r.url}</path>\n        <allowsharing>true</allowsharing>\n      </source>`
  ).join('')
  if (existing && existing.includes('<files>') && existing.includes('</files>')) {
    return existing.replace('</files>', `${blocks}\n    </files>`)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<sources>\n  <programs>\n    <default pathversion="1"></default>\n  </programs>\n  <video>\n    <default pathversion="1"></default>\n  </video>\n  <music>\n    <default pathversion="1"></default>\n  </music>\n  <pictures>\n    <default pathversion="1"></default>\n  </pictures>\n  <files>\n    <default pathversion="1"></default>${blocks}\n  </files>\n</sources>`
}

// ── Shared components ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const s = STATUS[status] ?? STATUS.offline
  return (
    <span style={{
      background: s.bg, color: s.text,
      fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)',
      padding: '2px 8px', borderRadius: 99,
      letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      {s.label}
    </span>
  )
}

function StatRow({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '9px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

function Bar({ pct, color }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 4, height: 5, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, background: color, height: '100%', borderRadius: 4, transition: 'width 0.4s' }} />
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)',
      color: 'var(--text-secondary)', letterSpacing: '0.08em',
      textTransform: 'uppercase', marginBottom: 10,
    }}>
      {children}
    </div>
  )
}

async function safeConfirmDialog(message, options) {
  try {
    return await dialogConfirm(message, options)
  } catch {
    return window.confirm(message)
  }
}

function TvDebloatPanel({ serial, noDevice, running, setRunning, append, device }) {
  const model = String(device?.model || '').toLowerCase()
  const product = String(device?.product || '').toLowerCase()
  const isFireTv = /fire/.test(model) || /fire/.test(product) || /amazon/.test(model)

  async function runPackageBatch(action, packages, label) {
    if (!serial || noDevice || running || !packages.length) return
    const ok = await safeConfirmDialog(`${label} ${packages.length} package(s)?`)
    if (!ok) return
    setRunning(true)
    append(`$ ${label} ${packages.length} package(s)`)
    try {
      for (const pkg of packages) {
        const args = action === 'restore'
          ? ['-s', serial, 'shell', 'pm', 'enable', '--user', '0', pkg]
          : ['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg]
        const res = await invoke('run_adb', { args })
        const text = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'Done.'
        append(`${pkg}: ${text}`)
      }
    } catch (error) {
      append(`Error: ${error}`)
    } finally {
      setRunning(false)
    }
  }

  const amazonExtras = FIRE_TV_AMAZON_BLOAT.map(item => item.id)
  const amazonTracking = FIRE_TV_TRACKING.map(item => item.id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        background: 'linear-gradient(135deg, rgba(20,184,166,0.09), rgba(59,130,246,0.06))',
        border: '1px solid rgba(20,184,166,0.2)',
        borderRadius: 'var(--radius-lg)',
        padding: '18px 16px',
      }}>
        <div style={{ fontSize: 20, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
          TV Debloat
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Review installed packages with TV-aware recommendations, then disable, restore, or remove user-0 packages in batches. This tab is tuned for Fire TV, Google TV, ONN, Shield, and other Android TV devices.
        </div>
      </div>

      {isFireTv && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
            Fire TV Quick Actions
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
            Fast presets for the Amazon extras already tracked elsewhere in the toolkit. These use `disable-user` so they are easier to restore later.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button className="btn-warning" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPackageBatch('disable', amazonExtras, 'Disable Fire TV extras')}>
              Disable Amazon Extras
            </button>
            <button className="btn-warning" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPackageBatch('disable', amazonTracking, 'Disable Fire TV tracking')}>
              Disable Tracking / Ads
            </button>
            <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPackageBatch('restore', amazonExtras, 'Restore Fire TV extras')}>
              Restore Extras
            </button>
            <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPackageBatch('restore', amazonTracking, 'Restore Fire TV tracking')}>
              Restore Tracking / Ads
            </button>
          </div>
          <div style={{ padding: '9px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.22)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Leave launcher and settings packages alone unless you already have a known-good alternate launcher and a recovery path.
          </div>
        </div>
      )}

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)' }}>
          <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Recommended flow</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Start with Analyze Packages, use the TV search chips to narrow the list, disable first, then only delete for user 0 after the home screen and playback apps still feel right.
          </div>
        </div>
        <DebloatWorkbench
          serial={serial}
          noDevice={noDevice}
          running={running}
          setRunning={setRunning}
          append={append}
          device={device}
          filterPresets={TV_DEBLOAT_FILTER_PRESETS}
          description="TV-aware debloat workbench with safer guidance for launchers, recommendation rails, kids surfaces, and common streaming-device extras."
        />
      </div>
    </div>
  )
}

// ── Titlebar ──────────────────────────────────────────────────────────────────

function Titlebar({ devices, scanning, onScan, theme, onTheme, platform }) {
  const connected = devices.filter(d => d.status === 'device')
  const hasDevice = connected.length > 0

  if (platform === 'android') {
    return (
      <div className="titlebar" style={{ justifyContent: 'space-between', gap: 12, padding: '0 16px', minHeight: 46, height: 46 }}>
        <span style={{
          fontSize: 'var(--text-sm)', fontWeight: 'var(--font-bold)',
          color: 'var(--text-primary)', letterSpacing: '-0.01em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          Android Toolkit
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span className="status-dot" style={{ background: hasDevice ? 'var(--accent-green)' : 'var(--text-muted)' }} />
          <span style={{ fontSize: 'var(--text-xs)', color: hasDevice ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
            {hasDevice ? `${connected.length} connected` : 'No device'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <span style={{
          fontSize: 'var(--text-sm)',
          fontWeight: 'var(--font-bold)',
          color: 'var(--text-primary)',
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          Android Toolkit {DISPLAY_VERSION}
        </span>
      </div>

      <div className="titlebar-center">
        <span className="status-dot" style={{ background: hasDevice ? 'var(--accent-green)' : 'var(--text-muted)' }} />
        <span style={{ fontSize: 'var(--text-xs)', color: hasDevice ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {hasDevice
            ? `${connected.length} connected`
            : 'No device connected'}
        </span>
      </div>

      <div className="titlebar-right">
        <div style={{ display: 'flex', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 20, padding: 2, gap: 1 }}>
          {[['dark', '🌙'], ['light', '☀️'], ['system', '💻']].map(([val, icon]) => (
            <button key={val} onClick={() => onTheme(val)} title={val.charAt(0).toUpperCase() + val.slice(1)} style={{
              background: theme === val ? 'var(--accent)' : 'transparent',
              border: 'none', borderRadius: 16, padding: '2px 7px',
              fontSize: 11, cursor: 'pointer', lineHeight: 1.4,
              color: theme === val ? '#fff' : 'var(--text-muted)',
              transition: 'background 0.15s',
            }}>{icon}</button>
          ))}
        </div>
        <span style={{
          fontSize: 'var(--text-xs)', color: 'var(--text-muted)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Android
        </span>
        <button
          className="btn-ghost"
          style={{ padding: '3px 10px', fontSize: 'var(--text-xs)' }}
          onClick={onScan}
        >
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>
    </div>
  )
}

// ── Sidebar device card ───────────────────────────────────────────────────────

function SidebarDeviceCard({ device, props, onPairDevice, currentVersion, updateChannel, onUpdateChannelChange, onUpdateAction, updateState }) {
  const updateButtonLabel = updateState.status === 'checking'
    ? 'Checking…'
    : updateState.available
      ? 'Update Available'
      : 'Check for Updates'

  const updateSection = (
    <div style={{
      marginTop: 12,
      paddingTop: 10,
      borderTop: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          flex: 1,
        }}>
          Updates
        </span>
        <select
          value={updateChannel}
          onChange={event => onUpdateChannelChange(event.target.value)}
          style={{
            width: 84,
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 10,
            fontWeight: 600,
            outline: 'none',
          }}
        >
          {UPDATE_CHANNELS.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </div>
      <button
        className="btn-ghost"
        style={{
          width: '100%',
          padding: '6px 10px',
          fontSize: 'var(--text-xs)',
          color: updateState.available ? 'var(--accent-yellow)' : undefined,
          borderColor: updateState.available ? 'rgba(245, 158, 11, 0.38)' : undefined,
          background: updateState.available ? 'rgba(245, 158, 11, 0.08)' : undefined,
        }}
        onClick={onUpdateAction}
        disabled={updateState.status === 'checking'}
      >
        {updateButtonLabel}
      </button>
      <div style={{
        fontSize: 10,
        color: updateState.status === 'error'
          ? 'var(--accent-red)'
          : updateState.available
            ? 'var(--accent-yellow)'
            : 'var(--text-muted)',
        textAlign: 'center',
        lineHeight: 1.35,
      }}>
        {formatUpdateStatus(updateState)}
      </div>
      <div style={{
        textAlign: 'center',
        fontSize: 10,
        color: 'var(--text-muted)',
        letterSpacing: '0.04em',
      }}>
        v{currentVersion}
      </div>
    </div>
  )

  if (!device) {
    return (
      <div className="sidebar-footer">
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 8, textAlign: 'center' }}>
          No device connected
        </div>
        <button className="btn-ghost" style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--text-xs)' }}
          onClick={onPairDevice}>
          Pair Device
        </button>
        {updateSection}
      </div>
    )
  }

  const { android, battery, storage } = props ?? {}
  const batteryColor = battery == null
    ? 'var(--text-muted)'
    : battery <= 15 ? 'var(--accent-red)'
    : battery <= 30 ? 'var(--accent-yellow)'
    : 'var(--accent-green)'
  const storageColor = storage?.used_pct > 90 ? 'var(--accent-red)'
    : storage?.used_pct > 75 ? 'var(--accent-yellow)'
    : 'var(--accent-green)'

  return (
    <div className="sidebar-footer">
      <div style={{
        fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)',
        color: 'var(--text-primary)', marginBottom: 2,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {device.model}
      </div>
      <div style={{
        fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
        fontFamily: 'monospace', marginBottom: 6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {device.serial}
      </div>
      {android && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 6 }}>
          Android {android} · {device.transport}
        </div>
      )}
      {battery != null && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 3 }}>
            <span>Battery</span>
            <span style={{ color: batteryColor }}>{battery}%</span>
          </div>
          <Bar pct={battery} color={batteryColor} />
        </div>
      )}
      {storage != null && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 3 }}>
            <span>Storage</span>
            <span style={{ color: storageColor }}>{storage.used_pct}%</span>
          </div>
          <Bar pct={storage.used_pct} color={storageColor} />
        </div>
      )}
      {updateSection}
    </div>
  )
}

// ── Device Tools panel ────────────────────────────────────────────────────────


function DeviceToolsPanel({ device, onNavigateToDevices, mode = 'all', platform = 'desktop', onOpenPanel: _onOpenPanel, embedded = false }) {
  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'
  const mono     = "'JetBrains Mono','Courier New',monospace"

  // ── Device pane ──────────────────────────────────────────────────────────────
  const [devPath, setDevPath]         = useState('/sdcard')
  const [devEntries, setDevEntries]   = useState([])
  const [devLoading, setDevLoading]   = useState(false)
  const [devSelected, setDevSelected]         = useState(null)
  const [devCopyClipboard, setDevCopyClipboard] = useState([])
  const [devSortKey, setDevSortKey]   = useState('name')
  const [devSortDir, setDevSortDir]   = useState('asc')

  // ── Local pane ───────────────────────────────────────────────────────────────
  const [localPath, setLocalPath]           = useState(null)
  const [showHidden, _setShowHidden]        = useState(false)
  const [localEntries, setLocalEntries]     = useState([])
  const [localLoading, setLocalLoading]     = useState(false)
  const [localSelected, setLocalSelected]         = useState(null)
  const [localCopyClipboard, setLocalCopyClipboard] = useState([])
  const [localSortKey, setLocalSortKey]     = useState('name')
  const [localSortDir, setLocalSortDir]     = useState('asc')

  // ── Transfers ────────────────────────────────────────────────────────────────
  const [transfers, setTransfers] = useState([]) // { id, name, direction, status }

  // ── Rename (device) ──────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState(null)
  const renameInputRef = useRef(null)

  // ── Context menu ─────────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, entry, pane }
  const ctxRef = useRef(null)

  // ── Section open ─────────────────────────────────────────────────────────────
  const [filesOpen,   setFilesOpen]   = useState(true)

  // Quest Tools sub-sections — all closed by default
  const [questPrivacyOpen, setQuestPrivacyOpen] = useState(true)
  const [questPerfOpen,    setQuestPerfOpen]    = useState(true)
  const [questDnsOpen,     setQuestDnsOpen]     = useState(true)
  const [questRootOpen,    setQuestRootOpen]    = useState(true)
  const [questRootStatusOpen, setQuestRootStatusOpen] = useState(true)
  const [questRootToolsOpen,  setQuestRootToolsOpen]  = useState(true)
  const [questRootUnlocksOpen,setQuestRootUnlocksOpen]= useState(true)
  const [questNoRootOpen,     setQuestNoRootOpen]     = useState(true)
  const [questTab, setQuestTab] = useState('tools')

  // Privacy packages — all checked by default
  const [questPkgChecked, setQuestPkgChecked] = useState(() => new Set(QUEST_PACKAGES.map(p => p.id)))

  // Performance levels
  const [questCpuLevel, setQuestCpuLevel] = useState(2)
  const [questGpuLevel, setQuestGpuLevel] = useState(2)

  // DNS — telemetry group pre-checked
  const [questDnsChecked,   setQuestDnsChecked]   = useState(() => new Set(QUEST_DNS_GROUPS.filter(g => g.defaultOn).flatMap(g => g.domains)))
  const [questDnsGroupOpen, setQuestDnsGroupOpen] = useState(() => Object.fromEntries(QUEST_DNS_GROUPS.map(g => [g.id, true])))

  // Quest feedback
  const [questStatus, setQuestStatus] = useState(null)
  const [questNoticeDismissed, setQuestNoticeDismissed] = useState(false)

  // ── Pixel / ROM Tools state ───────────────────────────────────────────────────
  const [pixelInfoOpen,     setPixelInfoOpen]     = useState(true)
  const [pixelBootOpen,     setPixelBootOpen]     = useState(true)
  const [pixelFlashOpen,    setPixelFlashOpen]    = useState(true)
  const [pixelSlotOpen,     setPixelSlotOpen]     = useState(true)
  const [pixelSideloadOpen, setPixelSideloadOpen] = useState(true)
  const [pixelWipeOpen,     setPixelWipeOpen]     = useState(true)
  const [pixelOutput,       setPixelOutput]       = useState('')
  const [pixelRunning,      setPixelRunning]      = useState(false)
  const [pixelFlashFiles,   setPixelFlashFiles]   = useState({ boot: '', recovery: '', vbmeta: '', system: '', factory: '' })
  const [pixelSideloadFile, setPixelSideloadFile] = useState('')
  const [pixelSlotStatus,   setPixelSlotStatus]   = useState(null)
  const [pixelConfirm,      setPixelConfirm]      = useState(null)   // { keyword, label, onConfirm }
  const [pixelConfirmInput, setPixelConfirmInput] = useState('')
  const [pixelFrpChecks,    setPixelFrpChecks]    = useState([false, false, false, false, false])
  const pixelOutputRef = useRef(null)

  // ── TV & Streaming Devices state ─────────────────────────────────────────────
  const [tvSetupOpen,    setTvSetupOpen]    = useState(true)
  const [tvFireOpen,     setTvFireOpen]     = useState(true)
  const [tvLauncherOpen, setTvLauncherOpen] = useState(true)
  const [tvGplayOpen,    setTvGplayOpen]    = useState(true)
  const [tvAndroidOpen,  setTvAndroidOpen]  = useState(true)
  const [tvIp,           setTvIp]           = useState('')
  const [tvPairIp,       setTvPairIp]       = useState('')
  const [tvPairCode,     setTvPairCode]     = useState('')
  const [tvFireChecked,       setTvFireChecked]       = useState(() => new Set())
  const [tvLauncherInstalled, setTvLauncherInstalled] = useState({})
  const [tvLauncherToast,     setTvLauncherToast]     = useState(null)
  const [tvLauncherChecking,  setTvLauncherChecking]  = useState(false)
  const [tvOutput,       setTvOutput]       = useState('')
  const [tvRunning,      setTvRunning]      = useState(false)
  const tvOutputRef = useRef(null)
  const [tvKodiOpen,   setTvKodiOpen]   = useState(true)
  const [_tvAppsOpen,   _setTvAppsOpen]   = useState(true)
  const [tvInstalling,     setTvInstalling]     = useState({})
  const [tvDlProgress,     setTvDlProgress]     = useState({})
  const [tvKodiRepos,       setTvKodiRepos]       = useState(() => new Set())
  const [tvKodiRepoBusy,    setTvKodiRepoBusy]    = useState(false)
  const [tvKodiRepoStatus,  setTvKodiRepoStatus]  = useState(null)
  const [tvKodiSourcesView, setTvKodiSourcesView] = useState(null)
  const [tvFireModOpen,      setTvFireModOpen]      = useState(true)
  const [tvFireAppInstalled, setTvFireAppInstalled] = useState({})
  const [tvFireAppToast,     setTvFireAppToast]     = useState(null)
  const [tvFireAdChecked,    setTvFireAdChecked]    = useState(() => new Set())
  const [tvFireDns,          setTvFireDns]          = useState('')
  const [tvFireDnsPreset,    setTvFireDnsPreset]    = useState('')
  const [tvDeviceFilter,     setTvDeviceFilter]     = useState('all')
  const [tvMediaInstalled,   setTvMediaInstalled]   = useState({})
  const [tvMediaInstalling,  setTvMediaInstalling]  = useState({})
  const [tvMediaProgress,    setTvMediaProgress]    = useState({})
  const [tvTab, setTvTab] = useState('tools')

  // ── ADB Setup card state ──────────────────────────────────────────────────────
  const [tvAdbSetupOpen,   setTvAdbSetupOpen]   = useState(true)
  const [tvAdbTab,         setTvAdbTab]         = useState('firetv')
  const [questAdbSetupOpen, setQuestAdbSetupOpen] = useState(true)
  const [questAdbOutput,   setQuestAdbOutput]   = useState('')

  // ── General Device Tools state ────────────────────────────────────────────────
  const [genDisplayOpen, setGenDisplayOpen] = useState(true)
  const [genPowerOpen,   setGenPowerOpen]   = useState(true)
  const [genUiOpen,      setGenUiOpen]      = useState(true)
  const [_genDebloatOpen, _setGenDebloatOpen] = useState(true)
  const [_genPerfOpen,    _setGenPerfOpen]    = useState(true)
  const [genDnsOpen,     setGenDnsOpen]     = useState(true)
  const [_genPermsOpen,   _setGenPermsOpen]   = useState(true)
  const [genOutput,      setGenOutput]      = useState('')
  const [genRunning,     setGenRunning]     = useState(false)
  const [genDpi,         setGenDpi]         = useState('')
  const [genResolution,  setGenResolution]  = useState('')
  const [genRefreshRate, setGenRefreshRate] = useState('')
  const [_genPackages,    _setGenPackages]    = useState([])
  const [_genPkgSearch,   _setGenPkgSearch]   = useState('')
  const [_genPkgLoading,  _setGenPkgLoading]  = useState(false)
  const [genCustomDns,   setGenCustomDns]   = useState('')
  const [genStatusIcons, setGenStatusIcons] = useState('alarm_clock,bluetooth,rotate,headset')
  const [_genPermPkg,     _setGenPermPkg]     = useState('')
  const [_genPermName,    _setGenPermName]    = useState('')
  const [_genForceStopPkg,_setGenForceStopPkg]= useState('')
  const [_genGrantPkg,    _setGenGrantPkg]    = useState('')
  const genOutputRef = useRef(null)

  // ── Local pane error + home boundary ─────────────────────────────────────────
  const [localError, setLocalError] = useState(null)
  const [localHome, setLocalHome]   = useState(null)   // resolved homeDir(), set once

  // ── Drag over highlight ───────────────────────────────────────────────────────
  const [localDragOver, setLocalDragOver] = useState(false)
  const [devDragOver, setDevDragOver]     = useState(false)
  const [draggedLocalFile, setDraggedLocalFile] = useState(null)
  const [draggedDeviceFile, setDraggedDeviceFile] = useState(null)

  // ── New folder ────────────────────────────────────────────────────────────────
  const [newFolderTarget, setNewFolderTarget] = useState(null) // { pane, name }
  const newFolderInputRef = useRef(null)

  // ── Transfer queue tab ────────────────────────────────────────────────────────
  const [transferTab, setTransferTab] = useState('active')

  // Auto-open the relevant section when rendering in mode-specific view
  useEffect(() => {
    if (mode === 'files')   setFilesOpen(true)
  }, [mode])

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    function dismiss(e) {
      if (ctxRef.current && !ctxRef.current.contains(e.target)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [ctxMenu])

  // Init local path to ~/ and store the home boundary
  useEffect(() => {
    homeDir().then(dir => {
      const h = dir.replace(/\/+$/, '') || '/'
      setLocalHome(h)
      setLocalPath(h)
    })
  }, [])

  // ── Load device entries ───────────────────────────────────────────────────────
  const loadDevEntries = useCallback(async (path) => {
    if (!serial) return
    setDevLoading(true)
    try {
      // Append trailing slash so ls follows symlinks (e.g. /sdcard → /storage/emulated/0)
      const lsPath = path === '/' ? '/' : path.replace(/\/?$/, '/')
      const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'ls', '-la', lsPath] })
      setDevEntries(parseLsOutput(res.stdout ?? ''))
    } catch { setDevEntries([]) }
    setDevLoading(false)
  }, [serial])

  // ── Load local entries ────────────────────────────────────────────────────────
  const loadLocalEntries = useCallback(async (path) => {
    if (!path) return
    console.log('[local] loadLocalEntries', path)
    setLocalLoading(true)
    try {
      const raw = await readDir(path)
      const entries = await Promise.all(
        raw.filter(e => e.name && (showHidden || !e.name.startsWith('.'))).map(async e => {
          let size = null, mtime = null, restricted = false
          try {
            const s = await fsStat(await pathJoin(path, e.name))
            size = s.size ?? null
            mtime = s.mtime ?? null
          } catch (serr) {
            const sm = String(serr).toLowerCase()
            restricted = sm.includes('permission') || sm.includes('denied') || sm.includes('os error 1')
          }
          return {
            name: e.name,
            type: e.isDirectory ? 'dir' : e.isSymlink ? 'symlink' : 'file',
            size, mtime, restricted,
          }
        })
      )
      setLocalEntries(entries.sort((a, b) => {
        const aD = a.type !== 'file', bD = b.type !== 'file'
        if (aD !== bD) return aD ? -1 : 1
        return a.name.localeCompare(b.name)
      }))
      setLocalError(null)
    } catch {
      setLocalEntries([])
      setLocalError(null)
      // Any failure → bounce back to home so we never get stuck
      homeDir().then(dir => setLocalPath(dir.replace(/\/+$/, '') || '/'))
    }
    setLocalLoading(false)
  }, [showHidden])

  useEffect(() => { if (serial && filesOpen) loadDevEntries(devPath) }, [serial, devPath, filesOpen, loadDevEntries])
  useEffect(() => { if (localPath && filesOpen) loadLocalEntries(localPath) }, [localPath, filesOpen, showHidden, loadLocalEntries])

  useEffect(() => {
    if (!tvLauncherOpen || !serial) return
    setTvLauncherChecking(true)
    ;(async () => {
      const result = {}
      for (const l of TV_LAUNCHERS) {
        if (!l.pkg) { result[l.id] = false; continue }
        try {
          const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'path', l.pkg] })
          result[l.id] = (r.stdout || '').includes('package:')
        } catch { result[l.id] = false }
      }
      setTvLauncherInstalled(result)
      setTvLauncherChecking(false)
    })()
  }, [tvLauncherOpen, serial])

  useEffect(() => {
    if (!tvFireModOpen || !serial) return
    ;(async () => {
      const result = {}
      for (const app of FIRE_TV_APPS) {
        if (!app.pkg) { result[app.id] = false; continue }
        try {
          const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'path', app.pkg] })
          result[app.id] = (r.stdout || '').includes('package:')
        } catch { result[app.id] = false }
      }
      setTvFireAppInstalled(result)
    })()
  }, [tvFireModOpen, serial])

  useEffect(() => {
    if (!tvKodiOpen || !serial) return
    ;(async () => {
      const checks = [
        { id: 'smarttube', pkg: 'com.liskovsoft.smarttube.alt' },
        { id: 'stremio',   pkg: 'com.stremio.one' },
        { id: 'cloudstream', pkg: 'com.lagradost.cloudstream3' },
        { id: 'dodostream', pkg: 'app.dodora.dodostream' },
        { id: 'debridstream', pkg: 'com.debridstream.tv' },
        { id: 'debrify', pkg: 'com.debrify.app' },
        { id: 'strmr', pkg: 'com.strmr.ps' },
        { id: 'wuplay', pkg: 'app.wuplay.androidtv' },
        { id: 'tizentube-cobalt', pkg: 'io.gh.reisxd.tizentube.cobalt' },
        { id: 'nuviotv', pkg: 'com.nuvio.tv' },
        { id: 'arvio', pkg: 'com.arvio.tv' },
        { id: 'weyd', pkg: 'app.weyd.player' },
        { id: 'lumera', pkg: 'com.lumera.app' },
        { id: 'syncler', pkg: 'com.syncler' },
        { id: 'vlc',       pkg: 'org.videolan.vlc' },
      ]
      const result = {}
      for (const { id, pkg } of checks) {
        try {
          const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'path', pkg] })
          result[id] = (r.stdout || '').includes('package:')
        } catch { result[id] = false }
      }
      setTvMediaInstalled(result)
    })()
  }, [tvKodiOpen, serial])

  // ── Sort ──────────────────────────────────────────────────────────────────────
  function sortEntries(entries, key, dir) {
    return [...entries].sort((a, b) => {
      let r = 0
      if (key === 'name') r = a.name.localeCompare(b.name)
      else if (key === 'size') r = (parseInt(a.size) || 0) - (parseInt(b.size) || 0)
      else if (key === 'type') r = a.type.localeCompare(b.type)
      else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0)
      return dir === 'asc' ? r : -r
    })
  }

  function toggleSort(key, current, setKey, setDir) {
    if (current === key) setDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setKey(key); setDir('asc') }
  }

  // ── Device navigation ─────────────────────────────────────────────────────────
  function devNavigateTo(name) {
    setDevPath(p => (p === '/' ? '' : p.replace(/\/$/, '')) + '/' + name)
    setDevSelected(null)
  }
  function devNavigateUp() {
    const parts = devPath.split('/').filter(Boolean)
    parts.pop()
    setDevPath(parts.length ? '/' + parts.join('/') : '/')
    setDevSelected(null)
  }
  function devRemotePath(name) {
    return (devPath === '/' ? '' : devPath.replace(/\/$/, '')) + '/' + name
  }

  // Device breadcrumb segments
  const devPathParts = devPath === '/'
    ? [{ label: '/', target: '/' }]
    : [{ label: '/', target: '/' }, ...devPath.split('/').filter(Boolean).map((p, i, arr) => ({
        label: p, target: '/' + arr.slice(0, i + 1).join('/')
      }))]

  // Local breadcrumb segments
  // Normalize path: remove trailing slash except for root
  const normLocal = !localPath ? '/' : (localPath !== '/' ? localPath.replace(/\/+$/, '') : '/')
  // Up is blocked when we're at home or above it
  const localIsRoot = !normLocal || !localHome || normLocal === localHome
  const localPathParts = (() => {
    if (!normLocal) return []
    const isWin = /^[A-Za-z]:/.test(normLocal)
    if (isWin) {
      const parts = normLocal.replace(/\\/g, '/').split('/').filter(Boolean)
      return parts.map((p, i, arr) => ({
        label: p,
        target: arr.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : ''),
      }))
    } else {
      const parts = normLocal.split('/').filter(Boolean)
      return [
        { label: '/', target: '/' },
        ...parts.map((p, i, arr) => ({
          label: p,
          target: '/' + arr.slice(0, i + 1).join('/'),
        })),
      ]
    }
  })()

  // ── Local navigation ──────────────────────────────────────────────────────────
  async function localNavigateTo(name) {
    const next = await pathJoin(localPath, name)
    console.log('[local] navigate into', next)
    setLocalPath(next)
    setLocalSelected(null)
  }
  async function localNavigateUp() {
    if (!localPath || !localHome) return
    const cur = localPath.replace(/\/+$/, '') || '/'
    if (cur === localHome) { console.log('[local] navigate up: already at home boundary', cur); return }
    const parent = await pathJoin(cur, '..')
    const norm = parent.replace(/\/+$/, '') || '/'
    console.log('[local] navigate up', cur, '->', norm)
    setLocalPath(norm)
    setLocalSelected(null)
  }

  // ── Transfers ─────────────────────────────────────────────────────────────────
  async function pullToLocal(entry) {
    const snapLocalPath = localPath   // snapshot before any await
    const remotePath = devRemotePath(entry.name)
    const localDest  = await pathJoin(snapLocalPath, entry.name)
    const tid = Date.now()
    setTransfers(ts => [...ts, { id: tid, name: entry.name, localPath: localDest, remotePath, size: entry.size ?? null, direction: 'pull', status: 'active' }])
    try {
      await invoke('run_adb', { args: ['-s', serial, 'pull', remotePath, localDest] })
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'done' } : t)))
      console.log('[pull] done, refreshing local pane at', snapLocalPath)
      loadLocalEntries(snapLocalPath)
    } catch {
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'error' } : t)))
    }
  }

  async function pushToDevice(entry) {
    const snapDevPath = devPath       // snapshot before any await
    const localSrc   = await pathJoin(localPath, entry.name)
    const remoteDest = devRemotePath(entry.name)
    const tid = Date.now()
    setTransfers(ts => [...ts, { id: tid, name: entry.name, localPath: localSrc, remotePath: remoteDest, size: entry.size ?? null, direction: 'push', status: 'active' }])
    try {
      await invoke('run_adb', { args: ['-s', serial, 'push', localSrc, remoteDest] })
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'done' } : t)))
      console.log('[push] done, refreshing device pane at', snapDevPath)
      loadDevEntries(snapDevPath)
    } catch {
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'error' } : t)))
    }
  }

  // ── Transfer helpers ──────────────────────────────────────────────────────────
  function trimTransfers(ts) {
    const active = ts.filter(t => t.status === 'active')
    const done   = ts.filter(t => t.status !== 'active').slice(-5)
    return [...active, ...done]
  }

  // Push a raw filesystem path (from OS drag-drop) to device
  async function pushPathToDevice(localFilePath) {
    const fileName   = localFilePath.split(/[/\\]/).pop()
    const remoteDest = devRemotePath(fileName)
    const tid = Date.now()
    setTransfers(ts => [...ts, { id: tid, name: fileName, localPath: localFilePath, remotePath: remoteDest, size: null, direction: 'push', status: 'active' }])
    try {
      await invoke('run_adb', { args: ['-s', serial, 'push', localFilePath, remoteDest] })
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'done' } : t)))
      loadDevEntries(devPath)
    } catch {
      setTransfers(ts => trimTransfers(ts.map(t => t.id === tid ? { ...t, status: 'error' } : t)))
    }
  }

  // ── Copy / Paste ──────────────────────────────────────────────────────────────
  async function localPaste() {
    if (!localCopyClipboard.length || !localPath) return
    for (const src of localCopyClipboard) {
      const name = src.replace(/\\/g, '/').split('/').pop()
      const dst = await pathJoin(localPath, name)
      try { await copyFile(src, dst) } catch (e) { console.error('[local paste] failed', src, e) }
    }
    setLocalCopyClipboard([])
    loadLocalEntries(localPath)
  }

  async function devPaste() {
    if (!devCopyClipboard.length || !serial) return
    for (const src of devCopyClipboard) {
      const name = src.replace(/\\/g, '/').split('/').pop()
      const dst = (devPath === '/' ? '' : devPath.replace(/\/$/, '')) + '/' + name
      try { await invoke('run_adb', { args: ['-s', serial, 'push', src, dst] }) }
      catch (e) { console.error('[dev paste] failed', src, e) }
    }
    setDevCopyClipboard([])
    loadDevEntries(devPath)
  }

  // Create a new folder in local or device pane
  async function createNewFolder(pane, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      if (pane === 'local') {
        await mkdir(await pathJoin(localPath, trimmed), { recursive: false })
        loadLocalEntries(localPath)
      } else {
        await invoke('run_adb', { args: ['-s', serial, 'shell', 'mkdir', '-p', devRemotePath(trimmed)] })
        loadDevEntries(devPath)
      }
    } catch {
      // Folder creation errors are surfaced by the unchanged file list.
    }
  }

  // ── Device rename / delete ────────────────────────────────────────────────────
  async function submitRename() {
    if (!renameTarget) return
    const { entry, newName } = renameTarget
    setRenameTarget(null)
    if (!newName.trim() || newName.trim() === entry.name) return
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'mv', devRemotePath(entry.name), devRemotePath(newName.trim())] })
    loadDevEntries(devPath)
  }

  async function devDeleteEntry(entry) {
    if (!await dialogConfirm(`Delete "${entry.name}"? This cannot be undone.`, { title: 'Confirm Delete', kind: 'warning' })) return
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'rm', '-rf', devRemotePath(entry.name)] })
    loadDevEntries(devPath)
  }

  // ── Local delete / open ───────────────────────────────────────────────────────
  async function localDeleteEntry(entry) {
    if (!await dialogConfirm(`Delete "${entry.name}"? This cannot be undone.`, { title: 'Confirm Delete', kind: 'warning' })) return
    await remove(await pathJoin(localPath, entry.name), { recursive: true })
    loadLocalEntries(localPath)
  }

  async function openInFinder(entry) {
    const p = await pathJoin(localPath, entry.name)
    await invoke('open_in_finder', { path: p })
  }

  async function uploadFilesToDevice() {
    if (noDevice) return
    const files = await openDialog({ multiple: true })
    if (!files) return
    const picked = Array.isArray(files) ? files : [files]
    for (const file of picked) {
      if (typeof file !== 'string') continue
      const name = file.split('/').pop()
      if (!name) continue
      const remoteDest = (devPath === '/' ? '' : devPath.replace(/\/$/, '')) + '/' + name
      await invoke('run_adb', { args: ['-s', serial, 'push', file, remoteDest] })
    }
    loadDevEntries(devPath)
  }

  async function revealCurrentLocalFolder() {
    if (!localPath) return
    await invoke('open_in_finder', { path: localPath })
  }

  async function copyCurrentPanePath(pane) {
    const path = pane === 'local' ? localPath : devPath
    if (!path) return
    await navigator.clipboard.writeText(path)
  }

  async function pullSelectedDeviceEntry() {
    const entry = devEntries.find(x => x.name === devSelected)
    if (entry) await pullToLocal(entry)
  }

  async function pushSelectedLocalEntry() {
    const entry = localEntries.find(x => x.name === localSelected)
    if (entry) await pushToDevice(entry)
  }

  // ── Pixel / ROM helpers ───────────────────────────────────────────────────────
  function pixelAppend(line) {
    setPixelOutput(o => o + line)
    setTimeout(() => { if (pixelOutputRef.current) pixelOutputRef.current.scrollTop = pixelOutputRef.current.scrollHeight }, 30)
  }
  async function pixelRunFastboot(args) {
    setPixelRunning(true)
    pixelAppend(`\n$ fastboot ${args.join(' ')}\n`)
    try {
      const r = await invoke('run_fastboot', { args })
      pixelAppend(([r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)') + '\n')
      return r
    } catch (e) { pixelAppend(`Error: ${e}\n`) }
    finally { setPixelRunning(false) }
  }
  async function pixelRunAdb(args) {
    setPixelRunning(true)
    pixelAppend(`\n$ adb ${args.join(' ')}\n`)
    try {
      const r = await invoke('run_adb', { args })
      pixelAppend(([r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)') + '\n')
      return r
    } catch (e) { pixelAppend(`Error: ${e}\n`) }
    finally { setPixelRunning(false) }
  }
  function pixelAskConfirm({ keyword, label, onConfirm }) {
    setPixelConfirmInput('')
    setPixelConfirm({ keyword, label, onConfirm })
  }

  // ── General Device Tools helpers ──────────────────────────────────────────────
  function genAppend(line) {
    setGenOutput(o => o + line)
    setTimeout(() => { if (genOutputRef.current) genOutputRef.current.scrollTop = genOutputRef.current.scrollHeight }, 30)
  }
  async function genRun(args) {
    setGenRunning(true)
    genAppend(`\n$ adb ${args.join(' ')}\n`)
    try {
      const r = await invoke('run_adb', { args })
      genAppend(([r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)') + '\n')
      return r
    } catch (e) { genAppend(`Error: ${e}\n`) }
    finally { setGenRunning(false) }
  }
  // ── TV & Streaming helpers ────────────────────────────────────────────────────
  function tvAppend(line) {
    setTvOutput(o => o + line)
    setTimeout(() => { if (tvOutputRef.current) tvOutputRef.current.scrollTop = tvOutputRef.current.scrollHeight }, 30)
  }
  function tvShowFor(devices) {
    if (devices.includes('all')) return true
    const groups = {
      all: ['firetv', 'onn', 'shield', 'googletv', 'sonytcl'],
      firetv: ['firetv'],
      androidtv: ['onn', 'shield', 'googletv', 'sonytcl'],
    }
    const visibleDevices = groups[tvDeviceFilter] || groups.all
    return devices.some(device => visibleDevices.includes(device))
  }
  async function tvRun(args) {
    setTvRunning(true)
    tvAppend(`\n$ adb ${args.join(' ')}\n`)
    try {
      const r = await invoke('run_adb', { args })
      tvAppend(([r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)') + '\n')
      return r
    } catch (e) { tvAppend(`Error: ${e}\n`) }
    finally { setTvRunning(false) }
  }
  async function tvInstallFromUrl(id, url, filename) {
    if (!serial) { tvAppend('No device connected\n'); return }
    setTvInstalling(s => ({ ...s, [id]: 'downloading' }))
    const unlisten = await listen('install:progress', e => {
      if (e.payload?.store !== filename) return
      const { phase, percent, speed } = e.payload
      if (phase === 'downloading') {
        setTvInstalling(s => ({ ...s, [id]: 'downloading' }))
        setTvDlProgress(s => ({ ...s, [id]: { percent, speed } }))
      } else if (phase === 'installing') {
        setTvInstalling(s => ({ ...s, [id]: 'installing' }))
        setTvDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      }
    })
    tvAppend(`\n$ install ${filename}\n`)
    try {
      const res = await invoke('install_from_url', { serial, url, filename })
      setTvInstalling(s => ({ ...s, [id]: res.ok ? 'done' : 'error' }))
      setTvDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      tvAppend(res.ok ? `✓ Installed ${filename}\n` : `✗ Failed: ${(res.stderr || '').trim()}\n`)
    } catch (e) {
      setTvInstalling(s => ({ ...s, [id]: 'error' }))
      setTvDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      tvAppend(`Error: ${e}\n`)
    } finally { unlisten() }
  }
  async function tvResolveLauncherApk(id) {
    if (id === 'projectivy') {
      const r    = await fetch('https://api.github.com/repos/spocky/miproja1/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name.startsWith('ProjectivyLauncher') && a.name.endsWith('.apk'))
      if (!asset) throw new Error('No APK asset found in GitHub release')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'flauncher') {
      const r    = await fetch('https://gitlab.com/api/v4/projects/26632151/releases?per_page=1')
      const data = await r.json()
      const link = data[0]?.assets?.links?.find(l => l.name?.endsWith('.apk'))
      if (!link) throw new Error('No APK link found in GitLab release')
      return { url: link.direct_asset_url || link.url, filename: link.name }
    }
    throw new Error(`No APK resolver for launcher: ${id}`)
  }

  async function tvResolveFireAppApk(id) {
    if (id === 'smarttube-stable') {
      const abi = await tvGetDeviceAbi()
      const ABI_PATTERNS = {
        'arm64-v8a': /SmartTube_(?:stable|beta)_.*arm64-v8a\.apk$/i,
        'armeabi-v7a': /SmartTube_(?:stable|beta)_.*armeabi-v7a\.apk$/i,
        'x86_64': /SmartTube_(?:stable|beta)_.*x86_64?\.apk$/i,
        'x86': /SmartTube_(?:stable|beta)_.*x86\.apk$/i,
      }
      const r = await fetch('https://api.github.com/repos/yuliskov/SmartTube/releases')
      const releases = await r.json()
      const rel = releases.find(x => x.tag_name?.endsWith('s') || x.name?.toLowerCase().includes('stable'))
               || releases.find(x => /beta/i.test(x.name || '') || /beta/i.test(x.tag_name || ''))
               || releases[0]
      if (!rel) throw new Error('No SmartTube release found')
      const asset = rel.assets?.find(a => ABI_PATTERNS[abi]?.test(a.name))
                 || rel.assets?.find(a => /SmartTube_(?:stable|beta)_.*universal\.apk$/i.test(a.name))
                 || rel.assets?.find(a => /SmartTube_(?:stable|beta)_.*arm64-v8a\.apk$/i.test(a.name))
                 || rel.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No SmartTube stable APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'matvt') {
      const r = await fetch('https://api.github.com/repos/virresh/matvt/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => /tv/i.test(a.name) && a.name.endsWith('.apk') && !/phone/i.test(a.name))
                 || data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No MATVT APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    throw new Error(`No APK resolver for Fire TV app: ${id}`)
  }

  async function tvResolveStremioApk() {
    const abi = await tvGetDeviceAbi()
    const APKS = {
      'arm64-v8a':   { url: 'https://dl.strem.io/android/v1.9.12-androidTV/com.stremio.one-1.9.12-13146380-arm64-v8a.apk', filename: 'com.stremio.one-1.9.12-arm64-v8a.apk' },
      'armeabi-v7a': { url: 'https://dl.strem.io/android/v1.9.12-androidTV/com.stremio.one-1.9.12-11049228-armeabi-v7a.apk', filename: 'com.stremio.one-1.9.12-armeabi-v7a.apk' },
      'x86_64':      { url: 'https://dl.strem.io/android/v1.9.12-androidTV/com.stremio.one-1.9.12-14194956-x86_64.apk', filename: 'com.stremio.one-1.9.12-x86_64.apk' },
      'x86':         { url: 'https://dl.strem.io/android/v1.9.12-androidTV/com.stremio.one-1.9.12-12097804-x86.apk', filename: 'com.stremio.one-1.9.12-x86.apk' },
    }
    return APKS[abi] || APKS['arm64-v8a']
  }

  async function tvGetDeviceAbi() {
    const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi'] })
    return (r.stdout || '').trim() || 'arm64-v8a'
  }

  async function tvResolveMediaApk(id) {
    if (id === 'cloudstream') {
      const r = await fetch('https://api.github.com/repos/recloudstream/cloudstream/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No Cloudstream APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'dodostream') {
      const abi = await tvGetDeviceAbi()
      const ABI_PATTERNS = {
        'arm64-v8a': /production_tv-arm64-v8a\.apk$/i,
        'armeabi-v7a': /production_tv-armeabi-v7a\.apk$/i,
        'x86_64': /production_tv-x86_64\.apk$/i,
        'x86': /production_tv-x86\.apk$/i,
      }
      const r = await fetch('https://api.github.com/repos/DodoraApp/DodoStream/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => ABI_PATTERNS[abi]?.test(a.name))
                 || data.assets?.find(a => /production_tv-arm64-v8a\.apk$/i.test(a.name))
                 || data.assets?.find(a => /production_tv-.*\.apk$/i.test(a.name))
      if (!asset) throw new Error('No DodoStream TV APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'debridstream') {
      return { url: 'https://github.com/codebutter-bit/scraper/releases/download/v2.0.0/v2dbs.apk', filename: 'v2dbs.apk' }
    }
    if (id === 'debrify') {
      const r = await fetch('https://api.github.com/repos/varunsalian/debrify/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No Debrify APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'strmr') {
      const r = await fetch('https://api.github.com/repos/strmrdev/strmr-releases/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name === 'STRMR-latest.apk')
                 || data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No STRMR APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'wuplay') {
      const r = await fetch('https://api.github.com/repos/me-here-now/wuplay-releases/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => /androidtv/i.test(a.name) && a.name.endsWith('.apk'))
                 || data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No WuPlay APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'tizentube-cobalt') {
      const abi = await tvGetDeviceAbi()
      const ABI_PATTERNS = {
        'arm64-v8a': /arm64\.apk$/i,
        'armeabi-v7a': /arm\.apk$/i,
      }
      const r = await fetch('https://api.github.com/repos/reisxd/TizenTubeCobalt/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => ABI_PATTERNS[abi]?.test(a.name))
                 || data.assets?.find(a => /arm64\.apk$/i.test(a.name))
                 || data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No TizenTube Cobalt APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'nuviotv') {
      const abi = await tvGetDeviceAbi()
      const ABI_PATTERNS = {
        'arm64-v8a': /arm64-v8a-release\.apk$/i,
        'armeabi-v7a': /armeabi-v7a-release\.apk$/i,
        'x86_64': /x86_64-release\.apk$/i,
        'x86': /x86-release\.apk$/i,
      }
      const r = await fetch('https://api.github.com/repos/NuvioMedia/NuvioTV/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => ABI_PATTERNS[abi]?.test(a.name))
                 || data.assets?.find(a => /universal-release\.apk$/i.test(a.name))
                 || data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No NuvioTV APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'arvio') {
      const r = await fetch('https://api.github.com/repos/ProdigyV21/ARVIO/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No ARVIO APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'weyd') {
      return { externalUrl: 'https://weyd.app/', filename: 'weyd.apk' }
    }
    if (id === 'lumera') {
      const r = await fetch('https://api.github.com/repos/LumeraD3v/Lumera/releases/latest')
      const data = await r.json()
      const asset = data.assets?.find(a => a.name.endsWith('.apk'))
      if (!asset) throw new Error('No Lumera APK found')
      return { url: asset.browser_download_url, filename: asset.name }
    }
    if (id === 'syncler') {
      return { url: 'https://syncler.net/d', filename: 'Syncler.apk' }
    }
    if (id === 'vlc') {
      const abi = await tvGetDeviceAbi()
      const ABI_FILENAMES = {
        'arm64-v8a': 'VLC-Android-3.7.0-arm64-v8a.apk',
        'armeabi-v7a': 'VLC-Android-3.7.0-armeabi-v7a.apk',
        'x86_64': 'VLC-Android-3.7.0-x86_64.apk',
        'x86': 'VLC-Android-3.7.0-x86.apk',
      }
      const filename = ABI_FILENAMES[abi] || ABI_FILENAMES['arm64-v8a']
      return {
        url: `https://download.videolan.org/pub/videolan/vlc-android/3.7.0/${filename}`,
        filename,
      }
    }
    throw new Error(`No resolver for media app: ${id}`)
  }

  async function tvInstallMediaApp(id, url, filename) {
    if (!serial) { tvAppend('No device connected\n'); return }
    setTvMediaInstalling(s => ({ ...s, [id]: 'downloading' }))
    const unlisten = await listen('install:progress', e => {
      if (e.payload?.store !== filename) return
      const { phase, percent, speed } = e.payload
      if (phase === 'downloading') {
        setTvMediaInstalling(s => ({ ...s, [id]: 'downloading' }))
        setTvMediaProgress(s => ({ ...s, [id]: { percent, speed } }))
      } else if (phase === 'installing') {
        setTvMediaInstalling(s => ({ ...s, [id]: 'installing' }))
        setTvMediaProgress(s => { const n = { ...s }; delete n[id]; return n })
      }
    })
    try {
      const res = await invoke('install_from_url', { serial, url, filename })
      setTvMediaInstalling(s => ({ ...s, [id]: res?.ok ? 'done' : 'error' }))
      setTvMediaProgress(s => { const n = { ...s }; delete n[id]; return n })
      if (res?.ok) {
        setTvMediaInstalled(s => ({ ...s, [id]: true }))
        tvAppend(`✓ ${filename} installed\n`)
      } else {
        tvAppend(`✗ Failed: ${(res?.stderr || res?.stdout || 'Install failed').trim()}\n`)
      }
    } catch (e) {
      setTvMediaInstalling(s => ({ ...s, [id]: 'error' }))
      setTvMediaProgress(s => { const n = { ...s }; delete n[id]; return n })
      tvAppend(`Error: ${e}\n`)
    } finally { unlisten() }
  }

  async function _genFetchPackages() {
    if (!serial) return
    _setGenPkgLoading(true)
    try {
      const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages'] })
      const pkgs = (r.stdout || '').split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean).sort()
      _setGenPackages(pkgs)
    } catch {
      // Package list is optional in the current general-tools flow.
    }
    _setGenPkgLoading(false)
  }
  async function genSetAnimScale(val) {
    for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', key, String(val)])
    }
  }
  async function genSetDns(mode, specifier) {
    await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'private_dns_mode', mode])
    if (specifier) await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'private_dns_specifier', specifier])
  }
  async function genSetLowPower(enabled) {
    await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'low_power', enabled ? '1' : '0'])
  }
  async function genSetStatusBarIcons(value) {
    const trimmed = String(value || '').trim()
    if (!trimmed) {
      await genRun(['-s', serial, 'shell', 'settings', 'delete', 'secure', 'icon_blacklist'])
      return
    }
    await genRun(['-s', serial, 'shell', 'settings', 'put', 'secure', 'icon_blacklist', trimmed])
  }
  async function genSetImmersive(mode) {
    await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'policy_control', mode])
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function fmtDate(mtime) {
    if (!mtime) return '—'
    const d = mtime instanceof Date ? mtime : new Date(typeof mtime === 'number' ? mtime : Number(mtime))
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
  }

  function fmtSize(bytes) {
    if (bytes == null || bytes === '') return '—'
    const n = parseInt(bytes)
    if (isNaN(n) || n === 0) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(1)} GB`
  }

  const entryIcon  = e => e.restricted ? '🔒' : e.type === 'dir' ? '📁' : e.type === 'symlink' ? '🔗' : '📄'
  const isDevNav   = e => e.type === 'dir' || e.type === 'symlink'
  const isLocalNav = e => e.type === 'dir'

  const sortedDev   = sortEntries(devEntries,   devSortKey,   devSortDir)
  const sortedLocal = sortEntries(localEntries, localSortKey, localSortDir)

  // ── Sub-components ────────────────────────────────────────────────────────────
  function QuestCard({ title, subtitle, open, onToggle, children }) {
    return (
      <div style={{ marginBottom: 8, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.025)', cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
          <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>{title}</span>
          {subtitle && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— {subtitle}</span>}
        </div>
        {open && <div style={{ padding: '10px 12px' }}>{children}</div>}
      </div>
    )
  }

  function ColHdr({ label, sk, cur, dir, onSort, style = {} }) {
    const active = cur === sk
    return (
      <div onClick={() => onSort(sk)} style={{
        fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.05em', cursor: 'pointer',
        userSelect: 'none', display: 'flex', alignItems: 'center', gap: 2,
        color: active ? 'var(--accent-teal)' : 'var(--text-muted)',
        ...style,
      }}>
        {label}{active && <span style={{ fontSize: 7 }}>{dir === 'asc' ? '▲' : '▼'}</span>}
      </div>
    )
  }

  const tbBtn = (disabled, iconOnly = false) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 26,
    justifyContent: 'center',
    padding: iconOnly ? '0 7px' : '0 9px', borderRadius: 5, border: '0.5px solid var(--border)',
    background: 'var(--bg-elevated)', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: iconOnly ? 13 : 11, color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1, flexShrink: 0,
  })

  function PaneHeader({ label, atRoot, onUp, loading, onRefresh }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-subtle)',
        padding: '4px 8px',
      }}>
        <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', letterSpacing: '0.1em', color: 'var(--text-muted)', flexShrink: 0 }}>
          {label}
        </span>
        <div style={{ width: 1, height: 12, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />
        <button disabled={atRoot} onClick={onUp} style={tbBtn(atRoot)}
          onMouseEnter={e => { if (!atRoot) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↑ Up</button>
        <div style={{ flex: 1 }} />
        <button disabled={loading} onClick={onRefresh} style={tbBtn(loading)}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↺ Refresh</button>
      </div>
    )
  }

  const ctxItemStyle = {
    display: 'block', width: '100%', padding: '7px 14px', background: 'none',
    border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 'var(--text-xs)',
    fontFamily: 'inherit', color: 'var(--text-primary)', whiteSpace: 'nowrap',
  }

  // ── Row renderer ─────────────────────────────────────────────────────────────
  function FileRow({ f, i, selected, onSelect, onDouble, onCtx, onDragStart, draggable: isDraggable, cols, nameColor, children }) {
    const baseBg = selected ? 'rgba(168,85,247,0.18)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
    return (
      <div
        draggable={isDraggable}
        onDragStart={onDragStart}
        onContextMenu={e => { e.stopPropagation(); if (onCtx) onCtx(e) }}
        onClick={onSelect}
        onDoubleClick={onDouble}
        style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', padding: '3px 8px', background: baseBg, cursor: 'default', userSelect: 'none' }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(168,85,247,0.07)' }}
        onMouseLeave={e => { e.currentTarget.style.background = baseBg }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{ fontSize: 12, flexShrink: 0, lineHeight: 1 }}>{entryIcon(f)}</span>
          <span style={{ fontSize: 11, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: nameColor }}>
            {f.name}
          </span>
        </span>
        {children}
      </div>
    )
  }

  const isAndroidTweaksView = platform === 'android' && mode === 'general'
  const panelBody = (
    <>
      {!embedded && (
        <div className="panel-header-row">
          <div style={{ minWidth: 0 }}>
            <div className="panel-header-accent" />
            <h1 className="panel-header">{
              mode === 'tv'      ? 'TV & Streaming' :
              mode === 'quest'   ? 'VR / Quest' :
              mode === 'files'   ? 'File Browser' :
              mode === 'rom'     ? 'ROM Tools' :
              mode === 'general' ? 'Tweaks' :
              'Device Tools'
            }</h1>
          </div>
          {noDevice && (
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={onNavigateToDevices}>
              Connect Device
            </button>
          )}
        </div>
      )}

      <div className={embedded ? undefined : 'panel-scroll'}>
        {!embedded && noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>
              {mode === 'general'
                ? 'No device connected — tweak actions will be disabled'
                : 'No device connected — file browser actions will be disabled'}
            </span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
              View Devices
            </button>
          </div>
        )}

        {/* ── File Browser ── */}
        {(mode === 'all' || mode === 'files') && (
        <div>

          {/* Rename bar */}
          {renameTarget && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>Rename:</span>
              <input ref={renameInputRef} autoFocus value={renameTarget.newName}
                onChange={e => setRenameTarget(t => ({ ...t, newName: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenameTarget(null) }}
                style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', outline: 'none', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', fontFamily: mono }}
              />
              <button className="btn-primary" style={{ padding: '3px 10px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={submitRename}>Rename</button>
              <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={() => setRenameTarget(null)}>Cancel</button>
            </div>
          )}

          {/* New folder bar */}
          {newFolderTarget && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, background: 'rgba(20,184,166,0.07)', border: '1px solid rgba(20,184,166,0.25)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>New folder in <span style={{ color: 'var(--accent-teal)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>{newFolderTarget.pane === 'local' ? localPath : devPath}</span>:</span>
              <input ref={newFolderInputRef} autoFocus value={newFolderTarget.name}
                onChange={e => setNewFolderTarget(t => ({ ...t, name: e.target.value }))}
                onKeyDown={async e => {
                  if (e.key === 'Enter') { await createNewFolder(newFolderTarget.pane, newFolderTarget.name); setNewFolderTarget(null) }
                  if (e.key === 'Escape') setNewFolderTarget(null)
                }}
                style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', outline: 'none', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
              />
              <button className="btn-primary" style={{ padding: '3px 10px', fontSize: 'var(--text-xs)', flexShrink: 0 }}
                onClick={async () => { await createNewFolder(newFolderTarget.pane, newFolderTarget.name); setNewFolderTarget(null) }}>Create</button>
              <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={() => setNewFolderTarget(null)}>Cancel</button>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, padding: '8px 10px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={!localSelected || noDevice} onClick={pushSelectedLocalEntry}>Push Selected</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={!devSelected || noDevice} onClick={pullSelectedDeviceEntry}>Pull Selected</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice} onClick={uploadFilesToDevice}>Upload Files…</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={!localPath} onClick={revealCurrentLocalFolder}>Reveal Local Folder</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={!localPath} onClick={() => copyCurrentPanePath('local')}>Copy Local Path</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice} onClick={() => copyCurrentPanePath('device')}>Copy Device Path</button>
          </div>

          {/* ── Dual-pane window ── */}
          <div style={{ display: 'flex', height: 500, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>

            {/* ══ LEFT: Local pane ══ */}
            <div
              style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-subtle)', minWidth: 0, boxShadow: localDragOver ? 'inset 0 0 0 2px var(--accent)' : 'none', transition: 'box-shadow 0.1s' }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setLocalDragOver(true) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setLocalDragOver(false) }}
              onDrop={async e => {
                e.preventDefault(); e.stopPropagation(); setLocalDragOver(false)
                let parsed = null
                try { const r = e.dataTransfer.getData('text/plain'); if (r) parsed = JSON.parse(r) } catch {
                  // Ignore malformed internal drag payloads.
                }
                if (!parsed?._nt) parsed = draggedDeviceFile
                if (parsed?._nt && parsed.pane === 'device') {
                  setDraggedDeviceFile(null)
                  const entry = devEntries.find(x => x.name === parsed.name) || { name: parsed.name, type: 'file', size: null }
                  pullToLocal(entry)
                }
              }}
            >
              {/* Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-subtle)', padding: '4px 8px' }}>
                <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', letterSpacing: '0.1em', color: 'var(--text-muted)', flexShrink: 0 }}>LOCAL</span>
                <div style={{ width: 1, height: 12, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />
                <button disabled={localIsRoot} onClick={localNavigateUp} style={tbBtn(localIsRoot)}
                  onMouseEnter={e => { if (!localIsRoot) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↑ Up</button>
                <button onClick={() => { if (localHome) { setLocalPath(localHome); setLocalSelected(null) } }} style={tbBtn(false)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>Home</button>
                <button onClick={async () => { const sel = await openDialog({ directory: true, multiple: false }); if (sel) { const p = typeof sel === 'string' ? sel : sel[0]; setLocalPath(p.replace(/\/+$/, '')); setLocalSelected(null) } }} style={tbBtn(false)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>Open</button>
                <button title="New folder" aria-label="Create new folder" onClick={() => setNewFolderTarget({ pane: 'local', name: '' })} style={tbBtn(false, true)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>📁+</button>
                <button title="Copy selected item" aria-label="Copy selected item" onClick={async () => { if (localSelected) { const p = await pathJoin(localPath, localSelected); setLocalCopyClipboard([p]) } }} disabled={!localSelected} style={tbBtn(!localSelected, true)}
                  onMouseEnter={e => { if (localSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>⎘</button>
                <button title="Paste copied item" aria-label="Paste copied item" onClick={localPaste} disabled={!localCopyClipboard.length} style={tbBtn(!localCopyClipboard.length, true)}
                  onMouseEnter={e => { if (localCopyClipboard.length) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>📋</button>
                <button title="Delete selected item" aria-label="Delete selected item" onClick={() => { const entry = localEntries.find(x => x.name === localSelected); if (entry) localDeleteEntry(entry) }} disabled={!localSelected} style={tbBtn(!localSelected, true)}
                  onMouseEnter={e => { if (localSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>🗑</button>
                <div style={{ flex: 1 }} />
                <button disabled={localLoading} onClick={() => loadLocalEntries(localPath)} style={tbBtn(localLoading)}
                  onMouseEnter={e => { if (!localLoading) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↺ Refresh</button>
              </div>
              {/* Breadcrumb */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 1, padding: '2px 8px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid var(--border-subtle)', overflow: 'hidden', flexShrink: 0 }}>
                {localPathParts.map((seg, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: i === localPathParts.length - 1 ? 1 : 0, minWidth: 0 }}>
                    {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 9, padding: '0 1px', userSelect: 'none' }}>›</span>}
                    <button onClick={() => { setLocalPath(seg.target); setLocalSelected(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', borderRadius: 2, fontSize: 10, fontFamily: mono, color: i === localPathParts.length - 1 ? 'var(--text-primary)' : 'var(--accent-teal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }} title={seg.label}>
                      {seg.label}
                    </button>
                  </span>
                ))}
              </div>
              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 48px 80px', padding: '3px 8px', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', flexShrink: 0 }}>
                <ColHdr label="NAME"     sk="name"  cur={localSortKey} dir={localSortDir} onSort={k => toggleSort(k, localSortKey, setLocalSortKey, setLocalSortDir)} />
                <ColHdr label="SIZE"     sk="size"  cur={localSortKey} dir={localSortDir} onSort={k => toggleSort(k, localSortKey, setLocalSortKey, setLocalSortDir)} />
                <ColHdr label="TYPE"     sk="type"  cur={localSortKey} dir={localSortDir} onSort={k => toggleSort(k, localSortKey, setLocalSortKey, setLocalSortDir)} />
                <ColHdr label="MODIFIED" sk="mtime" cur={localSortKey} dir={localSortDir} onSort={k => toggleSort(k, localSortKey, setLocalSortKey, setLocalSortDir)} />
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}
                onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, entry: null, pane: 'local' }) }}>
                {localLoading
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Loading…</div>
                  : localError
                  ? <div style={{ padding: '12px 16px', color: 'var(--accent-yellow)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>⚠</span><span>{localError}</span>
                    </div>
                  : localEntries.length === 0
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>Empty folder.</div>
                  : sortedLocal.map((f, i) => (
                    <FileRow key={i} f={f} i={i} cols="1fr 60px 48px 80px"
                      draggable={!isLocalNav(f)}
                      onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', JSON.stringify({ _nt: true, pane: 'local', name: f.name })); setDraggedLocalFile({ _nt: true, pane: 'local', name: f.name }) }}
                      onDragEnd={() => setDraggedLocalFile(null)}
                      selected={localSelected === f.name}
                      nameColor={isLocalNav(f) ? 'var(--accent-teal)' : 'var(--text-primary)'}
                      onSelect={() => setLocalSelected(f.name)}
                      onDouble={() => isLocalNav(f) ? localNavigateTo(f.name) : (noDevice ? openInFinder(f) : pushToDevice(f))}
                      onCtx={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, entry: f, pane: 'local' }) }}
                    >
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, textAlign: 'right', paddingRight: 4 }}>{f.type === 'dir' ? '—' : fmtSize(f.size)}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.type === 'dir' ? 'Folder' : 'File'}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, paddingLeft: 4 }}>{fmtDate(f.mtime)}</span>
                    </FileRow>
                  ))
                }
              </div>
            </div>

            {/* ══ CENTER: Transfer arrows ══ */}
            <div style={{ width: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'var(--bg-surface)', borderRight: '1px solid var(--border-subtle)', flexShrink: 0, padding: '0 2px' }}>
              {/* Push: local → device */}
              <button
                title={localSelected ? `Push "${localSelected}" → device` : 'Select a local file first'}
                disabled={!localSelected || noDevice}
                onClick={() => {
                  const e = localEntries.find(x => x.name === localSelected)
                  if (e) { console.log('[transfer] push', e.name, 'to device at', devPath); pushToDevice(e) }
                }}
                style={{
                  width: 36, height: 36, borderRadius: 'var(--radius-sm)', border: 'none', cursor: localSelected && !noDevice ? 'pointer' : 'not-allowed',
                  background: localSelected && !noDevice ? 'rgba(168,85,247,0.25)' : 'rgba(255,255,255,0.04)',
                  color: localSelected && !noDevice ? 'var(--accent-purple)' : 'var(--text-muted)',
                  fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >→</button>
              <div style={{ width: 24, height: 1, background: 'var(--border-subtle)' }} />
              {/* Pull: device → local */}
              <button
                title={devSelected ? `Pull "${devSelected}" → local` : 'Select a device file first'}
                disabled={!devSelected || noDevice}
                onClick={() => {
                  const e = devEntries.find(x => x.name === devSelected)
                  if (e) { console.log('[transfer] pull', e.name, 'to local at', localPath); pullToLocal(e) }
                }}
                style={{
                  width: 36, height: 36, borderRadius: 'var(--radius-sm)', border: 'none', cursor: devSelected && !noDevice ? 'pointer' : 'not-allowed',
                  background: devSelected && !noDevice ? 'rgba(20,184,166,0.2)' : 'rgba(255,255,255,0.04)',
                  color: devSelected && !noDevice ? 'var(--accent-teal)' : 'var(--text-muted)',
                  fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >←</button>
            </div>

            {/* ══ RIGHT: Device pane ══ */}
            <div
              style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, outline: devDragOver ? '2px dashed var(--accent)' : 'none', outlineOffset: -2, transition: 'outline 0.1s' }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDevDragOver(true) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDevDragOver(false) }}
              onDrop={async e => {
                e.preventDefault(); e.stopPropagation(); setDevDragOver(false)
                console.log('[drop] device pane drop detected, files:', e.dataTransfer.files.length, 'text/plain:', e.dataTransfer.getData('text/plain'))
                // Internal drag (local pane → device pane)
                let parsed = null
                try { const r = e.dataTransfer.getData('text/plain'); if (r) parsed = JSON.parse(r) } catch {
                  // Ignore malformed internal drag payloads.
                }
                if (!parsed?._nt) parsed = draggedLocalFile
                if (parsed?._nt && parsed.pane === 'local') {
                  setDraggedLocalFile(null)
                  console.log('[drop] internal drag from local pane:', parsed.name)
                  const entry = localEntries.find(x => x.name === parsed.name) || { name: parsed.name, type: 'file', size: null }
                  pushToDevice(entry)
                  return
                }
                // OS file drop (from Finder/Explorer) — f.path is Tauri's extension to File
                if (!noDevice && e.dataTransfer.files.length > 0) {
                  for (const f of Array.from(e.dataTransfer.files)) {
                    const p = f.path ?? f.name
                    console.log('[drop] OS file drop:', p)
                    if (p && p.startsWith('/')) pushPathToDevice(p)
                  }
                }
              }}
            >
              {/* Device Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-subtle)', padding: '4px 8px' }}>
                <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', letterSpacing: '0.1em', color: 'var(--text-muted)', flexShrink: 0 }}>DEVICE</span>
                <div style={{ width: 1, height: 12, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />
                <button disabled={devPath === '/'} onClick={devNavigateUp} style={tbBtn(devPath === '/')}
                  onMouseEnter={e => { if (devPath !== '/') e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↑ Up</button>
                <button onClick={() => { setDevPath('/'); setDevSelected(null) }} style={tbBtn(false)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>/ Root</button>
                <button onClick={() => { setDevPath('/sdcard'); setDevSelected(null) }} style={tbBtn(false)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>sdcard</button>
                <button title="Copy selected item" aria-label="Copy selected item" onClick={() => { if (devSelected) setDevCopyClipboard([devRemotePath(devSelected)]) }} disabled={!devSelected || noDevice} style={tbBtn(!devSelected || noDevice, true)}
                  onMouseEnter={e => { if (devSelected && !noDevice) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>⎘</button>
                <button title="Paste copied item" aria-label="Paste copied item" onClick={devPaste} disabled={!devCopyClipboard.length || noDevice} style={tbBtn(!devCopyClipboard.length || noDevice, true)}
                  onMouseEnter={e => { if (devCopyClipboard.length && !noDevice) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>📋</button>
                <button title="Delete selected item" aria-label="Delete selected item" onClick={() => { const entry = devEntries.find(x => x.name === devSelected); if (entry) devDeleteEntry(entry) }} disabled={!devSelected || noDevice} style={tbBtn(!devSelected || noDevice, true)}
                  onMouseEnter={e => { if (devSelected && !noDevice) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>🗑</button>
                <div style={{ flex: 1 }} />
                <button disabled={devLoading} onClick={() => loadDevEntries(devPath)} style={tbBtn(devLoading)}
                  onMouseEnter={e => { if (!devLoading) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}>↺ Refresh</button>
              </div>
              {/* Device breadcrumb */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 1, padding: '2px 8px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid var(--border-subtle)', overflow: 'hidden', flexShrink: 0 }}>
                {devPathParts.map((seg, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: i === devPathParts.length - 1 ? 1 : 0, minWidth: 0 }}>
                    {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 9, padding: '0 1px', userSelect: 'none' }}>›</span>}
                    <button onClick={() => { setDevPath(seg.target); setDevSelected(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', borderRadius: 2, fontSize: 10, fontFamily: mono, color: i === devPathParts.length - 1 ? 'var(--text-primary)' : 'var(--accent-teal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }} title={seg.label}>
                      {seg.label}
                    </button>
                  </span>
                ))}
              </div>
              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px 92px 88px', padding: '3px 8px', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', flexShrink: 0 }}>
                <ColHdr label="NAME" sk="name" cur={devSortKey} dir={devSortDir} onSort={k => toggleSort(k, devSortKey, setDevSortKey, setDevSortDir)} />
                <ColHdr label="SIZE" sk="size" cur={devSortKey} dir={devSortDir} onSort={k => toggleSort(k, devSortKey, setDevSortKey, setDevSortDir)} />
                <ColHdr label="MODIFIED" sk="mtime" cur={devSortKey} dir={devSortDir} onSort={k => toggleSort(k, devSortKey, setDevSortKey, setDevSortDir)} />
                <ColHdr label="PERMS" sk="type" cur={devSortKey} dir={devSortDir} onSort={k => toggleSort(k, devSortKey, setDevSortKey, setDevSortDir)} />
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}
                onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, entry: null, pane: 'device' }) }}>
                {noDevice
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>No device connected.</div>
                  : devLoading
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Loading…</div>
                  : devEntries.length === 0
                  ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>Empty directory.</div>
                  : sortedDev.map((f, i) => (
                    <FileRow key={i} f={f} i={i} cols="1fr 72px 92px 88px"
                      draggable={!isDevNav(f)}
                      onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', JSON.stringify({ _nt: true, pane: 'device', name: f.name })); setDraggedDeviceFile({ _nt: true, pane: 'device', name: f.name }) }}
                      onDragEnd={() => setDraggedDeviceFile(null)}
                      selected={devSelected === f.name}
                      nameColor={isDevNav(f) ? 'var(--accent-teal)' : 'var(--text-primary)'}
                      onSelect={() => setDevSelected(f.name)}
                      onDouble={() => isDevNav(f) ? devNavigateTo(f.name) : pullToLocal(f)}
                      onCtx={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, entry: f, pane: 'device' }) }}
                    >
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, textAlign: 'right', paddingRight: 4 }}>{fmtSize(f.size)}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, paddingLeft: 4 }}>{f.mtimeLabel || fmtDate(f.mtime)}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.perms || '—'}</span>
                    </FileRow>
                  ))
                }
              </div>
            </div>
          </div>

          {/* ── Transfer queue (FileZilla style) ── */}
          {(() => {
            const activeCount = transfers.filter(t => t.status === 'active').length
            const errorCount  = transfers.filter(t => t.status === 'error').length
            const doneCount   = transfers.filter(t => t.status === 'done').length
            const tabMap = { active: 'active', error: 'error', done: 'done' }
            const filtered = transfers.filter(t => t.status === tabMap[transferTab])
            const tabStyle = (key) => ({
              padding: '5px 12px', fontSize: 10, fontWeight: 'var(--font-semibold)',
              background: transferTab === key ? 'rgba(255,255,255,0.06)' : 'none',
              border: 'none', borderRight: '1px solid var(--border-subtle)',
              color: transferTab === key ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
            })
            const badge = (n, color) => n > 0 && <span style={{ fontSize: 9, background: `${color}22`, color, padding: '1px 4px', borderRadius: 3 }}>{n}</span>
            return (
              <div style={{ marginTop: 8, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                {/* Tab bar */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.015)' }}>
                  <button style={tabStyle('active')} onClick={() => setTransferTab('active')}>Queued {badge(activeCount, 'var(--accent-purple)')}</button>
                  <button style={tabStyle('error')}  onClick={() => setTransferTab('error')} >Failed  {badge(errorCount,  'var(--accent-red)')}</button>
                  <button style={tabStyle('done')}   onClick={() => setTransferTab('done')}  >Successful {badge(doneCount, 'var(--accent-green)')}</button>
                  <div style={{ flex: 1 }} />
                  <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 9, margin: '3px' }}
                    onClick={() => setTransfers(ts => ts.filter(t => t.status === 'active'))}>Clear</button>
                </div>
                {/* Column headers */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 18px 1fr 64px 80px', padding: '2px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)', flexShrink: 0 }}>
                  {['LOCAL FILE', '', 'REMOTE FILE', 'SIZE', 'STATUS'].map((h, i) => (
                    <span key={i} style={{ fontSize: 9, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>{h}</span>
                  ))}
                </div>
                {/* Rows */}
                <div style={{ height: 90, overflowY: 'auto' }}>
                  {filtered.length === 0
                    ? <div style={{ padding: '18px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic' }}>No transfers.</div>
                    : filtered.map((t, i) => (
                      <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1fr 18px 1fr 64px 80px', padding: '3px 8px', alignItems: 'center', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                        <span style={{ fontSize: 10, fontFamily: mono, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.localPath}>{t.localPath || t.name}</span>
                        <span style={{ fontSize: 11, color: t.direction === 'pull' ? 'var(--accent-teal)' : 'var(--accent-purple)', textAlign: 'center', fontWeight: 'bold' }}>{t.direction === 'pull' ? '←' : '→'}</span>
                        <span style={{ fontSize: 10, fontFamily: mono, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.remotePath}>{t.remotePath || '—'}</span>
                        <span style={{ fontSize: 10, fontFamily: mono, color: 'var(--text-muted)', textAlign: 'right', paddingRight: 4 }}>{t.size ? fmtSize(t.size) : '—'}</span>
                        <span style={{ fontSize: 10, color: t.status === 'done' ? 'var(--accent-green)' : t.status === 'error' ? 'var(--accent-red)' : 'var(--accent-yellow)' }}>
                          {t.status === 'active' ? '⟳ Transferring' : t.status === 'done' ? '✓ Done' : '✗ Failed'}
                        </span>
                      </div>
                    ))
                  }
                </div>
              </div>
            )
          })()}
        </div>
        )}

        {/* ── Other tool sections ── */}
        <div style={{ marginTop: 8 }}>
          {(mode === 'all' || mode === 'quest') && (
          <div>

            {/* ADB Setup Card — Quest */}
            {mode === 'quest' && (
            <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {[
                { id: 'tools', label: 'Tools' },
                { id: 'tweaks', label: 'Tweaks' },
                { id: 'advanced', label: 'Advanced' },
              ].map(item => (
                <button
                  key={item.id}
                  className={questTab === item.id ? 'btn-primary' : 'btn-ghost'}
                  style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', borderRadius: 99 }}
                  onClick={() => setQuestTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {questTab === 'tools' && (
            <div style={{ marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              <div onClick={() => setQuestAdbSetupOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.025)', cursor: 'pointer', userSelect: 'none' }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: questAdbSetupOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
                <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>ADB SETUP</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— Connect Your Meta Quest</span>
              </div>
              {questAdbSetupOpen && (
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: 11, color: 'var(--accent-amber)', lineHeight: 1.6 }}>
                    ⚠ Meta Quest requires a developer account before ADB can be enabled. This is free — you just need to create or join an organization.
                  </div>
                  {[
                    { title: 'STEP 1 — CREATE DEVELOPER ACCOUNT', steps: [
                      'Visit developers.meta.com on your computer or phone',
                      'Sign in with your Meta account',
                      'Create a new Organization (any name works — this is just for verification)',
                      'Your account is now a developer account',
                    ]},
                    { title: 'STEP 2 — ENABLE DEVELOPER MODE', steps: [
                      'Open the Meta Horizon app on your phone',
                      'Tap Menu → Devices → select your headset',
                      'Scroll to Headset Settings → Developer Mode',
                      'Toggle Developer Mode ON',
                      'Reboot the headset (hold power → Restart)',
                    ]},
                    { title: 'STEP 3 — ENABLE USB DEBUGGING', steps: [
                      'Put on the headset',
                      'Settings → System → Developer',
                      'Enable USB Debugging',
                      'Connect USB-C cable to your computer',
                      'Inside the headset, accept the "Allow USB Debugging" prompt',
                      'Check "Always allow from this computer"',
                    ]},
                    { title: 'WIRELESS ADB', steps: [
                      'Settings → System → Developer → Wireless Debugging → ON',
                      'Tap Wireless Debugging → Pair device with pairing code',
                      'Enter the pairing code, IP and port shown in the headset into the fields below',
                    ]},
                  ].map(({ title, steps }) => (
                    <div key={title}>
                      <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6, marginTop: 10 }}>{title}</div>
                      <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                        {steps.map((step, i) => (
                          <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                            <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                  {platform === 'windows' && (
                    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      ℹ Windows users: Install Oculus ADB Drivers from developers.meta.com before connecting via USB. Without these drivers the headset will not be detected.
                    </div>
                  )}
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={async () => { const r = await invoke('run_adb', { args: ['devices'] }); setQuestAdbOutput((r.stdout || r.stderr || '').trim()) }}>
                      Check Connection
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={async () => { if (!serial) { setQuestAdbOutput('No device connected'); return } const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'] }); setQuestAdbOutput(`Android ${(r.stdout || '').trim()}`) }}>
                      Check Quest Version
                    </button>
                  </div>
                  {questAdbOutput && (
                    <div style={{ marginTop: 8, padding: '6px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)' }}>
                      {questAdbOutput}
                    </div>
                  )}
                </div>
              )}
            </div>
            )}
            </>
            )}

            {/* Development notice */}
            {!questNoticeDismissed && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.22)' }}>
                <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.3 }}>🚧</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, flex: 1 }}>
                  Quest Tools is in active development. Some features may not work as expected on all firmware versions. Always test on a non-primary device first.
                </span>
                <button onClick={() => setQuestNoticeDismissed(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: '0 0 0 4px', flexShrink: 0 }} title="Dismiss">×</button>
              </div>
            )}

            {/* Status feedback */}
            {questStatus && (
              <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: questStatus.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${questStatus.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, fontSize: 11, color: questStatus.ok ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {questStatus.msg}
              </div>
            )}

            {/* ── 1. Privacy & Telemetry ── */}
            {questTab === 'tools' && <QuestCard title="PRIVACY & TELEMETRY" subtitle="ADB Package Controls" open={questPrivacyOpen} onToggle={() => setQuestPrivacyOpen(o => !o)}>
              <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)', fontSize: 11, color: 'var(--accent-yellow)', lineHeight: 1.5 }}>
                ⚠ Disabling core packages may affect login, store, or app licensing. Start with social/telemetry packages first.
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice}
                  onClick={async () => {
                    const pkgs = [...questPkgChecked]
                    if (!pkgs.length) return
                    let ok = true
                    for (const pkg of pkgs) {
                      try { await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg] }) }
                      catch { ok = false }
                    }
                    setQuestStatus({ ok, msg: ok ? `✓ Disabled ${pkgs.length} package(s)` : '⚠ Some commands failed — check device connection' })
                    setTimeout(() => setQuestStatus(null), 5000)
                  }}>✓ Apply Selected</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice}
                  onClick={async () => {
                    const pkgs = [...questPkgChecked]
                    if (!pkgs.length) return
                    let ok = true
                    for (const pkg of pkgs) {
                      try { await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'enable', '--user', '0', pkg] }) }
                      catch { ok = false }
                    }
                    setQuestStatus({ ok, msg: ok ? `↩ Re-enabled ${pkgs.length} package(s)` : '⚠ Some commands failed' })
                    setTimeout(() => setQuestStatus(null), 5000)
                  }}>↩ Revert Selected</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice}
                  onClick={async () => {
                    let ok = true
                    for (const pkg of QUEST_PACKAGES) {
                      try { await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'enable', '--user', '0', pkg.id] }) }
                      catch { ok = false }
                    }
                    setQuestStatus({ ok, msg: ok ? '↩ All packages restored to default' : '⚠ Some commands failed' })
                    setTimeout(() => setQuestStatus(null), 5000)
                  }}>↩ Revert All to Default</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {QUEST_PACKAGES.map(pkg => (
                  <label key={pkg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: questPkgChecked.has(pkg.id) ? 'rgba(168,85,247,0.07)' : 'transparent' }}>
                    <input type="checkbox" checked={questPkgChecked.has(pkg.id)}
                      onChange={e => setQuestPkgChecked(s => { const n = new Set(s); e.target.checked ? n.add(pkg.id) : n.delete(pkg.id); return n })}
                      style={{ marginTop: 2, accentColor: 'var(--accent-purple)', flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)' }}>{pkg.id}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{pkg.label} — {pkg.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </QuestCard>}

            {/* ── 2. Performance Tuning ── */}
            {questTab === 'tweaks' && <QuestCard title="PERFORMANCE TUNING" subtitle="CPU & GPU Levels" open={questPerfOpen} onToggle={() => setQuestPerfOpen(o => !o)}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 12 }}>
                {[
                  { label: 'CPU Level', val: questCpuLevel, set: setQuestCpuLevel },
                  { label: 'GPU Level', val: questGpuLevel, set: setQuestGpuLevel },
                ].map(({ label, val, set }) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 8 }}>
                      {label}: <span style={{ color: 'var(--accent-teal)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>{val}</span>
                    </div>
                    <input type="range" min={0} max={4} value={val} onChange={e => set(Number(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent-teal)', cursor: 'pointer' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
                      {[0,1,2,3,4].map(n => <span key={n} style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>{n}</span>)}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 14px' }} disabled={noDevice}
                  onClick={async () => {
                    try {
                      await invoke('run_adb', { args: ['-s', serial, 'shell', 'setprop', 'debug.oculus.cpuLevel', String(questCpuLevel)] })
                      await invoke('run_adb', { args: ['-s', serial, 'shell', 'setprop', 'debug.oculus.gpuLevel', String(questGpuLevel)] })
                      setQuestStatus({ ok: true, msg: `✓ Applied CPU=${questCpuLevel} GPU=${questGpuLevel}` })
                    } catch (e) {
                      setQuestStatus({ ok: false, msg: `⚠ Failed: ${String(e).slice(0, 80)}` })
                    }
                    setTimeout(() => setQuestStatus(null), 5000)
                  }}>Apply</button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Changes are temporary and reset on reboot</span>
              </div>
            </QuestCard>}

            {/* ── 3. DNS Blocklist ── */}
            {questTab === 'tweaks' && <QuestCard title="DNS BLOCKLIST" subtitle="Meta / Oculus Domains" open={questDnsOpen} onToggle={() => setQuestDnsOpen(o => !o)}>
              <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {QUEST_DNS_GROUPS.map(group => (
                  <div key={group.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <div
                      onClick={() => setQuestDnsGroupOpen(s => ({ ...s, [group.id]: !s[group.id] }))}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.02)', cursor: 'pointer', userSelect: 'none' }}
                    >
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: questDnsGroupOpen[group.id] ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
                      <span style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', flex: 1 }}>{group.label}</span>
                      {group.warn && <span style={{ fontSize: 10, color: 'var(--accent-yellow)' }}>{group.warn}</span>}
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>
                        {group.domains.filter(d => questDnsChecked.has(d)).length}/{group.domains.length}
                      </span>
                    </div>
                    {questDnsGroupOpen[group.id] && (
                      <div style={{ padding: '4px 10px 8px 28px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {group.domains.map(domain => (
                          <label key={domain} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '2px 0' }}>
                            <input type="checkbox" checked={questDnsChecked.has(domain)}
                              onChange={e => setQuestDnsChecked(s => { const n = new Set(s); e.target.checked ? n.add(domain) : n.delete(domain); return n })}
                              style={{ accentColor: 'var(--accent-teal)', flexShrink: 0 }} />
                            <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)' }}>{domain}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} disabled={noDevice || !questDnsChecked.size}
                  onClick={async () => {
                    try {
                      const domains = [...questDnsChecked]
                      if (!domains.length) return
                      const hosts = domains.map(d => `0.0.0.0 ${d}`).join('\n')
                      const dl = await downloadDir()
                      const root = await pathJoin(dl, 'Nocturnal Toolkit', 'Quest')
                      await mkdir(root, { recursive: true })
                      const localFile = await pathJoin(root, 'quest_dns_blocklist_hosts.txt')
                      await writeTextFile(localFile, hosts)
                      if (serial) {
                        await invoke('run_adb', { args: ['-s', serial, 'shell', 'mkdir', '-p', '/sdcard/Download/NocturnalToolkit'] })
                        await invoke('run_adb', { args: ['-s', serial, 'push', localFile, '/sdcard/Download/NocturnalToolkit/quest_dns_blocklist_hosts.txt'] })
                      }
                      setQuestStatus({ ok: true, msg: `✓ Saved ${domains.length} selected domains to toolkit blocklist files on your computer${serial ? ' and Quest' : ''}` })
                    } catch (e) {
                      setQuestStatus({ ok: false, msg: `⚠ Failed to save blocklist: ${String(e).slice(0, 80)}` })
                    }
                    setTimeout(() => setQuestStatus(null), 5000)
                  }}>✓ Save via Toolkit</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}
                  onClick={() => {
                    const domains = [...questDnsChecked]
                    if (!domains.length) return
                    const hosts = domains.map(d => `0.0.0.0 ${d}`).join('\n')
                    navigator.clipboard.writeText(hosts)
                    setQuestStatus({ ok: true, msg: `📋 Copied ${domains.length} domains as hosts file entries` })
                    setTimeout(() => setQuestStatus(null), 4000)
                  }}>📋 Copy Blocklist</button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{questDnsChecked.size} domains selected</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, fontStyle: 'italic' }}>
                The toolkit can now generate and save the selected hosts-format blocklist for you directly. Direct per-domain blocking on the headset itself still depends on root or a DNS/VPN layer because Quest does not expose a non-root hosts editor over ADB.
              </div>
            </QuestCard>}

            {/* ── 4. Rooting & Advanced Access ── */}
            {questTab === 'advanced' && <QuestCard title="ROOTING & ADVANCED ACCESS" subtitle="Firmware-dependent" open={questRootOpen} onToggle={() => setQuestRootOpen(o => !o)}>

              {/* Warning banner */}
              <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', fontSize: 11, color: 'var(--accent-red)', lineHeight: 1.6 }}>
                ⚠ Rooting support varies by firmware. Firmware 79 and below has known exploits. Firmware above v79 — no public root method available as of early 2026.
              </div>

              {/* a) Root status by firmware */}
              <QuestCard title="ROOT STATUS BY FIRMWARE" subtitle={null} open={questRootStatusOpen} onToggle={() => setQuestRootStatusOpen(o => !o)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[
                    { fw: 'v57 – v62', status: 'Rootable', color: 'var(--accent-green)',  desc: 'Rooted via payload dumper + Magisk — well documented, community tested' },
                    { fw: 'v63 – v71', status: 'Rootable', color: 'var(--accent-green)',  desc: 'Various methods available, community support and guides exist' },
                    { fw: 'v72 – v79', status: 'Rootable', color: 'var(--accent-yellow)', desc: 'Last known rootable firmware range — use at own risk, less documentation' },
                    { fw: 'v80+',      status: 'No root',  color: 'var(--accent-red)',    desc: 'No public root method available — ADB-only tools recommended' },
                  ].map(row => (
                    <div key={row.fw} style={{ display: 'grid', gridTemplateColumns: '72px 72px 1fr', alignItems: 'baseline', gap: 10, padding: '5px 8px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)' }}>
                      <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)', fontWeight: 'var(--font-semibold)' }}>{row.fw}</span>
                      <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: row.color }}>{row.status}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{row.desc}</span>
                    </div>
                  ))}
                </div>
              </QuestCard>

              {/* b) Rooting tools */}
              <QuestCard title="ROOTING TOOLS" subtitle="Reference links" open={questRootToolsOpen} onToggle={() => setQuestRootToolsOpen(o => !o)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    { name: 'Meta Quest ADB Guide',   url: 'https://developer.oculus.com/documentation/native/android/mobile-adb/',    desc: 'Official ADB setup and developer mode documentation' },
                    { name: 'Meta Developer Setup',   url: 'https://developers.meta.com/horizon/documentation/native/android/mobile-device-setup/', desc: 'Official developer-mode setup steps for Quest devices' },
                    { name: 'ADB Command Reference',  url: 'https://developer.android.com/tools/adb', desc: 'Official Android Debug Bridge reference' },
                  ].map(tool => (
                    <div key={tool.name} style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', flex: 1 }}>{tool.name}</span>
                        <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }}
                          onClick={() => openUrl(tool.url)}>
                          🔗 Open
                        </button>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>{tool.desc}</div>
                    </div>
                  ))}
                </div>
              </QuestCard>

              {/* c) What root unlocks */}
              <QuestCard title="WHAT ROOT UNLOCKS" subtitle={null} open={questRootUnlocksOpen} onToggle={() => setQuestRootUnlocksOpen(o => !o)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {[
                    'Full filesystem access beyond /sdcard',
                    'Remove all Meta/Facebook bloatware completely',
                    'Custom DNS at system level (no router required)',
                    'Overclock CPU/GPU beyond ADB setprop limits',
                    'Full logcat without restrictions',
                    'Battery stats and advanced thermal control',
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' }}>
                      <span style={{ color: 'var(--accent-green)', fontSize: 11, flexShrink: 0 }}>✓</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </QuestCard>

              {/* d) Without root */}
              <QuestCard title="WITHOUT ROOT (ADB ONLY)" subtitle="Works on all firmware" open={questNoRootOpen} onToggle={() => setQuestNoRootOpen(o => !o)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {[
                    'Package disable/enable — covered in Privacy & Telemetry above',
                    'Performance tuning via setprop (CPU/GPU level)',
                    'DNS blocklist via router, Private DNS, or network filtering',
                    'Sideloading APKs via ADB',
                    'File access to /sdcard via ADB or File Browser above',
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' }}>
                      <span style={{ color: 'var(--accent-teal)', fontSize: 11, flexShrink: 0 }}>→</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </QuestCard>

            </QuestCard>}

          </div>
          )}

          {(mode === 'all' || mode === 'rom') && (
          <div>

            {/* ── FRP Safety Checklist ── */}
            {(() => {
              const pixelSafetyOk = pixelFrpChecks.every(Boolean)
              const checks = [
                'I have removed all Google accounts from Settings → Accounts → Google → Remove Account',
                'I have disabled my screen lock (PIN/Pattern/Password) in Settings → Security',
                'I understand that unlocking the bootloader WIPES ALL DATA on this device',
                'I have backed up all important data before proceeding',
                'I am the legitimate owner of this device',
              ]
              return (
                <>
                <div style={{ marginBottom: 12, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: pixelSafetyOk ? 'rgba(34,197,94,0.05)' : 'rgba(234,179,8,0.05)', border: `1px solid ${pixelSafetyOk ? 'rgba(34,197,94,0.35)' : 'var(--accent-yellow)'}`, transition: 'border-color 0.2s, background 0.2s' }}>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', color: pixelSafetyOk ? 'var(--accent-green)' : 'var(--accent-yellow)', marginBottom: 3 }}>
                      {pixelSafetyOk ? '✓ Safety checks complete — actions unlocked' : '⚠ Before You Continue — FRP & Data Safety Checklist'}
                    </div>
                    {!pixelSafetyOk && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        Factory Reset Protection (FRP) will lock your device if a Google account is still linked when you wipe or unlock. Complete this checklist before proceeding.
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {checks.map((text, i) => (
                      <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                        <input type="checkbox" checked={pixelFrpChecks[i]}
                          onChange={e => setPixelFrpChecks(arr => arr.map((v, j) => j === i ? e.target.checked : v))}
                          style={{ marginTop: 2, accentColor: 'var(--accent-green)', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: pixelFrpChecks[i] ? 'var(--text-secondary)' : 'var(--text-primary)', lineHeight: 1.5, textDecoration: pixelFrpChecks[i] ? 'line-through' : 'none', transition: 'color 0.15s' }}>{text}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 7, alignItems: 'flex-start', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ fontSize: 11, color: 'var(--accent-teal)', flexShrink: 0 }}>ℹ</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      Google FRP locks your device after any untrusted factory reset if a Google account is still present. Even flashing stock firmware via fastboot can trigger FRP. If you changed your Google password in the last 72 hours, wait before wiping — Google may lock your entire account.
                    </span>
                  </div>
                </div>

            {/* Typed confirmation bar */}
            {pixelConfirm && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>
                <span style={{ fontSize: 11, color: 'var(--accent-red)', flexShrink: 0 }}>⚠ {pixelConfirm.label} — type <b>{pixelConfirm.keyword}</b> to confirm:</span>
                <input autoFocus value={pixelConfirmInput} onChange={e => setPixelConfirmInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && pixelConfirmInput === pixelConfirm.keyword) { pixelConfirm.onConfirm(); setPixelConfirm(null) } if (e.key === 'Escape') setPixelConfirm(null) }}
                  style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', outline: 'none', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
                <button className="btn-primary" style={{ padding: '3px 10px', fontSize: 11, background: 'var(--accent-red)', flexShrink: 0 }}
                  disabled={pixelConfirmInput !== pixelConfirm.keyword}
                  onClick={() => { pixelConfirm.onConfirm(); setPixelConfirm(null) }}>Confirm</button>
                <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11, flexShrink: 0 }} onClick={() => setPixelConfirm(null)}>Cancel</button>
              </div>
            )}

            {/* ── 1. Device Info ── */}
            <QuestCard title="DEVICE INFO" subtitle="Model, bootloader, build" open={pixelInfoOpen} onToggle={() => setPixelInfoOpen(o => !o)}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} disabled={noDevice || pixelRunning}
                  onClick={async () => {
                    for (const prop of ['ro.product.model', 'ro.bootloader', 'ro.build.version.release', 'ro.build.fingerprint']) {
                      await pixelRunAdb(['-s', serial, 'shell', 'getprop', prop])
                    }
                  }}>Get Device Info</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }} disabled={pixelRunning}
                  onClick={() => pixelRunFastboot(['getvar', 'all'])}>fastboot getvar all</button>
              </div>
              <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Device must be in fastboot mode for "getvar all"</div>
            </QuestCard>

            {/* ── 2. Bootloader Controls ── */}
            <QuestCard title="BOOTLOADER CONTROLS" subtitle="Reboot modes & unlock" open={pixelBootOpen} onToggle={() => setPixelBootOpen(o => !o)}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {[
                  { label: 'Reboot to Bootloader', args: ['-s', serial, 'reboot', 'bootloader'] },
                  { label: 'Reboot to Recovery',   args: ['-s', serial, 'reboot', 'recovery'] },
                  { label: 'Reboot to Fastbootd',  args: ['-s', serial, 'reboot', 'fastboot'] },
                  { label: 'Reboot to System',     args: ['-s', serial, 'reboot'] },
                ].map(btn => (
                  <button key={btn.label} className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                    disabled={noDevice || pixelRunning}
                    onClick={async () => {
                      if (!await dialogConfirm(`${btn.label}?`, { title: 'Confirm', kind: 'warning' })) return
                      await pixelRunAdb(btn.args)
                    }}>{btn.label}</button>
                ))}
              </div>
              <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', fontSize: 11, color: 'var(--accent-red)' }}>
                ⚠ Unlocking the bootloader wipes all data on the device
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.4)' }}
                  disabled={!pixelSafetyOk || pixelRunning}
                  title={!pixelSafetyOk ? 'Complete the safety checklist above first' : undefined}
                  onClick={() => pixelAskConfirm({ keyword: 'UNLOCK', label: 'Unlock bootloader (wipes all data)', onConfirm: () => pixelRunFastboot(['flashing', 'unlock']) })}>
                  🔓 Unlock Bootloader</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                  disabled={!pixelSafetyOk || pixelRunning}
                  title={!pixelSafetyOk ? 'Complete the safety checklist above first' : undefined}
                  onClick={() => pixelAskConfirm({ keyword: 'LOCK', label: 'Lock bootloader', onConfirm: () => pixelRunFastboot(['flashing', 'lock']) })}>
                  🔒 Lock Bootloader</button>
              </div>
            </QuestCard>

            {/* ── 3. Flash Tool ── */}
            <QuestCard title="FLASH TOOL" subtitle="fastboot flash partitions" open={pixelFlashOpen} onToggle={() => setPixelFlashOpen(o => !o)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { key: 'boot',     label: 'Boot Image',      note: null,           flashArgs: f => ['flash', 'boot', f],         ext: ['img'] },
                  { key: 'recovery', label: 'Recovery Image',  note: 'Pixel 6+ → vendor_boot', flashArgs: f => ['flash', 'recovery', f], ext: ['img'] },
                  { key: 'vbmeta',   label: 'vbmeta Image',    note: '--disable-verity --disable-verification', flashArgs: f => ['flash', 'vbmeta', '--disable-verity', '--disable-verification', f], ext: ['img'] },
                  { key: 'system',   label: 'System Image',    note: 'Requires fastbootd mode', flashArgs: f => ['flash', 'system', f], ext: ['img'] },
                  { key: 'factory',  label: 'Factory Image folder', note: 'Runs flash-all.sh/bat', flashArgs: null, ext: null },
                ].map(row => (
                  <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '130px 1fr auto', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)' }}>{row.label}</div>
                      {row.note && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{row.note}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono','Courier New',monospace", color: pixelFlashFiles[row.key] ? 'var(--text-primary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {pixelFlashFiles[row.key] || 'No file selected'}
                      </span>
                      <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }}
                        onClick={async () => {
                          const sel = row.key === 'factory'
                            ? await openDialog({ directory: true, multiple: false })
                            : await openDialog({ multiple: false, filters: [{ name: 'Image', extensions: row.ext }] })
                          if (sel) setPixelFlashFiles(f => ({ ...f, [row.key]: typeof sel === 'string' ? sel : sel[0] }))
                        }}>Browse</button>
                    </div>
                    <button className="btn-primary" style={{ fontSize: 10, padding: '3px 10px', flexShrink: 0 }}
                      disabled={!pixelFlashFiles[row.key] || pixelRunning}
                      onClick={async () => {
                        const fp = pixelFlashFiles[row.key]
                        if (!fp) return
                        if (row.key === 'factory') {
                          const script = navigator.userAgent.includes('Win') ? 'flash-all.bat' : 'flash-all.sh'
                          await pixelRunFastboot([fp + '/' + script])
                        } else {
                          await pixelRunFastboot(row.flashArgs(fp))
                        }
                      }}>Flash</button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, fontStyle: 'italic' }}>
                System partition flashing requires fastbootd mode (use "Reboot to Fastbootd" first) · Pixel 6+ requires vendor_boot for custom recovery
              </div>
              <div style={{ marginTop: 12, overflowX: 'auto' }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 8 }}>REFERENCE GUIDE</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      {['Goal', 'Command', 'Mode'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 10px', fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.05em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { goal: 'Install Custom ROM', cmd: 'adb sideload rom.zip', mode: 'Recovery' },
                      { goal: 'Install Recovery', cmd: 'fastboot flash recovery/vendor_boot', mode: 'Bootloader' },
                      { goal: 'Wipe for Clean Install', cmd: 'fastboot -w', mode: 'Bootloader' },
                      { goal: 'Fix System Partition', cmd: 'fastboot flash system system.img', mode: 'fastbootd' },
                      { goal: 'Restore Stock', cmd: 'flash-all.sh', mode: 'Bootloader' },
                      { goal: 'Switch Active Slot', cmd: 'fastboot set_active a|b', mode: 'Bootloader' },
                    ].map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '5px 10px', color: 'var(--text-secondary)' }}>{row.goal}</td>
                        <td style={{ padding: '5px 10px', fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--accent-teal)', whiteSpace: 'nowrap' }}>{row.cmd}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.mode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </QuestCard>

            {/* ── 4. Slot Management ── */}
            <QuestCard title="SLOT MANAGEMENT" subtitle="A/B partitions" open={pixelSlotOpen} onToggle={() => setPixelSlotOpen(o => !o)}>
              {pixelSlotStatus && (
                <div style={{ marginBottom: 8, padding: '5px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.08)', border: '1px solid rgba(20,184,166,0.25)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--accent-teal)' }}>
                  Current slot: {pixelSlotStatus}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={pixelRunning}
                  onClick={async () => {
                    const r = await pixelRunFastboot(['getvar', 'current-slot'])
                    if (r) setPixelSlotStatus(([r.stdout, r.stderr].join(' ').match(/current-slot:\s*(\w+)/i) || [])[1] || 'unknown')
                  }}>Get Current Slot</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={pixelRunning}
                  onClick={() => pixelRunFastboot(['set_active', 'a'])}>Switch to Slot A</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={pixelRunning}
                  onClick={() => pixelRunFastboot(['set_active', 'b'])}>Switch to Slot B</button>
              </div>
            </QuestCard>

            {/* ── 5. ADB Sideload ── */}
            <QuestCard title="ADB SIDELOAD" subtitle="OTA zips, custom ROMs" open={pixelSideloadOpen} onToggle={() => setPixelSideloadOpen(o => !o)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono','Courier New',monospace", color: pixelSideloadFile ? 'var(--text-primary)' : 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pixelSideloadFile || 'No file selected'}
                </span>
                <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }}
                  onClick={async () => {
                    const sel = await openDialog({ multiple: false, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
                    if (sel) setPixelSideloadFile(typeof sel === 'string' ? sel : sel[0])
                  }}>Browse</button>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 12px', flexShrink: 0 }}
                  disabled={!pixelSideloadFile || noDevice || pixelRunning}
                  onClick={() => pixelRunAdb(['-s', serial, 'sideload', pixelSideloadFile])}>Sideload</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Device must be in Recovery mode. Use for OTA updates and custom ROMs.
              </div>
            </QuestCard>

            {/* ── 6. Factory Reset / Wipe ── */}
            <QuestCard title="FACTORY RESET / WIPE" subtitle="Irreversible — data loss" open={pixelWipeOpen} onToggle={() => setPixelWipeOpen(o => !o)}>
              <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', fontSize: 11, color: 'var(--accent-red)' }}>
                ⚠ These operations are irreversible and will erase all data
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 12px', color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.4)' }}
                  disabled={!pixelSafetyOk || pixelRunning}
                  title={!pixelSafetyOk ? 'Complete the safety checklist above first' : undefined}
                  onClick={() => pixelAskConfirm({ keyword: 'WIPE', label: 'Wipe userdata', onConfirm: () => pixelRunFastboot(['erase', 'userdata']) })}>
                  🗑 Wipe Userdata</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 12px', color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.4)' }}
                  disabled={!pixelSafetyOk || pixelRunning}
                  title={!pixelSafetyOk ? 'Complete the safety checklist above first' : undefined}
                  onClick={() => pixelAskConfirm({ keyword: 'FACTORY', label: 'Flash all + wipe (factory restore)', onConfirm: () => pixelRunFastboot(['flashall', '-w']) })}>
                  ⚠ Flash All (factory)</button>
              </div>
            </QuestCard>

            {/* ── Shared output terminal ── */}
            {pixelOutput && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>OUTPUT</span>
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }} onClick={() => setPixelOutput('')}>Clear</button>
                </div>
                <pre ref={pixelOutputRef} style={{ margin: 0, padding: '10px 12px', background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflowY: 'auto', lineHeight: 1.5 }}>
                  {pixelOutput}
                </pre>
              </div>
            )}
              </>
              )
            })()}

          </div>
          )}

          {(mode === 'all' || mode === 'general') && (
          <div>

            {noDevice && (
              <div className="warning-banner" style={{ marginBottom: 12 }}>
                <span>⚠ No device connected — ADB commands disabled</span>
              </div>
            )}

            {isAndroidTweaksView && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 12 }}>
                <div style={{
                  background: 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(20,184,166,0.05))',
                  border: '1px solid rgba(245,158,11,0.2)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '16px 16px',
                }}>
                  <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
                    Tweaks
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    Phone-first controls for display, animations, DNS, permissions, and common device actions.
                  </div>
                </div>

                <div style={{
                  background: 'rgba(20,184,166,0.06)',
                  border: '1px solid rgba(20,184,166,0.18)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 6 }}>
                    Permission Notes
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    Some tweaks work immediately. Others depend on Android system permissions and may need a one-time ADB grant or root depending on your device.
                  </div>
                </div>
              </div>
            )}

            {/* ── 1. Display & UI Tweaks ── */}
            {(() => {
              const content = (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {isAndroidTweaksView && (
                    <div style={{ marginBottom: 2, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      Use these carefully. Density, resolution, and refresh-rate changes may not be supported by every device.
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Screen Density (DPI)</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={genDpi} onChange={e => setGenDpi(e.target.value)} placeholder="e.g. 320"
                        style={{ width: isAndroidTweaksView ? 120 : 100, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: isAndroidTweaksView ? '8px 10px' : '4px 8px', color: 'var(--text-primary)', fontSize: isAndroidTweaksView ? 13 : 11, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                      <button className="btn-primary" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={!genDpi || noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'wm', 'density', genDpi])}>Apply</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'wm', 'density', 'reset'])}>Reset</button>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Screen Resolution</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={genResolution} onChange={e => setGenResolution(e.target.value)} placeholder="e.g. 1080x1920"
                        style={{ width: isAndroidTweaksView ? 142 : 120, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: isAndroidTweaksView ? '8px 10px' : '4px 8px', color: 'var(--text-primary)', fontSize: isAndroidTweaksView ? 13 : 11, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                      <button className="btn-primary" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={!genResolution || noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'wm', 'size', genResolution])}>Apply</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'wm', 'size', 'reset'])}>Reset</button>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Animation Speed</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {[{ label: '0.5× Fast', val: '0.5' }, { label: '1× Normal', val: '1' }, { label: 'Off', val: '0' }].map(b => (
                        <button key={b.val} className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                          onClick={() => genSetAnimScale(b.val)}>{b.label}</button>
                      ))}
                    </div>
                    <div style={{ fontSize: isAndroidTweaksView ? 12 : 10, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>Sets window, transition, and animator duration scales</div>
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Force Refresh Rate (OnePlus/Nothing/Samsung)</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {['60', '90', '120', '144'].map(hz => (
                        <button key={hz} className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                          onClick={async () => {
                            await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'peak_refresh_rate', hz])
                            await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'min_refresh_rate', hz])
                          }}>{hz}Hz</button>
                      ))}
                      <input value={genRefreshRate} onChange={e => setGenRefreshRate(e.target.value)} placeholder="custom"
                        style={{ width: isAndroidTweaksView ? 88 : 70, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: isAndroidTweaksView ? '8px 10px' : '4px 8px', color: 'var(--text-primary)', fontSize: isAndroidTweaksView ? 13 : 11, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                      <button className="btn-primary" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={!genRefreshRate || noDevice || genRunning}
                        onClick={async () => {
                          await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'peak_refresh_rate', genRefreshRate])
                          await genRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'min_refresh_rate', genRefreshRate])
                        }}>Apply</button>
                    </div>
                  </div>
                </div>
              )
              return isAndroidTweaksView
                ? <QuestCard title="Display & Motion" subtitle="Screen size, density, refresh rate, and animations" open={genDisplayOpen} onToggle={() => setGenDisplayOpen(o => !o)}>{content}</QuestCard>
                : <DesktopInlineSection title="DISPLAY & UI TWEAKS" subtitle="DPI, resolution, animations">{content}</DesktopInlineSection>
            })()}

            {/* ── 2. Private DNS ── */}
            {(() => {
              const content = (
                <>
                  <div style={{ marginBottom: 10, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, padding: '6px 10px', background: 'rgba(20,184,166,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(20,184,166,0.15)' }}>
                    ℹ Sets system-wide Private DNS — works as an ad blocker on all apps without root. Changes take effect immediately.
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    {[
                      { label: 'AdGuard',    host: 'dns.adguard.com' },
                      { label: 'NextDNS',    host: 'dns.nextdns.io' },
                      { label: 'Cloudflare', host: '1dot1dot1dot1.cloudflare-dns.com' },
                    ].map(p => (
                      <button key={p.label} className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetDns('hostname', p.host)}>{p.label}</button>
                    ))}
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--accent-yellow)' }} disabled={noDevice || genRunning}
                      onClick={() => genSetDns('off', null)}>Disable (Auto)</button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input value={genCustomDns} onChange={e => setGenCustomDns(e.target.value)} placeholder="custom.dns.hostname.com"
                      style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                    <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} disabled={!genCustomDns || noDevice || genRunning}
                      onClick={() => genSetDns('hostname', genCustomDns)}>Apply Custom</button>
                  </div>
                </>
              )
              return isAndroidTweaksView
                ? <QuestCard title="Private DNS" subtitle="System-wide DNS presets and custom hostnames" open={genDnsOpen} onToggle={() => setGenDnsOpen(o => !o)}>{content}</QuestCard>
                : <DesktopInlineSection title="PRIVATE DNS" subtitle="System-wide DNS presets and custom hostnames">{content}</DesktopInlineSection>
            })()}

            {/* ── 3. Battery & Power ── */}
            {(() => {
              const content = (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: isAndroidTweaksView ? 12 : 10, color: 'var(--text-muted)', lineHeight: 1.6, padding: '6px 10px', background: 'rgba(20,184,166,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(20,184,166,0.15)' }}>
                    Battery saver and Doze controls are applied directly through ADB from the toolkit. Device firmware may still override some behavior.
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Battery Saver</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetLowPower(true)}>Enable Saver</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetLowPower(false)}>Disable Saver</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.BATTERY_SAVER_SETTINGS'])}>Open Settings</button>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Doze & Idle</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'force-idle'])}>Force Doze</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'unforce'])}>Exit Doze</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genRun(['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'step'])}>Advance Idle Step</button>
                    </div>
                  </div>
                </div>
              )
              return isAndroidTweaksView
                ? <QuestCard title="Battery & Power" subtitle="Battery saver and Doze controls" open={genPowerOpen} onToggle={() => setGenPowerOpen(o => !o)}>{content}</QuestCard>
                : <DesktopInlineSection title="BATTERY & POWER" subtitle="Battery saver and Doze controls">{content}</DesktopInlineSection>
            })()}

            {/* ── 4. System UI ── */}
            {(() => {
              const content = (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Status Bar Icon Cleanup</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {[
                        { label: 'Minimal', value: 'alarm_clock,bluetooth,rotate,headset' },
                        { label: 'Travel', value: 'alarm_clock,bluetooth,rotate,headset,vpn,hotspot' },
                        { label: 'Carrier Clutter', value: 'volte,vowifi,ims' },
                      ].map(preset => (
                        <button key={preset.label} className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                          onClick={() => { setGenStatusIcons(preset.value); genSetStatusBarIcons(preset.value) }}>{preset.label}</button>
                      ))}
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => { setGenStatusIcons(''); genSetStatusBarIcons('') }}>Reset</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={genStatusIcons} onChange={e => setGenStatusIcons(e.target.value)} placeholder="alarm_clock,bluetooth,rotate"
                        style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: isAndroidTweaksView ? '8px 10px' : '4px 8px', color: 'var(--text-primary)', fontSize: isAndroidTweaksView ? 13 : 11, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                      <button className="btn-primary" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetStatusBarIcons(genStatusIcons)}>Apply</button>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: isAndroidTweaksView ? 13 : 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-secondary)', marginBottom: 6 }}>Immersive Mode</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetImmersive('immersive.full=*')}>Full Screen</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetImmersive('immersive.status=*')}>Hide Status Bar</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetImmersive('immersive.navigation=*')}>Hide Navigation</button>
                      <button className="btn-ghost" style={{ fontSize: isAndroidTweaksView ? 13 : 11, padding: isAndroidTweaksView ? '8px 12px' : '4px 10px' }} disabled={noDevice || genRunning}
                        onClick={() => genSetImmersive('null')}>Reset</button>
                    </div>
                  </div>
                </div>
              )
              return isAndroidTweaksView
                ? <QuestCard title="System UI" subtitle="Status bar and immersive mode helpers" open={genUiOpen} onToggle={() => setGenUiOpen(o => !o)}>{content}</QuestCard>
                : <DesktopInlineSection title="SYSTEM UI" subtitle="Status bar and immersive mode helpers">{content}</DesktopInlineSection>
            })()}

            {/* ── Shared output terminal ── */}
            {genOutput && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>OUTPUT</span>
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }} onClick={() => setGenOutput('')}>Clear</button>
                </div>
                <pre ref={genOutputRef} style={{ margin: 0, padding: '10px 12px', background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflowY: 'auto', lineHeight: 1.5 }}>
                  {genOutput}
                </pre>
              </div>
            )}

          </div>
          )}

        {(mode === 'all' || mode === 'tv') && (
        <div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {[
                { id: 'tools', label: 'Tools' },
                { id: 'debloat', label: 'Debloat' },
                { id: 'streaming', label: 'Streaming' },
                { id: 'launchers', label: 'Launchers' },
                { id: 'others', label: 'Others' },
              ].map(item => (
                <button
                  key={item.id}
                  className={tvTab === item.id ? 'btn-primary' : 'btn-ghost'}
                  style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', borderRadius: 99 }}
                  onClick={() => setTvTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* ADB Setup Card — TV */}
            {mode === 'tv' && tvTab === 'tools' && (
            <div style={{ marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              <div onClick={() => setTvAdbSetupOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.025)', cursor: 'pointer', userSelect: 'none' }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: tvAdbSetupOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
                <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>ADB SETUP</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— Connect Your TV or Streaming Device</span>
              </div>
              {tvAdbSetupOpen && (
                <div style={{ padding: '10px 12px' }}>
                  {/* Tab row */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {[
                      { label: 'Fire TV',         value: 'firetv'  },
                      { label: 'ONN / Android TV', value: 'onn'     },
                      { label: 'NVIDIA Shield',    value: 'shield'  },
                      { label: 'Google TV',        value: 'googletv'},
                      { label: 'Sony / TCL',       value: 'sonytcl' },
                    ].map(t => (
                      <button key={t.value}
                        className={tvAdbTab === t.value ? 'btn-primary' : 'btn-ghost'}
                        style={{ fontSize: 10, padding: '3px 10px', borderRadius: 99 }}
                        onClick={() => setTvAdbTab(t.value)}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {/* Fire TV */}
                  {tvAdbTab === 'firetv' && (<>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6 }}>ENABLE ADB ON FIRE TV</div>
                    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {['Settings → My Fire TV → About','Tap your device name 7 times until "You are now a developer!" appears','Go back → Developer Options','Enable ADB Debugging','Enable Apps from Unknown Sources','Note: Fire TV uses WiFi ADB only — no USB ADB on Fire Sticks','Find your IP: Settings → My Fire TV → About → Network → IP Address','Enter IP below and click Connect'].map((step, i) => (
                        <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: 11, color: 'var(--accent-amber)', lineHeight: 1.6 }}>
                      ⚠ Fire TV Stick 4K Select (Vega OS) has Developer Options blocked on some firmware versions.
                    </div>
                  </>)}
                  {/* ONN */}
                  {tvAdbTab === 'onn' && (<>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6 }}>ENABLE ADB ON ONN / ANDROID TV</div>
                    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {['Settings → Device Preferences → About','Tap Build Number 7 times','Return to Settings → Device Preferences → Developer Options','Enable USB Debugging','Enable Network Debugging (for WiFi ADB)','Find your IP: Settings → Device Preferences → About → Network','Enter IP below and click Connect'].map((step, i) => (
                        <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </>)}
                  {/* NVIDIA Shield */}
                  {tvAdbTab === 'shield' && (<>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6 }}>ENABLE ADB ON NVIDIA SHIELD</div>
                    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {['Settings → Device Preferences → About','Tap Build Number 7 times','Return to Settings → Device Preferences → Developer Options','Enable Network Debugging (Shield uses "Network Debugging" not "USB Debugging")','Find your IP: Settings → About → Status → IP Address','Enter IP below and click Connect'].map((step, i) => (
                        <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      ℹ Shield keeps ADB authorization permanently. Other Android 11+ devices revoke authorization after ~7 days.
                    </div>
                  </>)}
                  {/* Google TV */}
                  {tvAdbTab === 'googletv' && (<>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6 }}>ENABLE ADB ON GOOGLE TV / CHROMECAST</div>
                    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {['Settings → System → About','Tap Build Number 7 times','Settings → System → Developer Options → USB Debugging ON','Find IP: Settings → Network & Internet → your network → IP Address','Important: Chromecast with Google TV on Android TV 14+ uses a randomized port','Use the Pair with Code method below instead of direct IP connect for Chromecast'].map((step, i) => (
                        <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      ℹ Chromecast with Google TV bug: ADB port is randomized in Android TV 14+. Use the Pair Device tab in the Devices panel instead of direct connect.
                    </div>
                  </>)}
                  {/* Sony / TCL */}
                  {tvAdbTab === 'sonytcl' && (<>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 6 }}>ENABLE ADB ON SONY / TCL</div>
                    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                      {['Settings → Device Preferences → About (or Settings → About)','Tap Build Number 7 times','Settings → Device Preferences → Developer Options → USB Debugging ON','Enable Network Debugging for WiFi ADB','Find IP: Settings → Network → Network Status → IP Address','Enter IP below and click Connect'].map((step, i) => (
                        <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: 11, color: 'var(--accent-amber)', lineHeight: 1.6 }}>
                      ⚠ Sony TVs sometimes disable ADB after reboot. Re-enable in Developer Options if connection drops.
                    </div>
                  </>)}
                </div>
              )}
            </div>
            )}

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.22)' }}>
              <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.3 }}>🚧</span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, flex: 1 }}>
                TV & Streaming Device Tools are in active development. Fire TV commands tested on Fire Stick 4K. ONN and other Android TV devices may vary.
              </span>
            </div>

            {(tvTab === 'tools' || tvTab === 'others') && (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    { label: 'All Devices', value: 'all' },
                    { label: 'Firestick / Fire TV', value: 'firetv' },
                    { label: 'Google / ONN Devices', value: 'androidtv' },
                  ].map(f => (
                    <button
                      key={f.value}
                      className={tvDeviceFilter === f.value ? 'btn-primary' : 'btn-ghost'}
                      style={{ fontSize: 10, padding: '3px 10px', borderRadius: 99 }}
                      onClick={() => setTvDeviceFilter(f.value)}>
                      {f.label}
                    </button>
                  ))}
                </div>
                {tvDeviceFilter !== 'all' && (
                  <div style={{ marginBottom: 12, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Showing device-specific sections for <span style={{ color: 'var(--accent-teal)' }}>{tvDeviceFilter === 'firetv' ? 'Firestick / Fire TV' : 'Google / ONN and Android TV devices'}</span>. Switch back to <span style={{ color: 'var(--text-secondary)' }}>All Devices</span> to see the shared setup cards too.
                  </div>
                )}
              </>
            )}

            {/* ── 1. Device Setup & Sideloading ── */}
            {tvTab === 'tools' && tvShowFor(['all']) && (
            <QuestCard title="DEVICE SETUP & SIDELOADING" subtitle={null} open={tvSetupOpen} onToggle={() => setTvSetupOpen(o => !o)}>
              <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                <div style={{ fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>Enable ADB Debugging</div>
                <div style={{ marginBottom: 4 }}>
                  <span style={{ color: 'var(--accent-teal)' }}>Fire Stick / Fire TV:</span>
                  {' '}Settings → My Fire TV → Developer Options → ADB Debugging <b>ON</b> + Apps from Unknown Sources <b>ON</b>
                </div>
                <div>
                  <span style={{ color: 'var(--accent-teal)' }}>ONN / Android TV:</span>
                  {' '}Settings → Device Preferences → Developer Options → USB Debugging
                </div>
                <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 10 }}>
                  Most TV sticks have no USB host mode — connect via WiFi ADB.
                </div>
              </div>

              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>WIRELESS CONNECT</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                  <input
                    value={tvIp} onChange={e => setTvIp(e.target.value)}
                    placeholder="192.168.1.x:5555"
                    style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)' }}
                  />
                  <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }} disabled={tvRunning || !tvIp.trim()}
                    onClick={() => tvRun(['connect', tvIp.trim()])}>
                    Connect
                  </button>
                </div>

                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>PAIR VIA CODE (Android 11+)</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={tvPairIp} onChange={e => setTvPairIp(e.target.value)}
                    placeholder="192.168.1.x:37000"
                    style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)' }}
                  />
                  <input
                    value={tvPairCode} onChange={e => setTvPairCode(e.target.value)}
                    placeholder="123456"
                    style={{ width: 80, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)' }}
                  />
                  <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }} disabled={tvRunning || !tvPairIp.trim() || !tvPairCode.trim()}
                    onClick={() => tvRun(['pair', tvPairIp.trim(), tvPairCode.trim()])}>
                    Pair
                  </button>
                </div>
              </div>
            </QuestCard>
            )}

            {tvTab === 'debloat' && (
              <TvDebloatPanel
                serial={serial}
                noDevice={noDevice}
                running={tvRunning}
                setRunning={setTvRunning}
                append={tvAppend}
                device={device}
              />
            )}

            {/* ── 2. Fire TV / Fire Stick Tools ── */}
            {tvTab === 'tools' && tvShowFor(['firetv']) && (
            <QuestCard title="FIRE TV / FIRE STICK TOOLS" subtitle="Debloat Presets" open={tvFireOpen} onToggle={() => setTvFireOpen(o => !o)}>
              <div style={{ marginBottom: 8, fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>Fire TV &amp; Fire Stick Only</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial || ![...tvFireChecked].length}
                  onClick={async () => {
                    for (const pkg of tvFireChecked) {
                      await tvRun(['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg])
                    }
                  }}>✓ Apply Selected</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial || ![...tvFireChecked].length}
                  onClick={async () => {
                    for (const pkg of tvFireChecked) {
                      await tvRun(['-s', serial, 'shell', 'pm', 'enable', '--user', '0', pkg])
                    }
                  }}>↩ Revert Selected</button>
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>AMAZON BLOAT (safe to disable)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {FIRE_TV_AMAZON_BLOAT.map(pkg => (
                    <label key={pkg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: tvFireChecked.has(pkg.id) ? 'rgba(20,184,166,0.07)' : 'transparent' }}>
                      <input type="checkbox" checked={tvFireChecked.has(pkg.id)}
                        onChange={e => setTvFireChecked(s => { const n = new Set(s); e.target.checked ? n.add(pkg.id) : n.delete(pkg.id); return n })}
                        style={{ marginTop: 2, accentColor: 'var(--accent-teal)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>{pkg.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>{pkg.id}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{pkg.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>AMAZON TRACKING / ADS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {FIRE_TV_TRACKING.map(pkg => (
                    <label key={pkg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: tvFireChecked.has(pkg.id) ? 'rgba(20,184,166,0.07)' : 'transparent' }}>
                      <input type="checkbox" checked={tvFireChecked.has(pkg.id)}
                        onChange={e => setTvFireChecked(s => { const n = new Set(s); e.target.checked ? n.add(pkg.id) : n.delete(pkg.id); return n })}
                        style={{ marginTop: 2, accentColor: 'var(--accent-teal)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>{pkg.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>{pkg.id}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{pkg.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)', fontSize: 11, color: 'var(--accent-yellow)', lineHeight: 1.5 }}>
                ⚠ Do not disable <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 10 }}>com.amazon.tv.launcher</code> (home screen) or <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 10 }}>com.amazon.device.settings</code>
              </div>
            </QuestCard>
            )}

            {/* ── 3. Fire TV Modding ── */}
            {tvTab === 'others' && tvShowFor(['firetv']) && (
            <QuestCard title="FIRE TV MODDING" subtitle="Sideloading & Power Tools" open={tvFireModOpen} onToggle={() => setTvFireModOpen(o => !o)}>

              {/* Toast */}
              {tvFireAppToast && (
                <div style={{ marginBottom: 10, padding: '7px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.12)', border: '1px solid rgba(20,184,166,0.35)', fontSize: 11, color: 'var(--accent-teal)' }}>
                  {tvFireAppToast}
                </div>
              )}

              {/* ── Section 1: Developer Setup ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 8 }}>ENABLE DEVELOPER MODE</div>
                <div style={{ marginBottom: 8, padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)', fontSize: 11, color: 'var(--accent-yellow)', lineHeight: 1.5 }}>
                  ⚠ Fire TV Stick 4K Select (Vega OS) has Developer Options blocked — sideloading is not supported on this model.
                </div>
                <div style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)', marginBottom: 8 }}>
                  {[
                    'Settings → My Fire TV → About',
                    'Click your Device Name 7 times rapidly',
                    '"You are now a developer!" toast will appear',
                    'Back → Developer Options',
                    'Enable "ADB Debugging" and "Apps from Unknown Sources"',
                    'Enable "Install Unknown Apps" for your sideloader app',
                  ].map((step, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 10, color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 14 }}>{i + 1}.</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'getprop', 'ro.debuggable'])}>
                    Check ADB Status
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'])}>
                    List Sideloaded Apps
                  </button>
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 14px' }} />

              {/* ── Section 2: Direct Install Apps ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 8 }}>DIRECT INSTALL APPS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {FIRE_TV_APPS.filter(app => app.id !== 'smarttube-stable').map(app => {
                    const instState   = tvInstalling[app.id]
                    const prog        = tvDlProgress[app.id]
                    const isInstalled = tvFireAppInstalled[app.id]
                    const inProgress  = instState === 'resolving' || instState === 'downloading' || instState === 'installing'
                    return (
                      <div key={app.id} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: `1px solid ${isInstalled ? 'rgba(34,197,94,0.3)' : 'var(--border-subtle)'}`, transition: 'border-color 0.2s' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{app.name}</span>
                              {isInstalled && <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 'var(--font-medium)' }}>● Installed</span>}
                            </div>
                            {app.compat && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{app.compat}</div>}
                            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3, lineHeight: 1.5 }}>{app.desc}</div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>
                              {prog ? `${prog.percent ?? 0}% — ${prog.speed ?? ''}` : app.source}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0, minWidth: 108 }}>
                            {app.fallbackUrl ? (
                              <button className="btn-ghost" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                                onClick={() => openUrl(app.fallbackUrl)}>
                                Get from Site ↗
                              </button>
                            ) : (
                              <button
                                className={isInstalled ? 'btn-ghost' : 'btn-primary'}
                                style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                                disabled={!serial || inProgress}
                                onClick={async () => {
                                  if (!serial) return
                                  setTvInstalling(s => ({ ...s, [app.id]: 'resolving' }))
                                  try {
                                    const { url, filename } = await tvResolveFireAppApk(app.id)
                                    await tvInstallFromUrl(app.id, url, filename)
                                    setTvFireAppInstalled(s => ({ ...s, [app.id]: true }))
                                  } catch (e) {
                                    setTvInstalling(s => ({ ...s, [app.id]: 'error' }))
                                    tvAppend(`Error resolving ${app.name}: ${e}\n`)
                                  }
                                }}>
                                {instState === 'resolving'    ? 'Resolving…'
                                  : instState === 'downloading' ? `↓ ${prog?.percent ?? 0}%`
                                  : instState === 'installing'  ? 'Installing…'
                                  : instState === 'error'       ? '✗ Retry'
                                  : isInstalled                 ? '↺ Reinstall'
                                  : 'Install'}
                              </button>
                            )}
                            {isInstalled && app.pkg && (
                              <button className="btn-danger" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                                disabled={!serial}
                                onClick={async () => {
                                  await tvRun(['-s', serial, 'shell', 'pm', 'uninstall', app.pkg])
                                  setTvFireAppInstalled(s => ({ ...s, [app.id]: false }))
                                }}>
                                Uninstall
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Downloader shortcodes */}
                <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>DOWNLOADER SHORTCODES</div>
                  {[
                    ['MATVT Mouse', 'aftv.news/matvt'],
                  ].map(([name, code]) => (
                    <div key={name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{name}</span>
                      <code style={{ fontFamily: mono, fontSize: 10, color: 'var(--accent-teal)' }}>{code}</code>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 14px' }} />

              {/* ── Section 3: Info Cards ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 8 }}>STREAMING & TOOLS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {FIRE_TV_INFO_SITES.map(site => (
                    <div key={site.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{site.name}</span>
                          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', letterSpacing: '0.04em' }}>{site.tag}</span>
                        </div>
                        {site.compat && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{site.compat}</div>}
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{site.desc}</div>
                      </div>
                      <button className="btn-ghost" style={{ fontSize: 10, padding: '4px 10px', flexShrink: 0 }}
                        onClick={() => openUrl(site.url)}>
                        Open Site ↗
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 14px' }} />

              {/* ── Section 4: Performance Tools ── */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 10 }}>PERFORMANCE TOOLS</div>

                {/* Kill Background Apps */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: 5 }}>KILL BACKGROUND APPS</div>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px', marginBottom: 5 }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'am', 'kill-all'])}>
                    Kill Background Processes
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>Terminates all background app processes to free RAM. Safe — apps relaunch when opened.</div>
                </div>

                {/* Clear Amazon Ad Storage */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: 5 }}>CLEAR AMAZON AD STORAGE</div>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px', marginBottom: 5 }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'pm', 'clear', 'com.amazon.ags.app'])}>
                    Clear Ad Data
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>Clears Amazon Gaming Services ad cache. Run periodically.</div>
                </div>

                {/* Disable Ad Services */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: 5 }}>DISABLE AD SERVICES</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
                    {FIRE_TV_AD_PKGS.map(pkg => (
                      <label key={pkg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: tvFireAdChecked.has(pkg.id) ? 'rgba(20,184,166,0.07)' : 'transparent' }}>
                        <input type="checkbox" checked={tvFireAdChecked.has(pkg.id)}
                          onChange={e => setTvFireAdChecked(s => { const n = new Set(s); e.target.checked ? n.add(pkg.id) : n.delete(pkg.id); return n })}
                          style={{ marginTop: 2, accentColor: 'var(--accent-teal)', flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>{pkg.label}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>{pkg.id}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{pkg.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px', marginBottom: 5 }}
                    disabled={tvRunning || !serial || tvFireAdChecked.size === 0}
                    onClick={async () => {
                      for (const pkg of tvFireAdChecked) {
                        await tvRun(['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg])
                      }
                    }}>
                    Disable Selected Ad Services
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>These services serve ads on your home screen. Disabling them does not affect playback apps.</div>
                </div>

                {/* DNS over ADB */}
                <div>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: 6 }}>DNS OVER ADB</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={tvFireDnsPreset}
                      onChange={e => { setTvFireDnsPreset(e.target.value); setTvFireDns(e.target.value) }}
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 11, color: 'var(--text-primary)', flexShrink: 0 }}>
                      <option value="">Custom</option>
                      <option value="94.140.14.14">AdGuard (94.140.14.14)</option>
                      <option value="45.90.28.0">NextDNS (45.90.28.0)</option>
                      <option value="1.1.1.1">Cloudflare (1.1.1.1)</option>
                    </select>
                    <input
                      value={tvFireDns}
                      onChange={e => { setTvFireDns(e.target.value); setTvFireDnsPreset('') }}
                      placeholder="DNS hostname or IP"
                      style={{ flex: 1, minWidth: 120, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, fontFamily: mono, color: 'var(--text-primary)' }}
                    />
                    <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
                      disabled={tvRunning || !serial || !tvFireDns.trim()}
                      onClick={async () => {
                        await tvRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'private_dns_specifier', tvFireDns.trim()])
                        await tvRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'private_dns_mode', 'hostname'])
                        setTvFireAppToast(`✓ DNS set to ${tvFireDns.trim()} — restart networking apps to apply`)
                        setTimeout(() => setTvFireAppToast(null), 5000)
                      }}>
                      Apply DNS
                    </button>
                  </div>
                </div>
              </div>

            </QuestCard>
            )}

            {/* ── 4. Google Play on Fire TV ── */}
            {tvTab === 'others' && tvShowFor(['firetv']) && (
            <QuestCard title="GOOGLE PLAY ON FIRE TV" subtitle="No Root" open={tvGplayOpen} onToggle={() => setTvGplayOpen(o => !o)}>
              <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)', fontSize: 11, color: 'var(--accent-yellow)', lineHeight: 1.5 }}>
                APK versions must match your Fire OS version. This method works on Fire OS 7 (Fire Stick 4K / 4K Max).
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {[
                  { step: 1, label: 'Google Account Manager',   note: 'version specific to Fire OS' },
                  { step: 2, label: 'Google Services Framework', note: null },
                  { step: 3, label: 'Google Play Services',      note: null },
                  { step: 4, label: 'Google Play Store',         note: null },
                ].map(({ step, label, note }) => (
                  <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', flexShrink: 0, minWidth: 18 }}>{step}.</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>Install {label}</div>
                      {note && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{note}</div>}
                    </div>
                    <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }} disabled={tvRunning || !serial}
                      onClick={async () => {
                        const p = await openDialog({ filters: [{ name: 'APK', extensions: ['apk'] }] })
                        if (p) tvRun(['-s', serial, 'install', '-r', p])
                      }}>
                      Install APK
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>Full guide with correct APK versions on AFTVnews</span>
                <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }} onClick={() => openUrl('https://www.aftvnews.com/how-to-install-google-play-on-amazon-fire-tv/')}>
                  Open Guide ↗
                </button>
              </div>
            </QuestCard>
            )}

            {/* ── 5. Android TV / ONN Tools ── */}
            {tvTab === 'tools' && tvShowFor(['onn', 'shield', 'googletv', 'sonytcl']) && (
            <QuestCard title="ANDROID TV / ONN TOOLS" subtitle="Common Tweaks" open={tvAndroidOpen} onToggle={() => setTvAndroidOpen(o => !o)}>
              <div style={{ marginBottom: 8, fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>ONN · Shield · Google TV · Sony · TCL</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'setprop', 'service.adb.tcp.port', '5555'])}>
                    Enable ADB WiFi
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'wm', 'size', '3840x2160'])}>
                    Force 4K
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'wm', 'size', '1920x1080'])}>
                    Force 1080p
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'wm', 'size', 'reset'])}>
                    Reset Resolution
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'settings', 'put', 'global', 'auto_update_onn', '0'])}>
                    Disable OTA (ONN)
                  </button>
                  <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={async () => {
                      tvAppend('\n$ Device Info\n')
                      await tvRun(['-s', serial, 'shell', 'getprop', 'ro.product.model'])
                      await tvRun(['-s', serial, 'shell', 'getprop', 'ro.build.version.release'])
                      await tvRun(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'])
                      await tvRun(['-s', serial, 'shell', 'wm', 'size'])
                    }}>
                    Get Device Info
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>
                  OTA disable uses ONN-specific key. Force resolution may revert on reboot on some devices.
                </div>
              </div>
            </QuestCard>
            )}

            {/* ── 6. Launchers ── */}
            {tvTab === 'launchers' && tvShowFor(['all']) && (
            <QuestCard title="LAUNCHERS" subtitle="Replace Your Home Screen" open={tvLauncherOpen} onToggle={() => setTvLauncherOpen(o => !o)}>

              {/* Toast */}
              {tvLauncherToast && (
                <div style={{ marginBottom: 10, padding: '7px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.12)', border: '1px solid rgba(20,184,166,0.35)', fontSize: 11, color: 'var(--accent-teal)' }}>
                  {tvLauncherToast}
                </div>
              )}

              {/* Launcher cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {TV_LAUNCHERS.map(launcher => {
                  const instState   = tvInstalling[launcher.id]
                  const prog        = tvDlProgress[launcher.id]
                  const isInstalled = tvLauncherInstalled[launcher.id]
                  const inProgress  = instState === 'resolving' || instState === 'downloading' || instState === 'installing'
                  return (
                    <div key={launcher.id} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: `1px solid ${isInstalled ? 'rgba(34,197,94,0.3)' : 'var(--border-subtle)'}`, transition: 'border-color 0.2s' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{launcher.name}</span>
                            {isInstalled && <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 'var(--font-medium)' }}>● Installed</span>}
                            {tvLauncherChecking && tvLauncherInstalled[launcher.id] === undefined && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>checking…</span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{launcher.compat}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4, lineHeight: 1.5 }}>{launcher.desc}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>
                            {prog ? `${prog.percent ?? 0}% — ${prog.speed ?? ''}` : launcher.source}
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0, minWidth: 108 }}>
                          {launcher.fallbackUrl ? (
                            <button className="btn-ghost" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                              onClick={() => openUrl(launcher.fallbackUrl)}>
                              Get from Site ↗
                            </button>
                          ) : (
                            <button
                              className={isInstalled ? 'btn-ghost' : 'btn-primary'}
                              style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                              disabled={!serial || inProgress}
                              onClick={async () => {
                                if (!serial) return
                                setTvInstalling(s => ({ ...s, [launcher.id]: 'resolving' }))
                                try {
                                  const { url, filename } = await tvResolveLauncherApk(launcher.id)
                                  await tvInstallFromUrl(launcher.id, url, filename)
                                  setTvLauncherInstalled(s => ({ ...s, [launcher.id]: true }))
                                } catch (e) {
                                  setTvInstalling(s => ({ ...s, [launcher.id]: 'error' }))
                                  tvAppend(`Error resolving ${launcher.name}: ${e}\n`)
                                }
                              }}>
                              {instState === 'resolving'    ? 'Resolving…'
                                : instState === 'downloading' ? `↓ ${prog?.percent ?? 0}%`
                                : instState === 'installing'  ? 'Installing…'
                                : instState === 'error'       ? '✗ Retry'
                                : isInstalled                 ? '↺ Reinstall'
                                : 'Install'}
                            </button>
                          )}

                          {isInstalled && launcher.homeActivity && (
                            <button className="btn-success" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                              disabled={!serial}
                              onClick={async () => {
                                await tvRun(['-s', serial, 'shell', 'cmd', 'package', 'set-home-activity', launcher.homeActivity])
                                setTvLauncherToast(`${launcher.name} set as default — press Home button to apply`)
                                setTimeout(() => setTvLauncherToast(null), 5000)
                              }}>
                              Set as Default
                            </button>
                          )}

                          {isInstalled && launcher.pkg && (
                            <button className="btn-danger" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                              disabled={!serial}
                              onClick={async () => {
                                await tvRun(['-s', serial, 'shell', 'pm', 'uninstall', launcher.pkg])
                                setTvLauncherInstalled(s => ({ ...s, [launcher.id]: false }))
                              }}>
                              Uninstall
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Note */}
              <div style={{ marginBottom: 12, padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                ℹ Some devices require disabling the stock launcher for the new one to take effect. Go to Manage Apps → find the stock launcher → Disable.
              </div>

              {/* Reset to stock + refresh */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 6 }}>RESET TO STOCK</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'cmd', 'package', 'set-home-activity', 'com.amazon.tv.launcher/.MainActivity'])}>
                    Fire TV Stock
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvRunning || !serial}
                    onClick={() => tvRun(['-s', serial, 'shell', 'cmd', 'package', 'set-home-activity', 'com.google.android.leanback.launcher/.MainActivity'])}>
                    Google TV Stock
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={tvLauncherChecking || !serial}
                    onClick={async () => {
                      setTvLauncherChecking(true)
                      const result = {}
                      for (const l of TV_LAUNCHERS) {
                        if (!l.pkg) { result[l.id] = false; continue }
                        try {
                          const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'path', l.pkg] })
                          result[l.id] = (r.stdout || '').includes('package:')
                        } catch { result[l.id] = false }
                      }
                      setTvLauncherInstalled(result)
                      setTvLauncherChecking(false)
                    }}>
                    {tvLauncherChecking ? 'Checking…' : '↺ Detect Installed'}
                  </button>
                </div>
              </div>
            </QuestCard>
            )}

            {tvTab === 'streaming' && (
            <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.08em', marginTop: 18, marginBottom: 10 }}>
              STREAMING
            </div>
            )}

            {/* ── 7. Media Center ── */}
            {tvTab === 'streaming' && tvShowFor(['all']) && (
            <QuestCard title="MEDIA CENTER" subtitle="Kodi, Stremio & More" open={tvKodiOpen} onToggle={() => setTvKodiOpen(o => !o)}>

              {/* ── Sub-section: Kodi ── */}
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.08em', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--border-subtle)' }}>KODI & LIBRARIES</div>

              {/* ── Install Kodi ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 8 }}>INSTALL KODI</div>
                {[
                  { id: 'kodi-21', label: 'Kodi 21.3 Omega', compat: '🏷 All Android TV Devices', tag: 'Latest', url: 'https://mirrors.kodi.tv/releases/android/arm64-v8a/kodi-21.3-Omega-arm64-v8a.apk', filename: 'kodi-21.3-Omega-arm64-v8a.apk' },
                  { id: 'kodi-20', label: 'Kodi 20.5 Nexus',  compat: '🏷 All Android TV Devices', tag: 'Stable', url: 'https://mirrors.kodi.tv/releases/android/arm64-v8a/kodi-20.5-Nexus-arm64-v8a.apk',  filename: 'kodi-20.5-Nexus-arm64-v8a.apk'  },
                ].map(app => {
                  const state = tvInstalling[app.id]
                  const prog  = tvDlProgress[app.id]
                  return (
                    <div key={app.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginBottom: 6, borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>{app.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{app.compat}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {prog ? `${prog.percent ?? 0}% — ${prog.speed ?? ''}` : app.tag}
                        </div>
                      </div>
                      <button
                        className={state === 'done' ? 'btn-ghost' : 'btn-primary'}
                        style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
                        disabled={!serial || (!!state && state !== 'done' && state !== 'error')}
                        onClick={() => tvInstallFromUrl(app.id, app.url, app.filename)}>
                        {state === 'downloading' ? '↓ Downloading…'
                          : state === 'installing' ? 'Installing…'
                          : state === 'done'       ? '✓ Installed'
                          : state === 'error'      ? '✗ Retry'
                          : 'Install'}
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* ── Add-on Repos → sources.xml ── */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>ADD-ON REPOSITORIES</div>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }}
                      onClick={() => setTvKodiRepos(new Set(KODI_REPOS.map(r => r.id)))}>
                      Select All
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }}
                      onClick={() => setTvKodiRepos(new Set())}>
                      Deselect All
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                  ⚠ Add-on availability changes frequently. Always verify repos are active before installing.
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                  {KODI_REPOS.map(repo => (
                    <label key={repo.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: tvKodiRepos.has(repo.id) ? 'rgba(20,184,166,0.07)' : 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
                      <input type="checkbox" checked={tvKodiRepos.has(repo.id)}
                        onChange={e => setTvKodiRepos(s => { const n = new Set(s); e.target.checked ? n.add(repo.id) : n.delete(repo.id); return n })}
                        style={{ marginTop: 2, accentColor: 'var(--accent-teal)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 'var(--font-medium)' }}>{repo.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{repo.desc}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono','Courier New',monospace", wordBreak: 'break-all' }}>{repo.url}</div>
                      </div>
                    </label>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: tvKodiRepoStatus ? 8 : 0 }}>
                  {/* ── Install Selected → sources.xml ── */}
                  <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                    disabled={tvKodiRepoBusy || !serial || tvKodiRepos.size === 0}
                    onClick={async () => {
                      setTvKodiRepoBusy(true)
                      const selected = KODI_REPOS.filter(r => tvKodiRepos.has(r.id))
                      try {
                        // 1. Read existing sources.xml (may not exist)
                        setTvKodiRepoStatus('Reading existing sources.xml…')
                        let existing = null
                        try {
                          const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'cat', KODI_SOURCES_PATH] })
                          const out = (r.stdout || '').trim()
                          if (out.startsWith('<?xml') || out.startsWith('<sources')) existing = out
                        } catch { /* file doesn't exist yet */ }

                        // 2. Build merged XML
                        setTvKodiRepoStatus(`Building sources.xml with ${selected.length} repo${selected.length !== 1 ? 's' : ''}…`)
                        const xml = buildKodiSourcesXml(existing, selected)

                        // 3. Ensure Kodi userdata dir exists on device
                        const kodiDataDir = '/sdcard/Android/data/org.xbmc.kodi/files/.kodi/userdata'
                        await invoke('run_adb', { args: ['-s', serial, 'shell', 'mkdir', '-p', kodiDataDir] })

                        // 4. Write to temp file and push
                        setTvKodiRepoStatus('Pushing sources.xml to device…')
                        const tmpPath = await pathJoin(await downloadDir(), 'kodi_sources_tmp.xml')
                        await writeTextFile(tmpPath, xml)
                        await invoke('run_adb', { args: ['-s', serial, 'push', tmpPath, KODI_SOURCES_PATH] })
                        await remove(tmpPath)

                        setTvKodiRepoStatus(`✓ ${selected.length} repo${selected.length !== 1 ? 's' : ''} added to Kodi sources — restart Kodi and go to File Manager to verify`)
                      } catch (e) {
                        setTvKodiRepoStatus(`✗ Error: ${String(e)}`)
                      } finally {
                        setTvKodiRepoBusy(false)
                      }
                    }}>
                    {tvKodiRepoBusy ? 'Working…' : `Install Selected to Device (${tvKodiRepos.size})`}
                  </button>

                  {/* ── View Current Kodi Sources ── */}
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                    disabled={tvKodiRepoBusy || !serial}
                    onClick={async () => {
                      setTvKodiRepoBusy(true)
                      setTvKodiRepoStatus('Reading sources.xml…')
                      try {
                        const r = await invoke('run_adb', { args: ['-s', serial, 'shell', 'cat', KODI_SOURCES_PATH] })
                        const out = (r.stdout || '').trim()
                        setTvKodiSourcesView(out || '(file is empty)')
                        setTvKodiRepoStatus(null)
                      } catch (e) {
                        setTvKodiRepoStatus(`✗ Error: ${String(e)}`)
                        setTvKodiSourcesView(null)
                      } finally {
                        setTvKodiRepoBusy(false)
                      }
                    }}>
                    View Sources
                  </button>

                  {/* ── Backup Kodi Sources ── */}
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                    disabled={tvKodiRepoBusy || !serial}
                    onClick={async () => {
                      setTvKodiRepoBusy(true)
                      setTvKodiRepoStatus('Backing up sources.xml…')
                      try {
                        const dl      = await downloadDir()
                        const kodiDir = await pathJoin(dl, 'Nocturnal Toolkit', 'Kodi')
                        await mkdir(kodiDir, { recursive: true })
                        const dest = await pathJoin(kodiDir, 'sources.xml.backup')
                        await invoke('run_adb', { args: ['-s', serial, 'pull', KODI_SOURCES_PATH, dest] })
                        setTvKodiRepoStatus(`✓ Backup saved to ~/Downloads/Nocturnal Toolkit/Kodi/sources.xml.backup`)
                      } catch (e) {
                        setTvKodiRepoStatus(`✗ Error: ${String(e)}`)
                      } finally {
                        setTvKodiRepoBusy(false)
                      }
                    }}>
                    Backup Sources
                  </button>
                </div>

                {/* Status banner */}
                {tvKodiRepoStatus && (
                  <div style={{
                    marginTop: 8, padding: '7px 10px', borderRadius: 'var(--radius-sm)', fontSize: 11, lineHeight: 1.5,
                    background: tvKodiRepoStatus.startsWith('✓') ? 'rgba(20,184,166,0.08)' : tvKodiRepoStatus.startsWith('✗') ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                    border:     `1px solid ${tvKodiRepoStatus.startsWith('✓') ? 'rgba(20,184,166,0.3)' : tvKodiRepoStatus.startsWith('✗') ? 'rgba(239,68,68,0.3)' : 'var(--border-subtle)'}`,
                    color:      tvKodiRepoStatus.startsWith('✓') ? 'var(--accent-teal)' : tvKodiRepoStatus.startsWith('✗') ? 'var(--accent-red)' : 'var(--text-secondary)',
                  }}>
                    {tvKodiRepoStatus}
                  </div>
                )}

                {/* View sources.xml inline box */}
                {tvKodiSourcesView && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>sources.xml</span>
                      <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }} onClick={() => setTvKodiSourcesView(null)}>✕ Close</button>
                    </div>
                    <pre style={{ margin: 0, padding: '10px 12px', background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)', borderRadius: 'var(--radius-sm)', fontSize: 10, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflowY: 'auto', lineHeight: 1.5 }}>
                      {tvKodiSourcesView}
                    </pre>
                  </div>
                )}
              </div>

              {/* ── How to add repos ── */}
              <div style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                <div style={{ fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 4 }}>How to Add Repositories</div>
                {[
                  '1. Select repos above and press "Install Selected to Device"',
                  '2. Repos are written directly to Kodi\'s sources.xml on the device',
                  '3. Restart Kodi — repos appear in Settings → File Manager automatically',
                  '4. Add-ons → Install from zip file → select your repo source',
                  '5. Install from repository → find and install add-ons',
                ].map((step, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, padding: '1px 0' }}>
                    <span style={{ color: 'var(--accent-teal)', flexShrink: 0 }}>→</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>

              {/* ── Sub-section: Media Apps ── */}
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.08em', marginTop: 18, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--border-subtle)' }}>MEDIA APPS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  {
                    title: 'Universal Tools',
                    subtitle: 'Ad-free YouTube replacements and cross-device media helpers',
                    apps: [
                      {
                        id: 'smarttube',
                        name: 'SmartTube (Stable)',
                        compat: '🏷 Fire TV · Android TV · Google TV · Shield',
                        pkg: 'com.liskovsoft.smarttube.alt',
                        desc: 'Ad-free YouTube for Android TV. SponsorBlock built-in, 8K support, no Google Services required. Beta channel also available.',
                        source: 'GitHub — yuliskov/SmartTube',
                        resolve: () => tvResolveFireAppApk('smarttube-stable'),
                      },
                      {
                        id: 'tizentube-cobalt',
                        name: 'TizenTube Cobalt',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'io.gh.reisxd.tizentube.cobalt',
                        desc: 'Cobalt-based TizenTube port for Android TV with TV-friendly playback and official ARM and ARM64 APK releases.',
                        source: 'GitHub — reisxd/TizenTubeCobalt',
                        resolve: () => tvResolveMediaApk('tizentube-cobalt'),
                      },
                    ],
                  },
                  {
                    title: 'Streaming Apps',
                    subtitle: 'Full streaming clients, Debrid apps, and media hubs',
                    apps: [
                      {
                        id: 'stremio',
                        name: 'Stremio',
                        compat: '🏷 All Android TV Devices',
                        pkg: 'com.stremio.one',
                        desc: 'The gold standard for free streaming. Pair with Torrentio and Real-Debrid for a Netflix-like experience. Add-ons sync across all devices.',
                        source: 'Stremio — official dl.strem.io',
                        resolve: () => tvResolveStremioApk(),
                      },
                      {
                        id: 'cloudstream',
                        name: 'Cloudstream',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'com.lagradost.cloudstream3',
                        desc: 'Open-source streaming app with plugin support, subtitle support, casting, and a TV-friendly layout.',
                        source: 'GitHub — recloudstream/cloudstream',
                        resolve: () => tvResolveMediaApk('cloudstream'),
                      },
                      {
                        id: 'dodostream',
                        name: 'DodoStream',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'app.dodora.dodostream',
                        desc: 'Modern TV-first streaming app with Debrid support, polished navigation, and dedicated Android TV builds.',
                        source: 'GitHub — DodoraApp/DodoStream',
                        resolve: () => tvResolveMediaApk('dodostream'),
                      },
                      {
                        id: 'debridstream',
                        name: 'Debrid Stream',
                        compat: '🏷 Android TV · Google TV',
                        pkg: 'com.debridstream.tv',
                        desc: 'Focused Debrid streaming app for browsing and playing media directly from your Debrid account.',
                        source: 'Debrid Stream — official site',
                        resolve: () => tvResolveMediaApk('debridstream'),
                      },
                      {
                        id: 'debrify',
                        name: 'Debrify',
                        compat: '🏷 Android TV · Google TV · Tablets',
                        pkg: 'com.debrify.app',
                        desc: 'Cross-platform Debrid media app with Android TV support and a clean modern interface.',
                        source: 'GitHub — varunsalian/debrify',
                        resolve: () => tvResolveMediaApk('debrify'),
                      },
                      {
                        id: 'strmr',
                        name: 'STRMR',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'com.strmr.ps',
                        desc: 'Streaming app with TV support and a dedicated Android release track from the official STRMR team.',
                        source: 'STRMR — official releases',
                        resolve: () => tvResolveMediaApk('strmr'),
                      },
                      {
                        id: 'wuplay',
                        name: 'WuPlay',
                        compat: '🏷 Android TV · Google TV',
                        pkg: 'app.wuplay.androidtv',
                        desc: 'Android TV streaming app with Stremio add-on compatibility, profiles, discover views, and remote-friendly navigation.',
                        source: 'GitHub — me-here-now/wuplay-releases',
                        resolve: () => tvResolveMediaApk('wuplay'),
                      },
                      {
                        id: 'nuviotv',
                        name: 'NuvioTV',
                        compat: '🏷 Fire TV · Android TV · Google TV',
                        pkg: 'com.nuvio.tv',
                        desc: 'Modern open-source Stremio-compatible media hub. User profiles, cross-device sync, plugin system, Trakt integration. Best new streaming app of 2026.',
                        source: 'GitHub — NuvioMedia/NuvioTV',
                        resolve: () => tvResolveMediaApk('nuviotv'),
                      },
                      {
                        id: 'arvio',
                        name: 'ARVIO',
                        compat: '🏷 Android TV · Google TV',
                        pkg: 'com.arvio.tv',
                        desc: 'Android TV media hub with live TV support, cloud sync options, and a polished big-screen interface.',
                        source: 'GitHub — ProdigyV21/ARVIO',
                        resolve: () => tvResolveMediaApk('arvio'),
                      },
                      {
                        id: 'weyd',
                        name: 'Weyd',
                        compat: '🏷 Android TV · Google TV',
                        pkg: 'app.weyd.player',
                        desc: 'Premium streaming app with a refined TV UI. The official site serves the download flow, so the toolkit opens Weyd in your browser instead of trying to ingest the landing page as an APK.',
                        source: 'Weyd — official weyd.app',
                        resolve: () => tvResolveMediaApk('weyd'),
                        externalInstall: true,
                      },
                      {
                        id: 'lumera',
                        name: 'Lumera',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'com.lumera.app',
                        desc: 'Modern media app with Debrid-friendly workflows and an Android release published by the official Lumera project.',
                        source: 'GitHub — LumeraD3v/Lumera',
                        resolve: () => tvResolveMediaApk('lumera'),
                      },
                      {
                        id: 'syncler',
                        name: 'Syncler',
                        compat: '🏷 Android TV · Google TV · Fire TV',
                        pkg: 'com.syncler',
                        desc: 'Popular TV streaming app with automatic device-optimized downloads served from the official Syncler site.',
                        source: 'Syncler — official syncler.net',
                        resolve: () => tvResolveMediaApk('syncler'),
                      },
                    ],
                  },
                  {
                    title: 'Media Tools',
                    subtitle: 'Playback tools and general media utilities',
                    apps: [
                      {
                        id: 'vlc',
                        name: 'VLC',
                        compat: '🏷 All Android TV Devices',
                        pkg: 'org.videolan.vlc',
                        desc: 'The universal open-source media player. Plays any format, supports network streams, DLNA, subtitles, and hardware decoding. No ads, no tracking.',
                        source: 'VideoLAN — official',
                        resolve: () => tvResolveMediaApk('vlc'),
                      },
                    ],
                  },
                ].map(group => (
                  <div key={group.title}>
                    <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', letterSpacing: '0.06em', marginBottom: 4 }}>
                      {group.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
                      {group.subtitle}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {group.apps.map(app => {
                        const instState   = tvMediaInstalling[app.id]
                        const prog        = tvMediaProgress[app.id]
                        const isInstalled = tvMediaInstalled[app.id]
                        const inProgress  = instState === 'resolving' || instState === 'downloading' || instState === 'installing'
                        return (
                          <div key={app.id} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.025)', border: `1px solid ${isInstalled ? 'rgba(34,197,94,0.3)' : 'var(--border-subtle)'}`, transition: 'border-color 0.2s' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 12, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{app.name}</span>
                                  {isInstalled && <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 'var(--font-medium)' }}>● Installed</span>}
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{app.compat}</div>
                                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3, lineHeight: 1.5 }}>{app.desc}</div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>
                                  {prog ? `${prog.percent ?? 0}% — ${prog.speed ?? ''}` : app.source}
                                </div>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0, minWidth: 108 }}>
                                <button
                                  className={isInstalled ? 'btn-ghost' : 'btn-primary'}
                                  style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                                  disabled={!serial || inProgress}
                                  onClick={async () => {
                                    if (!serial) return
                                    if (app.externalInstall) {
                                      const resolved = await app.resolve()
                                      if (resolved?.externalUrl) {
                                        await openUrl(resolved.externalUrl)
                                        tvAppend(`Opened ${app.name} download page: ${resolved.externalUrl}\n`)
                                      }
                                      return
                                    }
                                    setTvMediaInstalling(s => ({ ...s, [app.id]: 'resolving' }))
                                    try {
                                      const { url, filename } = await app.resolve()
                                      await tvInstallMediaApp(app.id, url, filename)
                                    } catch (e) {
                                      setTvMediaInstalling(s => ({ ...s, [app.id]: 'error' }))
                                      tvAppend(`Error resolving ${app.name}: ${e}\n`)
                                    }
                                  }}>
                                  {app.externalInstall         ? 'Open Site ↗'
                                    : instState === 'resolving'    ? 'Resolving…'
                                    : instState === 'downloading' ? `↓ ${prog?.percent ?? 0}%`
                                    : instState === 'installing'  ? 'Installing…'
                                    : instState === 'error'       ? '✗ Retry'
                                    : isInstalled                 ? '↺ Reinstall'
                                    : 'Install'}
                                </button>
                                {isInstalled && app.pkg && (
                                  <button className="btn-danger" style={{ fontSize: 10, padding: '4px 10px', width: '100%' }}
                                    disabled={!serial}
                                    onClick={async () => {
                                      await tvRun(['-s', serial, 'shell', 'pm', 'uninstall', app.pkg])
                                      setTvMediaInstalled(s => ({ ...s, [app.id]: false }))
                                    }}>
                                    Uninstall
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Sub-section: Info & Services ── */}
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.08em', marginTop: 18, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--border-subtle)' }}>SERVICES & LINKS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {MEDIA_CENTER_INFO.map(site => (
                  <div key={site.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{site.name}</span>
                        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', letterSpacing: '0.04em' }}>{site.tag}</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono, marginBottom: 2 }}>{site.compat}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{site.desc}</div>
                    </div>
                    <button className="btn-ghost" style={{ fontSize: 10, padding: '4px 10px', flexShrink: 0 }}
                      onClick={() => openUrl(site.url)}>
                      Open Site ↗
                    </button>
                  </div>
                ))}
              </div>
            </QuestCard>
            )}

            {/* ── Shared output terminal ── */}
            {tvOutput && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>OUTPUT</span>
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }} onClick={() => setTvOutput('')}>Clear</button>
                </div>
                <pre ref={tvOutputRef} style={{ margin: 0, padding: '10px 12px', background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflowY: 'auto', lineHeight: 1.5 }}>
                  {tvOutput}
                </pre>
              </div>
            )}

          </div>
          )}
        </div>
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && (
        <div ref={ctxRef} style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 9999, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 0', minWidth: 190, boxShadow: '0 8px 28px rgba(0,0,0,0.55)' }}>
          {ctxMenu.entry === null ? (<>
            {/* Empty area menu */}
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { setNewFolderTarget({ pane: ctxMenu.pane, name: '' }); setCtxMenu(null) }}>📁 New Folder</button>
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { if (ctxMenu.pane === 'local') loadLocalEntries(localPath); else loadDevEntries(devPath); setCtxMenu(null) }}>↺ Refresh</button>
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { navigator.clipboard.writeText(ctxMenu.pane === 'local' ? localPath : devPath); setCtxMenu(null) }}>📋 Copy current path</button>
          </>) : ctxMenu.pane === 'local' ? (<>
            {isLocalNav(ctxMenu.entry) && (
              <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
                onClick={() => { localNavigateTo(ctxMenu.entry.name); setCtxMenu(null) }}>📁 Open</button>
            )}
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { openInFinder(ctxMenu.entry); setCtxMenu(null) }}>🔍 Show in Finder</button>
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={async () => { navigator.clipboard.writeText(await pathJoin(localPath, ctxMenu.entry.name)); setCtxMenu(null) }}>📋 Copy path</button>
            {!isLocalNav(ctxMenu.entry) && (
              <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
                disabled={noDevice} onClick={() => { pushToDevice(ctxMenu.entry); setCtxMenu(null) }}>⬆ Push to Device</button>
            )}
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button style={{ ...ctxItemStyle, color: 'var(--accent-red)' }} onMouseEnter={e => e.target.style.background = 'rgba(239,68,68,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { localDeleteEntry(ctxMenu.entry); setCtxMenu(null) }}>🗑 Delete</button>
          </>) : (<>
            {isDevNav(ctxMenu.entry) && (
              <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
                onClick={() => { devNavigateTo(ctxMenu.entry.name); setCtxMenu(null) }}>📁 Open</button>
            )}
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { pullToLocal(ctxMenu.entry); setCtxMenu(null) }}>⬇ Pull to Local</button>
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { navigator.clipboard.writeText(devRemotePath(ctxMenu.entry.name)); setCtxMenu(null) }}>📋 Copy path</button>
            {ctxMenu.entry.name.endsWith('.apk') && (
              <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
                onClick={async () => {
                  const rp = devRemotePath(ctxMenu.entry.name)
                  const lp = await pathJoin(localPath, ctxMenu.entry.name)
                  setCtxMenu(null)
                  await invoke('run_adb', { args: ['-s', serial, 'pull', rp, lp] })
                  await invoke('run_adb', { args: ['-s', serial, 'install', '-r', lp] })
                  loadLocalEntries(localPath)
                }}>📦 Pull &amp; Install</button>
            )}
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button style={ctxItemStyle} onMouseEnter={e => e.target.style.background = 'rgba(168,85,247,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { setRenameTarget({ entry: ctxMenu.entry, newName: ctxMenu.entry.name }); setCtxMenu(null) }}>✏️ Rename</button>
            <button style={{ ...ctxItemStyle, color: 'var(--accent-red)' }} onMouseEnter={e => e.target.style.background = 'rgba(239,68,68,0.12)'} onMouseLeave={e => e.target.style.background = 'none'}
              onClick={() => { devDeleteEntry(ctxMenu.entry); setCtxMenu(null) }}>🗑 Delete</button>
          </>)}
        </div>
      )}
    </>
  )

  return embedded
    ? panelBody
    : <div className="panel-content">{panelBody}</div>
}

// ── Mode-specific panel wrappers ───────────────────────────────────────────────

function FilesPanel({ device, onNavigateToDevices }) {
  return <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="files" />
}

function QuestPanel({ device, onNavigateToDevices, platform }) {
  return <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="quest" platform={platform} />
}

function RomPanel({ device, onNavigateToDevices }) {
  return <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="rom" />
}

function GeneralPanel({ device, onNavigateToDevices, platform, onOpenPanel }) {
  return <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="general" platform={platform} onOpenPanel={onOpenPanel} />
}

function TVPanel({ device, onNavigateToDevices }) {
  return <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="tv" />
}

const SECURITY_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'security', label: 'Security' },
  { id: 'vpn', label: 'VPN' },
]

const SECURITY_TRUST = {
  top: { label: 'Top Pick', color: 'var(--accent)', bg: 'rgba(168,85,247,0.16)' },
  trusted: { label: 'Trusted', color: 'var(--accent-green)', bg: 'rgba(34,197,94,0.16)' },
  premium: { label: 'Premium', color: 'var(--accent-yellow)', bg: 'rgba(245,158,11,0.16)' },
}

async function resolveGithubLatestApk(repo, matcher) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub release lookup failed for ${repo}: ${response.status}`)
  const data = await response.json()
  const asset = (data.assets || []).find(asset => matcher(asset?.name || ''))
  if (!asset?.browser_download_url) throw new Error(`No APK asset found for ${repo}`)
  return { url: asset.browser_download_url, filename: asset.name, pageUrl: data.html_url || '' }
}

function playStoreSearchUrl(query) {
  return `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps`
}

function playStoreIntentUrl(query) {
  return `market://search?q=${encodeURIComponent(query)}&c=apps`
}

const SECURITY_APPS = [
  {
    id: 'varynx',
    category: 'security',
    source: 'play',
    name: 'VARYNX-2.0',
    icon: '🛡️',
    badge: 'top',
    tagline: 'Offline behavioral guardian',
    pkg: '',
    playQuery: 'VARYNX-2.0',
    desc: 'Monitors for hardware skimmers, network anomalies, and device tampering without cloud telemetry.',
    tags: ['Offline', 'Behavioral Guard', 'Tamper Checks'],
  },
  {
    id: 'hypatia',
    category: 'security',
    source: 'fdroid',
    name: 'Hypatia',
    icon: '🧬',
    badge: 'trusted',
    tagline: 'Local FOSS malware scanner',
    pkg: 'us.spotco.malwarescanner',
    apkUrl: 'https://f-droid.org/repo/us.spotco.malwarescanner_314.apk',
    pageUrl: 'https://f-droid.org/packages/us.spotco.malwarescanner/',
    desc: 'Privacy-focused malware scanner that works 100% locally with near-zero battery drain.',
    tags: ['F-Droid', 'Local Only', 'Low Battery'],
  },
  {
    id: 'bitdefender',
    category: 'security',
    source: 'play',
    name: 'Bitdefender Mobile Security',
    icon: '🦠',
    badge: 'premium',
    tagline: 'Cloud-assisted mobile antivirus',
    pkg: 'com.bitdefender.antivirus',
    playQuery: 'Bitdefender Mobile Security',
    desc: 'Cloud-based scanning, SMS scam alerts, and App Lock protection for Android devices.',
    tags: ['Realtime', 'SMS Alerts', 'App Lock'],
  },
  {
    id: 'norton',
    category: 'security',
    source: 'play',
    name: 'Norton 360 Deluxe',
    icon: '🧠',
    badge: 'premium',
    tagline: 'Identity and malware protection suite',
    pkg: 'com.symantec.mobilesecurity',
    playQuery: 'Norton 360 Deluxe',
    desc: 'Dark Web Monitoring, phishing defense, malware scanning, and broader identity protection features.',
    tags: ['Identity', 'Dark Web', 'Phishing'],
  },
  {
    id: 'aegis',
    category: 'security',
    source: 'github',
    name: 'Aegis Authenticator',
    icon: '🔐',
    badge: 'trusted',
    tagline: 'Open-source 2FA vault',
    pkg: 'com.beemdevelopment.aegis',
    githubRepo: 'beemdevelopment/Aegis',
    githubMatcher: name => /^aegis-.*\.apk$/i.test(name),
    pageUrl: 'https://f-droid.org/packages/com.beemdevelopment.aegis/',
    desc: 'Encrypted local backups, strong 2FA management, and a clean Material You-friendly interface.',
    tags: ['2FA', 'Encrypted Backups', 'FOSS', 'GitHub'],
  },
  {
    id: 'sophos',
    category: 'security',
    source: 'play',
    name: 'Sophos Intercept X',
    icon: '📶',
    badge: 'trusted',
    tagline: 'Free mobile security suite',
    pkg: 'com.sophos.smsec',
    playQuery: 'Sophos Intercept X',
    desc: 'Free mobile security with a secure QR scanner, link checking, and Wi-Fi security advice.',
    tags: ['Free', 'QR Scanner', 'Wi-Fi Advisor'],
  },
  {
    id: 'protonvpn',
    category: 'vpn',
    source: 'github',
    name: 'Proton VPN',
    icon: '🟣',
    badge: 'top',
    tagline: 'Swiss no-logs VPN',
    pkg: 'ch.protonvpn.android',
    githubRepo: 'ProtonVPN/android-app',
    githubMatcher: name => /\.apk$/i.test(name) && /direct-release/i.test(name),
    desc: 'Open-source, no-logs VPN with Secure Core, strong privacy defaults, and a strong free tier.',
    tags: ['No Logs', 'Secure Core', 'Free Tier', 'GitHub'],
  },
  {
    id: 'mullvad',
    category: 'vpn',
    source: 'github',
    name: 'Mullvad VPN',
    icon: '🦊',
    badge: 'trusted',
    tagline: 'Maximum anonymity VPN',
    pkg: 'net.mullvad.mullvadvpn',
    githubRepo: 'mullvad/mullvadvpn-app',
    githubMatcher: name => /^MullvadVPN-.*\.apk$/i.test(name) && !/\.asc$/i.test(name),
    desc: 'Account-number-based VPN with flat pricing and a strong anonymity-first posture.',
    tags: ['Anonymous', 'Flat Rate', 'Privacy', 'GitHub'],
  },
  {
    id: 'surfshark',
    category: 'vpn',
    source: 'play',
    name: 'Surfshark',
    icon: '🌊',
    badge: 'premium',
    tagline: 'Family-friendly VPN with GPS spoofing',
    pkg: 'com.surfshark.vpnclient.android',
    playQuery: 'Surfshark',
    desc: 'Unlimited simultaneous connections with GPS spoofing and a consumer-friendly multi-device setup.',
    tags: ['Unlimited Devices', 'GPS Spoofing', 'Families'],
  },
  {
    id: 'nordvpn',
    category: 'vpn',
    source: 'play',
    name: 'NordVPN',
    icon: '🌐',
    badge: 'premium',
    tagline: 'Fast VPN with DNS-layer protection',
    pkg: 'com.nordvpn.android',
    playQuery: 'NordVPN',
    desc: 'Fast, feature-rich VPN with Threat Protection style DNS filtering for ads, trackers, and malware.',
    tags: ['Fast', 'Threat Protection', 'DNS Filtering'],
  },
  {
    id: 'ivpn',
    category: 'vpn',
    source: 'official',
    name: 'IVPN',
    icon: '🔒',
    badge: 'trusted',
    tagline: 'Audited privacy-hardened VPN',
    pkg: 'net.ivpn.client',
    browserUrl: 'https://www.ivpn.net/apps-android/',
    desc: 'Multi-hop routing, transparent infrastructure, and a security-forward service design.',
    tags: ['Multi-hop', 'Audited', 'Official Site'],
  },
]

function SecurityAppCard({ app, serial, noDevice, platform, status, onStatusChange, addToast }) {
  const [phase, setPhase] = useState('idle')
  const [errMsg, setErrMsg] = useState('')
  const busy = phase === 'downloading' || phase === 'installing' || phase === 'opening'
  const isInstalled = status === 'installed'
  const isChecking = status === 'checking'
  const badge = SECURITY_TRUST[app.badge] || SECURITY_TRUST.trusted

  async function recheckStatus() {
    if (!app.pkg || !serial) return
    onStatusChange(app.id, 'checking')
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-e', app.pkg] })
      onStatusChange(app.id, res.stdout?.includes(`package:${app.pkg}`) ? 'installed' : 'not_installed')
    } catch {
      onStatusChange(app.id, 'not_installed')
    }
  }

  async function openOnDevice() {
    if (!serial) return false
    const targetUrl = app.source === 'play'
      ? playStoreIntentUrl(app.playQuery || app.name)
      : app.browserUrl || app.pageUrl || playStoreSearchUrl(app.playQuery || app.name)
    try {
      setPhase('opening')
      await invoke('run_adb', {
        args: ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', targetUrl],
      })
      addToast(`Opened ${app.name} on the device`, 'success')
      setPhase('idle')
      return true
    } catch (error) {
      setPhase('error')
      setErrMsg(String(error))
      return false
    }
  }

  async function handlePrimary() {
    setErrMsg('')
    if ((app.source === 'fdroid' && app.apkUrl) || app.source === 'github') {
      if (noDevice) return
      setPhase('downloading')
      const timer = setTimeout(() => setPhase(p => (p === 'downloading' ? 'installing' : p)), 1800)
      try {
        const resolved = app.source === 'github'
          ? await resolveGithubLatestApk(app.githubRepo, app.githubMatcher)
          : { url: app.apkUrl }
        const res = await invoke('install_from_url', {
          serial,
          url: resolved.url,
          filename: resolved.filename || `security_${app.id}.apk`,
        })
        clearTimeout(timer)
        if (platform === 'android' && res?.localPath) await openUrl(res.localPath)
        if (res.ok) {
          addToast(platform === 'android' && res?.localPath
            ? `${app.name} opened in the Android package installer`
            : `${app.name} installed successfully`, 'success')
          setPhase('idle')
          recheckStatus()
        } else {
          setPhase('error')
          setErrMsg(res.stderr?.trim() || res.stdout?.trim() || 'Install failed')
          addToast(`Failed to install ${app.name}`, 'error')
        }
      } catch (error) {
        clearTimeout(timer)
        setPhase('error')
        setErrMsg(String(error))
        addToast(`Failed to install ${app.name}`, 'error')
      }
      return
    }

    if (!noDevice && (app.source === 'play' || app.source === 'official')) {
      const opened = await openOnDevice()
      if (opened) return
    }

    await openUrl(
      app.source === 'play'
        ? playStoreSearchUrl(app.playQuery || app.name)
        : app.browserUrl || app.pageUrl || playStoreSearchUrl(app.playQuery || app.name)
    )
    setPhase('idle')
  }

  const actionLabel = app.source === 'fdroid'
    ? (busy ? (phase === 'downloading' ? 'Downloading…' : 'Installing…') : isInstalled ? 'Reinstall' : 'Install')
    : app.source === 'github'
    ? (busy ? (phase === 'downloading' ? 'Downloading…' : 'Installing…') : isInstalled ? 'Reinstall' : 'Install')
    : busy
      ? 'Opening…'
      : (!noDevice ? 'Open on Device' : app.source === 'play' ? 'Open Play Store' : 'Open Site')

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: `1px solid ${isInstalled ? 'rgba(34,197,94,0.22)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-lg)',
      padding: '14px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 28, lineHeight: 1, flexShrink: 0 }}>{app.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
            <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
              {app.name}
            </span>
            <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', padding: '1px 5px', borderRadius: 4, background: badge.bg, color: badge.color }}>
              {badge.label}
            </span>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
            {app.tagline}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        {app.desc}
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: badge.color }}>
          {app.source === 'fdroid' ? 'F-Droid' : app.source === 'github' ? 'GitHub' : app.source === 'play' ? 'Google Play' : 'Official Site'}
        </span>
        {app.tags.map(tag => (
          <span key={tag} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)' }}>
            {tag}
          </span>
        ))}
      </div>

      <div style={{ fontSize: 'var(--text-xs)', minHeight: 14 }}>
        {isChecking && serial
          ? <span style={{ color: 'var(--text-muted)' }}>Checking…</span>
          : isInstalled
            ? <span style={{ color: 'var(--accent-green)', fontWeight: 'var(--font-semibold)' }}>● Installed</span>
            : app.source === 'fdroid' || app.source === 'github'
              ? <span style={{ color: noDevice ? 'var(--text-muted)' : 'var(--accent-teal)' }}>{noDevice ? 'Connect a device to install' : 'Ready for direct install'}</span>
              : <span style={{ color: 'var(--text-muted)' }}>{!noDevice ? 'Can open on device or in browser' : 'Opens store page in browser'}</span>}
      </div>

      {phase === 'error' && errMsg && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)', wordBreak: 'break-word' }}>{errMsg}</div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className={app.source === 'fdroid' || app.source === 'github' ? 'btn-success' : 'btn-primary'}
          style={{ ...btnStyle, flex: 1 }}
          disabled={((app.source === 'fdroid' || app.source === 'github') && noDevice) || busy}
          onClick={handlePrimary}
        >
          {actionLabel}
        </button>
        <button
          className="btn-ghost"
          style={{ ...btnStyle, flex: 1 }}
          onClick={() => openUrl(
            app.source === 'play'
              ? playStoreSearchUrl(app.playQuery || app.name)
              : app.source === 'github'
                ? `https://github.com/${app.githubRepo}/releases`
                : app.browserUrl || app.pageUrl || playStoreSearchUrl(app.playQuery || app.name)
          )}
        >
          {app.source === 'fdroid' ? 'View Page' : app.source === 'github' ? 'Releases' : app.source === 'play' ? 'Browser' : 'Official'}
        </button>
      </div>
    </div>
  )
}

function SecurityHubPanel({ device, onNavigateToDevices, platform }) {
  const [catFilter, setCatFilter] = useState('all')
  const [statuses, setStatuses] = useState({})
  const [toasts, setToasts] = useState([])
  const serial = device?.serial
  const noDevice = !device || device.status !== 'device'

  useEffect(() => {
    if (!serial) {
      setStatuses({})
      return
    }
    const fresh = {}
    SECURITY_APPS.forEach(app => {
      if (app.pkg) fresh[app.id] = 'checking'
    })
    setStatuses(fresh)
    SECURITY_APPS.forEach(app => {
      if (!app.pkg) return
      invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-e', app.pkg] })
        .then(res => {
          const installed = res.stdout?.includes(`package:${app.pkg}`) ?? false
          setStatuses(s => ({ ...s, [app.id]: installed ? 'installed' : 'not_installed' }))
        })
        .catch(() => setStatuses(s => ({ ...s, [app.id]: 'not_installed' })))
    })
  }, [serial])

  function addToast(msg, type = 'success') {
    const id = crypto.randomUUID()
    setToasts(items => [...items, { id, msg, type }])
    setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 3000)
  }

  const filtered = catFilter === 'all'
    ? SECURITY_APPS
    : SECURITY_APPS.filter(app => app.category === catFilter)

  const directCount = SECURITY_APPS.filter(app => app.source === 'fdroid').length

  return (
    <div className="panel-content" style={{ position: 'relative', padding: 0 }}>
      {noDevice && (
        <div className="warning-banner" style={{ marginBottom: 20 }}>
          <span>No device connected — direct F-Droid installs are disabled, but Play Store and official links still work.</span>
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
            View Devices
          </button>
        </div>
      )}

      <div style={{
        background: 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.06))',
        border: '1px solid rgba(34,197,94,0.18)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 18px',
        marginBottom: 18,
      }}>
        <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-green)', marginBottom: 8 }}>
          Security & VPN Master List
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Curated 2026-ready Android security and VPN recommendations. F-Droid entries install directly from the toolkit. Play Store and official-site entries open on your connected phone when possible, or in your browser as a fallback.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={{ fontSize: 10, color: 'var(--accent)', background: 'rgba(168,85,247,0.15)', borderRadius: 999, padding: '2px 8px' }}>Top Picks: VARYNX-2.0 + Proton VPN</span>
          <span style={{ fontSize: 10, color: 'var(--accent-green)', background: 'rgba(34,197,94,0.14)', borderRadius: 999, padding: '2px 8px' }}>{directCount} direct F-Droid installs</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {SECURITY_CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className={catFilter === cat.id ? 'btn-primary' : 'btn-ghost'}
            style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', borderRadius: 99 }}
            onClick={() => setCatFilter(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {filtered.map(app => (
          <SecurityAppCard
            key={app.id}
            app={app}
            serial={serial}
            noDevice={noDevice}
            platform={platform}
            status={statuses[app.id]}
            onStatusChange={(id, value) => setStatuses(s => ({ ...s, [id]: value }))}
            addToast={addToast}
          />
        ))}
      </div>

      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        display: 'flex', flexDirection: 'column', gap: 8,
        zIndex: 9999, pointerEvents: 'none',
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: toast.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            fontSize: 'var(--text-sm)',
            maxWidth: 340,
            backdropFilter: 'blur(8px)',
          }}>
            <span>{toast.type === 'success' ? '✓' : '✗'}</span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PhoneToolsPanel({ device, deviceProps, onNavigateToDevices, platform, onOpenPanel }) {
  const serial = device?.serial
  const noDevice = !device || device.status !== 'device'
  const [tab, setTab] = useState('tools')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [securePkg, setSecurePkg] = useState('')
  const [permPkg, setPermPkg] = useState('')
  const [permName, setPermName] = useState('')
  const [statusIcons, setStatusIcons] = useState('alarm_clock,bluetooth,rotate,headset')

  function append(line) {
    setOutput(prev => `${prev}${prev ? '\n' : ''}${line}`)
  }

  async function runPhoneAdb(args, label) {
    if (!serial || running) return
    if (label) append(`$ ${label}`)
    setRunning(true)
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, ...args] })
      append(([res.stdout, res.stderr].filter(Boolean).join('\n').trim() || 'Done.'))
    } catch (error) {
      append(`Error: ${error}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Phone Tools</h1>
        </div>
        {noDevice && (
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
            Connect Device
          </button>
        )}
      </div>

      <div className="panel-scroll">
        <div style={{
          background: 'linear-gradient(135deg, rgba(20,184,166,0.08), rgba(168,85,247,0.05))',
          border: '1px solid rgba(20,184,166,0.18)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px 18px',
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 20, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
            Phone Tools
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Phone-first controls inspired by the most useful ADB workflows: app control, UI cleanup, DNS, display tweaks, battery tuning, and cleanup actions you can actually apply from this toolkit.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {[
            { id: 'tools', label: 'Tools' },
            { id: 'security', label: 'Security' },
            { id: 'tweaks', label: 'Tweaks' },
            { id: 'maintenance', label: 'Maintenance' },
            { id: 'backups', label: 'Backup & Restore' },
          ].map(item => (
            <button
              key={item.id}
              className={tab === item.id ? 'btn-primary' : 'btn-ghost'}
              style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', borderRadius: 99 }}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'tools' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {noDevice && (
              <div className="warning-banner">
                <span>No device connected — phone tool actions are disabled</span>
                <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
                  View Devices
                </button>
              </div>
            )}

            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
              <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
                App Control
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
                Debloating and app control are one of the most useful ADB workflows. The toolkit keeps the full debloat workbench in the Maintenance tab and app actions in Manage Apps.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} onClick={() => setTab('maintenance')}>Open Debloat &amp; App Care</button>
                <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} onClick={() => onOpenPanel?.('manage')}>Open Manage Apps</button>
                <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} onClick={() => onOpenPanel?.('backups')}>Open Backup &amp; Restore</button>
              </div>
            </div>

            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
              <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
                System UI & Immersive
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>
                Clean up status-bar icons and toggle immersive layouts directly through ADB from the toolkit.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                {[
                  { label: 'Minimal Icons', value: 'alarm_clock,bluetooth,rotate,headset' },
                  { label: 'Travel Icons', value: 'alarm_clock,bluetooth,rotate,headset,vpn,hotspot' },
                  { label: 'Reset Icons', value: '' },
                ].map(preset => (
                  <button key={preset.label} className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running}
                    onClick={() => {
                      setStatusIcons(preset.value)
                      runPhoneAdb(preset.value ? ['shell', 'settings', 'put', 'secure', 'icon_blacklist', preset.value] : ['shell', 'settings', 'delete', 'secure', 'icon_blacklist'], preset.label)
                    }}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <input value={statusIcons} onChange={e => setStatusIcons(e.target.value)} placeholder="alarm_clock,bluetooth,rotate"
                  style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running}
                  onClick={() => runPhoneAdb(statusIcons.trim() ? ['shell', 'settings', 'put', 'secure', 'icon_blacklist', statusIcons.trim()] : ['shell', 'settings', 'delete', 'secure', 'icon_blacklist'], 'Apply status bar icons')}>
                  Apply
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPhoneAdb(['shell', 'settings', 'put', 'global', 'policy_control', 'immersive.full=*'], 'Immersive full')}>Full Screen</button>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPhoneAdb(['shell', 'settings', 'put', 'global', 'policy_control', 'immersive.status=*'], 'Immersive status')}>Hide Status Bar</button>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPhoneAdb(['shell', 'settings', 'put', 'global', 'policy_control', 'immersive.navigation=*'], 'Immersive navigation')}>Hide Navigation</button>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runPhoneAdb(['shell', 'settings', 'put', 'global', 'policy_control', 'null'], 'Reset immersive mode')}>Reset</button>
              </div>
            </div>

            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
              <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
                Permissions & Setup Helpers
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
                Grant the ADB-level permissions these tools depend on, and jump straight into the Android settings pages you usually need during setup.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <input value={securePkg} onChange={e => setSecurePkg(e.target.value)} placeholder="com.example.app"
                  style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} disabled={!securePkg.trim() || noDevice || running}
                  onClick={() => runPhoneAdb(['shell', 'pm', 'grant', securePkg.trim(), 'android.permission.WRITE_SECURE_SETTINGS'], `grant WRITE_SECURE_SETTINGS ${securePkg.trim()}`)}>
                  Grant WRITE_SECURE_SETTINGS
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <input value={permPkg} onChange={e => setPermPkg(e.target.value)} placeholder="Package name"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                <input value={permName} onChange={e => setPermName(e.target.value)} placeholder="android.permission.DUMP"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'JetBrains Mono','Courier New',monospace", outline: 'none' }} />
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={!permPkg.trim() || !permName.trim() || noDevice || running}
                  onClick={() => runPhoneAdb(['shell', 'pm', 'grant', permPkg.trim(), permName.trim()], `grant ${permName.trim()}`)}>
                  Grant
                </button>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={!permPkg.trim() || !permName.trim() || noDevice || running}
                  onClick={() => runPhoneAdb(['shell', 'pm', 'revoke', permPkg.trim(), permName.trim()], `revoke ${permName.trim()}`)}>
                  Revoke
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running}
                  onClick={() => runPhoneAdb(['shell', 'am', 'start', '-a', 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'], 'Open Developer Options')}>
                  Open Developer Options
                </button>
                <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running}
                  onClick={() => runPhoneAdb(['shell', 'am', 'start', '-a', 'android.settings.WIRELESS_SETTINGS'], 'Open Wireless Settings')}>
                  Open Wireless Settings
                </button>
              </div>
            </div>

            <div style={{
              background: '#0a0a0a',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px',
              minHeight: 180,
            }}>
              <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
                Tools Output
              </div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {output || 'Run a phone tool action to see results here.'}
              </pre>
            </div>
          </div>
        )}

        {tab === 'tweaks' && (
          <DeviceToolsPanel device={device} onNavigateToDevices={onNavigateToDevices} mode="general" platform={platform} onOpenPanel={onOpenPanel} embedded />
        )}

        {tab === 'security' && (
          <SecurityHubPanel device={device} onNavigateToDevices={onNavigateToDevices} platform={platform} />
        )}

        {tab === 'maintenance' && (
          platform === 'android'
            ? <AndroidMaintenancePanel device={device} props={deviceProps} onNavigateToDevices={onNavigateToDevices} onOpenPanel={onOpenPanel} embedded />
            : <DesktopMaintenancePanel device={device} deviceProps={deviceProps} onNavigateToDevices={onNavigateToDevices} onOpenPanel={onOpenPanel} embedded />
        )}

        {tab === 'backups' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
              Backup &amp; Restore
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
              Open the dedicated Backup &amp; Restore panel to create, browse, and restore toolkit-managed backups.
            </div>
            <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }} onClick={() => onOpenPanel?.('backups')}>
              Open Backup &amp; Restore
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Drivers panel ─────────────────────────────────────────────────────────────

const DRIVERS = [
  {
    id: 'universal', icon: '🔌', name: 'Universal ADB Drivers', version: 'v6.0',
    author: 'universaladbdriver.com', size: '9.22 MB',
    color: ['#7c3aed', '#4f46e5'],
    desc: 'Works with virtually all Android devices. Best starting point.',
    tags: ['Universal', 'All Devices'],
    installUrl: 'https://universaladbdriver.com/wp-content/uploads/Universal_ADB_Driver_v6.0.zip',
    docsUrl: 'https://universaladbdriver.com',
  },
  {
    id: 'quest', icon: '🥽', name: 'Meta Quest USB Driver', version: 'v2.0',
    author: 'Meta Platforms', size: '8.3 MB',
    color: ['#0891b2', '#06b6d4'],
    desc: 'Official Meta driver for Quest 1/2/3 and Pro.',
    tags: ['Meta Quest', 'Official'],
    installUrl: 'https://developers.meta.com/horizon/downloads/package/oculus-adb-drivers/',
    docsUrl: 'https://developers.meta.com/horizon/downloads/package/oculus-adb-drivers/',
  },
  {
    id: 'google', icon: '🤖', name: 'Google USB Driver', version: 'r13',
    author: 'Google LLC', size: '6.2 MB',
    color: ['#059669', '#10b981'],
    desc: 'Official Google driver for Pixel phones and emulators.',
    tags: ['Pixel', 'Nexus'],
    installUrl: 'https://developer.android.com/studio/run/win-usb',
    docsUrl: 'https://developer.android.com/studio/run/win-usb',
  },
  {
    id: 'samsung', icon: '📱', name: 'Samsung USB Driver', version: 'v1.9.0',
    author: 'Samsung Electronics', size: '35.5 MB',
    color: ['#1d4ed8', '#3b82f6'],
    desc: 'Required for all Samsung Galaxy phones and tablets.',
    tags: ['Samsung', 'Galaxy'],
    installUrl: 'https://developer.samsung.com/android-usb-driver',
    docsUrl: 'https://developer.samsung.com/android-usb-driver',
  },
  {
    id: 'clockworkmod', icon: '⚙️', name: 'ClockworkMod ADB Driver', version: 'Latest',
    author: 'ClockworkMod', size: '—',
    color: ['#b45309', '#d97706'],
    desc: 'Universal ADB driver alternative, widely used by ROM flashers and modders.',
    tags: ['Universal', 'ROM Flashing'],
    installUrl: 'https://adb.clockworkmod.com/',
    docsUrl: 'https://adb.clockworkmod.com/',
  },
]

function DriversPanel({ platform }) {
  const isWindows = platform === 'windows'

  if (!isWindows) {
    return (
      <div className="panel-content">
        <div className="panel-header-row">
          <div style={{ minWidth: 0 }}>
            <div className="panel-header-accent" />
            <h1 className="panel-header">Drivers</h1>
          </div>
        </div>
        <div className="panel-scroll">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18,
            background: 'rgba(168,85,247,0.07)', border: '1px solid rgba(168,85,247,0.25)',
            borderRadius: 'var(--radius-sm)', padding: '12px 16px',
            fontSize: 'var(--text-sm)', color: 'var(--accent)',
          }}>
            <span>ℹ️</span>
            <span>USB driver downloads are only shown on Windows builds. On macOS and Linux, use the regular ADB and USB setup guides instead.</span>
          </div>
        </div>
      </div>
    )
  }

  const mono = "'JetBrains Mono','Courier New',monospace"

  return (
    <div className="panel-content">
      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Drivers</h1>
        </div>
      </div>

      <div className="panel-scroll">

        {/* ── Windows notice ── */}
        {isWindows && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20,
            background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)',
            borderRadius: 'var(--radius-lg)', padding: '18px 20px',
          }}>
            <span style={{ fontSize: 32, flexShrink: 0, lineHeight: 1 }}>🪟</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-base)', color: 'var(--accent-yellow)', marginBottom: 6 }}>
                You're on Windows — install the correct USB driver below
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }}>
                Windows requires a USB driver for ADB to recognise your device. Not sure which? Start with Universal ADB Drivers.
                You also need the <strong style={{ color: 'var(--text-primary)' }}>ADB tool itself</strong>, installable via winget:
              </div>
              <div style={{
                background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)',
                borderRadius: 'var(--radius-sm)', padding: '10px 14px',
                fontFamily: mono, fontSize: 12, color: 'var(--accent-yellow)',
              }}>
                winget install --id Google.PlatformTools
              </div>
            </div>
          </div>
        )}

        {/* ── Driver grid header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18,
          background: 'linear-gradient(135deg, rgba(245,158,11,0.07), rgba(6,182,212,0.07))',
          border: '1px solid rgba(245,158,11,0.2)',
          borderRadius: 'var(--radius-lg)', padding: '16px 20px',
        }}>
          <span style={{ fontSize: 36, lineHeight: 1 }}>🔌</span>
          <div>
            <div style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-base)', marginBottom: 4 }}>ADB Device Drivers</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Install the correct driver for your Android device.
            </div>
          </div>
        </div>

        {/* ── Driver cards ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 20 }}>
          {DRIVERS.map(d => (
            <div key={d.id} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)', padding: 18,
              display: 'flex', flexDirection: 'column', gap: 12,
              position: 'relative',
              transition: 'border-color 0.15s',
            }}>
              {/* Icon + title */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  background: `linear-gradient(135deg, ${d.color[0]}, ${d.color[1]})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                }}>
                  {d.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', marginBottom: 2 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.version} · {d.size} · {d.author}</div>
                </div>
              </div>

              {/* Description */}
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{d.desc}</div>

              {/* Tags */}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {d.tags.map(t => (
                  <span key={t} style={{
                    fontSize: 10, fontWeight: 'var(--font-semibold)', padding: '2px 7px',
                    borderRadius: 5, background: 'rgba(6,182,212,0.1)', color: 'var(--accent-teal)',
                  }}>{t}</span>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                <button className="btn-primary" style={{ flex: 1, fontSize: 'var(--text-xs)', padding: '5px 10px' }}
                  onClick={() => openUrl(d.installUrl)}>
                  ⬇ Download
                </button>
                <button className="btn-ghost" style={{ fontSize: 'var(--text-xs)', padding: '5px 10px' }}
                  onClick={() => openUrl(d.docsUrl)}>
                  🔗 Docs
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ── Need help? ── */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)', padding: '16px 20px',
        }}>
          <div style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', marginBottom: 10 }}>Need help?</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" style={{ fontSize: 'var(--text-xs)', padding: '5px 14px' }}
              onClick={() => openUrl('https://developer.android.com/tools/adb')}>
              📖 Setup Guide
            </button>
            <button className="btn-ghost" style={{ fontSize: 'var(--text-xs)', padding: '5px 14px' }}
              onClick={() => openUrl('https://developer.android.com/studio/run/device')}>
              🚨 Troubleshooting
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── Panel placeholder ─────────────────────────────────────────────────────────

// ── Welcome / splash screen ───────────────────────────────────────────────────

const WELCOME_FEATURES = [
  { icon: '📦', title: 'Install & Manage',  desc: 'Drag & drop APKs, manage apps, backup and restore' },
  { icon: '🔍', title: 'Search & Discover', desc: 'Search F-Droid, GitHub, Aptoide and install app stores' },
  { icon: '🛠️', title: 'Power Tools',       desc: 'ADB shell, file browser, device tools, ROM flashing' },
]

function WelcomeScreen({ onDismiss }) {
  const [fading, setFading] = useState(false)

  function dismiss() {
    setFading(true)
    setTimeout(() => {
      localStorage.setItem('nt_welcomed', '1')
      onDismiss()
    }, 360)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--bg-base)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      animation: `${fading ? 'welcome-out' : 'welcome-in'} 0.4s ease forwards`,
    }}>
      {/* Radial glow behind logo */}
      <div style={{
        position: 'absolute', top: '15%', left: '50%', transform: 'translateX(-50%)',
        width: 700, height: 320, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.08) 0%, transparent 68%)',
      }} />

      <div style={{ position: 'relative', textAlign: 'center', maxWidth: 660, padding: '0 28px', width: '100%' }}>

        {/* Logo */}
        <div style={{ fontSize: 52, marginBottom: 6, lineHeight: 1 }}>⚡</div>
        <div style={{
          fontSize: 38, fontWeight: 'var(--font-bold)', letterSpacing: '-0.02em',
          background: 'var(--gradient-accent)', WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          marginBottom: 10,
        }}>
          Android Toolkit by Team Nocturnal
        </div>
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginBottom: 36 }}>
          Android Device Manager &amp; APK Installer
        </div>

        {/* Feature cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 28 }}>
          {WELCOME_FEATURES.map(f => (
            <div key={f.title} style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: '16px 14px',
            }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>{f.icon}</div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 5 }}>{f.title}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{f.desc}</div>
            </div>
          ))}
        </div>

        {/* Platform note */}
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 28 }}>
          Works on Mac and Windows — ADB bundled, no setup required
        </div>

        {/* CTA */}
        <button
          className="btn-primary"
          style={{ padding: '11px 40px', fontSize: 'var(--text-base)', marginBottom: 18, borderRadius: 'var(--radius-lg)' }}
          onClick={dismiss}
        >
          Get Started →
        </button>

        {/* Footer credit */}
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Built by XsMagical · Team Nocturnal ·{' '}
          <span
            style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
            onClick={() => openUrl('https://team-nocturnal.com')}
          >
            team-nocturnal.com
          </span>
        </div>

      </div>
    </div>
  )
}

// ── Help & Docs panel ─────────────────────────────────────────────────────────

const HELP_LINKS = [
  { icon: '📖', label: 'ADB Documentation',             url: 'https://developer.android.com/tools/adb',             desc: 'Official Android Debug Bridge reference' },
  { icon: '🛠️', label: 'Android Developer Options',     url: 'https://developer.android.com/studio/debug/dev-options', desc: 'How to enable and use Developer Options' },
  { icon: '⚡', label: 'XDA Developers',                url: 'https://xda-developers.com',                           desc: 'Community forums, ROMs, and device-specific guides' },
  { icon: '📗', label: 'F-Droid',                       url: 'https://f-droid.org',                                  desc: 'Free and open-source Android app repository' },
  { icon: '🌙', label: 'Team Nocturnal',                url: 'https://team-nocturnal.com',                           desc: 'Home of Nocturnal Toolkit and Nocturnal ROM' },
]

const HELP_PANELS = [
  { icon: '📦', label: 'Install APK',   desc: 'Drag & drop .apk or .xapk files onto the panel, or use the browse button. Queue multiple installs and track progress per file.', url: 'https://developer.android.com/tools/adb#install' },
  { icon: '🔍', label: 'Search APKs',   desc: 'Search F-Droid, GitHub Releases, and Aptoide simultaneously. Filter by source and install directly to your connected device.' },
  { icon: '🏪', label: 'App Stores',    desc: 'One-click sideload for major alternative app stores: Aurora Store, F-Droid, Obtainium, and more.' },
  { icon: '🗂️', label: 'Manage Apps',   desc: 'List installed packages, launch or clear apps, and create toolkit-managed backups with APK splits, OBB, and shared app folders.' },
  { icon: '💾', label: 'Backup & Restore', desc: 'Create or restore toolkit backups, including APK splits, OBB files, shared app folders, and no-root device exports.' },
  { icon: '📱', label: 'Devices',       desc: 'View real-time hardware info: model, Android version, battery, storage, resolution. Reboot to recovery, bootloader, or system.' },
  { icon: '🖥️', label: 'ADB & Shell',   desc: 'Full interactive ADB shell terminal, streaming logcat viewer with level filters, and TCP/UDP port forwarding manager.', url: 'https://developer.android.com/tools/adb' },
  { icon: '📂', label: 'File Browser', desc: 'Dual-pane file manager: browse and transfer files between your computer and Android device with push/pull.', url: 'https://developer.android.com/tools/adb#copyfiles' },
  { icon: '⚡', label: 'ROM Tools',     desc: 'Pixel/ROM flashing, bootloader unlock/lock, A/B slot management, sideload via recovery, factory wipe tools.', url: 'https://source.android.com/docs/setup/build/running' },
  { icon: '📺', label: 'Kodi / TV Setup', desc: 'Install and configure Kodi on Android TV, Fire TV, or ONN devices. Add repos, sources, and streaming add-ons.', url: 'https://kodi.wiki/view/Android' },
  { icon: '🔥', label: 'Fire TV Modding', desc: 'Debloat Fire TV, install custom launchers, sideload apps, and remove Amazon ads using Downloader by AFTVnews.', url: 'https://www.aftv.news/how-to-install-downloader-on-fire-tv/' },
  { icon: '🥽', label: 'Meta Quest Sideloading', desc: 'Enable developer mode on Meta Quest, sideload APKs via ADB, and manage storage for your headset.', url: 'https://developers.meta.com/horizon/documentation/native/android/mobile-device-setup/' },
  { icon: '🔌', label: 'Drivers',       desc: 'USB driver downloads for Windows builds.' },
  { icon: '⚙️', label: 'Advanced',      desc: 'Reboot to any mode, enable wireless ADB, one-tap quick commands (device info, screen capture, network), and saved favorites.' },
]

const HELP_SETUP_STEPS = [
  { id: 'usb-debugging', priority: 10, step: '1', title: 'Enable USB Debugging', body: 'On your phone: Settings → About Phone → tap Build Number 7 times. Then open Developer Options and turn on USB Debugging.', url: 'https://developer.android.com/studio/debug/dev-options' },
  { id: 'connect-usb', priority: 20, step: '2', title: 'Connect via USB', body: 'Plug in your device and tap Allow on the phone if Android asks for USB debugging permission.', url: 'https://developer.android.com/tools/adb#Enabling' },
  { id: 'linux-usb', priority: 30, step: '3', title: 'Linux: Fix USB Access', body: 'If your phone still does not show up, open Help & Docs for the quick Linux USB fix.', actionLabel: 'Open Help & Docs', actionTarget: 'help' },
  { id: 'windows-adb', priority: 30, step: '3', title: 'Windows: Install ADB Drivers', body: 'Open the Drivers panel and install the correct USB driver for your phone, then reconnect the cable.', actionLabel: 'Open Drivers', actionTarget: 'drivers' },
  { id: 'macos-adb', priority: 30, step: '3', title: 'macOS: Install ADB', body: 'Run: brew install android-platform-tools\nThen check it with: adb version', url: 'https://developer.android.com/tools/releases/platform-tools' },
  { id: 'wireless', priority: 40, step: '4', title: 'Wireless ADB (Optional)', body: 'If USB is annoying, you can pair over Wi-Fi from the Devices screen using Wireless Debugging on Android 11+.', url: 'https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi', actionLabel: 'Open Devices', actionTarget: 'devices' },
]

const HELP_CONNECTION_CARDS = [
  {
    id: 'usb-debugging',
    title: 'Enable USB Debugging',
    body: 'On your phone, unlock Developer Options and turn on USB Debugging before connecting to Android Toolkit.',
    actionLabel: 'Read Android Guide',
    url: 'https://developer.android.com/studio/debug/dev-options',
  },
  {
    id: 'connect-usb',
    title: 'Connect over USB',
    body: 'Use a data cable, unlock the phone, and press Allow if Android asks whether to trust this computer for USB debugging.',
    actionLabel: 'USB Connection Help',
    url: 'https://developer.android.com/tools/adb#Enabling',
  },
  {
    id: 'wireless',
    title: 'Use Wireless ADB',
    body: 'If USB is still giving you trouble, pair over Wi-Fi from the Devices screen using Android 11+ Wireless Debugging.',
    actionLabel: 'Open Devices',
    actionTarget: 'devices',
    secondaryLabel: 'Read Wireless Guide',
    secondaryUrl: 'https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi',
  },
]

function PlatformSetupCard({ title, kicker, body, accent, current, steps = [], actions = [], command = '', details = '', children }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: `1px solid ${current ? accent : 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
            {kicker}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
            {title}
          </div>
        </div>
        {current && (
          <div style={{
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--border-subtle)',
            fontSize: 10,
            color: 'var(--text-muted)',
          }}>
            Current platform
          </div>
        )}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: steps.length ? 10 : 12 }}>
        {body}
      </div>
      {steps.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 10 }}>
          {steps.map((step, index) => (
            <div key={`${title}-${index}`} style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>
                {index + 1}. {step.title}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {step.body}
              </div>
            </div>
          ))}
        </div>
      )}
      {children}
      {children && (actions.length > 0 || command || details) && <div style={{ height: 10 }} />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {actions.map(action => (
          <button
            key={action.label}
            className="btn-ghost"
            style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
            onClick={() => action.action ? action.action() : openUrl(action.url)}
          >
            {action.label}
          </button>
        ))}
        {(command || details) && (
          <button
            className="btn-ghost"
            style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? 'Hide Details' : 'Show Details'}
          </button>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          {details && (
            <div style={{
              marginBottom: command ? 10 : 0,
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border-subtle)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}>
              {details}
            </div>
          )}
          {command && (
            <pre style={{
              margin: 0,
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid var(--border-subtle)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: "'JetBrains Mono','Courier New',monospace",
              fontSize: 11,
              color: 'var(--text-primary)',
              lineHeight: 1.55,
            }}>
              {command}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function HelpDocsPanel({ onShowWelcome, mode = 'help', onOpenPanel }) {
  const [platform, setPlatform] = useState(() => previewPlatformOverride() || 'desktop')
  useEffect(() => {
    const preview = previewPlatformOverride()
    if (preview) {
      setPlatform(preview)
      return
    }
    invoke('get_platform').then(p => setPlatform(p)).catch(() => setPlatform('desktop'))
  }, [])
  const isAndroid = platform === 'android'
  const visibleHelpPanels = HELP_PANELS.filter(panel => {
    if (panel.label === 'Drivers' && platform !== 'windows') return false
    if (isAndroid && ['Backup & Restore', 'File Browser', 'ROM Tools', 'Drivers'].includes(panel.label)) return false
    return true
  })
  const visibleSetupSteps = HELP_SETUP_STEPS.filter(step => {
    if (step.id === 'windows-adb' && platform !== 'windows') return false
    if (step.id === 'macos-adb' && platform !== 'macos') return false
    if (step.id === 'linux-usb' && platform !== 'linux') return false
    return true
  }).sort((a, b) => a.priority - b.priority)
  const androidHelpCards = [
    { title: 'This phone first', body: 'The Android app is centered on the device it is installed on. Remote-device ADB control is still a future feature.' },
    { title: 'Tweaks permissions', body: 'Some tweaks work right away, while others need WRITE_SETTINGS, a one-time ADB grant, or root depending on the setting.' },
    { title: 'Desktop companion', body: 'Use the desktop build when you need flashing tools, file transfer workflows, or external-device pairing.' },
  ]
  const helpPanelTargets = {
    'Install APK': 'install',
    'Search APKs': 'search',
    'App Stores': 'stores',
    'Manage Apps': 'manage',
    'Backup & Restore': 'backups',
    'Devices': 'devices',
    'ADB & Shell': 'adb',
    'File Browser': 'files',
    'ROM Tools': 'rom',
    'Kodi / TV Setup': 'tv',
    'Fire TV Modding': 'tv',
    'Meta Quest Sideloading': 'quest',
    'Drivers': 'drivers',
    'Advanced': 'advanced',
  }
  const showHero = mode === 'getting-started'
  const showSetup = mode === 'getting-started'
  const showPanels = mode === 'getting-started'
  const showLinks = mode === 'help'
  const showAbout = mode === 'about'
  const panelTitle = mode === 'getting-started' ? 'Getting Started' : mode === 'about' ? 'About' : 'Help & Docs'
  const showConnectionHelp = mode === 'help' && !isAndroid
  const showPlatformSetup = mode === 'help' && !isAndroid
  const platformSetupCards = [
    {
      id: 'linux',
      title: 'Linux',
      kicker: 'USB not detected?',
      body: 'Linux builds already bundle adb and fastboot. If your device does not appear, it usually just needs USB permissions rules.',
      accent: 'rgba(245,158,11,0.22)',
      current: platform === 'linux',
      render: (
        <LinuxUsbHelperCard devices={[]} ready={true} onOpenWireless={() => onOpenPanel?.('devices')} embedded compact />
      ),
    },
    {
      id: 'windows',
      title: 'Windows',
      kicker: 'Driver setup',
      body: 'Windows usually needs the right USB driver before adb or fastboot can see the phone. Install the driver, reconnect, then return to Devices.',
      accent: 'rgba(59,130,246,0.22)',
      current: platform === 'windows',
      steps: [
        { title: 'Open Drivers', body: 'Use the built-in Drivers panel to find the right USB driver for your phone or headset.' },
        { title: 'Install and reconnect', body: 'Finish the driver install, then unplug and reconnect the USB cable.' },
        { title: 'Approve debugging', body: 'Unlock the device and tap Allow if Android shows the USB debugging prompt.' },
      ],
      details: 'If adb or fastboot still cannot see the device after the driver install, try a different USB port or data cable, then re-open the Devices screen and scan again.',
      actions: [
        { label: 'Open Drivers', action: () => onOpenPanel?.('drivers') },
        { label: 'Open Getting Started', action: () => onOpenPanel?.('getting-started') },
      ],
    },
    {
      id: 'macos',
      title: 'macOS',
      kicker: 'Platform tools',
      body: 'macOS normally just needs Android platform-tools installed once. After that, reconnect the cable and approve USB debugging on the device.',
      accent: 'rgba(168,85,247,0.22)',
      current: platform === 'macos',
      steps: [
        { title: 'Install platform-tools', body: 'Run the Homebrew command once to install adb and fastboot on your Mac.' },
        { title: 'Reconnect the cable', body: 'Plug the phone back in after install so Android refreshes the USB connection.' },
        { title: 'Approve debugging', body: 'Unlock the phone and tap Allow when the USB debugging prompt appears.' },
      ],
      command: 'brew install android-platform-tools\nadb version',
      details: 'If the phone still does not appear, try a different cable, confirm Homebrew is installed, and check that USB Debugging is still enabled under Developer Options.',
      actions: [
        { label: 'Platform-Tools Guide', url: 'https://developer.android.com/tools/releases/platform-tools' },
        { label: 'Open Getting Started', action: () => onOpenPanel?.('getting-started') },
      ],
    },
  ]

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">{panelTitle}</h1>
        </div>
      </div>

      <div className="panel-scroll">

        {/* Hero */}
        {showHero && <div style={{
          background: 'linear-gradient(135deg, rgba(168,85,247,0.08), rgba(20,184,166,0.06))',
          border: '1px solid rgba(168,85,247,0.2)',
          borderRadius: 'var(--radius-md)', padding: '18px 20px', marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{ fontSize: 36, flexShrink: 0 }}>🌙</span>
          <div>
            <div style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-lg)', color: 'var(--text-primary)', marginBottom: 4 }}>
              Android Toolkit by Team Nocturnal
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              {isAndroid
                ? 'A phone-first Android toolkit built by Team Nocturnal. Use it for local device tools, app management, shell access, logs, and guided setup.'
                : 'A power-user Android management app built by Team Nocturnal. Everything you need to manage, sideload, flash, and debug Android devices from your desktop.'}
            </div>
          </div>
        </div>}

        {isAndroid && showHero && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 20 }}>
            {androidHelpCards.map(card => (
              <div key={card.title} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
                <div style={{ fontSize: 14, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>
                  {card.title}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {card.body}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Getting Started */}
        {showSetup && (
        <div style={{ marginBottom: 24 }}>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>Getting Started</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {visibleSetupSteps.map(s => (
              <div key={s.id} style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent)',
                  }}>
                    {s.step}
                  </div>
                  <div style={{ fontSize: isAndroid ? 14 : 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{s.title}</div>
                </div>
                <div style={{ fontSize: isAndroid ? 13 : 'var(--text-xs)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {s.body}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {s.actionTarget && (
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
                      onClick={() => onOpenPanel?.(s.actionTarget)}
                    >
                      {s.actionLabel || 'Open'}
                    </button>
                  )}
                  {s.url && (
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
                      onClick={() => openUrl(s.url)}
                    >
                      Read More
                    </button>
                  )}
                </div>
              </div>
            ))}
            {isAndroid && (
              <div style={{ marginTop: 4, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.18)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Remote pairing to other devices is not available inside the Android APK yet. Use the desktop build if you need to pair or connect to another phone, TV, or headset.
              </div>
            )}
          </div>
        </div>
        )}

        {/* Panel Guides */}
        {showPanels && (
        <div style={{ marginBottom: 24 }}>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>Panel Guides</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {visibleHelpPanels.map(p => (
              <div key={p.label} style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', padding: '12px 14px',
                display: 'flex', gap: 12, alignItems: 'flex-start',
                cursor: helpPanelTargets[p.label] ? 'pointer' : 'default',
              }}>
                <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>{p.icon}</span>
                <div style={{ flex: 1 }} onClick={() => helpPanelTargets[p.label] && onOpenPanel?.(helpPanelTargets[p.label])}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ fontSize: isAndroid ? 14 : 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{p.label}</div>
                    {p.url && (
                      <span
                        onClick={e => { e.stopPropagation(); openUrl(p.url) }}
                        style={{ fontSize: 10, color: 'var(--accent-teal)', cursor: 'pointer', marginLeft: 8 }}
                      >
                        Read More →
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: isAndroid ? 13 : 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{p.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

        {showConnectionHelp && (
        <div style={{ marginBottom: 24 }}>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>Connection Help</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {HELP_CONNECTION_CARDS.map(card => (
              <div key={card.id} style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '14px 16px',
              }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 6 }}>
                  {card.title}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                  {card.body}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {card.actionTarget && (
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
                      onClick={() => onOpenPanel?.(card.actionTarget)}
                    >
                      {card.actionLabel}
                    </button>
                  )}
                  {card.url && (
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
                      onClick={() => openUrl(card.url)}
                    >
                      {card.actionLabel}
                    </button>
                  )}
                  {card.secondaryUrl && (
                    <button
                      className="btn-ghost"
                      style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
                      onClick={() => openUrl(card.secondaryUrl)}
                    >
                      {card.secondaryLabel}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

        {showPlatformSetup && (
          <div style={{ marginBottom: 24 }}>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>Platform Setup</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
            {platformSetupCards.map(card => (
              <PlatformSetupCard
                key={card.id}
                title={card.title}
                kicker={card.kicker}
                body={card.body}
                accent={card.accent}
                current={card.current}
                steps={card.steps}
                actions={card.actions}
                command={card.command}
                details={card.details}
              >{card.render}</PlatformSetupCard>
            ))}
          </div>
        </div>
        )}

        {/* Useful Links */}
        {showLinks && (
        <div style={{ marginBottom: 24 }}>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>Useful Links</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {HELP_LINKS.map(lk => (
              <div key={lk.label} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', padding: '10px 14px',
              }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{lk.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{lk.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{lk.desc}</div>
                </div>
                <button
                  className="btn-ghost"
                  style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }}
                  onClick={() => openUrl(lk.url)}
                >
                  Open ↗
                </button>
              </div>
            ))}
          </div>
        </div>
        )}

        {/* About */}
        {showAbout && (
        <div>
          <div className="sidebar-section-label" style={{ marginBottom: 12 }}>About</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            {[
              ['App',      'Android Toolkit by Team Nocturnal'],
              ['Version',  `v${DISPLAY_VERSION}`],
              ['Built by', 'XsMagical — Team Nocturnal'],
              ['Stack',    'Tauri 2 + React + Vite + Rust'],
            ].map(([k, v]) => (
              <div key={k} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{k}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 'var(--font-medium)' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{
            background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.18)',
            borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 12,
            fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.65,
          }}>
            <span style={{ fontWeight: 'var(--font-semibold)', color: 'var(--accent)' }}>XDA History:</span>{' '}
            XsMagical started developing Xplod ROM and Nocturnal ROM for Android devices on XDA Developers from 2011–2014. Android Toolkit by Team Nocturnal carries that legacy forward as a modern desktop companion app.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" style={{ padding: '5px 14px', fontSize: 'var(--text-xs)' }} onClick={() => openUrl('https://team-nocturnal.com')}>
              team-nocturnal.com ↗
            </button>
            <button className="btn-ghost" style={{ padding: '5px 14px', fontSize: 'var(--text-xs)' }} onClick={onShowWelcome}>
              Show Welcome Screen
            </button>
          </div>
        </div>
        )}

      </div>
    </div>
  )
}

function DesktopInlineSection({ title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.025)', userSelect: 'none' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-teal)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>{title}</span>
        {subtitle && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— {subtitle}</span>}
      </div>
      <div style={{ padding: '10px 12px' }}>{children}</div>
    </div>
  )
}

function PanelPlaceholder({ label }) {
  return (
    <div className="panel-placeholder">
      <span>{label}</span>
    </div>
  )
}

// ── Device detail (right side of Devices panel) ───────────────────────────────

const REBOOT_MODES = [
  { label: 'Normal',     args: s => ['-s', s, 'reboot'],               color: '#3b82f6' },
  { label: 'Recovery',   args: s => ['-s', s, 'reboot', 'recovery'],   color: 'var(--accent-yellow)' },
  { label: 'Bootloader', args: s => ['-s', s, 'reboot', 'bootloader'], color: 'var(--accent)' },
]

const inputStyle = {
  flex: 1,
  minWidth: 0,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  padding: '6px 10px',
  outline: 'none',
  fontFamily: 'inherit',
}

function DeviceDetail({ device, props, loading, onReboot, savedDevices = [], onSaveDevice }) {
  const [phonesAdbOpen, setPhonesAdbOpen] = useState(true)
  const [savePromptIp, setSavePromptIp] = useState(null)
  const [saveDeviceName, setSaveDeviceName] = useState('')
  const [wifiStatus, setWifiStatus] = useState(null)

  if (!device) {
    return (
      <div className="detail-area-empty" style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
        Select a device
      </div>
    )
  }

  const {
    android, battery, storage,
    chipset, ram, resolution, build, secPatch, kernel,
    manufacturer, hwModel, bootloader, baseband,
  } = props ?? {}

  const batteryColor = battery <= 15 ? 'var(--accent-red)' : battery <= 30 ? 'var(--accent-yellow)' : 'var(--accent-green)'
  const storageColor = storage?.used_pct > 90 ? 'var(--accent-red)' : storage?.used_pct > 75 ? 'var(--accent-yellow)' : 'var(--accent-green)'

  return (
    <div className="detail-area" style={{ padding: 'var(--panel-padding)' }}>

      {/* ADB Setup Card */}
      <div style={{ marginBottom: 20, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        <div onClick={() => setPhonesAdbOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.025)', cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: phonesAdbOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
          <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>ADB SETUP — Phones &amp; Tablets</span>
        </div>
        {phonesAdbOpen && (
          <div style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 8 }}>ENABLE DEVELOPER OPTIONS</div>
            <ol style={{ margin: 0, paddingLeft: 18, listStyle: 'none' }}>
              {[
                'Open Settings → About Phone (or About Device)',
                'Find Build Number — tap it 7 times rapidly',
                'Enter your PIN if prompted',
                'You will see "You are now a developer!"',
                'Go back to Settings → System → Developer Options',
                'Enable USB Debugging',
                'Connect USB cable → tap Allow on the prompt that appears on your phone',
                'Check "Always allow from this computer" for future connections',
              ].map((step, i) => (
                <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div style={{ marginTop: 12, fontSize: 11, fontWeight: 'var(--font-bold)', color: 'var(--accent-teal)', letterSpacing: '0.06em', marginBottom: 8 }}>WIRELESS ADB (Android 11+)</div>
            <ol style={{ margin: 0, paddingLeft: 18, listStyle: 'none' }}>
              {[
                'In Developer Options → enable Wireless Debugging',
                'Tap Wireless Debugging → Pair device with pairing code',
                'Enter the IP, port and pairing code shown on your device into the fields below',
              ].map((step, i) => (
                <li key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-bold)', flexShrink: 0, minWidth: 16 }}>{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: 11, color: 'var(--accent-amber)', lineHeight: 1.6 }}>
              ⚠ Samsung: Settings → About Phone → Software Information → Build Number. Path varies slightly by manufacturer.
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={async () => { const r = await invoke('run_adb', { args: ['devices'] }); setWifiStatus((r.stdout || r.stderr || '').trim()) }}>
                Check Connection
              </button>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={async () => { if (!device?.serial) { setWifiStatus('No device connected'); return } const r = await invoke('run_adb', { args: ['-s', device.serial, 'shell', 'getprop', 'ro.build.version.release'] }); setWifiStatus(`Android ${(r.stdout || '').trim()}`) }}>
                Check Android Version
              </button>
            </div>
            {wifiStatus && (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {wifiStatus}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div className="panel-header-accent" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <h2 className="panel-header">{device.model}</h2>
          <StatusBadge status={device.status} />
          {device.status === 'device' && device.transport === 'Wi-Fi' && !savedDevices.some(d => d.ip === device.serial.split(':')[0]) && (
            <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 7px', marginLeft: 'auto' }}
              onClick={() => { setSavePromptIp({ ip: device.serial.split(':')[0], port: device.serial.split(':')[1] || '5555' }); setSaveDeviceName(device.model) }}>
              ☆ Save
            </button>
          )}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', fontFamily: 'monospace' }}>{device.serial}</div>
      </div>

      {/* Device info */}
      <div style={{ marginBottom: 32 }}>
        <SectionLabel>Device Info</SectionLabel>
        <StatRow label="Android"      value={loading ? '…' : android ? `Android ${android}` : null} />
        <StatRow label="Serial"       value={device.serial} />
        <StatRow label="Product"      value={device.product || null} />
        <StatRow label="Transport"    value={device.transport} />
        <StatRow label="Transport ID" value={device.transport_id} />
      </div>

      {/* Hardware */}
      <div style={{ marginBottom: 32 }}>
        <SectionLabel>Hardware</SectionLabel>
        {loading
          ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>…</div>
          : (
            <>
              <StatRow label="Manufacturer" value={manufacturer} />
              <StatRow label="Model"        value={hwModel} />
              <StatRow label="Chipset"      value={chipset} />
              <StatRow label="RAM"          value={ram} />
              <StatRow label="Resolution"   value={resolution} />
              <StatRow label="Build"        value={build} />
              <StatRow label="Security Patch" value={secPatch} />
              <StatRow label="Kernel"       value={kernel} />
              <StatRow label="Bootloader"   value={bootloader} />
              <StatRow label="Baseband"     value={baseband} />
            </>
          )
        }
      </div>

      {/* Battery */}
      {(loading || battery != null) && (
        <div style={{ marginBottom: 32 }}>
          <SectionLabel>Battery</SectionLabel>
          {loading
            ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>…</div>
            : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Level</span>
                  <span style={{ fontWeight: 'var(--font-semibold)', color: batteryColor }}>{battery}%</span>
                </div>
                <Bar pct={battery} color={batteryColor} />
              </div>
            )
          }
        </div>
      )}

      {/* Storage */}
      {(loading || storage != null) && (
        <div style={{ marginBottom: 32 }}>
          <SectionLabel>Storage (/data)</SectionLabel>
          {loading
            ? <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>…</div>
            : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{storage.used_gb} GB used of {storage.total_gb} GB</span>
                  <span style={{ fontWeight: 'var(--font-semibold)', color: storageColor }}>{storage.used_pct}%</span>
                </div>
                <Bar pct={storage.used_pct} color={storageColor} />
              </div>
            )
          }
        </div>
      )}

      {/* Reboot */}
      {device.status === 'device' && (
        <div style={{ marginBottom: 32 }}>
          <SectionLabel>Reboot</SectionLabel>
          <div style={{ display: 'flex', gap: 8 }}>
            {REBOOT_MODES.map(({ label, args, color }) => (
              <button
                key={label}
                onClick={() => onReboot(args(device.serial))}
                style={{
                  background: 'transparent',
                  border: `1px solid ${color}`,
                  color,
                  borderRadius: 'var(--radius-sm)',
                  padding: '7px 18px',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--font-medium)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Save Device prompt — shown when ☆ Save button in header is clicked */}
      {savePromptIp && (
        <div style={{ marginBottom: 32 }}>
          <SectionLabel>Save Device</SectionLabel>
          <div style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={saveDeviceName} onChange={e => setSaveDeviceName(e.target.value)} placeholder="Device name" style={{ ...inputStyle, fontSize: 11 }} />
              <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                onClick={() => { onSaveDevice?.({ id: Date.now().toString(), name: saveDeviceName || savePromptIp.ip, ip: savePromptIp.ip, port: savePromptIp.port, addedAt: new Date().toISOString() }); setSavePromptIp(null) }}>
                Save
              </button>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0, color: 'var(--text-muted)' }}
                onClick={() => setSavePromptIp(null)}>✕</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── Devices panel ─────────────────────────────────────────────────────────────

function AndroidDeviceHome({ device, props, loading, onOpenPanel }) {
  if (!device) {
    return (
      <div className="panel-content">
        <div className="panel-header-row">
          <div>
            <div className="panel-header-accent" />
            <h1 className="panel-header">This Device</h1>
          </div>
        </div>
        <div className="panel-scroll">
          <div style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '18px 16px',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 18, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 6 }}>
              No device detected
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Android Toolkit on Android is designed to work with the device it is running on.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const quickActions = [
    { id: 'install', icon: '📦', label: 'Install APK', desc: 'Install APK and XAPK files' },
    { id: 'manage', icon: '🗂️', label: 'Manage Apps', desc: 'Launch, clear, and uninstall apps' },
    { id: 'phone', icon: '📱', label: 'Phone Tools', desc: 'Tabs for tools, tweaks, and maintenance' },
    { id: 'adb', icon: '🖥️', label: 'ADB & Shell', desc: 'Shell commands and live log output' },
    { id: 'advanced', icon: '⚙️', label: 'Device Tools', desc: 'Advanced device actions and permission controls' },
    { id: 'help', icon: '❓', label: 'Help', desc: 'Guides and setup information' },
  ]

  const { android, battery, storage, manufacturer, hwModel, build, secPatch, kernel, ram } = props ?? {}
  const batteryColor = battery == null
    ? 'var(--text-muted)'
    : battery <= 15 ? 'var(--accent-red)'
    : battery <= 30 ? 'var(--accent-yellow)'
    : 'var(--accent-green)'
  const storageColor = storage?.used_pct > 90 ? 'var(--accent-red)'
    : storage?.used_pct > 75 ? 'var(--accent-yellow)'
    : 'var(--accent-green)'

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div>
          <div className="panel-header-accent" />
          <h1 className="panel-header">This Device</h1>
        </div>
      </div>
      <div className="panel-scroll">
        <div style={{
          background: 'linear-gradient(135deg, rgba(168,85,247,0.09), rgba(20,184,166,0.05))',
          border: '1px solid rgba(168,85,247,0.2)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 16px',
          marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 4 }}>
                {device.model}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                Android {android || 'Unknown'} • Local device
              </div>
            </div>
            <StatusBadge status={device.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {device.serial}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Battery
            </div>
            <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: batteryColor, marginBottom: 8 }}>
              {battery != null ? `${battery}%` : 'N/A'}
            </div>
            {battery != null && <Bar pct={battery} color={batteryColor} />}
          </div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Storage
            </div>
            <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: storageColor, marginBottom: 4 }}>
              {storage?.used_pct != null ? `${storage.used_pct}%` : 'N/A'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {storage ? `${storage.used_gb} / ${storage.total_gb} GB` : 'Unavailable'}
            </div>
            {storage != null && <Bar pct={storage.used_pct} color={storageColor} />}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
            Quick Actions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {quickActions.map(action => (
              <button
                key={action.id}
                onClick={() => onOpenPanel(action.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '16px 16px',
                  minHeight: 78,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              >
                <div style={{
                  width: 42, height: 42, borderRadius: 12,
                  background: 'var(--bg-elevated)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, flexShrink: 0,
                }}>
                  {action.icon}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 17, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>
                    {action.label}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    {action.desc}
                  </div>
                </div>
                <span style={{ fontSize: 20, color: 'var(--text-muted)' }}>›</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Overview
            </div>
            <StatRow label="Manufacturer" value={loading ? '…' : manufacturer} />
            <StatRow label="Model" value={loading ? '…' : hwModel} />
            <StatRow label="RAM" value={loading ? '…' : ram} />
          </div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Build Info
            </div>
            <StatRow label="Build" value={loading ? '…' : build} />
            <StatRow label="Security Patch" value={loading ? '…' : secPatch} />
            <StatRow label="Kernel" value={loading ? '…' : kernel} />
          </div>
          <div style={{
            background: 'rgba(20,184,166,0.06)',
            border: '1px solid rgba(20,184,166,0.18)',
            borderRadius: 'var(--radius-lg)',
            padding: '14px 16px',
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
          }}>
            Android Toolkit on Android is local-device first. Remote ADB pairing and connect are available when you need them, while desktop-only flashing workflows stay out of the mobile experience.
          </div>
          <div style={{
            background: 'rgba(168,85,247,0.07)',
            border: '1px solid rgba(168,85,247,0.18)',
            borderRadius: 'var(--radius-lg)',
            padding: '14px 16px',
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
          }}>
            The new Maintenance section focuses on safe cleanup and storage analysis. Android already handles RAM and battery management well on its own, so this app avoids background “booster” tasks that usually hurt more than they help.
          </div>
        </div>
      </div>
    </div>
  )
}

function AndroidMaintenancePanel({ device, props, onNavigateToDevices: _onNavigateToDevices, onOpenPanel, embedded = false }) {
  const serial = device?.serial
  const noDevice = !device || device.status !== 'device'
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState('')
  const storage = props?.storage
  const storageColor = storage?.used_pct > 90 ? 'var(--accent-red)'
    : storage?.used_pct > 75 ? 'var(--accent-yellow)'
    : 'var(--accent-green)'

  const CLEANUP_SCAN_ROOTS = ['/sdcard/Download', '/sdcard/Documents', '/sdcard/DCIM', '/sdcard/Movies', '/sdcard/Pictures']
  const TEMP_SCAN_ROOTS = ['/sdcard/Download', '/sdcard/Documents']
  const THUMBNAIL_DIRS = ['/sdcard/DCIM/.thumbnails', '/sdcard/Pictures/.thumbnails']
  const EXTERNAL_CACHE_ROOTS = ['/sdcard/Android/data', '/sdcard/Android/media']
  const INSTALLER_RE = /\.(apk|apks|apkm|xapk)$/i
  const TEMP_RE = /\.(tmp|temp|log|old|bak)$/i

  function fmtBytes(bytes) {
    if (!bytes) return '0 B'
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes} B`
  }

  async function safeReadDir(dir) {
    try { return await readDir(dir) } catch { return [] }
  }

  async function safeExists(path) {
    try { return await exists(path) } catch { return false }
  }

  async function safeStat(path) {
    try { return await fsStat(path) } catch { return null }
  }

  async function walkDir(root, visitor, depth = 0, maxDepth = 5) {
    const entries = await safeReadDir(root)
    for (const entry of entries) {
      if (!entry.name) continue
      const fullPath = entry.path || await pathJoin(root, entry.name)
      await visitor({ ...entry, path: fullPath, depth })
      if (entry.isDirectory && depth < maxDepth) {
        await walkDir(fullPath, visitor, depth + 1, maxDepth)
      }
    }
  }

  async function summarizeCleanupCandidates() {
    const summary = {
      installers: { count: 0, bytes: 0 },
      temp: { count: 0, bytes: 0 },
      thumbnails: { count: 0, bytes: 0 },
      externalCacheDirs: 0,
      externalCacheBytes: 0,
      emptyFolders: 0,
    }

    for (const root of CLEANUP_SCAN_ROOTS) {
      await walkDir(root, async entry => {
        if (entry.isDirectory) {
          const children = await safeReadDir(entry.path)
          if (children.length === 0) summary.emptyFolders += 1
          return
        }
        const st = await safeStat(entry.path)
        const size = st?.size || 0
        if (INSTALLER_RE.test(entry.name)) {
          summary.installers.count += 1
          summary.installers.bytes += size
        }
        if (TEMP_RE.test(entry.name)) {
          summary.temp.count += 1
          summary.temp.bytes += size
        }
        if (entry.path.includes('/.thumbnails/')) {
          summary.thumbnails.count += 1
          summary.thumbnails.bytes += size
        }
      }, 0, 5)
    }

    for (const root of EXTERNAL_CACHE_ROOTS) {
      await walkDir(root, async entry => {
        if (!entry.isDirectory || entry.name !== 'cache') return
        summary.externalCacheDirs += 1
        await walkDir(entry.path, async fileEntry => {
          if (fileEntry.isDirectory) return
          const st = await safeStat(fileEntry.path)
          summary.externalCacheBytes += st?.size || 0
        }, 0, 6)
      }, 0, 4)
    }

    return [
      'Cleanup Scan Summary',
      `- Installers: ${summary.installers.count} file(s), ${fmtBytes(summary.installers.bytes)}`,
      `- Temp / log leftovers: ${summary.temp.count} file(s), ${fmtBytes(summary.temp.bytes)}`,
      `- Thumbnail cache: ${summary.thumbnails.count} file(s), ${fmtBytes(summary.thumbnails.bytes)}`,
      `- External app cache dirs: ${summary.externalCacheDirs}, ${fmtBytes(summary.externalCacheBytes)}`,
      `- Empty folders: ${summary.emptyFolders}`,
    ].join('\n')
  }

  async function deleteMatchingFiles(roots, matcher) {
    let count = 0
    let bytes = 0
    for (const root of roots) {
      await walkDir(root, async entry => {
        if (entry.isDirectory || !matcher(entry)) return
        const st = await safeStat(entry.path)
        const size = st?.size || 0
        await remove(entry.path)
        count += 1
        bytes += size
      }, 0, 5)
    }
    return { count, bytes }
  }

  async function clearThumbnailCaches() {
    let count = 0
    let bytes = 0
    for (const dir of THUMBNAIL_DIRS) {
      if (!await safeExists(dir)) continue
      await walkDir(dir, async entry => {
        if (entry.isDirectory) return
        const st = await safeStat(entry.path)
        const size = st?.size || 0
        await remove(entry.path)
        count += 1
        bytes += size
      }, 0, 2)
    }
    return { count, bytes }
  }

  async function clearExternalCaches() {
    let count = 0
    let bytes = 0
    for (const root of EXTERNAL_CACHE_ROOTS) {
      await walkDir(root, async entry => {
        if (!entry.isDirectory || entry.name !== 'cache') return
        await walkDir(entry.path, async fileEntry => {
          if (fileEntry.isDirectory) return
          const st = await safeStat(fileEntry.path)
          const size = st?.size || 0
          await remove(fileEntry.path)
          count += 1
          bytes += size
        }, 0, 6)
      }, 0, 4)
    }
    return { count, bytes }
  }

  async function removeEmptyFolders() {
    let count = 0
    async function clean(dir, depth = 0) {
      const entries = await safeReadDir(dir)
      for (const entry of entries) {
        if (!entry.isDirectory || !entry.name) continue
        const fullPath = entry.path || await pathJoin(dir, entry.name)
        await clean(fullPath, depth + 1)
      }
      if (depth === 0) return
      const remaining = await safeReadDir(dir)
      if (remaining.length === 0) {
        await remove(dir, { recursive: true })
        count += 1
      }
    }
    for (const root of ['/sdcard/Download', '/sdcard/Documents', '/sdcard/Movies', '/sdcard/Pictures']) {
      if (await safeExists(root)) await clean(root)
    }
    return count
  }

  async function runMaint(label, task, { destructive = false, confirmText = '' } = {}) {
    if (!serial || running) return
    if (destructive) {
      const ok = await safeConfirmDialog(confirmText || `Run "${label}"?`)
      if (!ok) return
    }
    setRunning(true)
    setReport(prev => `${prev ? `${prev}\n\n` : ''}$ ${label}\nRunning…`)
    try {
      let text = ''
      if (typeof task === 'function') {
        text = (await task()) || 'Done.'
      } else {
        const res = await invoke('run_adb', { args: ['-s', serial, ...task] })
        text = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'Done.'
      }
      setReport(prev => prev.replace(/Running…$/, text))
    } catch (error) {
      setReport(prev => prev.replace(/Running…$/, String(error)))
    } finally {
      setRunning(false)
    }
  }

  const actionCards = [
    {
      title: 'Grant Storage Access',
      desc: 'Opens Android settings so Android Toolkit can read shared storage. This is needed before cleanup tools can scan Downloads, Pictures, and other common folders.',
      onClick: () => runMaint('Open all-files access settings', ['shell', 'am', 'start', '-a', 'android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', '-d', `package:${ANDROID_APP_ID}`]),
      button: 'Open Permission',
    },
    {
      title: 'Analyze Cleanup Candidates',
      desc: 'Scans installers, temp files, thumbnail caches, external app caches, and empty folders so you can see how much junk can be cleaned up first.',
      onClick: () => runMaint('Analyze Cleanup Candidates', async () => summarizeCleanupCandidates()),
      button: 'Run Cleanup Scan',
    },
    {
      title: 'Delete Downloaded Installers',
      desc: 'Removes leftover APK, APKS, APKM, and XAPK files from Downloads after you no longer need them.',
      onClick: () => runMaint('Delete Downloaded Installers', async () => {
        const { count, bytes } = await deleteMatchingFiles(['/sdcard/Download'], entry => INSTALLER_RE.test(entry.name || ''))
        return `Deleted ${count} installer file(s) and freed ${fmtBytes(bytes)}.`
      }, {
        destructive: true,
        confirmText: 'Delete downloaded APK/APKS/APKM/XAPK installers from Downloads?',
      }),
      button: 'Clean Installers',
    },
    {
      title: 'Clean Temp & Log Files',
      desc: 'Deletes leftover temp, log, old, and backup files that frequently accumulate in Downloads and Documents.',
      onClick: () => runMaint('Clean Temp & Log Files', async () => {
        const { count, bytes } = await deleteMatchingFiles(TEMP_SCAN_ROOTS, entry => TEMP_RE.test(entry.name || ''))
        return `Deleted ${count} temp/log file(s) and freed ${fmtBytes(bytes)}.`
      }, {
        destructive: true,
        confirmText: 'Delete temp, log, old, and backup files from Downloads and Documents?',
      }),
      button: 'Clean Temp Files',
    },
    {
      title: 'Clear Thumbnail Cache',
      desc: 'Removes thumbnail cache files that Android can regenerate later. Useful when image caches have grown too large.',
      onClick: () => runMaint('Clear Thumbnail Cache', async () => {
        const { count, bytes } = await clearThumbnailCaches()
        return `Deleted ${count} thumbnail cache file(s) and freed ${fmtBytes(bytes)}.`
      }, {
        destructive: true,
        confirmText: 'Clear thumbnail cache files from DCIM and Pictures?',
      }),
      button: 'Clear Cache',
    },
    {
      title: 'Clear External App Caches',
      desc: 'Best-effort cleanup for cache folders stored in shared storage under Android/data and Android/media, similar to what cleanup apps target when they have all-files access.',
      onClick: () => runMaint('Clear External App Caches', async () => {
        const { count, bytes } = await clearExternalCaches()
        return `Deleted ${count} external cache file(s) and freed ${fmtBytes(bytes)}.`
      }, {
        destructive: true,
        confirmText: 'Delete external app cache files from shared storage?',
      }),
      button: 'Clean App Caches',
    },
    {
      title: 'Remove Empty Folders',
      desc: 'Finds and removes empty directories left behind after app installs, backups, downloads, and manual file cleanup.',
      onClick: () => runMaint('Remove Empty Folders', async () => {
        const count = await removeEmptyFolders()
        return `Removed ${count} empty folder(s).`
      }, {
        destructive: true,
        confirmText: 'Remove empty folders from common shared-storage folders?',
      }),
      button: 'Remove Empty Folders',
    },
  ]

  const content = (
      <div className={embedded ? undefined : 'panel-scroll'}>
        <div style={{
          background: 'linear-gradient(135deg, rgba(20,184,166,0.09), rgba(59,130,246,0.05))',
          border: '1px solid rgba(20,184,166,0.18)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 16px',
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 24, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
            Device Care
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
            Safe cleanup tools for your Android device. This section focuses on storage cleanup and review-first actions instead of aggressive RAM boosters or background task killers.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                Storage Used
              </div>
              <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: storageColor }}>
                {storage?.used_pct != null ? `${storage.used_pct}%` : 'N/A'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                {storage ? `${storage.used_gb} / ${storage.total_gb} GB` : 'Unavailable'}
              </div>
            </div>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                Device
              </div>
              <div style={{ fontSize: 18, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
                {device?.model || 'Android'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                {device?.transport || 'Local device'}
              </div>
            </div>
          </div>
        </div>

        <div style={{
          background: 'rgba(250,204,21,0.08)',
          border: '1px solid rgba(250,204,21,0.22)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 16px',
          marginBottom: 18,
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
        }}>
          Modern Android already manages RAM, CPU scheduling, and battery life well on its own. This menu avoids always-on “boosters” and focuses on cleanup tasks that are safe, visible, and user-triggered.
        </div>

        <div style={{
          background: 'rgba(59,130,246,0.08)',
          border: '1px solid rgba(59,130,246,0.20)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 16px',
          marginBottom: 18,
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
        }}>
          If the cleanup tools say permission denied, tap <strong>Grant Storage Access</strong> first. Android blocks shared storage scans until the app is allowed to read those folders.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
          {actionCards.map(card => (
            <div key={card.title} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
              <div style={{ fontSize: 17, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 6 }}>
                {card.title}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
                {card.desc}
              </div>
              <button
                className="btn-ghost"
                disabled={noDevice || running}
                onClick={card.onClick}
                style={{ width: '100%', minHeight: 46, fontSize: 14 }}
              >
                {running ? 'Working…' : card.button}
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Related Tools
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button className="btn-ghost" style={{ minHeight: 46, fontSize: 14 }} onClick={() => onOpenPanel?.('manage')}>
                Open App Manager
              </button>
              <button className="btn-ghost" style={{ minHeight: 46, fontSize: 14 }} onClick={() => onOpenPanel?.('phone')}>
                Open Phone Tools
              </button>
              <button className="btn-ghost" style={{ minHeight: 46, fontSize: 14 }} onClick={() => onOpenPanel?.('advanced')}>
                Open Advanced Tools
              </button>
            </div>
          </div>

          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Not Included On Purpose
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              <div>RAM boosters and task killers are mostly redundant on modern Android and can make app relaunching slower.</div>
              <div>CPU cooler tools usually just force-stop background apps, which Android already handles when needed.</div>
              <div>System-wide cache trimming, antivirus scanning, and deep privacy wipes often need privileged access or built-in OEM services.</div>
            </div>
          </div>
        </div>

        <div style={{
          background: '#0a0a0a',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 16px',
          minHeight: 180,
        }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
            Maintenance Output
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {report || 'Run a scan or cleanup task to see results here.'}
          </pre>
        </div>
      </div>
  )

  if (embedded) return content

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Maintenance</h1>
        </div>
      </div>
      {content}
    </div>
  )
}

function DesktopMaintenancePanel({ device, deviceProps, onNavigateToDevices, onOpenPanel: _onOpenPanel, embedded = false }) {
  const serial = device?.serial
  const noDevice = !device || device.status !== 'device'
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const outputRef = useRef(null)
  const [_packageName, _setPackageName] = useState('')
  const [open, setOpen] = useState({
    cleanup: true,
    debloat: true,
    battery: true,
  })
  const [cleanupStatus, setCleanupStatus] = useState({ title: 'Idle', detail: 'Run a cleanup action to see live progress and a completion summary here.', tone: 'neutral' })
  const [cleanupHistory, setCleanupHistory] = useState([])
  const [cleanupFindings, setCleanupFindings] = useState([])
  const [cleanupInsight, setCleanupInsight] = useState('Run Analyze Junk to see what Nocturnal Toolkit thinks is worth cleaning before you delete anything.')

  function append(text) {
    setOutput(prev => `${prev}${prev ? '\n' : ''}${text}`)
    setTimeout(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
    }, 30)
  }

  function toggle(section) {
    setOpen(prev => ({ ...prev, [section]: !prev[section] }))
  }

  async function runAdb(args, label) {
    if (label) append(`$ ${label}`)
    setRunning(true)
    try {
      const res = await invoke('run_adb', { args })
      const text = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'Done.'
      append(text)
      return res
    } catch (error) {
      append(`Error: ${error}`)
      return null
    } finally {
      setRunning(false)
    }
  }

  async function _confirmRun(message, fn) {
    const ok = await safeConfirmDialog(message)
    if (!ok) return
    await fn()
  }

  async function saveBatteryStats() {
    if (!serial) return
    append('$ dumpsys batterystats (save to Downloads)')
    setRunning(true)
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'dumpsys', 'batterystats'] })
      const text = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
      const dl = await downloadDir()
      const dest = await pathJoin(dl, `batterystats_${serial.replace(/[^\w.-]+/g, '_')}_${Date.now()}.txt`)
      await writeTextFile(dest, text || 'No output')
      append(text || 'No output')
      append(`Saved to: ${dest}`)
    } catch (error) {
      append(`Error: ${error}`)
    } finally {
      setRunning(false)
    }
  }

  function summarizeCleanupResult(title, result) {
    const trimmed = String(result || '').trim()
    if (!trimmed) return `${title} finished successfully.`
    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean)
    const count = lines.filter(line => !/^(success|done|canceled\.?)$/i.test(line)).length
    if (/canceled/i.test(trimmed)) return `${title} canceled.`
    if (title === 'Analyze Junk') return count ? `Found ${count} cleanup candidate${count === 1 ? '' : 's'} in the scan.` : 'No large cleanup candidates were found.'
    if (title === 'Remove Installers') return count ? `Removed ${count} leftover installer file${count === 1 ? '' : 's'}.` : 'No leftover installer files were found.'
    if (title === 'Clear Thumbnails') return count ? `Removed ${count} thumbnail cache file${count === 1 ? '' : 's'}.` : 'No thumbnail cache files were found.'
    if (title === 'Clear Junk') return count ? `Removed ${count} junk file${count === 1 ? '' : 's'}.` : 'No temp, log, or backup leftovers were found.'
    if (title === 'Remove Empty Folders') return count ? `Removed ${count} empty folder${count === 1 ? '' : 's'}.` : 'No empty folders were found.'
    return lines[0]
  }

  function parseCleanupFindings(raw) {
    return String(raw || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(.+?)\s+(.+)$/)
        if (!match) return null
        const [, size, path] = match
        const lower = path.toLowerCase()
        let tag = 'Review'
        let desc = 'Large file or folder worth checking before cleanup.'
        if (/\.(apk|apks|apkm|xapk)$/.test(lower)) {
          tag = 'Installer'
          desc = 'Downloaded installer package. Safe to remove after the app is installed.'
        } else if (lower.includes('.thumbnails')) {
          tag = 'Thumbnail cache'
          desc = 'Regeneratable thumbnail cache.'
        } else if (/\.(tmp|temp|log|old|bak)$/.test(lower)) {
          tag = 'Junk'
          desc = 'Temporary, log, backup, or old leftover file.'
        } else if (/\/dcim|\/pictures|\/movies/.test(lower)) {
          tag = 'Media'
          desc = 'Personal media content. Review manually before deleting.'
        } else if (/\/download/.test(lower)) {
          tag = 'Downloads'
          desc = 'Downloaded file in shared storage.'
        }
        return { size, path, tag, desc }
      })
      .filter(Boolean)
  }

  async function runCleanupAction(title, detail, action) {
    setCleanupStatus({ title, detail, tone: 'working' })
    append(`$ ${title}`)
    try {
      const result = await action()
      const summary = summarizeCleanupResult(title, result)
      setCleanupStatus({ title: `${title} complete`, detail: `${summary}${result ? `\n\nRaw output:\n${result}` : ''}`, tone: 'success' })
      setCleanupHistory(prev => [{ title, summary, tone: 'success', at: new Date().toLocaleTimeString() }, ...prev].slice(0, 6))
      if (title === 'Analyze Junk') {
        const findings = parseCleanupFindings(result)
        setCleanupFindings(findings)
        setCleanupInsight(
          findings.length
            ? `Nocturnal Toolkit found ${findings.length} large cleanup candidate${findings.length === 1 ? '' : 's'}. Review the list below before you remove anything.`
            : 'Nocturnal Toolkit did not find any major cleanup candidates in the shared folders it scanned.'
        )
      }
      if (result) append(result)
    } catch (error) {
      const msg = String(error)
      setCleanupStatus({ title: `${title} failed`, detail: msg, tone: 'error' })
      setCleanupHistory(prev => [{ title, summary: msg, tone: 'error', at: new Date().toLocaleTimeString() }, ...prev].slice(0, 6))
      append(`Error: ${msg}`)
    }
  }

  const sectionStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '16px',
  }

  const actionButtonStyle = { padding: '6px 12px', fontSize: 'var(--text-xs)' }

  const content = (
      <div className={embedded ? undefined : 'panel-scroll'}>
        <div style={{
          background: 'linear-gradient(135deg, rgba(20,184,166,0.09), rgba(59,130,246,0.05))',
          border: '1px solid rgba(20,184,166,0.18)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 16px',
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
            Desktop Device Care
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            ADB-powered maintenance for connected devices: one-click cleanup, battery resets, debloat prep, capture tools, reboot actions, and diagnostics with status output after every action.
          </div>
        </div>

        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 18 }}>
            <span>No device connected — desktop maintenance actions are disabled.</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>View Devices</button>
          </div>
        )}

        <LogSection title="One-Click Cleanup" dot="var(--accent-green)" open={open.cleanup} onToggle={() => toggle('cleanup')}>
          <div style={sectionStyle}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
              Safe maintenance actions with output after every run. These are meant to feel like a device-care dashboard, not a command scratchpad.
            </div>
            <div style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: cleanupStatus.tone === 'success' ? 'rgba(34,197,94,0.08)' : cleanupStatus.tone === 'error' ? 'rgba(239,68,68,0.08)' : cleanupStatus.tone === 'working' ? 'rgba(20,184,166,0.08)' : 'rgba(107,107,120,0.08)',
              border: cleanupStatus.tone === 'success' ? '1px solid rgba(34,197,94,0.2)' : cleanupStatus.tone === 'error' ? '1px solid rgba(239,68,68,0.2)' : cleanupStatus.tone === 'working' ? '1px solid rgba(20,184,166,0.2)' : '1px solid var(--border-subtle)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>{cleanupStatus.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{cleanupStatus.detail}</div>
            </div>
            {cleanupHistory.length > 0 && (
              <div style={{ marginBottom: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
                {cleanupHistory.map((item, idx) => (
                  <div key={`${item.title}-${item.at}-${idx}`} style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: item.tone === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                    border: item.tone === 'success' ? '1px solid rgba(34,197,94,0.16)' : '1px solid rgba(239,68,68,0.16)',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{item.at}</div>
                    <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.summary}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Cleanup Review</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: cleanupFindings.length ? 10 : 0 }}>{cleanupInsight}</div>
              {cleanupFindings.length > 0 && (
                <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 8 }}>
                  {cleanupFindings.slice(0, 20).map(item => (
                    <div key={`${item.path}-${item.size}`} style={{ display: 'grid', gridTemplateColumns: '80px 86px 1fr', gap: 10, alignItems: 'start', padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)' }}>{item.size}</div>
                      <div style={{ fontSize: 10, color: 'var(--accent-teal)' }}>{item.tag}</div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-all', marginBottom: 3 }}>{item.path}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>{item.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Analyze Junk', 'Scanning Downloads, Documents, and media folders for the largest cleanup candidates…', async () => {
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'sh', '-c', "du -ak /sdcard/Download /sdcard/Documents /sdcard/DCIM 2>/dev/null | sort -rn | head -n 25"] })
                return (res.stdout || res.stderr || 'No output').trim()
              })}>Analyze Junk</button>
              <button className="btn-warning" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Remove Installers', 'Deleting leftover APK, APKS, APKM, and XAPK installers from Downloads…', async () => {
                const ok = await safeConfirmDialog('Delete leftover installer files from Downloads?')
                if (!ok) return 'Canceled.'
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'sh', '-c', "find /sdcard/Download -maxdepth 2 -type f \\( -iname '*.apk' -o -iname '*.apks' -o -iname '*.apkm' -o -iname '*.xapk' \\) -print -delete 2>/dev/null"] })
                return (res.stdout || res.stderr || 'Installer cleanup finished.').trim()
              })}>Remove Installers</button>
              <button className="btn-warning" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Clear Thumbnails', 'Removing cached thumbnail files from DCIM and Pictures…', async () => {
                const ok = await safeConfirmDialog('Clear thumbnail cache files on the device?')
                if (!ok) return 'Canceled.'
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'sh', '-c', "find /sdcard/DCIM /sdcard/Pictures -type f -path '*/.thumbnails/*' -print -delete 2>/dev/null"] })
                return (res.stdout || res.stderr || 'Thumbnail cache cleared.').trim()
              })}>Clear Thumbnails</button>
              <button className="btn-warning" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Clear Junk', 'Removing temp, old, backup, and log leftovers from shared storage…', async () => {
                const ok = await safeConfirmDialog('Delete temp, log, and old backup leftovers from shared storage?')
                if (!ok) return 'Canceled.'
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'sh', '-c', "find /sdcard/Download /sdcard/Documents -type f \\( -iname '*.tmp' -o -iname '*.temp' -o -iname '*.log' -o -iname '*.old' -o -iname '*.bak' \\) -print -delete 2>/dev/null"] })
                return (res.stdout || res.stderr || 'Junk cleanup finished.').trim()
              })}>Clear Junk</button>
              <button className="btn-warning" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Remove Empty Folders', 'Searching common shared-storage folders for empty directories to remove…', async () => {
                const ok = await safeConfirmDialog('Delete empty folders in common shared-storage locations?')
                if (!ok) return 'Canceled.'
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'sh', '-c', "find /sdcard/Download /sdcard/Documents /sdcard/Movies /sdcard/Pictures -depth -type d -empty -print -delete 2>/dev/null"] })
                return (res.stdout || res.stderr || 'Empty-folder cleanup finished.').trim()
              })}>Remove Empty Folders</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Reset Battery Stats', 'Resetting Android batterystats counters on the connected device…', async () => {
                const ok = await safeConfirmDialog('Reset Android batterystats on the connected device?')
                if (!ok) return 'Canceled.'
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'dumpsys', 'batterystats', '--reset'] })
                return (res.stdout || res.stderr || 'Battery stats reset.').trim()
              })}>Reset Battery Stats</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runCleanupAction('Optimize Packages', 'Triggering Android package optimization in the background…', async () => {
                const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'cmd', 'package', 'bg-dexopt-job'] })
                return (res.stdout || res.stderr || 'Package optimization requested.').trim()
              })}>Optimize Packages</button>
            </div>
          </div>
        </LogSection>

        <LogSection title="Interactive Debloater" dot="var(--accent-yellow)" open={open.debloat} onToggle={() => toggle('debloat')}>
          <div style={sectionStyle}>
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.18)' }}>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--accent-yellow)', marginBottom: 4 }}>Analyze, review, then act</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Run an analysis to load the device&apos;s packages, review Nocturnal Toolkit&apos;s manufacturer-aware guidance, select what you want to change, then disable, delete for user 0, or restore with batch actions.
              </div>
            </div>
            <DebloatWorkbench serial={serial} noDevice={noDevice} running={running} setRunning={setRunning} append={append} deviceProps={deviceProps} device={device} />
          </div>
        </LogSection>

        <LogSection title="Battery & Performance" dot="var(--accent-green)" open={open.battery} onToggle={() => toggle('battery')}>
          <div style={sectionStyle}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'dumpsys', 'battery'], 'dumpsys battery')}>Battery Status</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={saveBatteryStats}>Save Batterystats</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'dumpsys', 'meminfo'], 'dumpsys meminfo')}>Meminfo</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'top', '-n', '1'], 'top -n 1')}>Top Snapshot</button>
              <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'df', '-h'], 'df -h')}>Storage Usage</button>
            </div>
          </div>
        </LogSection>

        <div style={sectionStyle}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>
            Maintenance Output
          </div>
          <pre ref={outputRef} style={{ margin: 0, minHeight: 220, maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {output || 'Run a maintenance action to see output here.'}
          </pre>
        </div>
      </div>
  )

  if (embedded) return content

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Maintenance</h1>
        </div>
        {noDevice && (
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
            Connect Device
          </button>
        )}
      </div>
      {content}
    </div>
  )
}

function DesktopDeviceCompanionPanel({ device, onNavigateToDevices, onOpenPanel }) {
  const serial = device?.serial
  const noDevice = !device || device.status !== 'device'
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const outputRef = useRef(null)
  const [liveViewRunning, setLiveViewRunning] = useState(false)
  const [liveViewSrc, setLiveViewSrc] = useState('')
  const [liveViewStatus, setLiveViewStatus] = useState('Idle')
  const mirrorPopupRef = useRef(null)

  function append(text) {
    setOutput(prev => `${prev}${prev ? '\n' : ''}${text}`)
    setTimeout(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
    }, 30)
  }

  async function runAdb(args, label) {
    if (label) append(`$ ${label}`)
    setRunning(true)
    try {
      const res = await invoke('run_adb', { args })
      const text = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'Done.'
      append(text)
      return res
    } catch (error) {
      append(`Error: ${error}`)
      return null
    } finally {
      setRunning(false)
    }
  }

  async function ensureDeviceAwake() {
    if (!serial) return
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'] })
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'wm', 'dismiss-keyguard'] }).catch(() => null)
  }

  async function runDeviceShell(command, label) {
    return runAdb(['-s', serial, 'shell', 'sh', '-c', command], label)
  }

  async function captureScreenshot() {
    if (!serial || running) return
    append('$ Capture screenshot')
    setRunning(true)
    try {
      await ensureDeviceAwake()
      await invoke('run_adb', { args: ['-s', serial, 'shell', 'screencap', '/sdcard/ntk_capture.png'] })
      const dl = await downloadDir()
      const dest = await pathJoin(dl, `ntk_screenshot_${serial.replace(/[^\w.-]+/g, '_')}_${Date.now()}.png`)
      await invoke('run_adb', { args: ['-s', serial, 'pull', '/sdcard/ntk_capture.png', dest] })
      append(`Saved screenshot to: ${dest}`)
    } catch (error) {
      append(`Error: ${error}`)
    } finally {
      setRunning(false)
    }
  }

  async function recordScreen() {
    if (!serial || running) return
    append('$ Record 10 second screen capture')
    setRunning(true)
    try {
      await ensureDeviceAwake()
      await invoke('run_adb', { args: ['-s', serial, 'shell', 'screenrecord', '--time-limit', '10', '/sdcard/ntk_capture.mp4'] })
      const dl = await downloadDir()
      const dest = await pathJoin(dl, `ntk_screenrecord_${serial.replace(/[^\w.-]+/g, '_')}_${Date.now()}.mp4`)
      await invoke('run_adb', { args: ['-s', serial, 'pull', '/sdcard/ntk_capture.mp4', dest] })
      append(`Saved recording to: ${dest}`)
    } catch (error) {
      append(`Error: ${error}`)
    } finally {
      setRunning(false)
    }
  }

  function updateMirrorPopup(b64, status = null) {
    const win = mirrorPopupRef.current
    if (!win) return
    if (status) {
      win.emit('live-stream:status', { state: 'info', message: status }).catch(() => {
        mirrorPopupRef.current = null
      })
    }
  }

  async function restartLiveStream(reason = null) {
    if (!serial || noDevice || !liveViewRunning) return
    if (reason) setLiveViewStatus(reason)
    await invoke('stop_live_stream').catch(() => null)
    await new Promise(resolve => window.setTimeout(resolve, 120))
    await invoke('start_live_stream', { serial })
    updateMirrorPopup(null, `Connected to ${device?.model || serial}`)
  }

  async function captureLiveFrame() {
    if (!serial) return
    try {
      await ensureDeviceAwake()
      const res = await invoke('capture_screen_frame', { serial })
      if (!res?.ok || !res?.b64) {
        throw new Error(res?.stderr || 'Failed to capture live frame.')
      }
      const normalizedB64 = String(res.b64).trim()
      const src = normalizedB64.startsWith('data:')
        ? normalizedB64
        : `data:image/png;base64,${normalizedB64}`
      setLiveViewSrc(src)
      setLiveViewStatus(`Snapshot captured • ${new Date().toLocaleTimeString()}`)
    } catch (error) {
      const status = `Snapshot error: ${error}`
      setLiveViewStatus(status)
      append(status)
    }
  }

  async function _openLivePopup() {
    const label = 'ntk-live-view'
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      existing.setFocus().catch(() => {})
      mirrorPopupRef.current = existing
      if (liveViewRunning) {
        await restartLiveStream('Refreshing stream for pop-out window…')
      }
      return
    }
    const title = `Nocturnal Screen Mirror${device?.model ? ` • ${device.model}` : ''}`
    const win = new WebviewWindow(label, {
      url: `/?liveview_popup=1&serial=${encodeURIComponent(serial)}`,
      title,
      width: 430,
      height: 860,
      minWidth: 320,
      minHeight: 480,
      resizable: true,
      decorations: true,
    })
    win.once('tauri://error', (e) => {
      append(`Live-view popout error: ${e.payload ?? e}`)
      mirrorPopupRef.current = null
    })
    mirrorPopupRef.current = win
    if (liveViewRunning) {
      await new Promise(resolve => window.setTimeout(resolve, 180))
      await restartLiveStream('Refreshing stream for pop-out window…')
    }
  }

  useEffect(() => {
    if (!liveViewRunning || noDevice || !serial) return undefined
    setLiveViewStatus('Starting live stream…')
    invoke('start_live_stream', { serial })
      .then(() => updateMirrorPopup(null, `Connected to ${device?.model || serial}`))
      .catch(error => {
        const message = `Live stream failed to start: ${error}`
        setLiveViewStatus(message)
        append(message)
        setLiveViewRunning(false)
      })
    return () => {
      invoke('stop_live_stream').catch(() => null)
    }
  }, [liveViewRunning, serial, noDevice, device?.model])

  useEffect(() => {
    let unlisten
    listen('live-stream:status', event => {
      const payload = event.payload || {}
      if (!payload.message) return
      setLiveViewStatus(payload.message)
      if (payload.state === 'stopped') setLiveViewRunning(false)
    }).then(fn => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [])

  const sectionStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '16px',
  }

  const actionButtonStyle = { padding: '6px 12px', fontSize: 'var(--text-xs)' }

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Screen Mirror</h1>
        </div>
        {noDevice && (
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
            Connect Device
          </button>
        )}
      </div>

      <div className="panel-scroll">
        <div style={{
          background: 'linear-gradient(135deg, rgba(20,184,166,0.09), rgba(59,130,246,0.05))',
          border: '1px solid rgba(20,184,166,0.18)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 16px',
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
            Desktop Screen Mirror
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Built-in capture and viewing tools for the connected device, including live streaming, screenshots, and screen recording.
          </div>
        </div>

        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 18 }}>
            <span>No device connected — Screen Mirror actions are disabled.</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>View Devices</button>
          </div>
        )}

        <div style={sectionStyle}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Nocturnal Toolkit keeps the viewer running as a continuous in-app stream loop inside the Screen Mirror panel.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={captureScreenshot}>Screenshot</button>
            <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={recordScreen}>Record 10s</button>
            <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runDeviceShell('svc power stayon true; input keyevent KEYCODE_WAKEUP', 'Keep screen awake while plugged in')}>Stay Awake On</button>
            <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={() => runDeviceShell('svc power stayon false', 'Restore normal sleep behavior')}>Stay Awake Off</button>
            <button className="btn-ghost" style={actionButtonStyle} onClick={() => onOpenPanel?.('files')}>Open File Browser</button>
            <button className="btn-ghost" style={actionButtonStyle} onClick={() => onOpenPanel?.('adb')}>Open ADB & Shell</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 8 }}>Live Stream</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <button className="btn-primary" style={actionButtonStyle} disabled={noDevice} onClick={() => setLiveViewRunning(v => !v)}>
                  {liveViewRunning ? 'Stop' : 'Start Stream'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <button className="btn-ghost" style={actionButtonStyle} disabled={noDevice || running} onClick={captureLiveFrame}>Capture Now</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {liveViewStatus}
              </div>
            </div>
            <LiveVideoSurface serial={serial} running={liveViewRunning} snapshotSrc={liveViewSrc} emptyLabel="Start Stream to open a mirrored phone screen for the connected device." interactive />
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>
            Screen Mirror Output
          </div>
          <pre ref={outputRef} style={{ margin: 0, minHeight: 220, maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {output || 'Run a Screen Mirror action to see output here.'}
          </pre>
        </div>
      </div>
    </div>
  )
}

function LiveViewPopupWindow() {
  const serial = liveViewPopupSerial()

  return (
    <div style={{
      background: '#0b0b0f',
      color: '#fff',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.08)', fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
        Nocturnal Screen Mirror
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, overflow: 'hidden' }}>
        <LiveVideoSurface serial={serial} running={true} emptyLabel="Start the stream in the main window to see it here." maxDisplayWidth={null} interactive />
      </div>
    </div>
  )
}

function PhonesPanel({ devices, ready, selected, onSelect, props, loading, onReboot, savedDevices = [], savedDeviceHistory = [], onSaveDevice, onRemoveSaved, onUpdateSaved, onReplaceSaved, onClearSavedHistory, onRecordSavedHistory, pairSectionOpen, onPairSectionToggle, platform, onOpenPanel }) {
  const [editingNameId, setEditingNameId] = useState(null)
  const [editingName, setEditingName] = useState('')

  // Pair card state (moved up from DeviceDetail)
  const [connectIp, setConnectIp] = useState('')
  const [pairIp, setPairIp] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [wifiStatus, setWifiStatus] = useState(null)
  const [savePromptIp, setSavePromptIp] = useState(null)
  const [saveDeviceName, setSaveDeviceName] = useState('')

  // prefillPairIp is set by Pair buttons in device/saved lists; applied immediately to pairIp
  function triggerPrefill(ip) {
    setPairIp(ip)
    onPairSectionToggle?.(true)
  }

  async function exportSavedDevices() {
    const root = await pathJoin(await downloadDir(), 'Nocturnal Toolkit', 'Backups')
    await mkdir(root, { recursive: true })
    const file = await pathJoin(root, 'saved_devices_backup.json')
    await writeTextFile(file, JSON.stringify({
      exportedAt: new Date().toISOString(),
      devices: savedDevices,
    }, null, 2))
    setWifiStatus(`Saved device backup written to:\n${file}`)
    onRecordSavedHistory?.({ type: 'export', label: `Exported ${savedDevices.length} saved device${savedDevices.length === 1 ? '' : 's'}` })
  }

  async function importSavedDevices() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!picked || Array.isArray(picked)) return
    const text = await readTextFile(picked)
    const parsed = JSON.parse(text)
    const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.devices) ? parsed.devices : []
    const normalized = incoming
      .filter(item => item?.ip && item?.port)
      .map(item => ({
        id: item.id || crypto.randomUUID(),
        name: item.name || `${item.ip}:${item.port}`,
        ip: String(item.ip),
        port: String(item.port),
        addedAt: item.addedAt || new Date().toISOString(),
      }))
    const merged = [...savedDevices]
    const seen = new Set(merged.map(item => `${item.ip}:${item.port}`))
    normalized.forEach(item => {
      const key = `${item.ip}:${item.port}`
      if (!seen.has(key)) {
        merged.push(item)
        seen.add(key)
      }
    })
    onReplaceSaved?.(merged)
    setWifiStatus(`Restored ${normalized.length} saved device${normalized.length === 1 ? '' : 's'} from backup.`)
    onRecordSavedHistory?.({ type: 'import', label: `Restored ${normalized.length} saved device${normalized.length === 1 ? '' : 's'} from backup` })
  }

  async function clearSavedDevices() {
    const ok = await dialogConfirm('Delete all saved devices from this computer?')
    if (!ok) return
    onReplaceSaved?.([])
    onRecordSavedHistory?.({ type: 'delete', label: 'Cleared all saved devices' })
  }

  async function wifiConnect() {
    if (!connectIp.trim()) return
    setWifiStatus('Connecting…')
    const res = await invoke('run_adb', { args: ['connect', connectIp.trim()] })
    const rawOut = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'No output'
    const out = (res.stdout || '') + (res.stderr || '')
    const ok = out.toLowerCase().includes('connected') && !out.toLowerCase().includes('unable') && !out.toLowerCase().includes('failed')
    setWifiStatus(rawOut)
    if (ok) {
      const ip = connectIp.trim().split(':')[0]
      const port = connectIp.trim().split(':')[1] || '5555'
      onRecordSavedHistory?.({ type: 'connect', label: `Connected to ${connectIp.trim()}` })
      if (!savedDevices.some(d => d.ip === ip)) {
        setSavePromptIp({ ip, port })
        setSaveDeviceName(ip)
      }
    }
  }

  async function wifiPair() {
    if (!pairIp.trim() || !pairCode.trim()) return
    setSavePromptIp(null)
    setWifiStatus('Starting ADB server…')
    await invoke('run_adb', { args: ['start-server'] })
    await new Promise(r => setTimeout(r, 500))
    setWifiStatus('Pairing…')
    const res = await invoke('run_adb', { args: ['pair', pairIp.trim(), pairCode.trim()] })
    const rawOut = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'No output'
    const outLower = ((res.stdout || '') + (res.stderr || '')).toLowerCase()
    const paired = outLower.includes('successfully paired') || outLower.includes('paired to') || outLower.includes('pairing successful')
    if (!paired) {
      setWifiStatus(`Pairing failed.\n\nADB output:\n${rawOut}`)
      return
    }
    const importedTarget = pairIp.trim()
    setConnectIp(importedTarget)
    onRecordSavedHistory?.({ type: 'pair', label: `Paired with ${pairIp.trim()}` })
    setWifiStatus(`Paired successfully.\n\nADB output:\n${rawOut}\n\nThe Connect field now uses the exact host:port imported from your phone. If Wireless Debugging shows a different connect port on the device, update it there before clicking Connect.`)
  }

  if (platform === 'android') {
    return <AndroidDeviceHome device={selected} props={props} loading={loading} onOpenPanel={onOpenPanel} />
  }

  return (
    <div className="devices-panel">
      <div className="devices-list">
        {/* SAVED DEVICES */}
        <div>
          <div style={{ padding: '16px 16px 8px', fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Saved Devices
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 10px' }}>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }} disabled={savedDevices.length === 0} onClick={exportSavedDevices}>Backup</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }} onClick={importSavedDevices}>Restore</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', color: 'var(--accent-red)' }} disabled={savedDevices.length === 0} onClick={clearSavedDevices}>Delete All</button>
          </div>
          {savedDevices.length === 0 ? (
            <div style={{ padding: '0 16px 12px', fontSize: 11, color: 'var(--text-muted)' }}>No saved devices yet.</div>
          ) : (
          <div>
            {savedDevices.map(sd => (
              <div key={sd.id} style={{ padding: '8px 16px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ color: 'var(--accent)', fontSize: 'var(--text-xs)', flexShrink: 0 }}>★</span>
                  {editingNameId === sd.id ? (
                    <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)}
                      onBlur={() => { onUpdateSaved?.(sd.id, editingName); setEditingNameId(null) }}
                      onKeyDown={e => { if (e.key === 'Enter') { onUpdateSaved?.(sd.id, editingName); setEditingNameId(null) } if (e.key === 'Escape') setEditingNameId(null) }}
                      style={{ ...inputStyle, fontSize: 11, padding: '2px 6px' }} />
                  ) : (
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}
                      onDoubleClick={() => { setEditingNameId(sd.id); setEditingName(sd.name) }}>
                      {sd.name}
                    </span>
                  )}
                  <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                    title="Remove" onClick={() => { onRemoveSaved?.(sd.id); onRecordSavedHistory?.({ type: 'delete', label: `Removed saved device ${sd.name}` }) }}>🗑</button>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 6, paddingLeft: 16 }}>
                  {sd.ip}:{sd.port}
                </div>
                <div style={{ display: 'flex', gap: 4, paddingLeft: 16 }}>
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => { onRecordSavedHistory?.({ type: 'connect', label: `Connected to saved device ${sd.ip}:${sd.port}` }); invoke('run_adb', { args: ['connect', `${sd.ip}:${sd.port}`] }) }}>
                    Connect
                  </button>
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => triggerPrefill(sd.ip)}>
                    Pair
                  </button>
                </div>
              </div>
            ))}
          </div>
          )}
            <div style={{ padding: '12px 16px 4px', fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              History
            </div>
            <div style={{ padding: '0 16px 12px' }}>
              {savedDeviceHistory.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No saved-device history yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {savedDeviceHistory.slice(0, 8).map(item => (
                    <div key={item.id} style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-primary)', marginBottom: 3 }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(item.at).toLocaleString()}</div>
                    </div>
                  ))}
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 8px', alignSelf: 'flex-start' }} onClick={onClearSavedHistory}>
                    Clear History
                  </button>
                </div>
              )}
            </div>
        </div>

        {/* CONNECTED DEVICES */}
        <div style={{ padding: '16px 16px 8px', fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Connected Devices
        </div>
        {!ready && <div style={{ padding: '8px 16px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Scanning…</div>}
        {ready && devices.length === 0 && (
          <div style={{
            margin: '0 16px 12px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border-subtle)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', marginBottom: 4 }}>
              No devices found
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 8 }}>
              Check Getting Started for USB setup or open Help & Docs for troubleshooting.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button
                className="btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px' }}
                onClick={() => onOpenPanel?.('getting-started')}
              >
                Open Getting Started
              </button>
              <button
                className="btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px' }}
                onClick={() => onOpenPanel?.('help')}
              >
                Open Help & Docs
              </button>
              {platform === 'linux' && (
                <button
                  className="btn-ghost"
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={() => onOpenPanel?.('help')}
                >
                  Linux USB Help
                </button>
              )}
            </div>
          </div>
        )}
        {devices.map(d => {
          const active = selected?.serial === d.serial
          const statusColor = STATUS[d.status]?.text ?? 'var(--text-muted)'
          const ipMatch = d.serial.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)
          const isMdns = d.serial.includes('._adb-tls-') || (d.serial.startsWith('adb-') && d.serial.includes('._tcp'))
          const canPair = !!(ipMatch || isMdns)
          const pairLabel = isMdns ? 'Re-Pair' : 'Pair'
          return (
            <div key={d.serial} className={`nav-item${active ? ' active' : ''}`} onClick={() => onSelect(d)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.model}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace' }}>
                    {d.serial}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: statusColor, fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {STATUS[d.status]?.label ?? d.status}
                  </div>
                </div>
                {canPair && (
                  <button className="btn-ghost" style={{ fontSize: 10, padding: '2px 7px', flexShrink: 0, marginTop: 2 }}
                    onClick={e => { e.stopPropagation(); triggerPrefill(ipMatch ? ipMatch[1] : ''); onSelect(d) }}>
                    {pairLabel}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Right column: pair card pinned at top + device detail below */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)' }}>

        {/* ── PAIR & CONNECT DEVICE card ── */}
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border-subtle)' }}>
          <div onClick={() => onPairSectionToggle?.(!pairSectionOpen)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', cursor: 'pointer', userSelect: 'none', background: 'rgba(255,255,255,0.018)' }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block', transform: pairSectionOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
            <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Pair &amp; Connect Device</span>
          </div>
          {pairSectionOpen && (
            <div style={{ padding: '10px 16px 14px' }}>
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.08)', border: '1px solid rgba(20,184,166,0.18)' }}>
                <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--accent-teal)', marginBottom: 4 }}>Wireless Debugging uses two steps</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  Use <strong>Pair via Code</strong> with the temporary <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>IP:pairing-port</code> and 6-digit code shown in the phone&apos;s <strong>Pair device with pairing code</strong> popup.
                  Then use <strong>Connect</strong> with the <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>IP:connect-port</code> shown on the main <strong>Wireless debugging</strong> screen. They are often different.
                </div>
              </div>
              {/* Connect */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 5 }}>Connect using the Wireless Debugging screen&apos;s IP:port</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" placeholder="192.168.1.100:5555" value={connectIp}
                    onChange={e => setConnectIp(e.target.value)} onKeyDown={e => e.key === 'Enter' && wifiConnect()} style={inputStyle} />
                  <button className="btn-ghost" style={{ flexShrink: 0 }} onClick={wifiConnect}>Connect</button>
                </div>
              </div>
              {/* Pair via Code */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 5 }}>Pair using the Pair Device popup&apos;s IP:pairing-port + 6-digit code</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" placeholder="192.168.1.100:37000" value={pairIp}
                    onChange={e => setPairIp(e.target.value)} style={inputStyle} />
                  <input type="text" placeholder="6-digit code" value={pairCode}
                    onChange={e => setPairCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && wifiPair()}
                    style={{ ...inputStyle, width: 110, flexShrink: 0 }} />
                  <button className="btn-ghost" style={{ flexShrink: 0 }} onClick={wifiPair}>Pair</button>
                </div>
              </div>
              {/* Test ADB Connection */}
              <div style={{ marginBottom: wifiStatus ? 8 : 0 }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={async () => { const r = await invoke('run_adb', { args: ['devices'] }); setWifiStatus(([r.stdout, r.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim()) || 'No output') }}>
                  Test ADB Connection
                </button>
              </div>
              {/* Status output */}
              {wifiStatus && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontFamily: 'monospace', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {wifiStatus}
                </div>
              )}
              {/* Save device prompt */}
              {savePromptIp && (
                <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-green)', marginBottom: 6 }}>Save this device?</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="text" value={saveDeviceName} onChange={e => setSaveDeviceName(e.target.value)} placeholder="Device name" style={{ ...inputStyle, fontSize: 11 }} />
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                      onClick={() => { onSaveDevice?.({ id: Date.now().toString(), name: saveDeviceName || savePromptIp.ip, ip: savePromptIp.ip, port: savePromptIp.port, addedAt: new Date().toISOString() }); onRecordSavedHistory?.({ type: 'save', label: `Saved device ${saveDeviceName || savePromptIp.ip}` }); setSavePromptIp(null) }}>
                      Save
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0, color: 'var(--text-muted)' }}
                      onClick={() => setSavePromptIp(null)}>✕</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', padding: '10px 16px 12px' }}>
          <div style={{ marginBottom: 8, fontSize: 10, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Connection &amp; Server
          </div>
          <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.08)', border: '1px solid rgba(20,184,166,0.18)' }}>
            <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--accent-teal)', marginBottom: 4 }}>Wireless Debugging uses two different ports</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Pair first with the temporary <strong>pairing popup</strong> port and 6-digit code. Then connect using the separate <strong>Wireless debugging</strong> IP:port shown on the phone&apos;s main screen. Pairing alone authorizes this computer, but the device will not appear as connected until the second step succeeds.
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={async () => { const r = await invoke('run_adb', { args: ['devices'] }); setWifiStatus(([r.stdout, r.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim()) || 'No output') }}>List Devices</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={async () => { const r = await invoke('run_adb', { args: ['kill-server'] }); setWifiStatus(([r.stdout, r.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim()) || 'ADB server stopped.') }}>Kill Server</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={async () => { const r = await invoke('run_adb', { args: ['start-server'] }); setWifiStatus(([r.stdout, r.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim()) || 'ADB server started.') }}>Start Server</button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onOpenPanel?.('adb')}>Open ADB &amp; Shell</button>
          </div>
        </div>

        {/* Device detail scrollable area */}
        <DeviceDetail device={selected} props={props} loading={loading} onReboot={onReboot}
          savedDevices={savedDevices} onSaveDevice={onSaveDevice} />
      </div>
    </div>
  )
}

// ── Install APK panel ─────────────────────────────────────────────────────────

const INSTALL_STATUS = {
  pending:    { color: 'var(--text-muted)',   label: 'Pending'     },
  installing: { color: 'var(--accent)',        label: 'Installing…' },
  done:       { color: 'var(--accent-green)', label: 'Installed'   },
  error:      { color: 'var(--accent-red)',   label: 'Failed'      },
}

function QueueItem({ item, canInstall, onInstall, onRemove }) {
  const [dlProg, setDlProg] = useState(null) // { percent, speed, received, total }
  const isUrlInstall = typeof item.path === 'string' && item.path.startsWith('http')

  // Subscribe to install:progress events for this item's filename
  useEffect(() => {
    if (!isUrlInstall) return
    let unlisten
    listen('install:progress', e => {
      const p = e.payload
      // match on both 'filename' (new) and 'store' (legacy) keys
      if (p?.filename !== item.name && p?.store !== item.name) return
      if (p.phase === 'downloading') {
        setDlProg({ percent: p.percent ?? 0, speed: p.speed ?? '', received: p.received ?? '', total: p.total ?? '' })
      } else {
        setDlProg(null)
      }
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [item.name, isUrlInstall])

  // Derive the status label and colour from current state + live progress
  const isActive      = item.status === 'installing'
  const isDownloading = isActive && dlProg !== null

  let statusText, statusColor
  if (isDownloading) {
    const { percent, speed, received, total } = dlProg
    const parts = [`${percent}%`]
    if (speed)             parts.push(speed)
    if (received && total) parts.push(`${received}/${total}`)
    statusText  = `Downloading… ${parts.join(' · ')}`
    statusColor = 'var(--accent)'
  } else if (isActive) {
    statusText  = 'Installing…'
    statusColor = 'var(--accent)'
  } else if (item.status === 'done') {
    statusText  = '✓ Installed'
    statusColor = 'var(--accent-green)'
  } else if (item.status === 'error') {
    statusText  = `✗ Failed${item.error ? ` — ${item.error.slice(0, 60)}` : ''}`
    statusColor = 'var(--accent-red)'
  } else {
    const st = INSTALL_STATUS[item.status] ?? INSTALL_STATUS.pending
    statusText  = st.label
    statusColor = st.color
  }

  const showBar     = isActive && isUrlInstall
  const barPercent  = dlProg?.percent ?? 0

  return (
    <div className="queue-item" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{ fontSize: 28, flexShrink: 0, lineHeight: 1 }}>
        {/\.(xapk|apkm)$/i.test(item.name) ? '🗜️' : '📦'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 'var(--font-medium)', fontSize: 'var(--text-sm)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 3,
        }}>
          {item.name}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {item.size && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{item.size}</span>
          )}
          <span style={{ fontSize: 'var(--text-xs)', color: statusColor }}>{statusText}</span>
          {/* xapk extraction progress message */}
          {item.progress && !isDownloading && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.progress}
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {canInstall && (
          <button className="btn-primary" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onInstall}>
            Install
          </button>
        )}
        {item.status !== 'installing' && (
          <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 'var(--text-xs)' }} onClick={onRemove}>
            ✕
          </button>
        )}
      </div>

      {/* Download / install progress bar pinned to bottom edge */}
      {showBar && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'var(--border)' }}>
          {barPercent > 0 ? (
            <div style={{ height: '100%', width: `${barPercent}%`, background: 'var(--accent)', transition: 'width 0.4s ease-out', borderRadius: '0 2px 2px 0' }} />
          ) : (
            <div style={{ height: '100%', width: '40%', background: 'var(--accent)', animation: 'progress-indeterminate 1.4s ease-in-out infinite' }} />
          )}
        </div>
      )}
    </div>
  )
}

function InstallApkPanel({ device, onNavigateToDevices, externalQueue, onExternalQueueConsumed, platform }) {
  const [queue, setQueue]       = useState([])
  const [dragOver, setDragOver] = useState(false)
  const isAndroidLocalDevice = platform === 'android' && (device?.transport || '').toLowerCase() === 'local'

  // Merge items pushed from Search APKs panel (shared state path) — dedup by path
  useEffect(() => {
    if (!externalQueue?.length) return
    setQueue(q => {
      const existingPaths = new Set(q.map(x => x.path))
      const fresh = externalQueue.filter(x => !existingPaths.has(x.path))
      return fresh.length ? [...q, ...fresh] : q
    })
    onExternalQueueConsumed?.()
  }, [externalQueue, onExternalQueueConsumed])

  // Merge items stored in localStorage (fallback) — dedup by path
  useEffect(() => {
    try {
      const pending = JSON.parse(localStorage.getItem('nt_pending_installs') || '[]')
      localStorage.removeItem('nt_pending_installs') // clear immediately before any async work
      if (pending.length) {
        setQueue(q => {
          const existingPaths = new Set(q.map(x => x.path))
          const fresh = pending
            .filter(item => !existingPaths.has(item.url))
            .map(item => ({ id: crypto.randomUUID(), name: item.name, path: item.url, status: 'pending' }))
          return fresh.length ? [...q, ...fresh] : q
        })
      }
    } catch { /* ignore */ }
  }, [])

  // Use getCurrentWebview().onDragDropEvent() — single listener, correct Tauri 2 API.
  // The cancelled flag handles React StrictMode's double-mount: if cleanup runs before
  // the Promise resolves we immediately call the returned unlisten fn.
  useEffect(() => {
    let cancelled = false
    let unlisten = () => {}

    getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload
      if (type === 'enter' || type === 'over') {
        setDragOver(true)
      } else if (type === 'leave') {
        setDragOver(false)
      } else if (type === 'drop') {
        setDragOver(false)
        const paths = (event.payload.paths ?? []).filter(p => /\.(apk|xapk|apkm)$/i.test(p))
        if (paths.length) {
          setQueue(q => [
            ...q,
            ...paths.map(p => ({
              id: crypto.randomUUID(),
              name: p.split('/').pop(),
              path: p,
              status: 'pending',
              error: null,
            })),
          ])
        }
      }
    }).then(fn => {
      if (cancelled) fn()   // component already unmounted — clean up immediately
      else unlisten = fn
    })

    return () => { cancelled = true; unlisten() }
  }, [])

  function addPathsToQueue(paths) {
    setQueue(q => [
      ...q,
      ...paths.map(p => ({
        id: crypto.randomUUID(),
        name: p.split('/').pop(),
        path: p,
        status: 'pending',
        error: null,
      })),
    ])
  }

  async function browse() {
    const result = await openDialog({
      multiple: true,
      filters: [{ name: 'APK Files', extensions: ['apk', 'xapk', 'apkm'] }],
    })
    if (!result) return
    addPathsToQueue(Array.isArray(result) ? result : [result])
  }

  function removeItem(id) {
    setQueue(q => q.filter(x => x.id !== id))
  }

  async function installItem(item) {
    if (!device) return
    const id = item.id
    setQueue(q => q.map(x => x.id === id ? { ...x, status: 'installing', error: null, progress: null } : x))

    const isMulti = /\.(xapk|apkm)$/i.test(item.name)
    const isUrl   = typeof item.path === 'string' && item.path.startsWith('http')
    let res
    if (isMulti) {
      if (isAndroidLocalDevice) {
        setQueue(q => q.map(x => x.id === id ? {
          ...x,
          status: 'error',
          progress: null,
          error: 'Split APK / XAPK install on the local Android device is still pending. Use a standard APK for now.',
        } : x))
        return
      }
      // Listen for progress events during extraction
      const unlisten = await listen('xapk:progress', e => {
        if (e.payload?.path === item.path) {
          setQueue(q => q.map(x => x.id === id ? { ...x, progress: e.payload.message } : x))
        }
      })
      try {
        res = await invoke('extract_and_install_xapk', { serial: device.serial, path: item.path })
      } finally {
        unlisten()
      }
    } else if (isUrl) {
      res = await invoke('install_from_url', { serial: device.serial, url: item.path, filename: item.name })
      if (isAndroidLocalDevice && res?.localPath) {
        await openUrl(res.localPath)
        res = { ...res, ok: true, stdout: 'Opened the Android package installer.' }
      }
    } else if (isAndroidLocalDevice) {
      await openUrl(item.path)
      res = { ok: true, stdout: 'Opened the Android package installer.', stderr: '' }
    } else {
      res = await invoke('run_adb', { args: ['-s', device.serial, 'install', '-r', item.path] })
    }

    if (res.ok) {
      setQueue(q => q.map(x => x.id === id ? { ...x, status: 'done', progress: null } : x))
    } else {
      const err = res.stderr?.trim() || 'Install failed'
      setQueue(q => q.map(x => x.id === id ? { ...x, status: 'error', error: err, progress: null } : x))
    }
  }

  async function installAll() {
    const pending = queue.filter(x => x.status === 'pending')
    for (const item of pending) await installItem(item)
  }

  const pendingCount = queue.filter(x => x.status === 'pending').length

  return (
    <div className="panel-content">

      {/* Panel header row */}
      <div className="panel-header-row">
        <div>
          <div className="panel-header-accent" />
          <h2 className="panel-header">Install APK</h2>
        </div>
        <button className="btn-primary" onClick={browse}>+ Add APK</button>
      </div>

      <div className="panel-scroll">

        {/* No device warning */}
        {!device && (
          <div className="warning-banner">
            <span style={{ fontSize: 'var(--text-sm)' }}>No device connected — connect a device to install APKs</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={onNavigateToDevices}>
              View Devices
            </button>
          </div>
        )}

        {/* Drop zone */}
        <div
          className={`drop-zone${dragOver ? ' drop-zone-active' : ''}`}
          onClick={browse}
        >
          <div style={{ fontSize: 40, marginBottom: 12, lineHeight: 1 }}>📦</div>
          <div style={{
            fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-base)',
            color: 'var(--text-primary)', marginBottom: 6,
          }}>
            Drop APK files here
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 10 }}>
            or <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>click to browse</span>
          </div>
          <div className="format-badge">.APK · .XAPK · .APKM</div>
        </div>

        {/* Queue section */}
        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <SectionLabel>Install Queue</SectionLabel>
            {pendingCount > 0 && (
              <button
                className="btn-primary"
                style={{ padding: '4px 14px', fontSize: 'var(--text-xs)', marginBottom: 10 }}
                onClick={installAll}
              >
                ⚡ Install All ({pendingCount})
              </button>
            )}
          </div>

          {queue.length === 0 && (
            <div style={{
              textAlign: 'center', padding: '28px 16px',
              color: 'var(--text-muted)', fontSize: 'var(--text-sm)',
            }}>
              Queue is empty. Drop APK files above or search for an APK.
            </div>
          )}

          {queue.map(item => (
            <QueueItem
              key={item.id}
              item={item}
              canInstall={!!device && item.status === 'pending'}
              onInstall={() => installItem(item)}
              onRemove={() => removeItem(item.id)}
            />
          ))}
        </div>

      </div>
    </div>
  )
}

// ── Search APKs panel ─────────────────────────────────────────────────────────

const TRENDING_PILLS = [
  { q: 'VLC',           icon: '🎬' },
  { q: 'NewPipe',       icon: '▶️' },
  { q: 'Firefox',       icon: '🦊' },
  { q: 'Signal',        icon: '💬' },
  { q: 'Telegram',      icon: '✈️' },
  { q: 'Aegis',         icon: '🔐' },
  { q: 'Bitwarden',     icon: '🔑' },
  { q: 'K-9 Mail',      icon: '📧' },
  { q: 'Organic Maps',  icon: '🗺️' },
  { q: 'Thunderbird',   icon: '🐦' },
]

const SEARCH_SOURCES = [
  { id: 'fdroid',    name: 'F-Droid',   icon: '🟢', trust: 99, color: 'var(--accent-green)',   comingSoon: false, browserOnly: false },
  { id: 'github',    name: 'GitHub',    icon: '⭐', trust: 95, color: '#60a5fa',               comingSoon: false, browserOnly: false },
  { id: 'aptoide',   name: 'Aptoide',   icon: '🟡', trust: 89, color: '#f59e0b',               comingSoon: false, browserOnly: false },
  { id: 'apkpure',   name: 'APKPure',   icon: '🔵', trust: 94, color: '#fb923c',               comingSoon: false, browserOnly: true  },
  { id: 'apkmirror', name: 'APKMirror', icon: '🔴', trust: 99, color: 'var(--accent-red)',     comingSoon: false, browserOnly: true  },
  { id: 'uptodown',  name: 'Uptodown',  icon: '⬇️', trust: 96, color: 'var(--accent-teal)',    comingSoon: false, browserOnly: true  },
]

const BROWSER_ONLY_SOURCES = new Set(['apkpure', 'apkmirror', 'uptodown'])

const BROWSER_SOURCE_SEARCH_URLS = {
  aptoide:   q => `https://en.aptoide.com/search?query=${encodeURIComponent(q)}`,
  apkpure:   q => `https://apkpure.com/search?q=${encodeURIComponent(q)}`,
  apkmirror: q => `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${encodeURIComponent(q)}`,
  uptodown:  q => `https://en.uptodown.com/android/search/${encodeURIComponent(q)}`,
}

const SOURCE_BADGE = {
  fdroid:    { label: 'F-Droid',   bg: 'rgba(34,197,94,0.12)',   color: 'var(--accent-green)'   },
  apkmirror: { label: 'APKMirror', bg: 'rgba(239,68,68,0.15)',   color: 'var(--accent-red)'     },
  apkpure:   { label: 'APKPure',   bg: 'rgba(251,146,60,0.15)',  color: '#fb923c'               },
  aptoide:   { label: 'Aptoide',   bg: 'rgba(245,158,11,0.15)',  color: 'var(--accent-yellow)'  },
  github:    { label: 'GitHub',    bg: 'rgba(96,165,250,0.15)',  color: '#60a5fa'               },
  uptodown:  { label: 'Uptodown',  bg: 'rgba(16,185,129,0.15)',  color: 'var(--accent-green)'   },
}

const selectStyle = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-xs)',
  padding: '4px 8px',
  outline: 'none',
  fontFamily: 'inherit',
  cursor: 'pointer',
}

function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <div
      onClick={!disabled ? onChange : undefined}
      style={{
        width: 30, height: 17, borderRadius: 9, flexShrink: 0,
        background: checked ? 'var(--accent)' : 'var(--bg-active)',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', transition: 'background 0.18s, border-color 0.18s',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <div style={{
        width: 11, height: 11, borderRadius: '50%', background: 'white',
        position: 'absolute', top: 2,
        left: checked ? 15 : 2,
        transition: 'left 0.18s',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      }} />
    </div>
  )
}

function SearchApkPanel({ device, onNavigateToDevices, onNavigateToInstall: _onNavigateToInstall, onAddToQueue, platform }) {
  const [query, setQuery]             = useState('')
  const [searchState, setSearchState] = useState('idle') // idle | searching | results | no_results
  const [searchError, setSearchError] = useState(null)
  const [results, setResults]         = useState([])
  const [sourceProg, setSourceProg]   = useState({ apkmirror: 0, apkpure: 0, aptoide: 0, github: 0, fdroid: 0, uptodown: 0 })
  const [enabledSources, setEnabledSources] = useState(
    () => new Set(SEARCH_SOURCES.filter(s => !s.comingSoon && !s.browserOnly).map(s => s.id))
  )
  const [sourceFilter, setSourceFilter] = useState('all')
  const [archFilter, setArchFilter]   = useState('all')
  const [sortBy, setSortBy]           = useState('relevance')
  const [installing, setInstalling]   = useState({}) // id → 'downloading' | 'installing' | 'done' | 'error'
  const [dlProgress, setDlProgress]   = useState({}) // id → { percent, speed, received, total }
  const [githubPicks, setGithubPicks] = useState(null) // null = loading, array = loaded
  const [refreshState, setRefreshState] = useState('idle') // idle | loading | done
  const [refreshToast, setRefreshToast] = useState(null)
  const [toasts, setToasts]           = useState([])
  const [queuedPaths, setQueuedPaths] = useState(new Set()) // track URLs added to queue this session

  function addToast(msg, type = 'success') {
    const id = Math.random().toString(36).slice(2)
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }
  const inputRef = useRef(null)
  const lastQuery = useRef('')

  useEffect(() => {
    invoke('fetch_github_picks')
      .then(res => setGithubPicks(res.picks ?? []))
      .catch(() => setGithubPicks([]))
  }, [])

  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'

  async function runSearch(q) {
    const term = (q ?? query).trim()
    if (!term) return
    lastQuery.current = term
    setQuery(term)
    setSearchState('searching')
    setSearchError(null)
    setResults([])
    setSourceProg({ apkmirror: 0, apkpure: 0, aptoide: 0, github: 0, fdroid: 0, uptodown: 0 })

    // Animate coming-soon / browser-only sources — ramp to ~35% and hold
    SEARCH_SOURCES.filter(s => s.comingSoon || s.browserOnly).forEach((src, i) => {
      setTimeout(() => setSourceProg(p => ({ ...p, [src.id]: 15 })), i * 60 + 80)
      setTimeout(() => setSourceProg(p => ({ ...p, [src.id]: 35 })), i * 60 + 350)
    })
    // Animate enabled live sources with fake incremental progress
    const liveSrcIds = SEARCH_SOURCES
      .filter(s => !s.comingSoon && !s.browserOnly && enabledSources.has(s.id))
      .map(s => s.id)
    const steps = [[20, 10, 15], [55, 30, 45], [80, 60, 75]]
    ;[200, 700, 1300].forEach((d, si) => {
      const updates = {}
      liveSrcIds.forEach((id, li) => { updates[id] = steps[si][li % 3] })
      setTimeout(() => setSourceProg(p => ({ ...p, ...updates })), d)
    })

    try {
      const invokeArgs = { query: term, sources: [...enabledSources] }
      console.log('[search_apks] invoking with', invokeArgs)
      const res = await invoke('search_apks', invokeArgs)
      const completions = {}
      liveSrcIds.forEach(id => { completions[id] = 100 })
      setSourceProg(p => ({ ...p, ...completions }))

      const mapped = (res.results ?? []).map((pkg, i) => {
        const src = pkg.source || 'fdroid'
        return {
          id:       `${src}_${i}`,
          name:     pkg.name || pkg.packageName,
          pkg:      pkg.packageName,
          version:  pkg.suggestedVersionName || '?',
          date:     pkg.lastUpdated ? new Date(pkg.lastUpdated * 1000).toISOString().slice(0, 10) : '',
          summary:  pkg.summary || '',
          source:   src,
          arch:     src === 'fdroid' ? ['arm64-v8a', 'armeabi-v7a'] : ['universal'],
          verified: src === 'fdroid',
          apkUrl:   pkg.apkUrl || null,
          pageUrl:  pkg.pageUrl || pkg.apkUrl || null,
        }
      })

      const browserOnlyResults = SEARCH_SOURCES
        .filter(src => src.browserOnly && enabledSources.has(src.id))
        .map(src => ({
          id: `${src.id}_browser_${term}`,
          name: `${src.name} results for "${term}"`,
          pkg: `${src.name.toLowerCase()}.browser.search`,
          version: 'Browser search',
          date: '',
          summary: 'Open this source in your browser to review available packages and versions.',
          source: src.id,
          arch: ['browser'],
          verified: false,
          apkUrl: null,
          pageUrl: BROWSER_SOURCE_SEARCH_URLS[src.id]?.(term) ?? null,
        }))

      const combined = [...mapped.filter(pkg => !BROWSER_ONLY_SOURCES.has(pkg.source)), ...browserOnlyResults]
      setResults(combined)
      setSearchState(combined.length > 0 ? 'results' : 'no_results')
    } catch (e) {
      console.error('[search_apks] invoke error:', e)
      const completions = {}
      liveSrcIds.forEach(id => { completions[id] = 100 })
      setSourceProg(p => ({ ...p, ...completions }))
      setSearchError(String(e))
      setSearchState('no_results')
    }
  }

  async function refreshFdroid() {
    setRefreshState('loading')
    setRefreshToast(null)
    try {
      const res = await invoke('refresh_fdroid_index')
      setRefreshToast(`F-Droid database updated — ${res.count.toLocaleString()} apps indexed`)
      setRefreshState('done')
      setTimeout(() => { setRefreshToast(null); setRefreshState('idle') }, 5000)
    } catch (e) {
      setRefreshToast(`Refresh failed: ${e}`)
      setRefreshState('idle')
      setTimeout(() => setRefreshToast(null), 5000)
    }
  }

  async function installResult(result) {
    if (noDevice) { addToast('Connect a device first', 'error'); return }
    if (!result.apkUrl) { addToast('No download URL available for this result', 'error'); return }

    const id       = result.id
    const filename = `${result.pkg}.apk`

    setInstalling(s => ({ ...s, [id]: 'downloading' }))

    const unlisten = await listen('install:progress', e => {
      if (e.payload?.store !== filename) return
      const { phase, percent, speed, received, total } = e.payload
      if (phase === 'downloading') {
        setInstalling(s => ({ ...s, [id]: 'downloading' }))
        setDlProgress(s => ({ ...s, [id]: { percent, speed, received, total } }))
      } else if (phase === 'installing') {
        setInstalling(s => ({ ...s, [id]: 'installing' }))
        setDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      }
    })

    try {
      const res = await invoke('install_from_url', { serial, url: result.apkUrl, filename })
      if (platform === 'android' && res?.localPath) {
        await openUrl(res.localPath)
      }
      setInstalling(s => ({ ...s, [id]: res.ok ? 'done' : 'error' }))
      setDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      if (res.ok && platform === 'android' && res?.localPath) {
        addToast('Opened the Android package installer', 'success')
      } else if (!res.ok) {
        addToast(`Install failed: ${(res.stderr || '').trim().slice(0, 80)}`, 'error')
      }
    } catch (e) {
      setInstalling(s => ({ ...s, [id]: 'error' }))
      setDlProgress(s => { const n = { ...s }; delete n[id]; return n })
      addToast(`Install error: ${String(e).slice(0, 80)}`, 'error')
    } finally {
      unlisten()
    }
  }

  const filtered = results
    .filter(r => enabledSources.has(r.source))
    .filter(r => sourceFilter === 'all' || r.source === sourceFilter)
    .filter(r => archFilter === 'all' || r.arch.includes(archFilter))
    .sort((a, b) => sortBy === 'date' ? (b.date || '').localeCompare(a.date || '') : 0)

  return (
    <div className="panel-content">

      {/* Toast container */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            minWidth: 260, maxWidth: 380,
            background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: toast.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)',
            borderRadius: 'var(--radius-md)', padding: '10px 14px',
            fontSize: 'var(--text-sm)', display: 'flex', gap: 8, alignItems: 'center',
            animation: 'toast-in 0.25s ease',
          }}>
            <span style={{ flexShrink: 0 }}>{toast.type === 'success' ? '✓' : '✗'}</span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">APKs</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <button
            className="btn-ghost"
            style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
            onClick={refreshFdroid}
            disabled={refreshState === 'loading'}
          >
            {refreshState === 'loading' ? 'Updating F-Droid index…' : 'Refresh Database'}
          </button>
          <button
            className="btn-primary"
            onClick={() => { setTimeout(() => inputRef.current?.focus(), 50) }}
          >
            Search APKs
          </button>
        </div>
      </div>

      {/* Refresh toast */}
      {refreshToast && (
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)', padding: '8px 14px',
          fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
          marginBottom: 12,
        }}>
          {refreshToast}
        </div>
      )}

      <div className="panel-scroll">

        {/* No device warning */}
        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected — Install will be disabled</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
              View Devices
            </button>
          </div>
        )}

        {/* Search bar */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '0 14px',
          }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>🔍</span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder="Search by app name or package name…"
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 'var(--text-base)',
                padding: '11px 0', fontFamily: 'inherit',
              }}
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setSearchState('idle'); setResults([]) }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}
              >×</button>
            )}
          </div>
          <button
            className="btn-primary"
            style={{ padding: '0 20px', flexShrink: 0 }}
            onClick={() => runSearch()}
            disabled={!query.trim()}
          >
            Search
          </button>
        </div>

        {/* Per-source progress (searching state) */}
        {searchState === 'searching' && (
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 20,
          }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 14 }}>
              Searching sources…
            </div>
            {SEARCH_SOURCES.map(src => {
              const isDisabled = !src.comingSoon && !src.browserOnly && !enabledSources.has(src.id)
              const dimColor = isDisabled || src.comingSoon || src.browserOnly ? 'var(--text-muted)' : src.color
              const barColor = isDisabled || src.comingSoon || src.browserOnly ? 'var(--border)' : src.color
              return (
                <div key={src.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9, opacity: isDisabled ? 0.45 : 1 }}>
                  <div style={{ width: 92, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: dimColor, flexShrink: 0 }}>
                    {src.icon} {src.name}
                  </div>
                  <div style={{ flex: 1, height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${sourceProg[src.id]}%`, background: barColor, borderRadius: 2, transition: 'width 0.3s ease' }} />
                  </div>
                  <span style={{ width: 84, fontSize: 10, textAlign: 'right', flexShrink: 0, color: 'var(--text-muted)' }}>
                    {src.browserOnly ? 'Browser only'
                      : src.comingSoon ? 'Coming soon'
                      : isDisabled ? 'Disabled'
                      : sourceProg[src.id] === 100 ? <span style={{ color: 'var(--accent-green)' }}>✓ Done</span>
                      : `${sourceProg[src.id]}%`}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Home state */}
        {searchState === 'idle' && (
          <div>

            {/* Trending */}
            <div style={{ marginBottom: 28 }}>
              <div className="sidebar-section-label" style={{ marginBottom: 12 }}>🔥 Trending</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {TRENDING_PILLS.map(t => (
                  <button
                    key={t.q}
                    className="btn-ghost"
                    style={{ borderRadius: 99, padding: '5px 14px', fontSize: 'var(--text-sm)' }}
                    onClick={() => runSearch(t.q)}
                  >
                    <span style={{ marginRight: 5 }}>{t.icon}</span>{t.q}
                  </button>
                ))}
              </div>
            </div>

            {/* GitHub open-source apps */}
            <div style={{ marginBottom: 28 }}>
              <div className="sidebar-section-label" style={{ marginBottom: 12 }}>⭐ GitHub Open-Source Apps</div>
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
                {githubPicks === null ? (
                  // Loading skeletons
                  Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} style={{
                      minWidth: 170, flexShrink: 0, borderRadius: 'var(--radius-md)',
                      padding: '10px 14px', background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                    }}>
                      <div style={{ width: '70%', height: 12, borderRadius: 4, background: 'var(--bg-elevated)', marginBottom: 6 }} />
                      <div style={{ width: '90%', height: 9, borderRadius: 4, background: 'var(--bg-elevated)', marginBottom: 4 }} />
                      <div style={{ width: '40%', height: 9, borderRadius: 4, background: 'var(--bg-elevated)' }} />
                    </div>
                  ))
                ) : githubPicks.length === 0 ? (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: '10px 0' }}>
                    Could not load GitHub picks
                  </div>
                ) : (
                  githubPicks.slice(0, 6).map(app => (
                    <button
                      key={app.full_name}
                      className="btn-ghost"
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left',
                        borderRadius: 'var(--radius-md)', padding: '10px 14px',
                        minWidth: 170, flexShrink: 0, fontFamily: 'inherit',
                      }}
                      onClick={() => runSearch(app.name)}
                    >
                      <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>⭐</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)',
                          color: 'var(--text-primary)', marginBottom: 2,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {app.name}
                        </div>
                        {app.description && (
                          <div style={{
                            fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35,
                            overflow: 'hidden', display: '-webkit-box',
                            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            maxWidth: 140,
                          }}>
                            {app.description}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: '#60a5fa', marginTop: 3 }}>
                          ★ {app.stars >= 1000 ? `${(app.stars / 1000).toFixed(1)}k` : app.stars}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Sources */}
            <div>
              <div className="sidebar-section-label" style={{ marginBottom: 12 }}>📦 Sources</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {SEARCH_SOURCES.map(src => {
                  const isEnabled = enabledSources.has(src.id)
                  return (
                    <div key={src.id} style={{
                      background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)', padding: 14,
                      opacity: src.comingSoon ? 0.5 : (src.browserOnly ? 0.75 : (!isEnabled ? 0.6 : 1)),
                      transition: 'opacity 0.15s',
                    }}>
                      {/* Header: icon+name left, toggle right */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{src.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: (src.comingSoon || src.browserOnly) ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                            {src.name}
                          </div>
                          {!src.comingSoon && !src.browserOnly && (
                            <div style={{ fontSize: 10, color: isEnabled ? src.color : 'var(--text-muted)' }}>
                              {isEnabled ? '● Live' : '○ Off'}
                            </div>
                          )}
                          {src.browserOnly && (
                            <div style={{ fontSize: 10, color: isEnabled ? 'var(--accent-teal)' : 'var(--text-muted)' }}>
                              {isEnabled ? '● Browser' : '○ Off'}
                            </div>
                          )}
                        </div>
                        <ToggleSwitch
                          checked={isEnabled}
                          disabled={src.comingSoon}
                          onChange={() => setEnabledSources(s => {
                            const n = new Set(s)
                            n.has(src.id) ? n.delete(src.id) : n.add(src.id)
                            return n
                          })}
                        />
                      </div>
                      {src.comingSoon ? (
                        <div style={{
                          display: 'inline-block', fontSize: 10, fontWeight: 'var(--font-bold)',
                          letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 4,
                          background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                          border: '1px solid var(--border-subtle)',
                        }}>
                          COMING SOON
                        </div>
                      ) : src.browserOnly ? (
                        <div>
                          <div style={{
                            display: 'inline-block', fontSize: 10, fontWeight: 'var(--font-bold)',
                            letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 4,
                            background: 'rgba(20,184,166,0.1)', color: 'var(--accent-teal)',
                            border: '1px solid rgba(20,184,166,0.25)', marginBottom: 4,
                          }}>
                            Browser Only
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Opens search results in browser</div>
                        </div>
                      ) : (
                        <>
                          <div style={{ background: 'var(--bg-elevated)', borderRadius: 2, height: 3, overflow: 'hidden', marginBottom: 5 }}>
                            <div style={{ height: '100%', width: `${src.trust}%`, background: isEnabled ? src.color : 'var(--border)', borderRadius: 2, transition: 'background 0.15s' }} />
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: isEnabled ? src.color : 'var(--text-muted)' }}>
                            {src.trust}% trusted
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

          </div>
        )}

        {/* No results */}
        {searchState === 'no_results' && (
          <div style={{ padding: '32px 0' }}>

            {/* Error box — shown when invoke threw or Rust returned an error string */}
            {searchError && (
              <div style={{
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 20,
                fontSize: 'var(--text-xs)', color: 'var(--accent-red)', fontFamily: 'monospace',
                wordBreak: 'break-all', whiteSpace: 'pre-wrap',
              }}>
                <div style={{ fontWeight: 'var(--font-bold)', marginBottom: 4, fontFamily: 'inherit' }}>
                  Search error — check the terminal for full debug output:
                </div>
                {searchError}
              </div>
            )}

            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)', marginBottom: 6 }}>
                No results found
              </div>
              {!searchError && (
                <>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Nothing found on F-Droid or GitHub for "{lastQuery.current}"
                  </div>
                  <div style={{
                    display: 'inline-block', marginBottom: 20,
                    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)', padding: '10px 16px',
                    fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', textAlign: 'left', maxWidth: 360,
                  }}>
                    <span style={{ color: 'var(--accent-teal)', fontWeight: 'var(--font-semibold)' }}>ℹ These sources only index open-source apps.</span>
                    {' '}Proprietary apps like YouTube, Spotify, and WhatsApp won't appear.
                    Try searching for <span style={{ color: 'var(--text-primary)' }}>VLC, NewPipe, Firefox, or Signal</span> instead.
                  </div>
                </>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 12 }}>
                {TRENDING_PILLS.map(t => (
                  <button key={t.q} className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', borderRadius: 99 }} onClick={() => runSearch(t.q)}>
                    {t.icon} {t.q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {searchState === 'results' && (
          <div>

            {/* Back button + source pill toggles */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <button
                className="btn-ghost"
                style={{ padding: '4px 10px', fontSize: 'var(--text-xs)', flexShrink: 0 }}
                onClick={() => { setSearchState('idle'); setResults([]); setQuery('') }}
              >
                ← Back
              </button>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {SEARCH_SOURCES.filter(s => !s.comingSoon).map(src => {
                  const on = enabledSources.has(src.id)
                  return (
                    <button
                      key={src.id}
                      onClick={() => setEnabledSources(s => {
                        const n = new Set(s)
                        n.has(src.id) ? n.delete(src.id) : n.add(src.id)
                        return n
                      })}
                      style={{
                        padding: '3px 10px', borderRadius: 99, fontSize: 11,
                        fontWeight: 'var(--font-semibold)', cursor: 'pointer',
                        fontFamily: 'inherit',
                        background: on ? `${src.color}1a` : 'transparent',
                        color: on ? src.color : 'var(--text-muted)',
                        border: `1px solid ${on ? src.color : 'var(--border)'}`,
                        transition: 'all 0.15s',
                      }}
                    >
                      {src.name}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Filter / sort bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {filtered.length} result{filtered.length !== 1 ? 's' : ''}
              </span>
              {SEARCH_SOURCES.filter(s => !s.comingSoon && enabledSources.has(s.id)).map(({ id: src }) => {
                const count = results.filter(r => r.source === src).length
                if (!count) return null
                const badge = SOURCE_BADGE[src]
                return (
                  <span key={src} style={{
                    fontSize: 10, fontWeight: 'var(--font-semibold)', padding: '2px 7px',
                    borderRadius: 3, background: badge.bg, color: badge.color,
                  }}>
                    {badge.label}: {count}
                  </span>
                )
              })}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectStyle}>
                  <option value="all">All Sources</option>
                  {SEARCH_SOURCES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={archFilter} onChange={e => setArchFilter(e.target.value)} style={selectStyle}>
                  <option value="all">All Arch</option>
                  <option value="arm64-v8a">arm64-v8a</option>
                  <option value="armeabi-v7a">armeabi-v7a</option>
                </select>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
                  <option value="relevance">Relevance</option>
                  <option value="date">Newest</option>
                </select>
              </div>
            </div>

            {/* Result cards */}
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                No results match the current filters.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filtered.map(apk => {
                const badge        = SOURCE_BADGE[apk.source]
                const instState    = installing[apk.id]
                const inProgress   = instState === 'downloading' || instState === 'installing'
                const canInstall   = !!apk.apkUrl
                const dp           = dlProgress[apk.id]
                const isBrowserOnly = BROWSER_ONLY_SOURCES.has(apk.source)

                return (
                  <div key={apk.id} style={{
                    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)', padding: '14px 16px',
                    display: 'flex', gap: 14, alignItems: 'flex-start',
                  }}>
                    {/* App icon placeholder */}
                    <div style={{
                      width: 46, height: 46, borderRadius: 10,
                      background: 'var(--bg-elevated)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 22, flexShrink: 0, color: 'var(--text-muted)',
                    }}>
                      📦
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                          {apk.name}
                        </span>
                        {apk.verified && (
                          <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', padding: '1px 5px', borderRadius: 3, background: 'rgba(34,197,94,0.12)', color: 'var(--accent-green)', letterSpacing: '0.04em' }}>
                            ✓ VERIFIED
                          </span>
                        )}
                        {badge && (
                          <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', padding: '1px 5px', borderRadius: 3, background: badge.bg, color: badge.color, letterSpacing: '0.04em' }}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {apk.pkg}
                      </div>
                      {apk.summary && (
                        <div style={{
                          fontSize: 'var(--text-xs)', color: 'var(--text-primary)', opacity: 0.75, marginBottom: 6,
                          overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }}>
                          {apk.summary}
                        </div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-teal)', fontFamily: 'monospace' }}>
                          v{apk.version}
                        </span>
                        {apk.date && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{apk.date}</span>
                        )}
                        {apk.arch.map(a => (
                          <span key={a} style={{ fontSize: 10, fontWeight: 'var(--font-semibold)', padding: '1px 6px', borderRadius: 3, background: 'rgba(6,182,212,0.1)', color: 'var(--accent-teal)' }}>
                            {a}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flexShrink: 0 }}>
                      {isBrowserOnly ? (
                        <div>
                          <button
                            className="btn-ghost"
                            style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', minWidth: 128, width: '100%' }}
                            onClick={() => openUrl(apk.pageUrl || apk.apkUrl || '')}
                            disabled={!apk.pageUrl && !apk.apkUrl}
                          >
                            Open in Browser →
                          </button>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center', maxWidth: 128 }}>
                            Direct download not available — opens in browser
                          </div>
                        </div>
                      ) : (
                        <div>
                          <button
                            className={instState === 'done' ? 'btn-ghost' : canInstall ? 'btn-success' : 'btn-ghost'}
                            style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', minWidth: 128, width: '100%' }}
                            disabled={!canInstall || inProgress || instState === 'done'}
                            onClick={() => installResult(apk)}
                          >
                            {instState === 'downloading'
                              ? (dp
                                  ? `Downloading… ${dp.percent}%${dp.speed ? ` · ${dp.speed}` : ''}${dp.received && dp.total ? ` · ${dp.received}/${dp.total}` : ''}`
                                  : 'Downloading…')
                              : instState === 'installing' ? 'Installing…'
                              : instState === 'done'  ? '✓ Installed'
                              : instState === 'error' ? '✗ Failed — Retry'
                              : '⚡ Install Latest'}
                          </button>
                          {inProgress && (
                            <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                              {instState === 'downloading' && dp?.percent > 0 ? (
                                <div style={{
                                  height: '100%', borderRadius: 2,
                                  background: 'var(--accent)',
                                  width: `${dp.percent}%`,
                                  transition: 'width 0.4s ease-out',
                                }} />
                              ) : (
                                <div style={{
                                  height: '100%', borderRadius: 2,
                                  background: instState === 'installing' ? 'var(--accent-teal)' : 'var(--accent)',
                                  animation: 'progress-indeterminate 1.4s ease-in-out infinite',
                                  width: '40%',
                                }} />
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {!isBrowserOnly && (
                        <button
                          className="btn-ghost"
                          style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', minWidth: 128 }}
                          onClick={() => {
                            if (!apk.apkUrl) { addToast('No download URL available', 'error'); return }
                            if (queuedPaths.has(apk.apkUrl)) { addToast('Already in queue', 'error'); return }
                            const item = { id: crypto.randomUUID(), name: `${apk.pkg}.apk`, path: apk.apkUrl, status: 'pending' }
                            onAddToQueue?.(item)
                            setQueuedPaths(s => new Set([...s, apk.apkUrl]))
                            addToast('Added to Install APK queue', 'success')
                          }}
                        >
                          + Add to Queue
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

          </div>
        )}

      </div>
    </div>
  )
}

// ── ADB Logs panel ────────────────────────────────────────────────────────────

const QUICK_CMDS = [
  { label: 'Device Model',    cmd: 'getprop ro.product.model',          cat: 'device' },
  { label: 'Android Version', cmd: 'getprop ro.build.version.release',  cat: 'device' },
  { label: 'SDK Level',       cmd: 'getprop ro.build.version.sdk',      cat: 'device' },
  { label: 'Battery',         cmd: 'dumpsys battery',                   cat: 'device' },
  { label: 'Screen Size',     cmd: 'wm size',                           cat: 'device' },
  { label: 'Screen Density',  cmd: 'wm density',                        cat: 'device' },
  { label: 'All Packages',    cmd: 'pm list packages',                  cat: 'pkg'    },
  { label: '3rd-Party Pkgs',  cmd: 'pm list packages -3',               cat: 'pkg'    },
  { label: 'Running Procs',   cmd: 'ps -A | head -30',                  cat: 'sys'    },
  { label: 'Disk Usage',      cmd: 'df -h',                             cat: 'sys'    },
  { label: 'Memory Info',     cmd: 'cat /proc/meminfo',                 cat: 'sys'    },
  { label: 'IP Address',      cmd: 'ip addr show',                      cat: 'net'    },
  { label: 'Active Sockets',  cmd: 'ss -tulpn 2>/dev/null || netstat',  cat: 'net'    },
  { label: 'Enable Wi-Fi ADB',cmd: 'tcpip 5555',                        cat: 'net'    },
]

const DEFAULT_FAVORITES = [
  'pm list packages -3',
  'getprop ro.build.version.release',
  'dumpsys battery',
  'df -h',
]

const QCMD_CAT = {
  device: { label: 'Device',   bg: 'rgba(6,182,212,0.10)',   color: 'var(--accent-teal)'   },
  pkg:    { label: 'Packages', bg: 'rgba(168,85,247,0.10)',  color: 'var(--accent)'        },
  sys:    { label: 'System',   bg: 'rgba(239,68,68,0.10)',   color: 'var(--accent-red)'    },
  net:    { label: 'Network',  bg: 'rgba(34,197,94,0.10)',   color: 'var(--accent-green)'  },
}

const LC_LEVEL = {
  V: { label: 'Verbose', color: 'var(--text-muted)'    },
  D: { label: 'Debug',   color: '#93c5fd'              },
  I: { label: 'Info',    color: 'var(--accent-green)'  },
  W: { label: 'Warn',    color: 'var(--accent-yellow)' },
  E: { label: 'Error',   color: 'var(--accent-red)'    },
}

function parseLsOutput(output) {
  return output.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('total'))
    .map(l => {
      const parts = l.split(/\s+/)
      if (parts.length < 8) return null
      const perms = parts[0]
      const month = parts[5]
      const day = parts[6]
      const yearOrTime = parts[7]
      const dateInfo = parseLsDateToken(month, day, yearOrTime)
      // Strip symlink target: "name -> /target" → "name"
      const rawName = parts.slice(8).join(' ') || parts.slice(7).join(' ')
      const name = rawName.replace(/\s+->\s+.*$/, '').trim()
      if (!name || name === '.' || name === '..' || name === '?') return null
      const bytes = parseInt(parts[4]) || 0
      let size = ''
      if (bytes > 0) {
        if (bytes < 1024) size = `${bytes} B`
        else if (bytes < 1024 * 1024) size = `${(bytes / 1024).toFixed(1)} KB`
        else size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      }
      let type
      if (perms[0] === 'd') type = 'dir'
      else if (perms[0] === 'l') type = 'symlink'
      else type = 'file'
      return { type, name, size, perms, mtime: dateInfo.mtime, mtimeLabel: dateInfo.label }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aIsDir = a.type !== 'file'
      const bIsDir = b.type !== 'file'
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

function parseLogcatLine(line) {
  const m = line.match(/^([VDIWEF])\/(.+?)\(\s*\d+\):\s*(.*)$/)
  if (m) return { level: m[1], tag: m[2].trim().slice(0, 22), msg: m[3] }
  if (line.trim()) return { level: 'V', tag: 'logcat', msg: line.trim() }
  return null
}

function parseForwardList(output) {
  return output.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const p = l.split(/\s+/)
    if (p.length < 3) return null
    const lm = p[1].match(/^(tcp|udp|localabstract):(.+)$/)
    const rm = p[2].match(/^(tcp|udp|localabstract):(.+)$/)
    if (!lm || !rm) return null
    return { type: lm[1], local: lm[2], remote: rm[2] }
  }).filter(Boolean)
}

function LogSection({ title, dot, open, onToggle, children }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
          padding: '11px 0', userSelect: 'none', borderBottom: open ? '1px solid var(--border-subtle)' : 'none',
        }}
      >
        <span style={{
          fontSize: 9, color: 'var(--text-muted)', flexShrink: 0,
          display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
        }}>▶</span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: open ? dot : 'var(--border)', flexShrink: 0, transition: 'background 0.15s' }} />
        <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', flex: 1 }}>
          {title}
        </span>
      </div>
      {open && <div style={{ paddingTop: 14, paddingBottom: 8 }}>{children}</div>}
    </div>
  )
}

const terminalStyle = {
  background: 'var(--terminal-bg)', border: '1px solid var(--terminal-border)',
  borderRadius: 'var(--radius-md)', padding: '10px 12px',
  fontFamily: "'JetBrains Mono','Courier New',monospace", fontSize: 11,
  color: 'var(--terminal-text)',
  lineHeight: 1.7, overflowY: 'auto',
}
const shellLineColor = { prompt: '#a855f7', out: 'var(--terminal-text)', err: '#f87171', ok: 'var(--terminal-text)' }

const tableThStyle = {
  textAlign: 'left', fontSize: 10, fontWeight: 'var(--font-bold)',
  letterSpacing: '0.08em', color: 'var(--text-muted)',
  textTransform: 'uppercase', padding: '0 10px 8px',
}
const tableTdStyle = { padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }

function AdbLogsPanel({ device, onNavigateToDevices, platform }) {
  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'
  const isAndroid = platform === 'android'

  // Section collapse state
  const [open, setOpen] = useState({ shell: true, ports: true, logcat: true })
  function toggle(k) { setOpen(o => ({ ...o, [k]: !o[k] })) }

  // ── Shell terminal ──
  const [shellLines, setShellLines]     = useState([{ cls: 'ok', text: 'Android Toolkit ADB Shell' }, { cls: 'prompt', text: '$ ' }])
  const [shellInput, setShellInput]     = useState('')
  const [shellHistory, setShellHistory] = useState([])
  const [histIdx, setHistIdx]           = useState(-1)
  const [termTab, setTermTab]           = useState('shell') // shell | quick | favorites
  const [favorites, setFavorites]       = useState(DEFAULT_FAVORITES)
  const androidShellFavorites           = favorites.filter(f => !f.startsWith('tcpip '))
  const shellRef   = useRef(null)
  const shellInRef = useRef(null)

  useEffect(() => {
    if (shellRef.current) shellRef.current.scrollTop = shellRef.current.scrollHeight
  }, [shellLines])

  function addShellLine(cls, text) {
    setShellLines(l => [...l.slice(-800), { cls, text }])
  }

  async function runCmd(input) {
    const c = (input ?? shellInput).trim()
    if (!c) return
    setShellHistory(h => [...h, c])
    setHistIdx(-1)
    setShellInput('')
    addShellLine('prompt', `$ ${c}`)

    if (!serial) {
      addShellLine('err', 'No device connected.')
      addShellLine('prompt', '$ ')
      return
    }

    // If user typed "adb <args>" strip the prefix; otherwise run as shell command
    let args
    if (c.startsWith('adb ')) {
      args = ['-s', serial, ...c.slice(4).trim().split(/\s+/)]
    } else {
      args = ['-s', serial, 'shell', ...c.split(/\s+/)]
    }

    try {
      const res = await invoke('run_adb', { args })
      const out = (res.stdout?.trim() || res.stderr?.trim() || '(no output)')
      out.split('\n').forEach(line => addShellLine(res.ok ? 'out' : 'err', line))
    } catch (e) {
      addShellLine('err', String(e))
    }
    addShellLine('prompt', '$ ')
    setTimeout(() => shellInRef.current?.focus(), 50)
  }

  function onShellKey(e) {
    if (e.key === 'Enter') { runCmd(); return }
    if (e.key === 'ArrowUp') {
      const i = Math.min(histIdx + 1, shellHistory.length - 1)
      setHistIdx(i)
      setShellInput(shellHistory[shellHistory.length - 1 - i] || '')
    }
    if (e.key === 'ArrowDown') {
      const i = Math.max(histIdx - 1, -1)
      setHistIdx(i)
      setShellInput(i < 0 ? '' : shellHistory[shellHistory.length - 1 - i])
    }
  }

  // ── Port forwarding ──
  const [portRules, setPortRules] = useState([])
  const [pfType, setPfType]       = useState('tcp')
  const [pfLocal, setPfLocal]     = useState('')
  const [pfRemote, setPfRemote]   = useState('')
  const [loadingPorts, setLoadingPorts] = useState(false)

  const refreshPorts = useCallback(async () => {
    if (!serial) return
    setLoadingPorts(true)
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, 'forward', '--list'] })
      setPortRules(parseForwardList(res.stdout ?? ''))
    } catch { /* ignore */ }
    setLoadingPorts(false)
  }, [serial])

  useEffect(() => { if (serial && open.ports) refreshPorts() }, [serial, open.ports, refreshPorts])

  async function addPortRule() {
    if (!pfLocal || !pfRemote) return
    if (serial) {
      const res = await invoke('run_adb', { args: ['-s', serial, 'forward', `${pfType}:${pfLocal}`, `${pfType}:${pfRemote}`] })
      if (!res.ok && res.stderr) return
    }
    setPortRules(p => [...p, { type: pfType, local: pfLocal, remote: pfRemote }])
    setPfLocal(''); setPfRemote('')
  }

  async function removePortRule(rule) {
    if (serial) await invoke('run_adb', { args: ['-s', serial, 'forward', '--remove', `${rule.type}:${rule.local}`] })
    setPortRules(p => p.filter(r => r !== rule))
  }

  async function clearAllPorts() {
    if (serial) await invoke('run_adb', { args: ['-s', serial, 'forward', '--remove-all'] })
    setPortRules([])
  }

  // ── Logcat ──
  const [logcatEntries, setLogcatEntries] = useState([])
  const [activeLevels, setActiveLevels]   = useState(new Set(['V', 'D', 'I', 'W', 'E']))
  const [lcFilter, setLcFilter]           = useState('')
  const [lcStreaming, setLcStreaming]      = useState(false)
  const logcatRef  = useRef(null)
  const unlistenRef = useRef(null)

  useEffect(() => {
    if (logcatRef.current) logcatRef.current.scrollTop = logcatRef.current.scrollHeight
  }, [logcatEntries])

  // Stop streaming on unmount
  useEffect(() => () => {
    if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    invoke('stop_logcat').catch(() => {})
  }, [])

  async function toggleLogcat() {
    if (lcStreaming) {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
      await invoke('stop_logcat')
      setLcStreaming(false)
    } else {
      if (!serial) return
      const unlisten = await listen('logcat:line', ({ payload }) => {
        const parsed = parseLogcatLine(payload)
        if (parsed) setLogcatEntries(e => {
          const next = [...e, parsed]
          return next.length > 2000 ? next.slice(-2000) : next
        })
      })
      unlistenRef.current = unlisten
      await invoke('start_logcat', { serial })
      setLcStreaming(true)
    }
  }

  const filteredLc = logcatEntries.filter(e =>
    activeLevels.has(e.level) &&
    (!lcFilter || e.tag.toLowerCase().includes(lcFilter.toLowerCase()) || e.msg.toLowerCase().includes(lcFilter.toLowerCase()))
  )

  const inputStyle = {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)', padding: '6px 10px', outline: 'none',
    color: 'var(--text-primary)', fontSize: 'var(--text-xs)', fontFamily: 'inherit',
  }

  return (
    <div className="panel-content">

      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">{isAndroid ? 'Shell & Logs' : 'ADB &amp; Shell'}</h1>
        </div>
        {noDevice && (
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={onNavigateToDevices}>
            Connect Device
          </button>
        )}
      </div>

      <div className="panel-scroll">

        {isAndroid && (
          <div style={{
            background: 'linear-gradient(135deg, rgba(20,184,166,0.08), rgba(168,85,247,0.05))',
            border: '1px solid rgba(20,184,166,0.2)',
            borderRadius: 'var(--radius-lg)',
            padding: '16px 16px',
            marginBottom: 18,
          }}>
            <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
              On-device shell tools
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Use this screen for local shell commands, saved commands, and live logs from the Android device running Android Toolkit.
            </div>
          </div>
        )}

        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected — commands will be disabled</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
              View Devices
            </button>
          </div>
        )}

        {/* ── Shell Terminal ── */}
        <LogSection title={isAndroid ? 'Shell Terminal' : 'ADB Shell Terminal'} dot="var(--accent)" open={open.shell} onToggle={() => toggle('shell')}>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 12, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: 3, width: 'fit-content' }}>
            {[['shell', 'Shell'], ['quick', 'Quick Commands'], ['favorites', 'Favorites']].map(([id, label]) => (
              <button key={id} onClick={() => setTermTab(id)} style={{
                padding: isAndroid ? '7px 14px' : '4px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
                fontSize: isAndroid ? 13 : 'var(--text-xs)', fontWeight: 'var(--font-semibold)', fontFamily: 'inherit',
                background: termTab === id ? 'var(--bg-surface)' : 'transparent',
                color: termTab === id ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'background 0.12s, color 0.12s',
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* Shell tab */}
          {termTab === 'shell' && (
            <div>
              <div ref={shellRef} style={{ ...terminalStyle, height: isAndroid ? 260 : 220, marginBottom: 8, fontSize: isAndroid ? 12 : 11 }}>
                {shellLines.map((l, i) => (
                  <div key={i} style={{ color: shellLineColor[l.cls] ?? 'var(--terminal-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {l.text}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{
                  flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', padding: '0 10px',
                  fontFamily: "'JetBrains Mono','Courier New',monospace",
                }}>
                  <span style={{ color: 'var(--accent)', fontSize: 11 }}>$</span>
                  <input
                    ref={shellInRef}
                    type="text"
                    value={shellInput}
                    onChange={e => setShellInput(e.target.value)}
                    onKeyDown={onShellKey}
                    placeholder="enter command…"
                    disabled={noDevice}
                    style={{
                      flex: 1, background: 'transparent', border: 'none', outline: 'none',
                      color: 'var(--text-primary)', fontSize: isAndroid ? 13 : 11, padding: '8px 0',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>
                <button
                  className="btn-primary"
                  style={{ padding: isAndroid ? '0 18px' : '0 16px', fontSize: isAndroid ? 13 : 'var(--text-xs)', flexShrink: 0 }}
                  disabled={noDevice || !shellInput.trim()}
                  onClick={() => runCmd()}
                >
                  Run
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: isAndroid ? '0 14px' : '0 12px', fontSize: isAndroid ? 13 : 'var(--text-xs)', flexShrink: 0 }}
                  onClick={() => setShellLines([{ cls: 'ok', text: 'Android Toolkit ADB Shell' }, { cls: 'prompt', text: '$ ' }])}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Quick Commands tab */}
          {termTab === 'quick' && (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isAndroid ? 190 : 170}px, 1fr))`, gap: 8 }}>
              {QUICK_CMDS.filter(qc => !isAndroid || qc.cmd !== 'tcpip 5555').map((qc, i) => {
                const cat = QCMD_CAT[qc.cat]
                return (
                  <button
                    key={i}
                    disabled={noDevice}
                    onClick={() => { runCmd(qc.cmd); setTermTab('shell') }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      gap: 5, background: cat.bg, border: '1px solid transparent',
                      borderRadius: 'var(--radius-sm)', padding: isAndroid ? '12px 14px' : '9px 12px',
                      cursor: noDevice ? 'not-allowed' : 'pointer', textAlign: 'left',
                      fontFamily: 'inherit', opacity: noDevice ? 0.5 : 1,
                      transition: 'border-color 0.12s',
                    }}
                    onMouseEnter={e => !noDevice && (e.currentTarget.style.borderColor = cat.color)}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}
                  >
                    <span style={{ fontSize: isAndroid ? 14 : 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
                      {qc.label}
                    </span>
                    <span style={{ fontSize: isAndroid ? 11 : 10, fontFamily: "'JetBrains Mono','Courier New',monospace", color: cat.color, wordBreak: 'break-all' }}>
                      {qc.cmd}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Favorites tab */}
          {termTab === 'favorites' && (
            <div>
              <div style={{ fontSize: isAndroid ? 13 : 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 12 }}>
                Click to run. Add commands with the shell.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {androidShellFavorites.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <button
                      disabled={noDevice}
                      onClick={() => { runCmd(f); setTermTab('shell') }}
                      style={{
                        background: 'none', border: 'none', cursor: noDevice ? 'not-allowed' : 'pointer',
                        color: 'var(--text-secondary)', fontSize: isAndroid ? 12 : 11,
                        fontFamily: "'JetBrains Mono','Courier New',monospace",
                        padding: isAndroid ? '7px 12px' : '5px 10px', fontWeight: 'var(--font-semibold)',
                        opacity: noDevice ? 0.5 : 1,
                      }}
                    >
                      $ {f}
                    </button>
                    <button
                      onClick={() => setFavorites(favs => favs.filter((_, j) => j !== i))}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: 13, padding: isAndroid ? '7px 10px' : '5px 8px',
                        borderLeft: '1px solid var(--border-subtle)',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {androidShellFavorites.length === 0 && (
                  <span style={{ fontSize: isAndroid ? 13 : 'var(--text-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No favorites yet.
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <input
                  type="text"
                  id="fav-input"
                  placeholder="Command to save…"
                  style={{ ...inputStyle, flex: 1, fontSize: isAndroid ? 13 : 'var(--text-xs)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      setFavorites(f => [...f, e.target.value.trim()])
                      e.target.value = ''
                    }
                  }}
                />
                <button
                  className="btn-ghost"
                  style={{ padding: '0 14px', fontSize: isAndroid ? 13 : 'var(--text-xs)', flexShrink: 0 }}
                  onClick={() => {
                    const inp = document.getElementById('fav-input')
                    if (inp?.value.trim()) {
                      setFavorites(f => [...f, inp.value.trim()])
                      inp.value = ''
                    }
                  }}
                >
                  + Save
                </button>
              </div>
            </div>
          )}
        </LogSection>

        {/* ── Port Forwarding ── */}
        {!isAndroid && (
        <LogSection title="Port Forwarding" dot="var(--accent)" open={open.ports} onToggle={() => toggle('ports')}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)', marginBottom: 12 }}>
            <thead>
              <tr>
                {['Type', 'Local', 'Remote', 'Status', ''].map(h => (
                  <th key={h} style={tableThStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {portRules.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...tableTdStyle, color: 'var(--text-muted)' }}>
                    {loadingPorts ? 'Loading…' : 'No forwarding rules.'}
                  </td>
                </tr>
              )}
              {portRules.map((r, i) => (
                <tr key={i}>
                  <td style={tableTdStyle}>
                    <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', padding: '2px 7px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', color: 'var(--accent)' }}>
                      {r.type}
                    </span>
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--accent-teal)' }}>{r.local}</td>
                  <td style={{ ...tableTdStyle, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--accent-teal)' }}>{r.remote}</td>
                  <td style={tableTdStyle}>
                    <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', padding: '2px 7px', borderRadius: 99, background: 'rgba(34,197,94,0.12)', color: 'var(--accent-green)' }}>
                      active
                    </span>
                  </td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                    <button
                      className="btn-danger"
                      style={{ padding: '2px 8px', fontSize: 10 }}
                      onClick={() => removePortRule(r)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={pfType}
              onChange={e => setPfType(e.target.value)}
              style={{ ...inputStyle, width: 120 }}
            >
              <option>tcp</option>
              <option>udp</option>
              <option>localabstract</option>
            </select>
            <input type="text" value={pfLocal} onChange={e => setPfLocal(e.target.value)} placeholder="Local port" style={{ ...inputStyle, width: 110 }} />
            <input type="text" value={pfRemote} onChange={e => setPfRemote(e.target.value)} placeholder="Remote port" style={{ ...inputStyle, width: 110 }}
              onKeyDown={e => e.key === 'Enter' && addPortRule()}
            />
            <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', flexShrink: 0 }} disabled={noDevice || !pfLocal || !pfRemote} onClick={addPortRule}>
              + Add
            </button>
            <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={clearAllPorts}>
              Clear All
            </button>
            <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: 'var(--text-xs)', flexShrink: 0, marginLeft: 'auto' }} onClick={refreshPorts} disabled={loadingPorts}>
              ↺ Refresh
            </button>
          </div>
        </LogSection>
        )}

        {/* ── Logcat Viewer ── */}
        <LogSection title="Logcat Viewer" dot="var(--accent-green)" open={open.logcat} onToggle={() => toggle('logcat')}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {Object.entries(LC_LEVEL).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setActiveLevels(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })}
                  style={{
                    padding: isAndroid ? '6px 10px' : '3px 9px', borderRadius: 5, fontSize: isAndroid ? 12 : 11, fontWeight: 'var(--font-bold)',
                    cursor: 'pointer', background: `${v.color}20`, color: v.color,
                    border: `1px solid ${activeLevels.has(k) ? v.color : 'transparent'}`,
                    fontFamily: 'inherit',
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <input
              value={lcFilter}
              onChange={e => setLcFilter(e.target.value)}
              placeholder="Filter by tag or message…"
              style={{ ...inputStyle, flex: 1, minWidth: 120, fontSize: isAndroid ? 13 : 'var(--text-xs)' }}
            />
            <button className="btn-ghost" style={{ padding: isAndroid ? '7px 12px' : '5px 12px', fontSize: isAndroid ? 13 : 'var(--text-xs)', flexShrink: 0 }} onClick={() => setLogcatEntries([])}>
              Clear
            </button>
            <button
              className={lcStreaming ? 'btn-danger' : 'btn-success'}
              style={{ padding: isAndroid ? '7px 14px' : '5px 14px', fontSize: isAndroid ? 13 : 'var(--text-xs)', flexShrink: 0 }}
              disabled={noDevice && !lcStreaming}
              onClick={toggleLogcat}
            >
              {lcStreaming ? '⏹ Stop' : '▶ Stream'}
            </button>
          </div>

          {/* Log output */}
          <div
            ref={logcatRef}
            style={{ ...terminalStyle, height: isAndroid ? 300 : 240, fontSize: isAndroid ? 12 : 11 }}
          >
            {filteredLc.length === 0 && (
              <div style={{ color: 'var(--terminal-text)', opacity: 0.5 }}>
                {lcStreaming ? 'Waiting for logcat output…' : 'Press Stream to start.'}
              </div>
            )}
            {filteredLc.map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: 'var(--accent-teal)', minWidth: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.tag}
                </span>
                <span style={{ color: LC_LEVEL[e.level]?.color ?? 'var(--text-secondary)' }}>
                  [{e.level}] {e.msg}
                </span>
              </div>
            ))}
          </div>
          {logcatEntries.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
              {logcatEntries.length.toLocaleString()} entries{logcatEntries.length >= 2000 ? ' (capped at 2000)' : ''}
            </div>
          )}
        </LogSection>

      </div>
    </div>
  )
}

// ── App Stores panel ──────────────────────────────────────────────────────────

const APP_STORES = [
  {
    id: 'fdroid', name: 'F-Droid', icon: '🟢',
    tagline: 'Free & Open Source Android Apps',
    trust: 'Most Trusted', category: 'privacy',
    pkg: 'org.fdroid.fdroid',
    apkUrl: 'https://f-droid.org/F-Droid.apk',
    tags: ['Privacy', 'FOSS', 'No Ads', 'No Tracking'],
    badge: 'RECOMMENDED', installType: 'direct',
  },
  {
    id: 'aurora', name: 'Aurora Store', icon: '🔵',
    tagline: 'Play Store without Google',
    trust: 'Highly Trusted', category: 'privacy',
    pkg: 'com.aurora.store',
    apkUrl: 'https://f-droid.org/repo/com.aurora.store_73.apk',
    tags: ['Play Store Mirror', 'No Google', 'Anonymous'],
    badge: 'POPULAR', installType: 'direct',
  },
  {
    id: 'aptoide', name: 'Aptoide', icon: '🟡',
    tagline: 'Largest independent Android market',
    trust: 'Trusted', category: 'general',
    pkg: 'cm.aptoide.pt',
    apkUrl: 'https://pool.apk.aptoide.com/carolyne-silva/cm-aptoide-pt-12060-71289867-2725e9ae81839a4ae69f8f362fc4d7e1.apk',
    tags: ['Large Library', 'Decentralized', 'Region-Free'],
    badge: null, installType: 'direct',
  },
  {
    id: 'apkpure', name: 'APKPure', icon: '🔵',
    tagline: 'Bypass region restrictions',
    trust: 'Trusted', category: 'general',
    pkg: 'com.apkpure.aegon',
    apkUrl: 'https://d.apkpure.net/b/APK/com.apkpure.aegon?version=latest',
    tags: ['Region-Free', 'Fast Updates'],
    badge: null, installType: 'direct',
  },
  {
    id: 'uptodown', name: 'Uptodown', icon: '⬇️',
    tagline: 'Safe downloads with malware scanning',
    trust: 'Highly Trusted', category: 'general',
    pkg: 'com.uptodown',
    apkUrl: 'https://d.apkpure.net/b/APK/com.uptodown?version=latest',
    tags: ['Malware Scanning', 'Safe', 'Multi-Platform'],
    badge: null, installType: 'direct',
  },
  {
    id: 'taptap', name: 'TapTap', icon: '🎮',
    tagline: 'Gaming-focused app store',
    trust: 'Good', category: 'gaming',
    pkg: 'com.taptap.global',
    apkUrl: 'https://d.tap.io/latest/organic-direct_mobile',
    tags: ['Games Only', 'Early Access'],
    badge: 'GAMING', installType: 'direct',
  },
  {
    id: 'epic', name: 'Epic Games', icon: '🎯',
    tagline: 'Free games every week',
    trust: 'Trusted', category: 'gaming',
    pkg: 'com.epicgames.portal',
    browserUrl: 'https://store.epicgames.com/en-US/mobile/android',
    tags: ['Free Games', 'Premium Titles'],
    badge: null, installType: 'browser',
  },
  {
    id: 'galaxy', name: 'Galaxy Store', icon: '⭐',
    tagline: 'Samsung-optimized apps',
    trust: 'Highly Trusted', category: 'oem',
    pkg: 'com.sec.android.app.samsungapps',
    tags: ['Samsung Only', 'Official'],
    badge: null, installType: 'preinstalled',
  },
  {
    id: 'apkmirror', name: 'APKMirror', icon: '🔴',
    tagline: 'Trusted APK archive',
    trust: 'Most Trusted', category: 'general',
    pkg: 'com.apkmirror.helper.prod',
    browserUrl: 'https://www.apkmirror.com/apk/apkmirror/apkmirror-installer-official/',
    tags: ['Trusted', 'Version Archive'],
    badge: 'TRUSTED', installType: 'browser',
  },
]

const STORE_CATEGORIES = [
  { id: 'all',     label: 'All'     },
  { id: 'privacy', label: 'Privacy' },
  { id: 'general', label: 'General' },
  { id: 'gaming',  label: 'Gaming'  },
  { id: 'oem',     label: 'OEM'     },
  { id: 'utility', label: 'Utility' },
]

const TRUST_CONFIG = {
  'Most Trusted':   { color: 'var(--accent-green)',  pct: 99 },
  'Highly Trusted': { color: 'var(--accent-teal)',   pct: 85 },
  'Trusted':        { color: 'var(--accent-yellow)', pct: 70 },
  'Good':           { color: 'var(--accent-yellow)', pct: 55 },
}

// ── Advanced panel ────────────────────────────────────────────────────────────

const ADV_REBOOT_MODES = [
  { icon: '🔄', label: 'Normal',     args: s => ['-s', s, 'reboot'],                       danger: false },
  { icon: '🛠️', label: 'Recovery',   args: s => ['-s', s, 'reboot', 'recovery'],           danger: false },
  { icon: '⚙️', label: 'Bootloader', args: s => ['-s', s, 'reboot', 'bootloader'],         danger: false },
  { icon: '⚡', label: 'Fastboot',   args: s => ['-s', s, 'reboot', 'fastboot'],           danger: false },
  { icon: '📦', label: 'Sideload',   args: s => ['-s', s, 'reboot', 'sideload'],           danger: false },
  { icon: '⏻',  label: 'Power Off',  args: s => ['-s', s, 'shell', 'reboot', '-p'],        danger: true  },
]

const ADV_QUICK_CATS = {
  info:   { label: 'Device Info', color: 'var(--accent-teal)'  },
  screen: { label: 'Screen',      color: 'var(--accent)'       },
  net:    { label: 'Network',     color: 'var(--accent-green)' },
}

const ADV_QUICK_CMDS = [
  { icon: '📋', label: 'All Props',      cat: 'info',   args: s => ['-s', s, 'shell', 'getprop'] },
  { icon: '🔋', label: 'Battery Info',   cat: 'info',   args: s => ['-s', s, 'shell', 'dumpsys', 'battery'] },
  { icon: '💾', label: 'Memory Info',    cat: 'info',   args: s => ['-s', s, 'shell', 'cat', '/proc/meminfo'] },
  { icon: '⚙️', label: 'CPU Info',       cat: 'info',   args: s => ['-s', s, 'shell', 'cat', '/proc/cpuinfo'] },
  { icon: '💿', label: 'Disk Usage',     cat: 'info',   args: s => ['-s', s, 'shell', 'df', '-h'] },
  { icon: '⚡', label: 'Processes',      cat: 'info',   args: s => ['-s', s, 'shell', 'ps'] },
  { icon: '📸', label: 'Screenshot',     cat: 'screen', args: null },
  { icon: '🎬', label: 'Record 10s',     cat: 'screen', args: null },
  { icon: '☀️', label: 'Keep Screen On', cat: 'screen', args: s => ['-s', s, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '2147483647'] },
  { icon: '⏱️', label: 'Reset Timeout',  cat: 'screen', args: s => ['-s', s, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '60000'] },
  { icon: '🌐', label: 'Show IP',        cat: 'net',    args: s => ['-s', s, 'shell', 'ip', 'addr', 'show', 'wlan0'] },
  { icon: '📶', label: 'WiFi Info',      cat: 'net',    args: s => ['-s', s, 'shell', 'dumpsys', 'wifi'] },
  { icon: '✅', label: 'Enable WiFi',    cat: 'net',    args: s => ['-s', s, 'shell', 'svc', 'wifi', 'enable'] },
  { icon: '🚫', label: 'Disable WiFi',   cat: 'net',    args: s => ['-s', s, 'shell', 'svc', 'wifi', 'disable'] },
]

function DebloatWorkbench({
  serial,
  noDevice,
  running,
  setRunning,
  append,
  deviceProps,
  device,
  filterPresets = DEBLOAT_FILTER_PRESETS,
  description = 'Manufacturer-aware debloat GUI with analysis, selection, and batch actions. Safe guidance adjusts for the connected device when possible.',
}) {
  const [pkgSearch, setPkgSearch] = useState('')
  const [packages, setPackages] = useState([])
  const [pkgLoading, setPkgLoading] = useState(false)
  const [pkgTypeFilter, setPkgTypeFilter] = useState('all')
  const [pkgRecFilter, setPkgRecFilter] = useState('all')
  const [selectedPkgs, setSelectedPkgs] = useState([])
  const [focusedPkg, setFocusedPkg] = useState(null)
  const manufacturerHint = deviceProps?.manufacturer || ''
  const modelHint = deviceProps?.hwModel || device?.model || ''

  async function loadPackages() {
    if (noDevice || running) return
    setPkgLoading(true)
    try {
      const [allRes, thirdPartyRes, disabledRes] = await Promise.all([
        invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages'] }),
        invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'] }),
        invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-d'] }),
      ])
      const parseList = stdout => new Set((stdout || '').split('\n').map(l => l.trim().replace(/^package:/, '')).filter(Boolean))
      const thirdParty = parseList(thirdPartyRes.stdout)
      const disabled = parseList(disabledRes.stdout)
      const rows = Array.from(parseList(allRes.stdout)).sort((a, b) => a.localeCompare(b)).map(pkg => ({
        pkg,
        type: thirdParty.has(pkg) ? 'user' : 'system',
        disabled: disabled.has(pkg),
        ...analyzeDebloatPackage(pkg, { thirdParty: thirdParty.has(pkg), disabled: disabled.has(pkg), manufacturer: manufacturerHint, model: modelHint }),
      }))
      setPackages(rows)
      setSelectedPkgs([])
      setFocusedPkg(rows[0]?.pkg || null)
      append(`Analyzed ${rows.length} package(s) for ${manufacturerHint || 'this device'}.`)
    } catch (e) {
      append(`Error: ${e}`)
    } finally {
      setPkgLoading(false)
    }
  }

  const filteredRows = packages.filter(row => {
    if (pkgSearch && !row.pkg.includes(pkgSearch.toLowerCase())) return false
    if (pkgTypeFilter !== 'all' && row.type !== pkgTypeFilter) return false
    if (pkgRecFilter !== 'all' && row.recommendation !== pkgRecFilter) return false
    return true
  })
  const visibleRows = filteredRows.slice(0, 200)
  const selectedRows = packages.filter(row => selectedPkgs.includes(row.pkg))
  const focusedRow = packages.find(row => row.pkg === focusedPkg) || visibleRows[0] || null

  useEffect(() => {
    if (!focusedRow && visibleRows[0]) setFocusedPkg(visibleRows[0].pkg)
  }, [focusedRow, visibleRows])

  function toggleSelection(pkg) {
    setSelectedPkgs(prev => prev.includes(pkg) ? prev.filter(p => p !== pkg) : [...prev, pkg])
  }

  function selectFiltered(checked) {
    if (!checked) {
      setSelectedPkgs(prev => prev.filter(pkg => !filteredRows.some(row => row.pkg === pkg)))
      return
    }
    setSelectedPkgs(prev => Array.from(new Set([...prev, ...filteredRows.map(row => row.pkg)])))
  }

  async function runPkgAction(action, targets = null) {
    const rows = targets || (selectedRows.length ? selectedRows : filteredRows)
    if (noDevice || running || !rows.length) return
    const verbs = { disable: 'Disable', restore: 'Restore', uninstall: 'Delete for user 0' }
    const ok = await safeConfirmDialog(`${verbs[action]} ${rows.length} package(s)?`)
    if (!ok) return
    setRunning(true)
    append(`$ ${verbs[action]} ${rows.length} package(s)`)
    try {
      for (const row of rows) {
        const args = action === 'disable'
          ? ['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', row.pkg]
          : action === 'restore'
            ? ['-s', serial, 'shell', 'cmd', 'package', 'install-existing', row.pkg]
            : ['-s', serial, 'shell', 'pm', 'uninstall', '-k', '--user', '0', row.pkg]
        const res = await invoke('run_adb', { args })
        const text = [res.stdout, res.stderr].filter(Boolean).map(s => s.trim()).join('\n').trim() || 'Done.'
        append(`${row.pkg}: ${text}`)
      }
    } catch (e) {
      append(`Error: ${e}`)
    } finally {
      setRunning(false)
    }
  }

  async function exportSelection() {
    const rows = selectedRows.length ? selectedRows : filteredRows
    if (!rows.length) return
    const dl = await downloadDir()
    const dest = await pathJoin(dl, `ntk_debloater_${Date.now()}.txt`)
    await writeTextFile(dest, rows.map(row => `${row.pkg} [${row.type}] [${row.recommendation}]`).join('\n'))
    append(`Exported ${rows.length} package(s) to ${dest}`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {description}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} disabled={noDevice || pkgLoading} onClick={loadPackages}>
          {pkgLoading ? 'Analyzing…' : packages.length ? '↺ Analyze Again' : 'Analyze Packages'}
        </button>
        {filterPresets.map(preset => (
          <button key={preset.id} className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setPkgSearch(preset.query)}>
            {preset.label}
          </button>
        ))}
        <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setPkgSearch('')}>Clear</button>
      </div>
      {packages.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 0.9fr 0.9fr', gap: 8 }}>
            <input value={pkgSearch} onChange={e => setPkgSearch(e.target.value.toLowerCase())} placeholder="Search packages…"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', color: 'var(--text-primary)', fontSize: 11, outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
            <select value={pkgRecFilter} onChange={e => setPkgRecFilter(e.target.value)} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', color: 'var(--text-primary)', fontSize: 11, outline: 'none' }}>
              <option value="all">All recommendations</option>
              <option value="recommended">Recommended</option>
              <option value="advanced">Advanced</option>
              <option value="caution">Caution</option>
            </select>
            <select value={pkgTypeFilter} onChange={e => setPkgTypeFilter(e.target.value)} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', color: 'var(--text-primary)', fontSize: 11, outline: 'none' }}>
              <option value="all">All packages</option>
              <option value="system">System apps</option>
              <option value="user">User apps</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{filteredRows.length} matched • {selectedPkgs.length} selected</span>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} disabled={!filteredRows.length} onClick={() => selectFiltered(true)}>Select Filtered</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} disabled={!selectedPkgs.length} onClick={() => setSelectedPkgs([])}>Clear Selection</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--accent-yellow)' }} disabled={!filteredRows.length || running} onClick={() => runPkgAction('disable')}>Disable Selection</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--accent-green)' }} disabled={!filteredRows.length || running} onClick={() => runPkgAction('restore')}>Restore Selection</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px', color: 'var(--accent-red)' }} disabled={!filteredRows.length || running} onClick={() => runPkgAction('uninstall')}>Delete Selection</button>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} disabled={!filteredRows.length} onClick={exportSelection}>Export</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.95fr', gap: 10 }}>
            <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)' }}>
              {visibleRows.map((row, i) => {
                const styleCfg = DEBLOAT_RECOMMENDATION_STYLES[row.recommendation]
                const checked = selectedPkgs.includes(row.pkg)
                return (
                  <div key={row.pkg} onClick={() => setFocusedPkg(row.pkg)} style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: 8, alignItems: 'center', padding: '8px 10px', background: focusedPkg === row.pkg ? 'rgba(168,85,247,0.10)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleSelection(row.pkg)} onClick={e => e.stopPropagation()} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</div>
                      <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.pkg}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.description}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{row.type === 'user' ? 'User app' : 'System'}</span>
                        {row.disabled && <span style={{ fontSize: 9, color: 'var(--accent-yellow)' }}>Disabled</span>}
                        <span style={{ fontSize: 9, color: styleCfg.color, background: styleCfg.bg, borderRadius: 999, padding: '1px 6px' }}>{styleCfg.label}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn-ghost" style={{ fontSize: 9, padding: '2px 6px', color: 'var(--accent-yellow)' }} disabled={running} onClick={e => { e.stopPropagation(); runPkgAction('disable', [row]) }}>Disable</button>
                      <button className="btn-ghost" style={{ fontSize: 9, padding: '2px 6px', color: 'var(--accent-red)' }} disabled={running} onClick={e => { e.stopPropagation(); runPkgAction('uninstall', [row]) }}>Delete</button>
                      <button className="btn-ghost" style={{ fontSize: 9, padding: '2px 6px', color: 'var(--accent-green)' }} disabled={running} onClick={e => { e.stopPropagation(); runPkgAction('restore', [row]) }}>Restore</button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
              {focusedRow ? (() => {
                const styleCfg = DEBLOAT_RECOMMENDATION_STYLES[focusedRow.recommendation]
                return <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Package Details</div>
                  <div style={{ fontSize: 16, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>{focusedRow.title}</div>
                  <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Courier New',monospace", color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 8, wordBreak: 'break-word' }}>{focusedRow.pkg}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span style={{ fontSize: 10, color: styleCfg.color, background: styleCfg.bg, borderRadius: 999, padding: '2px 8px' }}>{styleCfg.label}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{focusedRow.type === 'user' ? 'User app' : 'System app'}</span>
                    {focusedRow.disabled && <span style={{ fontSize: 10, color: 'var(--accent-yellow)' }}>Disabled for user 0</span>}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>What it likely is</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>{focusedRow.description}</div>
                  <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Why Nocturnal Toolkit flagged it</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>{focusedRow.reason}</div>
                  <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Safety guidance</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>{focusedRow.safety}</div>
                  <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Possible impact</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>{focusedRow.impact}</div>
                  <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>Warning</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{focusedRow.warning}</div>
                </>
              })() : <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pick a package to review its analysis and actions.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function AdvancedPanel({ device, deviceProps: _deviceProps, onNavigateToDevices, platform, onOpenPanel }) {
  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'
  const isAndroid = platform === 'android'
  const isLocalAndroidDevice = isAndroid && (device?.transport || '').toLowerCase() === 'local'

  const [open, setOpen] = useState({ reboot: true, wireless: true, controls: true, quick: true, favorites: true })
  function toggle(k) { setOpen(o => ({ ...o, [k]: !o[k] })) }

  // ── Output terminal ──
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const outputRef = useRef(null)

  function append(line) {
    setOutput(o => o + line + '\n')
    setTimeout(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight }, 30)
  }

  async function runAdb(args, label) {
    if (label) append(`$ ${label}`)
    setRunning(true)
    try {
      const r = await invoke('run_adb', { args })
      if (r.stdout) append(r.stdout.trimEnd())
      if (r.stderr) append(r.stderr.trimEnd())
      return r
    } catch (e) {
      append(`Error: ${e}`)
      return null
    } finally {
      setRunning(false)
    }
  }

  // ── Wireless ADB ──
  const [wirelessEnabled, setWirelessEnabled] = useState(false)
  const [wifiIp, setWifiIp]     = useState('')
  const [pairIp, setPairIp]     = useState('')
  const [pairCode, setPairCode] = useState('')
  const [adbPort, setAdbPort]   = useState('')

  async function enableWireless() {
    const r = await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'adb_wifi_enabled', '1'], 'Enable Wi-Fi ADB')
    if (r) setWirelessEnabled(true)
  }
  async function disableWireless() {
    await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'adb_wifi_enabled', '0'], 'Disable Wi-Fi ADB')
    setWirelessEnabled(false)
  }
  async function connectWireless() {
    if (!wifiIp.trim()) return
    await runAdb(['connect', wifiIp.trim()], `connect ${wifiIp.trim()}`)
  }
  async function pairWireless() {
    if (!pairIp.trim() || pairCode.length !== 6) return
    await runAdb(['pair', pairIp.trim(), pairCode.trim()], `pair ${pairIp.trim()} ${pairCode.trim()}`)
  }
  async function checkAdbPort() {
    const r = await runAdb(['-s', serial, 'shell', 'getprop', 'service.adb.tcp.port'], 'getprop service.adb.tcp.port')
    const port = r?.stdout?.trim()
    if (port) setAdbPort(port)
  }

  // ── Quick commands ──
  async function runQuick(cmd) {
    if (noDevice || running) return
    if (cmd.args) { await runAdb(cmd.args(serial), cmd.label); return }
    if (cmd.label === 'Screenshot') {
      append('$ Taking screenshot…')
      setRunning(true)
      try {
        const r1 = await invoke('run_adb', { args: ['-s', serial, 'shell', 'screencap', '/sdcard/screenshot.png'] })
        if (r1.stdout) append(r1.stdout.trimEnd())
        const dl = await downloadDir()
        const dest = await pathJoin(dl, `screenshot_${Date.now()}.png`)
        const r2 = await invoke('run_adb', { args: ['-s', serial, 'pull', '/sdcard/screenshot.png', dest] })
        if (r2.stdout) append(r2.stdout.trimEnd())
        append(`Saved to: ${dest}`)
      } catch (e) { append(`Error: ${e}`) }
      finally { setRunning(false) }
    } else if (cmd.label === 'Record 10s') {
      append('$ Starting 10s screen recording…')
      setRunning(true)
      try {
        const r1 = await invoke('run_adb', { args: ['-s', serial, 'shell', 'screenrecord', '--time-limit', '10', '/sdcard/screenrecord.mp4'] })
        if (r1.stdout) append(r1.stdout.trimEnd())
        const dl = await downloadDir()
        const dest = await pathJoin(dl, `screenrecord_${Date.now()}.mp4`)
        const r2 = await invoke('run_adb', { args: ['-s', serial, 'pull', '/sdcard/screenrecord.mp4', dest] })
        if (r2.stdout) append(r2.stdout.trimEnd())
        append(`Saved to: ${dest}`)
      } catch (e) { append(`Error: ${e}`) }
      finally { setRunning(false) }
    }
  }

  // ── Favorites ──
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem('adv-favorites') || '[]') } catch { return [] }
  })
  const [favLabel, setFavLabel] = useState('')
  const [favCmd,   setFavCmd]   = useState('')
  const longPressRef = useRef(null)
  const [advForceStopPkg, setAdvForceStopPkg] = useState('')
  const [advSecurePkg, setAdvSecurePkg] = useState('')
  const [advPermPkg, setAdvPermPkg] = useState('')
  const [advPermName, setAdvPermName] = useState('')

  useEffect(() => { localStorage.setItem('adv-favorites', JSON.stringify(favorites)) }, [favorites])

  function addFavorite() {
    if (!favLabel.trim() || !favCmd.trim()) return
    setFavorites(f => [...f, { label: favLabel.trim(), cmd: favCmd.trim() }])
    setFavLabel('')
    setFavCmd('')
  }

  async function runFavorite(fav) {
    if (noDevice || running) return
    await runAdb(['-s', serial, 'shell', ...fav.cmd.split(/\s+/).filter(Boolean)], fav.label)
  }

  function startLongPress(idx) {
    longPressRef.current = setTimeout(() => setFavorites(f => f.filter((_, i) => i !== idx)), 700)
  }
  function clearLongPress() { clearTimeout(longPressRef.current) }
  const androidRootCards = [
    { title: 'Bootloader / fastboot work', body: 'Use the desktop build for flashing, bootloader commands, and file-based recovery workflows. These paths are not part of the Android APK experience.' },
    { title: 'External device control', body: 'Pairing and connecting to other devices from the phone is still pending. Use the desktop app when you need multi-device ADB.' },
    { title: 'Privileged system mods', body: 'Some deeper system changes still require root or a one-time ADB-granted permission depending on the tweak.' },
  ]

  return (
    <div className="panel-content">
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <h1 className="panel-header">Device Tools</h1>
        </div>
        {noDevice && (
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)', flexShrink: 0 }} onClick={onNavigateToDevices}>
            Connect Device
          </button>
        )}
      </div>

      <div className="panel-scroll">
        {isAndroid && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 }}>
            <div style={{
              background: 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(168,85,247,0.05))',
              border: '1px solid rgba(239,68,68,0.18)',
              borderRadius: 'var(--radius-lg)',
              padding: '16px 16px',
            }}>
              <div style={{ fontSize: 22, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
                Device tools
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Keep this area for deeper actions, diagnostics, and anything that may need extra permissions.
              </div>
            </div>
            <div style={{
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.18)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px',
            }}>
              <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-red)', marginBottom: 6 }}>
                Root Required / Desktop Only
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Root-only tools and remote-device workflows are separated here so the Android app stays clear about what works on-device today.
              </div>
            </div>
          </div>
        )}

        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected — commands will be disabled</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>View Devices</button>
          </div>
        )}

        {/* ── 1. Reboot Options ── */}
        <LogSection title="Reboot Options" dot="var(--accent-red)" open={open.reboot} onToggle={() => toggle('reboot')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
            {ADV_REBOOT_MODES.map(m => (
              <button
                key={m.label}
                disabled={noDevice || running}
                onClick={() => {
                  if (isLocalAndroidDevice && m.label === 'Power Off') {
                    runAdb(
                      ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.ACTION_REQUEST_SHUTDOWN', '--ez', 'android.intent.extra.KEY_CONFIRM', 'true'],
                      m.label
                    )
                    return
                  }
                  runAdb(m.args(serial), m.label)
                }}
                style={{
                  background: m.danger ? 'rgba(239,68,68,0.08)' : 'var(--bg-elevated)',
                  border: `1px solid ${m.danger ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)', padding: '12px 8px',
                  cursor: noDevice || running ? 'not-allowed' : 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  opacity: noDevice ? 0.5 : 1, transition: 'background 0.12s', fontFamily: 'inherit',
                }}
              >
                <span style={{ fontSize: 22 }}>{m.icon}</span>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: m.danger ? 'var(--accent-red)' : 'var(--text-primary)' }}>
                  {m.label}
                </span>
              </button>
            ))}
          </div>
        </LogSection>

        {/* ── 2. Quick Commands ── */}
        <LogSection title="Quick Commands" dot="var(--accent)" open={open.quick} onToggle={() => toggle('quick')}>
          {Object.entries(ADV_QUICK_CATS).map(([catKey, cat]) => (
            <div key={catKey} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: cat.color, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>{cat.label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isAndroid ? 190 : 150}px, 1fr))`, gap: 6 }}>
                {ADV_QUICK_CMDS.filter(c => c.cat === catKey).filter(c => !isAndroid || !['Screenshot', 'Record 10s'].includes(c.label)).map((cmd, i) => (
                  <button key={i} disabled={noDevice || running} onClick={() => runQuick(cmd)}
                    style={{
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', padding: isAndroid ? '12px 12px' : '8px 10px',
                      cursor: noDevice || running ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 8,
                      opacity: noDevice ? 0.5 : 1, fontFamily: 'inherit', textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: isAndroid ? 18 : 14, flexShrink: 0 }}>{cmd.icon}</span>
                    <span style={{ fontSize: isAndroid ? 14 : 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{cmd.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </LogSection>

        {/* ── 3. Wireless ADB ── */}
        {!isAndroid && (
        <LogSection title="Wireless ADB" dot="var(--accent-teal)" open={open.wireless} onToggle={() => toggle('wireless')}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1', padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(20,184,166,0.08)', border: '1px solid rgba(20,184,166,0.18)' }}>
              <div style={{ fontSize: 11, fontWeight: 'var(--font-semibold)', color: 'var(--accent-teal)', marginBottom: 4 }}>How to use Wireless ADB here</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                <strong>Pair via Code</strong> uses the temporary <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>IP:pairing-port</code> and 6-digit code shown in Android&apos;s pairing popup.
                <br />
                <strong>Connect</strong> uses the separate <code style={{ fontFamily: "'JetBrains Mono','Courier New',monospace" }}>IP:connect-port</code> shown on the main <strong>Wireless debugging</strong> screen. The device will not appear in Nocturnal Toolkit until the connect step succeeds.
              </div>
            </div>

            {/* Status + enable/disable */}
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>Status</div>
              <div style={{
                padding: '7px 12px', borderRadius: 'var(--radius-sm)', marginBottom: 10,
                background: wirelessEnabled ? 'rgba(20,184,166,0.08)' : 'rgba(107,107,120,0.08)',
                border: `1px solid ${wirelessEnabled ? 'rgba(20,184,166,0.25)' : 'var(--border-subtle)'}`,
                fontSize: 'var(--text-xs)', color: wirelessEnabled ? 'var(--accent-teal)' : 'var(--text-muted)',
              }}>
                ● {wirelessEnabled ? 'Wi-Fi ADB active' : 'Disabled'}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-success" style={{ flex: 1, padding: '5px 0', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={enableWireless}>Enable</button>
                <button className="btn-danger"  style={{ flex: 1, padding: '5px 0', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={disableWireless}>Disable</button>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={checkAdbPort}>Check Port</button>
                {adbPort && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-teal)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>:{adbPort}</span>}
              </div>
            </div>

            {/* Connect + Pair */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Connect using the main Wireless debugging screen</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={wifiIp} onChange={e => setWifiIp(e.target.value)} placeholder="192.168.1.x:xxxxx"
                    onKeyDown={e => e.key === 'Enter' && connectWireless()}
                    style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
                  />
                  <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)', flexShrink: 0 }} disabled={!wifiIp.trim() || running} onClick={connectWireless}>Connect</button>
                </div>
              </div>
              <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Pair using the popup&apos;s temporary pairing port</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input value={pairIp} onChange={e => setPairIp(e.target.value)} placeholder="192.168.1.x:xxxxx"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={pairCode} onChange={e => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="6-digit code" maxLength={6}
                      style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
                    />
                    <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)', flexShrink: 0 }} disabled={!pairIp.trim() || pairCode.length !== 6 || running} onClick={pairWireless}>Pair</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </LogSection>
        )}

        {/* ── 4. Package Controls ── */}
        <LogSection title="Package & Permission Controls" dot="var(--accent-yellow)" open={open.controls} onToggle={() => toggle('controls')}>
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.25)', fontSize: 11, color: 'var(--accent-yellow)', lineHeight: 1.5 }}>
            Use these carefully. The full debloater GUI now lives in Maintenance under its own Debloat & App Care section. Keep Advanced focused on power controls and permission work.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Power Controls</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'force-idle'], 'Force Doze')}>Force Doze</button>
                <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} disabled={noDevice || running} onClick={() => runAdb(['-s', serial, 'shell', 'am', 'kill-all'], 'Kill BG Processes')}>Kill BG Processes</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>Force Stop App</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input value={advForceStopPkg} onChange={e => setAdvForceStopPkg(e.target.value)} placeholder="com.example.app"
                  style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
                <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} disabled={!advForceStopPkg || noDevice || running}
                  onClick={() => runAdb(['-s', serial, 'shell', 'am', 'force-stop', advForceStopPkg.trim()], `force-stop ${advForceStopPkg.trim()}`)}>Force Stop</button>
              </div>
            </div>

            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Permissions</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>Grant WRITE_SECURE_SETTINGS</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                <input value={advSecurePkg} onChange={e => setAdvSecurePkg(e.target.value)} placeholder="com.example.app"
                  style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
                <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} disabled={!advSecurePkg || noDevice || running}
                  onClick={() => runAdb(['-s', serial, 'shell', 'pm', 'grant', advSecurePkg.trim(), 'android.permission.WRITE_SECURE_SETTINGS'], `grant WRITE_SECURE_SETTINGS ${advSecurePkg.trim()}`)}>Grant</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <input value={advPermPkg} onChange={e => setAdvPermPkg(e.target.value)} placeholder="Package name"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
                <input value={advPermName} onChange={e => setAdvPermName(e.target.value)} placeholder="android.permission.DUMP"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }} />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }} disabled={!advPermPkg || !advPermName || noDevice || running}
                  onClick={() => runAdb(['-s', serial, 'shell', 'pm', 'grant', advPermPkg.trim(), advPermName.trim()], `grant ${advPermName.trim()}`)}>Grant</button>
                <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--text-xs)', color: 'var(--accent-red)' }} disabled={!advPermPkg || !advPermName || noDevice || running}
                  onClick={() => runAdb(['-s', serial, 'shell', 'pm', 'revoke', advPermPkg.trim(), advPermName.trim()], `revoke ${advPermName.trim()}`)}>Revoke</button>
              </div>
            </div>
          </div>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>
              Debloat actions now live under <strong>Maintenance → Debloat &amp; App Care</strong> so package analysis, selection, and batch actions have a dedicated GUI.
            </div>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onOpenPanel?.('phone')}>
              Open Debloat & App Care
            </button>
          </div>
        </LogSection>

        {isAndroid && (
          <LogSection title="Root Required / Desktop Only" dot="var(--accent-red)" open={open.wireless} onToggle={() => toggle('wireless')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {androidRootCards.map(card => (
                <div key={card.title} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 14px' }}>
                  <div style={{ fontSize: 14, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 4 }}>
                    {card.title}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {card.body}
                  </div>
                </div>
              ))}
            </div>
          </LogSection>
        )}

        {/* ── 4. Favorites ── */}
        <LogSection title="Favorites" dot="var(--accent-yellow)" open={open.favorites} onToggle={() => toggle('favorites')}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>Click to run. Long-press to delete.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, minHeight: 32 }}>
            {favorites.length === 0
              ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>No favorites yet.</span>
              : favorites.map((fav, i) => (
                <button key={i}
                  onClick={() => runFavorite(fav)}
                  onMouseDown={() => startLongPress(i)}
                  onMouseUp={clearLongPress}
                  onMouseLeave={clearLongPress}
                  onTouchStart={() => startLongPress(i)}
                  onTouchEnd={clearLongPress}
                  disabled={noDevice || running}
                  style={{
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', padding: '5px 12px',
                    cursor: noDevice || running ? 'not-allowed' : 'pointer',
                    opacity: noDevice ? 0.5 : 1, fontFamily: 'inherit',
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
                  }}
                >
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>{fav.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono','Courier New',monospace" }}>$ {fav.cmd}</span>
                </button>
              ))
            }
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={favLabel} onChange={e => setFavLabel(e.target.value)} placeholder="Label…"
              style={{ width: 120, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: 'inherit' }}
            />
            <input value={favCmd} onChange={e => setFavCmd(e.target.value)} placeholder="shell command…"
              onKeyDown={e => e.key === 'Enter' && addFavorite()}
              style={{ flex: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', color: 'var(--text-primary)', fontSize: 'var(--text-xs)', outline: 'none', fontFamily: "'JetBrains Mono','Courier New',monospace" }}
            />
            <button className="btn-ghost" style={{ padding: '5px 14px', fontSize: 'var(--text-xs)', flexShrink: 0 }} disabled={!favLabel.trim() || !favCmd.trim()} onClick={addFavorite}>+ Add</button>
          </div>
        </LogSection>

        {/* ── Shared output terminal ── */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 'var(--font-bold)', color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Output</span>
            <button className="btn-ghost" style={{ fontSize: 10, padding: '1px 7px' }} onClick={() => setOutput('')}>Clear</button>
          </div>
          <pre ref={outputRef} style={{ ...terminalStyle, height: 200, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {output || <span style={{ opacity: 0.4 }}>Command output will appear here…</span>}
          </pre>
        </div>

      </div>
    </div>
  )
}

const BADGE_CONFIG = {
  RECOMMENDED: { bg: 'rgba(168,85,247,0.15)',  color: 'var(--accent)'        },
  POPULAR:     { bg: 'rgba(236,72,153,0.15)',  color: 'var(--accent-pink)'   },
  TRUSTED:     { bg: 'rgba(20,184,166,0.15)',  color: 'var(--accent-teal)'   },
  GAMING:      { bg: 'rgba(245,158,11,0.15)',  color: 'var(--accent-yellow)' },
}

function StoreCard({ store, serial, noDevice, status, onStatusChange, addToast, platform }) {
  // idle | downloading | installing | uninstalling | done | uninstalled | error
  const [phase, setPhase]     = useState('idle')
  const [barPct, setBarPct]   = useState(0)
  const [errMsg, setErrMsg]   = useState(null)
  const [dlEta, setDlEta]     = useState(null) // e.g. "~12s left"
  const dlStartRef            = useRef(null)
  const lastPctRef            = useRef(0)

  const trust       = TRUST_CONFIG[store.trust]
  const badge       = store.badge ? BADGE_CONFIG[store.badge] : null
  const isInstalled = status === 'installed'
  const isChecking  = status === 'checking' || status === undefined
  const busy        = phase === 'downloading' || phase === 'installing' || phase === 'uninstalling'

  // Drive the progress bar based on phase transitions
  useEffect(() => {
    if (phase === 'downloading') {
      setBarPct(0)
      // Fallback animation — real progress from install:progress events overrides this
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setBarPct(15)))
      return () => cancelAnimationFrame(id)
    }
    if (phase === 'installing')   { setBarPct(90);  return }
    if (phase === 'uninstalling') {
      setBarPct(0)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setBarPct(85)))
      return () => cancelAnimationFrame(id)
    }
    if (phase === 'done' || phase === 'uninstalled') { setBarPct(100); return }
    setBarPct(0)
  }, [phase])

  // Listen for real download progress from Rust
  useEffect(() => {
    if (phase !== 'downloading' && phase !== 'installing') return
    dlStartRef.current = Date.now()
    lastPctRef.current = 0
    const key = `nocturnal_${store.id}.apk`
    const unlisten = listen('install:progress', e => {
      const { store: s, phase: p, percent } = e.payload
      if (s !== key) return
      if (p === 'downloading') {
        setBarPct(percent)
        // Estimate time remaining based on elapsed time and progress so far
        const elapsed = (Date.now() - dlStartRef.current) / 1000
        if (percent > 2 && elapsed > 0.5) {
          const totalEst = elapsed / (percent / 85)
          const remaining = Math.max(1, Math.round(totalEst - elapsed))
          setDlEta(remaining <= 3 ? 'almost done' : `~${remaining}s left`)
        }
        lastPctRef.current = percent
      } else if (p === 'installing') {
        setBarPct(90)
        setDlEta(null)
      }
    })
    return () => { unlisten.then(fn => fn()); setDlEta(null) }
  }, [phase, store.id])

  const barDuration = { downloading: '2s', installing: '1.5s', uninstalling: '1.5s', done: '0.15s', uninstalled: '0.15s' }[phase] ?? '0s'
  const barColor    = (phase === 'uninstalling' || phase === 'error')
    ? 'var(--accent-red)'
    : (phase === 'done' || phase === 'uninstalled')
    ? 'var(--accent-green)'
    : 'var(--accent-teal)'

  const progressBar = (
    <div style={{
      position: 'absolute', bottom: 0, left: 0,
      height: 3, width: `${barPct}%`,
      background: barColor,
      transition: `width ${barDuration} ease-out`,
      borderRadius: '0 2px 2px 0',
    }} />
  )

  // Base style for buttons that carry the progress bar
  const activeBtnStyle = { ...btnStyle, position: 'relative', overflow: 'hidden', minWidth: 96 }

  async function recheckStatus() {
    onStatusChange(store.id, 'checking')
    const res = await invoke('run_adb', {
      args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-e', store.pkg],
    })
    const installed = res.stdout?.includes(`package:${store.pkg}`) ?? false
    onStatusChange(store.id, installed ? 'installed' : 'not_installed')
  }

  async function handleInstall() {
    if (store.installType === 'browser') { openUrl(store.browserUrl); return }
    if (store.installType === 'preinstalled' || !store.apkUrl || noDevice) return

    setPhase('downloading')
    setErrMsg(null)

    // Switch to "Installing…" phase after 2 s so the bar segments feel distinct
    const phaseTimer = setTimeout(
      () => setPhase(p => p === 'downloading' ? 'installing' : p),
      2000
    )

    try {
      const res = await invoke('install_from_url', {
        serial,
        url: store.apkUrl,
        filename: `nocturnal_${store.id}.apk`,
      })
      if (platform === 'android' && res?.localPath) {
        await openUrl(res.localPath)
      }
      clearTimeout(phaseTimer)
      if (res.ok) {
        setPhase('done')
        addToast(platform === 'android' && res?.localPath
          ? `${store.name} opened in the Android package installer`
          : `${store.name} installed successfully`, 'success')
        recheckStatus()
        setTimeout(() => setPhase('idle'), 600) // brief success flash
      } else {
        const msg = res.stderr?.trim() || res.stdout?.trim() || 'Install failed'
        setPhase('error')
        setErrMsg(msg)
        addToast(`Failed to install ${store.name}`, 'error')
      }
    } catch (e) {
      clearTimeout(phaseTimer)
      setPhase('error')
      setErrMsg(String(e))
      addToast(`Failed to install ${store.name}`, 'error')
    }
  }

  async function handleUninstall() {
    if (!serial || busy) return
    setPhase('uninstalling')
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, 'uninstall', store.pkg] })
      if (res.stdout?.toLowerCase().includes('success')) {
        setPhase('uninstalled')
        addToast(`${store.name} uninstalled`, 'success')
        setTimeout(() => {
          onStatusChange(store.id, 'not_installed')
          setPhase('idle')
        }, 500)
      } else {
        setPhase('error')
        addToast(`Failed to uninstall ${store.name}`, 'error')
      }
    } catch {
      setPhase('error')
      addToast(`Failed to uninstall ${store.name}`, 'error')
    }
  }

  function renderActions() {
    if (store.installType === 'browser') {
      return <button className="btn-ghost" style={btnStyle} onClick={handleInstall}>Get App ↗</button>
    }
    if (store.installType === 'preinstalled') {
      return (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
          {isInstalled ? '● Pre-installed on Samsung' : '● Not detected on this device'}
        </div>
      )
    }
    if (noDevice) {
      return (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
          Connect a device to install
        </div>
      )
    }

    // In-progress: single full-width button with animated bar
    if (busy) {
      let label
      if (phase === 'downloading') {
        const pctStr = barPct > 0 ? ` ${Math.round(barPct)}%` : ''
        const etaStr = dlEta ? ` · ${dlEta}` : ''
        label = `Downloading…${pctStr}${etaStr}`
      } else if (phase === 'uninstalling') {
        label = 'Uninstalling…'
      } else {
        label = 'Installing…'
      }
      return (
        <button className="btn-ghost" style={activeBtnStyle} disabled>
          {label}
          {progressBar}
        </button>
      )
    }

    // Just finished install — briefly shows "✓ Installed" at 100% bar
    if (phase === 'done') {
      return (
        <button className="btn-ghost" style={{ ...activeBtnStyle, color: 'var(--accent-green)', borderColor: 'rgba(34,197,94,0.35)' }} disabled>
          ✓ Installed
          {progressBar}
        </button>
      )
    }

    // Just finished uninstall — briefly shows "✓ Uninstalled" at 100% bar
    if (phase === 'uninstalled') {
      return (
        <button className="btn-ghost" style={{ ...activeBtnStyle, color: 'var(--accent-green)', borderColor: 'rgba(34,197,94,0.35)' }} disabled>
          ✓ Uninstalled
          {progressBar}
        </button>
      )
    }

    // Error — offer retry
    if (phase === 'error') {
      return (
        <button
          className="btn-ghost"
          style={{ ...btnStyle, color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.35)' }}
          onClick={() => { setPhase('idle'); setErrMsg(null) }}
        >
          ✗ Failed — Retry
        </button>
      )
    }

    // Installed: Reinstall + Uninstall side by side
    if (isInstalled) {
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" style={{ ...btnStyle, flex: 1 }} onClick={handleInstall}>
            Reinstall
          </button>
          <button className="btn-danger" style={{ ...btnStyle, flex: 1 }} onClick={handleUninstall}>
            Uninstall
          </button>
        </div>
      )
    }

    // Default: not installed
    return (
      <button className="btn-success" style={{ ...btnStyle, minWidth: 96 }} onClick={handleInstall}>
        Install
      </button>
    )
  }

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: `1px solid ${isInstalled ? 'rgba(34,197,94,0.2)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-lg)',
      padding: '14px 12px',
      display: 'flex', flexDirection: 'column', gap: 10,
      minWidth: 0, transition: 'border-color 0.2s',
    }}>

      {/* Icon + name + badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 28, lineHeight: 1, flexShrink: 0 }}>{store.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 1 }}>
            <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
              {store.name}
            </span>
            {badge && (
              <span style={{ fontSize: 9, fontWeight: 'var(--font-bold)', padding: '1px 5px', borderRadius: 4, background: badge.bg, color: badge.color, letterSpacing: '0.04em' }}>
                {store.badge}
              </span>
            )}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {store.tagline}
          </div>
        </div>
      </div>

      {/* Trust bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4, color: 'var(--text-secondary)' }}>
          <span>Trust</span>
          <span style={{ color: trust.color, fontWeight: 'var(--font-semibold)' }}>{store.trust}</span>
        </div>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 3, height: 3, overflow: 'hidden' }}>
          <div style={{ width: `${trust.pct}%`, background: trust.color, height: '100%', borderRadius: 3 }} />
        </div>
      </div>

      {/* Tags */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {store.tags.map(tag => (
          <span key={tag} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {tag}
          </span>
        ))}
      </div>

      {/* Status line */}
      <div style={{ fontSize: 'var(--text-xs)', minHeight: 14 }}>
        {isChecking && serial
          ? <span style={{ color: 'var(--text-muted)' }}>Checking…</span>
          : isInstalled
          ? <span style={{ color: 'var(--accent-green)', fontWeight: 'var(--font-semibold)' }}>● Installed</span>
          : serial
          ? <span style={{ color: 'var(--text-muted)' }}>○ Not installed</span>
          : null
        }
      </div>

      {/* Error detail */}
      {phase === 'error' && errMsg && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)', wordBreak: 'break-all' }}>
          {errMsg}
        </div>
      )}

      {renderActions()}

    </div>
  )
}

const btnStyle = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 'var(--text-xs)',
}

function AppStoresPanel({ device, onNavigateToDevices, platform }) {
  const [catFilter, setCatFilter] = useState('all')
  const [statuses, setStatuses]   = useState({}) // id → 'checking'|'installed'|'not_installed'
  const [toasts, setToasts]       = useState([]) // { id, msg, type }

  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'

  // Check installed status for all stores when device connects
  useEffect(() => {
    if (!serial) { setStatuses({}); return }
    const fresh = {}
    APP_STORES.forEach(s => { fresh[s.id] = 'checking' })
    setStatuses(fresh)
    APP_STORES.forEach(store => {
      invoke('run_adb', {
        args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-e', store.pkg],
      }).then(res => {
        const installed = res.stdout?.includes(`package:${store.pkg}`) ?? false
        setStatuses(s => ({ ...s, [store.id]: installed ? 'installed' : 'not_installed' }))
      }).catch(() => {
        setStatuses(s => ({ ...s, [store.id]: 'not_installed' }))
      })
    })
  }, [serial])

  function handleStatusChange(id, status) {
    setStatuses(s => ({ ...s, [id]: status }))
  }

  function addToast(msg, type = 'success') {
    const id = crypto.randomUUID()
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }

  const filtered = catFilter === 'all'
    ? APP_STORES
    : APP_STORES.filter(s => s.category === catFilter)

  const installableCount = APP_STORES.filter(s =>
    s.installType === 'direct' && statuses[s.id] === 'not_installed'
  ).length

  return (
    <div className="panel-content" style={{ position: 'relative' }}>

      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="panel-header">Stores</h1>
            {!noDevice && installableCount > 0 && (
              <span style={{
                fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)',
                background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 99,
                padding: '2px 9px',
              }}>
                {installableCount} installable
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="panel-scroll">

        {/* No device warning */}
        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected — install buttons are disabled</span>
            <button
              className="btn-ghost"
              style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
              onClick={onNavigateToDevices}
            >
              View Devices
            </button>
          </div>
        )}

        {/* Category filter tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {STORE_CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setCatFilter(cat.id)}
              style={{
                padding: '5px 12px', fontSize: 'var(--text-xs)',
                fontWeight: 'var(--font-semibold)', borderRadius: 99,
                border: '1px solid', cursor: 'pointer',
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                background:  catFilter === cat.id ? 'var(--accent)' : 'transparent',
                color:       catFilter === cat.id ? '#fff'          : 'var(--text-muted)',
                borderColor: catFilter === cat.id ? 'var(--accent)' : 'var(--border)',
                fontFamily: 'inherit',
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Store grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {filtered.map(store => (
            <StoreCard
              key={store.id}
              store={store}
              serial={serial}
              noDevice={noDevice}
              status={statuses[store.id]}
              onStatusChange={handleStatusChange}
              addToast={addToast}
              platform={platform}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            No stores in this category.
          </div>
        )}

      </div>

      {/* Toast container — bottom-right of viewport */}
      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        display: 'flex', flexDirection: 'column', gap: 8,
        zIndex: 9999, pointerEvents: 'none',
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: toast.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--font-medium)',
            maxWidth: 320,
            backdropFilter: 'blur(8px)',
            animation: 'toast-in 0.25s ease',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          }}>
            <span style={{ flexShrink: 0 }}>{toast.type === 'success' ? '✓' : '✗'}</span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

    </div>
  )
}

// ── Manage Apps panel ─────────────────────────────────────────────────────────

function parsePackages(stdout) {
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('package:'))
    .map(l => l.slice('package:'.length).trim())
    .filter(Boolean)
    .sort()
}

function adbCommandWorked(result) {
  if (result?.ok) return true
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.toLowerCase()
  return text.includes('success') || text.includes('pulled') || text.includes('pushed')
}

function fileNameFromPath(path) {
  return String(path || '').split('/').filter(Boolean).pop() || ''
}

function safeBackupFolderName(pkg) {
  return `${String(pkg || 'package').replace(/[^\w.-]+/g, '_')}__${Date.now()}`
}

async function remotePathExists(serial, remotePath) {
  const res = await invoke('run_adb', { args: ['-s', serial, 'shell', 'ls', '-d', remotePath] })
  const text = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`.toLowerCase()
  return !!res?.stdout?.trim() && !text.includes('no such file') && !text.includes('cannot access')
}

async function collectLocalFiles(root, prefix = '') {
  const entries = await readDir(root)
  const files = []
  for (const entry of entries) {
    const name = entry.name || ''
    if (!name) continue
    const nextPrefix = prefix ? `${prefix}/${name}` : name
    const fullPath = entry.path || await pathJoin(root, name)
    if (entry.isDirectory) {
      files.push(...await collectLocalFiles(fullPath, nextPrefix))
    } else {
      files.push(nextPrefix)
    }
  }
  return files
}

async function backupPackageToToolkit({ serial, pkg, device, androidVersion }) {
  const pathRes = await invoke('run_adb', {
    args: ['-s', serial, 'shell', 'pm', 'path', pkg],
  })
  const apkPaths = String(pathRes.stdout || '')
    .split('\n')
    .map(line => line.trim().replace(/^package:/, ''))
    .filter(Boolean)

  if (!apkPaths.length) throw new Error('Could not resolve APK path on device')

  const dl = await downloadDir()
  const backupsRoot = await pathJoin(dl, 'Nocturnal Toolkit', 'Backups')
  await mkdir(backupsRoot, { recursive: true })
  const backupDir = await pathJoin(backupsRoot, safeBackupFolderName(pkg))
  await mkdir(backupDir, { recursive: true })

  const pulledFiles = []
  for (const apkPath of apkPaths) {
    const apkName = fileNameFromPath(apkPath) || `split_${pulledFiles.length}.apk`
    const localApk = await pathJoin(backupDir, apkName)
    const pullRes = await invoke('run_adb', { args: ['-s', serial, 'pull', apkPath, localApk] })
    if (!adbCommandWorked(pullRes)) {
      throw new Error(pullRes.stderr?.trim() || `Failed to pull ${apkName}`)
    }
    pulledFiles.push(apkName)
  }

  const remoteDirs = [
    { remote: `/sdcard/Android/obb/${pkg}`, localFolder: 'obb', label: 'obb' },
    { remote: `/sdcard/Android/data/${pkg}`, localFolder: 'shared-data', label: 'shared-data' },
    { remote: `/sdcard/Android/media/${pkg}`, localFolder: 'shared-media', label: 'shared-media' },
  ]

  for (const item of remoteDirs) {
    if (!(await remotePathExists(serial, item.remote))) continue
    const localRoot = await pathJoin(backupDir, item.localFolder)
    await mkdir(localRoot, { recursive: true })
    const pullRes = await invoke('run_adb', { args: ['-s', serial, 'pull', item.remote, localRoot] })
    if (!adbCommandWorked(pullRes)) continue
    const localPkgDir = await pathJoin(localRoot, pkg)
    if (await exists(localPkgDir)) {
      const files = await collectLocalFiles(localPkgDir, `${item.localFolder}/${pkg}`)
      pulledFiles.push(...files)
    }
  }

  const manifest = {
    packageName: pkg,
    date: new Date().toISOString(),
    deviceModel: device?.model ?? 'Unknown Device',
    androidVersion: androidVersion ?? null,
    files: pulledFiles,
    containsObb: pulledFiles.some(name => name.startsWith(`obb/${pkg}/`)),
    containsSharedData: pulledFiles.some(name => name.startsWith(`shared-data/${pkg}/`) || name.startsWith(`shared-media/${pkg}/`)),
  }

  await writeTextFile(
    await pathJoin(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  )

  return { backupDir, manifest }
}

async function restoreToolkitBackup({ serial, backup }) {
  const entries = await readDir(backup.backupDir)
  const apkNames = entries
    .filter(entry => entry.isFile !== false && entry.name?.toLowerCase().endsWith('.apk'))
    .map(entry => entry.name)

  if (!apkNames.length) throw new Error(`No APK files found in ${backup.backupDir}`)

  const apkPaths = await Promise.all(apkNames.map(name => pathJoin(backup.backupDir, name)))
  const installRes = apkPaths.length === 1
    ? await invoke('run_adb', { args: ['-s', serial, 'install', '-r', apkPaths[0]] })
    : await invoke('run_adb', { args: ['-s', serial, 'install-multiple', '-r', ...apkPaths] })

  if (!adbCommandWorked(installRes)) {
    const detail = installRes.stderr?.trim() || installRes.stdout?.trim() || 'Install failed'
    throw new Error(detail)
  }

  const restoreDirs = [
    { localFolder: 'obb', remoteParent: '/sdcard/Android/obb' },
    { localFolder: 'shared-data', remoteParent: '/sdcard/Android/data' },
    { localFolder: 'shared-media', remoteParent: '/sdcard/Android/media' },
  ]

  for (const item of restoreDirs) {
    const localRoot = await pathJoin(backup.backupDir, item.localFolder)
    if (!(await exists(localRoot))) continue
    const localPkgDir = await pathJoin(localRoot, backup.packageName)
    if (!(await exists(localPkgDir))) continue
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'mkdir', '-p', item.remoteParent] })
    const pushRes = await invoke('run_adb', { args: ['-s', serial, 'push', localPkgDir, item.remoteParent] })
    if (!adbCommandWorked(pushRes)) {
      throw new Error(pushRes.stderr?.trim() || `Failed to restore ${item.localFolder}`)
    }
  }
}

function AppCard({ pkg, serial, device, androidVersion, addToast, onRemove }) {
  const [busy, setBusy] = useState(null) // 'launch' | 'uninstall' | 'clear' | 'backup'

  async function launch() {
    setBusy('launch')
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'monkey', '-p', pkg, '1'] })
    setBusy(null)
  }

  async function uninstall() {
    setBusy('uninstall')
    const res = await invoke('run_adb', { args: ['-s', serial, 'uninstall', pkg] })
    if (res.ok && res.stdout?.toLowerCase().includes('success')) {
      onRemove(pkg)
    }
    setBusy(null)
  }

  async function clearData() {
    setBusy('clear')
    await invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'clear', pkg] })
    setBusy(null)
  }

  async function backup() {
    setBusy('backup')
    try {
      const { manifest } = await backupPackageToToolkit({ serial, pkg, device, androidVersion })
      const detail = [
        `${(manifest.files || []).filter(name => name.endsWith('.apk')).length} APK`,
        manifest.containsObb ? 'OBB' : null,
        manifest.containsSharedData ? 'shared data' : null,
      ].filter(Boolean).join(' + ')
      addToast?.(`Backed up ${pkg}${detail ? ` (${detail})` : ''}`, 'success')
    } catch (e) {
      addToast?.(`Backup failed: ${String(e).slice(0, 80)}`, 'error')
    }
    setBusy(null)
  }

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: '12px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--text-sm)',
          fontWeight: 'var(--font-medium)',
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 2,
          fontFamily: 'monospace',
        }}>
          {pkg}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button
          className="btn-ghost"
          style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }}
          disabled={!!busy}
          onClick={launch}
        >
          {busy === 'launch' ? '…' : '▶ Launch'}
        </button>
        <button
          className="btn-ghost"
          style={{ padding: '4px 10px', fontSize: 'var(--text-xs)', color: 'var(--accent-yellow)', borderColor: 'var(--accent-yellow)' }}
          disabled={!!busy}
          onClick={clearData}
        >
          {busy === 'clear' ? '…' : 'Clear Data'}
        </button>
        <button
          className="btn-ghost"
          style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }}
          disabled={!!busy}
          onClick={backup}
        >
          {busy === 'backup' ? '…' : 'Full Backup'}
        </button>
        <button
          className="btn-danger"
          style={{ padding: '4px 10px', fontSize: 'var(--text-xs)' }}
          disabled={!!busy}
          onClick={uninstall}
        >
          {busy === 'uninstall' ? '…' : 'Uninstall'}
        </button>
      </div>
    </div>
  )
}

function ManageAppsPanel({ device, deviceProps, onNavigateToDevices, onOpenPanel }) {
  const [packages, setPackages]   = useState([])
  const [loading, setLoading]     = useState(false)
  const [search, setSearch]       = useState('')
  const [toasts, setToasts]       = useState([])

  const serial = device?.serial

  function addToast(msg, type = 'success') {
    const id = crypto.randomUUID()
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }

  useEffect(() => {
    if (!serial) { setPackages([]); return }
    setLoading(true)
    setPackages([])
    invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'] })
      .then(res => setPackages(parsePackages(res.stdout ?? '')))
      .finally(() => setLoading(false))
  }, [serial])

  function removePackage(pkg) {
    setPackages(ps => ps.filter(p => p !== pkg))
  }

  const filtered = search.trim()
    ? packages.filter(p => p.toLowerCase().includes(search.toLowerCase()))
    : packages

  const noDevice = !device || device.status !== 'device'

  return (
    <div className="panel-content" style={{ position: 'relative' }}>

      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="panel-header">Apps</h1>
            {!loading && packages.length > 0 && (
              <span style={{
                fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)',
                background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 99,
                padding: '2px 9px',
              }}>
                {filtered.length === packages.length
                  ? `${packages.length} apps`
                  : `${filtered.length} of ${packages.length}`}
              </span>
            )}
          </div>
        </div>
        <button
          className="btn-ghost"
          style={{ flexShrink: 0 }}
          disabled={noDevice || loading}
          onClick={() => {
            if (!serial) return
            setLoading(true)
            setPackages([])
            invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'] })
              .then(res => setPackages(parsePackages(res.stdout ?? '')))
              .finally(() => setLoading(false))
          }}
        >
          Refresh
        </button>
        <button
          className="btn-ghost"
          style={{ flexShrink: 0 }}
          onClick={() => onOpenPanel?.('backups')}
        >
          Backup &amp; Restore
        </button>
      </div>

      <div className="panel-scroll">

        {/* No device warning */}
        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected</span>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }} onClick={onNavigateToDevices}>
              View Devices
            </button>
          </div>
        )}

        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          background: 'linear-gradient(135deg, rgba(20,184,166,0.08), rgba(59,130,246,0.04))',
          border: '1px solid rgba(20,184,166,0.16)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 16px',
          marginBottom: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 4 }}>
              Toolkit Backup &amp; Restore
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Create a toolkit-managed backup from here, then restore it from Backup &amp; Restore. Each backup now saves APK splits, OBB files, and shared app folders that ADB can reach.
            </div>
          </div>
          <button
            className="btn-primary"
            style={{ padding: '6px 14px', fontSize: 'var(--text-xs)', flexShrink: 0 }}
            onClick={() => onOpenPanel?.('backups')}
          >
            Open Backup &amp; Restore
          </button>
        </div>

        {/* Search bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '0 12px',
          marginBottom: 16,
        }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={noDevice ? 'Connect a device to see installed apps' : loading ? 'Loading…' : `Search ${packages.length} installed apps…`}
            disabled={noDevice || loading}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: 'var(--text-sm)',
              padding: '10px 0', fontFamily: 'inherit',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Loading apps…
          </div>
        )}

        {/* Empty — no apps found */}
        {!loading && !noDevice && packages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            No user-installed apps found on this device.
          </div>
        )}

        {/* Empty — no device */}
        {!loading && noDevice && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Connect a device to see installed apps.
          </div>
        )}

        {/* No search results */}
        {!loading && !noDevice && packages.length > 0 && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            No apps match "{search}"
          </div>
        )}

        {/* App list */}
        {!loading && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map(pkg => (
              <AppCard
                key={pkg}
                pkg={pkg}
                serial={serial}
                device={device}
                androidVersion={deviceProps?.android ?? null}
                addToast={addToast}
                onRemove={removePackage}
              />
            ))}
          </div>
        )}

      </div>

      {/* Toast container */}
      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        display: 'flex', flexDirection: 'column', gap: 8,
        zIndex: 9999, pointerEvents: 'none',
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: toast.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--font-medium)',
            maxWidth: 320,
            backdropFilter: 'blur(8px)',
            animation: 'toast-in 0.25s ease',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          }}>
            <span style={{ flexShrink: 0 }}>{toast.type === 'success' ? '✓' : '✗'}</span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

    </div>
  )
}

// ── Backups panel ─────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function BackupsPanel({ device, deviceProps, onNavigateToDevices, onOpenPanel }) {
  const [backups, setBackups]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [backupsRoot, setBackupsRoot] = useState(null)
  const [restoring, setRestoring] = useState({}) // pkg → true
  const [exporting, setExporting] = useState({})
  const [packages, setPackages]   = useState([])
  const [packagesLoading, setPackagesLoading] = useState(false)
  const [backupTarget, setBackupTarget] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [toasts, setToasts]       = useState([])

  const serial   = device?.serial
  const noDevice = !device || device.status !== 'device'

  function addToast(msg, type = 'success') {
    const id = crypto.randomUUID()
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }

  async function loadBackups() {
    setLoading(true)
    try {
      const dl   = await downloadDir()
      const root = await pathJoin(dl, 'Nocturnal Toolkit', 'Backups')
      setBackupsRoot(root)
      const dirExists = await exists(root)
      if (!dirExists) { setBackups([]); setLoading(false); return }

      const entries = await readDir(root)
      const loaded  = []
      for (const entry of entries) {
        if (!entry.isDirectory) continue
        const manifestPath = await pathJoin(root, entry.name, 'manifest.json')
        const mExists = await exists(manifestPath)
        if (!mExists) continue
        try {
          const text     = await readTextFile(manifestPath)
          const manifest = JSON.parse(text)
          loaded.push({
            ...manifest,
            backupDir: await pathJoin(root, entry.name),
          })
        } catch {
          // Ignore malformed backup manifests and keep loading valid entries.
        }
      }
      loaded.sort((a, b) => new Date(b.date) - new Date(a.date))
      setBackups(loaded)
    } catch {
      setBackups([])
    }
    setLoading(false)
  }

  useEffect(() => { loadBackups() }, [])

  useEffect(() => {
    if (!serial) {
      setPackages([])
      setBackupTarget('')
      return
    }
    setPackagesLoading(true)
    invoke('run_adb', { args: ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'] })
      .then(res => {
        const next = parsePackages(res.stdout ?? '')
        setPackages(next)
        setBackupTarget(current => current && next.includes(current) ? current : (next[0] || ''))
      })
      .finally(() => setPackagesLoading(false))
  }, [serial])

  async function createBackup() {
    if (noDevice) {
      addToast('Connect a device to create a backup', 'error')
      return
    }
    if (!backupTarget) {
      addToast('Choose an app to back up', 'error')
      return
    }
    setBackingUp(true)
    try {
      await backupPackageToToolkit({
        serial,
        pkg: backupTarget,
        device,
        androidVersion: deviceProps?.android ?? null,
      })
      await loadBackups()
      addToast(`${backupTarget} backup created`, 'success')
    } catch (e) {
      addToast(`Backup failed: ${String(e).slice(0, 90)}`, 'error')
    }
    setBackingUp(false)
  }

  async function doRestore(backup) {
    if (noDevice) {
      addToast('Connect a device to restore', 'error')
      return
    }
    setRestoring(r => ({ ...r, [backup.packageName]: true }))
    try {
      await restoreToolkitBackup({ serial, backup })
      addToast(`${backup.packageName} restored`, 'success')
    } catch (e) {
      addToast(`Restore failed: ${String(e).slice(0, 100)}`, 'error')
    }
    setRestoring(r => { const n = { ...r }; delete n[backup.packageName]; return n })
  }

  async function doDelete(backup) {
    if (!confirm(`Delete backup of ${backup.packageName}?`)) return
    try {
      await remove(backup.backupDir, { recursive: true })
      setBackups(bs => bs.filter(b => b.backupDir !== backup.backupDir))
      addToast('Backup deleted', 'success')
    } catch (e) {
      addToast(`Delete failed: ${String(e).slice(0, 80)}`, 'error')
    }
  }

  async function openFolder(path) {
    await invoke('open_in_finder', { path })
  }

  async function exportNoRootData(key, label, adbArgs, ext = 'txt') {
    if (noDevice) {
      addToast('Connect a device to export data', 'error')
      return
    }
    setExporting(prev => ({ ...prev, [key]: true }))
    try {
      const res = await invoke('run_adb', { args: ['-s', serial, ...adbArgs] })
      const text = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
      if (!text) throw new Error('No data returned from the device')
      const dl = await downloadDir()
      const root = await pathJoin(dl, 'Nocturnal Toolkit', 'Backups', 'No-Root Data')
      await mkdir(root, { recursive: true })
      const safeSerial = (serial || 'device').replace(/[^\w.-]+/g, '_')
      const file = await pathJoin(root, `${key}_${safeSerial}_${Date.now()}.${ext}`)
      await writeTextFile(file, text)
      addToast(`${label} exported`, 'success')
    } catch (e) {
      addToast(`${label} export failed: ${String(e).slice(0, 90)}`, 'error')
    }
    setExporting(prev => { const next = { ...prev }; delete next[key]; return next })
  }

  return (
    <div className="panel-content" style={{ position: 'relative' }}>

      {/* Header */}
      <div className="panel-header-row">
        <div style={{ minWidth: 0 }}>
          <div className="panel-header-accent" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="panel-header">Backup &amp; Restore</h1>
            {!loading && backups.length > 0 && (
              <span style={{
                fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)',
                background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 99,
                padding: '2px 9px',
              }}>
                {backups.length} backup{backups.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            className="btn-ghost"
            style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }}
            disabled={loading}
            onClick={loadBackups}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {backupsRoot && (
            <button
              className="btn-ghost"
              style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }}
              onClick={() => openFolder(backupsRoot)}
            >
              Open Folder
            </button>
          )}
        </div>
      </div>

      <div className="panel-scroll">

        <div style={{
          background: 'linear-gradient(135deg, rgba(20,184,166,0.08), rgba(59,130,246,0.05))',
          border: '1px solid rgba(20,184,166,0.18)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px 18px',
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 20, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 6 }}>
            Backup & Restore
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            Create and restore toolkit-managed app backups from one place. App backups include APK splits, OBB files, and shared app folders that ADB can access, alongside no-root exports like SMS, call logs, contacts, and device info.
          </div>
        </div>

        {/* No device warning */}
        {noDevice && (
          <div className="warning-banner" style={{ marginBottom: 20 }}>
            <span>No device connected — backup and restore are disabled</span>
            <button
              className="btn-ghost"
              style={{ padding: '4px 12px', fontSize: 'var(--text-xs)' }}
              onClick={onNavigateToDevices}
            >
              View Devices
            </button>
          </div>
        )}

        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '16px', marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
            Toolkit App Backup
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
            Use these buttons to make a real toolkit backup before you restore later. The toolkit saves every APK split it can read, plus OBB files and shared app folders under Android data and media when the device exposes them over ADB.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <select
              value={backupTarget}
              onChange={e => setBackupTarget(e.target.value)}
              disabled={noDevice || packagesLoading || packages.length === 0 || backingUp}
              style={{
                minWidth: 260,
                maxWidth: '100%',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
                color: 'var(--text-primary)',
                fontSize: 'var(--text-sm)',
                outline: 'none',
              }}
            >
              {packages.length === 0 && <option value="">{packagesLoading ? 'Loading apps…' : 'No user-installed apps found'}</option>}
              {packages.map(pkg => <option key={pkg} value={pkg}>{pkg}</option>)}
            </select>
            <button
              className="btn-primary"
              style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }}
              disabled={noDevice || packagesLoading || !backupTarget || backingUp}
              onClick={createBackup}
            >
              {backingUp ? 'Backing Up…' : 'Back Up Selected App'}
            </button>
            <button
              className="btn-ghost"
              style={{ padding: '6px 14px', fontSize: 'var(--text-xs)' }}
              disabled={packagesLoading || backingUp}
              onClick={() => onOpenPanel?.('manage')}
            >
              Open Manage Apps
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Restores reinstall the saved APKs and copy the saved OBB and shared folders back onto the device. Internal app sandbox data still depends on root or app-specific export support.
          </div>
        </div>

        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '16px', marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 8 }}>
            No-Root Data Export
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
            These exports use ADB-accessible content providers and system services. They do not require root, but device firmware can still limit what is exposed.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {[
              { key: 'sms', label: 'Export SMS', desc: 'Saves SMS and MMS metadata from the device message database.', args: ['shell', 'content', 'query', '--uri', 'content://sms'] },
              { key: 'calls', label: 'Export Call Log', desc: 'Saves the call history that Android exposes over ADB.', args: ['shell', 'content', 'query', '--uri', 'content://call_log/calls'] },
              { key: 'contacts', label: 'Export Contacts', desc: 'Exports the visible contacts list from the contacts provider.', args: ['shell', 'content', 'query', '--uri', 'content://com.android.contacts/contacts'] },
              { key: 'device_info', label: 'Export Device Info', desc: 'Saves device props, battery status, and storage snapshots for reference.', args: ['shell', 'sh', '-c', 'getprop && echo "\\n--- BATTERY ---" && dumpsys battery && echo "\\n--- STORAGE ---" && df -h'] },
            ].map(card => (
              <div key={card.key} style={{ padding: '12px 12px', borderRadius: 'var(--radius-md)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: 13, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)', marginBottom: 5 }}>{card.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>{card.desc}</div>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 12px', fontSize: 'var(--text-xs)' }}
                  disabled={noDevice || !!exporting[card.key]}
                  onClick={() => exportNoRootData(card.key, card.label, card.args)}
                >
                  {exporting[card.key] ? 'Exporting…' : card.label}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Loading backups…
          </div>
        )}

        {/* Empty state */}
        {!loading && backups.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>💾</div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 8 }}>
              No backups yet
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Use the Toolkit App Backup buttons above to create your first full backup
            </div>
          </div>
        )}

        {/* Backup list */}
        {!loading && backups.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {backups.map(backup => {
              const isRestoring = restoring[backup.packageName]
              const apkCount    = (backup.files ?? []).filter(f => f.endsWith('.apk')).length
              const hasObb      = backup.containsObb || (backup.files ?? []).some(f => f.startsWith(`obb/${backup.packageName}/`) || f.endsWith('.obb'))
              const hasData     = backup.containsSharedData || (backup.files ?? []).some(f => f.startsWith(`shared-data/${backup.packageName}/`) || f.startsWith(`shared-media/${backup.packageName}/`))

              return (
                <div key={backup.backupDir} style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '16px',
                }}>
                  {/* Top row */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', marginBottom: 3, fontFamily: 'monospace' }}>
                      {backup.packageName}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 2 }}>
                      {formatDate(backup.date)}
                    </div>
                    {backup.deviceModel && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {backup.deviceModel}{backup.androidVersion ? ` · Android ${backup.androidVersion}` : ''}
                      </div>
                    )}
                  </div>

                  {/* File type badges */}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 'var(--font-bold)', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                      background: 'rgba(20,184,166,0.1)', color: 'var(--accent-teal)',
                    }}>
                      APK{apkCount > 1 ? ` · ${apkCount} files` : ''}
                    </span>
                    {hasObb && (
                      <span style={{
                        fontSize: 10, fontWeight: 'var(--font-bold)', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                        background: 'rgba(245,158,11,0.1)', color: 'var(--accent-yellow)',
                      }}>
                        OBB
                      </span>
                    )}
                    {hasData && (
                      <span style={{
                        fontSize: 10, fontWeight: 'var(--font-bold)', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                        background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)',
                      }}>
                        Shared Data
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn-success"
                      style={{ padding: '5px 14px', fontSize: 'var(--text-xs)' }}
                      disabled={isRestoring || noDevice}
                      onClick={() => doRestore(backup)}
                    >
                      {isRestoring ? 'Restoring…' : '⚡ Restore'}
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ padding: '5px 14px', fontSize: 'var(--text-xs)' }}
                      onClick={() => openFolder(backup.backupDir)}
                    >
                      Show in Finder
                    </button>
                    <button
                      className="btn-danger"
                      style={{ padding: '5px 14px', fontSize: 'var(--text-xs)' }}
                      disabled={isRestoring}
                      onClick={() => doDelete(backup)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </div>

      {/* Toast container */}
      <div style={{
        position: 'fixed', bottom: 24, right: 24,
        display: 'flex', flexDirection: 'column', gap: 8,
        zIndex: 9999, pointerEvents: 'none',
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: toast.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: toast.type === 'success' ? 'var(--accent-green)' : 'var(--accent-red)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--font-medium)',
            maxWidth: 320,
            backdropFilter: 'blur(8px)',
            animation: 'toast-in 0.25s ease',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          }}>
            <span style={{ flexShrink: 0 }}>{toast.type === 'success' ? '✓' : '✗'}</span>
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

function MainApp() {
  const [devices, setDevices]     = useState([])
  const [ready, setReady]         = useState(false)
  const [selected, setSelected]   = useState(null)
  const [props, setProps]         = useState(null)
  const [loading, setLoading]     = useState(false)
  const [activePanel, setActivePanel] = useState('getting-started')
  const [scanning, setScanning]   = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system')
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('nt_welcomed'))
  const [sharedInstallQueue, setSharedInstallQueue] = useState([])
  const [platform, setPlatform] = useState(() => previewPlatformOverride() || 'desktop')
  const [savedDevices, setSavedDevices] = useState([])
  const [savedDeviceHistory, setSavedDeviceHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nocturnal_saved_device_history') || '[]') } catch { return [] }
  })
  const [desktopNavOpen, setDesktopNavOpen] = useState(() => Object.fromEntries(NAV_SECTIONS.map(section => [section.label, false])))
  const [pairSectionOpen, setPairSectionOpen] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [orientation, setOrientation] = useState('portrait')
  const androidHistoryRef = useRef({ ready: false, syncingPop: false, key: '' })
  const [showUpdateBanner, setShowUpdateBanner] = useState(false)
  const [updateChannel, setUpdateChannel] = useState(() => localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY) || 'stable')
  const [updateState, setUpdateState] = useState({
    status: 'idle',
    channel: localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY) || 'stable',
    available: false,
    checkedAt: 0,
    error: '',
    latestVersion: '',
    releaseName: '',
    releaseTag: '',
    releaseUrl: GITHUB_RELEASES_PAGE,
  })

  function dismissUpdateBanner() {
    if (updateState.releaseTag) sessionStorage.setItem('updateBannerDismissed', updateState.releaseTag)
    setShowUpdateBanner(false)
  }

  const refreshUpdateStatus = useCallback(async () => {
    setUpdateState(prev => ({
      ...prev,
      status: 'checking',
      channel: updateChannel,
      error: '',
    }))
    try {
      const next = await fetchUpdateStatus(updateChannel)
      setUpdateState({
        ...next,
        status: 'ready',
      })
    } catch (error) {
      setUpdateState(prev => ({
        ...prev,
        status: 'error',
        channel: updateChannel,
        checkedAt: Date.now(),
        available: false,
        error: error?.message || 'Unable to reach GitHub releases',
      }))
    }
  }, [updateChannel])

  useEffect(() => {
    localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, updateChannel)
  }, [updateChannel])

  useEffect(() => {
    refreshUpdateStatus()
    const timer = window.setInterval(() => {
      refreshUpdateStatus()
    }, 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [refreshUpdateStatus])

  useEffect(() => {
    if (!updateState.available || !updateState.releaseTag) {
      setShowUpdateBanner(false)
      return
    }
    const dismissedTag = sessionStorage.getItem('updateBannerDismissed')
    setShowUpdateBanner(dismissedTag !== updateState.releaseTag)
  }, [updateState.available, updateState.releaseTag])

  useEffect(() => {
    const saved = localStorage.getItem('nocturnal_saved_devices')
    if (saved) try { setSavedDevices(JSON.parse(saved)) } catch {
      // Ignore corrupt saved-device payloads and start fresh.
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('nocturnal_saved_devices', JSON.stringify(savedDevices))
  }, [savedDevices])

  useEffect(() => {
    localStorage.setItem('nocturnal_saved_device_history', JSON.stringify(savedDeviceHistory))
  }, [savedDeviceHistory])

  function recordSavedDeviceHistory(entry) {
    setSavedDeviceHistory(prev => [
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        ...entry,
      },
      ...prev,
    ].slice(0, 40))
  }

  useEffect(() => {
    function applyTheme(t) {
      let resolved = t
      if (t === 'system') {
        resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      document.documentElement.setAttribute('data-theme', resolved)
    }
    applyTheme(theme)
    localStorage.setItem('theme', theme)
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme('system')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

  // Detect host platform so the UI can adapt
  useEffect(() => {
    const preview = previewPlatformOverride()
    if (preview) {
      setPlatform(preview)
      return
    }
    invoke('get_platform').then(p => setPlatform(p)).catch(() => setPlatform('desktop'))
  }, [])

  // Orientation detection is Android-only so desktop stays untouched.
  useEffect(() => {
    if (platform !== 'android') {
      setDrawerOpen(false)
      setOrientation('portrait')
      return
    }
    const update = () => setOrientation(window.innerWidth > window.innerHeight ? 'landscape' : 'portrait')
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [platform])

  // Redirect desktop-only panels away on Android.
  useEffect(() => {
    if (platform === 'android' && ANDROID_HIDDEN_PANELS.has(activePanel)) {
      setActivePanel('devices')
    }
  }, [platform, activePanel])

  useEffect(() => {
    if (platform !== 'windows' && NON_WINDOWS_HIDDEN_PANELS.has(activePanel)) {
      setActivePanel('help')
    }
  }, [platform, activePanel])

  useEffect(() => {
    if (platform !== 'android') {
      androidHistoryRef.current = { ready: false, syncingPop: false, key: '' }
      return
    }
    const stateKey = drawerOpen ? `menu:${activePanel}` : `panel:${activePanel}`
    const state = { ntkScreen: stateKey }
    if (!androidHistoryRef.current.ready) {
      window.history.replaceState(state, '')
      androidHistoryRef.current = { ready: true, syncingPop: false, key: stateKey }
      return
    }
    if (androidHistoryRef.current.syncingPop) {
      androidHistoryRef.current = { ...androidHistoryRef.current, syncingPop: false, key: stateKey }
      return
    }
    if (androidHistoryRef.current.key !== stateKey) {
      window.history.pushState(state, '')
      androidHistoryRef.current = { ...androidHistoryRef.current, key: stateKey }
    }
  }, [platform, activePanel, drawerOpen])

  useEffect(() => {
    if (platform !== 'android') return
    const onPopState = event => {
      const key = event.state?.ntkScreen
      androidHistoryRef.current = { ...androidHistoryRef.current, syncingPop: true }
      if (typeof key === 'string') {
        if (key.startsWith('menu:')) {
          setActivePanel(key.slice(5))
          setDrawerOpen(true)
          return
        }
        if (key.startsWith('panel:')) {
          setActivePanel(key.slice(6))
          setDrawerOpen(false)
          return
        }
      }
      setDrawerOpen(false)
      setActivePanel('devices')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [platform])

  // Device watcher — auto-selects first connected device
  useEffect(() => {
    let unlisten
    listen('devices:changed', (event) => {
      const next = event.payload
      setDevices(next)
      setReady(true)
      setSelected(prev => {
        if (prev) return next.find(d => d.serial === prev.serial) ?? null
        return next.find(d => d.status === 'device') ?? null
      })
    }).then(fn => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  // Fetch props when selected device changes
  useEffect(() => {
    if (!selected) { setProps(null); return }
    setLoading(true)
    setProps(null)
    const s = selected.serial
    Promise.all([
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.build.version.release'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'dumpsys', 'battery'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'df', '/data'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.board.platform'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'cat', '/proc/meminfo'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'dumpsys', 'display'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.build.display.id'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.build.version.security_patch'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'uname', '-r'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.product.manufacturer'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.product.model'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'ro.bootloader'] }),
      invoke('run_adb', { args: ['-s', s, 'shell', 'getprop', 'gsm.version.baseband'] }),
    ]).then(([
      androidRes, batteryRes, dfRes,
      chipsetRes, meminfoRes, displayRes,
      buildRes, patchRes, kernelRes,
      manufacturerRes, modelRes, bootloaderRes, basebandRes,
    ]) => {
      const trim = r => r.stdout?.trim() || null
      setProps({
        android:      androidRes.stdout?.trim() ?? '',
        battery:      parseBattery(batteryRes.stdout ?? ''),
        storage:      parseDf(dfRes.stdout ?? ''),
        chipset:      trim(chipsetRes),
        ram:          parseMeminfo(meminfoRes.stdout ?? ''),
        resolution:   parseResolution(displayRes.stdout ?? ''),
        build:        trim(buildRes),
        secPatch:     trim(patchRes),
        kernel:       trim(kernelRes),
        manufacturer: trim(manufacturerRes),
        hwModel:      trim(modelRes),
        bootloader:   trim(bootloaderRes),
        baseband:     trim(basebandRes),
      })
    }).finally(() => setLoading(false))
  }, [selected])

  const reboot = useCallback(async (args) => {
    await invoke('run_adb', { args })
  }, [])

  const scan = useCallback(() => {
    setScanning(true)
    setTimeout(() => setScanning(false), 1500)
  }, [])

  function renderPanel() {
    const nav = () => setActivePanel('devices')
    switch (activePanel) {
      case 'getting-started': return <HelpDocsPanel onShowWelcome={() => setShowWelcome(true)} mode="getting-started" onOpenPanel={setActivePanel} />
      case 'devices':  return <PhonesPanel devices={devices} ready={ready} selected={selected} onSelect={setSelected} props={props} loading={loading} onReboot={reboot} savedDevices={savedDevices} savedDeviceHistory={savedDeviceHistory} onSaveDevice={d => setSavedDevices(prev => [...prev, d])} onRemoveSaved={id => setSavedDevices(prev => prev.filter(d => d.id !== id))} onUpdateSaved={(id, name) => setSavedDevices(prev => prev.map(d => d.id === id ? { ...d, name } : d))} onReplaceSaved={items => setSavedDevices(items)} onClearSavedHistory={() => setSavedDeviceHistory([])} onRecordSavedHistory={recordSavedDeviceHistory} pairSectionOpen={pairSectionOpen} onPairSectionToggle={setPairSectionOpen} platform={platform} onOpenPanel={setActivePanel} />
      case 'install':  return <InstallApkPanel device={selected} onNavigateToDevices={nav} externalQueue={sharedInstallQueue} onExternalQueueConsumed={() => setSharedInstallQueue([])} platform={platform} />
      case 'search':   return <SearchApkPanel device={selected} onNavigateToDevices={nav} onNavigateToInstall={() => setActivePanel('install')} onAddToQueue={item => setSharedInstallQueue(q => [...q, item])} platform={platform} />
      case 'stores':   return <AppStoresPanel device={selected} onNavigateToDevices={nav} platform={platform} />
      case 'manage':   return <ManageAppsPanel device={selected} deviceProps={props} onNavigateToDevices={nav} onOpenPanel={setActivePanel} />
      case 'backups':  return <BackupsPanel device={selected} deviceProps={props} onNavigateToDevices={nav} onOpenPanel={setActivePanel} />
      case 'phone':    return <PhoneToolsPanel device={selected} deviceProps={props} onNavigateToDevices={nav} platform={platform} onOpenPanel={setActivePanel} />
      case 'adb':      return <AdbLogsPanel device={selected} onNavigateToDevices={nav} platform={platform} />
      case 'tv':       return <TVPanel device={selected} onNavigateToDevices={nav} />
      case 'quest':    return <QuestPanel device={selected} onNavigateToDevices={nav} platform={platform} />
      case 'files':    return <FilesPanel device={selected} onNavigateToDevices={nav} />
      case 'rom':      return <RomPanel device={selected} onNavigateToDevices={nav} />
      case 'general':  return <PhoneToolsPanel device={selected} deviceProps={props} onNavigateToDevices={nav} platform={platform} onOpenPanel={setActivePanel} />
      case 'maintenance': return <PhoneToolsPanel device={selected} deviceProps={props} onNavigateToDevices={nav} platform={platform} onOpenPanel={setActivePanel} />
      case 'companion': return <DesktopDeviceCompanionPanel device={selected} onNavigateToDevices={nav} onOpenPanel={setActivePanel} />
      case 'drivers':  return platform === 'windows' ? <DriversPanel platform={platform} /> : <HelpDocsPanel onShowWelcome={() => setShowWelcome(true)} />
      case 'advanced': return <AdvancedPanel device={selected} deviceProps={props} onNavigateToDevices={nav} platform={platform} onOpenPanel={setActivePanel} />
      case 'help':     return <HelpDocsPanel onShowWelcome={() => setShowWelcome(true)} mode="help" onOpenPanel={setActivePanel} />
      case 'about':    return <HelpDocsPanel onShowWelcome={() => setShowWelcome(true)} mode="about" onOpenPanel={setActivePanel} />
      default:         return <PanelPlaceholder label={activePanel} />
    }
  }

  // Android menu sections — exclude desktop-only panels
  const androidNavSections = NAV_SECTIONS.map(s => ({
    ...s,
    items: s.items.filter(item => !ANDROID_HIDDEN_PANELS.has(item.id)),
  })).filter(section => section.items.length > 0)

  const desktopNavSections = NAV_SECTIONS.map(section => ({
    ...section,
    items: section.items.filter(item => !(platform !== 'windows' && NON_WINDOWS_HIDDEN_PANELS.has(item.id))),
  })).filter(section => section.items.length > 0)

  const currentNavItem = (platform === 'android' ? androidNavSections : desktopNavSections)
    .flatMap(s => s.items)
    .find(i => i.id === activePanel)
  const isAndroidPortrait = platform === 'android' && orientation === 'portrait'
  const isAndroidLandscape = platform === 'android' && orientation === 'landscape'

  return (
    <div className="app-layout">
      {showWelcome && <WelcomeScreen onDismiss={() => setShowWelcome(false)} />}
      <Titlebar devices={devices} scanning={scanning} onScan={scan} theme={theme} onTheme={setTheme} platform={platform} />
      {showUpdateBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '7px 16px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
        }}>
          <span style={{ flex: 1, color: 'var(--text-primary)' }}>
            {updateState.channel === 'nightly'
              ? `A nightly build of Android Toolkit is available${updateState.releaseTag ? ` — ${updateState.releaseTag}` : ''}`
              : `A new version of Android Toolkit is available — v${updateState.latestVersion}`}
          </span>
          <button
            onClick={() => openUrl(updateState.releaseUrl || GITHUB_RELEASES_PAGE)}
            style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0, fontWeight: 600 }}
          >
            Download
          </button>
          <button
            onClick={dismissUpdateBanner}
            style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
            aria-label="Dismiss update banner"
          >
            ×
          </button>
        </div>
      )}
      <div className="body-layout">

        {/* Sidebar — desktop only */}
        {platform !== 'android' && (
          <div className="sidebar">
            <div className="sidebar-nav-scroll">
              {desktopNavSections.map(section => (
                <div key={section.label}>
                  {!section.standalone && (
                    <div
                      className="sidebar-section-label"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                      onClick={() => setDesktopNavOpen(prev => ({ ...prev, [section.label]: !prev[section.label] }))}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {section.icon && <span>{section.icon}</span>}
                        <span>{section.label}</span>
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', transform: desktopNavOpen[section.label] ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                    </div>
                  )}
                  {(section.standalone || desktopNavOpen[section.label]) && section.items.map(item => (
                    <div
                      key={item.id}
                      className={`nav-item${activePanel === item.id ? ' active' : ''}`}
                      onClick={() => setActivePanel(item.id)}
                      style={{ display: 'flex', alignItems: 'center' }}
                    >
                      <span style={{ marginRight: 7 }}>{item.icon}</span>
                      {item.label}
                      {item.badge && (
                        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 'var(--font-bold)', color: 'var(--accent)', background: 'rgba(168,85,247,0.15)', padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>{item.badge}</span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <SidebarDeviceCard
              device={selected}
              props={props}
              onPairDevice={() => { setActivePanel('devices'); setPairSectionOpen(true) }}
              currentVersion={DISPLAY_VERSION}
              updateChannel={updateChannel}
              onUpdateChannelChange={setUpdateChannel}
              onUpdateAction={() => {
                if (updateState.available && updateState.releaseUrl) {
                  openUrl(updateState.releaseUrl)
                  return
                }
                refreshUpdateStatus()
              }}
              updateState={updateState}
            />
          </div>
        )}

        {/* Main content */}
        <main
          className={`main-content${platform === 'android' ? ' android-content' : ''}`}
          style={{
            paddingRight: isAndroidLandscape ? 48 : 0,
          }}
        >
          {renderPanel()}
        </main>

      </div>

      {/* Android navigation — hamburger drawer system */}
      {platform === 'android' && (
        <>
          {/* Full-screen Android menu */}
          {drawerOpen && (
            <div
              style={{
                position: 'fixed', inset: 0, zIndex: 2000,
                background: 'var(--bg-base)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--bg-surface)',
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => setDrawerOpen(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-primary)',
                    fontSize: 24,
                    lineHeight: 1,
                    padding: '8px 10px',
                    borderRadius: 10,
                    minWidth: 44,
                    minHeight: 44,
                  }}
                >
                  ←
                </button>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 20, fontWeight: 'var(--font-bold)', color: 'var(--text-primary)', marginBottom: 2 }}>
                    Main Menu
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    Android Toolkit for Android
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 22px' }}>
                <div style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '14px 16px',
                  marginBottom: 16,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 5 }}>
                    Current Page
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
                    {currentNavItem?.label ?? activePanel}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.45 }}>
                    {ANDROID_MENU_DESCRIPTIONS[activePanel] ?? 'Open a section to keep working on this device.'}
                  </div>
                </div>

                {androidNavSections.map(section => (
                  <div key={section.label} style={{ marginBottom: 18 }}>
                    {!section.standalone && (
                      <div style={{
                        fontSize: 12,
                        fontWeight: 'var(--font-bold)',
                        color: 'var(--text-muted)',
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        marginBottom: 10,
                        padding: '0 2px',
                      }}>
                        {section.label}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {section.items.map(item => {
                        const active = activePanel === item.id
                        return (
                          <button
                            key={item.id}
                            onClick={() => { setActivePanel(item.id); setDrawerOpen(false) }}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              background: active ? 'rgba(168,85,247,0.10)' : 'var(--bg-surface)',
                              border: `1px solid ${active ? 'rgba(168,85,247,0.35)' : 'var(--border)'}`,
                              borderRadius: 'var(--radius-lg)',
                              padding: '16px 16px',
                              minHeight: 78,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 14,
                              color: 'var(--text-primary)',
                              fontFamily: 'inherit',
                            }}
                          >
                            <div style={{
                              width: 42,
                              height: 42,
                              borderRadius: 12,
                              background: active ? 'rgba(168,85,247,0.12)' : 'var(--bg-elevated)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 20,
                              flexShrink: 0,
                            }}>
                              {item.icon}
                            </div>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 17, fontWeight: 'var(--font-semibold)', color: 'var(--text-primary)' }}>
                                  {item.label}
                                </span>
                                {item.badge && (
                                  <span style={{
                                    fontSize: 9,
                                    fontWeight: 'var(--font-bold)',
                                    color: 'var(--accent)',
                                    background: 'rgba(168,85,247,0.15)',
                                    padding: '2px 6px',
                                    borderRadius: 99,
                                    letterSpacing: '0.05em',
                                  }}>
                                    {item.badge}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                                {ANDROID_MENU_DESCRIPTIONS[item.id] ?? 'Open this section'}
                              </div>
                            </div>
                            <span style={{ fontSize: 20, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>›</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}

                <div style={{
                  marginTop: 8,
                  background: 'rgba(20,184,166,0.06)',
                  border: '1px solid rgba(20,184,166,0.18)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 'var(--font-bold)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-teal)', marginBottom: 6 }}>
                    Android Note
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    This Android app is designed to stay easy to read and touch-friendly. Local-device tools come first, and remote ADB actions are available without turning the mobile UI into a desktop clone.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Bottom bar — portrait mode */}
          {isAndroidPortrait && !drawerOpen && (
            <div style={{
              position: 'fixed', bottom: 0, left: 0, right: 0,
              height: 'calc(64px + env(safe-area-inset-bottom, 0px))',
              background: 'var(--bg-surface)',
              borderTop: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              zIndex: 1000,
              boxSizing: 'border-box',
              padding: '0 10px env(safe-area-inset-bottom, 0px)',
            }}>
              <button
                onClick={() => setDrawerOpen(true)}
                style={{
                  background: 'transparent', border: 'none',
                  fontSize: 30, cursor: 'pointer',
                  color: 'var(--text-primary)', padding: '0',
                  width: 56, height: 56,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                ☰
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Main Menu</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentNavItem?.label ?? activePanel}
                </span>
              </div>
            </div>
          )}

          {/* Right rail — landscape mode */}
          {isAndroidLandscape && !drawerOpen && (
            <div style={{
              position: 'fixed', right: 0, top: 0, bottom: 0,
              width: 48,
              background: 'var(--bg-surface)',
              borderLeft: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000,
            }}>
              <button
                onClick={() => setDrawerOpen(true)}
                style={{
                  background: 'transparent', border: 'none',
                  fontSize: 28, cursor: 'pointer',
                  color: 'var(--text-primary)', padding: '10px 12px',
                  minWidth: 44, minHeight: 52,
                }}
              >
                ☰
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function App() {
  return isLiveViewPopupMode() ? <LiveViewPopupWindow /> : <MainApp />
}
