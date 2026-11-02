use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq)]
enum PackageKind {
    Apk,
    Bundle,
}

fn package_kind(path: &Path) -> Result<PackageKind, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive=zip::ZipArchive::new(file).map_err(|_|"This file is not a valid APK or APK bundle. If a website returned a download page, download the actual package in your browser.".to_string())?;
    if archive.by_name("AndroidManifest.xml").is_ok() {
        return Ok(PackageKind::Apk);
    }
    if archive.by_name("toc.pb").is_ok() {
        return Err("This APKS archive contains bundletool device variants. Export an APK set for this device, or install it with bundletool.".into());
    }
    let mut has_apk = false;
    let mut total = 0u64;
    if archive.len() > 1024 {
        return Err("The archive contains too many files".into());
    }
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        total = total.saturating_add(entry.size());
        if total > MAX_BYTES {
            return Err("The unpacked archive is larger than 1 GB".into());
        }
        let name = entry.name().to_lowercase();
        if name.ends_with(".obb") {
            return Err("This XAPK includes game data (OBB). Install it with the original store so those files are included.".into());
        }
        if name.ends_with(".apk") {
            has_apk = true;
        }
    }
    if has_apk {
        Ok(PackageKind::Bundle)
    } else {
        Err("No Android package was found in this archive".into())
    }
}

fn safe_name(name: &str) -> String {
    let filename = name.rsplit(['/', '\\']).next().unwrap_or("app.apk");
    let safe: String = filename
        .chars()
        .take(160)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() || safe.starts_with('.') {
        "app.apk".into()
    } else {
        safe
    }
}

fn progress(
    app: &tauri::AppHandle,
    key: &str,
    phase: &str,
    percent: u64,
    received: u64,
    total: Option<u64>,
    speed: &str,
) {
    let _=app.emit("install:progress",json!({"store":key,"filename":key,"phase":phase,"percent":percent,"received":crate::format_bytes(received),"total":total.map(crate::format_bytes).unwrap_or_default(),"speed":speed}));
}

