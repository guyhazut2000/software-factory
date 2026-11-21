use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

#[derive(Clone, Serialize)]
struct Info {
    port: u16,
    token: String,
    log: String,
}

struct Orchestrator {
    child: Mutex<Option<Child>>,
    info: Info,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(47821)
}

/// GUI apps on macOS/Linux do not inherit the login shell PATH (nvm, homebrew, ~/.local/bin ...).
/// Ask the user's login shell for it so `gh`, `sbx`, `claude`, `codex` are found.
#[cfg(unix)]
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell)
        .args(["-ilc", "echo __SFPATH__$PATH"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.lines().rev().find_map(|l| l.strip_prefix("__SFPATH__").map(|s| s.to_string()))
}

#[cfg(not(unix))]
fn login_path() -> Option<String> {
    None
}

fn clean(p: PathBuf) -> PathBuf {
    // strip the Windows verbatim prefix that node does not always like
    let s = p.to_string_lossy().to_string();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

fn find_node() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "sf-node.exe" } else { "sf-node" };
            let p = dir.join(name);
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from("node") // dev fallback: system node (needs >= 22.13)
}

fn find_resource(app: &tauri::AppHandle, rel: &str, dev_rel: &str) -> PathBuf {
    if let Ok(p) = app.path().resolve(rel, tauri::path::BaseDirectory::Resource) {
        if p.exists() {
            return clean(p);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(dev_rel)
}

fn start_orchestrator(app: &tauri::AppHandle) -> Orchestrator {
    let port = free_port();
    let agent_port = free_port();
    let token: String = rand::thread_rng().sample_iter(&Alphanumeric).take(40).map(char::from).collect();
    let script = find_resource(app, "resources/orchestrator.mjs", "../../../packages/orchestrator/dist/orchestrator.mjs");
    let skills = find_resource(app, "resources/skills", "../../../skills");
    let log_dir = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("orchestrator.log");
    let log = std::fs::File::create(&log_path).ok();

    let mut cmd = Command::new(find_node());
    cmd.arg(script)
        .env("SF_PORT", port.to_string())
        .env("SF_AGENT_PORT", agent_port.to_string())
        .env("SF_API_TOKEN", &token)
        .env("SF_SKILLS_DIR", skills)
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::null());
    if let Some(p) = login_path() {
        cmd.env("PATH", p);
    }
    match log.and_then(|f| f.try_clone().ok().map(|g| (f, g))) {
        Some((o, e)) => {
            cmd.stdout(Stdio::from(o)).stderr(Stdio::from(e));
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| eprintln!("failed to start orchestrator: {e}")).ok();
    Orchestrator {
        child: Mutex::new(child),
        info: Info { port, token, log: log_path.to_string_lossy().to_string() },
    }
}

#[tauri::command]
fn orchestrator_info(state: tauri::State<Orchestrator>) -> Info {
    state.info.clone()
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("software-factory", "github-token").map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_set(token: String) -> Result<(), String> {
    entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let orch = start_orchestrator(app.handle());
            app.manage(orch);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![orchestrator_info, keychain_set, keychain_get, keychain_delete])
        .build(tauri::generate_context!())
        .expect("error while building Software Factory")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(o) = app.try_state::<Orchestrator>() {
                    if let Some(mut c) = o.child.lock().unwrap().take() {
                        let _ = c.kill();
                    }
                }
            }
        });
}
