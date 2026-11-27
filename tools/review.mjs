import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [endpoint, mode, data, output] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('tauri.localhost'));
assert(page);
page.setDefaultTimeout(12_000);

const master = 'Local regression vault pass!42';
const existing = 'legacy@example.com';
const secret = 'Legacy-original-password!';
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const lines = [`imported@example.com----key----inside----${seed}`, 'next@example.com----another-secret----',
  `LEGACY@example.com----will-not-overwrite----${seed}`, 'invalid----no----'].join('\n');
const gate = name => page.getByRole('heading', {name, exact: true});
const named = name => page.getByRole('button', {name, exact: true});
const details = page.getByRole('dialog', {name: '账号详情'});
const tableRows = () => page.locator('tbody tr').allTextContents();

if (mode === 'seed') {
  await gate('创建账号库').waitFor();
  await page.getByLabel('主密码', {exact: true}).fill(master);
  await page.getByLabel('确认主密码', {exact: true}).fill(master);
  await named('创建并解锁').click();
  await gate('账号台账').waitFor();
  await named('新增账号').first().click();
  const form = page.getByRole('dialog', {name: '新增账号'});
  await form.getByLabel('登录邮箱').fill(existing);
  await form.getByLabel('密码', {exact: true}).fill(secret);
  await form.getByLabel('验证器密钥').fill(seed);
  await form.getByLabel('备注').fill('已由 v0.1.0 写入');
  await named('保存账号').click();
  await details.getByRole('heading', {name: existing}).waitFor();
  console.log('PASS: v0.1.0 fixture saved through the normal account editor');
} else if (mode === 'upgrade') {
  await gate('解锁账号库').waitFor();
  assert.equal(await named('查看示例台账').count(), 0);
  await page.getByLabel('主密码', {exact: true}).fill(master);
  await page.getByLabel('信任此设备，记住主密码').check();
  await named('解锁').click();
  await gate('账号台账').waitFor();
  await page.getByRole('button', {name: '查看 GPT-001 详情'}).click();
  await details.getByText('已由 v0.1.0 写入').waitFor();
  await named('显示密码').click();
  await details.getByText(secret, {exact: true}).waitFor();
  await named('显示验证码').click();
  await details.getByText(/^\d{3} \d{3}$/).waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS: v0.1.0 vault credentials and notes open unchanged in v0.1.1');

  await named('快速导入').click();
  const importPanel = page.getByRole('dialog', {name: '快速导入账号'});
  await importPanel.getByLabel('导入文本').fill(lines);
  await named('检查格式').click();
  await importPanel.getByText('可添加 2 条，跳过 2 条').waitFor();
  await importPanel.getByText(/第 3 行.*邮箱已存在/).waitFor();
  await importPanel.getByText(/第 4 行.*邮箱格式无效/).waitFor();
  await mkdir(output, {recursive: true});
  await importPanel.getByLabel('导入文本').fill('');
  await page.screenshot({path: join(output, 'quick-import.png')});
  await importPanel.getByLabel('导入文本').fill(lines);
  await named('检查格式').click();
  await named('导入 2 条').click();
  await page.getByText('已导入 2 条账号，跳过 2 条。').waitFor();
  assert.equal((await tableRows()).length, 3);
  assert.equal(await page.getByLabel('排序方式').inputValue(), 'number');

  const arrow = named('查看 GPT-002 详情');
  const targetSize = await arrow.boundingBox();
  assert(targetSize.width >= 50 && targetSize.height >= 49);
  await arrow.click({position: {x: 4, y: 4}});
  await details.getByRole('heading', {name: 'imported@example.com'}).waitFor();
  await named('显示密码').click();
  await details.getByText('key----inside', {exact: true}).waitFor();
  await named('显示验证码').click();
  await details.getByText(/^\d{3} \d{3}$/).waitFor();
  await page.keyboard.press('Escape');

  const from = page.getByTitle('查看 next@example.com');
  const top = page.locator('tbody tr').first();
  await from.scrollIntoViewIfNeeded();
  const start = await from.boundingBox();
  const end = await top.boundingBox();
  await page.mouse.move(start.x + 12, start.y + start.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(360);
  await page.mouse.move(start.x + 12, end.y + 6, {steps: 8});
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('tbody tr')?.textContent?.includes('next@example.com'));
  await page.getByLabel('排序方式').selectOption('number');
  await page.waitForFunction(() => document.querySelector('tbody tr')?.textContent?.includes('legacy@example.com'));
  await page.getByLabel('排序方式').selectOption('manual');
  await page.waitForFunction(() => document.querySelector('tbody tr')?.textContent?.includes('next@example.com'));
  await named('移动 GPT-003').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr')[1]?.textContent?.includes('next@example.com'));
  assert(!(await details.isVisible()));
  await page.screenshot({path: join(output, 'account-desk.png'), fullPage: true});

  await page.getByRole('navigation').getByRole('button', {name: '设置与备份'}).click();
  await named('撤销信任').waitFor();
  await named('自动查找').click();
  await page.getByText('已找到 Codex CLI。', {exact: true}).waitFor();
  await page.getByText(/回到账号簿/).waitFor();
  await page.screenshot({path: join(output, 'codex-setup.png'), fullPage: true});
  const file = await readFile(join(data, 'trusted-device.dat'));
  assert(file.length > 32 && !file.includes(Buffer.from(master)) && !file.includes(Buffer.from(secret)));

  await named('锁定').click();
  await gate('解锁账号库').waitFor();
  await named('使用本机解锁').click();
  await gate('账号台账').waitFor();
  console.log('PASS: preview and import, status defaults, drag and keyboard order, enlarged details, CLI detection and device unlock');
} else if (mode === 'restart') {
  await gate('账号台账').waitFor();
  const rows = await tableRows();
  assert(rows[0].includes(existing) && rows[1].includes('next@example.com') && rows[2].includes('imported@example.com'));
  assert.equal(await page.getByLabel('排序方式').inputValue(), 'manual');
  await page.getByRole('navigation').getByRole('button', {name: '设置与备份'}).click();
  await named('撤销信任').click();
  await named('信任此设备').waitFor();
  await named('锁定').click();
  await gate('解锁账号库').waitFor();
  assert.equal(await named('使用本机解锁').count(), 0);
  console.log('PASS: startup auto-unlock, persisted manual order, and trust revocation');
} else if (mode === 'revoked') {
  await gate('解锁账号库').waitFor();
  assert.equal(await named('使用本机解锁').count(), 0);
  assert.equal(await named('查看示例台账').count(), 0);
  await page.getByLabel('主密码', {exact: true}).fill('Incorrect-for-qa');
  await named('解锁').click();
  await page.getByText('主密码不正确，或文件已损坏。', {exact: true}).waitFor();
  await page.getByLabel('主密码', {exact: true}).fill(master);
  await named('解锁').click();
  await gate('账号台账').waitFor();
  console.log('PASS: revocation survives restart and master password remains valid');
} else {
  throw new Error('Invalid test phase');
}
process.exit(0);
