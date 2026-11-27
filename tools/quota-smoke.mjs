import assert from 'node:assert/strict';
import { argon2Sync, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [mode, dataDir, endpoint, output] = process.argv.slice(2);
const data = resolve(dataDir);
const master = 'Synthetic quota regression vault!42';

async function fixture() {
  const now = Math.floor(Date.now() / 1000);
  await mkdir(data, {recursive: true});
  const accounts = [];
  const scenarios = [
    {email: 'atlas@example.com', manualPlan:'free', manualStatus:'unavailable', plan:'pro',
      short:32, week:53, cards:2},
    {email: 'lumen@example.com', manualPlan:'plus', manualStatus:'available', plan:'plus',
      short:100, week:23, cards:0, reached:'rate_limit_reached'},
    {email: 'poppy@example.com', manualPlan:'unknown', manualStatus:'unchecked', plan:'go',
      short:12, cards:null},
    {email: 'mira@example.com', manualPlan:'free', manualStatus:'available', plan:'free',
      short:0, cards:0, network:'401 Unauthorized'},
    {email: 'haven@example.com', manualPlan:'free', manualStatus:'available'},
  ];
  for (const [index, settings] of scenarios.entries()) {
    let link = null;
    if (settings.plan) {
      const profile = randomUUID();
      const root = join(data, 'codex', profile);
      await mkdir(root, {recursive:true});
      await writeFile(join(root,'package.json'), JSON.stringify({type:'commonjs'}));
      await writeFile(join(root,'fixture.json'), JSON.stringify({...settings,
        resetsAt: now + 2 * 3600 + 900, resetsWeek: now + 3 * 86400, expires: now + 4 * 86400}));
      await writeFile(join(root,'app-server'), String.raw`
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const {id, method} = JSON.parse(line);
  if (!id) return;
  let result = {};
  if (method === 'account/read') result = {account: {type:'chatgpt',email:scenario.email,planType:scenario.manualPlan}};
  if (method === 'account/rateLimits/read') {
    const network = fs.existsSync('simulate-offline') ? '503 Service Unavailable' : scenario.network;
    if (network) {
      console.log(JSON.stringify({id,error:{code:-32000,message:network}}));
      return;
    }
    result = {rateLimitsByLimitId:{codex:{limitId:'codex',planType:scenario.plan,
      primary:{usedPercent:scenario.short,windowDurationMins:300,resetsAt:scenario.resetsAt},
      secondary:scenario.week === undefined ? null : {usedPercent:scenario.week,windowDurationMins:10080,resetsAt:scenario.resetsWeek},
      rateLimitReachedType:scenario.reached ?? null
    }},
    rateLimitResetCredits: scenario.cards === null ? null : {availableCount:scenario.cards,
      credits:scenario.cards ? [{status:'available',expiresAt:scenario.expires}] : []}};
  }
  console.log(JSON.stringify({id,result}));
});
`);
      link = {profile,email:settings.email,online:false,observation:{state:'connected',checkedAt:now,
        lastSuccessAt:now,onlineVerifiedAt:null,email:settings.email,plan:'unknown',detail:null}};
    }
    accounts.push({id:randomUUID(),number:'GPT-'+String(index+1).padStart(3,'0'),email:settings.email,
      previousEmail:'',plan:settings.manualPlan,availability:settings.manualStatus,rebind:'unknown',
      rebindDate:'',renewalDate:'',twoFactor:'none',notes:'用于验证的模拟账号',tags:[],
      verifiedAt:settings.manualStatus==='unchecked'?null:now,updatedAt:now,password:'',totp:'',link});
  }
  const clear = Buffer.from(JSON.stringify({accounts,manualOrder:false,hasCustomOrder:false,
    settings:{lockMinutes:5,reviewDays:30,autoRefreshMinutes:0}}));
  const nonce = randomBytes(12);
  const salt = randomBytes(16);
  const key = argon2Sync('argon2id', {message:Buffer.from(master),nonce:salt,parallelism:1,tagLength:32,memory:65536,passes:3});
  const header = Buffer.concat([Buffer.from('ACCOUNT-DESK\x01'),salt,nonce]);
  const cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([header,cipher.update(clear),cipher.final(),cipher.getAuthTag()]);
  await writeFile(join(data,'accounts.vault'),encrypted);
  await writeFile(join(data,'codex-path.txt'),process.execPath);
  await writeFile(join(data,'atlas-fixture-profile.txt'),accounts[0].link.profile);
}

if (mode === 'fixture') { await fixture(); process.exit(0); }
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('tauri.localhost'));
assert(page);
page.setDefaultTimeout(14_000);
const button = name => page.getByRole('button',{name,exact:true});
const heading = name => page.getByRole('heading',{name,exact:true});
const row = email => page.locator('tbody tr').filter({hasText:email});
const details = page.getByRole('dialog',{name:'账号详情'});
async function unlock() {
  await heading('解锁账号库').waitFor();
  await page.getByLabel('主密码',{exact:true}).fill(master);
  await button('解锁').click();
  await heading('账号台账').waitFor();
}

