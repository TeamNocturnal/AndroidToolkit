// ── Platform split ────────────────────────────────────────────────────────────
// This crate targets macOS, Windows, Linux, and Android from a single codebase.
//
// Desktop (macOS / Windows / Linux):
//   ADB and Fastboot are bundled as sidecars in src-tauri/binaries/ and
//   executed via tauri-plugin-shell's sidecar API.
//
// Android:
//   Sidecars cannot be bundled on Android. ADB commands are routed through
//   run_adb_wifi / run_fastboot_wifi which connect over TCP/IP (WiFi ADB).
//   These stubs will be fully implemented in a later session.
//
// The #[cfg(target_os = "android")] / #[cfg(not(target_os = "android"))]
// attributes control which code path is compiled for each target.
// ─────────────────────────────────────────────────────────────────────────────

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use std::sync::Mutex;
use tauri::Emitter;
#[cfg(target_os = "android")]
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "android")]
use adb_client::{tcp::ADBTcpDevice, ADBDeviceExt, RebootType};
#[cfg(target_os = "android")]
use libloading::{Library, Symbol};
#[cfg(target_os = "android")]
use num_bigint_dig::{BigUint, ModInverse};
#[cfg(target_os = "android")]
use num_traits::{FromPrimitive, ToPrimitive};
#[cfg(target_os = "android")]
use rcgen::{CertificateParams, KeyPair, PKCS_RSA_SHA256};
#[cfg(target_os = "android")]
use rsa::pkcs8::DecodePrivateKey;
#[cfg(target_os = "android")]
use rsa::pkcs8::EncodePrivateKey;
#[cfg(target_os = "android")]
use rsa::traits::PublicKeyParts;
#[cfg(target_os = "android")]
use rsa::RsaPrivateKey;
#[cfg(target_os = "android")]
use std::collections::BTreeSet;
#[cfg(target_os = "android")]
use std::io::Write;
#[cfg(target_os = "android")]
use std::io::{BufRead, BufReader};
#[cfg(target_os = "android")]
use std::net::{SocketAddr, ToSocketAddrs};
#[cfg(target_os = "android")]
use std::os::fd::IntoRawFd;
#[cfg(target_os = "android")]
use std::path::PathBuf;
#[cfg(target_os = "android")]
use std::process::{Command, Stdio};
#[cfg(target_os = "android")]
use std::sync::Condvar;

#[cfg(not(target_os = "android"))]
struct LogcatProcess(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
#[cfg(target_os = "android")]
struct LogcatProcess(Mutex<Option<std::process::Child>>);
#[cfg(target_os = "android")]
struct AndroidAdbState(Mutex<BTreeSet<String>>);
#[cfg(target_os = "android")]
struct PairingConnectionCtx;

#[cfg(target_os = "android")]
#[repr(C, packed)]
#[derive(Clone, Copy)]
struct PairingPeerInfo {
    type_: u8,
    data: [u8; 8191],
}

#[cfg(target_os = "android")]
struct PairingWaiter {
    result: Mutex<Option<Option<PairingPeerInfo>>>,
    cv: Condvar,
}

#[cfg(target_os = "android")]
type PairingResultCb = unsafe extern "C" fn(*const PairingPeerInfo, i32, *mut std::ffi::c_void);

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

fn format_speed(bps: f64) -> String {
    if bps >= 1_048_576.0 {
        format!("{:.1} MB/s", bps / 1_048_576.0)
    } else if bps >= 1024.0 {
        format!("{:.0} KB/s", bps / 1024.0)
    } else {
        format!("{:.0} B/s", bps)
    }
}

#[cfg(target_os = "android")]
#[derive(Debug)]
struct AndroidLogcatEmitter {
    app: tauri::AppHandle,
    buffer: Vec<u8>,
}

#[cfg(target_os = "android")]
impl AndroidLogcatEmitter {
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            buffer: Vec::new(),
        }
    }

    fn flush_lines(&mut self) {
        while let Some(pos) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..=pos).collect::<Vec<_>>();
            let text = String::from_utf8_lossy(&line).trim().to_string();
            if !text.is_empty() {
                let _ = self.app.emit("logcat:line", text);
            }
        }
    }
}

#[cfg(target_os = "android")]
impl Write for AndroidLogcatEmitter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        self.flush_lines();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.flush_lines();
        if !self.buffer.is_empty() {
            let text = String::from_utf8_lossy(&self.buffer).trim().to_string();
            if !text.is_empty() {
                let _ = self.app.emit("logcat:line", text);
            }
            self.buffer.clear();
        }
        Ok(())
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
struct Device {
    serial: String,
    model: String,
    product: String,
    transport: String,
    status: String,
    transport_id: Option<String>,
}

fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut tokens = line.split_whitespace();
            let serial = tokens.next()?.to_string();
            if serial.starts_with('*') {
                return None;
            }
            let status = tokens.next()?.to_string();
            if !matches!(status.as_str(), "device" | "unauthorized" | "offline") {
                return None;
            }
            let mut model = "Unknown Device".to_string();
            let mut product = String::new();
            let mut transport_id: Option<String> = None;
            for token in tokens {
                if let Some(v) = token.strip_prefix("model:") {
                    model = v.replace('_', " ");
                } else if let Some(v) = token.strip_prefix("product:") {
                    product = v.to_string();
                } else if let Some(v) = token.strip_prefix("transport_id:") {
                    transport_id = Some(v.to_string());
                }
            }
            let transport = if serial.contains(':') { "Wi-Fi" } else { "USB" }.to_string();
            Some(Device {
                serial,
                model,
                product,
                transport,
                status,
                transport_id,
            })
        })
        .collect()
}

async fn adb_output(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("adb")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "android")]
fn android_command_output(
    program: &str,
    args: &[String],
) -> Result<(bool, String, String), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {program}: {e}"))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

#[cfg(target_os = "android")]
fn android_prop(prop: &str) -> String {
    match Command::new("getprop").arg(prop).output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

#[cfg(target_os = "android")]
fn android_local_serial() -> String {
    let serial = android_prop("ro.serialno");
    if serial.is_empty() {
        "android-local".to_string()
    } else {
        serial
    }
}

#[cfg(target_os = "android")]
fn android_local_device() -> Device {
    let model = android_prop("ro.product.model");
    let product = android_prop("ro.product.device");
    Device {
        serial: android_local_serial(),
        model: if model.is_empty() {
            "This Android Device".to_string()
        } else {
            model
        },
        product,
        transport: "Local".to_string(),
        status: "device".to_string(),
        transport_id: Some("local".to_string()),
    }
}

#[cfg(target_os = "android")]
fn android_adb_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve Android app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create Android app data dir: {e}"))?;
    Ok(dir.join("adbkey.pem"))
}

