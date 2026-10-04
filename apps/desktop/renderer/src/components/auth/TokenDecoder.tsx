import { isVariableReferenceOnly } from '@aegis/core';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { Button } from '../ui';
import { isSecretRef } from './SecretField';

type Decoded = Awaited<ReturnType<typeof api.tools.decodeJwt>>;

/** "Decode token" helper: shows the (non-secret) header and claims of a JWT. Decoding happens in the main process. */
export function TokenDecoder({ token }: { token: string }) {
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unresolved = token === '' || isVariableReferenceOnly(token);

  const decode = async () => {
    setBusy(true);
    setError(null);
    try {
      let text = token;
      // Decoding a stored token needs its plaintext: this is an explicit user action and is audited by the backend.
      if (isSecretRef(token)) text = await api.variables.revealSecret({ ref: token });
      setDecoded(await api.tools.decodeJwt({ token: text.replace(/^Bearer\s+/i, '').trim() }));
    } catch (e) {
      setDecoded(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="au-decoder">
      <Button size="sm" disabled={busy || unresolved} onClick={() => void decode()} title={unresolved ? 'Enter a token value (variables cannot be decoded here)' : 'Decode the token header and claims'}>
        Decode token
      </Button>
      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {decoded && (
        <div className="au-decoded">
          {decoded.expiresAt !== undefined && (
            <div className={decoded.expired ? 'au-expired' : 'au-dim'}>
              {decoded.expired ? 'Expired' : 'Expires'} {new Date(decoded.expiresAt * 1000).toLocaleString()}
            </div>
          )}
          <div className="au-dim">Header</div>
          <pre className="mono">{JSON.stringify(decoded.header, null, 2)}</pre>
          <div className="au-dim">Payload</div>
          <pre className="mono">{JSON.stringify(decoded.payload, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
