import * as path from 'node:path';
import { type CallExpression, Node, Project, SyntaxKind, type VariableDeclaration } from 'ts-morph';
import type { Logger, NavigationTarget, PluginConfig, ProcedureMapping } from './types';

export class AstScanner {
  private project: Project;
  private logger: Logger;
  private config: PluginConfig;
  private lastRouterPath: string | null = null;

  constructor(logger: Logger, config: PluginConfig) {
    this.logger = logger;
    this.config = config;
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        target: 99, // ESNext
        module: 1, // CommonJS
        moduleResolution: 2, // Node
      },
      useInMemoryFileSystem: false,
      skipFileDependencyResolution: true,
    });
  }

  scanRoutersSync(routerRootPath: string): ProcedureMapping {
    // Synchronous version for TypeScript Language Service compatibility
    const mapping: ProcedureMapping = {};
    const routerPath = routerRootPath;

    this.logger.info(`Scanning routers in: ${routerPath} (sync mode)`);
    const scanStartTime = Date.now();

    try {
      this.prepareProject(routerPath);
      
      // Step 1: Find all procedure definitions (synchronous)
      const procedureScanStart = Date.now();
      const procedures = this.scanProceduresSync();
      this.logger.info(`Found ${procedures.size} procedures in ${Date.now() - procedureScanStart}ms`);

      // Step 2: Build router hierarchy
      this.buildRouterHierarchy(routerPath, mapping, procedures);

      const totalScanTime = Date.now() - scanStartTime;
      this.logger.info(`Total scan completed in ${totalScanTime}ms`);
      return mapping;
    } catch (error) {
      this.logger.error(`Error scanning routers`, error);
      return mapping;
    }
  }

  private prepareProject(routerPath: string): void {
    // Only recreate project if router path changed
    if (this.lastRouterPath !== routerPath) {
      this.logger.debug('Router path changed, recreating project');
      this.project.getSourceFiles().forEach(sf => {
        this.project.removeSourceFile(sf);
      });
      this.lastRouterPath = routerPath;
      
      // Add router files to project
      const addFilesStart = Date.now();
      this.project.addSourceFilesAtPaths([
        `${routerPath}/**/*.ts`,
        `!${routerPath}/**/*.test.ts`,
        `!${routerPath}/**/*.spec.ts`,
      ]);
      this.logger.debug(`Added source files in ${Date.now() - addFilesStart}ms`);
    } else {
      // Refresh existing source files from disk
      const refreshStart = Date.now();
      const sourceFiles = this.project.getSourceFiles();
      this.logger.debug(`Refreshing ${sourceFiles.length} source files...`);
      
      sourceFiles.forEach(sf => {
        try {
          sf.refreshFromFileSystemSync();
        } catch (e) {
          // File might have been deleted, remove it
          this.logger.debug(`Failed to refresh ${sf.getFilePath()}, removing from project`);
          this.project.removeSourceFile(sf);
        }
      });
      
      // Check for new files and add them
      this.project.addSourceFilesAtPaths([
        `${routerPath}/**/*.ts`,
        `!${routerPath}/**/*.test.ts`,
        `!${routerPath}/**/*.spec.ts`,
      ]);
      
      this.logger.debug(`Refreshed source files in ${Date.now() - refreshStart}ms`);
    }
  }

  private scanProceduresSync(): Map<string, NavigationTarget> {
    const procedures = new Map<string, NavigationTarget>();
    
    this.project.getSourceFiles().forEach((sourceFile) => {
      const filePath = sourceFile.getFilePath();

      // Skip test files and other non-relevant files
      if (filePath.includes('.test.') || 
          filePath.includes('.spec.') ||
          filePath.includes('.d.ts') ||
          filePath.includes('__tests__') ||
          filePath.includes('__mocks__')) {
        return;
      }

      // Find all exported procedures
      sourceFile.getExportedDeclarations().forEach((declarations, name) => {
        // If pattern is configured, check for pattern match
        if (this.config.procedurePattern && name.startsWith(this.config.procedurePattern)) {
          declarations.forEach((decl) => {
            if (Node.isVariableDeclaration(decl)) {
              const start = decl.getStart();
              const lineAndCol = sourceFile.getLineAndColumnAtPos(start);
              const target = {
                fileName: filePath,
                line: lineAndCol.line,
                column: lineAndCol.column,
                position: start,
                length: decl.getEnd() - start,
                type: 'procedure' as const,
                procedureName: name,
              };
              procedures.set(name, target);
              this.logger.debug(`Found procedure ${name} at ${path.relative(process.cwd(), filePath)}:${lineAndCol.line}`);
            }
          });
        } else if (!this.config.procedurePattern) {
          // If no pattern, check if it's a procedure by structure
          declarations.forEach((decl) => {
            if (Node.isVariableDeclaration(decl) && this.isProcedureDeclaration(decl)) {
              const start = decl.getStart();
              const lineAndCol = sourceFile.getLineAndColumnAtPos(start);
              const target = {
                fileName: filePath,
                line: lineAndCol.line,
                column: lineAndCol.column,
                position: start,
                length: decl.getEnd() - start,
                type: 'procedure' as const,
                procedureName: name,
              };
              procedures.set(name, target);
              this.logger.debug(`Found procedure ${name} at ${path.relative(process.cwd(), filePath)}:${lineAndCol.line}`);
            }
          });
        }
      });
    });
    
    return procedures;
  }


  private buildRouterHierarchy(
    routerPath: string,
    mapping: ProcedureMapping,
    procedures: Map<string, NavigationTarget>
  ): void {
    const hierarchyBuildStart = Date.now();
    const mainRouterFile = this.project.getSourceFile(path.join(routerPath, 'index.ts'));

    if (!mainRouterFile) {
      this.logger.error('Could not find main router file');
      return;
    }

    const appRouter = mainRouterFile.getVariableDeclaration(this.config.mainRouterName || 'appRouter');
    if (!appRouter) {
      this.logger.error(`Could not find ${this.config.mainRouterName || 'appRouter'} variable`);
      return;
    }

    // Analyze the router structure
    this.analyzeRouter(appRouter, [], mapping, procedures, 0);

    this.logger.info(`Found ${Object.keys(mapping).length} procedure mappings in ${Date.now() - hierarchyBuildStart}ms`);
  }

  private analyzeRouter(
    routerNode: VariableDeclaration,
    currentPath: string[],
    mapping: ProcedureMapping,
    procedures: Map<string, NavigationTarget>,
    depth: number,
  ): void {
    if (depth > (this.config.maxDepth || 10)) {
      this.logger.debug(`Max depth reached at path: ${currentPath.join('.')}`);
      return;
    }

    const initializer = routerNode.getInitializer();
    if (!initializer) {
      this.logger.debug(`No initializer for router at: ${currentPath.join('.')}`);
      return;
    }

    // Find router() call
    let routerCall: CallExpression | null = null;
    if (Node.isCallExpression(initializer) && initializer.getExpression().getText() === 'router') {
      routerCall = initializer;
    } else {
      const calls = initializer.getDescendantsOfKind(SyntaxKind.CallExpression);
      routerCall =
        calls.find((call) => {
          const expr = call.getExpression();
          return expr.getText() === 'router' || expr.getText().endsWith('.router');
        }) || null;
    }

    if (!routerCall) {
      this.logger.debug(`No router call found for: ${currentPath.join('.')}`);
      return;
    }

    const routesArg = routerCall.getArguments()[0];
    if (!Node.isObjectLiteralExpression(routesArg)) {
      this.logger.debug(`Router argument is not object literal at: ${currentPath.join('.')}`);
      return;
    }

    // Process each route
    routesArg.getProperties().forEach((prop) => {
      if (!Node.isPropertyAssignment(prop)) return;

      const routeName = prop.getName();
      const routeValue = prop.getInitializer();

      if (!routeValue) return;

      if (Node.isIdentifier(routeValue)) {
        const valueText = routeValue.getText();

        // Check if it's a procedure (with or without pattern)
        const procedureInfo = procedures.get(valueText);
        if (procedureInfo) {
          const fullPath = `${this.config.apiVariableName}.${[...currentPath, routeName].join('.')}`;
          mapping[fullPath] = procedureInfo;
          const relativePath = require('path').relative(process.cwd(), procedureInfo.fileName);
          this.logger.info(`Mapped: ${fullPath} -> ${relativePath}:${procedureInfo.line}`);
        } else {
          // Check if it's a nested router by following the import
          this.logger.debug(`Checking if ${valueText} is a router at ${[...currentPath, routeName].join('.')}`);

          // Find the import for this identifier
          const sourceFile = routerNode.getSourceFile();
          const importDecl = sourceFile.getImportDeclarations().find((imp) => {
            const namedImports = imp.getNamedImports();
            return namedImports.some((ni) => ni.getName() === valueText);
          });

          if (importDecl) {
            const importedFile = importDecl.getModuleSpecifierSourceFile();
            if (importedFile) {
              const nestedRouter = importedFile.getVariableDeclaration(valueText);
              if (nestedRouter && this.isRouterDeclaration(nestedRouter)) {
                // It's a router!
                const routerPath = `${this.config.apiVariableName}.${[...currentPath, routeName].join('.')}`;
                const routerStart = nestedRouter.getStart();
                const routerLineAndCol = importedFile.getLineAndColumnAtPos(routerStart);

                mapping[routerPath] = {
                  fileName: importedFile.getFilePath(),
                  line: routerLineAndCol.line,
                  column: routerLineAndCol.column,
                  position: routerStart,
                  length: nestedRouter.getEnd() - routerStart,
                  type: 'router' as any,
                };
                this.logger.debug(
                  `Mapped router: ${routerPath} -> ${importedFile.getFilePath()}:${routerLineAndCol.line}`,
                );

                // Then analyze its contents
                this.analyzeRouter(nestedRouter, [...currentPath, routeName], mapping, procedures, depth + 1);
              }
            }
          }
        }
      } else if (Node.isCallExpression(routeValue)) {
        // Handle inline procedure definitions (e.g., staffProcedure.input().mutation())
        // Find the base procedure identifier by traversing up the call chain
        let currentNode: Node = routeValue;
        let baseProcedure: string | null = null;

        while (currentNode) {
          if (Node.isCallExpression(currentNode)) {
            const expr = currentNode.getExpression();
            if (Node.isPropertyAccessExpression(expr)) {
              currentNode = expr.getExpression();
            } else if (Node.isIdentifier(expr)) {
              baseProcedure = expr.getText();
              break;
            } else {
              break;
            }
          } else if (Node.isIdentifier(currentNode)) {
            baseProcedure = currentNode.getText();
            break;
          } else {
            break;
          }
        }

        // Check if we found a procedure type
        if (baseProcedure?.endsWith('Procedure')) {
          const sourceFile = routeValue.getSourceFile();
          // Get the property assignment for better positioning
          const propAssignment = routeValue.getFirstAncestorByKind(SyntaxKind.PropertyAssignment);
          const position = propAssignment ? propAssignment.getStart() : routeValue.getStart();
          const length = propAssignment
            ? propAssignment.getEnd() - position
            : routeValue.getEnd() - routeValue.getStart();
          const lineAndCol = sourceFile.getLineAndColumnAtPos(position);

          const fullPath = `${this.config.apiVariableName}.${[...currentPath, routeName].join('.')}`;
          mapping[fullPath] = {
            fileName: sourceFile.getFilePath(),
            line: lineAndCol.line,
            column: lineAndCol.column,
            position: position,
            length: length,
            type: 'inline-procedure',
          };
          this.logger.debug(`Mapped inline procedure: ${fullPath} -> ${sourceFile.getFilePath()}:${lineAndCol.line}`);
        }
      }
    });
  }

  private isRouterDeclaration(decl: VariableDeclaration): boolean {
    const initializer = decl.getInitializer();
    if (!initializer) return false;

    // Check if it's a direct router() call
    if (Node.isCallExpression(initializer)) {
      const expr = initializer.getExpression();
      if (expr.getText() === 'router' || expr.getText().endsWith('.router')) {
        return true;
      }
    }

    // Check if it has router() somewhere in the initialization chain
    const calls = initializer.getDescendantsOfKind(SyntaxKind.CallExpression);
    return calls.some((call) => {
      const expr = call.getExpression();
      return expr.getText() === 'router' || expr.getText().endsWith('.router');
    });
  }

  private isProcedureDeclaration(decl: VariableDeclaration): boolean {
    const initializer = decl.getInitializer();
    if (!initializer) return false;

    // Check if it's a procedure call chain
    // Look for patterns like:
    // - protectedProcedure.query()
    // - staffProcedure.input().mutation()
    // - adminProcedure.use().input().query()

    // First check if it's a call expression
    if (!Node.isCallExpression(initializer)) {
      return false;
    }

    // Traverse up the call chain to find the base
    let currentNode: Node = initializer;
    let foundProcedureBase = false;

    while (currentNode) {
      if (Node.isCallExpression(currentNode)) {
        const expr = currentNode.getExpression();

        // Check if it's a method call like .query() or .mutation()
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          if (methodName === 'query' || methodName === 'mutation' || methodName === 'subscription') {
            // This is likely a procedure if we find a procedure base
            currentNode = expr.getExpression();
            continue;
          } else if (
            methodName === 'input' ||
            methodName === 'use' ||
            methodName === 'output' ||
            methodName === 'meta'
          ) {
            // These are procedure builder methods
            currentNode = expr.getExpression();
            continue;
          }
          currentNode = expr.getExpression();
        } else if (Node.isIdentifier(expr)) {
          // Check if the identifier ends with 'Procedure'
          const text = expr.getText();
          if (text.endsWith('Procedure') || text === 'procedure' || text === 't') {
            foundProcedureBase = true;
            break;
          }
          break;
        } else {
          break;
        }
      } else if (Node.isPropertyAccessExpression(currentNode)) {
        // Handle chained property access
        currentNode = currentNode.getExpression();
      } else if (Node.isIdentifier(currentNode)) {
        const text = currentNode.getText();
        if (text.endsWith('Procedure') || text === 'procedure' || text === 't') {
          foundProcedureBase = true;
        }
        break;
      } else {
        break;
      }
    }

    return foundProcedureBase;
  }
}
