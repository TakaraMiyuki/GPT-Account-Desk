import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, ClipboardCheck,
  ChartNoAxesCombined, ChartCandlestick, ClipboardPaste, GripVertical, Hourglass, KeyRound, ListFilter, LockKeyhole, Plus, RefreshCw, Search, Settings2, ShieldCheck, Users, X,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Account, AccountInput, Availability, availabilityLabels, Changed, Code, connectionState, effectiveStatus, ImportResult, localDay, LoginStage,
  needsAttention, needsReview, planGroup, plans, rebindLabels, Saved, seconds, Snapshot, Unlocked,
} from './domain';
import { QuickImport } from './quick-import';
import { AccountAvatar, QuotaMeter } from './quota-ui';
import { useRowReorder } from './reorder';
import { UsageView } from './usage-view';
import { PriceView } from './price-view';
import { Brand, Button, ConnectionPill, Detail, Editor, Gate, Modal, NoticeContext, PlanPill, RebindPill, SettingsView, StatusPill } from './ui';
import './style.css';

const desktop = isTauri();
type Page = 'accounts' | 'review' | 'usage' | 'prices' | 'settings';
type Notice = {text: string; error?: boolean};
type PendingLogin = {attempt: string; account: string; stage: LoginStage | null};
const strings: Record<Page, {title: string; subtitle: string}> = {
  accounts: {title: '账号枢纽', subtitle: '集中整理 ChatGPT 账号、登录凭据与核验记录。'},
  review: {title: '待复核', subtitle: '查看需要确认状态、续费或改绑的账号。'},
  usage: {title: '用量统计', subtitle: '按时间、账号和模型查看 Codex 用量。'},
  prices: {title: '价格监控', subtitle: '追踪 PriceAI 的 ChatGPT Plus 报价和库存。'},
  settings: {title: '设置与备份', subtitle: '管理加密库、Codex 连接和账号备份。'},
};
const errText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

