export type SkillCacheStatus = "hit" | "miss" | "single-flight";

export interface SkillCacheLookup<T> {
  value: T;
  status: SkillCacheStatus;
}

export interface SkillCacheStats {
  hits: number;
  misses: number;
  singleFlightHits: number;
  evictions: number;
  size: number;
  maxEntries: number;
  weight: number;
  maxWeight?: number;
}

export interface SkillCacheOptions<T> {
  maxWeight?: number;
  measure?: (value: T) => number;
}

export class SkillCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private hitCount = 0;
  private missCount = 0;
  private singleFlightHitCount = 0;
  private evictionCount = 0;
  private totalWeight = 0;
  private readonly maxWeight: number | undefined;
  private readonly measure: (value: T) => number;

  constructor(readonly maxEntries: number, options: SkillCacheOptions<T> = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("SkillCache maxEntries must be a positive integer");
    }
    if (options.maxWeight !== undefined && (!Number.isFinite(options.maxWeight) || options.maxWeight <= 0)) {
      throw new RangeError("SkillCache maxWeight must be a positive number");
    }
    this.maxWeight = options.maxWeight;
    this.measure = options.measure ?? (() => 1);
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    if (!this.entries.has(key)) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    return this.touch(key);
  }

  set(key: string, value: T): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) this.totalWeight -= this.measure(previous);
    this.entries.delete(key);
    const valueWeight = this.measure(value);
    if (this.maxWeight !== undefined && valueWeight > this.maxWeight) return;
    this.entries.set(key, value);
    this.totalWeight += valueWeight;
    while (
      this.entries.size > this.maxEntries
      || (this.maxWeight !== undefined && this.totalWeight > this.maxWeight && this.entries.size > 1)
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest !== undefined) this.totalWeight -= this.measure(oldest);
      this.entries.delete(oldestKey);
      this.evictionCount += 1;
    }
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) return false;
    this.totalWeight -= this.measure(value);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.totalWeight = 0;
  }

  async getOrCreate(key: string, create: () => T | Promise<T>): Promise<T> {
    return (await this.getOrCreateWithStatus(key, create)).value;
  }

  async getOrCreateWithStatus(
    key: string,
    create: () => T | Promise<T>,
  ): Promise<SkillCacheLookup<T>> {
    if (this.entries.has(key)) {
      this.hitCount += 1;
      return { value: this.touch(key), status: "hit" };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.hitCount += 1;
      this.singleFlightHitCount += 1;
      return { value: await pending, status: "single-flight" };
    }

    this.missCount += 1;
    const flight = Promise.resolve().then(create);
    this.inFlight.set(key, flight);
    try {
      const value = await flight;
      if (this.inFlight.get(key) === flight) this.set(key, value);
      return { value, status: "miss" };
    } finally {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    }
  }

  stats(): Readonly<SkillCacheStats> {
    return Object.freeze({
      hits: this.hitCount,
      misses: this.missCount,
      singleFlightHits: this.singleFlightHitCount,
      evictions: this.evictionCount,
      size: this.entries.size,
      maxEntries: this.maxEntries,
      weight: this.totalWeight,
      ...(this.maxWeight !== undefined ? { maxWeight: this.maxWeight } : {}),
    });
  }

  private touch(key: string): T {
    const value = this.entries.get(key) as T;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
}
