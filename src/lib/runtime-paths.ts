import fs from 'node:fs';
import path from 'node:path';

/** Mutable data must survive Next standalone's process.chdir(__dirname). */
export function resolveRuntimeRoots(cwd = process.cwd(), env: Record<string, string | undefined> = process.env) {
  const standaloneParent = path.basename(cwd) === 'standalone' && path.basename(path.dirname(cwd)) === '.next'
    ? path.resolve(cwd, '../..') : cwd;
  const checkout = fs.existsSync(/* turbopackIgnore: true */ path.join(standaloneParent, 'scripts', 'import_xlsx.py')) ? standaloneParent : cwd;
  for (const key of ['ATLAS_DATA_ROOT', 'ATLAS_APP_ROOT', 'ATLAS_DB', 'ATLAS_LIVE_DB']) {
    if (env[key] && !path.isAbsolute(env[key]!)) throw new Error(`${key} должен быть абсолютным путём`);
  }
  return { dataRoot: env.ATLAS_DATA_ROOT || checkout, appRoot: env.ATLAS_APP_ROOT || checkout };
}

export const {dataRoot, appRoot} = resolveRuntimeRoots();
export const dataPath = (...parts: string[]) => path.join(dataRoot, ...parts);
export const appPath = (...parts: string[]) => path.join(appRoot, ...parts);
export function publicDataPath(name: string) {
  const mutable = dataPath('public', 'data', name);
  return fs.existsSync(/* turbopackIgnore: true */ mutable) ? mutable : appPath('public', 'data', name);
}
