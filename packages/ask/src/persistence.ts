import { CaseStore } from "../../integrations/src/data.js";
/** Optional chat persistence must not make Elasticsearch-only answers depend on Atlas uptime. */
export class AskPersistence {
  private cache = new Map<string, object>();
  private pending = new Set<string>();
  private unavailableUntil = 0;
  constructor(private store: CaseStore) {}
  get degraded() {
    return Date.now() < this.unavailableUntil;
  }
  markUnavailable() {
    this.unavailableUntil = Date.now() + 30_000;
  }
  async save(kind: string, id: string, value: object) {
    const key = `${kind}:${id}`;
    if (!this.cache.has(key) && this.cache.size >= 5000) {
      const durable = [...this.cache.keys()].find((k) => !this.pending.has(k));
      if (durable) this.cache.delete(durable);
      else throw new Error("Temporary chat capacity reached");
    }
    this.cache.set(key, structuredClone(value));
    if (this.degraded) {
      this.pending.add(key);
      return;
    }
    try {
      await this.store.saveExtra(kind, id, value);
      this.pending.delete(key);
    } catch {
      this.markUnavailable();
      this.pending.add(key);
    }
  }
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    const key = `${kind}:${id}`;
    if (this.degraded || this.pending.has(key))
      return structuredClone(this.cache.get(key)) as T | undefined;
    try {
      return await this.store.getExtra<T>(kind, id);
    } catch {
      this.markUnavailable();
      return structuredClone(this.cache.get(key)) as T | undefined;
    }
  }
  async delete(kind: string, id: string) {
    const key = `${kind}:${id}`;
    // A failed durable delete must not be reported as completed.
    await this.store.deleteExtra(kind, id);
    this.cache.delete(key);
    this.pending.delete(key);
  }
  async maintain() {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      const expiry = (value as { expiresAt?: string }).expiresAt;
      if (expiry && Date.parse(expiry) <= now) {
        this.cache.delete(key);
        this.pending.delete(key);
      }
    }
    if (this.degraded) return;
    for (const key of [...this.pending]) {
      const split = key.indexOf(":"),
        value = this.cache.get(key);
      if (value)
        await this.save(key.slice(0, split), key.slice(split + 1), value);
      if (this.degraded) break;
    }
    await this.store.pruneAskHistory();
  }
}
