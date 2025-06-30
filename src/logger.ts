import type * as ts from 'typescript/lib/tsserverlibrary';
import type { Logger } from './types';

export function createLogger(info: ts.server.PluginCreateInfo, verbose = false): Logger {
  const prefix = '[TRPC-Nav]';

  const formatContext = (context: unknown): string => {
    if (!context) return '';
    if (typeof context === 'string') return `: ${context}`;
    try {
      return `: ${JSON.stringify(context, null, 2)}`;
    } catch {
      return `: ${String(context)}`;
    }
  };

  return {
    info(message: string, context?: unknown) {
      info.project.projectService.logger.info(`${prefix} ${message}${formatContext(context)}`);
    },

    error(message: string, errorOrContext?: unknown) {
      let errorMessage = message;
      if (errorOrContext instanceof Error) {
        errorMessage = `${message}: ${errorOrContext.message}\n${errorOrContext.stack}`;
      } else if (errorOrContext) {
        errorMessage = `${message}${formatContext(errorOrContext)}`;
      }
      info.project.projectService.logger.info(`${prefix} ERROR: ${errorMessage}`);
    },

    debug(message: string, context?: unknown) {
      if (verbose) {
        info.project.projectService.logger.info(`${prefix} DEBUG: ${message}${formatContext(context)}`);
      }
    },
  };
}
