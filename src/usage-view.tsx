import { invoke } from '@tauri-apps/api/core';
import { Activity, ChartColumn, ChartLine, Coins, Database, FolderPlus, Gauge, Grid3X3, RefreshCw, Settings2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Account, localDay, Unlocked } from './domain';
import { Button, Modal } from './ui';
import { UsageCharts, UsagePoint } from './usage-charts';

type Range = 'today' | 'week' | 'month' | 'all';
type Metric = 'tokens' | 'requests' | 'cost' | 'cache';
type Chart = 'line' | 'bar' | 'matrix';
type Detail = 'logs' | 'accounts' | 'models';
type Totals = {requests: number; tokens: number; input: number; cachedInput: number; cost: number; pricedRequests: number};
type Request = {time: number; model: string; accountId: string | null; input: number; cachedInput: number; output: number; estimatedCost: number | null};
type LocalUsage = {
  totals: Totals; buckets: Record<string, Totals>; accounts: Record<string, Totals>; unassigned: Totals;
  models: Record<string, Totals>; modelOptions: string[]; logs: Request[]; files: number; inaccessible: number; scannedAt: number;
};
type UsageProps = {
  book: Unlocked; busy: string;
  addSource: (account: string | null, useDefault: boolean) => Promise<unknown>;
  assignSource: (id: string, account: string | null) => Promise<unknown>;
  removeSource: (id: string) => Promise<unknown>;
};

const ranges: Record<Range, string> = {today: '今日', week: '近 7 天', month: '近 30 天', all: '全部'};
const offsets = {today: 0, week: -6, month: -29};
const metrics = {
  tokens: {label: 'Token 消耗', Icon: Database, hint: '输入与输出 Token 合计'},
  requests: {label: '请求数', Icon: Activity, hint: '含用量记录的模型响应'},
  cost: {label: '成本估算', Icon: Coins, hint: '公开 API 标准费率'},
  cache: {label: '缓存命中率', Icon: Gauge, hint: '缓存读取 Token ÷ 输入 Token'},
};
const charts = {line: {label: '折线图', Icon: ChartLine}, bar: {label: '柱状图', Icon: ChartColumn}, matrix: {label: '点阵图', Icon: Grid3X3}};
const details: Record<Detail, string> = {logs: '请求日志', accounts: '按账号', models: '按模型'};
const integer = new Intl.NumberFormat('zh-CN');
const usd = new Intl.NumberFormat('zh-CN', {style: 'currency', currency: 'USD', maximumFractionDigits: 4});
const percent = new Intl.NumberFormat('zh-CN', {style: 'percent', maximumFractionDigits: 1});
const accountLabel = (account: Account) => [account.number, account.email].filter(Boolean).join(' · ');
const format = (value: number | null | undefined, metric: Metric = 'tokens') => value == null ? '—' :
  (metric === 'cost' ? usd : metric === 'cache' ? percent : integer).format(value);
const metricValue = (totals: Totals | undefined, metric: Metric): number | null => {
  if (!totals) return null;
  if (metric === 'cache') return totals.input > 0 ? totals.cachedInput / totals.input : null;
  if (metric === 'cost') return totals.pricedRequests > 0 ? totals.cost : null;
  return totals[metric];
};

function timeline(range: Range, buckets: Record<string, Totals>, metric: Metric): UsagePoint[] {
  const keys = Object.keys(buckets).sort();
  if (!keys.length) return [];
  const today = localDay();
  const value = (key: string) => buckets[key] ? metricValue(buckets[key], metric) : metric === 'cost' || metric === 'cache' ? null : 0;
  if (range === 'today') {
    const currentHour = new Date().getHours();
    return Array.from({length: 24}, (_, hour) => {
      const key = today + 'T' + String(hour).padStart(2, '0') + ':00';
      return {key, value: hour > currentHour ? null : value(key)};
    });
  }
  const first = range === 'all' ? keys[0] : localDay(offsets[range]);
  const points: UsagePoint[] = [];
  const date = new Date(first + 'T12:00');
  for (; Number.isFinite(date.getTime()); date.setDate(date.getDate() + 1)) {
    const key = String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    if (key > today) break;
    points.push({key, value: value(key)});
  }
  return points;
}

