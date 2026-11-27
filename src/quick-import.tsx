import { ClipboardPaste } from 'lucide-react';
import { useState } from 'react';
import type { ImportResult } from './domain';
import { Button, Modal } from './ui';

export function QuickImport({busy, close, inspect, commit}: {
  busy: boolean; close: () => void; inspect: (input: string) => Promise<ImportResult | undefined>;
  commit: (input: string) => Promise<ImportResult | undefined>;
}) {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<ImportResult>();
  const [error, setError] = useState('');
  async function run(save: boolean) {
    setError('');
    try {
      const result = await (save ? commit : inspect)(input);
      if (result) setPreview(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <Modal title="快速导入账号" close={close} variant="editor-modal">
    <div className="modal-body import-body">
      <p>每行一个账号，按 <code>邮箱----密码----2FA</code> 粘贴。2FA 可填 Base32 密钥或验证器链接，留空时保留最后四个连字符。</p>
      <label className="field"><span>导入文本</span><textarea autoFocus rows={7} spellCheck={false} autoComplete="off"
        maxLength={512 * 1024} value={input} onChange={event => {setInput(event.target.value); setPreview(undefined); setError('');}}
        placeholder="name@example.com----你的密码----" disabled={busy}/></label>
      {preview && <div className="import-preview" aria-live="polite">
        <strong>可添加 {preview.count} 条，跳过 {preview.issues.length} 条</strong>
        {preview.issues.length > 0 && <ul>{preview.issues.map(issue => <li key={issue.line}>第 {issue.line} 行 · {issue.reason}</li>)}</ul>}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer">
      <Button onClick={close}>取消</Button>
      <Button kind={preview ? 'secondary' : 'primary'} disabled={busy || !input.trim()} onClick={() => void run(false)}>检查格式</Button>
      {!!preview?.count && <Button kind="primary" disabled={busy} onClick={() => void run(true)}><ClipboardPaste size={16}/> 导入 {preview.count} 条</Button>}
    </div>
  </Modal>;
}
