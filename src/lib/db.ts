import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './runtime-paths';

const globalDatabase = globalThis as unknown as { atlasDatabase?: Database.Database };
export const privateDirectory = dataPath('private-data');
export const databasePath = process.env.ATLAS_DB || path.join(privateDirectory,'atlas.sqlite');

export class LocalDataUnavailable extends Error {
  readonly status = 503;
  constructor() { super('Локальные данные не подключены. Проверьте каталог данных или выполните импорт.'); }
}
export function db(options: {create?: boolean} = {}) {
  if (globalDatabase.atlasDatabase) return globalDatabase.atlasDatabase;
  if (!options.create && !fs.existsSync(/* turbopackIgnore: true */ databasePath)) throw new LocalDataUnavailable();
  if (options.create) fs.mkdirSync(path.dirname(databasePath), {recursive:true, mode:0o700});
  const database = new Database(databasePath, {fileMustExist: !options.create});
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 10000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS saved_dossiers (id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, territory_id TEXT NOT NULL, content_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, error TEXT);
  `);
  globalDatabase.atlasDatabase = database;
  return database;
}
export function hasTable(name: string) {
  return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
export function all<T>(sql:string, ...params: (string|number|null)[]): T[] { return db().prepare(sql).all(...params) as T[]; }
export function one<T>(sql:string, ...params: (string|number|null)[]): T|undefined { return db().prepare(sql).get(...params) as T|undefined; }
export function safeJson<T>(value: string|null|undefined, fallback:T):T { try{return value ? JSON.parse(value) as T : fallback;}catch{return fallback;} }
