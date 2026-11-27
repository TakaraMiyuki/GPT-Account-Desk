use crate::model::{now, ConnectionState, Observation};
use crate::{browser, login, quota};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

pub enum Failure {
    Auth,
    Network,
    Unsupported,
}

impl Failure {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Auth => "Codex 没有可用的登录授权，请重新登录。",
            Self::Network => "暂时无法完成 Codex 检查，请稍后重试。",
            Self::Unsupported => "无法通过该 Codex CLI 读取账号，请检查版本或重新选择程序。",
        }
    }
}

pub type RpcResult<T> = Result<T, Failure>;

pub struct Identity {
    pub email: String,
    pub user_id: Option<String>,
    pub plan: Option<String>,
}

struct Connection {
    _child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    next_id: u32,
}

impl Connection {
    async fn start(executable: &Path, home: &Path) -> RpcResult<Self> {
        std::fs::create_dir_all(home).map_err(|_| Failure::Unsupported)?;
        let mut command = Command::new(executable);
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "cli_auth_credentials_store=\"keyring\"",
            ])
            .env("CODEX_HOME", home)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN")
            .env_remove("OPENAI_BASE_URL")
            .env_remove("CODEX_HOME_OVERRIDE")
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| Failure::Unsupported)?;
        let input = child.stdin.take().ok_or(Failure::Unsupported)?;
        let output = BufReader::new(child.stdout.take().ok_or(Failure::Unsupported)?).lines();
        let mut server = Self {
            _child: child,
            input,
            output,
            next_id: 1,
        };
        server.request("initialize", json!({
            "clientInfo": { "name": "account_desk", "title": "Account Desk", "version": env!("CARGO_PKG_VERSION") }
        })).await?;
        server.send(json!({ "method": "initialized" })).await?;
        Ok(server)
    }

    async fn send(&mut self, payload: Value) -> RpcResult<()> {
        let mut bytes = serde_json::to_vec(&payload).map_err(|_| Failure::Unsupported)?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| Failure::Unsupported)
    }

    async fn next(&mut self) -> RpcResult<Value> {
        loop {
            let line = self
                .output
                .next_line()
                .await
                .map_err(|_| Failure::Network)?
                .ok_or(Failure::Unsupported)?;
            if let Ok(response) = serde_json::from_str(&line) {
                return Ok(response);
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> RpcResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut call = json!({ "method": method, "id": id });
        if !params.is_null() {
            call["params"] = params;
        }
        timeout(Duration::from_secs(25), async {
            self.send(call).await?;
            loop {
                let response = self.next().await?;
                if response["id"].as_u64() != Some(id as u64) {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    return Err(map_error(error));
                }
                return response.get("result").cloned().ok_or(Failure::Unsupported);
            }
        })
        .await
        .map_err(|_| Failure::Network)?
    }

    async fn identity(&mut self) -> RpcResult<Identity> {
        let result = self
            .request("account/read", json!({"refreshToken": false}))
            .await?;
        let account = &result["account"];
        if account["type"].as_str() != Some("chatgpt") {
            return Err(Failure::Auth);
        }
        let email = account["email"]
            .as_str()
            .filter(|value| crate::model::validate_email(value))
            .ok_or(Failure::Unsupported)?;
        Ok(Identity {
            email: email.into(),
            user_id: crate::usage::valid_id(&result["userId"]).map(str::to_owned),
            plan: quota::reported_plan(&account["planType"]),
        })
    }

    async fn login(
        &mut self,
        attempt: &login::Attempt,
        signal: &mut tokio::sync::watch::Receiver<bool>,
        open_browser: impl FnOnce(&str) -> bool,
    ) -> Result<(), login::Error> {
        let result = tokio::select! {
            biased;
            _ = login::cancelled(signal) => return Err(login::Error::Cancelled),
            response = self.request("account/login/start", json!({
                "type": "chatgpt", "useHostedLoginSuccessPage": true, "appBrand": "codex"
            })) => response.map_err(|error| error.message())?,
        };
        let login_id = result["loginId"].as_str().ok_or("Codex 未返回登录编号。")?;
        let raw = result["authUrl"].as_str().ok_or("Codex 未返回授权链接。")?;
        let uri = url::Url::parse(raw).map_err(|_| "授权链接格式无效。")?;
        if uri.scheme() != "https"
            || !uri.username().is_empty()
            || uri.password().is_some()
            || uri.port().is_some()
            || !matches!(uri.host_str(), Some("auth.openai.com" | "chatgpt.com"))
        {
            return Err("授权链接的来源无法确认。".into());
        }
        if !attempt.open(uri.as_str(), || open_browser(uri.as_str())) {
            self.cancel_login(login_id).await;
            return Err(login::Error::Cancelled);
        }

        let result = tokio::select! {
            biased;
            _ = login::cancelled(signal) => Err(login::Error::Cancelled),
            response = timeout(Duration::from_secs(180), self.wait_for_login(login_id)) => {
                response.unwrap_or_else(|_| Err("授权已超时，请重新连接。".into()))
            }
        };
        attempt.finishing();
        if result.is_err() {
            self.cancel_login(login_id).await;
        }
        result
    }

    async fn wait_for_login(&mut self, login_id: &str) -> Result<(), login::Error> {
        loop {
            let notice = self.next().await.map_err(|error| error.message())?;
            if notice["method"] == "account/login/completed"
                && notice["params"]["loginId"] == login_id
            {
                return if notice["params"]["success"] == true {
                    Ok(())
                } else {
                    Err("浏览器授权未完成。".into())
                };
            }
        }
    }

    async fn cancel_login(&mut self, login_id: &str) {
        let _ = timeout(
            Duration::from_secs(2),
            self.request("account/login/cancel", json!({ "loginId": login_id })),
        )
        .await;
    }
}

fn map_error(error: &Value) -> Failure {
    let message = error["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if error["code"].as_i64() == Some(-32601) {
        return Failure::Unsupported;
    }
    if [
        "401",
        "unauthorized",
        "reauthentication",
        "re-authenticate",
        "sign in again",
        "not authenticated",
        "not logged in",
        "refresh_token",
        "token refresh failed",
        "requires chatgpt authentication",
    ]
    .iter()
    .any(|word| message.contains(word))
    {
        return Failure::Auth;
    }
    Failure::Network
}

pub fn executable_from_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let executable = if cfg!(windows) { "codex.exe" } else { "codex" };
    std::env::split_paths(&path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(executable))
        .find(|file| file.is_file())
}

