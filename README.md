The MIT License (MIT)

Copyright (c) [Year] [Your Name or Organization]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

/*
 * ----------------------------------------------------------------------------
 * "THE BEER-WARE LICENSE" (Revision 42):
 * <phk@FreeBSD.ORG> wrote this file. As long as you retain this notice you
 * can do whatever you want with this stuff. If we meet some day, and you think
 * this stuff is worth it, you can buy me a beer in return. Poul-Henning Kamp
 * ----------------------------------------------------------------------------
 */
A TypeScript Language Service Plugin that provides instant "go to definition" navigation for TRPC procedures, bypassing slow type evaluation in large codebases.

## Problem

When using TRPC with TypeScript's declaration emit, the generated type files become massive (1.1MB+) with deeply nested types. This causes TypeScript's "go to definition" feature to be extremely slow (2-10+ seconds) or fail entirely when clicking on API calls like `api.appointments.unsignedAppointments.useQuery()`.

## Solution

This plugin uses ts-morph to analyze the TRPC router structure and build a direct mapping from API paths to source files. When you Cmd+Click on a TRPC procedure, the plugin intercepts the navigation request and returns the source file location directly, bypassing TypeScript's slow type evaluation.

## Features

- **Instant Navigation**: Go directly to TRPC procedure implementations without type evaluation delays
- **Auto-Discovery**: Automatically scans and maps all TRPC procedures in the codebase
- **Smart Caching**: Caches the navigation map for 30 seconds to balance performance and freshness
- **Hover Hints**: Shows helpful hints when hovering over TRPC API calls
- **Zero Overhead**: Automatically disables itself in packages that don't use TRPC
- **Lazy Loading**: Only initializes when you actually click on a TRPC API call

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
       "name": "trpc-navigation-plugin"
         }
       ]
     }
   }
   ```

3. Make sure you're using the workspace TypeScript version in VS Code (not the built-in version)
4. Restart the TypeScript server: `Cmd+Shift+P` → "TypeScript: Restart TS Server"

## Configuration

All configuration is done in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
    "routerRoot": "./src/router",           // Optional: Where your TRPC routers are (auto-detected if not specified)
        "mainRouterName": "appRouter",          // Optional: Name of main router (default: "appRouter")
        "apiVariableName": "api",               // Optional: TRPC client variable (default: "api")
        "procedurePattern": "procedure_",       // Optional: Pattern for procedures (auto-detected if not specified)
        "cacheTimeout": 30000,                  // Optional: Cache duration in ms (default: 30000)
        "maxDepth": 10                          // Optional: Max router depth (default: 10)
      }
    ]
  }
}
```

## How It Works

1. **Scanning**: On first use, the plugin scans your configured router directory
- **Auto-detection mode** (default): Automatically detects both routers and procedures by their structure
   - **Pattern mode**: When `procedurePattern` is set, uses pattern matching for procedures
4. **Interception**: When you Cmd+Click on an API call, it returns the exact source location
5. **Smart Navigation**: Click on different parts for different results:
   - `api.billing.claims` - clicking "billing" goes to billing router
   - `api.billing.claims` - clicking "claims" goes to claims procedure/router

The plugin detects routers and procedures by their structure, not their names:

**Routers** - All of these work automatically:
```typescript
export const userRouter = router({...})     // ✓ Works
export const users = router({...})          // ✓ Works
export const userManagement = router({...}) // ✓ Works
export const foo = router({...})            // ✓ Works
  **Procedures** - Automatically detected when no pattern is configured:
```typescript
export const getUser = protectedProcedure.query(...)      // ✓ Works
export const updateUser = staffProcedure.mutation(...)    // ✓ Works
export const subscribeToUpdates = publicProcedure         // ✓ Works
  .input(z.object({...}))
  .subscription(...)
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
2. Verify your `routerRoot` path is correct and the directory exists
3. If using `procedurePattern`, ensure your procedures match the pattern
4. Make sure routers are properly exported and connected to your main router
5. Try restarting the TS Server

## Technical Details

- Uses ts-morph for AST traversal (no regex pattern matching)
- Handles nested routers and complex router structures
- Works with the existing TypeScript declaration emit setup
- Does not require any changes to the build process