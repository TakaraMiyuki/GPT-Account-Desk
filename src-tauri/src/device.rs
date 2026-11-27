use std::{
    ffi::c_void,
    path::Path,
    ptr::{null, null_mut},
};
use zeroize::{Zeroize, Zeroizing};

#[repr(C)]
struct Blob {
    size: u32,
    data: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *const c_void,
        prompt: *const c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *const c_void,
        prompt: *const c_void,
        flags: u32,
        output: *mut Blob,
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

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

fn machine_id() -> Result<Vec<u8>, String> {
    let subkey: Vec<_> = "SOFTWARE\\Microsoft\\Cryptography"
        .encode_utf16()
        .chain([0])
        .collect();
    let name: Vec<_> = "MachineGuid".encode_utf16().chain([0]).collect();
    let mut bytes = vec![0u8; 256];
    let mut size = bytes.len() as u32;
    let status = unsafe {
        RegGetValueW(
            0x8000_0002u32 as i32 as isize,
            subkey.as_ptr(),
            name.as_ptr(),
            0x1_0002,
            null_mut(),
            bytes.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || size < 10 {
        return Err("无法确认本机 Windows 标识。".into());
    }
    bytes.truncate(size as usize);
    Ok(bytes)
}

fn transform(input: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let machine_id = machine_id()?;
    let input = Blob {
        size: input.len() as u32,
        data: input.as_ptr().cast_mut(),
    };
    let entropy = Blob {
        size: machine_id.len() as u32,
        data: machine_id.as_ptr().cast_mut(),
    };
    let mut output = Blob {
        size: 0,
        data: null_mut(),
    };
    // CRYPTPROTECT_UI_FORBIDDEN keeps startup silent. User-scope is the Windows default.
    let result = unsafe {
        if protect {
            CryptProtectData(&input, null(), &entropy, null(), null(), 1, &mut output)
        } else {
            CryptUnprotectData(&input, null_mut(), &entropy, null(), null(), 1, &mut output)
        }
    };
    if result == 0 || output.data.is_null() {
        return Err("Windows 无法使用此设备的解锁凭据。".into());
    }
    // DPAPI allocates the result with LocalAlloc and gives us exclusive ownership.
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.data, output.size as usize) };
    let copy = Zeroizing::new(bytes.to_vec());
    bytes.zeroize();
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(copy)
}

pub fn remember(path: &Path, key: &[u8; 32]) -> Result<(), String> {
    crate::vault::write_atomic(path, &transform(key, true)?)
}

pub fn load(path: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    let token = crate::vault::read_file(path)?;
    if token.len() > 4096 {
        return Err("本机解锁凭据格式无效。".into());
    }
    let key = transform(&token, false)?;
    let mut bytes = Zeroizing::new([0; 32]);
    if key.len() != bytes.len() {
        return Err("本机解锁凭据格式无效。".into());
    }
    bytes.copy_from_slice(&key);
    Ok(bytes)
}

pub fn forget(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法撤销此设备的解锁凭据。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    #[test]
    fn remembered_key_unlocks_its_vault_and_can_be_removed() {
        let directory = tempfile::tempdir().unwrap();
        let pass = "test master password 0.1.1";
        let path = directory.path().join("original.vault");
        let other = directory.path().join("unrelated.vault");
        let token = directory.path().join("trusted-device.dat");
        let vault = Vault::new(pass).unwrap();
        vault.write(&path, &vault.book).unwrap();
        vault.remember_device(&token).unwrap();
        assert!(Vault::from_device(&path, &token).is_ok());
        let other_vault = Vault::new(pass).unwrap();
        other_vault.write(&other, &other_vault.book).unwrap();
        assert!(Vault::from_device(&other, &token).is_err());
        forget(&token).unwrap();
        assert!(Vault::from_device(&path, &token).is_err());
        assert!(Vault::from_file(&path, pass).is_ok());
    }
}
