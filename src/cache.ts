import type { ProcedureMapping } from './types';

export class NavigationCache {
  private cache: ProcedureMapping | null = null;
  private lastUpdate = 0;
  private cacheTimeout: number;

  constructor(cacheTimeout = 30000) {
    this.cacheTimeout = cacheTimeout;
  }

  get(): ProcedureMapping | null {
    if (this.cache && Date.now() - this.lastUpdate < this.cacheTimeout) {
      return this.cache;
    }
    return null;
  }

  set(mapping: ProcedureMapping): void {
    this.cache = mapping;
    this.lastUpdate = Date.now();
  }

  clear(): void {
    this.cache = null;
    this.lastUpdate = 0;
  }

  isValid(): boolean {
    return this.cache !== null && Date.now() - this.lastUpdate < this.cacheTimeout;
  }
}
