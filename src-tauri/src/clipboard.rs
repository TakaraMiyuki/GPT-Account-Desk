use std::{ffi::c_void, num::NonZeroU32};

pub fn write(window: *mut c_void, value: &str) -> Result<NonZeroU32, String> {
    use clipboard_win::{options::NoClear, raw, Clipboard};

    let marker = raw::register_format("ExcludeClipboardContentFromMonitorProcessing")
        .ok_or("Windows 剪贴板保护不可用。")?;
    let _clipboard =
        Clipboard::new_attempts_for(window, 8).map_err(|_| "暂时无法访问系统剪贴板。")?;
    raw::empty().map_err(|_| "无法准备系统剪贴板。")?;
    raw::set_without_clear(marker.get(), &[1]).map_err(|_| "无法保护本次剪贴板内容。")?;
    raw::set_string_with(value, NoClear).map_err(|_| "无法写入系统剪贴板。")?;
    raw::seq_num().ok_or_else(|| "无法读取本次剪贴板编号。".into())
}

pub fn clear(sequence: NonZeroU32) -> bool {
    use clipboard_win::{raw, Clipboard};

    if raw::seq_num() != Some(sequence) {
        return true;
    }
    let Ok(_clipboard) = Clipboard::new_attempts(8) else {
        return false;
    };
    raw::seq_num() != Some(sequence) || raw::empty().is_ok()
}
