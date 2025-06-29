import type * as ts from 'typescript/lib/tsserverlibrary';

export interface NavigationTarget {
  fileName: string;
  line: number;
  column: number;
  position?: number;
  length?: number;
  type?: 'procedure' | 'inline-procedure' | 'router';
  procedureName?: string;
}

export interface ProcedureMapping {
  [apiPath: string]: NavigationTarget;
}

export interface PluginConfig {
  /**
   * Root directory where TRPC routers are located.
   * If not specified, the plugin will try common locations.
   * @example "./src/router" or "../api/src/router"
   */
  routerRoot?: string;

  /**
   * Name of the main router export
   * @default "appRouter"
   */
  mainRouterName?: string;

  /**
   * Pattern to identify procedure exports. If not specified, procedures are detected by structure.
   * @example "procedure_" to match exports like "procedure_getSomething"
   */
  procedurePattern?: string;

  /**
   * Cache timeout in milliseconds
   * @default 30000 (30 seconds)
   */
  cacheTimeout?: number;

  /**
   * Maximum depth for recursive router analysis
   * @default 10
   */
  maxDepth?: number;

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;
}

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
}

export interface TrpcNavigationPlugin {
  create(info: ts.server.PluginCreateInfo): ts.LanguageService;
}
