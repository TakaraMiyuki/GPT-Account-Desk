#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod clipboard;
mod codex;
mod device;
mod import;
mod login;
mod model;
mod prices;
mod quota;
mod usage;
mod usage_commands;
mod vault;

use fs2::FileExt;
use model::{now, Account, AccountInput, Availability, ConnectionState, Link, Settings};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use uuid::Uuid;
use vault::Vault;
use zeroize::Zeroizing;

const LOCKED: &str = "账号库已锁定，请先解锁。";

struct Inner {
    current: Option<Vault>,
    generation: u64,
    notify_lock: bool,
    codex_exe: Option<PathBuf>,
}

impl Inner {
    fn expire(&mut self) {
        if self.current.as_ref().is_some_and(Vault::expired) {
            self.lock();
            self.notify_lock = true;
        }
    }

    fn lock(&mut self) {
        self.current = None;
        self.generation += 1;
        self.notify_lock = false;
    }

    fn vault(&mut self) -> Result<&mut Vault, String> {
        self.expire();
        self.current.as_mut().ok_or_else(|| LOCKED.into())
    }
}

struct AppState {
    path: PathBuf,
    profiles: PathBuf,
    executable_config: PathBuf,
    device_token: PathBuf,
    inner: Mutex<Inner>,
    codex_jobs: tokio::sync::Mutex<()>,
    login_attempt: Mutex<Option<(Uuid, Arc<login::Attempt>)>>,
    usage_cache: Mutex<Option<usage_commands::Cache>>,
    prices: prices::PriceStore,
    clipboard: Mutex<Clipboard>,
    _instance: File,
}

#[derive(Default)]
struct Clipboard {
    generation: u64,
    sequence: Option<std::num::NonZeroU32>,
}

impl AppState {
    fn new(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|_| "无法创建本地数据目录。")?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("instance.lock"))
            .map_err(|_| "无法打开账号簿。")?;
        file.try_lock_exclusive()
            .map_err(|_| "账号簿已打开，请切换到已有窗口。")?;
        let executable_config = directory.join("codex-path.txt");
        let codex_exe = fs::read_to_string(&executable_config)
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .or_else(codex::executable_from_path);
        let path = directory.join("accounts.vault");
        let device_token = directory.join("trusted-device.dat");
        let current = if path.is_file() && device_token.is_file() {
            Vault::from_device(&path, &device_token).ok()
        } else {
            None
        };
        Ok(Self {
            path,
            profiles: directory.join("codex"),
            executable_config,
            device_token,
            inner: Mutex::new(Inner {
                current,
                generation: 0,
                notify_lock: false,
                codex_exe,
            }),
            codex_jobs: tokio::sync::Mutex::new(()),
            login_attempt: Mutex::new(None),
            usage_cache: Mutex::new(None),
            prices: prices::PriceStore::new(directory.join("priceai-snapshots.json")),
            clipboard: Mutex::new(Clipboard::default()),
            _instance: file,
        })
    }

    fn guard(&self) -> Result<MutexGuard<'_, Inner>, String> {
        self.inner.lock().map_err(|_| "账号库暂时无法读取。".into())
    }

    fn view(&self, inner: &Inner) -> Value {
        let executable = inner
            .codex_exe
            .as_deref()
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy());
        match &inner.current {
            Some(vault) => json!({
                "phase": "unlocked", "accounts": vault.book.accounts.iter().map(Account::view).collect::<Vec<_>>(),
                "settings": vault.book.settings, "codexPath": executable,
                "usageSources": vault.book.usage_sources, "deviceTrusted": self.device_token.is_file(), "manualOrder": vault.book.manual_order, "hasCustomOrder": vault.book.has_custom_order
            }),
            None => json!({
                "phase": if self.path.exists() { "locked" } else { "new" },
                "deviceTrusted": self.path.exists() && self.device_token.is_file()
            }),
        }
    }

    fn clear_usage_cache(&self) {
        if let Ok(mut cache) = self.usage_cache.lock() {
            *cache = None;
        }
    }

    fn pending_login(&self, attempt: Uuid) -> Option<Arc<login::Attempt>> {
        self.login_attempt
            .lock()
            .ok()?
            .as_ref()
            .filter(|(id, _)| *id == attempt)
            .map(|(_, login)| Arc::clone(login))
    }

    fn cancel_active_login(&self) {
        if let Ok(slot) = self.login_attempt.lock() {
            if let Some((_, login)) = slot.as_ref() {
                login.cancel();
            }
        }
    }

    fn profile(&self, id: Uuid) -> PathBuf {
        self.profiles.join(id.to_string())
    }

    fn clear_clipboard(&self, expected: Option<u64>) {
        let Ok(mut owned) = self.clipboard.lock() else {
            return;
        };
        if expected.is_some_and(|generation| generation != owned.generation) {
            return;
        }
        if let Some(sequence) = owned.sequence {
            if clipboard::clear(sequence) {
                owned.sequence = None;
                owned.generation += 1;
            }
        }
    }

    fn copy(&self, owner: *mut std::ffi::c_void, value: &str) -> Result<u64, String> {
        let mut owned = self
            .clipboard
            .lock()
            .map_err(|_| "暂时无法访问系统剪贴板。")?;
        owned.sequence = Some(clipboard::write(owner, value)?);
        owned.generation += 1;
        Ok(owned.generation)
    }
}

