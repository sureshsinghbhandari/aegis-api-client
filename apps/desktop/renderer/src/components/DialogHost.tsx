import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { Button, Modal } from './ui';

export function DialogHost() {
  const confirm = useUi((s) => s.confirmDialog);
  const prompt = useUi((s) => s.promptDialog);
  return (
    <>
      {confirm && (
        <Modal
          title={confirm.title}
          width={460}
          onClose={() => confirm.resolve(false)}
          footer={
            <>
              <Button onClick={() => confirm.resolve(false)}>Cancel</Button>
              <Button variant={confirm.danger ? 'danger' : 'primary'} onClick={() => confirm.resolve(true)} autoFocus>
                {confirm.confirmLabel ?? 'Confirm'}
              </Button>
            </>
          }
        >
          <p className="pre-wrap">{confirm.message}</p>
        </Modal>
      )}
      {prompt && <PromptDialog key={prompt.title + prompt.label} />}
    </>
  );
}

function PromptDialog() {
  const prompt = useUi((s) => s.promptDialog)!;
  const [value, setValue] = useState(prompt.initial ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const submit = () => value.trim() && prompt.resolve(value.trim());
  return (
    <Modal
      title={prompt.title}
      width={440}
      onClose={() => prompt.resolve(null)}
      footer={
        <>
          <Button onClick={() => prompt.resolve(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {prompt.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{prompt.label}</span>
        <input ref={input} autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
    </Modal>
  );
}

export function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
