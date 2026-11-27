export const plans = {
  unknown: '未知', free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', business: 'Business',
  enterprise: 'Enterprise', edu: 'Edu', other: '其他',
} as const;
export const availabilityLabels = { unchecked: '待核验', available: '可用', unavailable: '不可用' } as const;
export const rebindLabels = { unchanged: '未改绑', changed: '已改绑', native: '原生' } as const;
export const factorLabels = { unknown: '未记录', none: '未启用', authenticator: '验证器', other: '其他方式' } as const;
export const connectionLabels = {
  connected: '已连接', reauth: '需重新登录', unreachable: '检查失败', identityMismatch: '账号待确认',
} as const;

export type Plan = keyof typeof plans;
export type Availability = keyof typeof availabilityLabels;
export type Rebind = keyof typeof rebindLabels;
export type TwoFactor = keyof typeof factorLabels;
export type LoginStage = 'starting' | 'waiting' | 'manual' | 'finishing' | 'cancelling' | 'committing';
export type ConnectionState = keyof typeof connectionLabels;

export type QuotaStatus = 'available' | 'limitReached' | 'workspaceLimited' | 'unknown';

export interface QuotaWindow {
  usedPercent: number;
  durationMinutes: number | null;
  resetsAt: number | null;
}

export interface Quota {
  windows: QuotaWindow[];
  resetCards: number | null;
  nextCardExpiry: number | null;
  status: QuotaStatus;
}

export interface Observation {
  state: ConnectionState;
  checkedAt: number;
  lastSuccessAt: number | null;
  onlineVerifiedAt: number | null;
  email: string | null;
  plan: string | null;
  detail: string | null;
  quota: Quota | null;
}

export interface UsageSource {
  id: string;
  accountId: string | null;
  folder: string;
}

export interface Account {
  id: string;
  number: string;
  email: string;
  previousEmail: string;
  plan: Plan;
  availability: Availability;
  rebind: Rebind;
  rebindDate: string;
  renewalDate: string;
  twoFactor: TwoFactor;
  notes: string;
  tags: string[];
  verifiedAt: number | null;
  updatedAt: number;
  hasPassword: boolean;
  hasTotp: boolean;
  observed: Observation | null;
  linkedEmail: string | null;
}

export type AccountInput = Omit<Account, 'id' | 'updatedAt' | 'hasPassword' | 'hasTotp' | 'observed' | 'linkedEmail'> & {
  id: string | null;
  password?: string;
  totp?: string;
};

export interface Settings {
  lockMinutes: number;
  reviewDays: number;
  autoRefreshMinutes: number;
}

export interface Unlocked {
  phase: 'unlocked';
  accounts: Account[];
  settings: Settings;
  codexPath: string | null;
  deviceTrusted: boolean;
  manualOrder: boolean;
  hasCustomOrder: boolean;
  usageSources: UsageSource[];
}
export type Snapshot = Unlocked | { phase: 'new' | 'locked'; deviceTrusted: boolean };
export type Saved = { id: string; snapshot: Unlocked };
export type Changed = { snapshot: Snapshot; warning: string | null };
export type ImportResult = { count: number; issues: {line: number; reason: string}[]; snapshot: Snapshot | null };
export type Code = { code: string; expiresAt: number };

export const seconds = () => Math.floor(Date.now() / 1000);
export const needsReview = (account: Account, days: number) =>
  account.verifiedAt === null || seconds() - account.verifiedAt >= days * 86400;

