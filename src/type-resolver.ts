import * as path from 'node:path';
import * as ts from 'typescript/lib/tsserverlibrary';
import type { PluginConfigWithDefaults } from './config';
import type { Logger } from './types';

export interface RouterTypeInfo {
  routerSymbol: ts.Symbol;
  routerFile: string;
}

export class TypeResolver {
  constructor(
    private logger: Logger,
    private serverHost: ts.server.ServerHost,
    private config: PluginConfigWithDefaults,
  ) {}

  /**
   * Extracts router type information using configured router location
   */
  extractRouterType(
    variableName: string,
    _sourceFile: ts.SourceFile,
    _position: number,
    typeChecker: ts.TypeChecker,
    program: ts.Program,
  ): RouterTypeInfo | null {
    this.logger.debug(`🔍 extractRouterType called for ${variableName}`);

    try {
      // Use configured router location
      if (!this.config.router) {
        this.logger.error('No router configuration provided');
        return null;
      }

      // Resolve the router file path
      // In monorepos, we need to find where the tsconfig.json is located
      const configFile = program.getCompilerOptions().configFilePath as string | undefined;
      const configDir = configFile ? path.dirname(configFile) : program.getCurrentDirectory();

      const routerPath = path.isAbsolute(this.config.router.filePath)
        ? this.config.router.filePath
        : path.resolve(configDir, this.config.router.filePath);

      this.logger.debug(`Config dir: ${configDir}`);
      this.logger.debug(`Looking for router at: ${routerPath}`);

      // Get the router source file
      let routerSourceFile = program.getSourceFile(routerPath);

      // If not in program, try to read and parse it directly
      if (!routerSourceFile) {
        // Check if file exists
        if (!this.serverHost.fileExists(routerPath)) {
          this.logger.error(`Router file does not exist: ${routerPath}`);
          return null;
        }

        // Read and parse the file
        const fileContent = this.serverHost.readFile(routerPath);
        if (!fileContent) {
          this.logger.error(`Could not read router file: ${routerPath}`);
          return null;
        }

        routerSourceFile = ts.createSourceFile(routerPath, fileContent, ts.ScriptTarget.Latest, true);
      }

      // Find the router variable in the file
      const routerSymbol = this.findRouterVariable(routerSourceFile, this.config.router.variableName, typeChecker);

      if (!routerSymbol) {
        this.logger.error(`Could not find router variable '${this.config.router.variableName}' in ${routerPath}`);
        return null;
      }

      this.logger.info(`✅ Found router ${this.config.router.variableName} in ${routerPath}`);
      return {
        routerSymbol,
        routerFile: routerPath,
      };
    } catch (error) {
      this.logger.error(`Error extracting router type for ${variableName}`, error);
      return null;
    }
  }

  /**
   * Find a router variable in a source file by name
   */
  private findRouterVariable(
    sourceFile: ts.SourceFile,
    variableName: string,
    typeChecker: ts.TypeChecker,
  ): ts.Symbol | null {
    let routerNode: ts.Node | null = null;

    const visit = (node: ts.Node): void => {
      if (routerNode) return;

      // Look for variable declarations
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === variableName) {
            routerNode = decl;
            return;
          }
        }
      }

      // Look for export declarations
      if (ts.isExportAssignment(node) && !node.isExportEquals && node.expression) {
        if (ts.isIdentifier(node.expression) && node.expression.text === variableName) {
          routerNode = node;
          return;
        }
      }

      // Look for named exports
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportedName = element.name?.text || element.propertyName?.text;
          if (exportedName === variableName) {
            routerNode = element;
            return;
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (!routerNode) {
      return null;
    }

    // Try to get symbol from type checker first
    const symbol = typeChecker.getSymbolAtLocation(routerNode);
    if (symbol) {
      return symbol;
    }

    // If no symbol (e.g., file not in program), create a pseudo-symbol
    return {
      name: variableName,
      flags: ts.SymbolFlags.Value,
      valueDeclaration: routerNode,
      getDeclarations: () => [routerNode],
      declarations: [routerNode],
    } as any as ts.Symbol;
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

      const hasClientInitializer = this.config.patterns.clientInitializers.some((pattern) => text.includes(pattern));
      const hasUtilsMethod = text.includes(this.config.patterns.utilsMethod);
      const hasContext = text.includes('useContext');

      if (hasClientInitializer || hasUtilsMethod || hasContext) {
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
    }

    return isTrpc;
  }

  private findIdentifierAtPosition(
    sourceFile: ts.SourceFile,
    variableName: string,
    position: number,
  ): ts.Identifier | undefined {
    let result: ts.Identifier | undefined;

    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && node.text === variableName) {
        // If no result yet, or this identifier is closer to the position
        if (!result || (position >= node.getStart() && position <= node.getEnd())) {
          result = node;
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return result;
  }

  private findInitializer(symbol: ts.Symbol): ts.Node | undefined {
    const declarations = symbol.getDeclarations();
    if (!declarations) return undefined;

    for (const decl of declarations) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return decl.initializer;
      }
    }
    return undefined;
  }
}
