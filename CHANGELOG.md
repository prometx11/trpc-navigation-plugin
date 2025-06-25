# TRPC Navigation Plugin Changelog

## v2.0.0 - TypeScript Rewrite

### Major Changes
- Converted entire plugin from JavaScript to TypeScript
- Modularized code into separate components:
  - `logger.ts` - Centralized logging functionality
  - `cache.ts` - Navigation cache with configurable timeout
  - `ast-scanner.ts` - AST scanning logic using ts-morph
  - `types.ts` - Shared TypeScript interfaces
- Added proper build process using Bun
- Added unit tests for cache functionality

### Improvements
- Better error handling and recovery
- Type-safe implementation
- Cleaner code organization
- Proper source maps for debugging
- Simplified dependency management using Bun

### Technical Details
- Uses `typescript/lib/tsserverlibrary` for TypeScript Language Service integration
- Synchronous AST scanning for compatibility with Language Service
- Build output in `dist/` directory
- Tests using Bun's built-in test runner

### Configuration
The plugin is automatically enabled for all packages that extend from `tooling/typescript/internal-package.json`.