import type { Signal } from './types';
import { ACTIVITY_TTL_MS, normalizeSceneLifecycle } from './scene-lifecycle';

/** Work equipment expresses a dated, verified active event, never a historical report. */
export const SCENE_ACTIVITY_MAX_AGE_DAYS = ACTIVITY_TTL_MS.construction / 86_400_000;
export type SceneActivitySubject = Partial<Pick<Signal, 'live' | 'lifecycle' | 'publishedAt'>> | Signal['lifecycle'];
export function isCurrentSceneActivity(subject: SceneActivitySubject | null | undefined, now = Date.now()) {
  return normalizeSceneLifecycle(subject, now).activeActivity;
}
