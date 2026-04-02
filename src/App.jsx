import './App.css'
import appIcon from './assets/site/app-icon.png'
import darkGettingStarted from './assets/site/dark-getting-started.png'
import darkDevices from './assets/site/dark-devices.png'
import darkSearch from './assets/site/dark-search.png'
import darkStores from './assets/site/dark-stores.png'
import darkManageApps from './assets/site/dark-manage-apps.png'
import darkBackups from './assets/site/dark-backups.png'
import darkAdbShell from './assets/site/dark-adb-shell.png'
import darkRomTools from './assets/site/dark-rom-tools.png'

const highlights = [
  {
    title: 'A proper GUI for ADB work',
    text:
      'Install apps, pair devices, browse files, run shell commands, stream logs, and manage packages without bouncing between terminal windows.',
  },
  {
    title: 'Built for real Android workflows',
    text:
      'Phones, tablets, Quest headsets, Fire TV devices, Android TV boxes, and modding setups all fit naturally into the same toolkit.',
  },
  {
    title: 'Fast enough for power users',
    text:
      'The goal is not a toy wrapper. It is a serious desktop utility for people who sideload often, troubleshoot often, and want less friction.',
  },
]

const featureList = [
  'Install APK, XAPK, and split packages',
  'Search Android app sources from one place',
  'Manage installed apps, backups, and restores',
  'USB and wireless ADB device support',
  'ADB shell, logcat, and port forwarding',
  'File browser and desktop-to-device transfers',
  'Quest, streaming-device, and ROM workflows',
  'Still actively evolving toward a fuller public release',
]

const audienceCards = [
  {
    title: 'Quest and VR users',
    text: 'Sideload apps, stores, and tools onto headsets without living in terminal commands.',
  },
  {
    title: 'ROM and Android modders',
    text: 'A cleaner desktop surface for the same device-management work you already know.',
  },
  {
    title: 'Power users',
    text: 'For people juggling backups, package cleanup, wireless debugging, file transfers, and app installs often.',
  },
  {
    title: 'Support people',
    text: 'Useful when you are the one helping friends or clients set up Android hardware the easy way.',
  },
]

const gallery = [
  {
    image: darkGettingStarted,
    title: 'Getting Started',
    text: 'Clear setup guidance for USB debugging, wireless ADB, and first-run onboarding.',
  },
  {
    image: darkDevices,
    title: 'Connected Devices',
    text: 'Device status, saved connections, pair and connect flows, and live hardware details.',
  },
  {
    image: darkSearch,
    title: 'Search APKs',
    text: 'Search across multiple Android app sources with a cleaner desktop workflow.',
  },
  {
    image: darkStores,
    title: 'App Stores',
    text: 'Install and manage the alternative stores people actually use.',
  },
  {
    image: darkManageApps,
    title: 'Manage Apps',
    text: 'Launch, clear data, back up, and uninstall packages from one list.',
  },
  {
    image: darkBackups,
    title: 'Backup and Restore',
    text: 'Keep backups organized and restore them without digging through folders.',
  },
  {
    image: darkAdbShell,
    title: 'ADB and Shell',
    text: 'Run shell commands, watch logs, and handle deeper Android work from the same interface.',
  },
  {
    image: darkRomTools,
    title: 'ROM Tools',
    text: 'Bootloader, fastboot, flashing, and recovery workflows for people doing deeper Android modification work.',
  },
]