fn get_account(accounts: &[Account], id: Uuid) -> Result<&Account, String> {
    accounts
        .iter()
        .find(|account| account.info.id == id)
        .ok_or_else(|| "这条账号记录已不存在。".into())
}

fn get_account_mut(accounts: &mut [Account], id: Uuid) -> Result<&mut Account, String> {
    accounts
        .iter_mut()
        .find(|account| account.info.id == id)
        .ok_or_else(|| "这条账号记录已不存在。".into())
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Result<Value, String> {
    let mut inner = state.guard()?;
    inner.expire();
    Ok(state.view(&inner))
}

#[tauri::command]
async fn unlock(
    app: AppHandle,
    password: Zeroizing<String>,
    create: bool,
    remember: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut inner = state.guard()?;
        inner.expire();
        if inner.current.is_some() {
            return Ok(json!({"snapshot": state.view(&inner), "warning": null}));
        }
        let vault = if create && !state.path.exists() {
            let vault = Vault::new(&password)?;
            vault.write(&state.path, &vault.book)?;
            vault
        } else if !create && state.path.exists() {
            Vault::from_file(&state.path, &password)?
        } else {
            return Err("账号库的状态已变化，请重新打开此窗口。".into());
        };
        let warning = match remember {
            Some(true) => vault.remember_device(&state.device_token).err(),
            Some(false) => device::forget(&state.device_token).err(),
            None => None,
        };
        inner.current = Some(vault);
        inner.notify_lock = false;
        inner.generation += 1;
        Ok(json!({"snapshot": state.view(&inner), "warning": warning}))
    })
    .await
    .map_err(|_| "无法打开加密库。")?
}

#[tauri::command]
async fn unlock_device(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut inner = state.guard()?;
        inner.expire();
        if inner.current.is_none() {
            inner.current = Some(
                Vault::from_device(&state.path, &state.device_token)
                    .map_err(|_| "本机解锁凭据不可用，请输入主密码。")?,
            );
            inner.notify_lock = false;
            inner.generation += 1;
        }
        Ok(state.view(&inner))
    })
    .await
    .map_err(|_| "无法使用本机解锁。")?
}

#[tauri::command]
fn trust_device(state: State<AppState>, trusted: bool) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    if trusted {
        vault.remember_device(&state.device_token)?;
    } else {
        device::forget(&state.device_token)?;
    }
    vault.activity();
    Ok(state.view(&inner))
}

#[tauri::command]
fn reorder_accounts(state: State<AppState>, ids: Vec<Uuid>) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    if ids.len() != book.accounts.len() {
        return Err("账号列表已变化，请重试。".into());
    }
    let mut by_id: std::collections::HashMap<_, _> = book
        .accounts
        .into_iter()
        .map(|row| (row.info.id, row))
        .collect();
    book.accounts = ids
        .into_iter()
        .map(|id| by_id.remove(&id).ok_or("排序列表不完整，请重试。"))
        .collect::<Result<_, _>>()?;
    book.manual_order = true;
    book.has_custom_order = true;
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(state.view(&inner))
}

