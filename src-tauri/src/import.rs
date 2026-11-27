use crate::model::{self, Account, AccountInput, Availability, Plan, Rebind, TwoFactor};
use serde::Serialize;
use std::collections::HashSet;
use zeroize::Zeroizing;

#[derive(Serialize)]
pub struct Issue {
    pub line: usize,
    pub reason: String,
}

pub fn plan(input: &str, existing: &[Account]) -> Result<(Vec<Account>, Vec<Issue>), String> {
    if input.len() > 512 * 1024 || input.lines().count() > 1000 {
        return Err("一次最多导入 1000 行，且文本不能超过 512 KB。".into());
    }
    let mut emails: HashSet<_> = existing
        .iter()
        .map(|row| row.info.email.to_lowercase())
        .collect();
    let mut numbers: HashSet<_> = existing
        .iter()
        .map(|row| row.info.number.to_ascii_uppercase())
        .collect();
    let mut next = 1;
    let mut accounts = Vec::new();
    let mut issues = Vec::new();
    for (index, line) in input.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let create = (|| {
            let (email, fields) = line
                .split_once("----")
                .ok_or("需要三个字段，使用四个半角连字符分隔。")?;
            let (password, seed) = fields
                .rsplit_once("----")
                .ok_or("缺少 2FA 字段，可以保留为空。")?;
            let email = email.trim();
            if !model::validate_email(email) {
                return Err("邮箱格式无效。".into());
            }
            if emails.contains(&email.to_lowercase()) {
                return Err("邮箱已存在，已跳过。".into());
            }
            if password.is_empty() {
                return Err("密码字段为空。".into());
            }
            let seed = seed.trim();
            let seed = if seed.starts_with("otpauth://") {
                authenticator_uri(seed)?
            } else {
                Zeroizing::new(seed.to_owned())
            };
            let number = loop {
                let candidate = format!("GPT-{next:03}");
                next += 1;
                if !numbers.contains(&candidate) {
                    break candidate;
                }
            };
            match (AccountInput {
                id: None,
                number: number.clone(),
                email: email.into(),
                previous_email: String::new(),
                plan: Plan::Unknown,
                availability: Availability::Unchecked,
                rebind: Rebind::Unchanged,
                rebind_date: String::new(),
                renewal_date: String::new(),
                two_factor: TwoFactor::Unknown,
                notes: String::new(),
                tags: Vec::new(),
                verified_at: None,
                password: Some(Zeroizing::new(password.to_owned())),
                totp: Some(seed),
            })
            .into_account(None)
            {
                Ok(row) => {
                    emails.insert(email.to_lowercase());
                    numbers.insert(number);
                    Ok(row)
                }
                Err(error) => {
                    next -= 1;
                    Err(error)
                }
            }
        })();
        match create {
            Ok(row) => accounts.push(row),
            Err(reason) => issues.push(Issue {
                line: index + 1,
                reason,
            }),
        }
    }
    Ok((accounts, issues))
}

fn authenticator_uri(input: &str) -> Result<Zeroizing<String>, String> {
    let uri = url::Url::parse(input).map_err(|_| "2FA 链接的格式无效。")?;
    if uri.host_str() != Some("totp") {
        return Err("只支持 TOTP 验证器链接。".into());
    }
    let mut secret = None;
    for (key, value) in uri.query_pairs() {
        match key.as_ref() {
            "secret" if secret.is_none() => secret = Some(Zeroizing::new(value.into_owned())),
            "secret" => return Err("2FA 链接包含重复密钥。".into()),
            "algorithm" if !value.eq_ignore_ascii_case("SHA1") => {
                return Err("只支持 SHA1 验证器。".into())
            }
            "digits" if value != "6" => return Err("只支持六位验证码。".into()),
            "period" if value != "30" => return Err("只支持 30 秒更新的验证码。".into()),
            _ => {}
        }
    }
    secret
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "2FA 链接缺少密钥。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_without_overwriting_and_never_echoes_secrets_in_errors() {
        let raw = "one@example.com----long----secret----JBSWY3DPEHPK3PXP\r\nONE@example.com----duplicate----\ninvalid----extra----\ntwo@example.com----key----otpauth://totp/sample?secret=JBSWY3DPEHPK3PXP\nthree@example.com----another----";
        let (rows, issues) = plan(raw, &[]).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].password.as_str(), "long----secret");
        assert_eq!(rows[1].info.number, "GPT-002");
        assert_eq!(rows[2].info.number, "GPT-003");
        assert!(rows[2].totp.is_empty());
        assert_eq!(
            issues.iter().map(|issue| issue.line).collect::<Vec<_>>(),
            [2, 3]
        );
        assert!(!issues
            .iter()
            .any(|issue| issue.reason.contains("duplicate")));
        assert!(plan(raw, &rows).unwrap().0.is_empty());
    }
}
