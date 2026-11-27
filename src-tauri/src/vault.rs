use crate::model::Book;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAGIC: &[u8] = b"ACCOUNT-DESK\x01";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const HEADER: usize = MAGIC.len() + 16 + 12;

pub struct Vault {
    pub book: Book,
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    last_activity: Instant,
}

impl Vault {
    pub fn new(password: &str) -> Result<Self, String> {
        if password.chars().count() < 12 || password.len() > 1024 {
            return Err("主密码至少需要 12 个字符，且不能超过 1024 字节。".into());
        }
        let mut salt = [0; 16];
        OsRng.fill_bytes(&mut salt);
        Ok(Self {
            book: Book::default(),
            key: derive_key(password, &salt)?,
            salt,
            last_activity: Instant::now(),
        })
    }

    pub fn from_file(path: &Path, password: &str) -> Result<Self, String> {
        let contents = read_file(path)?;
        if contents.len() < HEADER + 16 || !contents.starts_with(MAGIC) {
            return Err("文件格式无效，或版本暂不支持。".into());
        }
        let salt = contents[MAGIC.len()..MAGIC.len() + 16].try_into().unwrap();
        let key = derive_key(password, &salt)?;
        Self::decrypt(contents, key)
    }

    pub fn from_device(path: &Path, token: &Path) -> Result<Self, String> {
        Self::decrypt(read_file(path)?, crate::device::load(token)?)
    }

    pub fn remember_device(&self, path: &Path) -> Result<(), String> {
        crate::device::remember(path, &self.key)
    }

    fn decrypt(contents: Vec<u8>, key: Zeroizing<[u8; 32]>) -> Result<Self, String> {
        if contents.len() < HEADER + 16 || !contents.starts_with(MAGIC) {
            return Err("文件格式无效，或版本暂不支持。".into());
        }
        let salt = contents[MAGIC.len()..MAGIC.len() + 16].try_into().unwrap();
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "无法初始化加密库。")?;
        let clear = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&contents[HEADER - 12..HEADER]),
                    Payload {
                        msg: &contents[HEADER..],
                        aad: &contents[..HEADER],
                    },
                )
                .map_err(|_| "主密码不正确，或文件已损坏。")?,
        );
        let book: Book = serde_json::from_slice(&clear).map_err(|_| "加密库内的资料无法读取。")?;
        book.settings.validate()?;
        Ok(Self {
            book,
            key,
            salt,
            last_activity: Instant::now(),
        })
    }

    pub fn write(&self, path: &Path, book: &Book) -> Result<(), String> {
        let clear = Zeroizing::new(serde_json::to_vec(book).map_err(|_| "无法编码账号资料。")?);
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut output = Vec::with_capacity(HEADER + clear.len() + 16);
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&self.salt);
        output.extend_from_slice(&nonce);
        let cipher =
            Aes256Gcm::new_from_slice(self.key.as_ref()).map_err(|_| "无法初始化加密库。")?;
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &clear,
                    aad: &output,
                },
            )
            .map_err(|_| "无法加密账号资料。")?;
        output.extend_from_slice(&encrypted);
        if output.len() as u64 > MAX_BYTES {
            return Err("加密库已超过首版文件大小上限。".into());
        }
        write_atomic(path, &output)
    }

    pub fn commit(&mut self, path: &Path, book: Book) -> Result<(), String> {
        self.write(path, &book)?;
        self.book = book;
        Ok(())
    }

    pub fn activity(&mut self) {
        self.last_activity = Instant::now();
    }

    pub fn expired(&self) -> bool {
        let minutes = self.book.settings.lock_minutes;
        minutes != 0 && self.last_activity.elapsed() >= Duration::from_secs(u64::from(minutes) * 60)
    }
}

fn derive_key(password: &str, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, String> {
    if password.len() > 1024 {
        return Err("主密码不能超过 1024 字节。".into());
    }
    let params = Params::new(65_536, 3, 1, Some(32)).map_err(|_| "无法初始化密钥参数。")?;
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "无法派生加密密钥。")?;
    Ok(key)
}

pub fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|_| "无法读取加密文件。")?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取加密文件。")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("加密文件超过大小上限。".into());
    }
    Ok(bytes)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无法确认保存目录。")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建保存目录。")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法在目标目录创建文件。")?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "无法写入加密文件。")?;
    temp.persist(path)
        .map_err(|_| "无法替换目标文件，请确认文件未被占用。")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AccountInput, Availability, Plan, Rebind, TwoFactor};

    #[test]
    fn idle_lock_can_be_disabled() {
        let mut vault = Vault::new("Never lock regression test!").unwrap();
        vault.last_activity = Instant::now() - Duration::from_secs(360);
        assert!(vault.expired());
        vault.book.settings.lock_minutes = 0;
        assert!(!vault.expired());
        assert!(vault.book.settings.validate().is_ok());
    }

    #[test]
    fn vault_roundtrip_and_tamper_detection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("accounts.vault");
        let backup = directory.path().join("backup.vault");
        let password = "Test password for the encrypted library";
        let mut vault = Vault::new(password).unwrap();
        let mut book = Book::default();
        book.accounts.push(
            AccountInput {
                id: None,
                number: "GPT-100".into(),
                email: "private@example.com".into(),
                previous_email: "prior@example.com".into(),
                plan: Plan::Plus,
                availability: Availability::Available,
                rebind: Rebind::Changed,
                rebind_date: "2024-02-29".into(),
                renewal_date: "2026-12-01".into(),
                two_factor: TwoFactor::Authenticator,
                notes: "Synthetic personal note".into(),
                tags: vec!["personal".into()],
                verified_at: None,
                password: Some(Zeroizing::new("account-secret".into())),
                totp: Some(Zeroizing::new("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into())),
            }
            .into_account(None)
            .unwrap(),
        );
        vault.commit(&path, book).unwrap();

        let restored = Vault::from_file(&path, password).unwrap();
        assert_eq!(restored.book.accounts.len(), 1);
        assert_eq!(
            restored.book.accounts[0].password.as_str(),
            "account-secret"
        );
        assert!(Vault::from_file(&path, "incorrect").is_err());

        restored.write(&backup, &restored.book).unwrap();
        let encrypted = fs::read(&path).unwrap();
        assert_ne!(encrypted, fs::read(&backup).unwrap());
        for text in [
            "private@example.com",
            "account-secret",
            "Synthetic personal note",
        ] {
            assert!(!encrypted
                .windows(text.len())
                .any(|window| window == text.as_bytes()));
        }
        let mut corrupted = encrypted;
        corrupted[HEADER] ^= 1;
        fs::write(&path, corrupted).unwrap();
        assert!(Vault::from_file(&path, password).is_err());
        let recovered = Vault::from_file(&backup, password).unwrap();
        assert_eq!(recovered.book.accounts[0].info.email, "private@example.com");
    }
}