#[tauri::command]
fn set_order_mode(state: State<AppState>, manual: bool) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    if manual && !book.has_custom_order {
        return Err("请先拖动一条账号。".into());
    }
    book.manual_order = manual;
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(state.view(&inner))
}

#[tauri::command]
fn import_accounts(
    state: State<AppState>,
    input: Zeroizing<String>,
    commit: bool,
) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let (rows, issues) = import::plan(&input, &vault.book.accounts)?;
    let count = rows.len();
    if commit && count > 0 {
        let mut book = vault.book.clone();
        book.accounts.extend(rows);
        vault.commit(&state.path, book)?;
    }
    vault.activity();
    Ok(
        json!({"count": count, "issues": issues, "snapshot": if commit { state.view(&inner) } else { Value::Null }}),
    )
}

#[tauri::command]
fn lock(state: State<AppState>) -> Result<Value, String> {
    let mut inner = state.guard()?;
    inner.lock();
    state.cancel_active_login();
    state.clear_usage_cache();
    state.clear_clipboard(None);
    Ok(state.view(&inner))
}

#[tauri::command]
fn keep_active(state: State<AppState>) -> Result<(), String> {
    let mut inner = state.guard()?;
    inner.vault()?.activity();
    Ok(())
}

#[tauri::command]
fn save_account(state: State<AppState>, account: AccountInput) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    let existing = account
        .id
        .map(|id| get_account(&book.accounts, id))
        .transpose()?;
    let updated = account.into_account(existing)?;
    if book.accounts.iter().any(|row| {
        row.info.id != updated.info.id && row.info.number.eq_ignore_ascii_case(&updated.info.number)
    }) {
        return Err("该账号编号已存在。".into());
    }
    let id = updated.info.id;
    if let Some(row) = book.accounts.iter_mut().find(|e| e.info.id == id) {
        *row = updated;
    } else {
        book.accounts.push(updated);
    }
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(json!({ "id": id, "snapshot": state.view(&inner) }))
}

#[tauri::command]
fn mark_accounts(
    state: State<AppState>,
    ids: Vec<Uuid>,
    availability: Availability,
) -> Result<Value, String> {
    if ids.is_empty() {
        return Err("请先选择账号。".into());
    }
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    let time = now();
    for id in ids {
        let row = get_account_mut(&mut book.accounts, id)?;
        row.info.availability = availability;
        row.info.verified_at = if matches!(availability, Availability::Unchecked) {
            None
        } else {
            Some(time)
        };
        row.info.updated_at = time;
    }
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(state.view(&inner))
}

async fn release_profile(state: &AppState, exe: Option<&Path>, profile: Uuid) -> bool {
    let home = state.profile(profile);
    if !home.is_dir() {
        return true;
    }
    let Some(exe) = exe else {
        return false;
    };
    if !fs::canonicalize(&home)
        .ok()
        .zip(fs::canonicalize(&state.profiles).ok())
        .is_some_and(|(resolved, root)| {
            resolved.parent() == Some(&root) && resolved.file_name() == home.file_name()
        })
    {
        return false;
    }
    if codex::logout(exe, &home).await.is_err() {
        return false;
    }
    fs::remove_dir_all(home).is_ok()
}

#[tauri::command]
async fn remove_account(state: State<'_, AppState>, id: Uuid) -> Result<Value, String> {
    let _job = state
        .codex_jobs
        .try_lock()
        .map_err(|_| "Codex 操作正在进行，请稍后再试。")?;
    let (profile, exe) = {
        let mut inner = state.guard()?;
        let exe = inner.codex_exe.clone();
        let vault = inner.vault()?;
        let mut book = vault.book.clone();
        let profile = get_account(&book.accounts, id)?
            .link
            .as_ref()
            .map(|link| link.profile);
        if profile.is_some() && exe.as_ref().is_none_or(|path| !path.is_file()) {
            return Err("请先恢复 Codex CLI 路径，以便移除此账号的本地授权。".into());
        }
        book.accounts.retain(|row| row.info.id != id);
        for source in &mut book.usage_sources {
            if source.account_id == Some(id) {
                source.account_id = None;
            }
        }
        vault.commit(&state.path, book)?;
        vault.activity();
        (profile, exe)
    };
    let warning = match profile {
        Some(profile) if !release_profile(&state, exe.as_deref(), profile).await => {
            Some("记录已删除，但 Codex 本地授权清理失败。")
        }
        _ => None,
    };
    let inner = state.guard()?;
    Ok(json!({ "snapshot": state.view(&inner), "warning": warning }))
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<Value, String> {
    settings.validate()?;
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    book.settings = settings;
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(state.view(&inner))
}

#[tauri::command]
fn reveal_password(state: State<AppState>, id: Uuid) -> Result<String, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    vault.activity();
    let secret = &get_account(&vault.book.accounts, id)?.password;
    if secret.is_empty() {
        return Err("这个账号没有保存密码。".into());
    }
    Ok(secret.to_string())
}

