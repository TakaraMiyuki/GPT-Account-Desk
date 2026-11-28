import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, Coins, Package, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { UsageCharts, type UsagePoint } from './usage-charts';

type MerchantSource = {id: string; name: string; url: string | null};
type Quote = {source: MerchantSource; selfHosted?: boolean | null};
type PriceSources = {overall: Quote | null};
type Offer = {id: string; merchant: string; title: string; price: number; available: boolean; stock: number | null; selfHosted?: boolean | null};
type Point = {time: number; lowest: number | null; sources?: PriceSources | null};
type PriceData = {
  checkedAt: number | null;
  current: (Point & {offers: Offer[]; offerCount: number | null; inStockCount: number | null; stale: boolean}) | null;
  history: Point[];
};
const money = new Intl.NumberFormat('zh-CN', {style: 'currency', currency: 'CNY'});
const count = new Intl.NumberFormat('zh-CN');
const fullTime = new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
const price = (value: number | null | undefined) => value == null ? '—' : money.format(value);
const number = (value: number | null | undefined) => value == null ? '—' : count.format(value);
const time = (value: number) => fullTime.format(value * 1000);
const pollInterval = 30_000;
const filterKey = 'account-desk:exclude-self-hosted-prices';

function observedPrices(history: Point[], from: number, now: number, excludeSelfHosted: boolean) {
  const samples = history.filter(point => point.time <= now);
  const first = samples.findIndex(point => point.time >= from);
  if (first < 0) return {series: [], durations: new Map<number, number>(), details: new Map<string, MerchantSource>(), sampleCount: 0};

  const series: UsagePoint[] = [];
  const durations = new Map<number, number>();
  const details = new Map<string, MerchantSource>();
  let previousPrice: number | null = null;
  let previousVisiblePrice: number | null = null;
  let previousSource: MerchantSource | undefined;
  let previousSelfHosted = false;
  let priceSince = from;
  const lastTime = samples[samples.length - 1].time;
  for (let index = first; index < samples.length; index += 1) {
    const sample = samples[index];
    const quote = sample.sources?.overall;
    const value = sample.lowest;
    const source = quote?.source;
    const selfHosted = quote?.selfHosted === true;
    const visiblePrice = excludeSelfHosted && selfHosted ? null : value;
    const at = sample.time;
    if (visiblePrice !== previousVisiblePrice) priceSince = at;
    if (visiblePrice !== null) {
      const until = samples[index + 1]?.time ?? lastTime;
      durations.set(visiblePrice, Math.max(durations.get(visiblePrice) ?? 0, until - priceSince));
    }
    if (value !== previousPrice || source?.id !== previousSource?.id || selfHosted !== previousSelfHosted) {
      const key = String(at);
      series.push({key, time: at, label: time(at), value, hidden: excludeSelfHosted && selfHosted});
      if (source) details.set(key, source);
    }
    previousPrice = value;
    previousVisiblePrice = visiblePrice;
    previousSource = source;
    previousSelfHosted = selfHosted;
  }
  const last = series.at(-1);
  if (last && last.time !== lastTime) {
    series.push({...last, key: String(lastTime), time: lastTime, label: time(lastTime), endpoint: true});
  }
  return {series, durations, details, sampleCount: samples.length - first};
}

function durationLabel(seconds: number | undefined) {
  if (seconds === undefined) return undefined;
  if (seconds === 0) return '持续时间待确认';
  if (seconds < 60) return '最长持续不到 1 分钟';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const parts = [days && `${days} 天`, hours && `${hours} 小时`, minutes % 60 && `${minutes % 60} 分钟`];
  return '最长持续 ' + parts.filter(Boolean).join(' ');
}

