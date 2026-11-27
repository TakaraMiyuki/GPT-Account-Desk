import { Ticket } from 'lucide-react';
import { Account, activeObservation, cardsStale, formatDate, planGroup, positiveResetCards, quotaStale } from './domain';

export function AccountAvatar({account}: {account: Account}) {
  const gold = positiveResetCards(account) ? ' avatar-gold' : '';
  return <span className={`avatar avatar-${planGroup(account)}${gold}`}
    title={gold ? '已记录重置卡' : undefined}>{account.email[0]?.toUpperCase()}</span>;
}

function duration(minutes: number | null, index: number, compact: boolean) {
  if (!minutes) return index ? '次级' : '主要';
  if (minutes === 10080) return compact ? '7d' : '每周';
  if (minutes % 1440 === 0) return compact ? minutes / 1440 + 'd' : minutes / 1440 + ' 天';
  if (minutes % 60 === 0) return compact ? minutes / 60 + 'h' : minutes / 60 + ' 小时';
  return compact ? minutes + 'm' : minutes + ' 分钟';
}

function until(time: number | null, now: number, compact: boolean) {
  if (!time) return '—';
  if (time <= now) return '待刷新';
  const minutes = Math.max(1, Math.ceil((time - now) / 60));
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    return compact ? days + 'd' : days + ' 天' + (hours ? ' ' + hours + ' 小时' : '');
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return compact ? hours + 'h' : hours + ' 小时' + (remainder ? ' ' + remainder + ' 分钟' : '');
  }
  return compact ? minutes + 'm' : minutes + ' 分钟';
}

export function QuotaMeter({account, now, compact = false}: {account: Account; now: number; compact?: boolean}) {
  const observation = activeObservation(account);
  const windows = observation?.quota?.windows ?? [];
  if (!windows.length) return <span className="quota-empty" title={observation?.detail ?? undefined}>
    {!account.observed ? '—' : !observation ? '待确认账号' : observation.state === 'reauth' ? '待重新登录'
      : observation.state === 'unreachable' ? '读取失败' : observation.quota ? '未返回额度' : '待刷新'}
  </span>;
  const stale = observation !== null && quotaStale(observation, now);
  return <div className={`quota-meter ${compact ? 'quota-compact' : 'quota-full'} ${stale ? 'quota-stale' : ''}`}>
    {windows.map((window, index) => {
      const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
      const label = duration(window.durationMinutes, index, false);
      const reset = until(window.resetsAt, now, compact);
      return <div className="quota-line" key={index}
        title={`${label} · 剩余 ${remaining}%${window.resetsAt ? ` · 重置 ${formatDate(window.resetsAt, true)}` : ''}`}>
        <span className="quota-duration">{duration(window.durationMinutes, index, compact)}</span>
        <progress className={remaining <= 10 ? 'quota-low' : remaining <= 25 ? 'quota-warm' : ''}
          aria-label={`${label}剩余 ${remaining}%`} max={100} value={remaining}/>
        <strong>{remaining}%</strong>
        <span className="quota-reset">{!compact && window.resetsAt && window.resetsAt > now ? reset + '后重置' : reset}</span>
      </div>;
    })}
    {stale && <small className="quota-history">上次记录</small>}
  </div>;
}

export function ResetCard({account, now}: {account: Account; now: number}) {
  const observation = activeObservation(account);
  const quota = observation?.quota;
  const count = quota?.resetCards;
  if (!observation || !quota || typeof count !== 'number' || count <= 0) return null;
  const description = cardsStale(observation, now) ? '上次记录 · 刷新后确认'
    : quota.nextCardExpiry && quota.nextCardExpiry > now ? `最近到期 ${formatDate(quota.nextCardExpiry, true)}`
    : '可用重置卡';
  return <section className="reset-card reset-card-gold" aria-label="重置卡">
    <span className="reset-card-icon"><Ticket size={22} strokeWidth={1.7}/></span>
    <div><h4>重置卡</h4><p>{description}</p></div>
    <strong className="reset-card-count">{count}<small>张</small></strong>
  </section>;
}
