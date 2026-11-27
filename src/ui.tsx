import {
  ArchiveRestore, ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronDown, CircleAlert, Clipboard,
  Code2, Eye, EyeOff, Fingerprint, KeyRound, Link2, LockKeyhole, Plus, RefreshCw, ShieldCheck,
  Trash2, Unlink, X,
} from 'lucide-react';
import { createContext, FormEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import {
  Account, AccountInput, availabilityLabels, Code, connectionLabels, connectionState, detectedPlan, effectiveStatus, factorLabels, formatDate, LoginStage,
  planGroup, planName, plans, rebindLabels, seconds, Settings, Unlocked,
} from './domain';
import { AccountAvatar, QuotaMeter, ResetCard } from './quota-ui';

export function Brand() {
  return <div className="brand"><div className="brand-symbol"><BookOpen size={23} strokeWidth={1.8} /></div>
    <div><strong>账号簿</strong><span>Account Desk</span></div></div>;
}

export function Button({children, kind = 'secondary', className = '', ...props}:
  React.ButtonHTMLAttributes<HTMLButtonElement> & {kind?: 'primary' | 'secondary' | 'ghost' | 'danger'; children: ReactNode}) {
  return <button type="button" {...props} className={`button button-${kind} ${className}`}>{children}</button>;
}

export function Pill({tone = 'neutral', children, dot = false, title}: {tone?: string; children: ReactNode; dot?: boolean; title?: string}) {
  return <span className={`pill tone-${tone}`} title={title}>{dot && <i />}{children}</span>;
}

export function PlanPill({account}: {account: Account}) {
  const detected = detectedPlan(account);
  const group = planGroup(account);
  return <Pill tone={group === 'pro' ? 'purple' : group === 'plus' ? 'blue' : 'neutral'}
    title={detected ? 'Codex 检测到的套餐' : '手填套餐'}>{detected ? planName(detected) : plans[account.plan]}</Pill>;
}

export function StatusPill({account, now}: {account: Account; now: number}) {
  const status = effectiveStatus(account, now);
  return <Pill dot tone={status.tone} title={account.observed ? 'Codex 核验状态' : '手动状态'}>{status.label}</Pill>;
}

export function RebindPill({account}: {account: Account}) {
  return <Pill tone={account.rebind === 'native' ? 'blue' : account.rebind === 'changed' ? 'good' : 'neutral'}>{rebindLabels[account.rebind]}</Pill>;
}

export function ConnectionPill({account}: {account: Account}) {
  const status = connectionState(account);
  if (!status) return <span className="plain-indicator"><i />未连接</span>;
  const tone = status === 'connected' ? 'good' : status === 'unreachable' ? 'bad' : 'warm';
  return <span className={`plain-indicator text-${tone}`}><i />{connectionLabels[status]}</span>;
}

export const NoticeContext = createContext<ReactNode>(null);

export function Modal({title, children, close, variant = ''}: {
  title: string; children: ReactNode; close: () => void; variant?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const activeNotice = useContext(NoticeContext);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className={`modal ${variant}`} aria-label={title}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-frame">
      <div className="modal-heading"><h2>{title}</h2><Button kind="ghost" className="icon-button" aria-label="关闭" onClick={close}><X size={19}/></Button></div>
      {children}
    </div>
    {activeNotice}
  </dialog>;
}

export function SelectField<T extends string>({label, value, options, onChange}: {
  label: string; value: T; options: Record<T, string>; onChange: (value: T) => void;
}) {
  return <label className="field"><span>{label}</span><span className="select-wrap">
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value as T)}>
      {Object.entries(options).map(([id, name]) => <option key={id} value={id}>{String(name)}</option>)}
    </select><ChevronDown size={14}/></span></label>;
}