#[cfg(target_os = "android")]
fn ensure_android_adb_key(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let key_path = android_adb_key_path(app)?;
    if key_path.exists() {
        return Ok(key_path);
    }

    let private_key = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048)
        .map_err(|e| format!("Failed to generate Android ADB key: {e}"))?;
    let pem = private_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .map_err(|e| format!("Failed to encode Android ADB key: {e}"))?;
    std::fs::write(&key_path, pem.as_bytes())
        .map_err(|e| format!("Failed to persist Android ADB key: {e}"))?;
    Ok(key_path)
}

#[cfg(target_os = "android")]
fn adb_public_key_bytes(private_key: &RsaPrivateKey) -> Result<Vec<u8>, String> {
    const ANDROID_PUBKEY_MODULUS_SIZE_WORDS: u32 = 64;

    let mut bytes = Vec::new();
    bytes.extend_from_slice(&ANDROID_PUBKEY_MODULUS_SIZE_WORDS.to_le_bytes());

    let modulus = BigUint::from_bytes_be(&private_key.n().to_bytes_be());
    let exponent = BigUint::from_bytes_be(&private_key.e().to_bytes_be());
    let r32 = BigUint::from_u64(1 << 32).ok_or_else(|| "Failed to build r32".to_string())?;
    let r = BigUint::from_u8(1).ok_or_else(|| "Failed to build Montgomery base".to_string())?
        << 2048usize;

    let rem = &modulus % &r32;
    let n0inv = rem
        .mod_inverse(&r32)
        .and_then(|value| value.to_biguint())
        .ok_or_else(|| "Failed to compute adb public key inverse".to_string())?;
    let rr = r.modpow(&BigUint::from(2u32), &modulus);

    let n0inv_u32 = (r32 - n0inv)
        .to_u32()
        .ok_or_else(|| "Failed to downcast adb public key inverse".to_string())?;
    let exponent_u32 = exponent
        .to_u32()
        .ok_or_else(|| "Failed to downcast adb public key exponent".to_string())?;

    bytes.extend_from_slice(&n0inv_u32.to_le_bytes());

    let mut modulus_le = modulus.to_bytes_le();
    modulus_le.resize(256, 0);
    bytes.extend_from_slice(&modulus_le);

    let mut rr_le = rr.to_bytes_le();
    rr_le.resize(256, 0);
    bytes.extend_from_slice(&rr_le);
    bytes.extend_from_slice(&exponent_u32.to_le_bytes());
    Ok(bytes)
}

#[cfg(target_os = "android")]
fn android_adb_public_key(app: &tauri::AppHandle) -> Result<String, String> {
    let key_path = ensure_android_adb_key(app)?;
    let private_key_pem = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("Failed to read Android ADB key: {e}"))?;
    let private_key = RsaPrivateKey::from_pkcs8_pem(&private_key_pem)
        .map_err(|e| format!("Failed to parse Android ADB key: {e}"))?;
    let mut encoded = BASE64_STANDARD.encode(adb_public_key_bytes(&private_key)?);
    encoded.push(' ');
    encoded.push_str("TNToolkit@android");
    Ok(encoded)
}

#[cfg(target_os = "android")]
fn android_pairing_credentials(app: &tauri::AppHandle) -> Result<(String, String, String), String> {
    let key_path = ensure_android_adb_key(app)?;
    let private_key_pem = std::fs::read_to_string(&key_path)
        .map_err(|e| format!("Failed to read Android ADB key: {e}"))?;
    let key_pair = KeyPair::from_pkcs8_pem_and_sign_algo(&private_key_pem, &PKCS_RSA_SHA256)
        .map_err(|e| format!("Failed to build Android pairing key pair: {e}"))?;
    let cert = CertificateParams::default()
        .self_signed(&key_pair)
        .map_err(|e| format!("Failed to generate Android pairing certificate: {e}"))?;
    Ok((
        android_adb_public_key(app)?,
        cert.pem(),
        key_pair.serialize_pem(),
    ))
}

#[cfg(target_os = "android")]
unsafe extern "C" fn android_pairing_result_cb(
    peer_info: *const PairingPeerInfo,
    _fd: i32,
    opaque: *mut std::ffi::c_void,
) {
    let waiter = unsafe { &*(opaque as *const PairingWaiter) };
    let mut lock = waiter.result.lock().unwrap();
    *lock = Some(if peer_info.is_null() {
        None
    } else {
        Some(unsafe { *peer_info })
    });
    waiter.cv.notify_one();
}