function App() {
  const [book, setBook] = useState<Snapshot | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [page, setPage] = useState<Page>('accounts');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState('');
  const [availability, setAvailability] = useState('');
  const [rebind, setRebind] = useState('');
  const [tag, setTag] = useState('');
  const [connection, setConnection] = useState('');
  const [extraFilters, setExtraFilters] = useState(false);
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'remove' | 'disconnect' | 'restore' | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [privateWindow, setPrivateWindow] = useState(true);
  const [login, setLogin] = useState<PendingLogin | null>(null);
  const busyRef = useRef('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gateError, setGateError] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const currentPhase = useRef<Snapshot['phase'] | null>(null);
  currentPhase.current = book?.phase ?? null;

  function clearFilters() {
    setQuery(''); setPlan(''); setAvailability(''); setRebind(''); setTag(''); setConnection(''); setExtraFilters(false);
  }

  function resetView() {
    setPage('accounts'); clearFilters(); setSelected(new Set()); setActiveId(null);
    setEditing(null); setImportOpen(false); setConfirmation(null); setBackupPassword(''); setNotice(null); setGateError('');
  }

  function applySnapshot(snapshot: Snapshot) {
    if (snapshot.phase !== 'unlocked' && currentPhase.current !== snapshot.phase) {
      epoch.current += 1;
      resetView();
    }
    currentPhase.current = snapshot.phase;
    setBook(snapshot);
  }

  useEffect(() => {
    if (!desktop) { setGateError('请在 Windows 桌面应用中打开账号簿。'); return; }
    let alive = true;
    invoke<Snapshot>('snapshot').then(snapshot => { if (alive) setBook(snapshot); })
      .catch(reason => { if (alive) setGateError(errText(reason)); });
    const subscription = listen('vault-locked', () => {
      invoke<Snapshot>('snapshot').then(snapshot => { if (alive) applySnapshot(snapshot); }).catch(() => {});
    });
    return () => { alive = false; void subscription.then(unlisten => unlisten()); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 7000 : 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!desktop || book?.phase !== 'unlocked') return;
    let alive = true;
    let last = 0;
    const check = () => {
      const now = Date.now();
      if (now - last > 1000) {
        last = now;
        invoke('keep_active').catch(() => invoke<Snapshot>('snapshot').then(state => { if (alive) applySnapshot(state); }).catch(() => {}));
      }
    };
    for (const event of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(event, check, {passive: true});
    return () => { alive = false; for (const event of ['keydown', 'pointerdown', 'wheel']) window.removeEventListener(event, check); };
  }, [book?.phase]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && search.current && !activeId && !editing && !confirmation && !importOpen) {
        event.preventDefault();
        search.current.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [activeId, editing, confirmation, importOpen]);

  function go(next: Page) {
    setPage(next); setSelected(new Set()); setActiveId(null); setEditing(null); clearFilters();
  }

  async function perform<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return;
    busyRef.current = key; setBusy(key);
    const startedAt = epoch.current;
    try {
      const result = await action();
      if (startedAt === epoch.current) return result;
    } finally {
      busyRef.current = ''; setBusy('');
    }
  }

  async function run<T>(key: string, action: () => Promise<T>, success: (value: T) => void, quiet = false) {
    const startedAt = epoch.current;
    try {
      const result = await perform(key, action);
      if (result !== undefined) success(result);
    } catch (reason) {
      if (startedAt !== epoch.current) return;
      if (!quiet) setNotice({text: errText(reason), error: true});
      if (String(reason).includes('已锁定')) {
        invoke<Snapshot>('snapshot').then(applySnapshot).catch(() => {});
      }
    }
  }

  async function unlock(password: string, remember: boolean) {
    setGateError('');
    try {
      const result = await perform('unlock', () => invoke<Changed>('unlock', {password, remember, create: book?.phase === 'new'}));
      if (!result) return false;
      applySnapshot(result.snapshot);
      if (result.warning) setNotice({text: result.warning, error: true});
      return result.snapshot.phase === 'unlocked';
    } catch (reason) { setGateError(errText(reason)); return false; }
  }

  async function unlockDevice() {
    setGateError('');
    try {
      const result = await perform('unlock-device', () => invoke<Snapshot>('unlock_device'));
      if (result) applySnapshot(result);
    } catch (reason) { setGateError(errText(reason)); }
  }

  async function lock() {
    try { applySnapshot(await invoke<Snapshot>('lock')); } catch (reason) { setNotice({text: errText(reason), error: true}); }
  }

  const current = book?.phase === 'unlocked' ? book : null;
  const accounts = current?.accounts ?? [];
  const active = accounts.find(account => account.id === activeId) ?? null;
  const editingAccount = accounts.find(account => account.id === editing) ?? null;
  const attention = current ? accounts.filter(row => needsAttention(row, current.settings.reviewDays)) : [];
  const totalLinked = accounts.filter(row => row.observed).length;
  const [quotaNow, setQuotaNow] = useState(seconds);
  useEffect(() => {
    if (!totalLinked) return;
    setQuotaNow(seconds());
    const timer = setInterval(() => setQuotaNow(seconds()), 30_000);
    return () => clearInterval(timer);
  }, [!!totalLinked]);
  const refreshMinutes = current?.settings.autoRefreshMinutes || 5;
  const installReady = Boolean(current?.codexPath);
  const tags = Array.from(new Set(accounts.flatMap(row => row.tags))).sort((a, b) => a.localeCompare(b, 'zh-CN'));

  async function refresh(ids?: string[], automatic = false) {
    if (!installReady) {
      if (!automatic) setNotice({text: '请先在设置与备份中选择 Codex CLI。', error: true});
      return;
    }
    if (refreshingRef.current || busyRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const started = epoch.current;
    try {
      const result = await invoke<Snapshot>('refresh_accounts', {ids: ids ?? null, automatic});
      if (started !== epoch.current || result.phase !== 'unlocked') return;
      const observations = new Map(result.accounts.map(row => [row.id, row]));
      setBook(latest => latest?.phase !== 'unlocked' ? latest : {...latest, accounts: latest.accounts.map(row => {
        const updated = observations.get(row.id);
        return updated?.linkProfile && row.linkProfile === updated.linkProfile && updated.observed &&
          row.observed && updated.observed.checkedAt >= row.observed.checkedAt
          ? {...row, observed: updated.observed} : row;
      })});
      setQuotaNow(seconds());
      if (!automatic) setNotice({text: 'Codex 刷新完成，可在详情查看结果。'});
    } catch (reason) {
      if (!automatic && started === epoch.current) setNotice({text: errText(reason), error: true});
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  const refreshDue = useRef(() => {});
  refreshDue.current = () => {
    const now = seconds();
    const due = accounts.filter(row => {
      const observation = row.observed;
      if (!observation || observation.state === 'reauth' || observation.state === 'identityMismatch') return false;
      const age = now - observation.checkedAt;
      return age >= refreshMinutes * 60 ||
        (!observation.quota && observation.state === 'connected') ||
        (age >= 60 && !!observation.quota?.windows.some(window => window.resetsAt &&
          window.resetsAt > (observation.onlineVerifiedAt ?? 0) && window.resetsAt <= now));
    }).map(row => row.id);
    if (due.length) void refresh(due, true);
  };

  useEffect(() => {
    if (!current || !totalLinked || !installReady) return;
    const check = () => refreshDue.current();
    const initial = window.setTimeout(check, 350);
    const timer = window.setInterval(check, 15_000);
    window.addEventListener('focus', check);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [!!current, !!totalLinked, installReady]);

  const displayRows = useMemo(() => {
    if (!current || page === 'settings' || page === 'usage' || page === 'prices') return [];
    const needle = query.trim().toLocaleLowerCase();
    const rows = current.accounts.filter(row => {
      if (page === 'review' && !needsAttention(row, current.settings.reviewDays)) return false;
      if (plan && plan !== planGroup(row)) return false;
      if (availability && availability !== effectiveStatus(row, quotaNow).availability) return false;
      if (rebind && rebind !== row.rebind) return false;
      if (tag && !row.tags.includes(tag)) return false;
      if (connection && connection !== (connectionState(row) ?? 'unlinked')) return false;
      return !needle || [row.number, row.email, row.previousEmail, row.notes, ...row.tags]
        .some(text => text.toLocaleLowerCase().includes(needle));
    });
    if (current.manualOrder) return rows;
    return rows.sort((a, b) => a.number.localeCompare(b.number, 'zh-CN', {numeric: true}) * (descending ? -1 : 1));
  }, [current, page, query, plan, availability, rebind, tag, connection, descending, quotaNow]);

  const selectedShown = displayRows.filter(row => selected.has(row.id)).length;
  const allChecked = displayRows.length > 0 && selectedShown === displayRows.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedShown > 0 && !allChecked; }, [selectedShown, allChecked]);

  function toggle(id: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(previous => {
      const next = new Set(previous);
      displayRows.forEach(row => { if (allChecked) next.delete(row.id); else next.add(row.id); });
      return next;
    });
  }

  const hasFilters = !!(query.trim() || plan || availability || rebind || tag || connection);
  const orderable = page === 'accounts' && !hasFilters && displayRows.length >= 2;
  const canReorder = orderable && !busy;
  function reorder(id: string, target: {id: string; after: boolean}) {
    if (!canReorder || id === target.id) return;
    const ids = displayRows.map(row => row.id);
    ids.splice(ids.indexOf(id), 1);
    const destination = ids.indexOf(target.id);
    if (destination < 0) return;
    ids.splice(destination + (target.after ? 1 : 0), 0, id);
    if (ids.every((key, index) => key === displayRows[index].id)) return;
    void run('reorder', () => invoke<Snapshot>('reorder_accounts', {ids}), applySnapshot);
  }
  const {hold, drag, blocksClick} = useRowReorder(canReorder, reorder);

  function setOrder(manual: boolean) {
    setDescending(false);
    if (manual === current?.manualOrder) return;
    void run('order', () => invoke<Snapshot>('set_order_mode', {manual}), applySnapshot);
  }

  async function quickImport(input: string, commit: boolean) {
    const result = await perform('import', () => invoke<ImportResult>('import_accounts', {input, commit}));
    if (commit && result?.snapshot) {
      applySnapshot(result.snapshot);
      if (result.count) {
        setImportOpen(false);
        clearFilters();
        setNotice({text: `已导入 ${result.count} 条账号${result.issues.length ? `，跳过 ${result.issues.length} 条` : ''}。`});
      }
    }
    return result;
  }

  async function save(input: AccountInput) {
    if (!current) return;
    const result = await perform('save', () => invoke<Saved>('save_account', {account: input}));
    if (!result) return;
    setBook(result.snapshot); setEditing(null); setActiveId(result.id); setNotice({text: '账号已保存。'});
  }

  function mark(ids: string[], status: Availability) {
    if (!ids.length || !current) return;
    void run('mark', () => invoke<Unlocked>('mark_accounts', {ids, availability: status}), result => {
      setBook(result); setSelected(new Set()); setNotice({text: '已更新 ' + ids.length + ' 条账号的人工状态。'});
    });
  }

  async function copy(id: string, kind: string) {
    try {
      await invoke('copy_credential', {id, kind});
      setNotice({text: '已复制，稍后会清理本次复制的内容。'});
    } catch (reason) { setNotice({text: errText(reason), error: true}); }
  }

  function readCode(id: string): Promise<Code> {
    return invoke('read_totp', {id});
  }

  function updateChanged(result: Changed, message: string) {
    applySnapshot(result.snapshot);
    setNotice({text: result.warning ?? message, error: !!result.warning});
  }

  const loginId = login?.attempt;

  useEffect(() => {
    if (!loginId) return;
    let active = true;
    let timer = 0;
    async function poll() {
      try {
        const stage = await invoke<LoginStage | null>('codex_login_stage', {attempt: loginId});
        if (active && stage) setLogin(current =>
          current && current.attempt === loginId && current.stage !== stage && current.stage !== 'cancelling' ? {...current, stage} : current);
      } catch {
        // The connect request reports terminal errors itself.
      } finally {
        if (active) timer = window.setTimeout(poll, 200);
      }
    }
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [loginId]);

  function connect(account: Account) {
    if (!installReady) { setNotice({text: '请先在设置与备份中选择 Codex CLI。', error: true}); return; }
    if (busyRef.current) return;
    const attempt = crypto.randomUUID();
    setLogin({attempt, account: account.id, stage: null});
    void run('connect', () => invoke<Changed & {cancelled: boolean}>('connect_codex', {
      id: account.id, attempt, privateWindow,
    }), result => {
      setQuotaNow(seconds());
      updateChanged(result, result.cancelled ? '已取消 Codex 登录。' : '已绑定 Codex 账号，请查看额度与连接状态。');
    }).finally(() => setLogin(current => current?.attempt === attempt ? null : current));
  }

  async function cancelLogin() {
    if (!login?.stage || login.stage === 'cancelling' || login.stage === 'committing') return;
    const attempt = login.attempt;
    try {
      const accepted = await invoke<boolean>('cancel_codex_login', {attempt});
      if (accepted) setLogin(current => current?.attempt === attempt ? {...current, stage: 'cancelling'} : current);
    } catch (reason) { setNotice({text: errText(reason), error: true}); }
  }

  async function copyLoginLink() {
    if (!login) return;
    try {
      await invoke('copy_codex_login_url', {attempt: login.attempt});
      setNotice({text: privateWindow ? '授权链接已复制，请粘贴到无痕窗口。' : '授权链接已复制。'});
    } catch (reason) { setNotice({text: errText(reason), error: true}); }
  }

  function restore(event: FormEvent) {
    event.preventDefault();
    const password = backupPassword;
    setBackupPassword('');
    setConfirmation(null);
    void run('restore', () => invoke<Snapshot | null>('restore_backup', {password}), result => {
      if (result) { resetView(); applySnapshot(result); setNotice({text: '加密备份已恢复。'}); }
    });
  }

  function confirmAction() {
    const action = confirmation;
    const account = active;
    const data = current;
    if (!action || !account || !data) return;
    setConfirmation(null);
    if (action === 'remove') {
      void run('remove', () => invoke<Changed>('remove_account', {id: account.id}), result => {
        setActiveId(null); setSelected(previous => new Set([...previous].filter(id => id !== account.id)));
        updateChanged(result, '账号记录已删除。');
      });
    }
    if (action === 'disconnect') {
      void run('disconnect', () => invoke<Snapshot>('disconnect_codex', {id: account.id}), result => {
        applySnapshot(result); setNotice({text: 'Codex 连接已断开。'});
      });
    }
  }

  const alert = notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>
    {notice.error ? <CircleAlert size={18}/> : <Check size={18}/>} <span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16}/></button>
  </div>;
  const restoreModal = confirmation === 'restore' && <Modal title="恢复加密备份" close={() => { setConfirmation(null); setBackupPassword(''); }}>
    <form onSubmit={restore}>
      <div className="modal-body small-modal-body"><p>{current ? '恢复会替换当前台账。请输入备份创建时使用的主密码，然后选择备份文件。' : '输入备份创建时使用的主密码，然后选择备份文件。'}</p>
        <label className="field"><span>备份主密码</span><input autoFocus type="password" required maxLength={1024} autoComplete="off"
          value={backupPassword} onChange={event => setBackupPassword(event.target.value)}/></label>
      </div><div className="modal-footer"><Button onClick={() => { setConfirmation(null); setBackupPassword(''); }}>取消</Button><Button type="submit" kind="primary">选择备份文件</Button></div>
    </form>
  </Modal>;

  if (!book) return <p className="loading" role="status">{gateError || '正在打开账号簿…'}</p>;
  if (!current) return <NoticeContext.Provider value={alert}><Gate key={book.phase} create={book.phase === 'new'} working={!!busy} error={gateError} onUnlock={unlock}
    trusted={book.deviceTrusted} onDevice={() => void unlockDevice()} onRestore={() => setConfirmation('restore')}/>{restoreModal}{alert}</NoticeContext.Provider>;

  const countAvailable = accounts.filter(row => effectiveStatus(row, quotaNow).availability === 'available').length;
  const countPaid = accounts.filter(row => ['go', 'plus', 'pro', 'business', 'enterprise', 'edu'].includes(planGroup(row))).length;
  let nextNumber = 1;
  while (accounts.some(row => row.number.toUpperCase() === 'GPT-' + String(nextNumber).padStart(3, '0'))) nextNumber += 1;
  const suggested = 'GPT-' + String(nextNumber).padStart(3, '0');
  const stats = [
    {label: '全部账号', count: accounts.length, icon: Users, tone: 'green', action: () => go('accounts')},
    {label: '可用账号', count: countAvailable, icon: ShieldCheck, tone: 'green', action: () => {go('accounts'); setAvailability('available');}},
    {label: '付费套餐', count: countPaid, icon: KeyRound, tone: 'blue'},
    {label: '待复核', count: attention.length, icon: Hourglass, tone: 'gold', action: () => go('review')},
  ];

  return <NoticeContext.Provider value={alert}><div className="shell">
    <aside className="rail">
      <div className="rail-top"><Brand/></div>
      <nav aria-label="主要导航" className="nav-list">
        <button type="button" className={page === 'accounts' ? 'nav-active' : ''} aria-current={page === 'accounts' ? 'page' : undefined}
          onClick={() => go('accounts')}><BookOpen size={18}/> 账号枢纽</button>
        <button type="button" className={page === 'review' ? 'nav-active' : ''} aria-current={page === 'review' ? 'page' : undefined}
          onClick={() => go('review')}><ClipboardCheck size={18}/> 待复核 {attention.length > 0 && <span className="nav-count">{attention.length}</span>}</button>
        <button type="button" className={page === 'usage' ? 'nav-active' : ''} aria-current={page === 'usage' ? 'page' : undefined}
          onClick={() => go('usage')}><ChartNoAxesCombined size={18}/> 用量统计</button>
        <button type="button" className={page === 'prices' ? 'nav-active' : ''} aria-current={page === 'prices' ? 'page' : undefined}
          onClick={() => go('prices')}><ChartCandlestick size={18}/> 价格监控</button>
        <button type="button" className={page === 'settings' ? 'nav-active' : ''} aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => go('settings')}><Settings2 size={18}/> 设置与备份</button>
      </nav>
      <div className="rail-bottom">
        <div className="local-card"><div className="local-icon"><ShieldCheck size={17}/></div><div>
          <strong>本地加密库</strong><span>账号资料保存在此设备</span></div></div>
        <button type="button" className="rail-exit" onClick={() => void lock()}><LockKeyhole size={16}/> 锁定账号库</button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumbs"><span>工作台</span><ChevronRight size={14}/><strong>{strings[page].title}</strong></div>
        <div className="topbar-right"><span className="local-badge"><i/> 已解锁</span>
        <Button title="锁定账号库" className="icon-button" aria-label="锁定" onClick={() => void lock()}><LockKeyhole size={16}/></Button></div></header>
      <main className="main-content">
        <section className={`hero hero-${page}`}>
          <div className="hero-copy"><h1>{strings[page].title}</h1><p>{strings[page].subtitle}</p>
            {page === 'accounts' && <div className="hero-actions">
              <Button kind="primary" className="hero-button" onClick={() => setEditing('new')}><Plus size={18}/> 新增账号</Button>
              {page === 'accounts' && <Button className="hero-import" onClick={() => setImportOpen(true)}><ClipboardPaste size={17}/> 快速导入</Button>}
            </div>}</div>
          <div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/>
            <div className="art-orbit orbit-three"/><div className="art-card art-card-back"/><div className="art-card art-card-front">
              <div className="art-key"><KeyRound size={25} strokeWidth={1.45}/></div><div className="art-lines"><i/><i/><i/></div></div>
            <i className="art-star star-one"/><i className="art-star star-two"/><i className="art-star star-three"/></div>
        </section>

        {page === 'accounts' && <section aria-label="账号概览" className="stats-grid">
          {stats.map(({label, count, icon: Icon, tone, action}) => {
            const contents = <><div className={`stat-icon stat-${tone}`}><Icon size={18} strokeWidth={1.9}/></div>
              <div className="stat-copy"><span>{label}</span><strong>{count}</strong></div>{action && <ArrowRight size={15} className="stat-arrow"/>}</>;
            return action ? <button type="button" key={label} className="stat-card stat-button" onClick={action}>{contents}</button>
              : <div key={label} className="stat-card">{contents}</div>;
          })}
        </section>}

        {page === 'usage' ? <UsageView book={current} busy={busy}
          addSource={(account, useDefault) => run<Snapshot | null>('add-usage-source', () => invoke('add_usage_source', {account, useDefault}), result => {
            if (result) applySnapshot(result);
          })}
          assignSource={(id, account) => run<Snapshot>('assign-usage-source', () => invoke('assign_usage_source', {id, account}), applySnapshot)}
          removeSource={id => run<Snapshot>('remove-usage-source', () => invoke('remove_usage_source', {id}), applySnapshot)}/>
        : page === 'prices' ? <PriceView/> : page === 'settings' ? <SettingsView book={current} busy={busy}
          onSave={settings => run<Unlocked>('settings', () => invoke('save_settings', {settings}),
            result => {setBook(result); setNotice({text: '设置已保存。'});})}
          choose={() => void run('choose', () => invoke<Unlocked | null>('choose_codex'), result => { if (result) { setBook(result); setNotice({text: 'Codex CLI 路径已保存。'}); } })}
          discover={() => void run('discover', () => invoke<Snapshot>('discover_codex'), result => { applySnapshot(result); setNotice({text: '已找到 Codex CLI。'}); })}
          trust={trusted => void run('trust', () => invoke<Snapshot>('trust_device', {trusted}), result => {
            applySnapshot(result); setNotice({text: trusted ? '已信任此设备。' : '已撤销此设备的信任。'});
          })}
          exportBackup={() => void run('export', () => invoke<boolean>('export_backup'), result => { if (result) setNotice({text: '加密备份已导出。'}); })}
          restore={() => setConfirmation('restore')}/> : <section className="table-card" aria-label={page === 'review' ? '待复核列表' : '账号列表'}>
          <header className="table-heading"><div><h2>{page === 'review' ? '待处理账号' : '账号列表'} <span>{displayRows.length}</span></h2>
            <p>{page === 'review' ? '包含到期未核验和 7 天内续费（含已过期）的记录。' : hasFilters ? '清除筛选后可拖动排序。' : '长按账号行可上下拖动排序。'}</p></div>
            <Button onClick={() => refresh()} disabled={!totalLinked || !!busy || refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/>
              {refreshing ? '检查中…' : '刷新 Codex'}</Button></header>
          <div className="toolbar">
            <div className="search-box"><Search size={17}/><input ref={search} aria-label="搜索账号" placeholder="搜索邮箱、编号或标签" value={query}
              onChange={event => setQuery(event.target.value)}/>{query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15}/></button>
                : <kbd>Ctrl F</kbd>}</div>
            <Filter label="套餐" value={plan} onChange={setPlan} options={plans}/>
            <Filter label="状态" value={availability} onChange={setAvailability} options={availabilityLabels}/>
            <Filter label="改绑" value={rebind} onChange={setRebind} options={rebindLabels}/>
            <Button className={extraFilters ? 'filter-active' : ''} aria-expanded={extraFilters} onClick={() => setExtraFilters(!extraFilters)}><ListFilter size={16}/> 更多筛选</Button>
            {hasFilters && <Button kind="ghost" onClick={clearFilters}>清除</Button>}
            {page === 'accounts' && <label className="filter-select order-control"><span className="sr-only">排序方式</span>
              <select aria-label="排序方式" disabled={!!busy} value={current.manualOrder ? 'manual' : 'number'} onChange={event => setOrder(event.target.value === 'manual')}>
                <option value="number">按账号编号</option><option value="manual" disabled={!current.hasCustomOrder}>自定义顺序</option>
              </select><ChevronDown size={13}/></label>}
          </div>
          {extraFilters && <div className="toolbar toolbar-extra">
            <Filter label="标签" value={tag} onChange={setTag} options={Object.fromEntries(tags.map(tagLabel => [tagLabel, tagLabel]))}/>
            <Filter label="Codex 连接" value={connection} onChange={setConnection} options={{
              connected: '已连接', reauth: '需重新登录', unreachable: '检查失败', identityMismatch: '账号待确认', unlinked: '未连接',
            }}/></div>}
          {selected.size > 0 && <div className="bulk-bar"><strong>已选 {selected.size} 个账号</strong>
            <Button disabled={!!busy} onClick={() => mark([...selected], 'available')}><Check size={15}/> 确认可用</Button>
            <Button disabled={!!busy} onClick={() => mark([...selected], 'unavailable')}>标记不可用</Button>
            <Button disabled={!!busy} onClick={() => mark([...selected], 'unchecked')}>标记待核验</Button>
            <Button kind="ghost" onClick={() => setSelected(new Set())}>取消选择</Button></div>}
          <div className="table-scroller"><table>
            <thead><tr><th className="check-col"><input ref={selectAll} type="checkbox" aria-label="选择当前列表所有账号" checked={allChecked} disabled={!displayRows.length} onChange={toggleAll}/></th>
              <th><button type="button" className="sort-button" aria-label="按账号编号排序" onClick={() => current.manualOrder ? setOrder(false) : setDescending(!descending)}>账号 {!current.manualOrder && (descending ? <ArrowDown size={13}/> : <ArrowUp size={13}/>)}</button></th>
              <th>套餐</th><th>可用状态</th><th>邮箱改绑</th><th>Codex 连接</th><th className="quota-column">额度监控</th><th className="detail-col"><span className="sr-only">详情</span></th></tr></thead>
            <tbody className={drag ? 'dragging-rows' : ''}>{displayRows.map((row, index) => <tr data-row={row.id} key={row.id}
              onPointerDown={event => hold(event, row.id)}
              className={[selected.has(row.id) ? 'selected-row' : '', drag?.from === row.id ? 'dragging-row' : '',
                drag?.target?.id === row.id && drag.from !== row.id ? drag.target.after ? 'drop-after' : 'drop-before' : ''].join(' ')}>
              <td className="check-col"><input type="checkbox" aria-label={`选择 ${row.number}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)}/></td>
              <td className="identity-col"><div className="identity-actions">
                {orderable && <button type="button" className="drag-grip" aria-disabled={!canReorder} title="长按拖动，或使用上下方向键" aria-label={`移动 ${row.number}`}
                  onKeyDown={event => {
                    const offset = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                    const target = displayRows[index + offset];
                    if (offset && target) { event.preventDefault(); reorder(row.id, {id: target.id, after: offset > 0}); }
                  }}><GripVertical size={15}/></button>}
                <button type="button" className="identity-button" title={`查看 ${row.email}`} onClick={() => { if (!blocksClick(row.id)) setActiveId(row.id); }}>
                <AccountAvatar account={row}/>
                <span className="table-id"><strong>{row.email}</strong><small>{row.number}{row.tags[0] ? ' · ' + row.tags[0] : ''}</small></span></button></div></td>
              <td><PlanPill account={row}/></td><td><StatusPill account={row} now={quotaNow}/></td><td><RebindPill account={row}/></td>
              <td><ConnectionPill account={row}/></td><td className="quota-column"><QuotaMeter account={row} now={quotaNow} compact/>
                {page === 'review' && <small className="review-reason">{needsReview(row, current.settings.reviewDays) ? '需核验' : row.renewalDate < localDay() ? '续费已过期' : '临近续费日'}</small>}</td>
              <td className="detail-col"><button type="button" aria-label={`查看 ${row.number} 详情`} onClick={() => setActiveId(row.id)}><ChevronRight size={17}/></button></td></tr>)}</tbody>
          </table></div>
          {!displayRows.length && <div className="empty"><div className="section-icon">{hasFilters ? <Search size={22}/> : <BookOpen size={22}/>}</div>
            <h3>{hasFilters ? '没有符合筛选的账号' : page === 'review' ? '目前没有待复核的账号' : '还没有账号记录'}</h3>
            {hasFilters ? <Button onClick={clearFilters}>清除筛选</Button> : page === 'accounts'
              ? <Button kind="primary" onClick={() => setEditing('new')}><Plus size={17}/> 新增账号</Button>
              : <Button onClick={() => go('accounts')}>查看全部账号</Button>}</div>}
          <footer className="table-footer"><span>显示 {displayRows.length} / {page === 'review' ? attention.length : accounts.length} 条</span>
            <span><ShieldCheck size={14}/> 本地存储</span></footer>
        </section>}
      </main>
    </div>

    {active && editing === null && !confirmation && <Detail key={active.id} account={active}
      close={() => { if (login?.account === active.id) void cancelLogin(); else setActiveId(null); }} edit={() => setEditing(active.id)} mark={status => mark([active.id], status)}
      remove={() => setConfirmation('remove')} copy={kind => void copy(active.id, kind)}
      reveal={() => invoke('reveal_password', {id: active.id})}
      code={() => readCode(active.id)} connect={() => connect(active)} disconnect={() => setConfirmation('disconnect')}
      privateWindow={privateWindow} setPrivateWindow={setPrivateWindow}
      loginStage={login?.account === active.id ? login.stage : null} cancelLogin={() => void cancelLogin()} copyLoginLink={() => void copyLoginLink()}
      refresh={() => refresh([active.id])} jumpSettings={() => go('settings')} busy={busy} refreshing={refreshing} codexReady={installReady} quotaNow={quotaNow}/>}
    {importOpen && <QuickImport busy={!!busy} close={() => setImportOpen(false)}
      inspect={input => quickImport(input, false)} commit={input => quickImport(input, true)}/>}
    {editing !== null && <Editor key={editing} account={editingAccount} suggested={suggested} onSave={save} onClose={() => setEditing(null)} busy={!!busy}/>}
    {(confirmation === 'remove' || confirmation === 'disconnect') && active && <Modal title={confirmation === 'remove' ? '删除账号' : '断开 Codex'} close={() => setConfirmation(null)}>
      <div className="modal-body small-modal-body"><p>{confirmation === 'remove' ? '将永久删除以下账号记录及已保存的凭据。' : '断开后，此账号将停止 Codex 状态检查。'}</p>
        <strong className="confirm-email">{active.email}</strong></div>
      <div className="modal-footer"><Button onClick={() => setConfirmation(null)}>取消</Button>
        <Button kind="danger" onClick={confirmAction}>{confirmation === 'remove' ? '删除账号' : '断开连接'}</Button></div>
    </Modal>}
    {restoreModal}{alert}
  </div></NoticeContext.Provider>;
}

function Filter({label, value, options, onChange}: {label: string; value: string; options: Record<string, string>; onChange: (value: string) => void}) {
  return <label className={`filter-select ${value ? 'filter-active' : ''}`}><span className="sr-only">{label}筛选</span>
    <select aria-label={label + '筛选'} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{label}</option>{Object.entries(options).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select><ChevronDown size={13}/></label>;
}

createRoot(document.getElementById('root')!).render(<App/>);
