/** Prepare an explicitly synthetic, isolated database for browser verification. */
import fs from 'node:fs';
import path from 'node:path';
import { createAnalyticsFixture } from '../tests/fixtures/analytics';
const folder = process.argv[2];
if (!folder || !path.isAbsolute(folder) || fs.existsSync(folder)) throw new Error('Supply a new absolute directory; existing data is never replaced.');
fs.mkdirSync(folder, { recursive: true });
process.env.ATLAS_DB = path.join(folder, 'private.sqlite');
process.env.ATLAS_DATA_ROOT = folder;
process.env.ATLAS_LIVE_DB = path.join(folder, 'absent-live.sqlite');
const { db } = await import('../src/lib/db');
const database = db({ create: true });
createAnalyticsFixture(folder, database);
// Fields needed by the pre-existing detail and source panels during browser navigation.
database.exec(`ALTER TABLE meeting_plans ADD COLUMN updated_at TEXT;
ALTER TABLE imports ADD COLUMN rows_read INTEGER DEFAULT 0;
ALTER TABLE imports ADD COLUMN rows_kept INTEGER DEFAULT 0;
ALTER TABLE imports ADD COLUMN error TEXT;
ALTER TABLE imports ADD COLUMN file_hash TEXT;
ALTER TABLE payroll ADD COLUMN recipients_march INTEGER;
ALTER TABLE payroll ADD COLUMN recipients_july INTEGER;
ALTER TABLE payroll ADD COLUMN cumulative_april REAL;
ALTER TABLE payroll ADD COLUMN cumulative_august REAL;
`);
database.close();
console.log(folder);
