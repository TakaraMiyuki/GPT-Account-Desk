use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use tokio::sync::watch;
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Starting,
    Waiting,
    Manual,
    Finishing,
    Cancelling,
    Committing,
}

struct Progress {
    stage: Stage,
    url: Option<Zeroizing<String>>,
}

pub struct Attempt {
    progress: Mutex<Progress>,
    cancelled: watch::Sender<bool>,
}

impl Attempt {
    pub fn new() -> Self {
        Self {
            progress: Mutex::new(Progress {
                stage: Stage::Starting,
                url: None,
            }),
            cancelled: watch::channel(false).0,
        }
    }

    fn progress(&self) -> MutexGuard<'_, Progress> {
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancelled.subscribe()
    }

    pub fn stage(&self) -> Stage {
        self.progress().stage
    }

    pub fn open(&self, url: &str, open_browser: impl FnOnce() -> bool) -> bool {
        let mut progress = self.progress();
        if progress.stage == Stage::Cancelling {
            return false;
        }
        progress.stage = if open_browser() {
            Stage::Waiting
        } else {
            Stage::Manual
        };
        progress.url = Some(Zeroizing::new(url.to_owned()));
        true
    }

    pub fn url(&self) -> Option<Zeroizing<String>> {
        self.progress().url.clone()
    }

    pub fn finishing(&self) {
        let mut progress = self.progress();
        if !matches!(progress.stage, Stage::Cancelling | Stage::Committing) {
            progress.stage = Stage::Finishing;
        }
        progress.url = None;
    }

    pub fn cancel(&self) -> bool {
        let mut progress = self.progress();
        if progress.stage == Stage::Committing {
            return false;
        }
        progress.stage = Stage::Cancelling;
        progress.url = None;
        self.cancelled.send_replace(true);
        true
    }

    // The vault records the authorization only once this transition excludes a pending cancellation.
    pub fn begin_commit(&self) -> bool {
        let mut progress = self.progress();
        if progress.stage == Stage::Cancelling {
            return false;
        }
        progress.stage = Stage::Committing;
        progress.url = None;
        true
    }
}

pub async fn cancelled(signal: &mut watch::Receiver<bool>) {
    let _ = signal.wait_for(|requested| *requested).await;
}

#[derive(Debug)]
pub enum Error {
    Cancelled,
    Failed(String),
}

impl From<String> for Error {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Self::Failed(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_clears_the_link_and_disallows_committing() {
        let attempt = Attempt::new();
        let mut signal = attempt.subscribe();
        let url = "https://auth.openai.com/fixture";
        assert!(attempt.open(url, || false));
        assert!(attempt.stage() == Stage::Manual);
        assert_eq!(attempt.url().as_deref().map(String::as_str), Some(url));
        assert!(attempt.cancel());
        cancelled(&mut signal).await;
        assert!(attempt.url().is_none());
        assert!(!attempt.open(url, || panic!("cancelled attempts cannot open a browser")));
        assert!(!attempt.begin_commit());

        let attempt = Attempt::new();
        assert!(attempt.begin_commit());
        assert!(!attempt.cancel());
    }
}
