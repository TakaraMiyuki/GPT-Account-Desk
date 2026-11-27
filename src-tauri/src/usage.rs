use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub fetched_at: u64,
    pub lifetime_tokens: Option<u64>,
    pub days: Option<BTreeMap<String, u64>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Uuid,
    pub account_id: Option<Uuid>,
    pub folder: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Tokens {
    input: u64,
    cached: u64,
    write: u64,
    output: u64,
}

impl Tokens {
    fn read(data: &Value) -> Option<Self> {
        let input = data["input_tokens"].as_u64()?;
        let cached = data["cached_input_tokens"].as_u64().unwrap_or(0).min(input);
        let write = data["cache_write_input_tokens"]
            .as_u64()
            .unwrap_or(0)
            .min(input - cached);
        Some(Self {
            input,
            cached,
            write,
            output: data["output_tokens"].as_u64()?,
        })
    }
    fn delta(self, prior: Self) -> Self {
        let input = self.input.saturating_sub(prior.input);
        let cached = self.cached.saturating_sub(prior.cached).min(input);
        Self {
            input,
            cached,
            write: self.write.saturating_sub(prior.write).min(input - cached),
            output: self.output.saturating_sub(prior.output),
        }
    }
    fn sum(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            cached: self.cached.saturating_add(other.cached),
            write: self.write.saturating_add(other.write),
            output: self.output.saturating_add(other.output),
        }
    }
    fn total(self) -> u64 {
        self.input.saturating_add(self.output)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    time: i64,
    model: String,
    account_id: Option<Uuid>,
    input: u64,
    cached_input: u64,
    cache_write: u64,
    output: u64,
    estimated_cost: Option<f64>,
}

fn estimate(model: &str, tokens: Tokens) -> Option<f64> {
    // Standard public API reference rates in USD per million tokens.
    let (input, cached, output, long_threshold): (f64, f64, f64, Option<u64>) = match model {
        "gpt-6.2-astra" => (8.0, 0.4, 40.0, Some(272_000)),
        "gpt-6.2-sol" | "gpt-6.1-sol" => (2.0, 0.1, 10.0, Some(272_000)),
        "gpt-6-astra" => (10.0, 1.0, 50.0, Some(272_000)),
        "gpt-6.1-terra" => (1.0, 0.05, 5.0, Some(272_000)),
        "gpt-5.6-sol" | "gpt-5.6" => (4.0, 0.4, 20.0, Some(272_000)),
        "gpt-5.6-terra" => (2.0, 0.2, 12.0, Some(272_000)),
        _ => return None,
    };
    let (input_scale, output_scale) = if long_threshold.is_some_and(|limit| tokens.input > limit) {
        (2.0, 1.5)
    } else {
        (1.0, 1.0)
    };
    let ordinary = tokens
        .input
        .saturating_sub(tokens.cached)
        .saturating_sub(tokens.write);
    Some(
        (ordinary as f64 * input * input_scale
            + tokens.cached as f64 * cached * input_scale
            + tokens.write as f64 * input * 1.25 * input_scale
            + tokens.output as f64 * output * output_scale)
            / 1_000_000.0,
    )
}

impl Request {
    fn new(time: i64, model: String, account_id: Option<Uuid>, tokens: Tokens) -> Self {
        Self {
            time,
            estimated_cost: estimate(&model, tokens),
            model,
            account_id,
            input: tokens.input,
            cached_input: tokens.cached,
            cache_write: tokens.write,
            output: tokens.output,
        }
    }
}

const LINE_LIMIT: usize = 2 * 1024 * 1024;

fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    let mut over_limit = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(false);
        }
        let end = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map(|index| index + 1);
        let consumed = end.unwrap_or(buffer.len());
        if !over_limit && line.len() + consumed <= LINE_LIMIT {
            line.extend_from_slice(&buffer[..consumed]);
        } else {
            over_limit = true;
        }
        reader.consume(consumed);
        if end.is_some() {
            if over_limit {
                line.clear();
            }
            return Ok(true);
        }
    }
}

fn model_name(value: &Value) -> Option<String> {
    let model = value.as_str()?.trim().to_ascii_lowercase();
    if model.is_empty()
        || model.len() > 80
        || !model
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._-/".contains(&v))
    {
        return None;
    }
    Some(model)
}

fn timestamp(value: &Value) -> Option<i64> {
    let time = DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()?
        .timestamp_millis();
    (time > 0).then_some(time)
}

