import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/storage/src/schema.ts',
  out: './database/migrations',
});
