use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuotaStatus {
    Available,
    LimitReached,
    WorkspaceLimited,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_percent: f64,
    pub duration_minutes: Option<u32>,
    pub resets_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub windows: Vec<QuotaWindow>,
    pub reset_cards: Option<u32>,
    pub next_card_expiry: Option<u64>,
    pub status: QuotaStatus,
}

pub struct QuotaReport {
    pub plan: Option<String>,
    pub quota: Quota,
}

pub fn reported_plan(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|plan| {
            !plan.is_empty() && !plan.eq_ignore_ascii_case("unknown") && plan.len() <= 60
        })
        .map(str::to_owned)
}

fn window(value: &Value) -> Option<QuotaWindow> {
    let used_percent = value["usedPercent"]
        .as_f64()
        .filter(|percent| *percent >= 0.0)?;
    Some(QuotaWindow {
        used_percent: used_percent.min(100.0),
        duration_minutes: value["windowDurationMins"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n != 0),
        resets_at: timestamp(&value["resetsAt"]),
    })
}

fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| (1..=253_402_300_799).contains(n))
}

pub fn read(response: &Value) -> Option<QuotaReport> {
    let main = &response["rateLimitsByLimitId"]["codex"];
    let fallback = &response["rateLimits"];
    let bucket = if main.is_object() {
        main
    } else if fallback.is_object()
        && fallback["limitId"]
            .as_str()
            .is_none_or(|id| id.eq_ignore_ascii_case("codex"))
    {
        fallback
    } else {
        return None;
    };
    let mut windows: Vec<_> = [window(&bucket["primary"]), window(&bucket["secondary"])]
        .into_iter()
        .flatten()
        .collect();
    if windows.iter().all(|entry| entry.duration_minutes.is_some()) {
        windows.sort_by_key(|entry| entry.duration_minutes);
    }

    let credits = &bucket["credits"];
    let extra_credits = credits["hasCredits"] == true || credits["unlimited"] == true;
    let reached = bucket["rateLimitReachedType"]
        .as_str()
        .filter(|kind| !kind.is_empty());
    let status = match reached {
        Some(
            "workspace_owner_credits_depleted"
            | "workspace_member_credits_depleted"
            | "workspace_owner_usage_limit_reached"
            | "workspace_member_usage_limit_reached",
        ) => QuotaStatus::WorkspaceLimited,
        _ if bucket["spendControlReached"] == true => QuotaStatus::WorkspaceLimited,
        Some("rate_limit_reached") => QuotaStatus::LimitReached,
        Some(_) => QuotaStatus::Unknown,
        None if extra_credits => QuotaStatus::Available,
        None if windows.iter().any(|entry| entry.used_percent >= 100.0) => {
            QuotaStatus::LimitReached
        }
        None if !windows.is_empty() => QuotaStatus::Available,
        None => QuotaStatus::Unknown,
    };

    let cards = &response["rateLimitResetCredits"];
    let reset_cards = cards["availableCount"]
        .as_u64()
        .and_then(|count| u32::try_from(count).ok());
    let next_card_expiry = reset_cards.filter(|count| *count > 0).and_then(|_| {
        cards["credits"]
            .as_array()?
            .iter()
            .filter(|card| card["status"] == "available")
            .filter_map(|card| timestamp(&card["expiresAt"]))
            .min()
    });

    let plan = reported_plan(&bucket["planType"]).or_else(|| {
        if fallback["limitId"]
            .as_str()
            .is_none_or(|id| id.eq_ignore_ascii_case("codex"))
        {
            reported_plan(&fallback["planType"])
        } else {
            None
        }
    });
    Some(QuotaReport {
        plan,
        quota: Quota {
            windows,
            reset_cards,
            next_card_expiry,
            status,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefers_the_codex_bucket_and_the_reported_card_count() {
        let report = read(&json!({
            "rateLimits": {"planType":"plus","primary":{"usedPercent":90}},
            "rateLimitsByLimitId": {
                "another_model": {"primary":{"usedPercent":100}},
                "codex": {"planType":"promax","primary":{"usedPercent":22,"windowDurationMins":10080},
                          "secondary":{"usedPercent":12.5,"windowDurationMins":300,"resetsAt":1900000000}}
            },
            "rateLimitResetCredits": {"availableCount":3,"credits":[
                {"status":"consumed","expiresAt":1800000000},
                {"status":"available","expiresAt":1900000000}
            ]}
        })).unwrap();
        assert_eq!(report.plan.as_deref(), Some("promax"));
        assert_eq!(report.quota.windows[0].used_percent, 12.5);
        assert_eq!(report.quota.windows[1].duration_minutes, Some(10080));
        assert_eq!(report.quota.status, QuotaStatus::Available);
        assert_eq!(report.quota.reset_cards, Some(3));
        assert_eq!(report.quota.next_card_expiry, Some(1900000000));
    }

    #[test]
    fn distinguishes_exhaustion_and_unknown_fields_from_zero_cards() {
        let read_quota = |bucket, cards| {
            read(&json!({"rateLimits":bucket, "rateLimitResetCredits":cards}))
                .unwrap()
                .quota
        };
        let exhausted = read_quota(
            json!({"primary":{"usedPercent":100}}),
            json!({"availableCount":0}),
        );
        assert_eq!(exhausted.status, QuotaStatus::LimitReached);
        assert_eq!(exhausted.reset_cards, Some(0));
        assert_eq!(
            read_quota(
                json!({"spendControlReached":true,"primary":{"usedPercent":0}}),
                Value::Null
            )
            .status,
            QuotaStatus::WorkspaceLimited
        );
        let unknown = read_quota(json!({"primary":{"usedPercent":-1}}), Value::Null);
        assert_eq!(unknown.status, QuotaStatus::Unknown);
        assert_eq!(unknown.reset_cards, None);
        assert_eq!(
            read_quota(
                json!({"primary":{"usedPercent":100},"credits":{"hasCredits":true}}),
                Value::Null
            )
            .status,
            QuotaStatus::Available
        );
        assert!(read(&json!({"rateLimits":{"limitId":"another_model"}})).is_none());
    }
}
