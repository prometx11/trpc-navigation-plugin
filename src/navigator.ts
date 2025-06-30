import * as path from 'node:path';
import * as ts from 'typescript/lib/tsserverlibrary';
import type { Logger } from './types';

export class Navigator {
  constructor(
    private logger: Logger,
    private serverHost: ts.server.ServerHost,
  ) {}

  /**
   * Navigates through a router structure to find the target definition
   */
  navigateRouterPath(
    routerSymbol: ts.Symbol,
    pathSegments: string[],
    typeChecker: ts.TypeChecker,
  ): ts.DefinitionInfo | null {
    try {
      if (!routerSymbol.valueDeclaration) {
        this.logger.debug(`No value declaration for router symbol`);
        return null;
      }

      let currentDeclaration = routerSymbol.valueDeclaration;

      // Process each segment
      for (let i = 0; i < pathSegments.length; i++) {
        const segment = pathSegments[i];
        const isLastSegment = i === pathSegments.length - 1;

        this.logger.debug(`Processing segment: ${segment} (${i + 1}/${pathSegments.length})`);

        const segmentResult = this.processRouterSegment(currentDeclaration, segment, isLastSegment, typeChecker);

        if (segmentResult) {
          if (segmentResult.definition) {
            return segmentResult.definition;
          }
          if (segmentResult.nextDeclaration) {
            currentDeclaration = segmentResult.nextDeclaration;
            continue;
          }
        }

        // If we can't process further, return current location
        break;
      }

      // Return the current declaration location
      return this.createDefinitionFromDeclaration(
        currentDeclaration,
        pathSegments[pathSegments.length - 1] || 'router',
      );
    } catch (error) {
      this.logger.error(`Error navigating router path`, error);
      return null;
    }
  }

  private processRouterSegment(
    declaration: ts.Declaration,
    segment: string,
    isLastSegment: boolean,
    _typeChecker: ts.TypeChecker,
  ): { definition?: ts.DefinitionInfo; nextDeclaration?: ts.Declaration } | null {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return null;
    }

    const routerCall = this.findRouterCall(declaration.initializer);
    if (!routerCall || !routerCall.arguments.length) {
      return null;
    }

    const routesArg = routerCall.arguments[0];
    if (!ts.isObjectLiteralExpression(routesArg)) {
      return null;
    }

    // Find the property matching the segment
    for (const prop of routesArg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== segment) {
        continue;
      }

      // Handle different property value types
      if (ts.isIdentifier(prop.initializer)) {
        return this.handleIdentifierProperty(prop.initializer, segment, isLastSegment, declaration.getSourceFile());
      } else if (ts.isCallExpression(prop.initializer)) {
        return this.handleInlineProcedure(prop, segment, isLastSegment);
      }

      break;
    }

    return null;
  }

  private handleIdentifierProperty(
    identifier: ts.Identifier,
    segment: string,
    isLastSegment: boolean,
    sourceFile: ts.SourceFile,
  ): { definition?: ts.DefinitionInfo; nextDeclaration?: ts.Declaration } | null {
    const declaration = this.findDeclaration(identifier.text, sourceFile);

    if (!declaration) {
      this.logger.debug(`Could not find declaration for ${identifier.text}`);
      return null;
    }

    const isProcedure = this.isProcedureDeclaration(declaration);

    if (isLastSegment || isProcedure) {
      return {
        definition: this.createDefinitionFromDeclaration(declaration, segment),
      };
    } else {
      // Continue navigation with this router
      return { nextDeclaration: declaration };
    }
  }

  private handleInlineProcedure(
    prop: ts.PropertyAssignment,
    segment: string,
    isLastSegment: boolean,
  ): { definition?: ts.DefinitionInfo } | null {
    if (!isLastSegment || !this.isProcedureCall(prop.initializer)) {
      return null;
    }

    const start = prop.getStart();
    const sourceFile = prop.getSourceFile();

    return {
      definition: {
        fileName: sourceFile.fileName,
        textSpan: {
          start,
          length: prop.getEnd() - start,
        },
        kind: ts.ScriptElementKind.functionElement,
        name: segment,
        containerKind: ts.ScriptElementKind.moduleElement,
        containerName: 'TRPC Procedure',
      },
    };
  }

  private findDeclaration(name: string, sourceFile: ts.SourceFile): ts.VariableDeclaration | null {
    let result: ts.VariableDeclaration | null = null;

    const visit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.name.text === name) {
            result = decl;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // If not found locally, check imports
    if (!result) {
      result = this.findImportedDeclaration(name, sourceFile);
    }

    return result;
  }

  private findImportedDeclaration(name: string, sourceFile: ts.SourceFile): ts.VariableDeclaration | null {
    let foundImportPath: string | undefined;

    // Find the import declaration
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const specifier of node.importClause.namedBindings.elements) {
          if (specifier.name.text === name) {
            if (ts.isStringLiteral(node.moduleSpecifier)) {
              foundImportPath = node.moduleSpecifier.text;
              return;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (!foundImportPath) return null;

    const importPath = foundImportPath;

    // Resolve the import path
    const currentDir = path.dirname(sourceFile.fileName);
    let resolvedPath = importPath;

    if (importPath.startsWith('.')) {
      resolvedPath = path.resolve(currentDir, importPath);

      // Try different extensions
      const extensions = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
      for (const ext of extensions) {
        const fullPath = resolvedPath + ext;
        if (this.serverHost.fileExists(fullPath)) {
          // Read and parse the file
          const content = this.serverHost.readFile(fullPath);
          if (content) {
            const importedFile = ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true);

            // Look for the exported declaration
            return this.findExportedDeclaration(name, importedFile);
          }
        }
      }
    }

    return null;
  }

  private findExportedDeclaration(name: string, sourceFile: ts.SourceFile): ts.VariableDeclaration | null {
    let result: ts.VariableDeclaration | null = null;

    const visit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.name.text === name) {
              result = decl;
              return;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return result;
  }

  private findRouterCall(node: ts.Node): ts.CallExpression | null {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        (ts.isIdentifier(expr) && expr.text === 'router') ||
        (ts.isPropertyAccessExpression(expr) && expr.name.text === 'router')
      ) {
        return node;
      }
    }

    let result: ts.CallExpression | null = null;
    ts.forEachChild(node, (child) => {
      if (!result) {
        result = this.findRouterCall(child);
      }
    });

    return result;
  }

  private isProcedureDeclaration(decl: ts.Declaration): boolean {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) {
      return false;
    }

    const text = decl.initializer.getText();
    return (
      text.includes('Procedure') &&
      (text.includes('.query') || text.includes('.mutation') || text.includes('.subscription')) &&
      !text.includes('router(')
    );
  }

  private isProcedureCall(node: ts.Node): boolean {
    const text = node.getText();
    return (
      text.includes('Procedure') &&
      (text.includes('.query') || text.includes('.mutation') || text.includes('.subscription')) &&
      !text.includes('router(')
    );
  }

  private createDefinitionFromDeclaration(declaration: ts.Declaration, name: string): ts.DefinitionInfo {
    const sourceFile = declaration.getSourceFile();
    const start = declaration.getStart();

    return {
      fileName: sourceFile.fileName,
      textSpan: {
        start,
        length: declaration.getEnd() - start,
      },
      kind: ts.ScriptElementKind.moduleElement,
      name,
      containerKind: ts.ScriptElementKind.moduleElement,
      containerName: 'TRPC',
    };
  }
}
