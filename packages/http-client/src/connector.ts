import { isIP, type Socket } from 'node:net';
import { promises as dns, type LookupAddress } from 'node:dns';
import type { TLSSocket, PeerCertificate } from 'node:tls';
import { createHash } from 'node:crypto';
import { buildConnector } from 'undici';
import type { ConnectionInfo, TlsConnectionInfo } from '@aegis/core';

/** What the connector observed while establishing one connection. Never contains key material. */
export interface ObservedConnection {
  /** `protocol//host:port` of the origin the connection was made for. */
  origin: string;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  /** `HTTP/2` or `HTTP/1.1` (from ALPN; plain http is always 1.1 here). */
  httpVersion: string;
  tls?: TlsConnectionInfo;
  connection: ConnectionInfo;
}

export interface TimedConnectorOptions {
  /** Options forwarded to undici's `buildConnector` (TLS material, rejectUnauthorized, ...). */
  tls: Record<string, unknown>;
  allowH2: boolean;
  preferH2?: boolean;
  /** Host name -> IP literal; consulted before DNS. Keys are compared case-insensitively. */
  hosts?: Record<string, string>;
  /** Receives every established connection, in order. */
  onConnection(info: ObservedConnection): void;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type LookupOptions = { all?: boolean; family?: number | string; hints?: number };

interface LookupTiming {
  startedAt?: number;
  finishedAt?: number;
  override?: string;
}

function normalizeHosts(hosts: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [host, address] of Object.entries(hosts ?? {})) {
    const h = host.trim().toLowerCase().replace(/\.$/, '');
    const a = address.trim().replace(/^\[|\]$/g, '');
    if (h && isIP(a)) map.set(h, a);
  }
  return map;
}

function timedLookup(hosts: Map<string, string>, timing: LookupTiming) {
  return (hostname: string, options: LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts: LookupOptions = typeof options === 'object' && options !== null ? options : {};
    const override = hosts.get(hostname.toLowerCase().replace(/\.$/, ''));
    timing.startedAt = performance.now();
    if (override) {
      timing.override = override;
      timing.finishedAt = timing.startedAt;
      const family = isIP(override);
      queueMicrotask(() => (opts.all ? callback(null, [{ address: override, family }]) : callback(null, override, family)));
      return;
    }
    const family = typeof opts.family === 'number' ? opts.family : opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : 0;
    const lookupOptions = { ...(family ? { family } : {}), ...(opts.hints !== undefined ? { hints: opts.hints } : {}), all: true as const };
    dns
      .lookup(hostname, lookupOptions)
      .then((addresses) => {
        timing.finishedAt = performance.now();
        if (opts.all) callback(null, addresses);
        else {
          const first = addresses[0];
          if (!first) callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '');
          else callback(null, first.address, first.family);
        }
      })
      .catch((err: NodeJS.ErrnoException) => {
        timing.finishedAt = performance.now();
        callback(err, '');
      });
  };
}

function iso(value: string | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function dn(subject: PeerCertificate['subject'] | undefined): string {
  if (!subject || typeof subject !== 'object') return '';
  return Object.entries(subject)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : String(v)}`)
    .join(', ');
}

/** Read protocol, cipher and the peer certificate's public fields from a connected TLS socket. */
export function describeTlsSocket(socket: TLSSocket): TlsConnectionInfo {
  const cipher = socket.getCipher();
  const info: TlsConnectionInfo = {
    protocol: socket.getProtocol() ?? '',
    cipher: cipher?.name ?? '',
    alpn: typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : '',
    authorized: socket.authorized,
  };
  let cert: PeerCertificate | undefined;
  try {
    cert = socket.getPeerCertificate(false);
  } catch {
    cert = undefined;
  }
  if (cert && cert.subject && Object.keys(cert).length > 0) {
    const fingerprint = cert.fingerprint256 || (cert.raw ? createHash('sha256').update(cert.raw).digest('hex').replace(/(..)(?=.)/g, '$1:').toUpperCase() : '');
    info.peerCertificate = {
      subject: dn(cert.subject),
      issuer: dn(cert.issuer),
      validFrom: iso(cert.valid_from),
      validTo: iso(cert.valid_to),
      fingerprint,
      ...(cert.subjectaltname ? { subjectAltName: cert.subjectaltname } : {}),
    };
  }
  return info;
}

/**
 * undici connector that (1) applies host overrides at lookup time, (2) measures DNS / TCP / TLS
 * phases and (3) reports the negotiated ALPN protocol and TLS parameters of every connection.
 */
export function createTimedConnector(options: TimedConnectorOptions): buildConnector.connector {
  const hosts = normalizeHosts(options.hosts);
  return (connectOptions, callback) => {
    const timing: LookupTiming = {};
    const inner = buildConnector({
      ...(options.tls as buildConnector.BuildOptions),
      allowH2: options.allowH2,
      ...(options.preferH2 ? { preferH2: true } : {}),
      lookup: timedLookup(hosts, timing),
    } as buildConnector.BuildOptions);
    const t0 = performance.now();
    let connectedAt: number | undefined;
    const socket = inner(connectOptions, (err, sock) => {
      if (err || !sock) {
        callback(err ?? new Error('connection failed'), null);
        return;
      }
      const doneAt = performance.now();
      const tcpDone = connectedAt ?? doneAt;
      const dnsEnd = timing.finishedAt ?? timing.startedAt ?? t0;
      const isTls = connectOptions.protocol === 'https:';
      const tlsInfo = isTls ? describeTlsSocket(sock as TLSSocket) : undefined;
      const alpn = tlsInfo?.alpn ?? '';
      options.onConnection({
        origin: `${connectOptions.protocol}//${connectOptions.hostname}:${connectOptions.port}`,
        dnsMs: timing.finishedAt !== undefined && timing.startedAt !== undefined ? Math.max(0, Math.round(timing.finishedAt - timing.startedAt)) : 0,
        connectMs: Math.max(0, Math.round(tcpDone - dnsEnd)),
        tlsMs: isTls ? Math.max(0, Math.round(doneAt - tcpDone)) : 0,
        httpVersion: alpn === 'h2' ? 'HTTP/2' : 'HTTP/1.1',
        ...(tlsInfo ? { tls: tlsInfo } : {}),
        connection: {
          remoteAddress: sock.remoteAddress ?? '',
          remotePort: sock.remotePort ?? 0,
          localAddress: sock.localAddress ?? '',
          localPort: sock.localPort ?? 0,
          ...(timing.override ? { hostOverride: timing.override } : {}),
          reused: false,
        },
      });
      callback(null, sock);
    }) as Socket | undefined;
    // `connect` fires before `secureConnect`, so it marks the end of the TCP phase for both http and https.
    socket?.once('connect', () => {
      connectedAt = performance.now();
    });
  };
}