async fn download(
    app: &tauri::AppHandle,
    url: &str,
    key: &str,
    path: &Path,
) -> Result<PackageKind, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid download address")?;
    if url.scheme() != "https" {
        return Err("Use an HTTPS download address".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; AndroidToolkit/3.1.0)")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download returned HTTP {}. Download the package on the provider's website, then browse for it here.",response.status()));
    }
    if response.url().scheme() != "https" {
        return Err("The download redirected to an insecure address".into());
    }
    let total = response.content_length();
    if total.is_some_and(|n| n > MAX_BYTES) {
        return Err("This package is larger than the 1 GB download limit".into());
    }
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut last = Instant::now();
    let mut previous = 0;
    progress(app, key, "downloading", 0, 0, total, "");
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received > MAX_BYTES {
            return Err("Download exceeded the 1 GB limit".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        if last.elapsed().as_millis() > 400 {
            let speed =
                crate::format_speed((received - previous) as f64 / last.elapsed().as_secs_f64());
            progress(
                app,
                key,
                "downloading",
                total
                    .filter(|n| *n > 0)
                    .map(|n| (received * 100 / n).min(99))
                    .unwrap_or(0),
                received,
                total,
                &speed,
            );
            previous = received;
            last = Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    package_kind(path)
}

pub async fn install_path(
    app: &tauri::AppHandle,
    serial: &str,
    path: &str,
) -> Result<Value, String> {
    if serial.trim().is_empty() {
        return Err("Choose a connected device first".into());
    }
    let kind = package_kind(Path::new(path))?;
    #[cfg(target_os = "android")]
    if crate::is_android_local_serial(serial) {
        if kind == PackageKind::Bundle {
            return Err(
                "Split bundles require a connected device. Use a standard APK on this device."
                    .into(),
            );
        }
        return Ok(
            json!({"ok":true,"localPath":path,"stdout":"Open the Android package installer to continue","stderr":""}),
        );
    }
    let temp = tempfile::Builder::new()
        .prefix("ntk-splits-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let mut paths = vec![path.to_string()];
    if kind == PackageKind::Bundle {
        let _ = app.emit(
            "xapk:progress",
            json!({"path":path,"message":"Extracting APK splits…"}),
        );
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        paths.clear();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if !entry.name().to_lowercase().ends_with(".apk") {
                continue;
            }
            // Numbered paths prevent collisions and never use archive-controlled directories.
            let dest = temp.path().join(format!("split-{}.apk", i));
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            drop(out);
            if package_kind(&dest)? != PackageKind::Apk {
                return Err("The archive contains an invalid APK split".into());
            }
            paths.push(dest.to_string_lossy().into());
        }
    }
    let mut args = vec![
        "-s".to_string(),
        serial.to_string(),
        if paths.len() > 1 {
            "install-multiple".into()
        } else {
            "install".into()
        },
        "-r".into(),
    ];
    args.extend(paths);
    let mut result =
        tokio::time::timeout(Duration::from_secs(180), crate::run_adb(app.clone(), args))
            .await
            .map_err(|_| {
                "Installation timed out. Check the device before retrying.".to_string()
            })??;
    let success = result["ok"] == true
        && ["stdout", "stderr"].iter().any(|k| {
            result[k]
                .as_str()
                .unwrap_or("")
                .lines()
                .any(|l| l.trim() == "Success")
        });
    result["ok"] = json!(success);
    Ok(result)
}

pub async fn download_and_install(
    app: &tauri::AppHandle,
    serial: &str,
    url: &str,
    filename: &str,
) -> Result<Value, String> {
    let temp = tempfile::Builder::new()
        .prefix("ntk-download-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = temp.path().join(safe_name(filename));
    download(app, url, filename, &path).await?;
    progress(app, filename, "installing", 100, 0, None, "");
    let result = install_path(app, serial, &path.to_string_lossy()).await?;
    #[cfg(target_os = "android")]
    if result.get("localPath").is_some() {
        let _keep = temp.keep();
        return Ok(result);
    }
    progress(
        app,
        filename,
        if result["ok"] == true {
            "done"
        } else {
            "error"
        },
        100,
        0,
        None,
        "",
    );
    Ok(result)
}

pub async fn save_download(
    app: &tauri::AppHandle,
    url: &str,
    filename: &str,
) -> Result<Value, String> {
    let temp = tempfile::Builder::new()
        .prefix("ntk-download-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = temp.path().join("package");
    let kind = download(app, url, filename, &path).await?;
    let downloads = dirs::download_dir().ok_or("The Downloads folder is unavailable")?;
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let name = safe_name(filename);
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("app");
    let suffix = if kind == PackageKind::Apk {
        ".apk"
    } else {
        ".apkm"
    };
    // Persist without overwriting an existing download.
    let mut saved = tempfile::Builder::new()
        .prefix(&format!("{}-", stem))
        .suffix(suffix)
        .tempfile_in(&downloads)
        .map_err(|e| e.to_string())?;
    std::io::copy(
        &mut std::fs::File::open(&path).map_err(|e| e.to_string())?,
        saved.as_file_mut(),
    )
    .map_err(|e| e.to_string())?;
    let (_, dest) = saved.keep().map_err(|e| e.to_string())?;
    progress(app, filename, "downloaded", 100, 0, None, "");
    Ok(json!({"ok":true,"path":dest}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn archive(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
        (temp, path)
    }
    #[test]
    fn distinguishes_apk_bundle_and_non_package_zip() {
        let (_t, p) = archive(&[("AndroidManifest.xml", b"manifest")]);
        assert_eq!(package_kind(&p).unwrap(), PackageKind::Apk);
        let (_t, p) = archive(&[("base.apk", b"apk")]);
        assert_eq!(package_kind(&p).unwrap(), PackageKind::Bundle);
        let (_t, p) = archive(&[("readme.txt", b"text")]);
        assert!(package_kind(&p).is_err());
    }
    #[test]
    fn does_not_silently_skip_game_data() {
        let (_t, p) = archive(&[("base.apk", b"apk"), ("Android/obb/app/main.obb", b"data")]);
        assert!(package_kind(&p).unwrap_err().contains("OBB"));
    }
    #[test]
    fn does_not_install_all_bundletool_device_variants_together() {
        let (_t, p) = archive(&[("toc.pb", b"table"), ("splits/base.apk", b"apk")]);
        assert!(package_kind(&p).unwrap_err().contains("device variants"));
    }
    #[test]
    fn filenames_cannot_escape_download_directory() {
        assert_eq!(safe_name("C:\\path\\app.apk"), "app.apk");
        assert_eq!(safe_name("../../a.apk"), "a.apk");
        assert_eq!(safe_name(".."), "app.apk");
    }
}