export function Gate({create, working, error, trusted, onUnlock, onDevice, onRestore}: {
  create: boolean; working: boolean; error: string; trusted: boolean; onUnlock: (password: string, remember: boolean) => Promise<boolean>; onDevice: () => void; onRestore: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(trusted);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (create && password !== confirm) {
      setFormError('两次输入的主密码不一致。');
      return;
    }
    setFormError('');
    if (await onUnlock(password, remember)) { setPassword(''); setConfirm(''); }
  }
  return <main className="gate">
    <div className="gate-illustration"><Brand/><div className="gate-caption"><span className="gate-chip"><ShieldCheck size={15}/> 本地加密</span>
      <p>ChatGPT<br/>账号管理</p><span>账号资料、登录凭据与核验记录</span></div>
      <div className="gate-rings" aria-hidden="true"><div/><div/><div/><div/></div>
    </div>
    <div className="gate-content"><div className="gate-form">
      <div className="section-icon"><LockKeyhole size={22}/></div><h1>{create ? '创建账号库' : '解锁账号库'}</h1>
      <p>{create ? '设置主密码，加密保存在这台电脑上的账号资料。' : '输入主密码，查看保存在这台电脑上的账号资料。'}</p>
      <form onSubmit={submit} autoComplete="off">
        <label className="field"><span>主密码</span><span className="field-with-icon">
          <input autoFocus required type={show ? 'text' : 'password'} value={password} maxLength={1024}
            autoComplete={create ? 'new-password' : 'current-password'} onChange={event => { setPassword(event.target.value); setFormError(''); }}
            placeholder={create ? '至少 12 个字符' : '输入主密码'} />
          <button type="button" aria-label={show ? '隐藏主密码' : '显示主密码'} onClick={() => setShow(!show)}>{show ? <EyeOff size={17}/> : <Eye size={17}/>}</button>
        </span></label>
        {create && <label className="field"><span>确认主密码</span><input required type="password" autoComplete="new-password"
          value={confirm} maxLength={1024} onChange={event => { setConfirm(event.target.value); setFormError(''); }} placeholder="再次输入主密码" /></label>}
        <label className="checkbox-text"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>
          信任此设备，记住主密码</label>
        {(formError || error) && <p className="form-error" role="alert">{formError || error}</p>}
        <Button kind="primary" className="full" type="submit" disabled={working}><span>{working ? '正在打开…' : create ? '创建并解锁' : '解锁'}</span><ArrowRight size={17}/></Button>
      </form>
      <div className="gate-actions">
        {!create && trusted && <button type="button" disabled={working} onClick={onDevice}>使用本机解锁</button>}
        {create && <button type="button" disabled={working} onClick={onRestore}>从加密备份恢复</button>}
      </div>
    </div></div>
  </main>;
}

