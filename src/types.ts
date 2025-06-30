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

export interface PluginConfig {
  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;
}

export interface Logger {
  info(message: string, context?: unknown): void;
  error(message: string, errorOrContext?: unknown): void;
  debug(message: string, context?: unknown): void;
}

export interface TrpcNavigationPlugin {
  create(info: ts.server.PluginCreateInfo): ts.LanguageService;
}
