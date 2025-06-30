import * as path from "node:path";
import * as ts from "typescript/lib/tsserverlibrary";
import { AstScanner } from "./ast-scanner";
import { NavigationCache } from "./cache";
import { createLogger } from "./logger";
import type { PluginConfig, ProcedureMapping } from "./types";

function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
  // Check if this package uses TRPC
  const projectRoot = info.project.getCurrentDirectory();
  const packageJsonPath = path.join(projectRoot, "package.json");

  try {
    const fs = require("node:fs");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
      };

      // Check if this package has TRPC-related dependencies
      const hasTrpcDep = Object.keys(deps).some(
        (dep) =>
          dep.includes("@trpc/") ||
          dep.includes("trpc") ||
          // Check for common API package patterns
          (dep.endsWith("/api") && deps[dep]),
      );

      const usesTrpc =
        hasTrpcDep ||
        deps["@trpc/client"] ||
        deps["@trpc/react-query"] ||
        deps["@trpc/server"];

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
    mainRouterName: config.mainRouterName || "appRouter",
    procedurePattern: config.procedurePattern,
    cacheTimeout:
      config.cacheTimeout !== undefined ? config.cacheTimeout : 1000, // 1 second default
    maxDepth: config.maxDepth || 10,
    verbose: config.verbose || false,
  };
  const logger = createLogger(info, pluginConfig.verbose);
  logger.info("TRPC Navigation Plugin initialized");
  logger.debug(`Configuration: ${JSON.stringify(pluginConfig, null, 2)}`);

  const cache = new NavigationCache(pluginConfig.cacheTimeout, logger);
  const scanner = new AstScanner(logger, pluginConfig);

  // Lazy initialization - only resolve paths when actually needed
  let routerRootPath: string | null = null;
  let hasInitialized = false;
  const trpcClientCache = new Map<string, boolean>(); // Cache for tRPC client detection

  function ensureInitialized(): boolean {
    if (hasInitialized) return routerRootPath !== null;

    hasInitialized = true;
    const projectRoot = info.project.getCurrentDirectory();
    const fs = require("node:fs");

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
        "./src/router",
        "./src/routers",
        "./src/server/router",
        "./src/server/routers",
        "./src/trpc",
        "./src/server/trpc",
        "./router",
        "./routers",
        "./server/router",
        "./server/routers",
        "../api/src/router",
        "../api/src/routers",
        "../server/src/router",
        "../server/src/routers",
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

  for (const k of Object.keys(info.languageService) as Array<
    keyof ts.LanguageService
  >) {
    const x = info.languageService[k];
    // @ts-ignore - TypeScript's type system can't properly handle this proxy pattern
    proxy[k] = (...args: any[]) => x.apply(info.languageService, args);
  }

  // Cache for type resolution results
  const typeResolutionCache = new Map<string, { routerSymbol: ts.Symbol; routerFile: string } | null>();

  // Helper function to extract router type from a symbol
  function extractRouterTypeFromSymbol(
    symbol: ts.Symbol,
    typeChecker: ts.TypeChecker
  ): { routerSymbol: ts.Symbol; routerFile: string } | null {
    const declarations = symbol.declarations;
    if (!declarations) return null;
    
    for (const decl of declarations) {
      if (ts.isTypeAliasDeclaration(decl)) {
        const typeNode = decl.type;
        // Check if it's a typeof expression
        if (ts.isTypeQueryNode(typeNode) && ts.isIdentifier(typeNode.exprName)) {
          const routerVarName = typeNode.exprName.text;
          logger.debug(`Found typeof ${routerVarName} in type alias`);
          
          // Find the actual router variable
          const routerSymbol = typeChecker.resolveName(
            routerVarName, 
            typeNode.exprName, 
            ts.SymbolFlags.Value,
            false
          );
          
          if (routerSymbol && routerSymbol.valueDeclaration) {
            const routerFile = routerSymbol.valueDeclaration.getSourceFile().fileName;
            return { routerSymbol, routerFile };
          }
        }
      }
    }
    
    return null;
  }

  // Helper function to extract router type from tRPC client
  function extractRouterTypeFromClient(
    variableName: string, 
    sourceFile: ts.SourceFile, 
    position: number
  ): { routerSymbol: ts.Symbol; routerFile: string } | null {
    const cacheKey = `router:${sourceFile.fileName}:${variableName}`;
    logger.debug(`Extracting router type for ${variableName} in ${sourceFile.fileName}`);
    
    // TEMPORARY: Skip cache to debug
    // if (typeResolutionCache.has(cacheKey)) {
    //   const cached = typeResolutionCache.get(cacheKey);
    //   logger.debug(`Using cached result: ${cached ? 'found' : 'not found'}`);
    //   return cached;
    // }

    try {
      const typeChecker = info.languageService.getProgram()?.getTypeChecker();
      if (!typeChecker) {
        logger.debug(`No type checker available for router type extraction`);
        typeResolutionCache.set(cacheKey, null);
        return null;
      }

      // First, find the identifier at the position
      let identifierNode: ts.Identifier | undefined;
      let identifierCount = 0;
      
      function findIdentifier(node: ts.Node): void {
        if (ts.isIdentifier(node) && node.text === variableName) {
          identifierCount++;
          if (!identifierNode || 
              (position >= node.getStart() && position <= node.getEnd())) {
            identifierNode = node;
            logger.debug(`Found identifier ${variableName} at position ${node.getStart()}-${node.getEnd()}, cursor at ${position}`);
          }
        }
        ts.forEachChild(node, findIdentifier);
      }
      
      findIdentifier(sourceFile);
      logger.debug(`Found ${identifierCount} instances of ${variableName} in file`);
      
      if (!identifierNode) {
        logger.debug(`Could not find identifier for ${variableName} at position ${position}`);
        typeResolutionCache.set(cacheKey, null);
        return null;
      }

      // Get the symbol and follow imports
      const symbol = typeChecker.getSymbolAtLocation(identifierNode);
      if (!symbol) {
        logger.debug(`No symbol found for ${variableName}`);
        typeResolutionCache.set(cacheKey, null);
        return null;
      }
      logger.debug(`Symbol found: ${symbol.name}, flags: ${symbol.flags}`);

      // If it's an alias (import), resolve it
      let resolvedSymbol = symbol;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        resolvedSymbol = typeChecker.getAliasedSymbol(symbol);
        logger.debug(`Resolved import alias for ${variableName}, resolved to: ${resolvedSymbol.name}`);
      }

      // Find the declaration with initialization
      let targetNode: ts.Node | undefined;
      const declarations = resolvedSymbol.getDeclarations();
      logger.debug(`Found ${declarations?.length || 0} declarations for ${variableName}`);
      
      if (declarations) {
        for (const decl of declarations) {
          logger.debug(`Declaration kind: ${ts.SyntaxKind[decl.kind]}`);
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            targetNode = decl.initializer;
            logger.debug(`Found variable declaration with initializer`);
            break;
          }
        }
      }
      
      if (!targetNode) {
        logger.debug(`Could not find variable declaration with initializer for ${variableName}`);
        typeResolutionCache.set(cacheKey, null);
        return null;
      }

      // Check if it's a call expression with type arguments
      if (ts.isCallExpression(targetNode)) {
        logger.debug(`Found call expression: ${targetNode.expression.getText()}`);
        
        if (targetNode.typeArguments && targetNode.typeArguments.length > 0) {
          const typeArg = targetNode.typeArguments[0];
          logger.debug(`Has type arguments: ${typeArg.getText()}`);
          
          // Get the type reference
          if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
            const routerTypeName = typeArg.typeName.text;
            logger.info(`Found router type parameter: ${routerTypeName}`);
            
            // Resolve the type alias
            const routerTypeSymbol = typeChecker.getSymbolAtLocation(typeArg.typeName);
            if (routerTypeSymbol) {
              logger.debug(`Router type symbol found: ${routerTypeSymbol.name}`);
              
              // Get all declarations to check different patterns
              const declarations = routerTypeSymbol.declarations;
              if (declarations && declarations.length > 0) {
                for (const decl of declarations) {
                  logger.debug(`Checking declaration kind: ${ts.SyntaxKind[decl.kind]}`);
                  
                  // Check if it's a type alias (type AppRouter = typeof appRouter)
                  if (ts.isTypeAliasDeclaration(decl)) {
                    const typeNode = decl.type;
                    logger.debug(`Type alias declaration: ${typeNode.getText()}`);
                    
                    // Check if it's a typeof expression
                    if (ts.isTypeQueryNode(typeNode) && ts.isIdentifier(typeNode.exprName)) {
                      const routerVarName = typeNode.exprName.text;
                      logger.info(`Router type ${routerTypeName} = typeof ${routerVarName}`);
                      
                      // Find the actual router variable
                      const routerSymbol = typeChecker.resolveName(
                        routerVarName, 
                        typeNode.exprName, 
                        ts.SymbolFlags.Value,
                        false
                      );
                      
                      if (routerSymbol && routerSymbol.valueDeclaration) {
                        const routerFile = routerSymbol.valueDeclaration.getSourceFile().fileName;
                        logger.info(`Found router ${routerVarName} in ${routerFile}`);
                        const result = { routerSymbol, routerFile };
                        typeResolutionCache.set(cacheKey, result);
                        return result;
                      } else {
                        logger.debug(`Could not resolve router variable ${routerVarName}`);
                      }
                    } else {
                      logger.debug(`Type alias is not a typeof expression`);
                    }
                  } 
                  // Check if it's an interface that extends from a router type
                  else if (ts.isInterfaceDeclaration(decl)) {
                    logger.debug(`Interface declaration: ${decl.name?.text}`);
                    // For now, we can't handle interfaces dynamically
                    // Would need to analyze the heritage clauses
                  }
                  // Check if it's directly exported/imported
                  else if (ts.isImportSpecifier(decl) || ts.isExportSpecifier(decl)) {
                    logger.debug(`Import/Export specifier, following...`);
                    
                    // For imported types, let's try a different approach
                    // Most tRPC setups follow a pattern where AppRouter is defined in the API package
                    // Let's look for common patterns
                    
                    // Strategy 1: Look for appRouter in common locations
                    const program = info.languageService.getProgram();
                    if (program) {
                      const commonRouterPaths = [
                        'packages/api/src/router.ts',
                        'packages/api/src/router/index.ts',
                        'packages/api/src/index.ts',
                        'src/server/api/root.ts',
                        'src/server/api/router.ts',
                        'src/server/router.ts',
                        'server/router.ts',
                        'api/src/router.ts'
                      ];
                      
                      const projectRoot = sourceFile.fileName.substring(0, sourceFile.fileName.indexOf('/packages/') > -1 ? sourceFile.fileName.indexOf('/packages/') : sourceFile.fileName.lastIndexOf('/src/'));
                      logger.debug(`Project root: ${projectRoot}`);
                      
                      for (const relativePath of commonRouterPaths) {
                        const fullPath = path.join(projectRoot, relativePath);
                        const routerSourceFile = program.getSourceFile(fullPath);
                        
                        if (routerSourceFile) {
                          logger.debug(`Checking router file: ${fullPath}`);
                          
                          // Look for appRouter export
                          const appRouterSymbol = typeChecker.resolveName(
                            'appRouter',
                            routerSourceFile,
                            ts.SymbolFlags.Value,
                            false
                          );
                          
                          if (appRouterSymbol && appRouterSymbol.valueDeclaration) {
                            logger.info(`Found appRouter in ${fullPath}`);
                            const result = { routerSymbol: appRouterSymbol, routerFile: fullPath };
                            typeResolutionCache.set(cacheKey, result);
                            return result;
                          }
                        }
                      }
                    }
                    
                    // Strategy 2: Follow the import chain
                    // Try to get the module specifier from the import
                    const parent = decl.parent;
                    if (parent && ts.isNamedImports(parent)) {
                      const importClause = parent.parent;
                      if (importClause && ts.isImportClause(importClause)) {
                        const importDecl = importClause.parent;
                        if (importDecl && ts.isImportDeclaration(importDecl)) {
                          const moduleSpecifier = importDecl.moduleSpecifier;
                          if (ts.isStringLiteral(moduleSpecifier)) {
                            logger.debug(`Import from: ${moduleSpecifier.text}`);
                            
                            // Try to resolve the module
                            const resolvedModule = ts.resolveModuleName(
                              moduleSpecifier.text,
                              sourceFile.fileName,
                              program!.getCompilerOptions(),
                              info.serverHost
                            );
                            
                            if (resolvedModule.resolvedModule) {
                              const resolvedFileName = resolvedModule.resolvedModule.resolvedFileName;
                              logger.debug(`Resolved to: ${resolvedFileName}`);
                              
                              // If it's a .d.ts file, try to find the source file
                              let targetFileName = resolvedFileName;
                              if (resolvedFileName.endsWith('.d.ts')) {
                                // Try to find the source file
                                const possibleSourceFiles = [
                                  resolvedFileName.replace(/\.d\.ts$/, '.ts'),
                                  resolvedFileName.replace(/\.d\.ts$/, '.tsx'),
                                  resolvedFileName.replace(/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'),
                                  resolvedFileName.replace(/dist\//, 'src/').replace(/\.d\.ts$/, '.tsx'),
                                ];
                                
                                for (const sourceFile of possibleSourceFiles) {
                                  if (info.serverHost.fileExists(sourceFile)) {
                                    targetFileName = sourceFile;
                                    logger.debug(`Found source file: ${sourceFile}`);
                                    break;
                                  }
                                }
                              }
                              
                              // If we still have a .d.ts file, try looking in common router locations
                              if (targetFileName.endsWith('.d.ts')) {
                                const packageRoot = targetFileName.substring(0, targetFileName.lastIndexOf('/dist/'));
                                logger.debug(`Package root: ${packageRoot}`);
                                
                                // Based on the logs showing router root path: /Users/ethan/EMR/WHHC-CUA/packages/api/src/router
                                const routerPaths = [
                                  path.join(packageRoot, 'src/router.ts'),
                                  path.join(packageRoot, 'src/router/index.ts'),
                                  path.join(packageRoot, 'src/index.ts'),
                                  // Add the actual path we see in the logs
                                  path.join(packageRoot, 'src/router/index.ts'),
                                ];
                                
                                for (const routerPath of routerPaths) {
                                  logger.debug(`Trying to get source file: ${routerPath}`);
                                  
                                  // First check if file exists
                                  if (!info.serverHost.fileExists(routerPath)) {
                                    logger.debug(`File does not exist: ${routerPath}`);
                                    continue;
                                  }
                                  
                                  // Try to add it to the program if not already there
                                  let routerFile = program!.getSourceFile(routerPath);
                                  if (!routerFile) {
                                    logger.debug(`Source file not in program, trying to read it`);
                                    const fileContent = info.serverHost.readFile(routerPath);
                                    if (fileContent) {
                                      routerFile = ts.createSourceFile(
                                        routerPath,
                                        fileContent,
                                        ts.ScriptTarget.Latest,
                                        true
                                      );
                                    }
                                  }
                                  
                                  if (routerFile) {
                                    logger.debug(`Got router file: ${routerPath}`);
                                    
                                    // Parse the file to look for appRouter export
                                    let foundResult: { routerSymbol: ts.Symbol; routerFile: string } | null = null;
                                    
                                    ts.forEachChild(routerFile, (node) => {
                                      if (foundResult) return; // Already found
                                      
                                      // Look for export const appRouter = ...
                                      if (ts.isVariableStatement(node)) {
                                        const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
                                        if (isExported) {
                                          for (const decl of node.declarationList.declarations) {
                                            if (ts.isVariableDeclaration(decl) && 
                                                ts.isIdentifier(decl.name) && 
                                                decl.name.text === 'appRouter' &&
                                                decl.initializer) {
                                              logger.info(`Found appRouter export in ${routerPath}`);
                                              
                                              // Create a symbol-like object
                                              const routerSymbol = {
                                                name: 'appRouter',
                                                valueDeclaration: decl,
                                                getDeclarations: () => [decl],
                                                flags: ts.SymbolFlags.Value
                                              } as any as ts.Symbol;
                                              
                                              foundResult = { routerSymbol, routerFile: routerPath };
                                              typeResolutionCache.set(cacheKey, foundResult);
                                              return;
                                            }
                                          }
                                        }
                                      }
                                      
                                      // Look for export type AppRouter = ...
                                      if (ts.isTypeAliasDeclaration(node)) {
                                        const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
                                        if (isExported && node.name.text === 'AppRouter') {
                                          logger.debug(`Found AppRouter type alias in ${routerPath}`);
                                          
                                          // Check if it's typeof appRouter
                                          if (ts.isTypeQueryNode(node.type) && ts.isIdentifier(node.type.exprName)) {
                                            const routerVarName = node.type.exprName.text;
                                            logger.info(`AppRouter = typeof ${routerVarName}`);
                                            
                                            // Now look for that variable in the same file
                                            ts.forEachChild(routerFile, (innerNode) => {
                                              if (foundResult) return;
                                              
                                              if (ts.isVariableStatement(innerNode)) {
                                                for (const decl of innerNode.declarationList.declarations) {
                                                  if (ts.isVariableDeclaration(decl) && 
                                                      ts.isIdentifier(decl.name) && 
                                                      decl.name.text === routerVarName) {
                                                    logger.info(`Found ${routerVarName} in same file`);
                                                    
                                                    const routerSymbol = {
                                                      name: routerVarName,
                                                      valueDeclaration: decl,
                                                      getDeclarations: () => [decl],
                                                      flags: ts.SymbolFlags.Value
                                                    } as any as ts.Symbol;
                                                    
                                                    foundResult = { routerSymbol, routerFile: routerPath };
                                                    typeResolutionCache.set(cacheKey, foundResult);
                                                    return;
                                                  }
                                                }
                                              }
                                            });
                                          }
                                        }
                                      }
                                    });
                                    
                                    if (foundResult) {
                                      return foundResult;
                                    }
                                  }
                                }
                              } else {
                                // We have a source file, check it normally
                                const targetSourceFile = program!.getSourceFile(targetFileName);
                                if (targetSourceFile) {
                                  // Look for AppRouter export in the target file
                                  const exportedAppRouter = typeChecker.resolveName(
                                    'AppRouter',
                                    targetSourceFile,
                                    ts.SymbolFlags.Type,
                                    false
                                  );
                                  
                                  if (exportedAppRouter) {
                                    logger.debug(`Found exported AppRouter, checking its declaration`);
                                    // Recursively check this symbol
                                    const result = extractRouterTypeFromSymbol(exportedAppRouter, typeChecker);
                                    if (result) {
                                      typeResolutionCache.set(cacheKey, result);
                                      return result;
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            } else {
              logger.debug(`Could not get router type symbol`);
            }
          } else {
            logger.debug(`Type argument is not a type reference`);
          }
        } else {
          logger.debug(`No type arguments found`);
        }
      } else {
        logger.debug(`Initializer is not a call expression: ${targetNode.kind}`);
      }

      logger.debug(`Could not extract router type for ${variableName}`);
      typeResolutionCache.set(cacheKey, null);
      return null;
    } catch (error) {
      logger.error(`Error extracting router type for ${variableName}`, error);
      typeResolutionCache.set(cacheKey, null);
      return null;
    }
  }

  // Helper function to navigate through router structure dynamically
  function navigateRouterPath(
    routerSymbol: ts.Symbol,
    pathSegments: string[],
    typeChecker: ts.TypeChecker
  ): ts.DefinitionInfo | null {
    try {
      if (!routerSymbol.valueDeclaration) {
        logger.debug(`No value declaration for router symbol`);
        return null;
      }

      let currentDeclaration = routerSymbol.valueDeclaration;
      
      // Process each segment of the path
      for (let i = 0; i < pathSegments.length; i++) {
        const segment = pathSegments[i];
        logger.debug(`Processing path segment: ${segment} (${i + 1}/${pathSegments.length})`);
        logger.debug(`Current declaration file: ${currentDeclaration.getSourceFile().fileName}`);
        
        // Find the router call in the declaration
        if (ts.isVariableDeclaration(currentDeclaration) && currentDeclaration.initializer) {
          logger.debug(`Analyzing declaration: ${currentDeclaration.name.getText()}`);
          const routerCall = findRouterCall(currentDeclaration.initializer);
          
          if (routerCall && routerCall.arguments.length > 0) {
            logger.debug(`Found router call with ${routerCall.arguments.length} arguments`);
            const routesArg = routerCall.arguments[0];
            
            // Check if it's an object literal with the route we're looking for
            if (ts.isObjectLiteralExpression(routesArg)) {
              logger.debug(`Router has ${routesArg.properties.length} properties`);
              let foundSegment = false;
              
              for (const prop of routesArg.properties) {
                if (foundSegment) break; // Already found, skip rest
                
                if (ts.isPropertyAssignment(prop) && 
                    ts.isIdentifier(prop.name) && 
                    prop.name.text === segment) {
                  logger.debug(`Found matching property: ${segment}`);
                  foundSegment = true;
                  
                  // Found the matching property
                  const propValue = prop.initializer;
                  const isLastSegment = i === pathSegments.length - 1;
                  
                  // If it's an identifier, try to resolve it
                  if (ts.isIdentifier(propValue)) {
                    logger.debug(`Found identifier: ${propValue.text} for segment ${segment}`);
                    
                    // Try to find the declaration in the same file first
                    const sourceFile = propValue.getSourceFile();
                    let foundDeclaration: ts.VariableDeclaration | null = null;
                    let foundSourceFile = sourceFile;
                    
                    ts.forEachChild(sourceFile, (node) => {
                      if (ts.isVariableStatement(node)) {
                        for (const decl of node.declarationList.declarations) {
                          if (ts.isVariableDeclaration(decl) && 
                              ts.isIdentifier(decl.name) && 
                              decl.name.text === propValue.text) {
                            foundDeclaration = decl;
                            return;
                          }
                        }
                      }
                    });
                    
                    // If not found in the same file, check imports
                    if (!foundDeclaration) {
                      logger.debug(`Checking imports for ${propValue.text}`);
                      
                      ts.forEachChild(sourceFile, (node) => {
                        if (ts.isImportDeclaration(node) && node.importClause && node.importClause.namedBindings) {
                          if (ts.isNamedImports(node.importClause.namedBindings)) {
                            for (const importSpecifier of node.importClause.namedBindings.elements) {
                              if (importSpecifier.name.text === propValue.text) {
                                // Found the import
                                const moduleSpecifier = node.moduleSpecifier;
                                if (ts.isStringLiteral(moduleSpecifier)) {
                                  logger.debug(`Found import for ${propValue.text} from ${moduleSpecifier.text}`);
                                  
                                  // Resolve the import path
                                  const currentDir = path.dirname(sourceFile.fileName);
                                  let importPath = moduleSpecifier.text;
                                  
                                  // Handle relative imports
                                  if (importPath.startsWith('.')) {
                                    importPath = path.resolve(currentDir, importPath);
                                    
                                    // Try different extensions
                                    const extensions = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
                                    for (const ext of extensions) {
                                      const fullPath = importPath + ext;
                                      if (info.serverHost.fileExists(fullPath)) {
                                        logger.debug(`Resolved import to: ${fullPath}`);
                                        
                                        // Read and parse the imported file
                                        const importedContent = info.serverHost.readFile(fullPath);
                                        if (importedContent) {
                                          const importedSourceFile = ts.createSourceFile(
                                            fullPath,
                                            importedContent,
                                            ts.ScriptTarget.Latest,
                                            true
                                          );
                                          
                                          // Look for the exported variable
                                          ts.forEachChild(importedSourceFile, (importedNode) => {
                                            if (ts.isVariableStatement(importedNode)) {
                                              const isExported = importedNode.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
                                              if (isExported) {
                                                for (const decl of importedNode.declarationList.declarations) {
                                                  if (ts.isVariableDeclaration(decl) && 
                                                      ts.isIdentifier(decl.name) && 
                                                      decl.name.text === propValue.text) {
                                                    foundDeclaration = decl;
                                                    foundSourceFile = importedSourceFile;
                                                    return;
                                                  }
                                                }
                                              }
                                            }
                                          });
                                          
                                          if (foundDeclaration) break;
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      });
                    }
                    
                    if (foundDeclaration) {
                      logger.debug(`Found declaration for ${propValue.text} in ${foundSourceFile.fileName}`);
                      
                      // Check if it's a procedure or router
                      const isProcedure = foundDeclaration.initializer && 
                                        isProcedureDeclaration(foundDeclaration.initializer);
                      logger.debug(`Declaration ${propValue.text}: isProcedure=${isProcedure}, isLastSegment=${isLastSegment}`);
                      
                      if (isLastSegment || isProcedure) {
                        // Navigate to this definition
                        const start = foundDeclaration.getStart();
                        
                        return {
                          fileName: foundSourceFile.fileName,
                          textSpan: {
                            start: start,
                            length: foundDeclaration.getEnd() - start,
                          },
                          kind: ts.ScriptElementKind.functionElement,
                          name: segment,
                          containerKind: ts.ScriptElementKind.moduleElement,
                          containerName: "TRPC Procedure",
                        };
                      } else {
                        // It's a nested router, continue navigation
                        logger.debug(`Found router ${propValue.text}, continuing navigation to next segment`);
                        currentDeclaration = foundDeclaration;
                        foundSegment = true;
                        break; // Break out of properties loop to continue with next segment
                      }
                    } else {
                      logger.debug(`Could not find declaration for ${propValue.text}`);
                    }
                  } else if (ts.isCallExpression(propValue)) {
                    // Inline procedure definition
                    const callText = propValue.getText().substring(0, 50);
                    logger.debug(`Found call expression for segment ${segment}: ${callText}...`);
                    
                    // Check if it's a procedure call
                    const isProcedureCall = isProcedureDeclaration(propValue);
                    logger.debug(`Is procedure call: ${isProcedureCall}, isLastSegment: ${isLastSegment}`);
                    
                    if (isProcedureCall && isLastSegment) {
                      // We want to navigate to this inline procedure
                      const start = prop.getStart();
                      const sourceFile = prop.getSourceFile();
                      
                      logger.info(`Found inline procedure ${segment} at ${sourceFile.fileName}:${start}`);
                      
                      return {
                        fileName: sourceFile.fileName,
                        textSpan: {
                          start: start,
                          length: prop.getEnd() - start,
                        },
                        kind: ts.ScriptElementKind.functionElement,
                        name: segment,
                        containerKind: ts.ScriptElementKind.moduleElement,
                        containerName: "TRPC Procedure",
                      };
                    } else if (!isProcedureCall) {
                      logger.debug(`Call expression is not a procedure: ${callText}`);
                    } else {
                      // This shouldn't happen - inline procedures can't have nested paths
                      logger.debug(`Warning: Found inline procedure ${segment} but not last segment`);
                      return null;
                    }
                  } else {
                    logger.debug(`Property value for ${segment} is neither identifier nor call expression: ${propValue.kind}`);
                  }
                }
              }
              
              if (!foundSegment) {
                logger.debug(`Segment ${segment} not found in router properties`);
                // List available properties for debugging
                const available = routesArg.properties
                  .filter(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
                  .map(p => (p as ts.PropertyAssignment).name?.getText())
                  .join(', ');
                logger.debug(`Available properties: ${available}`);
              }
            } else {
              logger.debug(`Router argument is not an object literal`);
            }
          } else {
            logger.debug(`No router call found in declaration`);
          }
        } else {
          logger.debug(`Current declaration is not a variable declaration with initializer`);
        }
      }
      
      // If we get here, we navigated as far as we could
      // Return the current symbol's location
      logger.debug(`Reached end of navigation at ${currentDeclaration.name?.getText() || 'unknown'}`);
      const targetFile = currentDeclaration.getSourceFile();
      const start = currentDeclaration.getStart();
      
      return {
        fileName: targetFile.fileName,
        textSpan: {
          start: start,
          length: currentDeclaration.getEnd() - start,
        },
        kind: ts.ScriptElementKind.moduleElement,
        name: pathSegments[pathSegments.length - 1] || "router",
        containerKind: ts.ScriptElementKind.moduleElement,
        containerName: "TRPC Router",
      };
      
    } catch (error) {
      logger.error(`Error navigating router path`, error);
      return null;
    }
  }

  // Helper to find router() call in an initializer
  function findRouterCall(node: ts.Node): ts.CallExpression | null {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'router') {
        return node;
      }
      if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'router') {
        return node;
      }
    }
    
    let result: ts.CallExpression | null = null;
    ts.forEachChild(node, (child) => {
      if (!result) {
        result = findRouterCall(child);
      }
    });
    return result;
  }

  // Helper to check if a symbol represents a procedure
  function isProcedureSymbol(symbol: ts.Symbol, typeChecker: ts.TypeChecker): boolean {
    if (!symbol.valueDeclaration) return false;
    
    if (ts.isVariableDeclaration(symbol.valueDeclaration) && symbol.valueDeclaration.initializer) {
      const init = symbol.valueDeclaration.initializer;
      const initText = init.getText();
      
      // Check for procedure patterns
      if (initText.includes('Procedure') && 
          (initText.includes('.query') || 
           initText.includes('.mutation') || 
           initText.includes('.subscription'))) {
        return true;
      }
    }
    
    return false;
  }

  // Helper to check if a node is a procedure declaration
  function isProcedureDeclaration(node: ts.Node): boolean {
    const nodeText = node.getText();
    // Check for procedure patterns but exclude router patterns
    const isProcedure = nodeText.includes('Procedure') && 
           (nodeText.includes('.query') || 
            nodeText.includes('.mutation') || 
            nodeText.includes('.subscription'));
    const isRouter = nodeText.includes('router(') || nodeText.includes('.router(');
    
    return isProcedure && !isRouter;
  }

  // Helper function to check if a variable is a tRPC client
  function isTrpcClient(variableName: string, sourceFile: ts.SourceFile, position: number): boolean {
    // Check cache first
    const cacheKey = `${sourceFile.fileName}:${variableName}`;
    if (trpcClientCache.has(cacheKey)) {
      return trpcClientCache.get(cacheKey)!;
    }

    logger.debug(`Checking if ${variableName} is a tRPC client`);

    try {
      const typeChecker = info.languageService.getProgram()?.getTypeChecker();
      if (!typeChecker) {
        logger.debug(`No type checker available`);
        return false;
      }

      // Find the identifier node
      let identifierNode: ts.Identifier | undefined;
      
      function findIdentifier(node: ts.Node): void {
        if (ts.isIdentifier(node) && node.text === variableName) {
          if (!identifierNode || 
              (position >= node.getStart() && position <= node.getEnd())) {
            identifierNode = node;
          }
        }
        ts.forEachChild(node, findIdentifier);
      }
      
      findIdentifier(sourceFile);
      
      if (!identifierNode) {
        logger.debug(`Could not find identifier for ${variableName}`);
        trpcClientCache.set(cacheKey, false);
        return false;
      }

      // Get the symbol
      const symbol = typeChecker.getSymbolAtLocation(identifierNode);
      if (!symbol) {
        logger.debug(`No symbol found for ${variableName}`);
        trpcClientCache.set(cacheKey, false);
        return false;
      }

      // Check the symbol's value declaration
      const valueDeclaration = symbol.valueDeclaration;
      if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration) && valueDeclaration.initializer) {
        const initText = valueDeclaration.initializer.getText();
        logger.debug(`Checking initializer for ${variableName}: ${initText.substring(0, 100)}...`);
        
        if (initText.includes('createTRPC') || 
            initText.includes('initTRPC') ||
            initText.includes('useUtils') ||
            initText.includes('useContext') ||
            initText.includes('trpc')) {
          logger.info(`Found tRPC client by initializer: ${variableName}`);
          trpcClientCache.set(cacheKey, true);
          return true;
        }
      }

      // Check all declarations
      const declarations = symbol.getDeclarations();
      if (declarations) {
        for (const decl of declarations) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            const initText = decl.initializer.getText();
            if (initText.includes('createTRPC') || 
                initText.includes('initTRPC') ||
                initText.includes('useUtils') ||
                initText.includes('useContext') ||
                initText.includes('trpc')) {
              logger.info(`Found tRPC client by declaration: ${variableName}`);
              trpcClientCache.set(cacheKey, true);
              return true;
            }
          }
        }
      }

      // Check the type
      const type = typeChecker.getTypeOfSymbolAtLocation(symbol, identifierNode);
      const typeName = typeChecker.typeToString(type);
      logger.debug(`Type of ${variableName}: ${typeName}`);
      
      if (typeName.includes('TRPC') || 
          typeName.includes('CreateTRPC') ||
          typeName.includes('TRPCClient') ||
          typeName.includes('Proxy<DecoratedProcedureRecord')) {
        logger.info(`Found tRPC client by type: ${variableName}`);
        trpcClientCache.set(cacheKey, true);
        return true;
      }

      // Check if symbol is imported and follows it
      if (symbol.flags & ts.SymbolFlags.Alias) {
        const aliasedSymbol = typeChecker.getAliasedSymbol(symbol);
        if (aliasedSymbol && aliasedSymbol !== symbol) {
          const aliasedDeclarations = aliasedSymbol.getDeclarations();
          if (aliasedDeclarations) {
            for (const decl of aliasedDeclarations) {
              if (ts.isVariableDeclaration(decl) && decl.initializer) {
                const initText = decl.initializer.getText();
                if (initText.includes('createTRPC') || 
                    initText.includes('initTRPC') ||
                    initText.includes('trpc')) {
                  logger.info(`Found tRPC client through import: ${variableName}`);
                  trpcClientCache.set(cacheKey, true);
                  return true;
                }
              }
            }
          }
        }
      }

      logger.debug(`${variableName} is not a tRPC client`);
      trpcClientCache.set(cacheKey, false);
      return false;
    } catch (error) {
      logger.error(`Error checking if ${variableName} is tRPC client`, error);
      return false;
    }
  }

  // Helper function to find useUtils() variable assignments
  function findUseUtilsVariables(sourceFile: ts.SourceFile): Set<string> {
    const utilsVariables = new Set<string>();
    logger.debug(`Scanning for useUtils variables in ${sourceFile.fileName}`);

    function visit(node: ts.Node) {
      if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            // Check for pattern: const varName = anyVariable.useUtils()
            if (ts.isCallExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (
                ts.isPropertyAccessExpression(expr) &&
                ts.isIdentifier(expr.expression) &&
                expr.name.text === "useUtils"
              ) {
                // Just add it - we don't need to verify the base is a tRPC client
                // because useUtils is tRPC-specific
                utilsVariables.add(decl.name.text);
                logger.info(`Found useUtils variable: ${decl.name.text}`);
              }
            }
          } else if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
            // Check for destructuring: const { mutate, ... } = anyVariable.useUtils()
            if (ts.isCallExpression(decl.initializer)) {
              const expr = decl.initializer.expression;
              if (
                ts.isPropertyAccessExpression(expr) &&
                ts.isIdentifier(expr.expression) &&
                expr.name.text === "useUtils"
              ) {
                logger.debug(`Found destructured useUtils assignment`);
              }
            }
          }
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    logger.info(
      `Total useUtils variables found: ${utilsVariables.size} - [${Array.from(utilsVariables).join(", ")}]`,
    );
    return utilsVariables;
  }

  // Override getDefinitionAndBoundSpan for navigation
  proxy.getDefinitionAndBoundSpan = (
    fileName: string,
    position: number,
  ): ts.DefinitionInfoAndBoundSpan | undefined => {
    try {
      // Skip if not a TypeScript/JavaScript file
      if (
        !fileName.endsWith(".ts") &&
        !fileName.endsWith(".tsx") &&
        !fileName.endsWith(".js") &&
        !fileName.endsWith(".jsx")
      ) {
        logger.debug(`Skipping non-TS file: ${fileName}`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }
      const program = info.languageService.getProgram();
      if (!program) {
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        logger.debug(`No source file found for ${fileName}`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      const text = sourceFile.text;

      // Find all useUtils variables in the file
      const utilsVariables = findUseUtilsVariables(sourceFile);

      // Find the line containing the position
      const lineStart = text.lastIndexOf("\n", position) + 1;
      const lineEnd = text.indexOf("\n", position);
      const line = text.substring(
        lineStart,
        lineEnd === -1 ? text.length : lineEnd,
      );

      // Look for TRPC API usage patterns
      const beforeCursor = line.substring(0, position - lineStart);
      const afterCursor = line.substring(position - lineStart);

      // Match any variable followed by a dot and path
      const apiPattern = /(\w+)\s*\.\s*([\w.]*\w)?$/;
      const apiMatch = beforeCursor.match(apiPattern);
      if (!apiMatch) {
        logger.debug(`No API match found in line: ${line}`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      const matchedVariable = apiMatch[1];
      let apiPath = apiMatch[2] || "";
      
      // Check if this is a tRPC client or a useUtils variable
      const isTrpc = isTrpcClient(matchedVariable, sourceFile, position);
      const isUtils = utilsVariables.has(matchedVariable);
      
      if (!isTrpc && !isUtils) {
        logger.debug(`Variable ${matchedVariable} is not a tRPC client`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      // Look forward to complete the path
      // For useUtils, we also need to match methods like .fetch(), .mutate(), .invalidate()
      const forwardMatch = afterCursor.match(
        /^([\w.]*?)(?:\s*\.\s*(?:useQuery|useMutation|useSubscription|queryOptions|mutationOptions|use|fetch|mutate|invalidate|refetch|cancel|setData|getData)|\s|$)/,
      );
      if (forwardMatch?.[1]) {
        apiPath += forwardMatch[1];
      }

      // Clean up the path
      apiPath = apiPath
        .replace(/\s+/g, "")
        .replace(/\.+$/, "")
        .replace(/^\.+/, "");

      if (!apiPath) {
        logger.debug(`Empty API path`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      // Build the full path with the actual variable name
      const fullPath = `${matchedVariable}.${apiPath}`;

      logger.debug(
        `Detected TRPC API call: ${fullPath}`,
      );

      // Try dynamic type resolution first (for tRPC clients only, not useUtils)
      if (isTrpc && !isUtils) {
        logger.info("🚀 DYNAMIC RESOLUTION: Attempting dynamic type resolution for navigation");
        const routerInfo = extractRouterTypeFromClient(matchedVariable, sourceFile, position);
        
        if (routerInfo) {
          logger.info(`🎯 DYNAMIC RESOLUTION: Found router type, navigating through ${routerInfo.routerSymbol.name} in ${routerInfo.routerFile}`);
          const typeChecker = program.getTypeChecker();
          const pathSegments = apiPath.split('.');
          
          // Figure out which segment was clicked
          let wordStart = position;
          let wordEnd = position;
          while (wordStart > 0 && /\w/.test(text.charAt(wordStart - 1))) {
            wordStart--;
          }
          while (wordEnd < text.length && /\w/.test(text.charAt(wordEnd))) {
            wordEnd++;
          }
          const clickedWord = text.substring(wordStart, wordEnd);
          
          // Determine which segment index was clicked
          const fullPathParts = fullPath.split('.');
          let clickedSegmentIndex = -1;
          
          for (let i = 0; i < fullPathParts.length; i++) {
            if (fullPathParts[i] === clickedWord) {
              clickedSegmentIndex = i;
              break;
            }
          }
          
          // Skip the variable name (index 0)
          if (clickedSegmentIndex <= 0) {
            logger.debug(`Clicked on variable name or invalid position`);
            return info.languageService.getDefinitionAndBoundSpan(fileName, position);
          }
          
          // Navigate only up to the clicked segment
          // We need to adjust because fullPath includes the variable name but apiPath doesn't
          const adjustedIndex = clickedSegmentIndex - 1; // Subtract 1 because apiPath doesn't include variable name
          const pathToNavigate = apiPath.split('.').slice(0, adjustedIndex + 1); // +1 to include the clicked segment
          logger.debug(`Clicked word: "${clickedWord}" at index ${clickedSegmentIndex}`);
          logger.debug(`Full path: ${fullPath}, apiPath: ${apiPath}`);
          logger.debug(`Navigating to segments: ${pathToNavigate.join('.')}`);
          
          // Navigate dynamically through the router
          const dynamicResult = navigateRouterPath(
            routerInfo.routerSymbol,
            pathToNavigate,
            typeChecker
          );
          
          if (dynamicResult) {
            logger.info(`✅ DYNAMIC RESOLUTION SUCCESS: ${fullPath} -> ${dynamicResult.fileName}`);
            
            return {
              definitions: [dynamicResult],
              textSpan: {
                start: wordStart,
                length: clickedWord.length,
              },
            };
          } else {
            logger.info("❌ DYNAMIC RESOLUTION FAILED: Falling back to pre-built mapping");
          }
        } else {
          logger.info("❌ DYNAMIC RESOLUTION: Could not extract router type, falling back to pre-built mapping");
        }
      } else {
        logger.info(`📦 STATIC RESOLUTION: Using pre-built mapping (isTrpc=${isTrpc}, isUtils=${isUtils})`);
      }

      // Fall back to pre-built mapping (for useUtils or when dynamic resolution fails)
      // Ensure initialization before proceeding
      if (!ensureInitialized()) {
        logger.debug("Plugin not initialized, falling back to default");
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }
      
      // TEMPORARY: Comment out to test dynamic resolution
      // return info.languageService.getDefinitionAndBoundSpan(fileName, position);

      // Get or build the procedure mapping
      let mapping = cache.get();
      if (!mapping) {
        logger.info("Cache miss, rebuilding procedure mapping...");

        // Clear the cache to force a fresh scan
        // The AST scanner will read fresh file contents

        mapping = buildProcedureMappingSync();
        if (mapping && Object.keys(mapping).length > 0) {
          cache.set(mapping);
        } else {
          logger.error("Failed to build procedure mapping");
          return info.languageService.getDefinitionAndBoundSpan(
            fileName,
            position,
          );
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

      const fullPathParts = fullPath.split(".");
      let targetPath = "";

      // Find which segment was clicked
      for (let i = 0; i < fullPathParts.length; i++) {
        if (fullPathParts[i] === clickedWord) {
          // Found the clicked segment, build the normalized path up to this point
          if (i === 0) {
            // Clicked on the variable name itself, no navigation
            logger.debug(`Clicked on variable name: ${clickedWord}`);
            return info.languageService.getDefinitionAndBoundSpan(
              fileName,
              position,
            );
          }
          // Build path with normalized "api" prefix for mapping lookup
          // The AST scanner always uses "api" as the prefix in its mappings
          const pathSegments = fullPathParts.slice(1, i + 1);
          targetPath = `api.${pathSegments.join(".")}`;
          break;
        }
      }

      // If we couldn't match the clicked word to a path segment, fall back to full path
      if (!targetPath) {
        // Normalize to "api" prefix for mapping lookup
        targetPath = `api.${apiPath}`;
      }

      logger.debug(
        `Clicked word: "${clickedWord}", target path: "${targetPath}"`,
      );

      // Now find the mapping for the target path
      const target = mapping[targetPath];

      if (!target) {
        logger.debug(`Available mappings: ${Object.keys(mapping).join(", ")}`);

        // If exact path not found, try to find the closest parent
        const parts = targetPath.split(".");
        for (let i = parts.length - 1; i > 0; i--) {
          const checkPath = parts.slice(0, i).join(".");
          const candidate = mapping[checkPath];
          if (candidate) {
            logger.info(
              `Using parent navigation: ${checkPath} -> ${path.relative(process.cwd(), candidate.fileName)}:${candidate.line}`,
            );
            return info.languageService.getDefinitionAndBoundSpan(
              fileName,
              position,
            );
          }
        }

        logger.debug(`No navigation found for: ${targetPath}`);
        return info.languageService.getDefinitionAndBoundSpan(
          fileName,
          position,
        );
      }

      logger.info(
        `Navigation: ${targetPath} -> ${path.relative(process.cwd(), target.fileName)}:${target.line}`,
      );

      // Calculate the exact position in the file
      let targetStart = 0;
      let targetLength = 100;

      try {
        const fs = require("node:fs");
        const targetFileContent = fs.readFileSync(target.fileName, "utf8");
        const lines = targetFileContent.split("\n");

        // Calculate character position from line number
        for (
          let lineIdx = 0;
          lineIdx < target.line - 1 && lineIdx < lines.length;
          lineIdx++
        ) {
          targetStart += lines[lineIdx].length + 1; // +1 for newline
        }

        // Different handling for inline vs exported procedures
        if (target.line <= lines.length) {
          const targetLine = lines[target.line - 1];

          // Extract the last segment of the target path for matching
          const targetSegment = targetPath.split(".").pop() || "";

          if (target.type === "inline-procedure") {
            // For inline procedures, try to find the exact procedure name on the line
            const procedureNameMatch = targetLine.match(
              new RegExp(`\\b${targetSegment}\\s*:`),
            );
            if (procedureNameMatch && procedureNameMatch.index !== undefined) {
              targetStart += procedureNameMatch.index;
              targetLength = procedureNameMatch[0].length;
            } else {
              // Fallback: use the whole line
              targetLength = targetLine.length;
            }
          } else if (target.type === "procedure" && target.procedureName) {
            // For exported procedures, find the procedure declaration
            const procMatch = targetLine.match(
              new RegExp(`\\b${target.procedureName}\\b`),
            );
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
        containerName: "TRPC Procedure",
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
      logger.error("Error in getDefinitionAndBoundSpan", error);
      return info.languageService.getDefinitionAndBoundSpan(fileName, position);
    }
  };

  // Override getQuickInfoAtPosition for hover hints
  proxy.getQuickInfoAtPosition = (
    fileName: string,
    position: number,
  ): ts.QuickInfo | undefined => {
    const original = info.languageService.getQuickInfoAtPosition(
      fileName,
      position,
    );

    try {
      const program = info.languageService.getProgram();
      if (!program) return original;

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) return original;

      // Check wider context for TRPC calls
      const text = sourceFile.text;
      const wordRange = text.substring(
        Math.max(0, position - 50),
        Math.min(text.length, position + 50),
      );

      // Check if we're hovering over a TRPC-related call
      const hasTrpcMethods = wordRange.includes("useQuery") ||
                            wordRange.includes("useMutation") ||
                            wordRange.includes("useSubscription") ||
                            wordRange.includes("fetch") ||
                            wordRange.includes("mutate");
      
      if (!hasTrpcMethods) {
        return original;
      }
      
      // Check if there's a variable.path pattern
      const variableMatch = wordRange.match(/(\w+)\s*\.\s*[\w.]+/);
      if (!variableMatch) {
        return original;
      }
      
      const variableName = variableMatch[1];
      
      // Check if it's a tRPC client
      const utilsVariables = findUseUtilsVariables(sourceFile);
      const isTrpc = isTrpcClient(variableName, sourceFile, position) || 
                     utilsVariables.has(variableName);
                     
      if (!isTrpc) {
        return original;
      }

      // Add navigation hint to the quick info
      if (original?.displayParts) {
        original.displayParts.push(
          { text: "\n", kind: "lineBreak" },
          { text: "[TRPC-Nav] ", kind: "punctuation" },
          {
            text: "Cmd+Click to navigate to procedure definition",
            kind: "text",
          },
        );
      }

      return original;
    } catch (error) {
      logger.error("Error in getQuickInfoAtPosition", error);
      return original;
    }
  };

  function buildProcedureMappingSync(): ProcedureMapping | null {
    if (!routerRootPath) {
      logger.error("Router root path not set");
      return null;
    }

    try {
      logger.info("Starting router scan...");
      const start = Date.now();
      const mapping = scanner.scanRoutersSync(routerRootPath);
      const duration = Date.now() - start;
      logger.info(`Router scan completed in ${duration}ms`);
      return mapping;
    } catch (error) {
      logger.error("Error building procedure mapping", error);
      return null;
    }
  }

  return proxy;
}

function init(_modules: { typescript: typeof ts }) {
  return { create };
}

export = init;
