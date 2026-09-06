import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {'/*':['./private-data/**/*','./data/public/**/*','./data/live/*.sqlite*','./data/live/raw/**/*','./data/live/cache/**/*','./artifacts/**/*','./public/data/*.pmtiles']},
  outputFileTracingIncludes: {'/api/*':['./scripts/**/*.py','./scripts/live/schema.sql','./config/*.json']},
  serverExternalPackages: ['better-sqlite3'],
  devIndicators: false,
};
export default config;
