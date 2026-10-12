import type { AuthConfig, OAuth2DeviceStart } from '@aegis/core';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useApp } from '../../store/app';
import { Button } from '../ui';
import type { OAuthContext } from './OAuth2Fields';

/**
 * OAuth 2.0 device authorization grant (RFC 8628) driven from the renderer: start the flow, show
 * the user code and verification URI, poll the token endpoint with the server's interval (and
 * `slow_down` backoff) until a token arrives, the code expires or the user cancels. The device code
 * lives only in component state and is never displayed or stored.
 */

export interface DeviceFlowState {
  phase: 'idle' | 'starting' | 'waiting';
  device?: Omit<OAuth2DeviceStart, 'deviceCode'>;
  error: string | null;
}

export function useDeviceCodeFlow(auth: AuthConfig, workspaceId: string, context: OAuthContext | undefined, onToken: (params: Record<string, string | number | boolean>) => void) {
  const [state, setState] = useState<DeviceFlowState>({ phase: 'idle', error: null });
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const cancel = () => {
    stop();
    setState({ phase: 'idle', error: null });
  };

  const start = async () => {
    stop();
    const id = run.current;
    const scope = {
      auth,
      workspaceId,
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.collectionId ? { collectionId: context.collectionId } : {}),
      ...(context?.folderId ? { folderId: context.folderId } : {}),
    };
    setState({ phase: 'starting', error: null });
    try {
      const started = await api.tools.oauth2DeviceStart(scope);
      if (id !== run.current) return;
      const { deviceCode, ...device } = started;
      setState({ phase: 'waiting', device, error: null });
      const deadline = Date.now() + device.expiresIn * 1000;
      let interval = device.interval;
      const poll = async () => {
        if (id !== run.current) return;
        if (Date.now() > deadline) {
          setState({ phase: 'idle', error: 'The device code expired before the sign-in was completed. Start again.' });
          return;
        }
        try {
          const outcome = await api.tools.oauth2DevicePoll({ ...scope, deviceCode, interval });
          if (id !== run.current) return;
          if (outcome.status === 'done') {
            stop();
            setState({ phase: 'idle', error: null });
            onToken(outcome.params);
            useApp.getState().toast('Access token received', 'success');
            return;
          }
          interval = outcome.interval;
          timer.current = setTimeout(() => void poll(), Math.max(1, interval) * 1000);
        } catch (e) {
          if (id !== run.current) return;
          stop();
          setState({ phase: 'idle', error: errorMessage(e) });
        }
      };
      timer.current = setTimeout(() => void poll(), Math.max(1, interval) * 1000);
    } catch (e) {
      if (id !== run.current) return;
      setState({ phase: 'idle', error: errorMessage(e) });
    }
  };

  return { state, start, cancel };
}

export function DeviceCodePanel({ state, onCancel }: { state: DeviceFlowState; onCancel(): void }) {
  if (state.phase === 'idle') return null;
  const d = state.device;
  return (
    <div className="au-device" role="status">
      {state.phase === 'starting' && <div className="field-hint">Requesting a device code...</div>}
      {state.phase === 'waiting' && d && (
        <>
          <div>
            Open <span className="mono au-device-uri">{d.verificationUriComplete ?? d.verificationUri}</span> on any device and enter the code
          </div>
          <div className="au-device-code mono" aria-label="User code">
            {d.userCode}
          </div>
          <div className="field-hint">Waiting for you to complete the sign-in (polling every {d.interval} s; the code expires in {Math.round(d.expiresIn / 60)} min).</div>
        </>
      )}
      <div>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
