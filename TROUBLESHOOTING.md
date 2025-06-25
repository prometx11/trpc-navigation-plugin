# TRPC Navigation Plugin Troubleshooting

## Setup Checklist

1. **Verify Installation**
   ```bash
   # Check if plugin is linked in node_modules
   ls -la node_modules/@my/trpc-navigation-plugin
   # Should show: -> ../../tooling/trpc-navigation-plugin
   ```

2. **Restart TypeScript Server**
   - In VS Code: `Cmd+Shift+P` → "TypeScript: Restart TS Server"
   - Or: `Cmd+Shift+P` → "Developer: Reload Window"

3. **Select Workspace TypeScript Version**
   - Open any TypeScript file
   - Look at the bottom right status bar for TypeScript version
   - Click on it and select "Use Workspace Version"
   - Should show: `TypeScript 5.8.3`

4. **Check TypeScript Server Logs**
   - `Cmd+Shift+P` → "TypeScript: Open TS Server Log"
   - Look for `[TRPC-Nav]` entries
   - If no entries, the plugin isn't loading

## Common Issues

### Plugin Not Loading

1. **Console Logs Not Appearing**
   - The plugin has console.log statements that should appear in VS Code's Output panel
   - Go to View → Output → Select "TypeScript" from dropdown
   - Look for `[TRPC-Nav] Plugin module loaded`

2. **Check File Being Edited**
   - The plugin is configured in `packages/app/tsconfig.json`
   - Make sure you're editing a file under `packages/app/`
   - Try opening `packages/app/features/appointments/UnsignedAppointmentsScreen.tsx`

3. **Verify tsconfig.json**
   ```json
   // Should contain:
   "compilerOptions": {
     "plugins": [
       {
         "name": "@my/trpc-navigation-plugin"
       }
     ]
   }
   ```

### Plugin Loads but Navigation Doesn't Work

1. **Check Navigation Map**
   - The plugin builds a map on first use
   - Check logs for: `Built navigation map with X entries`
   - If 0 entries, the scanning failed

2. **Verify API Usage Pattern**
   - Plugin looks for patterns like: `api.appointments.unsignedAppointments`
   - Must be followed by `.useQuery()`, `.useMutation()`, etc.

3. **Cache Issues**
   - Plugin caches for 30 seconds
   - Try waiting 30 seconds and retrying

## Manual Testing

Test the plugin directly:
```bash
cd tooling/trpc-navigation-plugin
node test-navigation.js
```

Should output:
- Found procedures
- Found main router file
- Found appRouter export

## VS Code Settings

Ensure these are set in `.vscode/settings.json`:
```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.tsserver.pluginPaths": [
    "./tooling/trpc-navigation-plugin"
  ],
  "typescript.tsserver.log": "verbose"
}
```

## Last Resort

1. Close VS Code completely
2. Delete `.vscode/.tsbuildinfo` and `packages/*/.cache`
3. Run `bun install`
4. Open VS Code
5. Select workspace TypeScript version
6. Try navigation again