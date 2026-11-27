use crate::{vault, AppState};
use chrono::DateTime;
use reqwest::{header, Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::State;
use tokio::sync::Mutex;

const LATEST: &str = "https://data.priceai.cc/latest.json";
const SNAPSHOTS: &str = "https://data.priceai.cc/v1/snapshots/";
const SCHEMA: &str = "price-radar.v1";
const PRODUCT: &str = "chatgpt-plus";
const RETENTION_SECONDS: i64 = 8 * 86_400;
const MIN_POLL_SECONDS: u64 = 60;

pub struct PriceStore {
    path: PathBuf,
    last_attempt: Mutex<Option<Instant>>,
}

impl PriceStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            last_attempt: Mutex::new(None),
        }
    }

    pub async fn poll_background(&self) {
        if self.path.is_file() {
            let _ = self.sync(false).await;
        }
    }

    fn read(&self) -> Result<Disk, String> {
        match fs::read(&self.path) {
            Ok(data) => serde_json::from_slice(&data).map_err(|_| "无法读取本地价格历史。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Disk::default()),
            Err(_) => Err("无法打开本地价格历史。".into()),
        }
    }

    async fn sync(&self, manual: bool) -> Result<PriceView, String> {
        let minimum_interval = if manual { MIN_POLL_SECONDS } else { 300 };
        let mut last_attempt = self.last_attempt.lock().await;
        let mut disk = self.read()?;
        let now = crate::model::now();
        if last_attempt.is_some_and(|time| time.elapsed().as_secs() < minimum_interval)
            || disk
                .view
                .checked_at
                .is_some_and(|time| now.saturating_sub(time) < minimum_interval)
        {
            return Ok(disk.view);
        }
        *last_attempt = Some(Instant::now());
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(14))
            .user_agent("AccountDesk/0.1.6 (PriceAI Price Radar)")
            .build()
            .map_err(|_| "无法初始化 HTTPS 连接。")?;
        let mut request = client.get(LATEST);
        if let Some(etag) = &disk.etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "无法连接 PriceAI 数据源。")?;
        if response.status() != StatusCode::NOT_MODIFIED {
            let etag = response
                .headers()
                .get(header::ETAG)
                .and_then(|tag| tag.to_str().ok())
                .map(str::to_owned);
            let pointer: Pointer = decode(response, 32 * 1024).await?;
            if pointer.schema_version != SCHEMA || !valid_snapshot_url(&pointer) {
                return Err("PriceAI 返回了无法识别的快照地址。".into());
            }
            if disk.snapshot_id.as_deref() != Some(&pointer.snapshot_id) {
                let response = client
                    .get(&pointer.snapshot_url)
                    .send()
                    .await
                    .map_err(|_| "无法下载 PriceAI 快照。")?;
                let feed: Feed = decode(response, 12 * 1024 * 1024).await?;
                if feed.schema_version != SCHEMA || feed.snapshot_id != pointer.snapshot_id {
                    return Err("PriceAI 快照版本与索引不一致。".into());
                }
                let product = feed
                    .products
                    .into_iter()
                    .find(|product| product.id == PRODUCT)
                    .ok_or("这份 PriceAI 快照缺少 ChatGPT Plus 报价。")?;
                let current = current_snapshot(product, pointer.stale)?;
                disk.accept(current, now as i64);
                disk.snapshot_id = Some(pointer.snapshot_id);
            }
            disk.etag = etag;
        }
        disk.view
            .history
            .retain(|point| point.time >= (now as i64).saturating_sub(RETENTION_SECONDS));
        disk.view.checked_at = Some(now);
        let bytes = serde_json::to_vec(&disk).map_err(|_| "无法整理价格历史。")?;
        vault::write_atomic(&self.path, &bytes).map_err(|_| "无法保存本地价格历史。")?;
        Ok(disk.view)
    }
}

