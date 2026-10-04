import { randomBytes, randomInt, randomUUID } from 'node:crypto';

/**
 * Dynamic variables are resolved through providers so none are hard-coded in
 * the resolver. `name` includes the leading `$`, e.g. `$guid`.
 */
export interface DynamicVariableProvider {
  resolve(name: string): string | undefined;
}

export class DynamicVariableRegistry {
  private readonly providers: DynamicVariableProvider[] = [];

  register(provider: DynamicVariableProvider): this {
    this.providers.push(provider);
    return this;
  }

  resolve(name: string): string | undefined {
    for (const provider of this.providers) {
      const v = provider.resolve(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

/** Table-driven provider: name -> generator. */
export class TableDynamicProvider implements DynamicVariableProvider {
  constructor(private readonly table: Record<string, () => string>) {}
  resolve(name: string): string | undefined {
    const fn = Object.hasOwn(this.table, name) ? this.table[name] : undefined;
    return fn ? fn() : undefined;
  }
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn'];
const LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Garcia', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Clark'];

export const COMMON_DYNAMIC_VARIABLES: Record<string, () => string> = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1001)),
  $randomBoolean: () => (randomInt(0, 2) === 1 ? 'true' : 'false'),
  $randomAlphaNumeric: () => ALNUM[randomInt(0, ALNUM.length)]!,
  $randomHexColor: () => `#${randomBytes(3).toString('hex')}`,
  $randomIP: () => [1, 2, 3, 4].map(() => randomInt(1, 255)).join('.'),
  $randomFirstName: () => FIRST_NAMES[randomInt(0, FIRST_NAMES.length)]!,
  $randomLastName: () => LAST_NAMES[randomInt(0, LAST_NAMES.length)]!,
  $randomEmail: () => `${randomBytes(4).toString('hex')}@example.com`,
  $randomPassword: () => randomBytes(9).toString('base64url'),
};

export function createDefaultDynamicRegistry(): DynamicVariableRegistry {
  return new DynamicVariableRegistry().register(new TableDynamicProvider(COMMON_DYNAMIC_VARIABLES));
}
