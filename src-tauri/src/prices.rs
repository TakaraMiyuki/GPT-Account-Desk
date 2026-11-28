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
            .user_agent(concat!(
                "AccountDesk/",
                env!("CARGO_PKG_VERSION"),
                " (PriceAI Price Radar)"
            ))
            .build()
            .map_err(|_| "无法初始化 HTTPS 连接。")?;
        let mut request = client.get(LATEST);
        let needs_sources = disk
            .view
            .current
            .as_ref()
            .is_some_and(|current| current.sources.is_none());
        if let Some(etag) = disk.etag.as_ref().filter(|_| !needs_sources) {
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
            if needs_sources || disk.snapshot_id.as_deref() != Some(&pointer.snapshot_id) {
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
                sources: current.sources.clone(),
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
    #[serde(default)]
    sources: Option<PriceSources>,
}

#[derive(Serialize, Deserialize)]
struct PricePoint {
    time: i64,
    lowest: Option<f64>,
    #[serde(default)]
    sources: Option<PriceSources>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    id: String,
    merchant: String,
    title: String,
    price: f64,
    available: bool,
    stock: Option<u64>,
    #[serde(default)]
    self_hosted: Option<bool>,
    #[serde(default)]
    source: Option<MerchantSource>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PriceSources {
    overall: Option<PriceQuote>,
    marketplace: Option<PriceQuote>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PriceQuote {
    price: f64,
    source: MerchantSource,
}

#[derive(Clone, Serialize, Deserialize)]
struct MerchantSource {
    id: String,
    name: String,
    url: Option<String>,
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
    source_id: Option<String>,
    source_name: Option<String>,
    source_store_name: Option<String>,
    url: Option<String>,
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
        let merchant = self
            .source_store_name
            .filter(|name| !name.trim().is_empty())
            .or(self.source_name.filter(|name| !name.trim().is_empty()));
        let url = self.url.as_deref().and_then(web_url);
        let source_id = self.source_id.as_deref().unwrap_or_default();
        let self_hosted = classify_source(source_id, url.as_ref());
        let name = merchant
            .as_deref()
            .or((!source_id.is_empty()).then_some(source_id))
            .or_else(|| url.as_ref().and_then(reqwest::Url::host_str));
        let source = name.map(|name| MerchantSource {
            id: if source_id.is_empty() {
                name.to_owned()
            } else {
                source_id.to_owned()
            },
            name: name.to_owned(),
            url: url.as_ref().map(ToString::to_string),
        });
        Some(Offer {
            id: self.id,
            merchant: name.unwrap_or("未知渠道").to_owned(),
            title: self.title,
            price: self.price,
            available: self
                .effective_status
                .as_deref()
                .map_or(self.status == "in_stock", |value| value == "available"),
            stock: self.stock_count,
            self_hosted,
            source,
        })
    }
}

fn web_url(value: &str) -> Option<reqwest::Url> {
    reqwest::Url::parse(value).ok().filter(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn classify_source(source_id: &str, url: Option<&reqwest::Url>) -> Option<bool> {
    let host = url.and_then(reqwest::Url::host_str);
    // Price Radar exposes source IDs and listing URLs, without a storefront type field.
    if source_id.starts_with("16688-")
        || source_id.starts_with("ldxp-")
        || host.is_some_and(|host| {
            ["16688.store", "wzyp.cn"].iter().any(|platform| {
                host == *platform
                    || host
                        .strip_suffix(platform)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            })
        })
    {
        return Some(false);
    }
    host.map(|_| true)
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
    let lowest_offer = product.lowest_offer.and_then(FeedOffer::display);
    let overall = lowest_offer
        .as_ref()
        .filter(|offer| Some(offer.price) == lowest)
        .and_then(|offer| {
            offer.source.clone().map(|source| PriceQuote {
                price: offer.price,
                source,
            })
        });
    let mut offers: Vec<_> = product
        .top_offers
        .into_iter()
        .take(5)
        .filter_map(FeedOffer::display)
        .collect();
    let mut seen = std::collections::HashSet::new();
    offers.retain(|offer| seen.insert(offer.id.clone()));
    if let Some(offer) = lowest_offer {
        if seen.insert(offer.id.clone()) {
            offers.push(offer);
        }
    }
    offers.sort_by(|a, b| a.price.total_cmp(&b.price));
    let marketplace = offers
        .iter()
        .filter(|offer| offer.available && offer.self_hosted == Some(false))
        .find_map(|offer| {
            offer.source.clone().map(|source| PriceQuote {
                price: offer.price,
                source,
            })
        });
    Ok(Current {
        time,
        lowest,
        offer_count: product.offer_count,
        in_stock_count: product.in_stock_count,
        offers,
        stale,
        sources: Some(PriceSources {
            overall,
            marketplace,
        }),
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
pub fn open_price_source(url: Option<String>) -> Result<(), String> {
    let url = url
        .as_deref()
        .unwrap_or("https://priceai.cc/products/chatgpt-plus");
    let url = web_url(url).ok_or("这条报价没有有效的网页链接。")?;
    open::that(url.as_str()).map_err(|_| "无法打开 PriceAI 报价页。".into())
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
            sources: None,
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

    #[test]
    fn captures_storefront_attribution_for_both_price_modes() {
        let product = serde_json::from_value(serde_json::json!({
            "id": PRODUCT, "snapshot_generated_at": "2026-11-28T12:00:00+08:00", "lowest_price": 6.8,
            "lowest_offer": {"id": "direct", "source_id": "direct-store", "source_name": "独立商家",
                "title": "Plus", "price": 6.8, "currency": "CNY", "status": "in_stock",
                "url": "https://shop.example.com/item/1"},
            "top_offers": [
                {"id": "market-out", "source_id": "16688-s1", "source_name": "平台缺货",
                    "title": "Plus", "price": 7, "currency": "CNY", "status": "sold_out"},
                {"id": "market", "source_id": "nodebits-1", "source_name": "平台商家",
                    "title": "Plus", "price": 9, "currency": "CNY", "status": "in_stock",
                    "url": "https://www.wzyp.cn/item/9"},
                {"id": "unknown", "source_name": "未知归属",
                    "title": "Plus", "price": 8, "currency": "CNY", "status": "in_stock",
                    "url": "javascript:alert(1)"}
            ]
        })).unwrap();
        let current = current_snapshot(product, false).unwrap();
        assert_eq!(current.offers[0].self_hosted, Some(true));
        assert_eq!(current.offers[1].self_hosted, Some(false));
        assert_eq!(current.offers[2].self_hosted, None);
        let mut disk = Disk::default();
        disk.accept(current, 0);
        let sources = disk.view.history[0].sources.as_ref().unwrap();
        assert_eq!(sources.overall.as_ref().unwrap().source.name, "独立商家");
        let market = sources.marketplace.as_ref().unwrap();
        assert_eq!(market.price, 9.0);
        assert_eq!(
            market.source.url.as_deref(),
            Some("https://www.wzyp.cn/item/9")
        );
        let legacy: PricePoint = serde_json::from_str(r#"{"time":1,"lowest":17}"#).unwrap();
        assert!(legacy.sources.is_none());
    }
}