fn valid_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 160
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    })
}

fn read_rollout(
    path: &Path,
    account: Option<Uuid>,
    requests: &mut HashMap<String, Request>,
) -> io::Result<()> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = Vec::new();
    let mut model = String::new();
    let mut thread = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut prior: Option<Tokens> = None;
    let mut explicit = Tokens::default();
    while read_line(&mut reader, &mut line)? {
        if line.is_empty() {
            continue;
        }
        let head = &line[..line.len().min(512)];
        if ![
            b"\"session_meta\"".as_slice(),
            b"\"turn_context\"",
            b"\"token_count\"",
            b"\"token_usage_record\"",
            b"\"thread_settings_applied\"",
        ]
        .iter()
        .any(|needle| head.windows(needle.len()).any(|value| value == *needle))
        {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let data = &event["payload"];
        let kind = event["type"].as_str();
        match kind {
            Some("session_meta") => {
                if let Some(id) = valid_id(&data["id"]) {
                    thread = id.to_owned();
                }
            }
            Some("turn_context") => {
                if let Some(name) = model_name(&data["model"]) {
                    model = name;
                }
            }
            Some("event_msg") if data["type"] == "thread_settings_applied" => {
                if let Some(name) =
                    model_name(&data["settings"]["model"]).or_else(|| model_name(&data["model"]))
                {
                    model = name;
                }
            }
            Some("token_usage_record") => {
                let Some(tokens) = Tokens::read(&data["usage"]).filter(|tokens| tokens.total() > 0)
                else {
                    continue;
                };
                let Some(time) = timestamp(&event["timestamp"]) else {
                    continue;
                };
                let key = valid_id(&data["response_id"])
                    .map(|id| format!("response:{id}"))
                    .unwrap_or_else(|| {
                        format!("record:{thread}:{time}:{}:{}", tokens.input, tokens.output)
                    });
                let name = model_name(&data["model"]).unwrap_or_else(|| model.clone());
                insert_request(requests, key, Request::new(time, name, account, tokens));
                explicit = explicit.sum(tokens);
            }
            Some("event_msg") if data["type"] == "token_count" => {
                let info = &data["info"];
                let Some(time) = timestamp(&event["timestamp"]) else {
                    continue;
                };
                let last = Tokens::read(&info["last_token_usage"]);
                let total = Tokens::read(&info["total_token_usage"]);
                if total.is_none() && last.is_none() {
                    continue;
                }
                if total.is_some() && total == prior {
                    explicit = Tokens::default();
                    continue;
                }
                let mut tokens = match (total, prior, last) {
                    (Some(total), Some(previous), _)
                        if total.input >= previous.input && total.output >= previous.output =>
                    {
                        total.delta(previous)
                    }
                    (Some(total), _, last) => last.unwrap_or(total),
                    (None, _, Some(last)) => last,
                    _ => continue,
                };
                if total.is_some() {
                    prior = total;
                }
                // Modern records precede compatibility counters for the same response.
                // Count only the remainder when the cumulative counter covers several responses.
                if explicit.total() > 0 {
                    if last == Some(explicit) || tokens == explicit {
                        tokens = Tokens::default();
                    } else if total.is_some()
                        && tokens.input >= explicit.input
                        && tokens.output >= explicit.output
                    {
                        tokens = tokens.delta(explicit);
                    }
                }
                explicit = Tokens::default();
                if tokens.total() == 0 {
                    continue;
                }
                let sequence = total.unwrap_or(tokens);
                let key = format!(
                    "count:{thread}:{time}:{}:{}",
                    sequence.input, sequence.output
                );
                insert_request(
                    requests,
                    key,
                    Request::new(time, model.clone(), account, tokens),
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn insert_request(requests: &mut HashMap<String, Request>, key: String, request: Request) {
    requests
        .entry(key)
        .and_modify(|previous| {
            if previous.account_id != request.account_id {
                previous.account_id = None;
            }
        })
        .or_insert(request);
}

pub struct Index {
    requests: Vec<Request>,
    files: u64,
    inaccessible: u64,
    scanned_at: i64,
}

impl Index {
    pub fn scan(sources: &[Source]) -> Self {
        let mut requests = HashMap::new();
        let mut files = 0;
        let mut inaccessible = 0;
        let mut scanned = HashSet::new();
        for source in sources {
            let Ok(root) = fs::canonicalize(&source.folder) else {
                inaccessible += 1;
                continue;
            };
            let mut directories = vec![root.clone()];
            while let Some(directory) = directories.pop() {
                if !scanned.insert((source.id, directory.clone())) {
                    continue;
                }
                let Ok(entries) = fs::read_dir(&directory) else {
                    inaccessible += 1;
                    continue;
                };
                for entry in entries {
                    let Ok(entry) = entry else {
                        inaccessible += 1;
                        continue;
                    };
                    let Ok(kind) = entry.file_type() else {
                        inaccessible += 1;
                        continue;
                    };
                    if kind.is_dir() {
                        if let Ok(path) = entry.path().canonicalize() {
                            if path.starts_with(&root) {
                                directories.push(path);
                            }
                        }
                    } else if kind.is_file()
                        && entry.file_name().to_str().is_some_and(|name| {
                            name.starts_with("rollout-") && name.ends_with(".jsonl")
                        })
                    {
                        if read_rollout(&entry.path(), source.account_id, &mut requests).is_ok() {
                            files += 1;
                        } else {
                            inaccessible += 1;
                        }
                    }
                }
            }
        }
        let mut requests: Vec<_> = requests.into_values().collect();
        requests.sort_unstable_by(|a, b| {
            b.time
                .cmp(&a.time)
                .then(a.model.cmp(&b.model))
                .then(a.input.cmp(&b.input))
        });
        Self {
            requests,
            files,
            inaccessible,
            scanned_at: Local::now().timestamp_millis(),
        }
    }

    pub fn query(&self, query: &Query) -> LocalUsage {
        let mut totals = Totals::default();
        let mut buckets = BTreeMap::<String, Totals>::new();
        let mut accounts = BTreeMap::<Uuid, Totals>::new();
        let mut models = BTreeMap::<String, Totals>::new();
        let mut model_options = BTreeSet::new();
        let mut unknown = Totals::default();
        let mut logs = Vec::new();
        let skip = (query.page as usize).saturating_mul(50);
        for request in self.requests.iter().filter(|request| {
            query.from.is_none_or(|from| request.time >= from)
                && query
                    .account
                    .is_none_or(|account| request.account_id == Some(account))
                && (!query.unassigned || request.account_id.is_none())
        }) {
            model_options.insert(request.model.as_str());
            if query
                .model
                .as_ref()
                .is_some_and(|model| model != &request.model)
            {
                continue;
            }
            if totals.requests >= skip as u64 && logs.len() < 50 {
                logs.push(request.clone());
            }
            totals.add(request);
            if let Some(date) = DateTime::from_timestamp_millis(request.time) {
                let date = date.with_timezone(&Local);
                let key = if query.hourly {
                    date.format("%Y-%m-%dT%H:00").to_string()
                } else {
                    date.format("%Y-%m-%d").to_string()
                };
                buckets.entry(key).or_default().add(request);
            }
            if let Some(account) = request.account_id {
                accounts.entry(account).or_default().add(request);
            } else {
                unknown.add(request);
            }
            models
                .entry(request.model.clone())
                .or_default()
                .add(request);
        }
        LocalUsage {
            totals,
            buckets,
            accounts,
            unassigned: unknown,
            models,
            model_options: model_options.into_iter().map(str::to_string).collect(),
            logs,
            files: self.files,
            inaccessible: self.inaccessible,
            scanned_at: self.scanned_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub from: Option<i64>,
    pub account: Option<Uuid>,
    pub unassigned: bool,
    pub model: Option<String>,
    pub hourly: bool,
    pub page: u32,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    requests: u64,
    tokens: u64,
    input: u64,
    cached_input: u64,
    cost: f64,
    priced_requests: u64,
}

impl Totals {
    fn add(&mut self, request: &Request) {
        self.requests += 1;
        self.tokens = self
            .tokens
            .saturating_add(request.input)
            .saturating_add(request.output);
        self.input = self.input.saturating_add(request.input);
        self.cached_input = self.cached_input.saturating_add(request.cached_input);
        if let Some(cost) = request.estimated_cost {
            self.priced_requests += 1;
            self.cost += cost;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsage {
    totals: Totals,
    buckets: BTreeMap<String, Totals>,
    accounts: BTreeMap<Uuid, Totals>,
    unassigned: Totals,
    models: BTreeMap<String, Totals>,
    model_options: Vec<String>,
    logs: Vec<Request>,
    files: u64,
    inaccessible: u64,
    scanned_at: i64,
}
