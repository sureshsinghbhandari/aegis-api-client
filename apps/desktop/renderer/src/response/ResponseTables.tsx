import type { ResponseView } from '@aegis/core';
import { Button } from '../components/ui';
import { copyText } from './useResponseBody';

export function HeadersView({ response }: { response: ResponseView }) {
  if (response.headers.length === 0) return <div className="empty">No response headers.</div>;
  const all = response.headers.map((h) => `${h.name}: ${h.value}`).join('\n');
  return (
    <div className="rv-scroll">
      <div className="rv-toolbar">
        <span className="wb-dim">
          {response.headers.length} headers · {response.httpVersion}
        </span>
        <span className="wb-spacer" />
        <Button size="sm" onClick={() => void copyText(all, 'Headers copied')}>
          Copy all
        </Button>
      </div>
      <table className="rv-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {response.headers.map((h, i) => (
            <tr key={i}>
              <td className="mono rv-key">{h.name}</td>
              <td className="mono pre-wrap">{h.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CookiesView({ response }: { response: ResponseView }) {
  if (response.cookies.length === 0) return <div className="empty">This response did not set any cookies.</div>;
  return (
    <div className="rv-scroll">
      <table className="rv-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Domain</th>
            <th>Path</th>
            <th>Expires</th>
            <th>Secure</th>
            <th>HttpOnly</th>
            <th>SameSite</th>
          </tr>
        </thead>
        <tbody>
          {response.cookies.map((c, i) => (
            <tr key={i}>
              <td className="mono rv-key">{c.name}</td>
              <td className="mono pre-wrap">{c.value}</td>
              <td>{c.domain ?? ''}</td>
              <td>{c.path ?? ''}</td>
              <td>{c.expires ?? 'Session'}</td>
              <td>{c.secure ? 'Yes' : 'No'}</td>
              <td>{c.httpOnly ? 'Yes' : 'No'}</td>
              <td>{c.sameSite ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
