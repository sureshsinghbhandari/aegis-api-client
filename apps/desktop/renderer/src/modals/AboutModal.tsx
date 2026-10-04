import { policySummary } from '../lib/settings-helpers';
import { Badge, Button, Modal } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

export default function AboutModal(_p: ModalComponentProps) {
  const info = useApp((s) => s.info);
  const close = () => useUi.getState().closeModal();
  return (
    <Modal
      title="About"
      width={580}
      onClose={close}
      footer={
        <>
          <Button onClick={() => useUi.getState().openModal('settings', { section: 'security' })}>Security settings</Button>
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      {!info ? (
        <p className="field-hint">Application information is not available.</p>
      ) : (
        <>
          <div className="about-head">
            <div className="about-logo" aria-hidden="true">
              ◆
            </div>
            <div>
              <h3>{info.name}</h3>
              <div className="field-hint">
                Version {info.version} · {info.platform}
              </div>
            </div>
          </div>
          <dl className="about-list">
            <dt>Data directory</dt>
            <dd className="mono">{info.dataDir}</dd>
            <dt>Secret storage</dt>
            <dd>
              {info.secretStorageAvailable ? <Badge tone="success">Available</Badge> : <Badge tone="danger">Unavailable</Badge>} {info.secretStorage}
            </dd>
            <dt>Privacy</dt>
            <dd>
              {info.localOnly ? <Badge tone="success">Local-only mode on</Badge> : <Badge tone="warning">Local-only mode off</Badge>} No telemetry, analytics, cloud sync or crash reporting. Your data stays on this computer; only the requests you send leave it.
            </dd>
            <dt>Organization policy</dt>
            <dd>
              <ul className="about-policy">
                {policySummary(info.policy).map((l) => (
                  <li key={l.label}>
                    {l.label}: <strong>{l.value}</strong>
                    {l.enforced && <span className="field-hint"> (enforced)</span>}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Roadmap</dt>
            <dd>OpenAPI, GraphQL, WebSocket, gRPC are not implemented yet.</dd>
          </dl>
        </>
      )}
    </Modal>
  );
}