export function Editor({account, suggested, onSave, onClose, busy}: {
  account: Account | null; suggested: string; onSave: (input: AccountInput) => Promise<void>; onClose: () => void; busy: boolean;
}) {
  const [number, setNumber] = useState(account?.number ?? suggested);
  const [email, setEmail] = useState(account?.email ?? '');
  const [previousEmail, setPreviousEmail] = useState(account?.previousEmail ?? '');
  const [plan, setPlan] = useState(account?.plan ?? 'unknown');
  const [availability, setAvailability] = useState(account?.availability ?? 'unchecked');
  const [rebind, setRebind] = useState(account?.rebind ?? 'unchanged');
  const [rebindDate, setRebindDate] = useState(account?.rebindDate ?? '');
  const [renewalDate, setRenewalDate] = useState(account?.renewalDate ?? '');
  const [factor, setFactor] = useState(account?.twoFactor ?? 'unknown');
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [tags, setTags] = useState(account?.tags.join('，') ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [removeTotp, setRemoveTotp] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await onSave({
        id: account?.id ?? null, number, email, previousEmail, plan, availability, rebind, rebindDate, renewalDate,
        twoFactor: factor, notes, tags: tags.split(/[,，]/), verifiedAt: account?.availability === availability ? account.verifiedAt : null,
        password: removePassword ? '' : password || undefined, totp: removeTotp ? '' : totp || undefined,
      });
    } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
  }

  return <Modal title={account ? '编辑账号' : '新增账号'} close={onClose} variant="editor-modal">
    <form onSubmit={submit} autoComplete="off">
      <div className="modal-body editor-body">
        <div className="form-section"><h3>基本资料</h3><div className="field-grid">
          <label className="field"><span>账号编号</span><input required value={number} maxLength={32} onChange={e => setNumber(e.target.value)}/></label>
          <label className="field"><span>登录邮箱</span><input required value={email} maxLength={320} inputMode="email" autoComplete="off"
            onChange={e => setEmail(e.target.value)} placeholder="name@example.com"/></label>
          <SelectField label="套餐" value={plan} options={plans} onChange={setPlan}/>
          <SelectField label="手动状态" value={availability} options={availabilityLabels} onChange={setAvailability}/>
          <SelectField label="邮箱改绑" value={rebind} options={rebindLabels} onChange={setRebind}/>
          <label className="field"><span>订阅续费日</span><input type="date" value={renewalDate} onChange={e => setRenewalDate(e.target.value)}/></label>
          <label className="field"><span>原邮箱</span><input value={previousEmail} maxLength={320} inputMode="email" autoComplete="off"
            onChange={e => setPreviousEmail(e.target.value)} placeholder="选填"/></label>
          <label className="field"><span>邮箱改绑日期</span><input type="date" value={rebindDate} onChange={e => setRebindDate(e.target.value)}/></label>
        </div></div>
        <div className="form-section"><h3>登录凭据</h3><div className="field-grid">
          <label className="field"><span>密码</span><input type="password" autoComplete="new-password" maxLength={4096}
            value={password} disabled={removePassword} onChange={e => setPassword(e.target.value)}
            placeholder={account?.hasPassword ? '留空保留已保存密码' : '选填'}/></label>
          <SelectField label="2FA 方式" value={factor} options={factorLabels} onChange={setFactor}/>
          <label className="field span-two"><span>验证器密钥</span><input type="password" autoComplete="off" maxLength={256}
            value={totp} disabled={removeTotp} onChange={e => setTotp(e.target.value)}
            placeholder={account?.hasTotp ? '留空保留已保存密钥' : '选填 · Base32 密钥'}/></label>
          {account?.hasPassword && <label className="checkbox-text"><input type="checkbox" checked={removePassword} onChange={e => setRemovePassword(e.target.checked)}/> 清除已保存密码</label>}
          {account?.hasTotp && <label className="checkbox-text"><input type="checkbox" checked={removeTotp} onChange={e => setRemoveTotp(e.target.checked)}/> 清除已保存密钥</label>}
        </div></div>
        <div className="form-section"><h3>标签与备注</h3><div className="field-grid">
          <label className="field span-two"><span>标签</span><input value={tags} onChange={e => setTags(e.target.value)} placeholder="例如「工作，主用」"/></label>
          <label className="field span-two"><span>备注</span><textarea rows={3} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="补充账号情况"/></label>
        </div></div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><Button onClick={onClose}>取消</Button>
        <Button type="submit" kind="primary" disabled={busy}>{account ? <Check size={17}/> : <Plus size={17}/>} 保存账号</Button></div>
    </form>
  </Modal>;
}