function App() {
  return (
    <div className="page">
      <header className="site-header">
        <div className="brand">
          <img className="brand__icon" src={appIcon} alt="Nocturnal Toolkit icon" />
          <div className="brand__text">
            <strong>Nocturnal Toolkit</strong>
            <span>Team Nocturnal</span>
          </div>
        </div>

        <nav className="site-nav">
          <a href="#features">Features</a>
          <a href="#gallery">Screenshots</a>
          <a href="#audience">Who It&apos;s For</a>
          <a href="#status">Status</a>
        </nav>

        <a
          className="header-link"
          href="https://forums.wbodytech.com/%E2%9A%A1-nocturnal-toolkit-by-team-nocturnal.t239/"
          target="_blank"
          rel="noreferrer"
        >
          Forum thread
        </a>
      </header>

      <main className="page-content">
        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow">Android device manager and APK installer</p>
            <h1>A clean desktop toolkit for sideloading, managing, and working with Android devices.</h1>
            <p className="hero__lede">
              Nocturnal Toolkit brings installs, app search, device pairing, backups, file tools, shell access, and other ADB-powered workflows into one polished desktop app for macOS and Windows.
            </p>
            <p className="hero__sublede">
              It is designed for Android enthusiasts, modders, Quest users, streaming-device tinkerers, and anyone tired of stitching together ten different utilities just to get real work done.
            </p>

            <div className="hero__actions">
              <a
                className="button button--primary"
                href="https://forums.wbodytech.com/%E2%9A%A1-nocturnal-toolkit-by-team-nocturnal.t239/"
                target="_blank"
                rel="noreferrer"
              >
                Follow development
              </a>
              <a className="button button--secondary" href="#gallery">
                View screenshots
              </a>
            </div>

            <div className="hero__meta">
              <span>macOS arm64</span>
              <span>Windows x64</span>
              <span>ADB-powered workflows</span>
              <span>Coming soon</span>
            </div>
          </div>

          <div className="hero__visual">
            <div className="window-frame">
              <div className="window-frame__bar">
                <span />
                <span />
                <span />
              </div>
              <img src={darkGettingStarted} alt="Nocturnal Toolkit getting started screen" />
            </div>
          </div>
        </section>

        <section className="section" id="features">
          <div className="section-heading">
            <p className="eyebrow">What it is</p>
            <h2>A modern desktop front end for the Android tasks people usually handle the hard way.</h2>
          </div>

          <div className="highlight-grid">
            {highlights.map((item) => (
              <article className="card" key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>

          <div className="feature-panel">
            <div className="feature-panel__copy">
              <p className="eyebrow">What it does</p>
              <h3>Everything from quick installs to deeper device work.</h3>
              <p>
                Nocturnal Toolkit exists to make ADB-heavy workflows easier to start, easier to repeat, and easier to understand. It is not trying to look flashy for its own sake. It is trying to make Android utility work feel clean.
              </p>
            </div>

            <div className="feature-list">
              {featureList.map((item) => (
                <div className="feature-list__item" key={item}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="gallery">
          <div className="section-heading">
            <p className="eyebrow">Screenshots</p>
            <h2>Built to look clean in both dark and light mode, with theme switching and system-theme support.</h2>
            <p className="section-copy">
              Nocturnal Toolkit follows your system theme by default, supports both dark and light modes, and lets you switch between them manually inside the app. The same UI also scales from quick installs and package management to advanced device and ROM workflows.
            </p>
          </div>

          <div className="gallery-grid">
            {gallery.map((shot) => (
              <figure className="shot-card" key={shot.title}>
                <div className="window-frame window-frame--small">
                  <div className="window-frame__bar">
                    <span />
                    <span />
                    <span />
                  </div>
                  <img src={shot.image} alt={shot.title} />
                </div>
                <figcaption>
                  <strong>{shot.title}</strong>
                  <span>{shot.text}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="section section--split" id="audience">
          <div className="section-heading">
            <p className="eyebrow">Who it&apos;s for</p>
            <h2>Made for people who actually use Android tools.</h2>
          </div>

          <div className="audience-grid">
            {audienceCards.map((card) => (
              <article className="card audience-card" key={card.title}>
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section status-section" id="status">
          <div className="status-card">
            <div>
              <p className="eyebrow">Current status</p>
              <h2>Still in development. Public-facing site now, fuller release later.</h2>
              <p>
                Nocturnal Toolkit is actively being developed and refined. This site is meant to clearly explain what the tool is, what it does, and who it is for while the project continues moving toward a more complete launch.
              </p>
            </div>

            <div className="status-card__actions">
              <a
                className="button button--secondary status-card__button"
                href="https://forums.wbodytech.com/%E2%9A%A1-nocturnal-toolkit-by-team-nocturnal.t239/"
                target="_blank"
                rel="noreferrer"
              >
                View forum thread
              </a>
              <span className="status-pill">Coming soon</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