await unlock();
if (mode === 'legacy') {
  await page.getByRole('columnheader',{name:'最后核验'}).waitFor();
  const current = row('atlas@example.com');
  await current.getByText('Free',{exact:true}).waitFor();
  await current.getByText('不可用',{exact:true}).waitFor();
  console.log('PASS: v0.1.1 reads old linked fixture and keeps its manual fields');
} else if (mode === 'monitor') {
  await mkdir(output,{recursive:true});
  await page.getByRole('columnheader',{name:'额度监控'}).waitFor();
  assert.equal(await page.getByRole('columnheader',{name:'最后核验'}).count(),0);
  const atlas = row('atlas@example.com');
  const lumen = row('lumen@example.com');
  const poppy = row('poppy@example.com');
  const mira = row('mira@example.com');
  const haven = row('haven@example.com');
  await atlas.getByText('Pro',{exact:true}).waitFor();
  await atlas.getByText('Codex 可用',{exact:true}).waitFor();
  await atlas.getByRole('progressbar',{name:'5 小时剩余 68%'}).waitFor();
  await atlas.getByRole('progressbar',{name:'每周剩余 47%'}).waitFor();
  await lumen.getByText('额度用尽',{exact:true}).waitFor();
  await poppy.getByText('Go',{exact:true}).waitFor();
  await mira.getByText('需重新登录',{exact:true}).first().waitFor();
  await haven.getByText('可用',{exact:true}).waitFor();
  assert.equal(await page.locator('tbody .avatar-gold').count(),1);
  assert.equal(await atlas.locator('.avatar-gold').count(),1);
  await page.screenshot({path:join(output,'account-desk.png'),fullPage:true,animations:'disabled'});
  await button('查看 GPT-001 详情').click();
  const card = details.getByRole('region',{name:'重置卡'});
  assert.equal(await card.locator('.reset-card-count').textContent(),'2张');
  await card.getByText(/最近到期/).waitFor();
  assert(await card.evaluate(element => element.classList.contains('reset-card-gold')));
  assert(await details.evaluate(element => {
    const card = element.querySelector('.reset-card');
    const last = [...element.querySelectorAll('h4')].find(heading => heading.textContent.includes('登录凭据'));
    return !!last && !!card && !!(last.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  const widths = await details.locator('.quota-full progress').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width));
  assert.equal(widths.length, 2);
  assert.equal(widths[0], widths[1]);
  await page.screenshot({path:join(output,'reset-card.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  await button('查看 GPT-002 详情').click();
  assert.equal(await card.count(),0);
  assert.equal(await details.locator('.reset-card-gold').count(),0);
  await page.keyboard.press('Escape');
  await button('查看 GPT-003 详情').click();
  assert.equal(await card.count(),0);
  await page.keyboard.press('Escape');

  await page.getByRole('navigation').getByRole('button',{name:'设置与备份'}).click();
  await page.getByLabel('闲置后自动锁定').selectOption('0');
  await button('保存设置').click();
  await page.getByText('设置已保存。',{exact:true}).waitFor();
  await page.getByRole('navigation').getByRole('button',{name:'账号台账'}).click();
  const { readFile } = await import('node:fs/promises');
  const profile = await readFile(join(data,'atlas-fixture-profile.txt'),'utf8');
  await writeFile(join(data,'codex',profile,'simulate-offline'),'');
  await button('刷新 Codex').click();
  await atlas.getByText('暂无法核验',{exact:true}).waitFor();
  await atlas.getByText('上次记录',{exact:true}).waitFor();
  await atlas.getByRole('progressbar',{name:'5 小时剩余 68%'}).waitFor();
  await button('查看 GPT-001 详情').click();
  await details.getByText('Free · 不可用',{exact:true}).waitFor();
  await card.getByText(/上次记录/).waitFor();
  await page.keyboard.press('Escape');
  await button('锁定').click();
  await heading('解锁账号库').waitFor();
  console.log('PASS: startup monitoring, real desktop quota UI, stale cache, card counts, automatic plan/status, and manual lock');
} else if (mode === 'restart') {
  await page.getByRole('navigation').getByRole('button',{name:'设置与备份'}).click();
  assert.equal(await page.getByLabel('闲置后自动锁定').inputValue(),'0');
  console.log('PASS: never lock setting persists after restart');
} else { throw new Error('Bad test phase'); }

process.exit(0);