#[cfg(target_os = "android")]
fn android_pair_remote_device(
    app: &tauri::AppHandle,
    address: &str,
    password: &str,
) -> Result<String, String> {
    type PairingConnectionClientNew = unsafe extern "C" fn(
        *const u8,
        usize,
        *const PairingPeerInfo,
        *const u8,
        usize,
        *const u8,
        usize,
    ) -> *mut PairingConnectionCtx;
    type PairingConnectionStart = unsafe extern "C" fn(
        *mut PairingConnectionCtx,
        i32,
        PairingResultCb,
        *mut std::ffi::c_void,
    ) -> bool;
    type PairingConnectionDestroy = unsafe extern "C" fn(*mut PairingConnectionCtx);

    let socket = remote_socket_from_serial(address)?;
    let stream = std::net::TcpStream::connect_timeout(&socket, std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to connect to pairing port {address}: {e}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(15)))
        .map_err(|e| format!("Failed to configure pairing socket: {e}"))?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(15)))
        .map_err(|e| format!("Failed to configure pairing socket: {e}"))?;

    let (adb_pubkey, cert_pem, key_pem) = android_pairing_credentials(app)?;
    let mut peer_info = PairingPeerInfo {
        type_: 0,
        data: [0; 8191],
    };
    let pubkey_bytes = adb_pubkey.as_bytes();
    if pubkey_bytes.len() >= peer_info.data.len() {
        return Err("Android ADB public key is unexpectedly large".to_string());
    }
    peer_info.data[..pubkey_bytes.len()].copy_from_slice(pubkey_bytes);

    let pswd = password.as_bytes();
    if pswd.is_empty() {
        return Err("Pairing code is required".to_string());
    }

    let waiter = PairingWaiter {
        result: Mutex::new(None),
        cv: Condvar::new(),
    };

    let library = unsafe { Library::new("libadb_pairing_connection.so") }
        .map_err(|e| format!("Android pairing library is unavailable on this device: {e}"))?;
    let client_new: Symbol<'_, PairingConnectionClientNew> = unsafe {
        library
            .get(b"pairing_connection_client_new")
            .map_err(|e| format!("Android pairing client symbol missing: {e}"))?
    };
    let start: Symbol<'_, PairingConnectionStart> = unsafe {
        library
            .get(b"pairing_connection_start")
            .map_err(|e| format!("Android pairing start symbol missing: {e}"))?
    };
    let destroy: Symbol<'_, PairingConnectionDestroy> = unsafe {
        library
            .get(b"pairing_connection_destroy")
            .map_err(|e| format!("Android pairing destroy symbol missing: {e}"))?
    };

    let ctx = unsafe {
        client_new(
            pswd.as_ptr(),
            pswd.len(),
            &peer_info,
            cert_pem.as_bytes().as_ptr(),
            cert_pem.len(),
            key_pem.as_bytes().as_ptr(),
            key_pem.len(),
        )
    };
    if ctx.is_null() {
        return Err("Failed to create Android pairing client".to_string());
    }

    let fd = stream.into_raw_fd();
    let started = unsafe {
        start(
            ctx,
            fd,
            android_pairing_result_cb,
            &waiter as *const PairingWaiter as *mut std::ffi::c_void,
        )
    };
    if !started {
        unsafe { destroy(ctx) };
        return Err("Failed to start Android pairing client".to_string());
    }

    let result = {
        let lock = waiter.result.lock().unwrap();
        let timeout = std::time::Duration::from_secs(20);
        let (lock, _) = waiter
            .cv
            .wait_timeout_while(lock, timeout, |result| result.is_none())
            .map_err(|_| "Failed while waiting for pairing result".to_string())?;
        *lock
    };
    unsafe { destroy(ctx) };

    let peer_info = match result {
        Some(Some(peer_info)) => peer_info,
        Some(None) => {
            return Err("Wrong pairing code or the pairing connection was dropped.".to_string())
        }
        None => return Err("Timed out while waiting for the pairing result.".to_string()),
    };

    if peer_info.type_ != 1 {
        return Err(format!(
            "Pairing succeeded but returned an unexpected peer info type: {}",
            peer_info.type_
        ));
    }

    let guid_len = peer_info
        .data
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(peer_info.data.len());
    let guid = String::from_utf8_lossy(&peer_info.data[..guid_len]).to_string();
    Ok(format!("Successfully paired to {address} [guid={guid}]"))
}

#[cfg(target_os = "android")]
fn normalize_remote_address(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Missing device address".to_string());
    }
    let with_port = if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:5555")
    };
    let mut resolved = with_port
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve {with_port}: {e}"))?;
    let socket = resolved
        .next()
        .ok_or_else(|| format!("No socket address found for {with_port}"))?;
    Ok(socket.to_string())
}

#[cfg(target_os = "android")]
fn remote_socket_from_serial(serial: &str) -> Result<SocketAddr, String> {
    normalize_remote_address(serial)?
        .parse::<SocketAddr>()
        .map_err(|e| format!("Invalid device address {serial}: {e}"))
}

#[cfg(target_os = "android")]
fn android_remote_device_shell(
    app: &tauri::AppHandle,
    address: &str,
    command: &str,
) -> Result<(bool, String, String), String> {
    let key_path = ensure_android_adb_key(app)?;
    let socket = remote_socket_from_serial(address)?;
    let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
        .map_err(|e| format!("Failed to connect to {address}: {e}"))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let status = device
        .shell_command(&command, Some(&mut stdout), Some(&mut stderr))
        .map_err(|e| format!("ADB shell failed for {address}: {e}"))?;

    Ok((
        status.unwrap_or(0) == 0,
        String::from_utf8_lossy(&stdout).to_string(),
        String::from_utf8_lossy(&stderr).to_string(),
    ))
}