export function localDay(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function needsAttention(account: Account, days: number): boolean {
  const renewSoon = !!account.renewalDate && account.renewalDate <= localDay(7);
  return needsReview(account, days) || renewSoon;
}

export const formatDate = (value: number | null | undefined, withTime = false) => {
  if (!value) return '—';
  const date = new Date(value * 1000);
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('.');
  return withTime ? day + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : day;
};

const additionalPlans: Record<string, {label: string; group: Plan}> = {
  prolite: {label: 'Pro Lite', group: 'pro'}, promax: {label: 'Pro Max', group: 'pro'},
  team: {label: 'Team', group: 'business'},
  self_serve_business_prolite: {label: 'Business Pro Lite', group: 'business'},
  self_serve_business_usage_based: {label: 'Business', group: 'business'},
  ent26: {label: 'Enterprise', group: 'enterprise'},
  enterprise_cbp_automation: {label: 'Enterprise', group: 'enterprise'},
  enterprise_cbp_usage_based: {label: 'Enterprise', group: 'enterprise'},
  edu_plus: {label: 'Edu Plus', group: 'edu'}, edu_pro: {label: 'Edu Pro', group: 'edu'},
  sci: {label: 'Science', group: 'other'}, sci_plus: {label: 'Science Plus', group: 'other'},
};

export function connectionState(account: Account): ConnectionState | undefined {
  if (!account.observed) return;
  return account.linkedEmail && account.email.toLowerCase() !== account.linkedEmail.toLowerCase()
    ? 'identityMismatch' : account.observed.state;
}

export function activeObservation(account: Account): Observation | null {
  return connectionState(account) === 'identityMismatch' ? null : account.observed;
}

export function detectedPlan(account: Account) {
  const plan = activeObservation(account)?.plan;
  return plan && plan.toLowerCase() !== 'unknown' ? plan : null;
}

export function planGroup(account: Account): Plan {
  const key = detectedPlan(account)?.toLowerCase();
  if (!key) return account.plan;
  if (Object.hasOwn(plans, key)) return key as Plan;
  return Object.hasOwn(additionalPlans, key) ? additionalPlans[key].group : 'other';
}

export function quotaStale(observation: Observation, time: number) {
  const verified = observation.onlineVerifiedAt ?? 0;
  return observation.state !== 'connected' || time - verified >= 3600 ||
    !!observation.quota?.windows.some(window => window.resetsAt && window.resetsAt <= time);
}

export function cardsStale(observation: Observation, time: number) {
  const verified = observation.onlineVerifiedAt ?? 0;
  const expiry = observation.quota?.nextCardExpiry;
  return observation.state !== 'connected' || time - verified >= 3600 || !!(expiry && expiry <= time);
}

export function positiveResetCards(account: Account) {
  return (activeObservation(account)?.quota?.resetCards ?? 0) > 0;
}

export type AccountStatus = {label: string; availability: Availability; tone: 'good' | 'bad' | 'warm'};

export function effectiveStatus(account: Account, time: number): AccountStatus {
  const connection = connectionState(account);
  if (!connection) {
    const value = account.availability;
    return {label: availabilityLabels[value], availability: value,
      tone: value === 'available' ? 'good' : value === 'unavailable' ? 'bad' : 'warm'};
  }
  switch (connection) {
    case 'reauth': return {label: '需重新登录', availability: 'unavailable', tone: 'warm'};
    case 'unreachable': return {label: '暂无法核验', availability: 'unchecked', tone: 'warm'};
    case 'identityMismatch': return {label: '账号待确认', availability: 'unchecked', tone: 'warm'};
  }
  const observation = account.observed!;
  const quota = observation.quota;
  if (!quota || quotaStale(observation, time)) return {label: '额度待刷新', availability: 'unchecked', tone: 'warm'};
  switch (quota.status) {
    case 'available': return {label: 'Codex 可用', availability: 'available', tone: 'good'};
    case 'limitReached': return {label: '额度用尽', availability: 'unavailable', tone: 'bad'};
    case 'workspaceLimited': return {label: '工作区受限', availability: 'unavailable', tone: 'bad'};
    default: return {label: '待确认', availability: 'unchecked', tone: 'warm'};
  }
}

export const planName = (plan: string) => {
  const normalized = plan.toLowerCase();
  if (Object.hasOwn(plans, normalized)) return plans[normalized as Plan];
  return Object.hasOwn(additionalPlans, normalized) ? additionalPlans[normalized].label : plan;
};
