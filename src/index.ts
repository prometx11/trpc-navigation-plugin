import * as ts from 'typescript/lib/tsserverlibrary';
import { getConfigWithDefaults, type PluginConfigWithDefaults } from './config';
import { createLogger } from './logger';
import { createNavigationResult, detectTrpcApiCall, findWordAtPosition, parseNavigationPath } from './navigation-utils';
import { Navigator } from './navigator';
import { TypeResolver } from './type-resolver';
import type { PluginConfig } from './types';

function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
  // Read configuration
  const config: Partial<PluginConfig> = info.config || {};
  const pluginConfig = getConfigWithDefaults(config);

  const logger = createLogger(info, pluginConfig.verbose);
  logger.info('TRPC Navigation Plugin initialized');

  // Validate configuration
  if (!pluginConfig.router) {
    logger.error('TRPC Navigation Plugin requires router configuration');
    logger.error('Add to your tsconfig.json:');
    logger.error('"plugins": [{');
    logger.error('  "name": "trpc-navigation-plugin",');
    logger.error('  "router": {');
    logger.error('    "filePath": "./src/server/api/root.ts",');
    logger.error('    "variableName": "appRouter"');
    logger.error('  }');
    logger.error('}]');
    // Return the original language service without modifications
    return info.languageService;
  }

  // Validate router configuration
  if (!pluginConfig.router.filePath || !pluginConfig.router.variableName) {
    logger.error('Invalid router configuration: both filePath and variableName are required');
    return info.languageService;
  }

  const typeResolver = new TypeResolver(logger, info.serverHost, pluginConfig as PluginConfigWithDefaults);
  const navigator = new Navigator(logger, info.serverHost, pluginConfig as PluginConfigWithDefaults);

  // Proxy the language service
  const proxy: ts.LanguageService = Object.create(null);

  for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
    const x = info.languageService[k];
    // @ts-ignore - TypeScript's type system can't properly handle this proxy pattern
    proxy[k] = (...args: any[]) => x.apply(info.languageService, args);
  }

  // Helper to find variable declaration
  function findVariableDeclaration(
    sourceFile: ts.SourceFile,
    variableName: string,
  ): ts.VariableDeclaration | undefined {
    let result: ts.VariableDeclaration | undefined;

    function visit(node: ts.Node) {
      if (result) return;

      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === variableName) {
            result = decl;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return result;
  }

  // Helper to find useUtils variables
  function findUseUtilsVariables(sourceFile: ts.SourceFile): Set<string> {
    const utilsVariables = new Set<string>();

    function visit(node: ts.Node) {
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            if (ts.isCallExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (ts.isPropertyAccessExpression(expr) && expr.name.text === pluginConfig.patterns.utilsMethod) {
                utilsVariables.add(decl.name.text);
                logger.info(`Found useUtils variable: ${decl.name.text}`);
              }
            }
          }
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return utilsVariables;
  }

  // Override getDefinitionAndBoundSpan for navigation
  proxy.getDefinitionAndBoundSpan = (fileName: string, position: number): ts.DefinitionInfoAndBoundSpan | undefined => {
    try {
      // Skip non-supported files
      const extensionPattern = pluginConfig.fileExtensions.map((ext) => ext.replace('.', '\\.')).join('|');
      if (!fileName.match(new RegExp(`(${extensionPattern})$`))) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const program = info.languageService.getProgram();
      if (!program) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      const typeChecker = program.getTypeChecker();
      const text = sourceFile.text;

      // Find the line containing the position
      const lineStart = text.lastIndexOf('\n', position) + 1;
      const lineEnd = text.indexOf('\n', position);
      const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const cursorPositionInLine = position - lineStart;

      // Detect tRPC API call
      const apiCall = detectTrpcApiCall(line, cursorPositionInLine);
      if (!apiCall) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      // Check if it's a tRPC client or useUtils variable
      const utilsVariables = findUseUtilsVariables(sourceFile);
      const isTrpcClient = typeResolver.isTrpcClient(apiCall.variable, sourceFile, position, typeChecker);
      const isUtilsVar = utilsVariables.has(apiCall.variable);

      if (!isTrpcClient && !isUtilsVar) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      // Find which word was clicked
      const clickedWord = findWordAtPosition(text, position);
      const fullPath = `${apiCall.variable}.${apiCall.path}`;

      // Parse the navigation path
      const navPath = parseNavigationPath(fullPath, clickedWord.word, apiCall.variable);
      if (!navPath) {
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      logger.debug(`Navigating to: ${navPath.targetPath.join('.')}`);

      // For useUtils variables, we need to find the original tRPC client
      let targetVariable = apiCall.variable;

      if (isUtilsVar) {
        logger.debug(`🔄 Tracing useUtils variable: ${targetVariable}`);

        // Find the declaration of the utils variable
        const utilsDecl = findVariableDeclaration(sourceFile, targetVariable);
        if (utilsDecl?.initializer && ts.isCallExpression(utilsDecl.initializer)) {
          const expr = utilsDecl.initializer.expression;

          // Check if it's variableName.useUtils()
          if (
            ts.isPropertyAccessExpression(expr) &&
            expr.name.text === pluginConfig.patterns.utilsMethod &&
            ts.isIdentifier(expr.expression)
          ) {
            targetVariable = expr.expression.text;
            logger.info(`✅ Traced useUtils to tRPC client: ${targetVariable}`);
          }
        }

        if (targetVariable === apiCall.variable) {
          logger.error('Could not trace useUtils to tRPC client');
          return info.languageService.getDefinitionAndBoundSpan(fileName, position);
        }
      }

      // Extract router type from the tRPC client (or traced variable)
      const routerInfo = typeResolver.extractRouterType(targetVariable, sourceFile, position, typeChecker, program);

      if (!routerInfo) {
        logger.error('Could not extract router type', {
          variable: apiCall.variable,
          fileName: sourceFile.fileName,
          position,
          fullPath,
          targetPath: navPath.targetPath.join('.'),
          clickedWord: clickedWord.word,
        });
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      // Navigate through the router
      const definition = navigator.navigateRouterPath(routerInfo.routerSymbol, navPath.targetPath, typeChecker);

      if (!definition) {
        logger.error('Navigation failed');
        return info.languageService.getDefinitionAndBoundSpan(fileName, position);
      }

      logger.info(`Navigation success: ${definition.fileName}`);
      return createNavigationResult(definition, clickedWord);
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

      const typeChecker = program.getTypeChecker();
      const text = sourceFile.text;

      // Check if we're near a tRPC call
      const wordRange = text.substring(Math.max(0, position - 50), Math.min(text.length, position + 50));

      // Check if we're in a pattern like: variable.path.path.method()
      if (!wordRange.match(/\b\w+\s*\.\s*[\w.]+/)) {
        return original;
      }

      // Extract variable name
      const varMatch = wordRange.match(/(\w+)\s*\.\s*[\w.]+/);
      if (!varMatch) return original;

      const variableName = varMatch[1];
      const utilsVariables = findUseUtilsVariables(sourceFile);

      if (
        !typeResolver.isTrpcClient(variableName, sourceFile, position, typeChecker) &&
        !utilsVariables.has(variableName)
      ) {
        return original;
      }

      // Add navigation hint
      if (original?.displayParts) {
        original.displayParts.push(
          { text: '\n', kind: 'lineBreak' },
          { text: '[TRPC-Nav] ', kind: 'punctuation' },
          {
            text: 'Cmd+Click to navigate to procedure definition',
            kind: 'text',
          },
        );
      }

      return original;
    } catch (error) {
      logger.error('Error in getQuickInfoAtPosition', error);
      return original;
    }
  };

  return proxy;
}

function init(_modules: { typescript: typeof ts }) {
  return { create };
}

export = init;
