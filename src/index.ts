import * as path from 'node:path';
import * as ts from 'typescript/lib/tsserverlibrary';
import { AstScanner } from './ast-scanner';
import { NavigationCache } from './cache';
import { createLogger } from './logger';
import type { PluginConfig, ProcedureMapping } from './types';

function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
  // Check if this package uses TRPC
  const projectRoot = info.project.getCurrentDirectory();
  const packageJsonPath = path.join(projectRoot, 'package.json');

  try {
    const fs = require('node:fs');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
      };

      // Check if this package has TRPC-related dependencies
      const hasTrpcDep = Object.keys(deps).some(
        (dep) =>
          dep.includes('@trpc/') ||
          dep.includes('trpc') ||
          // Check for common API package patterns
          (dep.endsWith('/api') && deps[dep]),
      );

      const usesTrpc = hasTrpcDep || deps['@trpc/client'] || deps['@trpc/react-query'] || deps['@trpc/server'];

      if (!usesTrpc) {
        // This package doesn't use TRPC, return unmodified language service
        return info.languageService;
      }
    }
  } catch (_error) {
    // If we can't determine, proceed with normal initialization
  }

  // Read configuration from tsconfig.json
  const config: Partial<PluginConfig> = info.config || {};

  // Apply defaults
  const pluginConfig: PluginConfig = {
    routerRoot: config.routerRoot,
    mainRouterName: config.mainRouterName || 'appRouter',
    apiVariableName: config.apiVariableName || 'api',
    procedurePattern: config.procedurePattern,
    cacheTimeout: config.cacheTimeout !== undefined ? config.cacheTimeout : 1000, // 1 second default
    maxDepth: config.maxDepth || 10,
    verbose: config.verbose || false,
  };
  const logger = createLogger(info, pluginConfig.verbose);
  logger.info('TRPC Navigation Plugin initialized');
  logger.debug(`Configuration: ${JSON.stringify(pluginConfig, null, 2)}`);

  const cache = new NavigationCache(pluginConfig.cacheTimeout, logger);
  const scanner = new AstScanner(logger, pluginConfig);

  // Lazy initialization - only resolve paths when actually needed
  let routerRootPath: string | null = null;
  let hasInitialized = false;

  function ensureInitialized(): boolean {
    if (hasInitialized) return routerRootPath !== null;

    hasInitialized = true;
    const projectRoot = info.project.getCurrentDirectory();
    const fs = require('node:fs');

    // If routerRoot is specified, use it
    if (pluginConfig.routerRoot) {
      routerRootPath = path.isAbsolute(pluginConfig.routerRoot)
        ? pluginConfig.routerRoot
        : path.resolve(projectRoot, pluginConfig.routerRoot);

      if (!fs.existsSync(routerRootPath)) {
        logger.error(`Router root directory not found: ${routerRootPath}`);
        routerRootPath = null;
        return false;
      }
    } else {
      // Try common locations
      const commonPaths = [
        './src/router',
        './src/routers',
        './src/server/router',
        './src/server/routers',
        './src/trpc',
        './src/server/trpc',
        './router',
        './routers',
        './server/router',
        './server/routers',
        '../api/src/router',
        '../api/src/routers',
        '../server/src/router',
        '../server/src/routers',
      ];

      for (const testPath of commonPaths) {
        const absolutePath = path.resolve(projectRoot, testPath);
        if (fs.existsSync(absolutePath)) {
          routerRootPath = absolutePath;
          logger.info(`Auto-detected router root: ${testPath}`);
          break;
        }
      }

      if (!routerRootPath) {
        logger.error(
          `Could not auto-detect router root directory. Please specify 'routerRoot' in your tsconfig.json plugin configuration.`,
        );
        return false;
      }
    }

    logger.info(`Router root path: ${routerRootPath}`);
    return true;
  }

  // Proxy the language service
  const proxy: ts.LanguageService = Object.create(null);

  for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
    const x = info.languageService[k];
    // @ts-ignore - TypeScript's type system can't properly handle this proxy pattern
    proxy[k] = (...args: any[]) => x.apply(info.languageService, args);
  }

  // Helper function to find useUtils() variable assignments
  function findUseUtilsVariables(sourceFile: ts.SourceFile): Set<string> {
    const utilsVariables = new Set<string>();
    logger.debug(`Scanning for useUtils variables in ${sourceFile.fileName}`);
    
    function visit(node: ts.Node) {
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach(decl => {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            // Check for pattern: const varName = api.useUtils()
            if (ts.isCallExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (ts.isPropertyAccessExpression(expr) && 
                  ts.isIdentifier(expr.expression) &&
                  expr.expression.text === pluginConfig.apiVariableName &&
                  expr.name.text === 'useUtils') {
                utilsVariables.add(decl.name.text);
                logger.info(`Found useUtils variable: ${decl.name.text}`);
              }
            }
          } else if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
            // Check for destructuring: const { mutate, ... } = api.useUtils()
            if (ts.isCallExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (ts.isPropertyAccessExpression(expr) && 
                  ts.isIdentifier(expr.expression) &&
                  expr.expression.text === pluginConfig.apiVariableName &&
                  expr.name.text === 'useUtils') {
                // For destructuring, we'll still track the entire pattern
                // In practice, users would need to use the destructured properties differently
                logger.debug(`Found destructured useUtils assignment`);
              }
            }
          }
        });
      }
      
      ts.forEachChild(node, visit);
    }
    
    visit(sourceFile);
    logger.info(`Total useUtils variables found: ${utilsVariables.size} - [${Array.from(utilsVariables).join(', ')}]`);
    return utilsVariables;
  }

  // Override getDefinitionAndBoundSpan for navigation
  proxy.getDefinitionAndBoundSpan = (fileName: string, position: number): ts.DefinitionInfoAndBoundSpan | undefined => {
    try {
      // Skip if not a TypeScript/JavaScript file
      if (
        !fileName.endsWith('.ts') &&
        !fileName.endsWith('.tsx') &&
        !fileName.endsWith('.js') &&
        !fileName.endsWith('.jsx')
      ) {
        logger.debug(`Skipping non-TS file: ${fileName}`);
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }
      const program = info.languageService.getProgram();
      if (!program) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        logger.debug(`No source file found for ${fileName}`);
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const text = sourceFile.text;

      // Find all useUtils variables in the file
      const utilsVariables = findUseUtilsVariables(sourceFile);

      // Find the line containing the position
      const lineStart = text.lastIndexOf('\n', position) + 1;
      const lineEnd = text.indexOf('\n', position);
      const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);

      // Look for TRPC API usage patterns
      const beforeCursor = line.substring(0, position - lineStart);
      const afterCursor = line.substring(position - lineStart);

      // Build pattern to match both api.* and utilsVariable.* expressions
      const variableNames = [pluginConfig.apiVariableName, ...utilsVariables];
      logger.debug(`Variable names to match: [${variableNames.join(', ')}]`);
      const apiPattern = new RegExp(`(${variableNames.join('|')})\\s*\\.\\s*([\\w.]*\\w)?$`);
      logger.debug(`Pattern: ${apiPattern.source}`);
      logger.debug(`Testing against: "${beforeCursor}"`);
      const apiMatch = beforeCursor.match(apiPattern);
      if (!apiMatch) {
        logger.debug(`No API match found in line: ${line}`);
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const matchedVariable = apiMatch[1];
      let apiPath = apiMatch[2] || '';

      // Look forward to complete the path
      // For useUtils, we also need to match methods like .fetch(), .mutate(), .invalidate()
      const forwardMatch = afterCursor.match(/^([\w.]*?)(?:\s*\.\s*(?:useQuery|useMutation|useSubscription|use|fetch|mutate|invalidate|refetch|cancel|setData|getData)|\s|$)/);
      if (forwardMatch?.[1]) {
        apiPath += forwardMatch[1];
      }

      // Clean up the path
      apiPath = apiPath.replace(/\s+/g, '').replace(/\.+$/, '').replace(/^\.+/, '');

      if (!apiPath) {
        logger.debug(`Empty API path`);
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      // Always normalize to use the configured API variable name for mapping lookup
      apiPath = `${pluginConfig.apiVariableName}.${apiPath}`;

      logger.debug(`Detected TRPC API call: ${apiPath} (via ${matchedVariable})`);

      // Ensure initialization before proceeding
      if (!ensureInitialized()) {
        logger.debug('Plugin not initialized, falling back to default');
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      // Get or build the procedure mapping
      let mapping = cache.get();
      if (!mapping) {
        logger.info('Cache miss, rebuilding procedure mapping...');
        
        // Clear the cache to force a fresh scan
        // The AST scanner will read fresh file contents
        
        mapping = buildProcedureMappingSync();
        if (mapping && Object.keys(mapping).length > 0) {
          cache.set(mapping);
        } else {
          logger.error('Failed to build procedure mapping');
          return info.languageService.getDefinitionAndBoundSpan(fileName, position);
        }
      }

      // Figure out which segment of the path was clicked
      // First, find which word is at the cursor position
      let wordStart = position;
      let wordEnd = position;

      // Find start of word
      while (wordStart > 0 && /\w/.test(text.charAt(wordStart - 1))) {
        wordStart--;
      }

      // Find end of word
      while (wordEnd < text.length && /\w/.test(text.charAt(wordEnd))) {
        wordEnd++;
      }

      const clickedWord = text.substring(wordStart, wordEnd);

      // Now figure out which segment of the API path this word represents
      // We need to consider the full path including the variable name for proper matching
      // For apictx.agencies.patientAgencyConnections, clicking "agencies" should navigate to api.agencies
      
      // Build the full path as it appears in the code (with the actual variable name)
      const fullPathInCode = matchedVariable + (apiPath.substring(pluginConfig.apiVariableName.length) || '');
      const fullPathParts = fullPathInCode.split('.');
      
      let targetPath = '';
      
      // Find which segment was clicked
      for (let i = 0; i < fullPathParts.length; i++) {
        if (fullPathParts[i] === clickedWord) {
          // Found the clicked segment, build the normalized path up to this point
          if (i === 0) {
            // Clicked on the variable name itself, no navigation
            logger.debug(`Clicked on variable name: ${clickedWord}`);
            return info.languageService.getDefinitionAndBoundSpan(fileName, position);
          }
          // Build path with normalized api variable name
          const pathSegments = fullPathParts.slice(1, i + 1);
          targetPath = `${pluginConfig.apiVariableName}.${pathSegments.join('.')}`;
          break;
        }
      }

      // If we couldn't match the clicked word to a path segment, fall back to full path
      if (!targetPath) {
        targetPath = apiPath;
      }

      logger.debug(`Clicked word: "${clickedWord}", target path: "${targetPath}"`);

      // Now find the mapping for the target path
      const target = mapping[targetPath];

      if (!target) {
        logger.debug(`Available mappings: ${Object.keys(mapping).join(', ')}`);
        
        // If exact path not found, try to find the closest parent
        const parts = targetPath.split('.');
        for (let i = parts.length - 1; i > 0; i--) {
          const checkPath = parts.slice(0, i).join('.');
          const candidate = mapping[checkPath];
          if (candidate) {
            logger.info(
              `Using parent navigation: ${checkPath} -> ${path.relative(process.cwd(), candidate.fileName)}:${candidate.line}`,
            );
            return info.languageService.getDefinitionAndBoundSpan(fileName, position);
          }
        }

        logger.debug(`No navigation found for: ${targetPath}`);
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      logger.info(`Navigation: ${targetPath} -> ${path.relative(process.cwd(), target.fileName)}:${target.line}`);

      // Calculate the exact position in the file
      let targetStart = 0;
      let targetLength = 100;

      try {
        const fs = require('node:fs');
        const targetFileContent = fs.readFileSync(target.fileName, 'utf8');
        const lines = targetFileContent.split('\n');

        // Calculate character position from line number
        for (let lineIdx = 0; lineIdx < target.line - 1 && lineIdx < lines.length; lineIdx++) {
          targetStart += lines[lineIdx].length + 1; // +1 for newline
        }

        // Different handling for inline vs exported procedures
        if (target.line <= lines.length) {
          const targetLine = lines[target.line - 1];

          // Extract the last segment of the target path for matching
          const targetSegment = targetPath.split('.').pop() || '';

          if (target.type === 'inline-procedure') {
            // For inline procedures, try to find the exact procedure name on the line
            const procedureNameMatch = targetLine.match(new RegExp(`\\b${targetSegment}\\s*:`));
            if (procedureNameMatch && procedureNameMatch.index !== undefined) {
              targetStart += procedureNameMatch.index;
              targetLength = procedureNameMatch[0].length;
            } else {
              // Fallback: use the whole line
              targetLength = targetLine.length;
            }
          } else if (target.type === 'procedure' && target.procedureName) {
            // For exported procedures, find the procedure declaration
            const procMatch = targetLine.match(new RegExp(`\\b${target.procedureName}\\b`));
            if (procMatch && procMatch.index !== undefined) {
              targetStart += procMatch.index;
              targetLength = procMatch[0].length;
            }
          } else {
            // Generic fallback patterns (for routers)
            const patterns = [
              new RegExp(`\\b${targetSegment}Router\\b`), // e.g., appointmentsRouter
              new RegExp(`\\b${targetSegment}\\s*:`), // property: value
              new RegExp(`\\bprocedure_${targetSegment}\\b`), // procedure_name
              new RegExp(`\\b${targetSegment}\\s*=`), // name =
            ];

            for (const pattern of patterns) {
              const match = targetLine.match(pattern);
              if (match && match.index !== undefined) {
                targetStart += match.index;
                targetLength = match[0].length;
                break;
              }
            }
          }
        }
      } catch (error) {
        logger.error(`Error calculating position`, error);
        // Fall back to stored position if available
        if (target.position !== undefined) {
          targetStart = target.position;
          targetLength = target.length || 100;
        }
      }

      // Create the definition
      const definition: ts.DefinitionInfo = {
        fileName: target.fileName,
        textSpan: {
          start: targetStart,
          length: targetLength,
        },
        kind: ts.ScriptElementKind.functionElement,
        name: clickedWord,
        containerKind: ts.ScriptElementKind.moduleElement,
        containerName: 'TRPC Procedure',
      };

      // We already calculated wordStart and wordEnd above
      return {
        definitions: [definition],
        textSpan: {
          start: wordStart,
          length: clickedWord.length,
        },
      };
    } catch (error) {
      logger.error('Error in getDefinitionAndBoundSpan', error);
      return info.languageService.getDefinitionAndBoundSpan(fileName, position);
    }
  };

  // Override getQuickInfoAtPosition for hover hints
  proxy.getQuickInfoAtPosition = (fileName: string, position: number): ts.QuickInfo | undefined => {
    const original = info.languageService.getQuickInfoAtPosition(fileName, position);

    try {
      const program = info.languageService.getProgram();
      if (!program) return original;

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) return original;

      // Find all useUtils variables in the file
      const utilsVariables = findUseUtilsVariables(sourceFile);

      // Check wider context for TRPC calls
      const text = sourceFile.text;
      const wordRange = text.substring(Math.max(0, position - 50), Math.min(text.length, position + 50));

      // Build pattern to check for TRPC calls
      const variableNames = [pluginConfig.apiVariableName, ...utilsVariables];
      const hasTrpcVariable = variableNames.some(varName => wordRange.includes(`${varName}.`));
      
      // Check if we're hovering over a TRPC call
      if (
        !hasTrpcVariable ||
        (!wordRange.includes('useQuery') &&
          !wordRange.includes('useMutation') &&
          !wordRange.includes('useSubscription'))
      ) {
        return original;
      }

      // Add navigation hint to the quick info
      if (original?.displayParts) {
        original.displayParts.push(
          { text: '\n', kind: 'lineBreak' },
          { text: '[TRPC-Nav] ', kind: 'punctuation' },
          { text: 'Cmd+Click to navigate to procedure definition', kind: 'text' },
        );
      }

      return original;
    } catch (error) {
      logger.error('Error in getQuickInfoAtPosition', error);
      return original;
    }
  };

  function buildProcedureMappingSync(): ProcedureMapping | null {
    if (!routerRootPath) {
      logger.error('Router root path not set');
      return null;
    }

    try {
      logger.info('Starting router scan...');
      const start = Date.now();
      const mapping = scanner.scanRoutersSync(routerRootPath);
      const duration = Date.now() - start;
      logger.info(`Router scan completed in ${duration}ms`);
      return mapping;
    } catch (error) {
      logger.error('Error building procedure mapping', error);
      return null;
    }
  }

  return proxy;
}

function init(_modules: { typescript: typeof ts }) {
  return { create };
}

export = init;
