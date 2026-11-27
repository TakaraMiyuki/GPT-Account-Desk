use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Plan {
    Unknown,
    Free,
    Go,
    Plus,
    Pro,
    Business,
    Enterprise,
    Edu,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Unchecked,
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rebind {
    #[serde(alias = "unknown", alias = "pending")]
    Unchanged,
    Changed,
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TwoFactor {
    Unknown,
    None,
    Authenticator,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connected,
    Reauth,
    Unreachable,
    IdentityMismatch,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub state: ConnectionState,
    pub checked_at: u64,
    pub last_success_at: Option<u64>,
    pub online_verified_at: Option<u64>,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub detail: Option<String>,
    #[serde(default)]
    pub quota: Option<crate::quota::Quota>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub profile: Uuid,
    pub email: String,
    pub observation: Observation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::usage::AccountUsage>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: Uuid,
    pub number: String,
    pub email: String,
    pub previous_email: String,
    pub plan: Plan,
    pub availability: Availability,
    pub rebind: Rebind,
    pub rebind_date: String,
    pub renewal_date: String,
    pub two_factor: TwoFactor,
    pub notes: String,
    pub tags: Vec<String>,
    pub verified_at: Option<u64>,
    pub updated_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    #[serde(flatten)]
    pub info: AccountInfo,
    pub password: Zeroizing<String>,
    pub totp: Zeroizing<String>,
    pub link: Option<Link>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub lock_minutes: u16,
    pub review_days: u16,
    pub auto_refresh_minutes: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lock_minutes: 5,
            review_days: 30,
            auto_refresh_minutes: 0,
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub manual_order: bool,
    #[serde(default)]
    pub has_custom_order: bool,
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub usage_sources: Vec<crate::usage::Source>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView<'a> {
    #[serde(flatten)]
    pub info: &'a AccountInfo,
    pub has_password: bool,
    pub has_totp: bool,
    pub observed: Option<&'a Observation>,
    pub linked_email: Option<&'a str>,
}

impl Account {
    pub fn view(&self) -> AccountView<'_> {
        AccountView {
            info: &self.info,
            has_password: !self.password.is_empty(),
            has_totp: !self.totp.is_empty(),
            observed: self.link.as_ref().map(|link| &link.observation),
            linked_email: self.link.as_ref().map(|link| link.email.as_str()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: Option<Uuid>,
    pub number: String,
    pub email: String,
    pub previous_email: String,
    pub plan: Plan,
    pub availability: Availability,
    pub rebind: Rebind,
    pub rebind_date: String,
    pub renewal_date: String,
    pub two_factor: TwoFactor,
    pub notes: String,
    pub tags: Vec<String>,
    pub verified_at: Option<u64>,
    pub password: Option<Zeroizing<String>>,
    pub totp: Option<Zeroizing<String>>,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn totp_seed(text: &str) -> Result<Zeroizing<String>, String> {
    let seed = Zeroizing::new(
        text.chars()
            .filter(|c| !c.is_ascii_whitespace() && *c != '-')
            .collect::<String>()
            .to_ascii_uppercase(),
    );
    if seed.is_empty() {
        return Ok(seed);
    }
    if seed.len() > 256 {
        return Err("2FA 密钥太长。".into());
    }
    let bytes = Zeroizing::new(
        data_encoding::BASE32_NOPAD
            .decode(seed.trim_end_matches('=').as_bytes())
            .map_err(|_| "请输入验证器提供的 Base32 密钥。")?,
    );
    if bytes.len() < 10 {
        return Err("2FA 密钥太短，请检查是否完整复制。".into());
    }
    Ok(Zeroizing::new(data_encoding::BASE32_NOPAD.encode(&bytes)))
}

pub fn totp_code(seed: &str, timestamp: u64) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    let bytes = Zeroizing::new(
        data_encoding::BASE32_NOPAD
            .decode(seed.as_bytes())
            .map_err(|_| "2FA 密钥无效。")?,
    );
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&bytes).map_err(|_| "2FA 密钥无效。")?;
    mac.update(&(timestamp / 30).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let digits = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff;
    Ok(format!("{:06}", digits % 1_000_000))
}

pub fn validate_email(text: &str) -> bool {
    let Some((name, domain)) = text.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && text.len() <= 320
        && !text.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn valid_date(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    let parts: Vec<_> = text.split('-').collect();
    if parts.len() != 3
        || [parts[0].len(), parts[1].len(), parts[2].len()] != [4, 2, 2]
        || !parts
            .iter()
            .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let year: u16 = parts[0].parse().unwrap();
    let month: u8 = parts[1].parse().unwrap();
    let day: u8 = parts[2].parse().unwrap();
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year > 0 && (1..=days).contains(&day)
}

impl AccountInput {
    pub fn into_account(self, existing: Option<&Account>) -> Result<Account, String> {
        let number = self.number.trim().to_string();
        let email = self.email.trim().to_string();
        let previous_email = self.previous_email.trim().to_string();
        if number.is_empty() || number.chars().count() > 32 || number.chars().any(char::is_control)
        {
            return Err("账号编号需为 1 到 32 个字符。".into());
        }
        if !validate_email(&email)
            || (!previous_email.is_empty() && !validate_email(&previous_email))
        {
            return Err("请检查登录邮箱和原邮箱的格式。".into());
        }
        if self.notes.chars().count() > 2000 {
            return Err("备注最多 2000 字。".into());
        }
        if !valid_date(&self.rebind_date) || !valid_date(&self.renewal_date) {
            return Err("请检查改绑日期和续费日期。".into());
        }
        let mut tags = Vec::new();
        for tag in self.tags {
            let tag = tag.trim();
            if !tag.is_empty()
                && !tags
                    .iter()
                    .any(|current: &String| current.eq_ignore_ascii_case(tag))
            {
                tags.push(tag.into());
            }
        }
        if tags.len() > 10
            || tags
                .iter()
                .any(|tag| tag.chars().count() > 20 || tag.chars().any(char::is_control))
        {
            return Err("最多添加 10 个标签，每个标签最多 20 字。".into());
        }
        let password = self
            .password
            .or_else(|| existing.map(|e| e.password.clone()))
            .unwrap_or_default();
        if password.len() > 4096 {
            return Err("密码字段太长。".into());
        }
        let totp = match self.totp {
            Some(seed) => totp_seed(&seed)?,
            None => existing.map(|e| e.totp.clone()).unwrap_or_default(),
        };
        let two_factor = if totp.is_empty() {
            self.two_factor
        } else {
            TwoFactor::Authenticator
        };
        let updated_at = now();
        let verified_at = if matches!(self.availability, Availability::Unchecked) {
            None
        } else {
            self.verified_at
                .map(|date| date.min(updated_at))
                .or(Some(updated_at))
        };
        Ok(Account {
            info: AccountInfo {
                id: existing.map(|e| e.info.id).unwrap_or_else(Uuid::new_v4),
                number,
                email,
                previous_email,
                plan: self.plan,
                availability: self.availability,
                rebind: self.rebind,
                rebind_date: self.rebind_date,
                renewal_date: self.renewal_date,
                two_factor,
                notes: self.notes.trim().to_string(),
                tags,
                verified_at,
                updated_at,
            },
            password,
            totp,
            link: existing.and_then(|e| e.link.clone()),
        })
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if ![0, 1, 5, 15, 30].contains(&self.lock_minutes)
            || ![7, 14, 30, 60, 90].contains(&self.review_days)
            || ![0, 15, 30, 60].contains(&self.auto_refresh_minutes)
        {
            return Err("设置值超出范围。".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totp_matches_rfc_6238_at_two_windows() {
        let seed = totp_seed("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").unwrap();
        assert_eq!(totp_code(&seed, 59).unwrap(), "287082");
        assert_eq!(totp_code(&seed, 1_111_111_109).unwrap(), "081804");
        assert!(totp_seed("JBSWY3").is_err());
        assert!(totp_seed("THIS IS INVALID!").is_err());
    }
}