async fn decode<T: DeserializeOwned>(
    mut response: reqwest::Response,
    max: usize,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!(
            "PriceAI 暂无法读取（HTTP {}）。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err("PriceAI 快照超过读取上限。".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 PriceAI 快照时连接中断。")?
    {
        if chunk.len() > max - body.len() {
            return Err("PriceAI 快照超过读取上限。".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "PriceAI 返回的数据格式无法读取。".into())
}

#[derive(Default, Serialize, Deserialize)]
struct Disk {
    etag: Option<String>,
    snapshot_id: Option<String>,
    view: PriceView,
}

impl Disk {
    fn accept(&mut self, current: Current, now: i64) {
        let cutoff = now.saturating_sub(RETENTION_SECONDS);
        self.view
            .history
            .retain(|point| point.time >= cutoff && point.time != current.time);
        if current.time >= cutoff {
            self.view.history.push(PricePoint {
                time: current.time,
                lowest: current.lowest,
            });
            self.view.history.sort_unstable_by_key(|point| point.time);
        }
        if self
            .view
            .current
            .as_ref()
            .is_none_or(|previous| current.time >= previous.time)
        {
            self.view.current = Some(current);
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceView {
    checked_at: Option<u64>,
    current: Option<Current>,
    history: Vec<PricePoint>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Current {
    time: i64,
    lowest: Option<f64>,
    offer_count: Option<u64>,
    in_stock_count: Option<u64>,
    offers: Vec<Offer>,
    stale: bool,
}

#[derive(Serialize, Deserialize)]
struct PricePoint {
    time: i64,
    lowest: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct Offer {
    id: String,
    merchant: String,
    title: String,
    price: f64,
    available: bool,
    stock: Option<u64>,
}

#[derive(Deserialize)]
struct Pointer {
    schema_version: String,
    snapshot_id: String,
    snapshot_url: String,
    stale: bool,
}

fn valid_snapshot_url(pointer: &Pointer) -> bool {
    !pointer.snapshot_id.is_empty()
        && pointer.snapshot_id.len() <= 80
        && pointer
            .snapshot_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && pointer.snapshot_url == format!("{SNAPSHOTS}{}.json", pointer.snapshot_id)
}

#[derive(Deserialize)]
struct Feed {
    schema_version: String,
    snapshot_id: String,
    products: Vec<Product>,
}

#[derive(Deserialize)]
struct Product {
    id: String,
    snapshot_generated_at: Option<String>,
    lowest_price: Option<f64>,
    lowest_offer: Option<FeedOffer>,
    top_offers: Vec<FeedOffer>,
    offer_count: Option<u64>,
    in_stock_count: Option<u64>,
}

#[derive(Deserialize)]
struct FeedOffer {
    id: String,
    source_name: Option<String>,
    source_store_name: Option<String>,
    title: String,
    price: f64,
    currency: String,
    status: String,
    effective_status: Option<String>,
    stock_count: Option<u64>,
}

impl FeedOffer {
    fn display(self) -> Option<Offer> {
        if self.currency != "CNY" || !valid_price(self.price) || self.id.is_empty() {
            return None;
        }
        Some(Offer {
            id: self.id,
            merchant: self
                .source_store_name
                .filter(|value| !value.is_empty())
                .or(self.source_name)
                .unwrap_or_else(|| "未知渠道".into()),
            title: self.title,
            price: self.price,
            available: self
                .effective_status
                .as_deref()
                .map_or(self.status == "in_stock", |value| value == "available"),
            stock: self.stock_count,
        })
    }
}

fn valid_price(price: f64) -> bool {
    price.is_finite() && price >= 0.0
}

fn current_snapshot(product: Product, stale: bool) -> Result<Current, String> {
    let time = product
        .snapshot_generated_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.timestamp())
        .filter(|time| *time > 0)
        .ok_or("PriceAI 未提供有效的商品快照时间。")?;
    let lowest = product
        .lowest_offer
        .as_ref()
        .filter(|offer| offer.currency == "CNY")
        .and(product.lowest_price)
        .filter(|value| valid_price(*value));
    let mut offers: Vec<_> = product
        .top_offers
        .into_iter()
        .take(5)
        .filter_map(FeedOffer::display)
        .collect();
    let mut seen = std::collections::HashSet::new();
    offers.retain(|offer| seen.insert(offer.id.clone()));
    if let Some(offer) = product.lowest_offer.and_then(FeedOffer::display) {
        if seen.insert(offer.id.clone()) {
            offers.push(offer);
        }
    }
    offers.sort_by(|a, b| a.price.total_cmp(&b.price));
    Ok(Current {
        time,
        lowest,
        offer_count: product.offer_count,
        in_stock_count: product.in_stock_count,
        offers,
        stale,
    })
}

#[tauri::command]
pub fn read_prices(state: State<AppState>) -> Result<PriceView, String> {
    let mut inner = state.guard()?;
    inner.vault()?;
    Ok(state.prices.read()?.view)
}

#[tauri::command]
pub async fn sync_prices(state: State<'_, AppState>, manual: bool) -> Result<PriceView, String> {
    {
        let mut inner = state.guard()?;
        inner.vault()?;
    }
    state.prices.sync(manual).await
}

#[tauri::command]
pub fn open_price_source() -> Result<(), String> {
    open::that("https://priceai.cc/products/chatgpt-plus")
        .map_err(|_| "无法打开 PriceAI 报价页。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_product_snapshots_and_keeps_latest_on_out_of_order_updates() {
        let mut disk = Disk::default();
        let now = 1_000_000;
        let snapshot = |time, lowest| Current {
            time,
            lowest: Some(lowest),
            offer_count: None,
            in_stock_count: None,
            offers: Vec::new(),
            stale: false,
        };
        disk.accept(snapshot(now - RETENTION_SECONDS - 1, 1.0), now);
        disk.accept(snapshot(now - 300, 10.0), now);
        disk.accept(snapshot(now - 300, 12.0), now);
        disk.accept(snapshot(now - 600, 14.0), now);
        assert_eq!(disk.view.history.len(), 2);
        assert_eq!(disk.view.history[0].lowest, Some(14.0));
        assert_eq!(disk.view.current.unwrap().lowest, Some(12.0));
    }

    #[test]
    fn restricts_pointer_to_the_documented_origin_and_path() {
        let mut pointer = Pointer {
            schema_version: SCHEMA.into(),
            snapshot_id: "20261127-abcd".into(),
            snapshot_url: format!("{SNAPSHOTS}20261127-abcd.json"),
            stale: false,
        };
        assert!(valid_snapshot_url(&pointer));
        pointer.snapshot_url += "?ref=foo";
        assert!(!valid_snapshot_url(&pointer));
        pointer.snapshot_url = "https://priceai.cc/v1/snapshots/20261127-abcd.json".into();
        assert!(!valid_snapshot_url(&pointer));
    }
}