pub async fn discover_executable() -> Option<PathBuf> {
    if let Some(path) = executable_from_path() {
        return Some(path);
    }
    let windows = std::env::var_os("SystemRoot")?;
    let powershell = PathBuf::from(windows).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(powershell);
    command.args(["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation -First 1"])
        .stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(8), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let location = String::from_utf8(output.stdout).ok()?;
    let path = PathBuf::from(location.trim()).join("app/resources/codex.exe");
    (path.is_absolute() && path.is_file()).then_some(path)
}

pub async fn authorize(
    executable: &Path,
    home: &Path,
    expected_email: &str,
    attempt: &login::Attempt,
    private_window: bool,
) -> Result<Observation, login::Error> {
    let mut signal = attempt.subscribe();
    let mut server = tokio::select! {
        biased;
        _ = login::cancelled(&mut signal) => return Err(login::Error::Cancelled),
        result = Connection::start(executable, home) => result.map_err(|error| error.message())?,
    };
    server
        .login(attempt, &mut signal, |url| {
            browser::open_authorization(url, private_window)
        })
        .await?;
    tokio::select! {
        biased;
        _ = login::cancelled(&mut signal) => Err(login::Error::Cancelled),
        result = observe_authorized(&mut server, expected_email) => result,
    }
}

async fn observe_authorized(
    server: &mut Connection,
    expected_email: &str,
) -> Result<Observation, login::Error> {
    let identity = server.identity().await.map_err(|error| error.message())?;
    if !identity.email.eq_ignore_ascii_case(expected_email) {
        return Err(format!(
            "浏览器授权邮箱为 {}，与台账的 {} 不一致。请切换到正确的账号。",
            identity.email, expected_email
        )
        .into());
    }
    let mut observation = Observation {
        state: ConnectionState::Connected,
        checked_at: now(),
        last_success_at: None,
        online_verified_at: None,
        email: Some(identity.email),
        user_id: identity.user_id,
        plan: identity.plan.clone(),
        detail: None,
        quota: None,
    };
    if let Err(error) = refresh_quota(server, &mut observation, identity.plan).await {
        record_failure(&mut observation, error);
    }
    Ok(observation)
}