#[cfg(target_os = "android")]
fn android_probe_remote_device(app: &tauri::AppHandle, address: &str) -> Device {
    let serial = normalize_remote_address(address).unwrap_or_else(|_| address.trim().to_string());
    let model = android_remote_device_shell(app, &serial, "getprop ro.product.model")
        .ok()
        .map(|(_, stdout, _)| stdout.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Remote Android Device".to_string());
    let product = android_remote_device_shell(app, &serial, "getprop ro.product.device")
        .ok()
        .map(|(_, stdout, _)| stdout.trim().to_string())
        .unwrap_or_default();
    let status = if model == "Remote Android Device" && product.is_empty() {
        "offline".to_string()
    } else {
        "device".to_string()
    };
    Device {
        serial: serial.clone(),
        model,
        product,
        transport: "Wi-Fi".to_string(),
        status,
        transport_id: Some(format!("remote-{serial}")),
    }
}

#[cfg(target_os = "android")]
fn android_list_devices(app: &tauri::AppHandle, state: &AndroidAdbState) -> Vec<Device> {
    let mut devices = vec![android_local_device()];
    let remotes: Vec<String> = state.0.lock().unwrap().iter().cloned().collect();
    for remote in remotes {
        devices.push(android_probe_remote_device(app, &remote));
    }
    devices
}

#[cfg(target_os = "android")]
fn android_devices_stdout(app: &tauri::AppHandle, state: &AndroidAdbState) -> String {
    let mut stdout = String::from("List of devices attached\n");
    for device in android_list_devices(app, state) {
        let model = device.model.replace(' ', "_");
        let product = if device.product.is_empty() {
            "android".to_string()
        } else {
            device.product
        };
        let transport_id = device.transport_id.unwrap_or_else(|| "unknown".to_string());
        stdout.push_str(&format!(
            "{}\t{} product:{} model:{} transport_id:{}\n",
            device.serial, device.status, product, model, transport_id
        ));
    }
    stdout
}

#[cfg(target_os = "android")]
fn strip_android_serial(mut args: Vec<String>) -> Result<(Option<String>, Vec<String>), String> {
    let mut target = None;
    if args.len() >= 2 && args[0] == "-s" {
        let requested = args[1].clone();
        target = Some(normalize_remote_address(&requested).unwrap_or(requested));
        args.drain(0..2);
    }
    Ok((target, args))
}

#[cfg(not(target_os = "android"))]
async fn run_adb_sidecar(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let refresh_after = args.first().is_some_and(|cmd| {
        matches!(
            cmd.as_str(),
            "connect" | "disconnect" | "pair" | "kill-server" | "start-server"
        )
    });
    let output = app
        .shell()
        .sidecar("adb")
        .map_err(|e| e.to_string())?
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if refresh_after {
        if let Ok(stdout) = adb_output(app, &["devices", "-l"]).await {
            let _ = app.emit("devices:changed", &parse_devices(&stdout));
        }
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(serde_json::json!({ "ok": output.status.success(), "stdout": stdout, "stderr": stderr }))
}

#[cfg(target_os = "android")]
fn is_android_local_serial(serial: &str) -> bool {
    let local = android_local_serial();
    serial == local || serial == "android-local"
}

#[cfg(target_os = "android")]
fn android_shell_command(args: &[String]) -> String {
    args.iter()
        .map(|arg| {
            if arg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._/:=@".contains(c))
            {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "android")]
async fn run_adb_wifi(
    app: &tauri::AppHandle,
    state: &AndroidAdbState,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let (target, args) = strip_android_serial(args)?;
    if args.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "stdout": "",
            "stderr": "No adb command provided"
        }));
    }

    match args[0].as_str() {
        "devices" => {
            return Ok(serde_json::json!({
                "ok": true,
                "stdout": android_devices_stdout(app, state),
                "stderr": ""
            }));
        }
        "start-server" | "kill-server" => {
            return Ok(serde_json::json!({
                "ok": true,
                "stdout": "Android APK mode uses the local device backend — no adb server required\n",
                "stderr": ""
            }));
        }
        "connect" => {
            if args.len() < 2 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": "adb connect requires a host:port target"
                }));
            }
            let address = normalize_remote_address(&args[1])?;
            let device = android_probe_remote_device(app, &address);
            if device.status != "device" {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": format!("Failed to connect to {address}. Make sure Wireless Debugging or ADB over TCP is already enabled on the target device.")
                }));
            }
            state.0.lock().unwrap().insert(address.clone());
            return Ok(serde_json::json!({
                "ok": true,
                "stdout": format!("connected to {address}\n"),
                "stderr": ""
            }));
        }
        "pair" => {
            if args.len() < 3 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": "adb pair requires a host:port target and 6-digit pairing code"
                }));
            }
            let address = normalize_remote_address(&args[1])?;
            let message = android_pair_remote_device(app, &address, &args[2])?;
            return Ok(serde_json::json!({
                "ok": true,
                "stdout": format!("{message}\n"),
                "stderr": ""
            }));
        }
        "shell" => {
            if args.len() < 2 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": "adb shell requires a command"
                }));
            }
            let shell_args = args[1..].to_vec();
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            let (ok, stdout, stderr) = if is_remote {
                let command = android_shell_command(&shell_args);
                android_remote_device_shell(app, target.as_deref().unwrap(), &command)?
            } else {
                android_command_output(&shell_args[0], &shell_args[1..])?
            };
            return Ok(serde_json::json!({ "ok": ok, "stdout": stdout, "stderr": stderr }));
        }
        "uninstall" => {
            if args.len() < 2 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": "adb uninstall requires a package name"
                }));
            }
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            let (ok, stdout, stderr) = if is_remote {
                let socket = remote_socket_from_serial(target.as_deref().unwrap())?;
                let key_path = ensure_android_adb_key(app)?;
                let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
                    .map_err(|e| {
                        format!("Failed to connect to {}: {e}", target.as_deref().unwrap())
                    })?;
                match device.uninstall(&args[1], None) {
                    Ok(_) => (true, "Success\n".to_string(), String::new()),
                    Err(e) => (false, String::new(), format!("adb uninstall failed: {e}")),
                }
            } else {
                let pm_args = vec!["uninstall".to_string(), args[1].clone()];
                android_command_output("pm", &pm_args)?
            };
            return Ok(serde_json::json!({ "ok": ok, "stdout": stdout, "stderr": stderr }));
        }
        "install" => {
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            if !is_remote {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": "Local Android installs use the system package installer instead of adb install."
                }));
            }
            let apk_path = args
                .iter()
                .rev()
                .find(|arg| !arg.starts_with('-'))
                .ok_or_else(|| "adb install requires an APK path".to_string())?;
            let socket = remote_socket_from_serial(target.as_deref().unwrap())?;
            let key_path = ensure_android_adb_key(app)?;
            let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
                .map_err(|e| format!("Failed to connect to {}: {e}", target.as_deref().unwrap()))?;
            let result = device.install(&std::path::Path::new(apk_path), None);
            return Ok(match result {
                Ok(_) => serde_json::json!({ "ok": true, "stdout": "Success\n", "stderr": "" }),
                Err(e) => {
                    serde_json::json!({ "ok": false, "stdout": "", "stderr": format!("adb install failed: {e}") })
                }
            });
        }
        "pull" => {
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            if !is_remote || args.len() < 3 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": if args.len() < 3 { "adb pull requires remote and local paths" } else { "adb pull is only available for external Android devices inside the APK." }
                }));
            }
            let socket = remote_socket_from_serial(target.as_deref().unwrap())?;
            let key_path = ensure_android_adb_key(app)?;
            let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
                .map_err(|e| format!("Failed to connect to {}: {e}", target.as_deref().unwrap()))?;
            let mut output = std::fs::File::create(&args[2])
                .map_err(|e| format!("Failed to create {}: {e}", args[2]))?;
            let result = device.pull(&args[1], &mut output);
            return Ok(match result {
                Ok(_) => {
                    serde_json::json!({ "ok": true, "stdout": format!("{} -> {}\n", args[1], args[2]), "stderr": "" })
                }
                Err(e) => {
                    serde_json::json!({ "ok": false, "stdout": "", "stderr": format!("adb pull failed: {e}") })
                }
            });
        }
        "push" => {
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            if !is_remote || args.len() < 3 {
                return Ok(serde_json::json!({
                    "ok": false,
                    "stdout": "",
                    "stderr": if args.len() < 3 { "adb push requires local and remote paths" } else { "adb push is only available for external Android devices inside the APK." }
                }));
            }
            let socket = remote_socket_from_serial(target.as_deref().unwrap())?;
            let key_path = ensure_android_adb_key(app)?;
            let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
                .map_err(|e| format!("Failed to connect to {}: {e}", target.as_deref().unwrap()))?;
            let mut input = std::fs::File::open(&args[1])
                .map_err(|e| format!("Failed to open {}: {e}", args[1]))?;
            let result = device.push(&mut input, &args[2]);
            return Ok(match result {
                Ok(_) => {
                    serde_json::json!({ "ok": true, "stdout": format!("{} -> {}\n", args[1], args[2]), "stderr": "" })
                }
                Err(e) => {
                    serde_json::json!({ "ok": false, "stdout": "", "stderr": format!("adb push failed: {e}") })
                }
            });
        }
        "reboot" => {
            let is_remote = target
                .as_deref()
                .is_some_and(|serial| !is_android_local_serial(serial));
            if !is_remote {
                let reboot_args: Vec<String> = match args.get(1).map(String::as_str) {
                    Some("bootloader") | Some("fastboot") => vec!["bootloader".to_string()],
                    Some("recovery") => vec!["recovery".to_string()],
                    Some("sideload") => vec!["sideload".to_string()],
                    Some("sideload-auto-reboot") => vec!["sideload-auto-reboot".to_string()],
                    Some(_) | None => Vec::new(),
                };
                let (ok, stdout, stderr) = android_command_output("reboot", &reboot_args)?;
                return Ok(serde_json::json!({ "ok": ok, "stdout": stdout, "stderr": stderr }));
            }
            let reboot_type = match args.get(1).map(String::as_str) {
                Some("bootloader") => RebootType::Bootloader,
                Some("recovery") => RebootType::Recovery,
                Some("fastboot") => RebootType::Fastboot,
                Some("sideload") => RebootType::Sideload,
                Some("sideload-auto-reboot") => RebootType::SideloadAutoReboot,
                Some(_) | None => RebootType::System,
            };
            let socket = remote_socket_from_serial(target.as_deref().unwrap())?;
            let key_path = ensure_android_adb_key(app)?;
            let mut device = ADBTcpDevice::new_with_custom_private_key(socket, key_path)
                .map_err(|e| format!("Failed to connect to {}: {e}", target.as_deref().unwrap()))?;
            let result = device.reboot(reboot_type);
            return Ok(match result {
                Ok(_) => serde_json::json!({ "ok": true, "stdout": "rebooting\n", "stderr": "" }),
                Err(e) => {
                    serde_json::json!({ "ok": false, "stdout": "", "stderr": format!("adb reboot failed: {e}") })
                }
            });
        }
        "install-multiple" | "sideload" => {
            return Ok(serde_json::json!({
                "ok": false,
                "stdout": "",
                "stderr": format!("adb {} is not supported inside the Android APK backend yet.", args[0])
            }));
        }
        other => {
            return Ok(serde_json::json!({
                "ok": false,
                "stdout": "",
                "stderr": format!("Unsupported adb command in Android APK mode: {other}")
            }));
        }
    }
}