#[tauri::command]
fn read_totp(state: State<AppState>, id: Uuid) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let account = get_account(&vault.book.accounts, id)?;
    if account.totp.is_empty() {
        return Err("这个账号没有保存验证器密钥。".into());
    }
    let time = now();
    Ok(json!({ "code": model::totp_code(&account.totp, time)?, "expiresAt": (time / 30 + 1) * 30 }))
}

#[tauri::command]
fn copy_credential(app: AppHandle, id: Uuid, kind: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    vault.activity();
    let account = get_account(&vault.book.accounts, id)?;
    let value = match kind.as_str() {
        "email" => Zeroizing::new(account.info.email.clone()),
        "password" if !account.password.is_empty() => account.password.clone(),
        "totp" if !account.totp.is_empty() => {
            Zeroizing::new(model::totp_code(&account.totp, now())?)
        }
        _ => return Err("该凭据尚未录入。".into()),
    };

    copy_and_clear(app.clone(), &value)
}

fn copy_and_clear(app: AppHandle, value: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let window = app.get_webview_window("main").ok_or("账号簿窗口已关闭。")?;
    let token = state.copy(window.hwnd().map_err(|_| "无法访问账号簿窗口。")?.0, value)?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(25)).await;
        app.state::<AppState>().clear_clipboard(Some(token));
    });
    Ok(())
}

fn selected_path(selection: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    selection
        .map(|item| item.into_path().map_err(|_| "请选择本机文件。".into()))
        .transpose()
}

#[tauri::command]
async fn discover_codex(state: State<'_, AppState>) -> Result<Value, String> {
    {
        state.guard()?.vault()?;
    }
    let executable = codex::discover_executable()
        .await
        .ok_or("未找到 Codex CLI。请安装 Codex CLI，或选择已有的 codex.exe。")?;
    let mut inner = state.guard()?;
    inner.vault()?.activity();
    vault::write_atomic(
        &state.executable_config,
        executable.to_string_lossy().as_bytes(),
    )?;
    inner.codex_exe = Some(executable);
    Ok(state.view(&inner))
}

#[tauri::command]
async fn choose_codex(app: AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.guard()?.vault()?;
        let selected = selected_path(
            app.dialog()
                .file()
                .add_filter("Codex CLI", &["exe"])
                .set_title("选择 Codex CLI 程序")
                .blocking_pick_file(),
        )?;
        let Some(path) = selected else {
            return Ok(None);
        };
        if !path.is_absolute()
            || !path.is_file()
            || !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("codex.exe"))
        {
            return Err("请选择可信来源的 codex.exe。".into());
        }
        let mut inner = state.guard()?;
        inner.vault()?.activity();
        fs::write(&state.executable_config, path.to_string_lossy().as_bytes())
            .map_err(|_| "无法保存 CLI 路径。")?;
        inner.codex_exe = Some(path);
        Ok(Some(state.view(&inner)))
    })
    .await
    .map_err(|_| "无法选择 Codex 程序。")?
}

#[tauri::command]
async fn export_backup(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.guard()?.vault()?;
        let selection = selected_path(
            app.dialog()
                .file()
                .add_filter("账号簿加密备份", &["vault"])
                .set_file_name("Account Desk Backup.vault")
                .blocking_save_file(),
        )?;
        let Some(path) = selection else {
            return Ok(false);
        };
        if path == state.path
            || fs::canonicalize(&path)
                .ok()
                .zip(fs::canonicalize(&state.path).ok())
                .is_some_and(|(destination, original)| {
                    destination
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&original.to_string_lossy())
                })
        {
            return Err("请选择与当前加密库不同的保存位置。".into());
        }
        let mut inner = state.guard()?;
        let vault = inner.vault()?;
        let mut backup = vault.book.clone();
        for row in &mut backup.accounts {
            row.link = None;
        }
        vault.write(&path, &backup)?;
        vault.activity();
        Ok(true)
    })
    .await
    .map_err(|_| "无法导出加密备份。")?
}

