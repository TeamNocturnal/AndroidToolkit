export const TV_OPTIONAL_APPS = [
  { id: 'com.google.android.play.games', name: 'Google Play Games' },
  { id: 'com.google.android.youtube.tvmusic', name: 'YouTube Music' },
  { id: 'com.google.android.apps.youtube.music.tv', name: 'YouTube Music' },
  { id: 'com.google.android.videos', name: 'Google TV movies and purchases' },
  { id: 'com.google.android.music', name: 'Google Play Music' },
  { id: 'com.google.android.youtube.tv', name: 'YouTube' },
  { id: 'com.netflix.ninja', name: 'Netflix' },
  { id: 'com.amazon.amazonvideo.livingroom', name: 'Prime Video' },
  { id: 'com.disney.disneyplus', name: 'Disney+' },
  { id: 'com.spotify.tv.android', name: 'Spotify' },
  { id: 'com.hulu.livingroomplus', name: 'Hulu' },
  { id: 'tv.pluto.android', name: 'Pluto TV' },
  { id: 'com.plexapp.android', name: 'Plex' },
  { id: 'org.xbmc.kodi', name: 'Kodi' },
]

export function tvDemoGuide(manufacturer) {
  const maker = String(manufacturer || '').toLowerCase()
  if (/sony/.test(maker)) return {
    text: 'In TV Settings, find Retail mode settings under System or Device Preferences. Turn off Demo mode and Picture reset mode.',
    url: 'https://www.sony.com/electronics/support/articles/00050389',
  }
  if (/tcl/.test(maker)) return {
    text: 'In TV Settings, look under System → Advanced Settings → Usage Mode and choose Home Mode. Menu names vary by firmware.',
    url: 'https://support.tcl.com/en_US/how-to-switch-your-tcl-google-tv-from-store-mode-to-home-mode',
  }
  if (/hisense/.test(maker)) return {
    text: 'In TV Settings, look under System → Advanced System. Turn Store Mode off, or choose Home Mode in Store Mode Settings.',
    url: 'https://files.hisense-usa.com/download/f2565f9cb1a82ad4',
  }
  if (/philips|tp vision|tpvision/.test(maker)) return {
    text: 'Find Location or Retail mode settings in TV Settings and choose Home instead of Shop. Older firmware may put Location under Preferences.',
    url: 'https://www.philips.co.uk/c-f/XC000015786/what-to-do-when-information-about-philips-tv-appears-on-the-screen-shop-mode',
  }
  if (/xiaomi|redmi/.test(maker)) return {
    text: 'In TV Settings, look under All settings → System → TV Mode and choose Home Mode. Follow the guide for your firmware if the menu differs.',
    url: 'https://www.mi.com/global/support/faq/details/KA-367537/',
  }
  return {
    text: 'In device Settings, look for Store, Shop, Retail, Demo, or Usage Mode and select Home or Off. If no such menu exists, check the manufacturer’s instructions. The optimizer cannot determine every vendor’s shop-mode state.',
    url: null,
  }
}