#[tauri::command]
async fn run_adb(app: tauri::AppHandle, args: Vec<String>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let state = app.state::<AndroidAdbState>();
        return run_adb_wifi(&app, &state, args).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        return run_adb_sidecar(&app, args).await;
    }
}

#[tauri::command]
async fn install_from_url(
    app: tauri::AppHandle,
    serial: String,
    url: String,
    filename: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Linux; Android 10)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .connection_verbose(true)
        .build()
        .map_err(|e| format!("Client build failed: {e}"))?;

    println!(
        "[install] starting: url={} serial={} filename={}",
        url, serial, filename
    );
    println!("[install] downloading {}", url);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    println!(
        "[install] HTTP {} content-type={:?} content-length={:?}",
        resp.status(),
        resp.headers().get("content-type"),
        resp.headers().get("content-length")
    );

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Stream chunks, tracking progress and emitting events every 500ms
    let content_length: Option<u64> = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    let mut data = Vec::new();
    if let Some(len) = content_length {
        data.reserve(len as usize);
    }

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;

    let mut received: u64 = 0;
    let mut last_speed_check = std::time::Instant::now();
    let mut last_bytes_for_speed: u64 = 0;
    let mut current_speed = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        received += chunk.len() as u64;
        data.extend_from_slice(&chunk);

        if last_speed_check.elapsed().as_millis() >= 500 {
            let bytes_since = received - last_bytes_for_speed;
            let elapsed_secs = last_speed_check.elapsed().as_secs_f64();
            if elapsed_secs > 0.0 {
                current_speed = format_speed(bytes_since as f64 / elapsed_secs);
            }
            last_speed_check = std::time::Instant::now();
            last_bytes_for_speed = received;

            let percent = content_length
                .filter(|&t| t > 0)
                .map(|t| ((received as f64 / t as f64) * 100.0).min(99.0) as u64)
                .unwrap_or(0);
            let received_str = format_bytes(received);
            let total_str = content_length.map(format_bytes).unwrap_or_default();

            let _ = app.emit(
                "install:progress",
                serde_json::json!({
                    "store":    filename,
                    "filename": filename,
                    "phase":    "downloading",
                    "percent":  percent,
                    "speed":    current_speed,
                    "received": received_str,
                    "total":    total_str,
                }),
            );
        }
    }
    println!("[install] downloaded {} bytes", data.len());

    if data.is_empty() {
        return Err("Downloaded file is empty".to_string());
    }

    let final_total = content_length
        .map(format_bytes)
        .unwrap_or_else(|| format_bytes(received));
    let _ = app.emit(
        "install:progress",
        serde_json::json!({
            "store":    filename,
            "filename": filename,
            "phase":    "installing",
            "percent":  95,
            "speed":    "",
            "received": format_bytes(received),
            "total":    final_total,
        }),
    );

    let tmp_dir = std::env::temp_dir();
    tokio::fs::create_dir_all(&tmp_dir).await.ok();
    let safe_filename: String = filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let tmp = tmp_dir.join(&safe_filename);
    println!("[install] writing {} bytes to {:?}", data.len(), tmp);
    tokio::fs::write(&tmp, &data)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;
    let path = tmp.to_string_lossy().to_string();

    #[cfg(target_os = "android")]
    if is_android_local_serial(&serial) {
        let _ = app.emit(
            "install:progress",
            serde_json::json!({
                "store": filename, "filename": filename, "phase": "done", "percent": 100
            }),
        );
        return Ok(serde_json::json!({
            "ok": true,
            "stdout": "Installer package downloaded.\n",
            "stderr": "",
            "localPath": path
        }));
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        app.shell()
            .sidecar("adb")
            .map_err(|e| e.to_string())?
            .args(&["-s", &serial, "install", "-r", &path])
            .output(),
    )
    .await
    .map_err(|_| "adb install timed out after 60s".to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    println!("[install] adb stdout: {}", stdout);
    println!("[install] adb stderr: {}", stderr);

    let ok = stdout.to_lowercase().contains("success") || stderr.to_lowercase().contains("success");
    println!("[install] ok={}", ok);
    let _ = tokio::fs::remove_file(&tmp).await;

    let _ = app.emit(
        "install:progress",
        serde_json::json!({
            "store": filename, "filename": filename, "phase": "done", "percent": 100
        }),
    );

    Ok(serde_json::json!({ "ok": ok, "stdout": stdout, "stderr": stderr }))
}

// ── F-Droid index cache ───────────────────────────────────────────────────────

fn fdroid_cache_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home)
        .join("Downloads")
        .join("Nocturnal Toolkit")
        .join("fdroid-index.json")
}

