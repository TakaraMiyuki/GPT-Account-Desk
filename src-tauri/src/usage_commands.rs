use crate::{get_account, usage, AppState, LOCKED};
use serde_json::Value;
use std::{path::Path, sync::Arc};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

pub struct Cache {
    pub generation: u64,
    pub sources: Vec<usage::Source>,
    pub index: Arc<usage::Index>,
}

#[tauri::command]
pub async fn add_usage_source(
    app: AppHandle,
    account: Option<Uuid>,
    use_default: bool,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let generation = {
            let mut inner = state.guard()?;
            inner.vault()?;
            inner.generation
        };
        let home = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_dir())
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|profile| std::path::PathBuf::from(profile).join(".codex"))
            });
        let sessions = home.map(|path| path.join("sessions"));
        let path = if use_default {
            sessions
                .filter(|path| path.is_dir())
                .ok_or("未找到默认 Codex 日志目录，请手动选择。")?
        } else {
            let mut picker = app.dialog().file().set_title("选择 Codex 会话日志目录");
            if let Some(sessions) = sessions.filter(|path| path.is_dir()) {
                picker = picker.set_directory(sessions);
            }
            let Some(selected) = picker.blocking_pick_folder() else {
                return Ok(None);
            };
            selected.into_path().map_err(|_| "请选择本机文件夹。")?
        };
        let folder = path.canonicalize().map_err(|_| "无法访问该日志目录。")?;
        let mut inner = state.guard()?;
        inner.expire();
        if generation != inner.generation {
            return Err(LOCKED.into());
        }
        let vault = inner.vault()?;
        if let Some(id) = account {
            get_account(&vault.book.accounts, id)?;
        }
        let mut book = vault.book.clone();
        if book
            .usage_sources
            .iter()
            .any(|source| same_or_nested(&source.folder, &folder))
        {
            return Err("该目录和现有日志来源重叠，请先移除原来源。".into());
        }
        book.usage_sources.push(usage::Source {
            id: Uuid::new_v4(),
            account_id: account,
            folder,
        });
        vault.commit(&state.path, book)?;
        vault.activity();
        state.clear_usage_cache();
        Ok(Some(state.view(&inner)))
    })
    .await
    .map_err(|_| "无法选择 Codex 日志文件夹。")?
}

fn same_or_nested(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().to_ascii_lowercase();
    let right = right.to_string_lossy().to_ascii_lowercase();
    let left = Path::new(&left);
    let right = Path::new(&right);
    left.starts_with(right) || right.starts_with(left)
}

#[tauri::command]
pub fn assign_usage_source(
    state: State<AppState>,
    id: Uuid,
    account: Option<Uuid>,
) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    if let Some(id) = account {
        get_account(&vault.book.accounts, id)?;
    }
    let mut book = vault.book.clone();
    let source = book
        .usage_sources
        .iter_mut()
        .find(|source| source.id == id)
        .ok_or("找不到该日志来源。")?;
    source.account_id = account;
    vault.commit(&state.path, book)?;
    vault.activity();
    state.clear_usage_cache();
    Ok(state.view(&inner))
}

#[tauri::command]
pub fn remove_usage_source(state: State<AppState>, id: Uuid) -> Result<Value, String> {
    let mut inner = state.guard()?;
    let vault = inner.vault()?;
    let mut book = vault.book.clone();
    book.usage_sources.retain(|source| source.id != id);
    vault.commit(&state.path, book)?;
    vault.activity();
    state.clear_usage_cache();
    Ok(state.view(&inner))
}

#[tauri::command]
pub async fn local_usage(
    app: AppHandle,
    query: usage::Query,
    rescan: bool,
) -> Result<usage::LocalUsage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (generation, sources) = {
            let mut inner = state.guard()?;
            inner.expire();
            let generation = inner.generation;
            let sources = inner.vault()?.book.usage_sources.clone();
            (generation, sources)
        };
        let previous = if rescan {
            None
        } else {
            state
                .usage_cache
                .lock()
                .map_err(|_| "无法读取用量缓存。")?
                .as_ref()
                .filter(|cache| generation == cache.generation && sources == cache.sources)
                .map(|cache| Arc::clone(&cache.index))
        };
        let index = previous.unwrap_or_else(|| Arc::new(usage::Index::scan(&sources)));
        let result = index.query(&query);
        let mut inner = state.guard()?;
        inner.expire();
        if inner.generation != generation {
            return Err(LOCKED.into());
        }
        if inner.vault()?.book.usage_sources != sources {
            return Err("日志来源已变更，请刷新。".into());
        }
        *state.usage_cache.lock().map_err(|_| "无法保存用量缓存。")? = Some(Cache {
            generation,
            sources,
            index,
        });
        Ok(result)
    })
    .await
    .map_err(|_| "无法统计 Codex 会话日志。")?
}