async fn refresh_quota(
    server: &mut Connection,
    outcome: &mut Observation,
    plan: Option<String>,
) -> RpcResult<()> {
    let response = server
        .request("account/rateLimits/read", Value::Null)
        .await?;
    let report = quota::read(&response).ok_or(Failure::Unsupported)?;
    let verified = now();
    outcome.state = ConnectionState::Connected;
    outcome.last_success_at = Some(verified);
    outcome.online_verified_at = Some(verified);
    outcome.plan = report.plan.or(plan);
    outcome.quota = Some(report.quota);
    Ok(())
}

fn record_failure(outcome: &mut Observation, error: Failure) {
    outcome.state = if matches!(error, Failure::Auth) {
        ConnectionState::Reauth
    } else {
        ConnectionState::Unreachable
    };
    outcome.detail = Some(error.message().into());
}

pub async fn check(
    executable: &Path,
    home: &Path,
    linked_email: &str,
    previous: &Observation,
    published_identity: Option<&str>,
) -> Observation {
    let mut outcome = previous.clone();
    outcome.checked_at = now();
    outcome.detail = None;
    let result = timeout(Duration::from_secs(15), async {
        let mut server = Connection::start(executable, home).await?;
        let identity = server.identity().await?;
        let matches = identity.email.eq_ignore_ascii_case(linked_email)
            && published_identity.is_none_or(|email| email.eq_ignore_ascii_case(&identity.email));
        outcome.email = Some(identity.email);
        if !matches {
            outcome.state = ConnectionState::IdentityMismatch;
            outcome.detail = Some("当前授权邮箱与台账或绑定邮箱不同，请确认后重新连接。".into());
            outcome.user_id = None;
            outcome.plan = None;
            outcome.quota = None;
            return Ok(());
        }
        if identity.user_id.is_some() {
            outcome.user_id = identity.user_id;
        }
        if outcome
            .plan
            .as_ref()
            .is_none_or(|plan| plan.eq_ignore_ascii_case("unknown"))
        {
            outcome.plan = identity.plan.clone();
        }
        refresh_quota(&mut server, &mut outcome, identity.plan).await
    })
    .await
    .unwrap_or(Err(Failure::Network));
    if let Err(error) = result {
        record_failure(&mut outcome, error);
    }
    outcome
}

