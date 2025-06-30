# tRPC Navigation Plugin

A TypeScript Language Service Plugin that fixes broken "go to definition" navigation for tRPC procedures when using TypeScript's declaration emit.

## Problem

When using tRPC with TypeScript's declaration emit (`declaration: true`), there's a TypeScript bug that completely breaks "go to definition" functionality. When you try to Cmd+Click on a tRPC procedure call like `api.users.getUser.useQuery()`, TypeScript only takes you to the root router definition - it can't navigate any deeper into nested routers or the actual procedure implementations.

This is caused by how TypeScript handles the complex type inference in tRPC's router chains when generating `.d.ts` files.

## Solution

This plugin bypasses TypeScript's broken type-based navigation by dynamically resolving your tRPC router types at runtime. When you Cmd+Click on a tRPC procedure, the plugin intercepts the navigation request and takes you directly to the procedure implementation in your source code.

## Features

- **Fixes Broken Navigation**: Restores "go to definition" functionality that TypeScript's declaration emit breaks
- **Direct Source Navigation**: Takes you to the actual implementation code, not type definitions
- **Dynamic Resolution**: Resolves router types on-demand with ~2ms performance
- **Intelligent Client Detection**: Automatically detects any tRPC client variable (api, trpc, client, etc.)
- **useUtils Support**: Full navigation support for `useUtils()` variables
- **Cross-Package Support**: Works seamlessly in monorepos with imported router types
- **Zero Configuration**: Works out of the box - no setup required
- **Minimal Overhead**: Lightweight with ~2ms response time

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

The plugin works with zero configuration. Simply add it to your tsconfig.json:

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

### Monorepo Setup

In monorepos, add the plugin to each package that uses tRPC (directly or through another package):

```json
// packages/api/tsconfig.json - has direct tRPC dependency
{
  "compilerOptions": {
    "plugins": [{ "name": "trpc-navigation-plugin" }]
  }
}

// packages/web/tsconfig.json - uses tRPC through @my/api package
{
  "compilerOptions": {
    "plugins": [{ "name": "trpc-navigation-plugin" }]
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

No configuration needed - the plugin automatically detects these patterns!

## How It Works

1. **Dynamic Type Resolution**: When you click on a tRPC call, the plugin dynamically resolves the router type from your client
2. **Type Chain Following**: Follows TypeScript's type chain from `AppRouter` to find the actual router implementation
3. **Cross-Package Support**: Automatically resolves imports across package boundaries in monorepos
4. **Smart Navigation**: Intercepts navigation requests and returns the exact source location
5. **Contextual Navigation**: Click on different parts for different results:
   - `api.billing.claims` - clicking "billing" goes to billing router
   - `api.billing.claims` - clicking "claims" goes to claims procedure/router

The plugin works with any tRPC pattern:

**Client Creation**:
```typescript
// All patterns work automatically
export const api = createTRPCReact<AppRouter>();
export const trpc = createTRPCNext<AppRouter>();
import { api } from '@my/api';  // Cross-package imports work
```

**Router Definitions**:
```typescript
export const userRouter = router({...})     // ✓ Works
export const appRouter = t.router({...})    // ✓ Works
export type AppRouter = typeof appRouter    // ✓ Type resolved dynamically
```


## Troubleshooting

If navigation isn't working:

1. Check the TS Server logs for `[TRPC-Nav]` entries
2. Enable verbose logging by adding `"verbose": true` to the plugin config
3. Ensure your tRPC client is created with the router type: `createTRPCReact<AppRouter>()`
4. Make sure your router type is properly exported: `export type AppRouter = typeof appRouter`
5. Restart the TS Server after configuration changes: `Cmd+Shift+P` → "TypeScript: Restart TS Server"

## Technical Details

- Uses TypeScript's Language Service API for dynamic type resolution
- Resolves router types in ~2ms without any caching needed
- Works around TypeScript's navigation bug without modifying your build process
- Compatible with tRPC v10+ and v11 that use the standard router pattern
- Supports monorepo setups with cross-package imports
- Does not interfere with TypeScript's type checking or declaration emit