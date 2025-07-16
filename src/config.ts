import type { PluginConfig } from './types';

export const DEFAULT_PATTERNS = {
  procedureTypes: ['query', 'mutation', 'subscription'],
  routerFunctions: ['router', 'createTRPCRouter', 'createRouter', 't.router'],
  clientInitializers: ['createTRPC', 'initTRPC', 'createTRPCClient'],
  utilsMethod: 'useUtils',
};

export const DEFAULT_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface PluginConfigWithDefaults extends PluginConfig {
  patterns: {
    procedureTypes: string[];
    routerFunctions: string[];
    clientInitializers: string[];
    utilsMethod: string;
  };
  fileExtensions: string[];
}

export function getConfigWithDefaults(config: Partial<PluginConfig>): PluginConfigWithDefaults {
  return {
    verbose: config.verbose || false,
    router: config.router,
    nestedRouters: config.nestedRouters,
    patterns: {
      procedureTypes: config.patterns?.procedureTypes || DEFAULT_PATTERNS.procedureTypes,
      routerFunctions: config.patterns?.routerFunctions || DEFAULT_PATTERNS.routerFunctions,
      clientInitializers: config.patterns?.clientInitializers || DEFAULT_PATTERNS.clientInitializers,
      utilsMethod: config.patterns?.utilsMethod || DEFAULT_PATTERNS.utilsMethod,
    },
    fileExtensions: config.fileExtensions || DEFAULT_FILE_EXTENSIONS,
  };
}
