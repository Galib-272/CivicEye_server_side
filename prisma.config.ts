import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Not required for `prisma generate`; required for migrate/diff commands.
    url: process.env['DATABASE_URL'],
  },
});
