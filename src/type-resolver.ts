import * as path from 'node:path';
import * as ts from 'typescript/lib/tsserverlibrary';
import type { Logger } from './types';

export interface RouterTypeInfo {
  routerSymbol: ts.Symbol;
  routerFile: string;
}

export class TypeResolver {
  constructor(
    private logger: Logger,
    private serverHost: ts.server.ServerHost,
  ) {}

  /**
   * Extracts router type information from a tRPC client variable
   */
  extractRouterType(
    variableName: string,
    sourceFile: ts.SourceFile,
    position: number,
    typeChecker: ts.TypeChecker,
  ): RouterTypeInfo | null {
    this.logger.debug(`🔍 extractRouterType called for ${variableName}`);

    try {
      return this.performTypeExtraction(variableName, sourceFile, position, typeChecker);
    } catch (error) {
      this.logger.error(`Error extracting router type for ${variableName}`, error);
      return null;
    }
  }

  private performTypeExtraction(
    variableName: string,
    sourceFile: ts.SourceFile,
    position: number,
    typeChecker: ts.TypeChecker,
  ): RouterTypeInfo | null {
    this.logger.debug(`🔍 Starting type extraction for ${variableName} in ${sourceFile.fileName}`);

    // Find the identifier at position
    const identifierNode = this.findIdentifierAtPosition(sourceFile, variableName, position);
    if (!identifierNode) {
      this.logger.debug(`❌ Could not find identifier for ${variableName}`, {
        sourceFile: sourceFile.fileName,
        position,
      });
      return null;
    }

    // Get and resolve the symbol
    const symbol = typeChecker.getSymbolAtLocation(identifierNode);
    if (!symbol) {
      this.logger.debug(`❌ No symbol found for ${variableName}`, {
        sourceFile: sourceFile.fileName,
        identifierText: identifierNode.getText(),
      });
      return null;
    }

    this.logger.debug(`📌 Symbol found: ${symbol.name}, flags: ${symbol.flags}`);

    // Check if it's an imported symbol
    const isImported = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
    this.logger.debug(`📦 Symbol is ${isImported ? 'imported' : 'local'}`);

    const resolvedSymbol = isImported ? typeChecker.getAliasedSymbol(symbol) : symbol;

    this.logger.debug(`🎯 Resolved symbol: ${resolvedSymbol.name}, flags: ${resolvedSymbol.flags}`);

    // Find the variable declaration with initializer
    const targetNode = this.findInitializer(resolvedSymbol);
    if (!targetNode) {
      this.logger.debug(`❌ No initializer found for ${variableName}`, {
        symbolName: resolvedSymbol.name,
        symbolFlags: resolvedSymbol.flags,
        declarationCount: resolvedSymbol.declarations?.length || 0,
        isImported,
      });
      return null;
    }

    this.logger.debug(`🎯 Found initializer: ${targetNode.getText().substring(0, 100)}...`);

    // Extract type arguments from createTRPCReact<AppRouter>()
    if (ts.isCallExpression(targetNode)) {
      this.logger.debug(`📞 Found call expression`);

      if (targetNode.typeArguments?.length) {
        const typeArg = targetNode.typeArguments[0];
        this.logger.debug(`🏷️ Type argument: ${typeArg.getText()}`);

        if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
          const routerTypeName = typeArg.typeName.text;
          this.logger.info(`✨ Found router type parameter: ${routerTypeName}`);

          // Resolve the router type
          const routerTypeSymbol = typeChecker.getSymbolAtLocation(typeArg.typeName);
          if (routerTypeSymbol) {
            this.logger.debug(`🔗 Resolving router type symbol...`);
            return this.resolveRouterTypeSymbol(routerTypeSymbol, typeChecker);
          } else {
            this.logger.debug(`❌ Could not get router type symbol`);
          }
        }
      } else {
        this.logger.debug(`⚠️ No type arguments found, checking for property access pattern`);

        // Check if it's a property access like api.useUtils()
        const parent = identifierNode.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === identifierNode) {
          this.logger.debug(`🔄 Found property access, checking base variable type`);

          // Get the type of the variable
          const type = typeChecker.getTypeOfSymbolAtLocation(symbol, identifierNode);
          const typeString = typeChecker.typeToString(type);
          this.logger.debug(`📊 Variable type: ${typeString.substring(0, 200)}...`);

          // Try to extract router type from the type string
          const routerMatch = typeString.match(
            /CreateTRPCReact<(\w+)>|CreateTRPCProxyClient<(\w+)>|CreateTRPCNext<(\w+)>/,
          );
          if (routerMatch) {
            const routerTypeName = routerMatch[1] || routerMatch[2] || routerMatch[3];
            this.logger.info(`🎣 Extracted router type from type string: ${routerTypeName}`);

            // Try to resolve this type in the current context
            const routerTypeSymbol = typeChecker.resolveName(
              routerTypeName,
              identifierNode,
              ts.SymbolFlags.Type,
              false,
            );

            if (routerTypeSymbol) {
              return this.resolveRouterTypeSymbol(routerTypeSymbol, typeChecker);
            }
          }
        }
      }
    }

    this.logger.debug(`❌ Could not extract router type from ${variableName}`, {
      sourceFile: sourceFile.fileName,
      hasCallExpression: ts.isCallExpression(targetNode),
      nodeKind: ts.SyntaxKind[targetNode.kind],
      nodeText: targetNode.getText().substring(0, 100),
    });
    return null;
  }

  private findIdentifierAtPosition(
    sourceFile: ts.SourceFile,
    variableName: string,
    position: number,
  ): ts.Identifier | undefined {
    let result: ts.Identifier | undefined;
    let count = 0;

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === variableName) {
        count++;
        if (!result || (position >= node.getStart() && position <= node.getEnd())) {
          result = node;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    this.logger.debug(`🔍 Found ${count} instances of '${variableName}' in file`, {
      selectedPosition: result ? `${result.getStart()}-${result.getEnd()}` : 'none',
      cursorPosition: position,
    });

    return result;
  }

  private findInitializer(symbol: ts.Symbol): ts.Node | undefined {
    const declarations = symbol.getDeclarations();
    if (!declarations) {
      this.logger.debug(`❌ No declarations found for symbol`);
      return undefined;
    }

    this.logger.debug(`📋 Found ${declarations.length} declarations for symbol`);

    for (const decl of declarations) {
      this.logger.debug(`📄 Declaration kind: ${ts.SyntaxKind[decl.kind]}`);
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        this.logger.debug(`✅ Found variable declaration with initializer`);
        return decl.initializer;
      }
    }

    this.logger.debug(`❌ No initializer found in any declaration`);
    return undefined;
  }

  private resolveRouterTypeSymbol(routerTypeSymbol: ts.Symbol, typeChecker: ts.TypeChecker): RouterTypeInfo | null {
    this.logger.debug(`🔍 Resolving router type symbol: ${routerTypeSymbol.name}`);

    const declarations = routerTypeSymbol.declarations;
    if (!declarations) {
      this.logger.debug(`❌ No declarations found for router type symbol`);
      return null;
    }

    this.logger.debug(`📋 Found ${declarations.length} declarations`);

    for (const decl of declarations) {
      this.logger.debug(`📄 Declaration kind: ${ts.SyntaxKind[decl.kind]}`);

      // Handle type alias: type AppRouter = typeof appRouter
      if (ts.isTypeAliasDeclaration(decl)) {
        this.logger.debug(`🏷️ Type alias: ${decl.name.text}`);

        if (ts.isTypeQueryNode(decl.type)) {
          if (ts.isIdentifier(decl.type.exprName)) {
            const routerVarName = decl.type.exprName.text;
            this.logger.info(`🎯 Found typeof ${routerVarName}`);

            const routerSymbol = typeChecker.resolveName(
              routerVarName,
              decl.type.exprName,
              ts.SymbolFlags.Value,
              false,
            );

            if (routerSymbol?.valueDeclaration) {
              const routerFile = routerSymbol.valueDeclaration.getSourceFile().fileName;
              this.logger.info(`✅ Resolved router ${routerVarName} in ${routerFile}`);
              return { routerSymbol, routerFile };
            } else {
              this.logger.debug(`❌ Could not resolve router variable ${routerVarName}`, {
                typeAliasName: decl.name.text,
                sourceFile: decl.getSourceFile().fileName,
              });
            }
          }
        } else {
          this.logger.debug(`⚠️ Type alias is not a typeof expression`);
        }
      }
      // Handle import/export specifiers
      else if (ts.isImportSpecifier(decl) || ts.isExportSpecifier(decl)) {
        this.logger.debug(`📦 Import/Export specifier found`);

        // Try to follow the import
        const importResult = this.followImportSpecifier(decl, typeChecker);
        if (importResult) {
          return importResult;
        }

        // Fallback: Try to find the actual router in common locations
        const fallbackResult = this.tryCommonRouterLocations(typeChecker);
        if (fallbackResult) {
          return fallbackResult;
        }
      }
    }

    this.logger.debug(`❌ Could not resolve router type symbol`);
    return null;
  }

  private followImportSpecifier(
    importSpecifier: ts.ImportSpecifier | ts.ExportSpecifier,
    _typeChecker: ts.TypeChecker,
  ): RouterTypeInfo | null {
    this.logger.debug(`🔍 Following import specifier`);

    // Get the import declaration
    let importDecl: ts.ImportDeclaration | null = null;
    let current: ts.Node = importSpecifier;

    while (current && !ts.isImportDeclaration(current)) {
      current = current.parent;
    }

    if (ts.isImportDeclaration(current)) {
      importDecl = current;
    }

    if (!importDecl || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
      this.logger.debug(`❌ Could not find import declaration`);
      return null;
    }

    const modulePath = importDecl.moduleSpecifier.text;
    this.logger.debug(`📦 Import from: ${modulePath}`);

    // Get the source file
    const sourceFile = importSpecifier.getSourceFile();
    const resolvedModule = ts.resolveModuleName(
      modulePath,
      sourceFile.fileName,
      {} as ts.CompilerOptions, // We'll use default options
      this.serverHost,
    );

    if (!resolvedModule.resolvedModule) {
      this.logger.debug(`❌ Could not resolve module: ${modulePath}`);
      return null;
    }

    const resolvedFileName = resolvedModule.resolvedModule.resolvedFileName;
    this.logger.debug(`📁 Resolved to: ${resolvedFileName}`);

    // If it's a .d.ts file, try to find the source
    let targetFileName = resolvedFileName;
    if (resolvedFileName.endsWith('.d.ts')) {
      this.logger.debug(`🔍 Looking for source file for: ${resolvedFileName}`);

      const possibleSources = [
        resolvedFileName.replace(/\.d\.ts$/, '.ts'),
        resolvedFileName.replace(/\.d\.ts$/, '.tsx'),
        resolvedFileName.replace(/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'),
        resolvedFileName.replace(/dist\//, 'src/').replace(/\.d\.ts$/, '.tsx'),
        // For monorepo setups where the api package has its own structure
        resolvedFileName.replace(/\/dist\/index\.d\.ts$/, '/src/index.ts'),
        resolvedFileName.replace(/\/dist\/index\.d\.ts$/, '/src/index.tsx'),
        resolvedFileName.replace(/\/dist\/index\.d\.ts$/, '/src/router.ts'),
        resolvedFileName.replace(/\/dist\/index\.d\.ts$/, '/src/router/index.ts'),
      ];

      this.logger.debug(`📋 Checking ${possibleSources.length} possible source locations`);

      for (const source of possibleSources) {
        this.logger.debug(`🔍 Checking: ${source}`);
        if (this.serverHost.fileExists(source)) {
          targetFileName = source;
          this.logger.debug(`🎯 Found source file: ${source}`);
          break;
        }
      }

      if (targetFileName === resolvedFileName) {
        this.logger.debug(`⚠️ No source file found, using .d.ts file`);
      }
    }

    // Read and parse the file to find AppRouter
    const fileContent = this.serverHost.readFile(targetFileName);
    if (!fileContent) {
      this.logger.debug(`❌ Could not read file: ${targetFileName}`);
      return null;
    }

    const targetSourceFile = ts.createSourceFile(targetFileName, fileContent, ts.ScriptTarget.Latest, true);

    // Look for AppRouter type export
    let foundRouter: RouterTypeInfo | null = null;

    const visit = (node: ts.Node): void => {
      if (foundRouter) return;

      // Look for: export type AppRouter = typeof appRouter
      if (ts.isTypeAliasDeclaration(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported && node.name.text === 'AppRouter') {
          this.logger.debug(`🎯 Found AppRouter type alias`);

          if (ts.isTypeQueryNode(node.type) && ts.isIdentifier(node.type.exprName)) {
            const routerVarName = node.type.exprName.text;
            this.logger.info(`🎯 AppRouter = typeof ${routerVarName}`);

            // Look for the router variable in the same file
            const routerVar = this.findRouterVariable(targetSourceFile, routerVarName);
            if (routerVar) {
              foundRouter = routerVar;
            }
          }
        }
      }
    };

    ts.forEachChild(targetSourceFile, visit);
    return foundRouter;
  }

  private findRouterVariable(sourceFile: ts.SourceFile, routerName: string): RouterTypeInfo | null {
    let result: RouterTypeInfo | null = null;

    const visit = (node: ts.Node): void => {
      if (result) return;

      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isVariableDeclaration(decl) &&
            ts.isIdentifier(decl.name) &&
            decl.name.text === routerName &&
            decl.initializer
          ) {
            const initText = decl.initializer.getText();
            if (initText.includes('router(') || initText.includes('.router(')) {
              this.logger.info(`✅ Found router ${routerName} in ${sourceFile.fileName}`);

              // Create a pseudo-symbol for this router
              const routerSymbol = {
                name: routerName,
                flags: ts.SymbolFlags.Value,
                valueDeclaration: decl,
                getDeclarations: () => [decl],
                declarations: [decl],
              } as any as ts.Symbol;

              result = { routerSymbol, routerFile: sourceFile.fileName };
            }
          }
        }
      }
    };

    ts.forEachChild(sourceFile, visit);
    return result;
  }

  private tryCommonRouterLocations(typeChecker: ts.TypeChecker): RouterTypeInfo | null {
    this.logger.debug(`🔍 Trying common router locations...`);

    const commonNames = ['appRouter', 'router', 'mainRouter', 'rootRouter'];

    for (const name of commonNames) {
      // Try to resolve the name globally
      const symbol = typeChecker.resolveName(
        name,
        undefined as any, // Global scope
        ts.SymbolFlags.Value,
        false,
      );

      if (symbol?.valueDeclaration) {
        const sourceFile = symbol.valueDeclaration.getSourceFile();
        // Check if it's a router by looking at the initializer
        if (ts.isVariableDeclaration(symbol.valueDeclaration) && symbol.valueDeclaration.initializer) {
          const initText = symbol.valueDeclaration.initializer.getText();
          if (initText.includes('router(') || initText.includes('.router(')) {
            this.logger.info(`✅ Found router ${name} in ${sourceFile.fileName}`);
            return { routerSymbol: symbol, routerFile: sourceFile.fileName };
          }
        }
      }
    }

    return null;
  }

  /**
   * Checks if a variable is a tRPC client
   */
  isTrpcClient(
    variableName: string,
    sourceFile: ts.SourceFile,
    position: number,
    typeChecker: ts.TypeChecker,
  ): boolean {
    this.logger.debug(`🔎 Checking if ${variableName} is a tRPC client`);

    const identifier = this.findIdentifierAtPosition(sourceFile, variableName, position);
    if (!identifier) {
      this.logger.debug(`❌ No identifier found`);
      return false;
    }

    const symbol = typeChecker.getSymbolAtLocation(identifier);
    if (!symbol) {
      this.logger.debug(`❌ No symbol found`);
      return false;
    }

    // Check if it's an alias (imported)
    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(symbol) : symbol;

    // Check the initializer text
    const initializer = this.findInitializer(resolvedSymbol);
    if (initializer) {
      const text = initializer.getText();
      this.logger.debug(`📄 Initializer: ${text.substring(0, 100)}...`);

      if (
        text.includes('createTRPC') ||
        text.includes('initTRPC') ||
        text.includes('useUtils') ||
        text.includes('useContext')
      ) {
        this.logger.info(`✅ Found tRPC client by initializer: ${variableName}`);
        return true;
      }
    }

    // Check the type name
    const type = typeChecker.getTypeOfSymbolAtLocation(symbol, identifier);
    const typeName = typeChecker.typeToString(type);
    this.logger.debug(`📊 Type: ${typeName.substring(0, 200)}...`);

    const isTrpc =
      typeName.includes('TRPC') ||
      typeName.includes('CreateTRPC') ||
      typeName.includes('TRPCClient') ||
      typeName.includes('Proxy<DecoratedProcedureRecord') ||
      typeName.includes('AnyRouter');

    if (isTrpc) {
      this.logger.info(`✅ Found tRPC client by type: ${variableName}`);
    } else {
      this.logger.debug(`❌ ${variableName} is not a tRPC client`);
    }

    return isTrpc;
  }
}
