use std::{
    ffi::{c_void, OsString},
    os::windows::{ffi::OsStringExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    ptr::{null, null_mut},
};

#[link(name = "shlwapi")]
extern "system" {
    fn AssocQueryStringW(
        flags: u32,
        kind: u32,
        association: *const u16,
        verb: *const u16,
        output: *mut u16,
        length: *mut u32,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(
        key: isize,
        subkey: *const u16,
        name: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn default_browser() -> Option<PathBuf> {
    const ASSOCF_IS_PROTOCOL: u32 = 0x1000;
    const ASSOCSTR_EXECUTABLE: u32 = 2;
    let protocol = wide("https");
    let mut buffer = vec![0u16; 4096];
    let mut length = buffer.len() as u32;
    // Windows resolves the current user's HTTPS handler to its registered binary.
    let code = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_EXECUTABLE,
            protocol.as_ptr(),
            null(),
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if code != 0 {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0)?;
    let path = PathBuf::from(OsString::from_wide(&buffer[..end]));
    (path.is_absolute() && path.is_file()).then_some(path)
}

struct PrivateMode {
    flag: &'static str,
    policy_path: &'static str,
    policy_value: &'static str,
}

fn private_mode(executable: &Path) -> Option<PrivateMode> {
    let name = executable.file_name()?.to_str()?.to_ascii_lowercase();
    let (flag, policy_path, policy_value) = match name.as_str() {
        "msedge.exe" => (
            "--inprivate",
            r"SOFTWARE\Policies\Microsoft\Edge",
            "InPrivateModeAvailability",
        ),
        "chrome.exe" => (
            "--incognito",
            r"SOFTWARE\Policies\Google\Chrome",
            "IncognitoModeAvailability",
        ),
        "firefox.exe" => (
            "--private-window",
            r"SOFTWARE\Policies\Mozilla\Firefox",
            "DisablePrivateBrowsing",
        ),
        _ => return None,
    };
    Some(PrivateMode {
        flag,
        policy_path,
        policy_value,
    })
}

fn registry_disables_private_mode(mode: &PrivateMode) -> bool {
    let path = wide(mode.policy_path);
    let name = wide(mode.policy_value);
    // Inspect both machine and user policy, including the 32-bit policy registry view.
    [0x8000_0001u32, 0x8000_0002].into_iter().any(|root| {
        [0x1_0010, 0x2_0010].into_iter().any(|flags| {
            let mut value = 0u32;
            let mut size = 4u32;
            let status = unsafe {
                RegGetValueW(
                    root as i32 as isize,
                    path.as_ptr(),
                    name.as_ptr(),
                    flags,
                    null_mut(),
                    (&mut value as *mut u32).cast(),
                    &mut size,
                )
            };
            status == 0 && size == 4 && value == 1
        })
    })
}

fn private_command(url: &str) -> Option<Command> {
    let executable = default_browser()?;
    let mode = private_mode(&executable)?;
    if registry_disables_private_mode(&mode) {
        return None;
    }
    if executable
        .file_name()?
        .to_str()?
        .eq_ignore_ascii_case("firefox.exe")
    {
        let policy = executable
            .parent()?
            .join("distribution")
            .join("policies.json");
        if let Ok(contents) = std::fs::read_to_string(policy) {
            if serde_json::from_str::<serde_json::Value>(&contents)
                .ok()
                .is_some_and(|data| data["policies"]["DisablePrivateBrowsing"] == true)
            {
                return None;
            }
        }
    }
    let mut command = Command::new(executable);
    command
        .args([mode.flag, url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000);
    Some(command)
}

pub fn open_authorization(url: &str, private_window: bool) -> bool {
    if !private_window {
        return open::that_detached(url).is_ok();
    }
    // A direct process call sends the URL as one argument and avoids the shell and ordinary-mode fallback.
    private_command(url).is_some_and(|mut command| command.spawn().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_browsers_with_known_private_flags() {
        for (exe, flag) in [
            ("msedge.exe", "--inprivate"),
            ("chrome.exe", "--incognito"),
            ("firefox.exe", "--private-window"),
        ] {
            assert_eq!(private_mode(Path::new(exe)).unwrap().flag, flag);
        }
        assert!(private_mode(Path::new("unrecognized.exe")).is_none());
    }

    #[test]
    fn uses_the_registered_windows_browser_and_passes_the_url_as_a_separate_argument() {
        let resolved = default_browser();
        if let Some(wanted) = std::env::var_os("ACCOUNT_DESK_QA_BROWSER") {
            assert_eq!(
                resolved.as_deref().and_then(Path::file_name),
                Some(wanted.as_os_str())
            );
            assert!(private_command("https://auth.openai.com/fixture").is_some());
        }
        let Some(executable) = resolved else {
            return;
        };
        let Some(mode) = private_mode(&executable) else {
            return;
        };
        let url = "https://auth.openai.com/fixture?example=a%20b&mode=test";
        if let Some(command) = private_command(url) {
            assert_eq!(command.get_program(), executable.as_os_str());
            assert_eq!(command.get_args().collect::<Vec<_>>(), [mode.flag, url]);
        }
    }
}