export function Detail({account, close, edit, mark, remove, copy, reveal, code, connect, disconnect, refresh, jumpSettings, busy, refreshing, codexReady, quotaNow, privateWindow, setPrivateWindow, loginStage, cancelLogin, copyLoginLink}:
  {account: Account; close: () => void; edit: () => void; mark: (status: Account['availability']) => void;
    remove: () => void; copy: (kind: string) => void; reveal: () => Promise<string>; code: () => Promise<Code>;
    connect: () => void; disconnect: () => void; refresh: () => void; jumpSettings: () => void; busy: string; refreshing: boolean; codexReady: boolean; quotaNow: number;
    privateWindow: boolean; setPrivateWindow: (value: boolean) => void; loginStage: LoginStage | null;
    cancelLogin: () => void; copyLoginLink: () => void;}) {
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState<Code | null>(null);
  const [clock, setClock] = useState(seconds);
  const [error, setError] = useState('');
  const busyAny = !!busy;
  const signingIn = busy === 'connect';
  const canCancel = !!loginStage && loginStage !== 'cancelling' && loginStage !== 'committing';
  const canCopyLink = loginStage === 'waiting' || loginStage === 'manual';
  const loginText = loginStage === 'cancelling' ? '正在取消登录…'
    : loginStage === 'finishing' || loginStage === 'committing' ? '正在确认授权并读取额度…'
    : loginStage === 'manual' ? (privateWindow ? '请打开浏览器的无痕窗口，复制授权链接并粘贴到地址栏。' : '请复制授权链接并在浏览器中打开。')
    : loginStage === 'waiting' ? (privateWindow ? '请在浏览器的无痕窗口完成授权。若窗口未打开，可以复制链接。' : '请在浏览器中完成授权。')
    : '正在准备 Codex 授权…';

  useEffect(() => {
    if (!password) return;
    const timeout = setTimeout(() => setPassword(''), 15_000);
    return () => clearTimeout(timeout);
  }, [password]);

  useEffect(() => {
    if (!otp) return;
    const timer = setInterval(() => setClock(seconds()), 250);
    return () => clearInterval(timer);
  }, [otp]);

  useEffect(() => {
    if (!otp || clock < otp.expiresAt) return;
    let mounted = true;
    code().then(value => { if (mounted) setOtp(value); }).catch(() => { if (mounted) setOtp(null); });
    return () => { mounted = false; };
  }, [clock, otp, code]);

  const observation = account.observed;
  const reported = detectedPlan(account);
  return <Modal title="账号详情" close={close} variant="detail-modal">
    <div className="modal-body detail-body">
      <div className="detail-identity"><AccountAvatar account={account}/>
        <div><p>{account.number}</p><h3>{account.email}</h3><div className="row-chips"><PlanPill account={account}/><StatusPill account={account} now={quotaNow}/><RebindPill account={account}/></div></div>
      </div>
      <div className="detail-section"><h4><KeyRound size={15}/> 登录凭据</h4>
        <div className="credential-item"><div><span>邮箱</span><strong>{account.email}</strong></div><Button className="icon-button" aria-label="复制邮箱" onClick={() => copy('email')}><Clipboard size={15}/></Button></div>
        <div className="credential-item"><div><span>密码</span><strong className={password ? 'revealed' : ''}>{account.hasPassword ? password || '••••••••••' : '未保存'}</strong></div>
          {account.hasPassword && <div className="icon-group"><Button aria-label={password ? '隐藏密码' : '显示密码'} className="icon-button" onClick={() => {
            setError('');
            if (password) setPassword(''); else reveal().then(setPassword).catch(reason => setError(String(reason)));
          }}>{password ? <EyeOff size={16}/> : <Eye size={16}/>}</Button>
          <Button aria-label="复制密码" className="icon-button" onClick={() => copy('password')}><Clipboard size={15}/></Button></div>}</div>
        <div className="credential-item"><div><span>2FA · {factorLabels[account.twoFactor]}</span>
          <strong className={otp ? 'otp-code' : ''}>{otp ? otp.code.slice(0, 3) + ' ' + otp.code.slice(3) : account.hasTotp ? '可生成离线验证码' : '未保存密钥'}</strong>
          {otp && <small>{Math.max(0, otp.expiresAt - clock)} 秒后更新</small>}</div>
          {account.hasTotp && <div className="icon-group"><Button aria-label={otp ? '隐藏验证码' : '显示验证码'} className="icon-button" onClick={() => {
            setError('');
            if (otp) setOtp(null); else code().then(value => { setClock(seconds()); setOtp(value); }).catch(reason => setError(String(reason)));
          }}>{otp ? <EyeOff size={16}/> : <Fingerprint size={16}/>}</Button>
          <Button aria-label="复制验证码" className="icon-button" onClick={() => copy('totp')}><Clipboard size={15}/></Button></div>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="detail-section"><h4><ShieldCheck size={16}/> Codex 连接</h4>
        <div className="connection-panel">
          <div className="connection-title"><ConnectionPill account={account}/>
            {observation && <span>{stationTime(observation.checkedAt)}</span>}</div>
          {!observation && <p>使用与本条记录相同的邮箱在浏览器登录 ChatGPT，授权后回到此页面。</p>}
          {observation && <dl>
            <div><dt>授权邮箱</dt><dd>{observation.email || '—'}</dd></div>
            <div><dt>检测到的套餐</dt><dd>{reported ? planName(reported) : '—'}</dd></div>
            <div><dt>上次成功检查</dt><dd>{formatDate(observation.lastSuccessAt, true)}</dd></div>

          </dl>}
          {observation?.detail && <p className="connection-note">{observation.detail}</p>}
          {observation && <div className="detail-quota"><QuotaMeter account={account} now={quotaNow}/></div>}
          {codexReady && !signingIn && <label className="checkbox-text browser-preference">
            <input type="checkbox" checked={privateWindow} disabled={busyAny} onChange={event => setPrivateWindow(event.target.checked)}/>
            用无痕窗口打开授权
          </label>}
          {signingIn && <p className="login-progress" role="status">{loginText}</p>}
          <div className="connection-actions">
            {signingIn ? <>
              <Button disabled={!canCancel} onClick={cancelLogin}><X size={15}/> 取消登录</Button>
              {canCopyLink && <Button onClick={copyLoginLink}><Clipboard size={15}/> 复制授权链接</Button>}
            </> : <Button disabled={busyAny} onClick={codexReady ? connect : jumpSettings}>
              <Link2 size={15}/>{!codexReady ? '设置 Codex CLI' : observation ? '重新连接' : '连接 Codex'}
            </Button>}
            {observation && !signingIn && <Button disabled={busyAny || refreshing} onClick={refresh}><RefreshCw size={15}/>{refreshing ? '检查中…' : '刷新'}</Button>}
            {observation && !signingIn && <Button disabled={busyAny} kind="ghost" className="icon-button" aria-label="断开 Codex" title="断开 Codex" onClick={disconnect}><Unlink size={16}/></Button>}

          </div>
        </div>
      </div>
      <ResetCard account={account} now={quotaNow}/>
      <div className="detail-section"><h4><ArchiveRestore size={15}/> 复核与备注</h4>
        <dl className="details-list">
          {observation && <div><dt>手填套餐 / 状态</dt><dd>{plans[account.plan]} · {availabilityLabels[account.availability]}</dd></div>}
          <div><dt>最后人工核验</dt><dd>{formatDate(account.verifiedAt, true)}</dd></div>
          <div><dt>订阅续费日</dt><dd>{account.renewalDate || '—'}</dd></div>
          <div><dt>原登录邮箱</dt><dd>{account.previousEmail || '—'}</dd></div>
          <div><dt>邮箱改绑日期</dt><dd>{account.rebindDate || '—'}</dd></div>
        </dl>
        {account.tags.length > 0 && <div className="row-chips wrap">{account.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}</div>}
        <p className="note-text">{account.notes || '暂无备注'}</p>
        <div className="connection-actions">
          <Button onClick={() => mark('available')} disabled={busyAny}><Check size={16}/> 确认可用</Button>
          <Button onClick={() => mark('unavailable')} disabled={busyAny}><CircleAlert size={16}/> 标记不可用</Button>
        </div>
      </div>
    </div>
    <div className="modal-footer detail-footer">
      <Button kind="ghost" className="icon-button delete-button" aria-label="删除账号" disabled={busyAny} onClick={remove}><Trash2 size={17}/></Button>
      <Button kind="primary" onClick={edit}>编辑账号 <ArrowRight size={16}/></Button>
    </div>
  </Modal>;
}

function stationTime(time: number) { return formatDate(time, true); }

export function SettingsView({book, onSave, choose, discover, trust, exportBackup, restore, busy}:
  {book: Unlocked; onSave: (settings: Settings) => Promise<void>; choose: () => void; discover: () => void; trust: (value: boolean) => void; exportBackup: () => void; restore: () => void; busy: string;}) {
  const [settings, setSettings] = useState(book.settings);
  const changed = Object.keys(settings).some(key => settings[key as keyof Settings] !== book.settings[key as keyof Settings]);
  const select = (label: string, field: keyof Settings, choices: [number, string][]) => (
    <label className="settings-row"><span>{label}</span><span className="select-wrap">
      <select aria-label={label} value={settings[field]} onChange={event => setSettings({...settings, [field]: Number(event.target.value)})}>
        {choices.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select><ChevronDown size={14}/></span></label>
  );
  return <div className="settings-view">
    <section className="settings-card settings-lock"><div className="settings-heading"><div className="section-icon"><LockKeyhole size={19}/></div><div><h3>锁定与复核</h3><p>设置锁定时间、人工复核周期和应用内刷新频率。</p></div></div>
      {select('闲置后自动锁定', 'lockMinutes', [[1, '1 分钟'], [5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟'], [0, '永不']])}
      {select('人工状态复核周期', 'reviewDays', [[7, '7 天'], [14, '14 天'], [30, '30 天'], [60, '60 天'], [90, '90 天']])}
      {select('Codex 自动刷新', 'autoRefreshMinutes', [[0, '智能（每 5 分钟）'], [15, '每 15 分钟'], [30, '每 30 分钟'], [60, '每 60 分钟']])}
      <div className="settings-row"><span className="path-info"><strong>信任此设备，记住主密码</strong>
        <small>同一 Windows 用户重新打开应用时自动解锁。</small></span>
        <Button disabled={!!busy} onClick={() => trust(!book.deviceTrusted)}>{book.deviceTrusted ? '撤销信任' : '信任此设备'}</Button></div>
      <div className="settings-actions"><Button kind="primary" disabled={!changed || !!busy} onClick={() => void onSave(settings)}><Check size={16}/> 保存设置</Button></div>
    </section>
    <section className="settings-card"><div className="settings-heading"><div className="section-icon"><Code2 size={21}/></div><div><h3>Codex CLI</h3><p>读取连接状态需要本机的 Codex CLI。</p></div></div>
      <div className="settings-row"><span className="path-info"><strong>{book.codexPath ? '已找到 Codex CLI' : '当前未找到 Codex CLI'}</strong>
        {book.codexPath && <small>{book.codexPath}</small>}</span>
        <div className="row-chips wrap"><Button disabled={!!busy} onClick={discover}>{busy === 'discover' ? '查找中…' : '自动查找'}</Button>
        <Button disabled={!!busy} onClick={choose}>选择程序</Button></div></div>
      <ol className="connection-steps">
        <li>确认此处显示「已找到 Codex CLI」。</li>
        <li>打开要连接的账号详情，在 Codex 连接中点「连接 Codex」。</li>
        <li>用该条记录的邮箱在浏览器授权，完成后回到账号簿。</li>
      </ol>
    </section>
    <section className="settings-card"><div className="settings-heading"><div className="section-icon"><ArchiveRestore size={19}/></div><div><h3>加密备份</h3>
      <p>备份包含账号资料和凭据。迁移后可逐个重新连接 Codex。</p></div></div>
      <div className="settings-row"><span>本地加密文件</span><div className="row-chips wrap">
        <Button disabled={!!busy} onClick={exportBackup}><ArrowDownToLine size={16}/> 导出备份</Button>
        <Button disabled={!!busy} onClick={restore}><ArchiveRestore size={16}/> 恢复备份</Button>
      </div></div>
    </section>
  </div>;
}
