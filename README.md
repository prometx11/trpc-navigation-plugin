# tRPC Navigation Plugin

A TypeScript Language Service Plugin that fixes broken "go to definition" navigation for tRPC procedures when using TypeScript's declaration emit.

## Problem

When using tRPC with TypeScript's declaration emit (`declaration: true`), there's a TypeScript bug that completely breaks "go to definition" functionality. When you try to Cmd+Click on a tRPC procedure call like `api.users.getUser.useQuery()`, TypeScript only takes you to the root router definition - it can't navigate any deeper into nested routers or the actual procedure implementations.

This is caused by how TypeScript handles the complex type inference in tRPC's router chains when generating `.d.ts` files.

## Solution

This plugin bypasses TypeScript's broken type-based navigation by using a configured router location. When you Cmd+Click on a tRPC procedure, the plugin intercepts the navigation request and takes you directly to the procedure implementation in your source code.

## Features

- **Fixes Broken Navigation**: Restores "go to definition" functionality that TypeScript's declaration emit breaks
- **Direct Source Navigation**: Takes you to the actual implementation code, not type definitions
- **Simple Configuration**: Just specify your router location - no complex setup
- **Intelligent Client Detection**: Automatically detects any tRPC client variable (api, trpc, client, etc.)
- **useUtils Support**: Full navigation support for `useUtils()` variables
- **Cross-Package Support**: Works seamlessly in monorepos
- **Fast Performance**: Direct navigation without complex type resolution

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

2. Configure in your `tsconfig.json` with your router location:
   ```json
   {
     "compilerOptions": {
       "plugins": [
         {
           "name": "trpc-navigation-plugin",
           "router": {
             "filePath": "./src/server/api/root.ts",
             "variableName": "appRouter"
           }
         }
       ]
     }
   }
   ```

3. Make sure you're using the workspace TypeScript version in VS Code (not the built-in version)
4. Restart the TypeScript server: `Cmd+Shift+P` → "TypeScript: Restart TS Server"

## Configuration

The plugin requires you to specify where your tRPC router is defined:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "trpc-navigation-plugin",
        "router": {
          "filePath": "./src/server/api/root.ts",  // Path to your router file
          "variableName": "appRouter"              // Name of your router variable
        }
      }
    ]
  }
}
```

### Configuration Options

- `router.filePath` (required): Path to the file containing your main tRPC router
  - Can be relative (resolved from project root) or absolute
  - Example: `"./src/server/api/root.ts"`

- `router.variableName` (required): Name of your router variable in that file
  - Example: `"appRouter"`, `"router"`, `"mainRouter"`

### Monorepo Setup

In monorepos, add the plugin to each package that uses tRPC:

```json
// packages/api/tsconfig.json - where router is defined
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "trpc-navigation-plugin",
        "router": {
          "filePath": "./src/router/index.ts",
          "variableName": "appRouter"
        }
      }
    ]
  }
}

// packages/web/tsconfig.json - uses tRPC through @my/api package
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "trpc-navigation-plugin",
        "router": {
          "filePath": "../api/src/router/index.ts",
          "variableName": "appRouter"
        }
      }
    ]
  }
}
```

### Optional: Enable Verbose Logging

For debugging, you can enable verbose logging:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "trpc-navigation-plugin",
        "router": {
          "filePath": "./src/server/api/root.ts",
          "variableName": "appRouter"
        },
        "verbose": true  // Enable detailed logging
      }
    ]
  }
}
```

## Automatic tRPC Client Detection

The plugin intelligently detects any tRPC client variable, regardless of naming:

```typescript
// All of these work automatically:
export const api = createTRPCReact<AppRouter>();
export const trpc = createTRPCNext<AppRouter>();
export const client = createTRPCProxyClient<AppRouter>();
export const myCustomName = initTRPC.create();

// In your components:
api.users.getUser.useQuery();      // ✓ Works
trpc.users.getUser.useQuery();     // ✓ Works
client.users.getUser.query();       // ✓ Works
myCustomName.users.getUser.query(); // ✓ Works

// useUtils variables also work:
const utils = api.useUtils();
const apiCtx = trpc.useUtils();
utils.users.getUser.fetch();       // ✓ Works
apiCtx.users.getUser.invalidate();  // ✓ Works
```

## How It Works

1. **Router Configuration**: You specify where your tRPC router is defined
2. **Client Detection**: The plugin detects when you click on a tRPC client call
3. **Direct Navigation**: Uses the configured router location to navigate directly to procedures
4. **Path Resolution**: Follows the navigation path through nested routers to find the target
5. **Contextual Navigation**: Click on different parts for different results:
   - `api.billing.claims` - clicking "billing" goes to billing router
   - `api.billing.claims` - clicking "claims" goes to claims procedure/router

## Troubleshooting

If navigation isn't working:

1. **Check Configuration**: Ensure your router config points to the correct file and variable name
2. **Verify Router Export**: Make sure your router is exported or declared in the specified file
3. **Check TS Server Logs**: Look for `[TRPC-Nav]` entries in the TypeScript Server logs
4. **Enable Verbose Logging**: Add `"verbose": true` to see detailed debug information
5. **Restart TS Server**: After configuration changes: `Cmd+Shift+P` → "TypeScript: Restart TS Server"

Common issues:
- Wrong file path: Paths are resolved from the project root (where tsconfig.json is)
- Wrong variable name: The variable name must match exactly (case-sensitive)
- Router not found: Make sure the router is a top-level export or variable declaration

## Technical Details

- Uses TypeScript's Language Service API for navigation interception
- Directly navigates to configured router location without complex type resolution
- Works around TypeScript's navigation bug without modifying your build process
- Compatible with tRPC v10+ and v11 that use the standard router pattern
- Supports monorepo setups with relative or absolute paths
- Does not interfere with TypeScript's type checking or declaration emit