#[tauri::command]
async fn restore_backup(
    app: AppHandle,
    password: Zeroizing<String>,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _job = state
            .codex_jobs
            .try_lock()
            .map_err(|_| "Codex 操作正在进行，请稍后再试。")?;
        let generation = state.guard()?.generation;
        let selection = selected_path(
            app.dialog()
                .file()
                .add_filter("账号簿加密备份", &["vault"])
                .set_title("选择加密备份")
                .blocking_pick_file(),
        )?;
        let Some(path) = selection else {
            return Ok(None);
        };
        let mut incoming = Vault::from_file(&path, &password)?;
        let mut inner = state.guard()?;
        inner.expire();
        if generation != inner.generation {
            return Err(LOCKED.into());
        }
        for row in &mut incoming.book.accounts {
            row.link = None;
        }
        if let Some(vault) = inner.current.as_mut() {
            // Keep local authorizations only when the prior record and its identity both match.
            for row in &mut incoming.book.accounts {
                if let Ok(previous) = get_account(&vault.book.accounts, row.info.id) {
                    if row.info.email.eq_ignore_ascii_case(&previous.info.email) {
                        row.link = previous.link.clone();
                    }
                }
            }
            if vault.book.accounts.iter().any(|row| {
                row.link.is_some()
                    && !incoming
                        .book
                        .accounts
                        .iter()
                        .any(|target| target.info.id == row.info.id && target.link.is_some())
            }) {
                return Err("该备份会覆盖已连接的账号。请先断开这些账号的 Codex 连接。".into());
            }
            vault.commit(&state.path, std::mem::take(&mut incoming.book))?;
            vault.activity();
        } else if !state.path.exists() {
            incoming.write(&state.path, &incoming.book)?;
            incoming.activity();
            inner.current = Some(incoming);
            inner.notify_lock = false;
        } else {
            return Err(LOCKED.into());
        }
        inner.generation += 1;
        Ok(Some(state.view(&inner)))
    })
    .await
    .map_err(|_| "无法恢复加密备份。")?
}

#[tauri::command]
fn codex_login_stage(state: State<AppState>, attempt: Uuid) -> Option<login::Stage> {
    state.pending_login(attempt).map(|current| current.stage())
}

#[tauri::command]
fn cancel_codex_login(state: State<AppState>, attempt: Uuid) -> bool {
    state
        .pending_login(attempt)
        .is_some_and(|current| current.cancel())
}

#[tauri::command]
fn copy_codex_login_url(app: AppHandle, attempt: Uuid) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut inner = state.guard()?;
    inner.vault()?.activity();
    let url = state
        .pending_login(attempt)
        .and_then(|current| current.url())
        .ok_or("授权链接已失效。")?;
    copy_and_clear(app.clone(), &url)
}

