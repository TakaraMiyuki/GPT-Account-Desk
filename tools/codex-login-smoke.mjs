import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const [mode, dataDir, endpoint, output] = process.argv.slice(2);
const data = resolve(dataDir);
const profileRoot = join(data, 'codex');
const master = 'Synthetic quota regression vault!42';

if (mode === 'preload') {
  const fixture = String.raw`
import('node:fs').then(async fs => {
  const {createInterface} = await import('node:readline');
  createInterface({input:process.stdin}).on('line', line => {
    const {id,method} = JSON.parse(line);
    if (!id) return;
    if (method === 'account/login/start') {
      fs.writeFileSync('request-received.txt', 'pending');
      // Keep login/start pending so this desktop test never opens a user browser.
      return;
    }
    console.log(JSON.stringify({id,result:{}}));
  });
});
`;
  await writeFile(join(data,'qa-login-preload.cjs'), `
const {existsSync,writeFileSync} = require('node:fs');
const {resolve,basename,dirname} = require('node:path');
const root = ${JSON.stringify(profileRoot)};
const directory = resolve(process.cwd());
if (dirname(directory) === root && basename(process.argv[1] || '') === 'app-server' && !existsSync('app-server')) {
  writeFileSync('package.json', '{"type":"commonjs"}');
  writeFileSync('app-server', ${JSON.stringify(fixture)});
}
`);
  process.exit(0);
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('tauri.localhost'));
assert(page);
page.setDefaultTimeout(14_000);
await mkdir(output,{recursive:true});
const button = name => page.getByRole('button',{name,exact:true});
const details = page.getByRole('dialog',{name:'账号详情'});
const card = details.getByRole('region',{name:'重置卡'});
const accounts = await readdir(profileRoot);

await page.getByRole('heading',{name:'解锁账号库'}).waitFor();
await page.getByLabel('主密码',{exact:true}).fill(master);
await button('解锁').click();
await page.locator('tbody tr').filter({hasText:'atlas@example.com'}).getByText('Codex 可用',{exact:true}).waitFor();

async function waitForRequest() {
  await page.locator('button:enabled').filter({hasText:'取消登录'}).waitFor();
  for (let i = 0; i < 50; i++) {
    const profiles = (await readdir(profileRoot)).filter(name => !accounts.includes(name));
    for (const profile of profiles) {
      if ((await readdir(join(profileRoot,profile)).catch(() => [])).includes('request-received.txt')) return;
    }
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw new Error('The synthetic callback never started');
}

await button('查看 GPT-001 详情').click();
assert(await details.getByLabel('用无痕窗口打开授权').isChecked());
assert(await card.evaluate(el => {
  const section = el.previousElementSibling;
  return Boolean(section?.querySelector('h4')?.textContent.includes('Codex 连接'));
}));
await card.scrollIntoViewIfNeeded();
await page.screenshot({path:join(output,'codex-reset-card.png'),animations:'disabled'});
await button('重新连接').click();
await waitForRequest();
await details.getByText('正在准备 Codex 授权…',{exact:true}).waitFor();
await page.screenshot({path:join(output,'cancel-codex-login.png'),animations:'disabled'});
await button('取消登录').click();
await button('取消登录').waitFor({state:'hidden'});
await details.getByText('已取消 Codex 登录。',{exact:true}).waitFor();
await details.getByText('Codex 可用',{exact:true}).waitFor();
assert.equal(await card.locator('.reset-card-count').textContent(),'2张');
assert.deepEqual((await readdir(profileRoot)).sort(),accounts.sort());
await page.keyboard.press('Escape');

await button('查看 GPT-005 详情').click();
await details.getByLabel('用无痕窗口打开授权').uncheck();
await button('连接 Codex').click();
await waitForRequest();
await page.keyboard.press('Escape');
await button('取消登录').waitFor({state:'hidden'});
await details.getByText('已取消 Codex 登录。',{exact:true}).waitFor();
await details.getByText('未连接',{exact:true}).waitFor();
assert.equal(await details.getByRole('region',{name:'重置卡'}).count(),0);
assert.deepEqual((await readdir(profileRoot)).sort(),accounts.sort());

console.log('PASS: packaged app reset-card placement, private-by-default preference, button and Escape cancellation, retained old binding, cleaned new profiles');
process.exit(0);
