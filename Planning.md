# Planning & Future Improvements

## Completed High Priority Tasks

✅ **Configurable tRPC Patterns**
- Added configuration for procedure types, router functions, client initializers
- Maintained sensible defaults for standard tRPC setups

✅ **File Extensions Configuration**
- Support for modern JS/TS extensions (.mts, .cts, .mjs, .cjs)
- Configurable list of extensions to process

## Remaining Tasks

### Medium Priority

1. **Platform-Specific Messages**
   - Currently shows "Cmd+Click" on all platforms
   - Should detect OS and show "Ctrl+Click" on Windows/Linux
   - Allow custom override in config
   - Implementation: Use `process.platform` to detect OS

2. **Improved Type Detection Patterns**
   - Add configuration for custom tRPC client type patterns
   - Support for detecting custom client wrappers
   - Better detection of re-exported clients

3. **Path Aliases & Absolute Imports**
   - Currently only supports relative imports
   - Add support for TypeScript path mappings (tsconfig paths)
   - Support for absolute imports from node_modules
   - Parse tsconfig.json compilerOptions.paths

### Low Priority

4. **Minor Configuration Options**
   - Make logger prefix configurable (currently hardcoded as '[TRPC-Nav]')
   - Make container names configurable
   - Add option to customize hover hint messages

5. **Advanced Router Support**
   - Support for dynamically imported routers
   - Better handling of routers created with factory functions
   - Support for routers exported as default exports

6. **Performance Optimizations**
   - Cache router file parsing results
   - Lazy load router files only when needed
   - Add debouncing for frequent navigation requests

### Nice to Have

7. **Developer Experience**
   - Add a command to validate configuration
   - Provide better error messages with suggested fixes
   - Add a diagnostic mode that shows what the plugin detects

8. **Testing Infrastructure**
   - Add unit tests for pattern matching
   - Integration tests with real tRPC projects
   - Test coverage for different tRPC versions

## Technical Debt

- Remove `@ts-ignore` in proxy setup by properly typing the proxy pattern
- Consider using a more robust AST traversal library
- Improve error handling with more specific error types

## Future Features

- **Multi-Router Support**: Support multiple routers in the same project without manual configuration
- **Auto-Discovery**: Automatically find router files without configuration
- **Jump to Tests**: Navigate to test files for procedures
- **Breadcrumb Navigation**: Show the full path in hover tooltips
- **Quick Fix Actions**: Add code actions to generate missing procedures

## Notes

- The plugin architecture is designed to be extensible
- All new features should maintain backward compatibility
- Performance is critical - avoid blocking the TypeScript Language Service
- Keep the configuration simple - advanced users can customize, but defaults should work for most