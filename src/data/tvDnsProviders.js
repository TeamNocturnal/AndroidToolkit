const google = 'https://developers.google.com/speed/public-dns/docs/using'
const cloudflare = 'https://developers.cloudflare.com/1.1.1.1/setup/android/'
const adguard = 'https://adguard-dns.io/en/public-dns.html'
const quad9 = 'https://docs.quad9.net/services/'
const clean = 'https://cleanbrowsing.org/filters/'
const control = 'https://docs.controld.com/docs/free-dns'

export const TV_DNS_PROVIDERS = [
  { id: 'automatic', group: 'Device defaults', name: 'Automatic', mode: 'opportunistic', host: null, description: 'Use the DNS supplied by your network. Try encryption when available; no added content filtering.' },
  { id: 'off', group: 'Device defaults', name: 'Private DNS off', mode: 'off', host: null, description: 'Turn off Android Private DNS. Network or router filtering can still apply.' },
  { id: 'google', group: 'Google', name: 'Google Public DNS', host: 'dns.google', description: 'General-purpose DNS. No ad blocking or adult-content filter.', source: google },
  { id: 'cloudflare', group: 'Cloudflare', name: 'Standard', host: 'one.one.one.one', description: 'General-purpose DNS without malware, ad, or adult-content filtering.', source: cloudflare },
  { id: 'cloudflare-security', group: 'Cloudflare', name: 'Malware blocking', host: 'security.cloudflare-dns.com', description: 'Blocks known malware domains. Does not add ad blocking or an adult-content filter.', source: cloudflare },
  { id: 'cloudflare-family', group: 'Cloudflare', name: 'Malware + adult content', host: 'family.cloudflare-dns.com', description: 'Blocks malware and adult-content domains. Does not add ad blocking.', source: cloudflare },
  { id: 'adguard', group: 'AdGuard', name: 'Ads & trackers', host: 'dns.adguard-dns.com', description: 'Blocks advertising and tracking domains. Does not add an adult-content filter.', source: adguard },
  { id: 'adguard-family', group: 'AdGuard', name: 'Family protection', host: 'family.adguard-dns.com', description: 'Blocks ads, trackers, and adult-content domains. Requests SafeSearch and restricted modes where supported.', source: adguard },
  { id: 'adguard-unfiltered', group: 'AdGuard', name: 'Unfiltered', host: 'unfiltered.adguard-dns.com', description: 'AdGuard DNS without ad, tracker, or content blocking.', source: adguard },
  { id: 'quad9', group: 'Quad9', name: 'Threat blocking', host: 'dns.quad9.net', description: 'Blocks domains linked to threats such as malware and phishing. No ad or adult-content filter.', source: quad9 },
  { id: 'quad9-unfiltered', group: 'Quad9', name: 'No threat blocking', host: 'dns10.quad9.net', description: 'Quad9 without threat filtering. No ad or adult-content filter.', source: quad9 },
  { id: 'clean-security', group: 'CleanBrowsing', name: 'Security', host: 'security-filter-dns.cleanbrowsing.org', description: 'Blocks malicious, phishing, and spam domains. Does not block adult content.', source: clean },
  { id: 'clean-adult', group: 'CleanBrowsing', name: 'Adult filter', host: 'adult-filter-dns.cleanbrowsing.org', description: 'Adds adult-domain filtering and Google/Bing SafeSearch to security blocking. Mixed-content sites and VPN domains remain allowed.', source: clean },
  { id: 'clean-family', group: 'CleanBrowsing', name: 'Family filter', host: 'family-filter-dns.cleanbrowsing.org', description: 'Stricter adult filtering, including mixed-content sites and proxy/VPN domains. Requests Google, Bing, and YouTube safe modes.', source: clean },
  { id: 'control-unfiltered', group: 'Control D', name: 'Unfiltered', host: 'p0.freedns.controld.com', description: 'General-purpose DNS without the optional filtering lists.', source: control },
  { id: 'control-malware', group: 'Control D', name: 'Malware', host: 'p1.freedns.controld.com', description: 'Blocks domains on the malware filter list.', source: control },
  { id: 'control-ads', group: 'Control D', name: 'Ads & tracking', host: 'p2.freedns.controld.com', description: 'Blocks malware plus advertising and tracking domains.', source: control },
  { id: 'control-social', group: 'Control D', name: 'Social', host: 'p3.freedns.controld.com', description: 'Adds social-media blocking to malware and ad filtering. Social features in apps can stop working.', source: control },
  { id: 'control-family', group: 'Control D', name: 'Family friendly', host: 'family.freedns.controld.com', description: 'Uses the family preset, filtering malware, ads, social media, adult content, and drugs.', source: control },
  { id: 'control-uncensored', group: 'Control D', name: 'Uncensored', host: 'uncensored.freedns.controld.com', description: 'Uses Control D’s uncensored resolver. No ad or family filtering.', source: control },
  { id: 'nextdns', group: 'Personal profiles', name: 'NextDNS profile', custom: true, description: 'Use your profile’s Private DNS hostname. Ads, security, adult categories, SafeSearch, and logging follow the choices in your NextDNS dashboard.', source: 'https://nextdns.io/' },
  { id: 'custom', group: 'Personal profiles', name: 'Custom provider or profile', custom: true, description: 'Enter a DNS-over-TLS hostname from your provider. Personal AdGuard and Control D profiles also go here.' },
]

export function isDnsHostname(host) {
  return typeof host === 'string' && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
}

export function tvDnsTarget(id, customHost = '') {
  const provider = TV_DNS_PROVIDERS.find(item => item.id === id)
  if (!provider) throw new Error('Choose a DNS provider.')
  const host = provider.custom ? customHost.trim().toLowerCase() : provider.host
  if (!provider.mode && !isDnsHostname(host)) throw new Error('Enter a Private DNS hostname, not an IP address or URL.')
  return { mode: provider.mode || 'hostname', host: host || null }
}