#[tauri::command]
async fn connect_codex(
    state: State<'_, AppState>,
    id: Uuid,
    attempt: Uuid,
    private_window: bool,
) -> Result<Value, String> {
    let _job = state
        .codex_jobs
        .try_lock()
        .map_err(|_| "已有 Codex 操作，请稍候。")?;
    let pending = Arc::new(login::Attempt::new());
    let (exe, expected_email, generation, old_profile) = {
        let mut inner = state.guard()?;
        inner.expire();
        let exe = inner
            .codex_exe
            .clone()
            .filter(|path| path.is_file())
            .ok_or("请先在设置中选择 Codex CLI。")?;
        let generation = inner.generation;
        let vault = inner.vault()?;
        vault.activity();
        let row = get_account(&vault.book.accounts, id)?;
        *state
            .login_attempt
            .lock()
            .map_err(|_| "无法开始 Codex 登录。")? = Some((attempt, Arc::clone(&pending)));
        (
            exe,
            row.info.email.clone(),
            generation,
            row.link.as_ref().map(|link| link.profile),
        )
    };
    let profile = Uuid::new_v4();
    let authorized = codex::authorize(
        &exe,
        &state.profile(profile),
        &expected_email,
        &pending,
        private_window,
    )
    .await;
    let result = (|| -> Result<(), login::Error> {
        let observation = authorized?;
        let mut inner = state.guard()?;
        inner.expire();
        if generation != inner.generation {
            return Err(LOCKED.into());
        }
        let vault = inner.vault()?;
        let mut book = vault.book.clone();
        let row = get_account_mut(&mut book.accounts, id)?;
        if !row.info.email.eq_ignore_ascii_case(&expected_email) {
            return Err("授权期间账号邮箱发生变化，请重新连接。".into());
        }
        if !pending.begin_commit() {
            return Err(login::Error::Cancelled);
        }
        row.link = Some(Link {
            profile,
            email: expected_email.clone(),
            observation,
            usage: None,
        });
        vault.commit(&state.path, book)?;
        vault.activity();
        Ok(())
    })();
    let response = match result {
        Ok(()) => {
            let warning = match old_profile {
                Some(previous) if !release_profile(&state, Some(&exe), previous).await => {
                    Some("新连接已建立，但旧的本地授权清理失败。")
                }
                _ => None,
            };
            Ok((false, warning))
        }
        Err(error) => {
            let cancelled = matches!(error, login::Error::Cancelled)
                || pending.stage() == login::Stage::Cancelling;
            // Invalidate the browser link immediately and keep cleanup limited to the new profile.
            if !cancelled {
                pending.finishing();
            }
            let cleanup = tokio::time::timeout(
                Duration::from_secs(5),
                release_profile(&state, Some(&exe), profile),
            )
            .await
            .unwrap_or(false);
            if cancelled {
                Ok((
                    true,
                    (!cleanup).then_some("已取消登录，临时授权清理未完成。"),
                ))
            } else if let login::Error::Failed(message) = error {
                Err(message)
            } else {
                unreachable!()
            }
        }
    };
    if let Ok(mut slot) = state.login_attempt.lock() {
        *slot = None;
    }
    let (cancelled, warning) = response?;
    let inner = state.guard()?;
    Ok(json!({ "snapshot": state.view(&inner), "warning": warning, "cancelled": cancelled }))
}

#[tauri::command]
async fn disconnect_codex(state: State<'_, AppState>, id: Uuid) -> Result<Value, String> {
    let _job = state
        .codex_jobs
        .try_lock()
        .map_err(|_| "已有 Codex 操作，请稍候。")?;
    let (exe, profile, generation) = {
        let mut inner = state.guard()?;
        let exe = inner.codex_exe.clone();
        let generation = inner.generation;
        let vault = inner.vault()?;
        let row = get_account(&vault.book.accounts, id)?;
        let profile = row.link.as_ref().ok_or("这个账号尚未连接。")?.profile;
        (exe, profile, generation)
    };
    if !release_profile(&state, exe.as_deref(), profile).await {
        return Err("未能清除本地授权，请确认 Codex CLI 可用后重试。".into());
    }
    let mut inner = state.guard()?;
    inner.expire();
    if inner.generation != generation {
        return Err(LOCKED.into());
    }
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    get_account_mut(&mut book.accounts, id)?.link = None;
    vault.commit(&state.path, book)?;
    vault.activity();
    Ok(state.view(&inner))
}

