/**
 * Protocol adapter abstraction. HTTP is the first implementation
 * (`HttpProtocolClient` in `@aegis/http-client`). GraphQL, WebSocket and gRPC
 * clients can be added later by implementing this interface without touching
 * the HTTP execution layer.
 */
export interface ProtocolClient<Req = unknown, Res = unknown> {
  /** Stable protocol identifier, e.g. `http`, `graphql`, `websocket`, `grpc`. */
  readonly protocol: string;
  send(request: Req): Promise<Res>;
  cancel(requestId: string): Promise<void>;
}

/** Registry of protocol clients keyed by protocol id. */
export class ProtocolRegistry {
  private readonly clients = new Map<string, ProtocolClient>();

  register(client: ProtocolClient): void {
    this.clients.set(client.protocol, client);
  }

  get<T extends ProtocolClient = ProtocolClient>(protocol: string): T | undefined {
    return this.clients.get(protocol) as T | undefined;
  }

  list(): string[] {
    return [...this.clients.keys()];
  }
}
