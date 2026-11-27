import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

const executable = process.argv[2];
const testRoot = resolve(process.argv[3]);
const env = {...process.env};
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'CODEX_HOME_OVERRIDE']) delete env[key];

async function isolatedProfile(name) {
  const home = join(testRoot, name);
  await mkdir(home, {recursive: true});
  const child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="keyring"'],
    {cwd: home, env: {...env, CODEX_HOME: home}, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  const replies = new Map();
  let sequence = 0;
  createInterface({input: child.stdout}).on('line', line => {
    try {
      const parsed = JSON.parse(line);
      const reply = replies.get(parsed.id);
      if (reply) {
        replies.delete(parsed.id);
        reply(parsed);
      }
    } catch {
      // Diagnostics can share stdout across CLI builds.
    }
  });
  async function call(method, params) {
    const id = ++sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out on ' + method)), 20_000);
      replies.set(id, message => {clearTimeout(timer); accept(message);});
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }

  try {
    const handshake = await call('initialize', {clientInfo: {name: 'account_desk', title: 'Account Desk', version: '0.1.0'}});
    assert(handshake.result && !handshake.error);
    child.stdin.write('{"method":"initialized"}\n');
    const state = await call('account/read', {refreshToken: false});
    assert.equal(state.result?.account, null, 'An isolated profile must start without an existing account');
    const online = await call('account/rateLimits/read');
    assert(online.error && !online.result, 'Unsigned profile must report a rate-limit auth error');
    console.log(name + ': isolated profile starts unsigned; rate-limit read returns an error');
    if (name === 'profile-a' && process.argv.includes('--prepare-login')) {
      const login = await call('account/login/start', {type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex'});
      const url = new URL(login.result?.authUrl);
      assert.equal(url.protocol, 'https:');
      assert(['auth.openai.com', 'chatgpt.com'].includes(url.hostname));
      const cancel = await call('account/login/cancel', {loginId: login.result.loginId});
      assert(cancel.result && !cancel.error);
      console.log(name + ': managed login URL and startup cancellation verified');
    }
    const logout = await call('account/logout');
    assert(logout.result && !logout.error, 'Rollback of an unsigned profile must be possible');
    await assert.rejects(readFile(join(home, 'auth.json')), error => error.code === 'ENOENT');
  } finally {
    child.kill();
  }
}
await isolatedProfile('profile-a');
await isolatedProfile('profile-b');