#[tauri::command]
async fn refresh_accounts(
    state: State<'_, AppState>,
    ids: Option<Vec<Uuid>>,
    automatic: Option<bool>,
) -> Result<Value, String> {
    let _job = state
        .codex_jobs
        .try_lock()
        .map_err(|_| "已有 Codex 操作，请稍候。")?;
    let (exe, connections, generation) = {
        let mut inner = state.guard()?;
        inner.expire();
        let exe = inner
            .codex_exe
            .clone()
            .filter(|path| path.is_file())
            .ok_or("请先在设置中选择 Codex CLI。")?;
        let generation = inner.generation;
        let vault = inner.vault()?;
        let requested = ids.map(|ids| ids.into_iter().collect::<std::collections::HashSet<_>>());
        let time = now();
        let connections = vault
            .book
            .accounts
            .iter()
            .filter_map(|row| {
                let link = row.link.as_ref()?;
                if requested
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&row.info.id))
                {
                    return None;
                }
                if automatic.unwrap_or(false)
                    && (matches!(link.observation.state, ConnectionState::Reauth)
                        || (link.observation.quota.is_some()
                            && time.saturating_sub(link.observation.checked_at) < 60))
                {
                    return None;
                }
                Some((row.info.id, row.info.email.clone(), link.clone()))
            })
            .collect::<Vec<_>>();
        (exe, connections, generation)
    };
    let mut connections = connections.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut results = std::collections::HashMap::new();
    loop {
        while tasks.len() < 3 {
            let Some((id, email, link)) = connections.next() else {
                break;
            };
            let exe = exe.clone();
            let profile_home = state.profile(link.profile);
            tasks.spawn(async move {
                let observation = codex::check(
                    &exe,
                    &profile_home,
                    &link.email,
                    &link.observation,
                    Some(&email),
                )
                .await;
                (id, email, link.profile, observation)
            });
        }
        let Some(result) = tasks.join_next().await else {
            break;
        };
        {
            let mut inner = state.guard()?;
            inner.expire();
            if inner.generation != generation {
                return Err(LOCKED.into());
            }
        }
        let (id, email, profile, observation) = result.map_err(|_| "Codex 检查进程中断。")?;
        results.insert(id, (email, profile, observation));
    }
    let mut inner = state.guard()?;
    inner.expire();
    if inner.generation != generation {
        return Err(LOCKED.into());
    }
    if !results.is_empty() {
        let vault = inner.vault()?;
        let mut book = vault.book.clone();
        for row in &mut book.accounts {
            let Some((email, profile, observation)) = results.remove(&row.info.id) else {
                continue;
            };
            if !row.info.email.eq_ignore_ascii_case(&email) {
                continue;
            }
            if let Some(link) = row.link.as_mut().filter(|link| link.profile == profile) {
                link.observation = observation;
            }
        }
        vault.commit(&state.path, book)?;
    }
    Ok(state.view(&inner))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let directory = match std::env::args_os().skip(1).next() {
                Some(argument) if argument == "--data-dir" => {
                    let directory = std::env::args_os()
                        .nth(2)
                        .map(PathBuf::from)
                        .filter(|path| path.is_absolute())
                        .ok_or("数据目录须为完整路径。")?;
                    directory
                }
                _ => app.path().app_local_data_dir()?,
            };
            let state = AppState::new(&directory)?;
            app.manage(state);
            let price_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    price_handle
                        .state::<AppState>()
                        .prices
                        .poll_background()
                        .await;
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    let state = handle.state::<AppState>();
                    let expired = state.guard().is_ok_and(|mut inner| {
                        inner.expire();
                        std::mem::take(&mut inner.notify_lock)
                    });
                    if expired {
                        state.cancel_active_login();
                        state.clear_usage_cache();
                        state.clear_clipboard(None);
                        let _ = handle.emit("vault-locked", ());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            unlock,
            unlock_device,
            trust_device,
            reorder_accounts,
            set_order_mode,
            import_accounts,
            lock,
            keep_active,
            save_account,
            mark_accounts,
            remove_account,
            save_settings,
            reveal_password,
            read_totp,
            copy_credential,
            choose_codex,
            discover_codex,
            export_backup,
            restore_backup,
            connect_codex,
            codex_login_stage,
            cancel_codex_login,
            copy_codex_login_url,
            usage_commands::add_usage_source,
            usage_commands::remove_usage_source,
            usage_commands::assign_usage_source,
            prices::read_prices,
            prices::sync_prices,
            prices::open_price_source,
            usage_commands::local_usage,
            disconnect_codex,
            refresh_accounts
        ])
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<AppState>().clear_clipboard(None);
            }
        }),
        Err(error) => {
            // Startup failures may occur before the event loop is available.
            eprintln!("{error}");
            #[cfg(windows)]
            {
                let body = format!("账号簿无法打开。\n{error}");
                startup_message(&body);
            }
        }
    }
}

#[cfg(windows)]
fn startup_message(body: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let text: Vec<_> = body.encode_utf16().chain([0]).collect();
    let caption: Vec<_> = "账号簿".encode_utf16().chain([0]).collect();
    unsafe {
        MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10);
    }
}
