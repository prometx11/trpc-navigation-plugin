import type { ProcedureMapping } from "./types";

export class NavigationCache {
  private cache: ProcedureMapping | null = null;
  private lastUpdate = 0;
  private cacheTimeout: number;
  private fileHashes: Map<string, string> = new Map();
  private logger?: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
  };

  constructor(
    cacheTimeout = 30000,
    logger?: { debug: (msg: string) => void; info: (msg: string) => void },
  ) {
    this.cacheTimeout = cacheTimeout;
    this.logger = logger;
  }

  get(): ProcedureMapping | null {
    if (this.isValid()) {
      this.logger?.debug("Cache hit - returning cached mapping");
      return this.cache;
    }
    this.logger?.debug("Cache miss - cache is invalid or expired");
    return null;
  }

  set(mapping: ProcedureMapping): void {
    this.cache = mapping;
    this.lastUpdate = Date.now();

    // Store file hashes for all files in the mapping
    this.fileHashes.clear();
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const uniqueFiles = new Set<string>();

    Object.values(mapping).forEach((target) => {
      uniqueFiles.add(target.fileName);
    });

    uniqueFiles.forEach((fileName) => {
      try {
        const content = fs.readFileSync(fileName, "utf8");
        const hash = crypto.createHash("md5").update(content).digest("hex");
        this.fileHashes.set(fileName, hash);
        const relativePath = require("path").relative(process.cwd(), fileName);
        this.logger?.info(
          `Tracking file for changes: ${relativePath} (hash: ${hash.substring(0, 8)}...)`,
        );
      } catch (e) {
        // File might not exist or be accessible
        this.logger?.debug(`Failed to hash file ${fileName}: ${e}`);
      }
    });
  }

  clear(): void {
    this.cache = null;
    this.lastUpdate = 0;
    this.fileHashes.clear();
  }

  isValid(): boolean {
    if (this.cache === null) {
      this.logger?.debug("Cache invalid: cache is null");
      return false;
    }

    const timeSinceUpdate = Date.now() - this.lastUpdate;
    if (timeSinceUpdate >= this.cacheTimeout) {
      this.logger?.debug(
        `Cache expired due to timeout (${timeSinceUpdate}ms >= ${this.cacheTimeout}ms)`,
      );
      return false;
    }

    // Check if any watched files have been modified by comparing hashes
    const fs = require("node:fs");
    const crypto = require("node:crypto");

    this.logger?.debug(
      `Checking ${this.fileHashes.size} file hashes for changes...`,
    );

    for (const [fileName, lastHash] of this.fileHashes) {
      try {
        const content = fs.readFileSync(fileName, "utf8");
        const currentHash = crypto
          .createHash("md5")
          .update(content)
          .digest("hex");
        this.logger?.debug(
          `Hash check for ${fileName}: ${lastHash} -> ${currentHash}`,
        );
        if (currentHash !== lastHash) {
          // File content has changed, cache is invalid
          this.logger?.info(
            `Cache invalidated: file content changed - ${fileName}`,
          );
          this.logger?.debug(`Hash mismatch: ${lastHash} -> ${currentHash}`);
          return false;
        }
      } catch (e) {
        // File might have been deleted or moved
        this.logger?.info(
          `Cache invalidated: file not accessible - ${fileName}: ${e}`,
        );
        return false;
      }
    }

    this.logger?.debug("Cache is still valid - no file changes detected");
    return true;
  }
}