async fn download_fdroid_index() -> Result<Vec<u8>, String> {
    println!("[fdroid] downloading index-v1.json …");
    let client = reqwest::Client::builder()
        .user_agent("NocturnalToolkit/2.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://f-droid.org/repo/index-v1.json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    println!("[fdroid] HTTP {}", resp.status());
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    println!("[fdroid] downloaded {} bytes", bytes.len());
    Ok(bytes)
}

fn save_fdroid_cache(bytes: &[u8]) {
    let path = fdroid_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, bytes) {
        Ok(_) => println!("[fdroid] saved cache to {}", path.display()),
        Err(e) => println!("[fdroid] cache write failed: {}", e),
    }
}

// ── F-Droid search ────────────────────────────────────────────────────────────

async fn search_fdroid(client: &reqwest::Client, query: &str) -> Vec<serde_json::Value> {
    let url = format!(
        "https://search.f-droid.org/api/search_apps?q={}",
        query.replace(' ', "+")
    );
    println!("[fdroid] GET {}", url);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            println!("[fdroid] failed: {}", e);
            return vec![];
        }
    };
    println!("[fdroid] HTTP {}", resp.status());
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            println!("[fdroid] bytes failed: {}", e);
            return vec![];
        }
    };
    println!(
        "[fdroid] preview: {}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(300)])
    );
    let json: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(j) => j,
        Err(e) => {
            println!("[fdroid] parse failed: {}", e);
            return vec![];
        }
    };
    // Response shape: {"apps": [{"name", "summary", "icon", "url"}, ...]}
    // packageName is the last path component of url: .../packages/{packageName}
    let arr = match json.get("apps").and_then(|v| v.as_array()) {
        Some(a) => a.clone(),
        None => {
            println!(
                "[fdroid] unexpected shape: {:?}",
                json.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
            return vec![];
        }
    };
    println!("[fdroid] {} results, fetching version codes…", arr.len());

    // Fetch package details concurrently to get suggestedVersionCode for APK URL
    let results: Vec<serde_json::Value> = {
        use futures_util::future::join_all;
        let futs: Vec<_> = arr
            .iter()
            .take(10)
            .map(|hit| {
                let client = client.clone();
                let name = hit
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let summary = hit
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let pkg = hit
                    .get("url")
                    .and_then(|v| v.as_str())
                    .and_then(|u| u.split('/').last())
                    .unwrap_or("")
                    .to_string();
                async move {
                    if pkg.is_empty() {
                        return serde_json::json!({
                            "packageName": pkg, "name": name, "summary": summary,
                            "suggestedVersionName": "", "source": "fdroid",
                            "verified": true, "apkUrl": serde_json::Value::Null
                        });
                    }
                    // Fetch package details to get suggestedVersionCode
                    let (apk_url, version_name) = match client
                        .get(format!("https://f-droid.org/api/v1/packages/{}", pkg))
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() => match r.bytes().await {
                            Ok(b) => {
                                let det: serde_json::Value =
                                    serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null);
                                let vc = det.get("suggestedVersionCode").and_then(|v| v.as_u64());
                                let vn = det
                                    .get("suggestedVersionName")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let url = if let Some(code) = vc {
                                    format!("https://f-droid.org/repo/{}_{}.apk", pkg, code)
                                } else {
                                    format!("https://f-droid.org/repo/{}_latest.apk", pkg)
                                };
                                (url, vn)
                            }
                            Err(_) => (
                                format!("https://f-droid.org/repo/{}_latest.apk", pkg),
                                String::new(),
                            ),
                        },
                        _ => (
                            format!("https://f-droid.org/repo/{}_latest.apk", pkg),
                            String::new(),
                        ),
                    };
                    println!("[fdroid] {} -> {}", pkg, apk_url);
                    serde_json::json!({
                        "packageName": pkg, "name": name, "summary": summary,
                        "suggestedVersionName": version_name, "source": "fdroid",
                        "verified": true, "apkUrl": apk_url
                    })
                }
            })
            .collect();
        join_all(futs).await
    };
    results
}

// ── Aptoide search ────────────────────────────────────────────────────────────

async fn search_aptoide(client: &reqwest::Client, query: &str) -> Vec<serde_json::Value> {
    let url = format!(
        "https://ws75.aptoide.com/api/7/apps/search/query={}",
        query.replace(' ', "+")
    );
    println!("[aptoide] GET {}", url);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            println!("[aptoide] failed: {}", e);
            return vec![];
        }
    };
    println!("[aptoide] HTTP {}", resp.status());
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            println!("[aptoide] bytes failed: {}", e);
            return vec![];
        }
    };
    println!(
        "[aptoide] preview: {}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(300)])
    );
    let json: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(j) => j,
        Err(e) => {
            println!("[aptoide] parse failed: {}", e);
            return vec![];
        }
    };
    // Aptoide returns { datalist: { list: [...] } }
    let list = match json
        .get("datalist")
        .and_then(|d| d.get("list"))
        .and_then(|v| v.as_array())
    {
        Some(l) => l.clone(),
        None => {
            println!("[aptoide] unexpected shape");
            return vec![];
        }
    };
    println!("[aptoide] {} results", list.len());
    list.iter()
        .take(10)
        .map(|app| {
            let pkg = app
                .get("package")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = app
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&pkg)
                .to_string();
            let version = app
                .get("file")
                .and_then(|f| f.get("vername"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let download_url = app
                .get("file")
                .and_then(|f| f.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            serde_json::json!({
                "packageName": pkg, "name": name, "summary": "",
                "suggestedVersionName": version, "source": "aptoide",
                "verified": false, "apkUrl": download_url
            })
        })
        .collect()
}

// ── GitHub search ─────────────────────────────────────────────────────────────

async fn search_github(client: &reqwest::Client, query: &str) -> Vec<serde_json::Value> {
    let search_q = format!("{} android", query);
    let repos: serde_json::Value = match client
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", search_q.as_str()),
            ("sort", "stars"),
            ("per_page", "8"),
        ])
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null),
            Err(_) => return vec![],
        },
        _ => return vec![],
    };

    let items = match repos.get("items").and_then(|v| v.as_array()) {
        Some(i) => i.clone(),
        None => return vec![],
    };

    let mut results = Vec::new();
    for repo in items.iter().take(8) {
        let full_name = match repo.get("full_name").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let name = repo
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&full_name)
            .to_string();
        let description = repo
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let release: serde_json::Value = match client
            .get(format!(
                "https://api.github.com/repos/{}/releases/latest",
                full_name
            ))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null),
                Err(_) => continue,
            },
            _ => continue,
        };

        let assets = match release.get("assets").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => continue,
        };
        let apk_asset = match assets.iter().find(|a| {
            a.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n.to_lowercase().ends_with(".apk"))
                .unwrap_or(false)
        }) {
            Some(a) => a,
            None => continue,
        };

        let download_url = apk_asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let version = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();

        results.push(serde_json::json!({
            "packageName":          full_name,
            "name":                 name,
            "summary":              description,
            "suggestedVersionName": version,
            "suggestedVersionCode": serde_json::Value::Null,
            "lastUpdated":          0u64,
            "apkUrl":               download_url,
            "source":               "github",
        }));

        if results.len() >= 5 {
            break;
        }
    }
    results
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn refresh_fdroid_index() -> Result<serde_json::Value, String> {
    // Delete stale cache so load_fdroid_index always re-downloads
    let path = fdroid_cache_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        println!("[fdroid] cache deleted, forcing re-download");
    }
    let bytes = download_fdroid_index().await?;
    save_fdroid_cache(&bytes);
    // Count apps
    let count = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|j| j.get("apps").and_then(|v| v.as_array()).map(|a| a.len()))
        .unwrap_or(0);
    println!("[fdroid] refresh complete — {} apps indexed", count);
    Ok(serde_json::json!({ "ok": true, "count": count }))
}

