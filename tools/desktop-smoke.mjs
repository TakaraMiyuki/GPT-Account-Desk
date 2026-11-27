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
      const day = (offset) => {
        const date = new Date();
        date.setDate(date.getDate() + offset);
        return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
      };
      await writeFile(join(root,'fixture.json'), JSON.stringify({...settings, index, today: day(0), yesterday: day(-1),
        resetsAt: now + 2 * 3600 + 900, resetsWeek: now + 3 * 86400, expires: now + 4 * 86400}));
      await writeFile(join(root,'app-server'), String.raw`
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const {id, method} = JSON.parse(line);
  if (!id) return;
  let result = {};
  if (method === 'account/read') result = {account: {type:'chatgpt',email:scenario.email,planType:scenario.manualPlan}};
  if (method === 'account/usage/read') {
    if (scenario.index === 3 || fs.existsSync('simulate-offline')) {
      console.log(JSON.stringify({id,error:{code:-32000,message:'Response unavailable'}}));
      return;
    }
    result = {summary:{lifetimeTokens: (scenario.index+1)*200000},
      dailyUsageBuckets: scenario.index === 2 ? null : [{startDate:scenario.today,tokens:(scenario.index+1)*100},
        {startDate:scenario.yesterday,tokens:(scenario.index+1)*50}]};
  }
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
      previousEmail:'',plan:settings.manualPlan,availability:settings.manualStatus,rebind:['unknown','pending','changed','unchanged','unknown'][index],
      rebindDate:'',renewalDate:'',twoFactor:'none',notes:'用于验证的模拟账号',tags:[],
      verifiedAt:settings.manualStatus==='unchecked'?null:now,updatedAt:now,password:'',totp:'',link});
  }
  const linked = join(data, 'fixture-sessions-atlas');
  const mixed = join(data, 'fixture-sessions-mixed');
  for (const folder of [linked,mixed]) await mkdir(folder,{recursive:true});
  const at = (offset) => { const date = new Date(); date.setDate(date.getDate()+offset); return date.toISOString(); };
  const usage = (input, cached, output) => ({input_tokens:input,cached_input_tokens:cached,output_tokens:output});
  const event = (type, payload, offset) => ({timestamp:at(offset),type,payload});
  const record = (id, input, cached, output, offset, model = 'gpt-5.6-sol') =>
    event('token_usage_record',{response_id:id,model,usage:usage(input,cached,output)},offset);
  const counter = (last, cumulative, offset) =>
    event('event_msg',{type:'token_count',info:{last_token_usage:last,total_token_usage:cumulative}},offset);
  const a = record('resp_demoA',1000,200,100,0);
  const b = record('resp_demoB',2000,800,220,-2);
  const c = record('resp_demoC',80,0,20,-15,'example-unpriced-model');
  const rows = [event('turn_context',{model:'gpt-5.6-sol'},0),a,
    counter(usage(1000,200,100),usage(1000,200,100),0),b,
    counter(usage(2000,800,220),usage(3000,1000,320),-2),
    c,counter(usage(80,0,20),usage(3080,1000,340),-15)];
  await writeFile(join(linked,'rollout-synthetic-a.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  await writeFile(join(mixed,'rollout-synthetic-b.jsonl'),[b].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const usageSources = mode === 'empty-fixture' ? [] : [
    {id:randomUUID(),accountId:accounts[0].id,folder:linked},
    {id:randomUUID(),accountId:null,folder:mixed}
  ];
  const clear = Buffer.from(JSON.stringify({accounts,usageSources,manualOrder:false,hasCustomOrder:false,
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
  if (mode === 'fixture') {
    const current = {time:now - 120,lowest:10,offerCount:18,inStockCount:13,stale:false,offers:[
      {id:'a',merchant:'渠道甲',title:'模拟 Plus 商品一',price:10,available:true,stock:12},
      {id:'b',merchant:'渠道乙',title:'模拟 Plus 商品二',price:11,available:true,stock:null},
      {id:'c',merchant:'渠道丙',title:'模拟 Plus 商品三',price:20,available:true,stock:4},
      {id:'d',merchant:'渠道丁',title:'模拟 Plus 商品四',price:12,available:false,stock:0}
    ]};
    const history = [{time:now-2*86400,lowest:17},{time:now-7200,lowest:8},{time:current.time,lowest:10}];
    await writeFile(join(data,'priceai-snapshots.json'),JSON.stringify({etag:null,snapshot_id:'demo',view:{checkedAt:now,current,history}}));
  }
}



if (mode.endsWith('fixture')) { await fixture(); process.exit(0); }
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('tauri.localhost'));
assert(page);
page.setDefaultTimeout(14000);
const button = name => page.getByRole('button',{name,exact:true});
const heading = name => page.getByRole('heading',{name,exact:true});
const card = title => page.getByRole('region',{name:'用量概览'}).locator('.stat-card').filter({hasText:title}).locator('strong');
const logs = page.getByRole('table',{name:'请求日志'}).locator('tbody tr');
const dialog = page.getByRole('dialog',{name:'账号详情'});
const reset = dialog.getByRole('region',{name:'重置卡'});
const screenshot = name => page.screenshot({path:join(output,name),fullPage:true,animations:'disabled'});

await heading('解锁账号库').waitFor();
await page.getByLabel('主密码',{exact:true}).fill(master);
await button('解锁').click();
await heading('账号台账').waitFor();
if (mode === 'live') {
  await button('价格监控').click();
  await page.getByText(/商品快照/).waitFor({timeout:35000});
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(data,'priceai-snapshots.json'),'utf8'));
  assert(saved.snapshot_id);
  assert(saved.view.current.offers.length > 0);
  assert(saved.view.history.length >= 1);
  console.log('PASS: real PriceAI pointer, immutable snapshot and local history', saved.snapshot_id);
  await screenshot('price-live.png');
  await browser.close();
  process.exit(0);
}
if (mode === 'empty') {
  await button('用量统计').click();
  await button('接入默认 Codex 日志').click();
  await page.getByText(/已扫描 1 个会话日志/).waitFor();
  assert.equal(await card('Token 消耗').textContent(),'3,320');
  assert.equal(await logs.count(),2);
  assert.equal(await logs.filter({hasText:'未归属'}).count(),2);
  console.log('PASS: default CODEX_HOME sessions imported from an old vault without any log source');
  await browser.close();
  process.exit(0);
}

await page.getByText('Codex 可用',{exact:true}).first().waitFor();
await button('查看 GPT-001 详情').click();
await reset.getByText('2',{exact:false}).first().waitFor();
assert.equal(await reset.locator('.reset-card-count').textContent(),'2张');
await button('关闭').click();
for (const id of ['GPT-002','GPT-003','GPT-005']) {
  await button('查看 '+id+' 详情').click();
  await dialog.waitFor();
  assert.equal(await reset.count(),0);
  await button('关闭').click();
}
await button('查看 GPT-001 详情').click();
await button('编辑账号').click();
const rebind = page.getByLabel('邮箱改绑',{exact:true});
assert.deepEqual(await rebind.locator('option').allTextContents(),['未改绑','已改绑','原生']);
assert.equal(await rebind.inputValue(),'unchanged');
await rebind.selectOption({label:'原生'});
await button('保存账号').click();
const nativePill = page.locator('tbody tr').filter({hasText:'atlas@example.com'}).getByText('原生',{exact:true});
await nativePill.waitFor();
assert(await nativePill.evaluate(el => el.classList.contains('tone-blue')));
await page.locator('tbody tr').filter({hasText:'lumen@example.com'}).getByText('未改绑',{exact:true}).waitFor();

await button('关闭').click();
await button('关闭提示').click();
await button('设置与备份').click();
await page.setViewportSize({width:1420,height:900});
const wide = await page.locator('.settings-card').evaluateAll(cards => cards.map(card => {
  const box = card.getBoundingClientRect();
  return {x:box.x,y:box.y,right:box.right};
}));
assert.equal(wide[0].y,wide[1].y);
assert(wide[0].right < wide[1].x);
await screenshot('settings-wide.png');
await page.setViewportSize({width:840,height:650});
const narrow = await page.locator('.settings-card').evaluateAll(cards => cards.map(card => {
  const box = card.getBoundingClientRect();
  return {x:box.x,y:box.y,width:box.width};
}));
assert(narrow[1].y > narrow[0].y && narrow[2].y > narrow[1].y);
assert.equal(narrow[0].width,narrow[1].width);
assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await screenshot('settings-narrow.png');

await page.setViewportSize({width:1270,height:870});
await button('用量统计').click();
await page.getByText(/已扫描 2 个会话日志/).waitFor();
assert.equal(await button('账号用量').count(),0);
assert.equal(await button('本地请求').count(),0);
assert.equal(await card('Token 消耗').textContent(),'3,320');
assert.equal(await card('请求数').textContent(),'2');
assert.equal(await card('缓存命中率').textContent(),'33.3%');
assert.equal(await page.getByRole('img',{name:'Token 消耗折线图'}).count(),1);
assert.equal(await page.locator('canvas').count(),1);
assert.equal(await page.locator('.usage-dot').count(),0);
await screenshot('usage.png');
await button('柱状图').click();
assert.equal(await page.getByRole('img',{name:'Token 消耗柱状图'}).count(),1);
assert.equal(await page.locator('canvas').count(),1);
await button('点阵图').click();
assert.equal(await page.locator('canvas').count(),0);
assert.equal(await page.locator('.usage-dot').count(),7);
await page.getByRole('button',{name:/缓存命中率.*缓存读取/}).click();
await heading('缓存命中率点阵图').waitFor();
await button('今日').click();
await page.getByText(/已扫描 2 个会话日志/).waitFor();
assert.equal(await card('请求数').textContent(),'1');
assert.equal(await page.locator('.usage-dot').count(),24);
await button('近 30 天').click();
await page.getByText(/已扫描 2 个会话日志/).waitFor();
assert.equal(await card('Token 消耗').textContent(),'3,420');
await button('按账号').click();
assert.equal(await page.getByRole('table',{name:'按账号'}).locator('tbody tr').count(),2);
await button('按模型').click();
assert.equal(await page.getByRole('table',{name:'按模型'}).locator('tbody tr').count(),2);
await button('example-unpriced-model').click();
await page.getByText(/已扫描 2 个会话日志/).waitFor();
assert.equal(await card('成本估算').textContent(),'—');
assert.equal(await page.getByLabel('筛选模型').locator('option').count(),3);
await page.getByLabel('筛选模型').selectOption('');
await page.getByText(/已扫描 2 个会话日志/).waitFor();
await button('请求日志').click();
assert.equal(await logs.count(),3);
await button('日志设置').first().click();
const sources = page.getByRole('dialog',{name:'日志设置'});
assert.equal(await sources.locator('.usage-source').count(),2);
const mixed = sources.getByLabel(/目录归属.*fixture-sessions-mixed/);
await mixed.selectOption({label:'GPT-001 · atlas@example.com'});
await page.getByText(/已扫描 2 个会话日志/).waitFor();
await page.waitForFunction(() => document.querySelector('table[aria-label="请求日志"] tbody')?.textContent.includes('未归属') === false);
assert.equal(await logs.filter({hasText:'未归属'}).count(),0);
await button('完成').click();
const folder = join(data,'fixture-sessions-atlas');
const newRows = Array.from({length:52},(_,index)=>({timestamp:new Date().toISOString(),type:'token_usage_record',
  payload:{response_id:'test_batch_'+index,model:'gpt-5.6-sol',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:5}}}));
await writeFile(join(folder,'rollout-more.jsonl'),newRows.map(x=>JSON.stringify(x)).join('\n')+'\n');
await button('刷新用量').click();
await page.getByText(/已扫描 3 个会话日志/).waitFor();
assert.equal(await card('请求数').textContent(),'55');
assert.equal(await logs.count(),50);
await button('下一页').click();
await page.getByText('第 2 / 2 页',{exact:true}).waitFor();
assert.equal(await logs.count(),5);
await button('价格监控').click();
const priceCard = title => page.getByRole('region',{name:'价格概览'}).locator('.stat-card').filter({hasText:title}).locator('strong');
await page.getByText(/已记录 2 个快照/).waitFor();
assert.match(await priceCard('区间峰价').textContent(), /10/);
assert.match(await priceCard('区间谷价').textContent(), /8/);
await button('近 7 天').click();
await page.getByText(/已记录 3 个快照/).waitFor();
assert.match(await priceCard('区间峰价').textContent(), /17/);
await page.getByLabel('最高价').fill('11');
assert.equal(await page.getByRole('table',{name:'可见报价与库存'}).locator('tbody tr').count(),2);
await page.getByText('2 条有货 · 已知库存 12 · 1 条有货报价未提供数量',{exact:true}).waitFor();
await page.getByLabel('最低价').fill('15');
await page.getByText(/请输入有效的价位范围/).waitFor();
await page.getByLabel('最低价').fill('');
await screenshot('price-preview.png');
await button('锁定').click();
await heading('解锁账号库').waitFor();
assert.equal(await page.getByRole('table',{name:'请求日志'}).count(),0);
console.log('PASS: legacy rebind migration, native status save, positive-only reset cards, responsive settings, usage attribution and charts, price ranges and inventory');
await browser.close();
