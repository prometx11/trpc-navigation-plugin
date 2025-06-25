import { expect, test, describe, beforeEach } from 'bun:test';
import { NavigationCache } from '../src/cache';

describe('NavigationCache', () => {
  let cache: NavigationCache;

  beforeEach(() => {
    cache = new NavigationCache(1000); // 1 second timeout for tests
  });

  test('should store and retrieve mapping', () => {
    const mapping = {
      'api.users.getUser': { fileName: '/path/to/file.ts', line: 10, column: 5 }
    };

    cache.set(mapping);
    expect(cache.get()).toEqual(mapping);
  });

  test('should return null when cache is empty', () => {
    expect(cache.get()).toBeNull();
  });

  test('should return null when cache expires', async () => {
    const mapping = {
      'api.users.getUser': { fileName: '/path/to/file.ts', line: 10, column: 5 }
    };

    cache.set(mapping);
    expect(cache.get()).toEqual(mapping);

    // Wait for cache to expire
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(cache.get()).toBeNull();
  });

  test('should clear cache', () => {
    const mapping = {
      'api.users.getUser': { fileName: '/path/to/file.ts', line: 10, column: 5 }
    };

    cache.set(mapping);
    expect(cache.get()).toEqual(mapping);

    cache.clear();
    expect(cache.get()).toBeNull();
  });

  test('should validate cache state', () => {
    expect(cache.isValid()).toBe(false);

    cache.set({});
    expect(cache.isValid()).toBe(true);

    cache.clear();
    expect(cache.isValid()).toBe(false);
  });
});