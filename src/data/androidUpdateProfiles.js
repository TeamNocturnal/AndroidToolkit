const profiles = [
  { id: 'amazon', label: 'Amazon Fire OS', match: /amazon/, packages: ['com.amazon.device.software.ota', 'com.amazon.device.software.ota.override', 'com.amazon.tv.forcedotaupdater.v2'] },
  { id: 'samsung', label: 'Samsung', match: /samsung/, packages: ['com.wssyncmldm', 'com.sec.android.soagent', 'com.samsung.sdm'] },
  { id: 'motorola', label: 'Motorola', match: /motorola/, packages: ['com.motorola.ccc.ota', 'com.motorola.android.fota'] },
  { id: 'oneplus', label: 'OnePlus', match: /oneplus/, packages: ['com.oneplus.opbackup', 'com.oplus.ota', 'com.coloros.sau'] },
  { id: 'oppo', label: 'OPPO / Realme', match: /oppo|realme/, packages: ['com.oppo.ota', 'com.oplus.ota', 'com.coloros.sau'] },
  { id: 'vivo', label: 'Vivo / iQOO', match: /vivo|iqoo/, packages: ['com.bbk.updater'] },
  { id: 'asus', label: 'ASUS', match: /asus/, packages: ['com.asus.dm'] },
  { id: 'sony', label: 'Sony', match: /sony/, packages: ['com.sonyericsson.updatecenter'] },
  { id: 'tcl', label: 'TCL / Alcatel', match: /tcl|alcatel|\btct\b/, packages: ['com.tcl.fota.system'] },
  { id: 'lg', label: 'LG', match: /\blg\b|lge/, packages: ['com.lge.lgdmsclient'] },
  { id: 'xiaomi', label: 'Xiaomi / Redmi / POCO', match: /xiaomi|redmi|poco/, packages: [], note: 'The MIUI updater is excluded because disabling it can be unsafe on some firmware. Use the available automatic-install preference or the device’s update settings.' },
  { id: 'huawei', label: 'Huawei / Honor', match: /huawei|honor/, packages: [], note: 'No updater app is disabled automatically for this family. Use the available automatic-install preference or the device’s update settings.' },
  { id: 'onn', label: 'ONN', match: /\bonn\b/, packages: [] },
  { id: 'nvidia', label: 'NVIDIA Shield', match: /nvidia/, packages: [] },
  { id: 'google', label: 'Google / Android', match: /google/, packages: [] },
  { id: 'hisense', label: 'Hisense', match: /hisense/, packages: [] },
  { id: 'philips', label: 'Philips', match: /philips|tp.?vision/, packages: [] },
  { id: 'lenovo', label: 'Lenovo', match: /lenovo/, packages: [] },
  { id: 'nokia', label: 'Nokia / HMD', match: /nokia|\bhmd\b/, packages: [] },
  { id: 'zte', label: 'ZTE / Nubia', match: /\bzte\b|nubia/, packages: [] },
  { id: 'meta', label: 'Meta / Quest', match: /oculus|meta/, packages: [] },
]

export function androidUpdateProfile(manufacturer, brand) {
  const identity = `${manufacturer} ${brand}`.toLowerCase()
  return profiles.find(profile => profile.match.test(identity)) || { id: 'generic', label: 'Android device', packages: [] }
}

export function allowedUpdatePackages(identity) {
  return [...androidUpdateProfile(identity.manufacturer, identity.brand).packages, 'com.adups.fota']
}

export const AUTOMATIC_UPDATE_KEY = 'ota_disable_automatic_update'
