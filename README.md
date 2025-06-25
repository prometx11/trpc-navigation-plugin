# tRPC Navigation Plugin

A TypeScript Language Service Plugin that fixes broken "go to definition" navigation for tRPC procedures when using TypeScript's declaration emit.

## Problem

When using tRPC with TypeScript's declaration emit (`declaration: true`), there's a TypeScript bug that completely breaks "go to definition" functionality. When you try to Cmd+Click on a tRPC procedure call like `api.users.getUser.useQuery()`, TypeScript only takes you to the root router definition - it can't navigate any deeper into nested routers or the actual procedure implementations.

This is caused by how TypeScript handles the complex type inference in tRPC's router chains when generating `.d.ts` files.

## Solution

This plugin bypasses TypeScript's broken type-based navigation by directly analyzing your tRPC router structure using the TypeScript AST. When you Cmd+Click on a tRPC procedure, the plugin intercepts the navigation request and takes you directly to the procedure implementation in your source code.

## Features

- **Fixes Broken Navigation**: Restores "go to definition" functionality that TypeScript's declaration emit breaks
- **Direct Source Navigation**: Takes you to the actual implementation code, not type definitions
- **Auto-Discovery**: Automatically finds and maps all tRPC routers and procedures
- **Smart Caching**: Caches the navigation map to ensure fast performance
- **Zero Configuration**: Works out of the box for most tRPC projects
- **Minimal Overhead**: Only activates in projects using tRPC, with lazy initialization

## When You Need This Plugin

You need this plugin if:
- Your project uses tRPC
- You have `declaration: true` in your tsconfig.json (for generating .d.ts files)
- "Go to definition" on tRPC procedures doesn't work or takes you to the wrong place

You DON'T need this plugin if:
- You're not using TypeScript's declaration emit
- Your "go to definition" already works correctly

## Installation

1. Install the plugin:
   ```bash
   npm install --save-dev trpc-navigation-plugin
   # or
   yarn add -D trpc-navigation-plugin
   # or
   bun add -D trpc-navigation-plugin
   ```

2. Configure in your `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "plugins": [
         {
           "name": "trpc-navigation-plugin"
         }
       ]
     }
   }
   ```

3. Make sure you're using the workspace TypeScript version in VS Code (not the built-in version)
4. Restart the TypeScript server: `Cmd+Shift+P` → "TypeScript: Restart TS Server"

## Configuration

The plugin works out of the box with zero configuration for most projects. All configuration options are optional:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "trpc-navigation-plugin",
        "routerRoot": "./src/router",           // Optional: Where your TRPC routers are located
        "mainRouterName": "appRouter",          // Optional: Name of your main router export (default: "appRouter")
        "apiVariableName": "api",               // Optional: Variable name used for TRPC client (default: "api")
        "cacheTimeout": 30000                   // Optional: Cache duration in ms (default: 30000)
      }
    ]
  }
}
```

**Note**: The plugin automatically detects router locations if `routerRoot` is not specified, checking common paths like `./src/router`, `./src/routers`, `./src/server/router`, etc.

## How It Works

1. **Lazy Initialization**: The plugin only activates when you first click on a TRPC API call
2. **Auto-Detection**: Automatically finds and scans your router directory (or uses `routerRoot` if configured)
3. **AST Analysis**: Uses ts-morph to analyze your TypeScript files and build a mapping of API paths to source locations
4. **Smart Navigation**: When you Cmd+Click on an API call, it intercepts the request and returns the exact source location
5. **Contextual Navigation**: Click on different parts for different results:
   - `api.billing.claims` - clicking "billing" goes to billing router
   - `api.billing.claims` - clicking "claims" goes to claims procedure/router

The plugin detects routers and procedures by their structure, not their names:

**Routers** - All of these work automatically:
```typescript
export const userRouter = router({...})     // ✓ Works
export const users = router({...})          // ✓ Works
export const userManagement = router({...}) // ✓ Works
export const foo = router({...})            // ✓ Works
```

**Procedures** - Automatically detected when no pattern is configured:
```typescript
export const getUser = protectedProcedure.query(...)      // ✓ Works
export const updateUser = staffProcedure.mutation(...)    // ✓ Works
export const subscribeToUpdates = publicProcedure         // ✓ Works
  .input(z.object({...}))
  .subscription(...)
```
```

### Smart Package Detection

The plugin automatically detects if a package uses TRPC by checking for:
- Any `@trpc/*` dependencies
- Packages with "trpc" in the name
- Common API package patterns (packages ending with `/api`)

If none are found, the plugin disables itself with zero overhead. This means you can safely add it to a shared TypeScript config without impacting non-TRPC packages.

## Troubleshooting

If navigation isn't working:

1. Check the TS Server logs for `[TRPC-Nav]` entries
2. If using `routerRoot`, verify the path is correct and the directory exists
3. Ensure your main router is exported with the expected name (default: `appRouter`)
4. Make sure routers are properly exported and connected to your main router
5. Try restarting the TS Server after making configuration changes

## Technical Details

- Uses ts-morph for AST traversal to find procedure implementations
- Works around TypeScript's navigation bug without modifying your build process
- Compatible with tRPC v10+ and v11 that use the standard router pattern
- Does not interfere with TypeScript's type checking or declaration emit