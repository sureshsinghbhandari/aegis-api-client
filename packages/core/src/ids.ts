/** Opaque string identifiers. UUIDv4 via the platform CSPRNG. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
