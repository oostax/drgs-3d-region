import type { BuildingGeometryInput, PackedBuildingGeometry } from './building-detail-geometry';

type Pending = { resolve: (items: PackedBuildingGeometry[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** One worker per map. Bounded batches keep prefetch from blocking visible work. */
export class BuildingGeometryWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private serial = 0;
  private disposed = false;
  private failed = false;
  completed = 0;
  failure: string | null = null;
  constructor(private readonly factory = () => new Worker(new URL('./building-geometry.worker.ts', import.meta.url), { type: 'module', name: 'atlas-building-geometry' })) {}
  get available() { return !this.disposed && !this.failed && typeof Worker !== 'undefined'; }
  get busy() { return this.pending.size > 0; }
  build(inputs: BuildingGeometryInput[]): Promise<PackedBuildingGeometry[]> {
    if (this.disposed || this.failed) return Promise.reject(new Error('Building worker unavailable'));
    try {
      if (!this.worker) {
        this.worker = this.factory();
        this.worker.onmessage = ({ data }: MessageEvent<{ id: number; items?: PackedBuildingGeometry[]; error?: string }>) => {
          const pending = this.pending.get(data.id); if (!pending) return;
          this.pending.delete(data.id); clearTimeout(pending.timer);
          if (data.error || !data.items) { const message = data.error ?? 'Invalid worker response'; pending.reject(new Error(message)); this.fail(message); return; }
          this.completed += data.items.length; pending.resolve(data.items);
        };
        this.worker.onerror = event => { event.preventDefault(); this.fail(event.message || 'Worker startup failed'); };
        this.worker.onmessageerror = () => this.fail('Worker message could not be decoded');
      }
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.fail('Building worker timed out'), 15_000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.worker!.postMessage({ id, inputs }); } catch (error) { this.fail(String(error)); }
      });
    } catch (error) { this.fail(String(error)); return Promise.reject(error); }
  }
  private fail(message: string) { this.failed = true; this.failure = message; this.cancel(); }
  cancel() {
    this.worker?.terminate(); this.worker = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(this.failure ?? 'Building preparation cancelled')); }
    this.pending.clear();
  }
  dispose() { this.disposed = true; this.cancel(); }
}
