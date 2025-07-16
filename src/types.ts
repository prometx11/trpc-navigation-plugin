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

export interface RouterConfig {
  /**
   * Path to the file containing the router definition
   */
  filePath: string;
  /**
   * Name of the exported router variable
   */
  variableName: string;
}

export interface PluginConfig {
  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;
  /**
   * Router configuration - required for navigation
   */
  router?: RouterConfig;
  /**
   * Optional nested routers configuration
   */
  nestedRouters?: Record<string, RouterConfig>;
  /**
   * Pattern configuration for tRPC detection
   */
  patterns?: {
    /**
     * Procedure types to detect
     * @default ['query', 'mutation', 'subscription']
     */
    procedureTypes?: string[];
    /**
     * Router function names to detect
     * @default ['router', 'createTRPCRouter', 'createRouter', 't.router']
     */
    routerFunctions?: string[];
    /**
     * Client initializer patterns to detect
     * @default ['createTRPC', 'initTRPC', 'createTRPCClient']
     */
    clientInitializers?: string[];
    /**
     * Name of the utils method
     * @default 'useUtils'
     */
    utilsMethod?: string;
  };
  /**
   * File extensions to process
   * @default ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
   */
  fileExtensions?: string[];
}

export interface Logger {
  info(message: string, context?: unknown): void;
  error(message: string, errorOrContext?: unknown): void;
  debug(message: string, context?: unknown): void;
}

export interface TrpcNavigationPlugin {
  create(info: ts.server.PluginCreateInfo): ts.LanguageService;
}