pub async fn logout(executable: &Path, home: &Path) -> Result<(), String> {
    let mut server = Connection::start(executable, home)
        .await
        .map_err(|err| err.message())?;
    server
        .request("account/logout", Value::Null)
        .await
        .map_err(|err| err.message())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancels_the_server_login_by_id_after_browser_handoff() {
        let node = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
            .map(|dir| dir.join("node.exe"))
            .find(|file| file.is_file())
            .expect("Node.js");
        let directory = tempfile::tempdir().unwrap();
        let app = r#"
            const fs = require('node:fs');
            require('node:readline').createInterface({input: process.stdin}).on('line', line => {
                const {id, method, params} = JSON.parse(line);
                if (!id) return;
                let result = {};
                if (method === 'account/login/start') {
                    result = {loginId:'test-login-id',authUrl:'https://auth.openai.com/fixture?state=synthetic'};
                } else if (method === 'account/login/cancel') {
                    fs.writeFileSync('cancelled.txt', params.loginId);
                    result = {status:'canceled'};
                }
                console.log(JSON.stringify({id,result}));
            });
        "#;
        std::fs::write(directory.path().join("app-server"), app).unwrap();
        std::fs::write(
            directory.path().join("package.json"),
            r#"{"type":"commonjs"}"#,
        )
        .unwrap();
        let mut server = Connection::start(&node, directory.path())
            .await
            .unwrap_or_else(|error| panic!("{}", error.message()));
        let attempt = login::Attempt::new();
        let mut signal = attempt.subscribe();
        let (result, _) = tokio::join!(
            server.login(&attempt, &mut signal, |url| {
                assert_eq!(url, "https://auth.openai.com/fixture?state=synthetic");
                false
            }),
            async {
                timeout(Duration::from_secs(5), async {
                    while attempt.stage() != login::Stage::Manual {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
                assert!(attempt.url().is_some());
                assert!(attempt.cancel());
            }
        );
        assert!(matches!(result, Err(login::Error::Cancelled)));
        assert!(attempt.url().is_none());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("cancelled.txt")).unwrap(),
            "test-login-id"
        );
    }

    #[tokio::test]
    async fn checks_accounts_independently_and_retains_last_success_on_error() {
        let node = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
            .map(|dir| dir.join("node.exe"))
            .find(|file| file.is_file())
            .expect("Node.js");
        let directory = tempfile::tempdir().unwrap();
        let mock = r#"
            const name = require('node:path').basename(process.env.CODEX_HOME);
            require('node:readline').createInterface({input: process.stdin}).on('line', line => {
                const {id, method} = JSON.parse(line);
                if (!id) return;
                const email = name + '@example.com';
                let result;
                switch (method) {
                    case 'initialize': result = {}; break;
                    case 'account/read':
                        result = {account: {type: 'chatgpt', email, planType: 'plus'}};
                        break;
                    case 'account/rateLimits/read':
                        if (name === 'second') {
                            console.log(JSON.stringify({id, error: {code: -32000, message: '401 Unauthorized'}}));
                            return;
                        }
                        result = {rateLimitsByLimitId: {codex: {planType: 'pro', primary: {usedPercent: 20}}},
                                  rateLimitResetCredits: {availableCount: 2}};
                        break;
                }
                console.log(JSON.stringify({id, result}));
            });
        "#;
        for name in ["first", "second"] {
            let home = directory.path().join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("app-server"), mock).unwrap();
        }
        let prior = Observation {
            user_id: None,
            state: ConnectionState::Connected,
            checked_at: 500,
            last_success_at: Some(500),
            online_verified_at: Some(480),
            email: None,
            plan: Some("go".into()),
            detail: None,
            quota: Some(quota::Quota {
                windows: vec![],
                reset_cards: Some(7),
                next_card_expiry: None,
                status: quota::QuotaStatus::Unknown,
            }),
        };
        let first = check(
            &node,
            &directory.path().join("first"),
            "first@example.com",
            &prior,
            None,
        )
        .await;
        assert!(matches!(first.state, ConnectionState::Connected));
        assert_eq!(first.email.as_deref(), Some("first@example.com"));
        assert_eq!(first.plan.as_deref(), Some("pro"));
        assert_eq!(first.online_verified_at, first.last_success_at);
        assert_eq!(first.quota.unwrap().reset_cards, Some(2));
        let second = check(
            &node,
            &directory.path().join("second"),
            "second@example.com",
            &prior,
            None,
        )
        .await;
        assert!(matches!(second.state, ConnectionState::Reauth));
        assert_eq!(second.email.as_deref(), Some("second@example.com"));
        assert_eq!(second.plan.as_deref(), Some("go"));
        assert_eq!(second.last_success_at, Some(500));
        assert_eq!(second.online_verified_at, Some(480));
        assert_eq!(second.quota.unwrap().reset_cards, Some(7));
        let mismatch = check(
            &node,
            &directory.path().join("first"),
            "first@example.com",
            &prior,
            Some("changed@example.com"),
        )
        .await;
        assert!(matches!(mismatch.state, ConnectionState::IdentityMismatch));
        assert!(mismatch.quota.is_none());
    }
}
