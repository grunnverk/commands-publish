# Critical Bug Fix: Development Version Increment After Publish

## Problem

After publishing version `0.0.15`, the `kodrdriv development` command incorrectly bumped the working branch to `0.0.15-dev.0` instead of `0.0.16-dev.0`.

This is a **critical oversight** because:
- The working branch should always be ahead of the released version
- `0.0.15-dev.0` is semantically incorrect (implies development toward 0.0.15, which was already released)
- The correct next development version after releasing 0.0.15 is `0.0.16-dev.0`

## Root Cause

The `development` command was reading the version from the working branch's `package.json` **after** merging from main, but in cases where:
1. The working branch had merge conflicts
2. The working branch had an old dev version (e.g., `0.0.14-dev.0`)
3. The merge didn't properly update the version

The command would read the OLD version from the working branch instead of the RELEASED version from main.

### Example of the Bug

**Scenario:**
- Main branch: `0.0.15` (just published)
- Working branch before merge: `0.0.14-dev.0` (old dev version)
- After merge (with conflict or old version persisting): `0.0.14-dev.0`

**Buggy behavior:**
1. Read `currentVersion` from working branch = `"0.0.14-dev.0"`
2. `incrementPatchVersion("0.0.14-dev.0")` strips `-dev.0` and increments: `14 → 15`
3. Returns `"0.0.15"`
4. Add prerelease tag: `"0.0.15-dev.0"` ❌ **WRONG!**

**Expected behavior:**
1. Read `currentVersion` from **main branch** = `"0.0.15"`
2. `incrementPatchVersion("0.0.15")` increments: `15 → 16`
3. Returns `"0.0.16"`
4. Add prerelease tag: `"0.0.16-dev.0"` ✅ **CORRECT!**

## Solution

Modified `/src/commands/development.ts` to:
1. **Read the version from the target branch (main)** after publish, not from the working branch
2. Use `git show main:package.json` to get the released version
3. Fall back to working branch version only if target branch doesn't exist
4. Increment from the RELEASED version to ensure proper version progression

### Code Changes

```typescript
// BEFORE (lines 478-484)
const storage = createStorage();
const pkgJsonContents = await storage.readFile('package.json', 'utf-8');
const pkgJson = safeJsonParse(pkgJsonContents, 'package.json');
const validatedPkgJson = validatePackageJson(pkgJson, 'package.json');
const currentVersion = validatedPkgJson.version;

// AFTER (with fix)
const storage = createStorage();
const targetBranch = allBranchConfig && (allBranchConfig as any)[workingBranch]?.targetBranch || 'main';
let currentVersion: string;

try {
    // Try to read version from target branch (main) to get the released version
    const targetPackageResult = await run(`git show ${targetBranch}:package.json`);
    const targetPackageJson = safeJsonParse(targetPackageResult.stdout, 'package.json from target branch');
    const validatedTargetPkg = validatePackageJson(targetPackageJson, 'package.json from target branch');
    currentVersion = validatedTargetPkg.version;
    logger.info(`DEV_VERSION_SOURCE: Using version from target branch | Branch: ${targetBranch} | Version: ${currentVersion}`);
} catch (error: any) {
    // Fallback: If target branch doesn't exist, use current working branch version
    logger.warn(`DEV_VERSION_FALLBACK: Could not read version from target branch ${targetBranch} | Fallback: Using current branch version`);
    const pkgJsonContents = await storage.readFile('package.json', 'utf-8');
    const pkgJson = safeJsonParse(pkgJsonContents, 'package.json');
    const validatedPkgJson = validatePackageJson(pkgJson, 'package.json');
    currentVersion = validatedPkgJson.version;
}
```

## Testing

Added comprehensive test case `uses target branch version for increment after publish`:
- Mocks main branch with version `0.0.15` (released)
- Mocks working branch with old version `0.0.14-dev.0`
- Verifies that the development command correctly bumps to `0.0.16-dev.0`, not `0.0.15-dev.0`

## Impact

### Before Fix
- ❌ After publishing 0.0.15, working branch would be 0.0.15-dev.0
- ❌ Semantically incorrect version progression
- ❌ Working branch not ahead of released version
- ❌ Confusion about what version is being developed

### After Fix
- ✅ After publishing 0.0.15, working branch correctly becomes 0.0.16-dev.0
- ✅ Proper semantic versioning
- ✅ Working branch always ahead of released version
- ✅ Clear development progression

## Files Changed

1. `/src/commands/development.ts` - Core fix
2. `/tests/commands/development.test.ts` - Added regression test

## Related Issues

This fix ensures proper version management in the publish → development workflow cycle, which is critical for:
- Proper semantic versioning
- Clear version history in git
- Correct version tagging
- Development workflow clarity

## Date

January 20, 2026
