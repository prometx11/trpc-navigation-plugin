import type * as ts from 'typescript/lib/tsserverlibrary';
import type { Logger } from './types';

export function createLogger(info: ts.server.PluginCreateInfo, verbose = false): Logger {
  const prefix = '[TRPC-Nav]';

  return {
    info(message: string) {
      info.project.projectService.logger.info(`${prefix} ${message}`);
    },

    error(message: string, error?: unknown) {
      const errorMessage =
        error instanceof Error
          ? `${message}: ${error.message}\n${error.stack}`
          : `${message}${error ? `: ${String(error)}` : ''}`;
      info.project.projectService.logger.info(`${prefix} ERROR: ${errorMessage}`);
    },

    debug(message: string) {
      if (verbose) {
        info.project.projectService.logger.info(`${prefix} DEBUG: ${message}`);
      }
    },
  };
}