export function PriceView() {
  const [data, setData] = useState<PriceData>();
  const [windowDays, setWindowDays] = useState(1);
  const [excludeSelfHosted, setExcludeSelfHosted] = useState(() => localStorage.getItem(filterKey) === 'true');
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);

  const refresh = useCallback(async (manual = false) => {
    if (pending.current) return;
    pending.current = true;
    const started = generation.current;
    setSyncing(true);
    setError('');
    try {
      const updated = await invoke<PriceData>('sync_prices', {manual});
      if (started === generation.current) setData(updated);
    } catch (reason) {
      if (started === generation.current) setError(String(reason));
    } finally {
      pending.current = false;
      if (started === generation.current) setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const started = generation.current;
    void invoke<PriceData>('read_prices').then(saved => {
      if (started === generation.current) setData(saved);
    }).catch(reason => {
      if (started === generation.current) setError(String(reason));
    }).finally(() => {
      if (started === generation.current && !document.hidden) void refresh();
    });
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, pollInterval);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const now = Math.floor(Date.now() / 1000);
  const from = now - windowDays * 86_400;
  const current = data?.current;
  const {series, durations, details, sampleCount} = observedPrices(data?.history ?? [], from, now, excludeSelfHosted);
  const values = Array.from(durations.keys());
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  const min = minimum ? Number(minimum) : 0;
  const max = maximum ? Number(maximum) : Infinity;
  const invalidRange = !Number.isFinite(min) || (maximum !== '' && !Number.isFinite(max)) || min < 0 || max < min;
  const eligible = (current?.offers ?? []).filter(offer => !excludeSelfHosted || offer.selfHosted !== true);
  const visible = invalidRange ? [] : eligible.filter(offer => offer.price >= min && offer.price <= max);
  const inStock = visible.filter(offer => offer.available);
  const known = inStock.filter(offer => offer.stock !== null);
  const stockTotal = known.length ? known.reduce((total, offer) => total + (offer.stock ?? 0), 0) : null;
  const cards = [
    {label: '最新最低价', value: price(excludeSelfHosted && current?.sources?.overall?.selfHosted ? null : current?.lowest), Icon: Coins},
    {label: '区间谷价', value: price(low), range: low === null ? undefined : durationLabel(durations.get(low)), Icon: ArrowDown},
    {label: '区间峰价', value: price(high), range: high === null ? undefined : durationLabel(durations.get(high)), Icon: ArrowUp},
    {label: '全部有货报价', value: number(current?.inStockCount), Icon: Package},
  ];

  return <div className="usage-layout price-layout">
    <section className="usage-panel">
      <div className="usage-toolbar">
        <div className="usage-switch" role="group" aria-label="价格时间范围">
          <button type="button" aria-pressed={windowDays === 1} onClick={() => setWindowDays(1)}>近 24 小时</button>
          <button type="button" aria-pressed={windowDays === 7} onClick={() => setWindowDays(7)}>近 7 天</button>
        </div>
        <div className="usage-toolbar-actions">
          <label className="checkbox-text"><input type="checkbox" checked={excludeSelfHosted} onChange={event => {
            const checked = event.target.checked;
            setExcludeSelfHosted(checked);
            localStorage.setItem(filterKey, String(checked));
          }}/> 过滤自建卡网</label>
          <Button disabled={syncing} onClick={() => void refresh(true)}><RefreshCw size={16} className={syncing ? 'spin' : ''}/> {syncing ? '同步中…' : '刷新报价'}</Button>
          <Button onClick={() => void invoke('open_price_source').catch(reason => setError(String(reason)))}>PriceAI 报价页</Button>
        </div>
      </div>
      <p className="usage-note" role="status">{current ? '商品快照 ' + time(current.time) : '等待首份报价快照'}{data?.checkedAt ? ' · 最近检查 ' + time(data.checkedAt) : ''}。首次同步后，应用运行时约每 5 分钟检查一次。</p>
      {current?.stale && <p className="usage-note price-warning">PriceAI 将本次数据源标记为过期，报价和库存可能已有变化。</p>}
      {error && <p className="usage-note text-bad" role="alert">{error}{current && ' 正在显示上次保存的报价。'}</p>}
    </section>

    <section className="stats-grid" aria-label="价格概览">
      {cards.map(({label, value, range, Icon}) => <div key={label} className="stat-card usage-stat">
        <div className="stat-icon stat-green"><Icon size={18}/></div><div className="stat-copy"><span>{label}</span><strong>{value}</strong>{range && <small>{range}</small>}</div>
      </div>)}
    </section>

    <section className="usage-panel">
      <div className="usage-heading"><h2>最低报价走势</h2></div>
      <p className="usage-note">最低价或商家变化时标点。峰谷持续时间按区间内最长连续时段计算，统计到最后一份快照。</p>
      {excludeSelfHosted && <p className="usage-note">原最低价来自自建卡网的时段留空。渠道未知的历史报价仍然显示。</p>}
      {series.some(point => point.value !== null) ? <UsageCharts key={windowDays} points={series} format={price}
        axisFormat={price} metric="最低报价" mode="line" hourly={false} step detail={point => {
          const source = details.get(point.key);
          return source ? <> · {source.url ? <button type="button" className="price-source-link"
            onClick={() => void invoke('open_price_source', {url: source.url}).catch(reason => setError(String(reason)))}>
            {source.name}
          </button> : source.name}</> : ' · 无商家记录';
        }}/>: <p className="usage-empty">{sampleCount ? '所选时间内暂无符合条件的报价。' : '所选时间内暂无本地快照。'}</p>}
    </section>

    <section className="usage-panel" aria-label="价格与库存">
      <div className="usage-heading price-stock-heading"><h2>价位内库存</h2>
        <div className="price-inputs">
          <label>最低价 <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="不限" value={minimum} onChange={event => setMinimum(event.target.value)}/></label>
          <label>最高价 <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="不限" value={maximum} onChange={event => setMaximum(event.target.value)}/></label>
        </div>
      </div>
      <p className="usage-note">库存统计覆盖接口公开的前 5 条报价及单列最低价。库存数量未知的报价单独计数。</p>
      {invalidRange ? <p className="usage-note text-bad" role="alert">请输入有效的价位范围，最高价须大于或等于最低价。</p> : <>
        <p className="price-stock-summary">{number(inStock.length)} 条有货 · 已知库存 {number(stockTotal)} · {number(inStock.length - known.length)} 条有货报价未提供数量</p>
        {visible.length ? <div className="usage-table-scroll"><table className="usage-table" aria-label="可见报价与库存">
          <thead><tr><th>渠道</th><th>商品</th><th>报价</th><th>状态</th><th>库存数量</th></tr></thead>
          <tbody>{visible.map(offer => <tr key={offer.id}>
            <td>{offer.merchant}{offer.selfHosted && <span className="price-source-tag">自建卡网</span>}</td>
            <td className="price-offer-title" title={offer.title}>{offer.title}</td><td>{price(offer.price)}</td>
            <td>{offer.available ? '有货' : '不可用'}</td><td>{number(offer.stock)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="usage-empty">当前价位无可展示的报价。</p>}
      </>}
    </section>
  </div>;
}