#[tauri::command]
async fn fetch_github_picks() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("NocturnalToolkit/2.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", "android apk release"),
            ("sort", "stars"),
            ("per_page", "12"),
        ])
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .bytes()
        .await
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))?;

    let picks: Vec<serde_json::Value> = json
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items.iter().take(12).map(|repo| serde_json::json!({
            "full_name":   repo.get("full_name").and_then(|v| v.as_str()).unwrap_or(""),
            "name":        repo.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "description": repo.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "stars":       repo.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0),
        })).collect()
        })
        .unwrap_or_default();

    Ok(serde_json::json!({ "ok": true, "picks": picks }))
}

#[tauri::command]
async fn search_apks(query: String, sources: Vec<String>) -> Result<serde_json::Value, String> {
    println!("[search_apks] query={:?} sources={:?}", query, sources);

    let client = reqwest::Client::builder()
        .user_agent("NocturnalToolkit/2.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let want_fdroid = sources.contains(&"fdroid".to_string());
    let want_github = sources.contains(&"github".to_string());
    let want_aptoide = sources.contains(&"aptoide".to_string());

    let (fdroid_results, github_results, aptoide_results) = tokio::join!(
        async {
            if !want_fdroid {
                return vec![];
            }
            search_fdroid(&client, &query).await
        },
        async {
            if !want_github {
                return vec![];
            }
            search_github(&client, &query).await
        },
        async {
            if !want_aptoide {
                return vec![];
            }
            search_aptoide(&client, &query).await
        }
    );

    let mut all: Vec<serde_json::Value> = fdroid_results;
    all.extend(github_results);
    all.extend(aptoide_results);
    println!("[search_apks] total results: {}", all.len());

    Ok(serde_json::json!({ "ok": true, "results": all }))
}

#[cfg(not(target_os = "android"))]
async fn run_fastboot_sidecar(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let output = app
        .shell()
        .sidecar("fastboot")
        .map_err(|e| e.to_string())?
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(serde_json::json!({ "ok": output.status.success(), "stdout": stdout, "stderr": stderr }))
}

#[cfg(target_os = "android")]
async fn run_fastboot_wifi(args: Vec<String>) -> Result<serde_json::Value, String> {
    let _ = args;
    Ok(serde_json::json!({
        "ok": false,
        "stdout": "",
        "stderr": "Fastboot is not available inside the Android APK backend."
    }))
}

#[tauri::command]
async fn run_fastboot(
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        return run_fastboot_wifi(args).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        return run_fastboot_sidecar(&app, args).await;
    }
}

#[tauri::command]
async fn capture_screen_frame(
    app: tauri::AppHandle,
    serial: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        let _ = serial;
        return Ok(serde_json::json!({
            "ok": false,
            "stderr": "Desktop live preview is not available inside the Android APK."
        }));
    }

    #[cfg(not(target_os = "android"))]
    {
        let output = app
            .shell()
            .sidecar("adb")
            .map_err(|e| e.to_string())?
            .args(["-s", &serial, "exec-out", "screencap", "-p"])
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if !output.status.success() || output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Ok(serde_json::json!({
                "ok": false,
                "stderr": if stderr.trim().is_empty() { "Failed to capture a screen frame from the connected device.".to_string() } else { stderr }
            }));
        }

        let encoded = BASE64_STANDARD.encode(&output.stdout);
        Ok(serde_json::json!({
            "ok": true,
            "mime": "image/png",
            "data_url": format!("data:image/png;base64,{encoded}")
        }))
    }
}

#[tauri::command]
async fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(&["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(&["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let target = std::path::Path::new(&path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new(&path));
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn start_logcat(
    app: tauri::AppHandle,
    serial: String,
    state: tauri::State<'_, LogcatProcess>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }

        if !is_android_local_serial(&serial) {
            let remote_serial = normalize_remote_address(&serial).unwrap_or(serial);
            let key_path = ensure_android_adb_key(&app)?;
            let handle = app.clone();
            std::thread::spawn(move || {
                let socket = match remote_socket_from_serial(&remote_serial) {
                    Ok(socket) => socket,
                    Err(err) => {
                        let _ = handle.emit(
                            "logcat:line",
                            format!("Failed to resolve {remote_serial}: {err}"),
                        );
                        return;
                    }
                };
                let mut device = match ADBTcpDevice::new_with_custom_private_key(socket, key_path) {
                    Ok(device) => device,
                    Err(err) => {
                        let _ = handle.emit(
                            "logcat:line",
                            format!("Failed to connect to {remote_serial}: {err}"),
                        );
                        return;
                    }
                };
                let mut out = AndroidLogcatEmitter::new(handle.clone());
                let mut err = AndroidLogcatEmitter::new(handle.clone());
                if let Err(log_err) =
                    device.shell_command(&"logcat -v brief -d", Some(&mut out), Some(&mut err))
                {
                    let _ = handle.emit("logcat:line", format!("Remote logcat failed: {log_err}"));
                } else {
                    let _ = out.flush();
                    let _ = err.flush();
                }
            });
            return Ok(());
        }

        let mut child = Command::new("logcat")
            .args(["-v", "brief"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start logcat: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture logcat stdout".to_string())?;
        let handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let _ = handle.emit("logcat:line", line);
                    }
                    Err(_) => break,
                }
            }
        });

        *state.0.lock().unwrap() = Some(child);
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
        let (mut rx, child) = app
            .shell()
            .sidecar("adb")
            .map_err(|e| e.to_string())?
            .args(&["-s", &serial, "logcat", "-v", "brief"])
            .spawn()
            .map_err(|e| e.to_string())?;
        *state.0.lock().unwrap() = Some(child);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let _ =
                            handle.emit("logcat:line", String::from_utf8_lossy(&line).to_string());
                    }
                    CommandEvent::Terminated(_) => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }
}