export function UsageView({book, busy, addSource, assignSource, removeSource}: UsageProps) {
  const [range, setRange] = useState<Range>('week');
  const [account, setAccount] = useState('');
  const [sourceAccount, setSourceAccount] = useState('');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [chart, setChart] = useState<Chart>('line');
  const [detail, setDetail] = useState<Detail>('logs');
  const [model, setModel] = useState('');
  const [page, setPage] = useState(0);
  const [rescan, setRescan] = useState(0);
  const scanRequested = useRef(0);
  const [manage, setManage] = useState(false);
  const [outcome, setOutcome] = useState<{key: string; data?: LocalUsage; error?: string}>();
  const fromDay = range === 'all' ? null : localDay(offsets[range]);
  const from = fromDay ? new Date(fromDay + 'T00:00').getTime() : null;
  const sourceKey = book.usageSources.map(source => source.id + ':' + (source.accountId ?? '')).join(',');
  const hourly = range === 'today';
  const key = JSON.stringify([range, from, account, model, page, rescan, sourceKey]);
  const result = outcome?.key === key ? outcome : undefined;
  const data = result?.data;
  const loading = !!sourceKey && !result;

  useEffect(() => {
    if (!sourceKey) return;
    let active = true;
    const reload = scanRequested.current !== rescan;
    scanRequested.current = rescan;
    invoke<LocalUsage>('local_usage', {
      query: {from, account: account && account !== 'unassigned' ? account : null,
        unassigned: account === 'unassigned', model: model || null, hourly, page},
      rescan: reload,
    }).then(data => {
      if (active) setOutcome({key, data});
    }).catch(error => { if (active) setOutcome({key, error: String(error)}); });
    return () => { active = false; };
  }, [sourceKey, from, account, model, hourly, page, key, rescan]);

  const series = useMemo(() => data ? timeline(range, data.buckets, metric) : [], [range, data, metric]);
  const name = (id: string | null) => {
    const row = book.accounts.find(item => item.id === id);
    return row ? accountLabel(row) : '未归属';
  };
  const selectAccount = (value: string) => { setAccount(value); setPage(0); };
  const selectModel = (value: string) => { setModel(value); setPage(0); };
  const accounts = Object.entries(data?.accounts ?? {}).map(([id, totals]) => ({id, label: name(id), totals}));
  if (data?.unassigned.requests) accounts.push({id: 'unassigned', label: '未归属', totals: data.unassigned});
  const modelRows = Object.entries(data?.models ?? {}).map(([id, totals]) => ({id, label: id, totals}));
  const modelOptions = data?.modelOptions ?? [];


  return <div className="usage-layout">
    <section className="usage-panel" aria-label="统计筛选">
      <div className="usage-toolbar">
        <div className="usage-switch" role="group" aria-label="时间范围">
          {(Object.keys(ranges) as Range[]).map(item => <button type="button" key={item} aria-pressed={range === item}
            onClick={() => {setRange(item); setPage(0);}}>{ranges[item]}</button>)}
        </div>
        <label className="filter-select"><span className="sr-only">筛选账号</span>
          <select value={account} onChange={event => selectAccount(event.target.value)}>
            <option value="">全部账号</option>{book.accounts.map(row => <option key={row.id} value={row.id}>{accountLabel(row)}</option>)}
            <option value="unassigned">未归属</option>
          </select>
        </label>
        <label className="filter-select"><span className="sr-only">筛选模型</span>
          <select value={model} onChange={event => selectModel(event.target.value)}>
            <option value="">全部模型</option>{(model && !modelOptions.includes(model) ? [...modelOptions, model] : modelOptions).map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="usage-toolbar-actions">
          <Button disabled={!sourceKey || loading || !!busy} onClick={() => {setPage(0); setRescan(count => count + 1);}}>
            <RefreshCw size={16} className={loading ? 'spin' : ''}/> 刷新用量</Button>
          <Button onClick={() => setManage(true)}><Settings2 size={16}/> 日志设置</Button>
        </div>
      </div>
      <p className="usage-note" role="status">{loading ? '正在读取日志…' : result?.error ? result.error :
        data ? '已扫描 ' + data.files + ' 个会话日志' + (data.inaccessible ? ' · ' + data.inaccessible + ' 处无法访问' : '') +
          ' · 上次同步 ' + new Date(data.scannedAt).toLocaleTimeString('zh-CN', {hour12: false}) :
        '接入 Codex 会话目录后可统计历史请求。多个账号混用的目录可保留为未归属。'}</p>
      {!!data?.unassigned.requests && <p className="usage-note">未归属的请求可在<button type="button" className="usage-link" onClick={() => setManage(true)}>日志设置</button>中为对应目录指定账号。</p>}
      {!sourceKey && <div className="usage-toolbar usage-setup">
        <Button kind="primary" disabled={!!busy} onClick={() => void addSource(null, true)}><FolderPlus size={16}/> 接入默认 Codex 日志</Button>
        <Button disabled={!!busy} onClick={() => setManage(true)}>选择其他目录</Button>
      </div>}
    </section>

    <section className="stats-grid" aria-label="用量概览">
      {(Object.keys(metrics) as Metric[]).map(id => {
        const {label, Icon, hint} = metrics[id];
        return <button type="button" key={id} className="stat-card stat-button usage-stat" aria-pressed={id === metric} onClick={() => setMetric(id)}>
          <div className="stat-icon stat-green"><Icon size={18}/></div>
          <div className="stat-copy"><span>{label}</span><strong>{format(metricValue(data?.totals, id), id)}</strong>
            <small>{id === 'cost' && data ? hint + ' · ' + data.totals.pricedRequests + '/' + data.totals.requests + ' 条可估算' : hint}</small></div>
        </button>;
      })}
    </section>

    <section className="usage-panel" aria-label="用量趋势">
      <div className="usage-heading usage-trend-heading"><h2>用量趋势 <small>{metrics[metric].label}</small></h2>
        <div className="usage-switch" role="group" aria-label="图表类型">
          {(Object.keys(charts) as Chart[]).map(item => {
            const {Icon, label} = charts[item];
            return <button type="button" key={item} aria-pressed={chart === item} onClick={() => setChart(item)}><Icon size={15}/>{label}</button>;
          })}
        </div>
      </div>
      <UsageCharts key={range + ':' + chart + ':' + metric} points={series} format={value => format(value, metric)}
        metric={metrics[metric].label} hourly={hourly} mode={chart} axisFormat={metric === 'cache' ? value => percent.format(value) :
          metric === 'cost' ? value => usd.format(value) : undefined}/>
    </section>

    <section className="usage-panel" aria-label="用量明细">
      <div className="usage-heading">
        <div className="usage-switch" role="group" aria-label="明细视图">
          {(Object.keys(details) as Detail[]).map(item => <button key={item} type="button" aria-pressed={detail === item}
            onClick={() => setDetail(item)}>{details[item]}</button>)}
        </div>
      </div>
      {detail === 'accounts' ? <TotalsTable itemLabel="账号" rows={accounts} current={account} pick={selectAccount}/> :
        detail === 'models' ? <TotalsTable itemLabel="模型" rows={modelRows} current={model} pick={selectModel}/> : <>
          {data?.logs.length ? <div className="usage-table-scroll"><table className="usage-table" aria-label="请求日志">
            <thead><tr><th>时间</th><th>账号</th><th>模型</th><th>输入</th><th>缓存读取</th><th>输出</th><th>估算成本</th></tr></thead>
            <tbody>{data.logs.map((log, index) => <tr key={index}>
              <td>{new Date(log.time).toLocaleString('zh-CN', {hour12: false})}</td><td>{name(log.accountId)}</td><td>{log.model}</td>
              <td>{format(log.input)}</td><td>{format(log.cachedInput)}</td><td>{format(log.output)}</td><td>{format(log.estimatedCost, 'cost')}</td>
            </tr>)}</tbody>
          </table></div> : <p className="usage-empty">{loading ? '正在读取请求记录…' : '所选范围暂无请求记录。'}</p>}
          {!!data && (data.totals.requests > 50 || page > 0) && <div className="usage-pager">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
            <span>第 {page + 1} / {Math.max(1, Math.ceil(data.totals.requests / 50))} 页</span>
            <Button disabled={(page + 1) * 50 >= data.totals.requests} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>}
        </>}
    </section>
    {manage && <Modal title="日志设置" close={() => setManage(false)}>
      <div className="usage-source-dialog">
        <div className="usage-toolbar">
          <label className="filter-select"><span className="sr-only">日志归属账号</span>
            <select value={sourceAccount} onChange={event => setSourceAccount(event.target.value)}>
              <option value="">未归属或混用账号</option>
              {book.accounts.map(row => <option key={row.id} value={row.id}>{accountLabel(row)}</option>)}
            </select>
          </label>
          <Button disabled={!!busy} onClick={() => void addSource(sourceAccount || null, false)}><FolderPlus size={16}/> 选择日志目录</Button>
          <Button disabled={!!busy} onClick={() => void addSource(sourceAccount || null, true)}>使用默认目录</Button>
        </div>
        <p className="usage-note">默认日志目录可能包含多个账号。确认整个目录属于同一账号时，可在下面指定归属，已导入的请求会重新统计。混用目录请保留为未归属。</p>
        {book.usageSources.map(source => <div className="usage-source" key={source.id}>
          <label className="filter-select"><span className="sr-only">目录归属 {source.folder}</span>
            <select value={source.accountId ?? ''} disabled={!!busy} onChange={event => {
              setPage(0);
              void assignSource(source.id, event.target.value || null);
            }}>
              <option value="">未归属或混用账号</option>
              {book.accounts.map(row => <option value={row.id} key={row.id}>{accountLabel(row)}</option>)}
            </select>
          </label><span title={source.folder}>{source.folder}</span>
          <Button className="icon-button" aria-label={'移除日志来源 ' + source.folder} disabled={!!busy} onClick={() => void removeSource(source.id)}><X size={15}/></Button>
        </div>)}
      </div>
      <div className="modal-footer"><Button kind="primary" onClick={() => setManage(false)}>完成</Button></div>
    </Modal>}
  </div>;
}

function TotalsTable({itemLabel, rows, current, pick}: {
  itemLabel: string; rows: {id: string; label: string; totals: Totals}[]; current: string; pick: (value: string) => void;
}) {
  return rows.length ? <div className="usage-table-scroll"><table className="usage-table" aria-label={'按' + itemLabel}>
    <thead><tr><th>{itemLabel}</th><th>请求数</th><th>Token</th><th>估算成本</th><th>缓存命中率</th></tr></thead>
    <tbody>{rows.sort((a, b) => b.totals.tokens - a.totals.tokens).map(({id, label, totals}) => <tr key={id}>
      <td><button type="button" className="usage-link" aria-pressed={current === id} onClick={() => pick(id === current ? '' : id)}>{label}</button></td>
      <td>{format(totals.requests)}</td><td>{format(totals.tokens)}</td>
      <td>{format(metricValue(totals, 'cost'), 'cost')}</td><td>{format(metricValue(totals, 'cache'), 'cache')}</td>
    </tr>)}</tbody>
  </table></div> : <p className="usage-empty">所选范围暂无记录。</p>;
}