#[tauri::command]
async fn stop_logcat(state: tauri::State<'_, LogcatProcess>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
async fn extract_and_install_xapk(
    app: tauri::AppHandle,
    serial: String,
    path: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    if is_android_local_serial(&serial) {
        return Ok(serde_json::json!({
            "ok": false,
            "stdout": "",
            "stderr": "Split APK / XAPK install on the local Android device is not supported yet. Use a standard APK for now."
        }));
    }

    // ── 1. Extract zip to a temp directory ───────────────────────────────────
    let src = std::path::PathBuf::from(&path);
    let tmp = std::env::temp_dir().join(format!(
        "nt_xapk_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("failed to create temp dir: {e}"))?;

    let _ = app.emit(
        "xapk:progress",
        serde_json::json!({ "stage": "extracting", "msg": "Extracting archive…" }),
    );

    let tmp_clone = tmp.clone();
    let src_clone = src.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::open(&src_clone).map_err(|e| format!("cannot open file: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("not a valid zip: {e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.mangled_name();
            // Only extract .apk files (skip OBB, manifest, icon, etc.)
            if name.extension().and_then(|e| e.to_str()) != Some("apk") {
                continue;
            }
            // Flatten to temp root — no subdirectory traversal
            let filename = name.file_name().unwrap_or(name.as_os_str());
            let dest = tmp_clone.join(filename);
            let mut out =
                std::fs::File::create(&dest).map_err(|e| format!("cannot write {dest:?}: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // ── 2. Collect extracted APKs ─────────────────────────────────────────────
    let apk_paths: Vec<String> = std::fs::read_dir(&tmp)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("apk"))
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();

    if apk_paths.is_empty() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("No APK files found inside the archive".to_string());
    }

    let _ = app.emit(
        "xapk:progress",
        serde_json::json!({
            "stage": "installing",
            "msg": format!("Installing {} APK(s)…", apk_paths.len()),
            "count": apk_paths.len(),
        }),
    );

    // ── 3. Install: install-multiple for splits, install for single ───────────
    let output = if apk_paths.len() > 1 {
        let mut args = vec![
            "-s".to_string(),
            serial.clone(),
            "install-multiple".to_string(),
            "-r".to_string(),
        ];
        args.extend(apk_paths.iter().cloned());
        app.shell()
            .sidecar("adb")
            .map_err(|e| e.to_string())?
            .args(&args)
            .output()
            .await
            .map_err(|e| e.to_string())?
    } else {
        app.shell()
            .sidecar("adb")
            .map_err(|e| e.to_string())?
            .args(["-s", &serial, "install", "-r", &apk_paths[0]])
            .output()
            .await
            .map_err(|e| e.to_string())?
    };

    // ── 4. Clean up temp dir ──────────────────────────────────────────────────
    let _ = std::fs::remove_dir_all(&tmp);

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let ok = output.status.success() || stdout.contains("Success");

    let _ = app.emit(
        "xapk:progress",
        serde_json::json!({
            "stage": if ok { "done" } else { "error" },
            "msg": if ok { "Installation complete" } else { stderr.trim() },
        }),
    );

    Ok(serde_json::json!({ "ok": ok, "stdout": stdout, "stderr": stderr, "apks": apk_paths.len() }))
}

#[tauri::command]
fn get_platform() -> &'static str {
    #[cfg(target_os = "android")]
    {
        return "android";
    }
    #[cfg(target_os = "macos")]
    {
        return "macos";
    }
    #[cfg(target_os = "windows")]
    {
        return "windows";
    }
    #[cfg(target_os = "linux")]
    {
        return "linux";
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        return "desktop";
    }
}

/// Kill the bundled ADB sidecar server. Called on window close and app exit.
/// Spawns asynchronously so it does not block the event thread.
#[cfg(not(target_os = "android"))]
fn kill_adb_sidecar(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Ok(cmd) = app.shell().sidecar("adb") {
            let _ = cmd.args(["kill-server"]).output().await;
            println!("[adb] kill-server sent on app exit");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(LogcatProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                #[cfg(not(target_os = "android"))]
                {
                    use tauri::Manager;
                    kill_adb_sidecar(window.app_handle().clone());
                }
            }
            _ => {}
        });

    #[cfg(target_os = "android")]
    {
        builder = builder.manage(AndroidAdbState(Mutex::new(BTreeSet::new())));
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // On Windows, copy AdbWinApi.dll and AdbWinUsbApi.dll next to the adb sidecar.
            // tauri-plugin-shell resolves sidecars relative to the current executable directory,
            // but bundled resources land in resource_dir which may differ from exe dir.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let (Ok(resource_dir), Ok(exe)) =
                    (app.path().resource_dir(), std::env::current_exe())
                {
                    if let Some(exe_dir) = exe.parent() {
                        for dll in &["AdbWinApi.dll", "AdbWinUsbApi.dll"] {
                            let dst = exe_dir.join(dll);
                            if dst.exists() {
                                continue;
                            }
                            // Production: resource_dir root; dev fallback: resource_dir/binaries
                            let src = resource_dir.join(dll);
                            let src_dev = resource_dir.join("binaries").join(dll);
                            let source = if src.exists() {
                                Some(src)
                            } else if src_dev.exists() {
                                Some(src_dev)
                            } else {
                                None
                            };
                            match source {
                                Some(s) => {
                                    let _ = std::fs::copy(&s, &dst);
                                }
                                None => println!(
                                    "[setup] {dll} not found in resource_dir, skipping copy"
                                ),
                            }
                        }
                    }
                }
            }

            // Desktop-only: poll ADB sidecar for connected devices every 2 s.
            // On Android the device IS the host — no sidecar polling needed.
            #[cfg(not(target_os = "android"))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut last = String::new();
                    loop {
                        if let Ok(stdout) = adb_output(&handle, &["devices", "-l"]).await {
                            if stdout != last {
                                last = stdout.clone();
                                let _ = handle.emit("devices:changed", &parse_devices(&stdout));
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                });
            }
            #[cfg(target_os = "android")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let state = handle.state::<AndroidAdbState>();
                        let _ =
                            handle.emit("devices:changed", android_list_devices(&handle, &state));
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_adb,
            run_fastboot,
            capture_screen_frame,
            install_from_url,
            search_apks,
            fetch_github_picks,
            refresh_fdroid_index,
            start_logcat,
            stop_logcat,
            open_in_finder,
            extract_and_install_xapk,
            get_platform
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                #[cfg(not(target_os = "android"))]
                kill_adb_sidecar(app_handle.clone());
            }
        });
}
