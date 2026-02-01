#!/usr/bin/env node
/**
 * Check Development Command - Verifies development readiness
 *
 * This command checks:
 * 1. Branch status (not on main/master)
 * 2. Remote sync status
 * 3. Dev version status
 * 4. Link status for local dependencies
 * 5. Open PRs from working branch
 */

import { Config, getLogger } from '@grunnverk/core';
import { scanForPackageJsonFiles } from '@grunnverk/tree-core';
import { getGitStatusSummary, getLinkedDependencies, run } from '@grunnverk/git-tools';
import { getOctokit } from '@grunnverk/github-tools';
import { isDevelopmentVersion } from '@grunnverk/core';
import { readFile, access } from 'fs/promises';
import * as path from 'path';

/**
 * Default patterns for subprojects to exclude from scanning
 */
const DEFAULT_EXCLUDE_SUBPROJECTS = [
    'doc/',
    'docs/',
    'examples/',
    'test-*/',
];

/**
 * Checks if .gitignore contains required patterns to prevent publishing
 * development artifacts and sensitive files.
 */
async function checkGitignorePatterns(directory: string, checks: any): Promise<void> {
    const logger = getLogger();
    const gitignorePath = path.join(directory, '.gitignore');

    // Required patterns that must be present in .gitignore
    const requiredPatterns = [
        'node_modules',
        'dist',
        'package-lock.json',
        '.env',
        'output/',
        'coverage',
        '.kodrdriv*'
    ];

    // Check if .gitignore exists
    try {
        await access(gitignorePath);
    } catch {
        checks.gitignore.passed = false;
        checks.gitignore.issues.push('.gitignore file not found');
        checks.gitignore.issues.push(`Create .gitignore with patterns: ${requiredPatterns.join(', ')}`);
        return;
    }

    // Read .gitignore content
    let gitignoreContent: string;
    try {
        gitignoreContent = await readFile(gitignorePath, 'utf-8');
    } catch (error: any) {
        checks.gitignore.passed = false;
        checks.gitignore.issues.push(`Failed to read .gitignore: ${error.message}`);
        return;
    }

    // Parse .gitignore into lines, ignoring comments and empty lines
    const gitignoreLines = gitignoreContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    // Check for missing patterns
    const missingPatterns: string[] = [];
    for (const pattern of requiredPatterns) {
        // Check if the pattern exists in any of the gitignore lines
        const found = gitignoreLines.some(line => {
            // Exact match
            if (line === pattern) return true;

            // Pattern with wildcard - check if the pattern or any matching line exists
            if (pattern.includes('*')) {
                const basePattern = pattern.replace('*', '');
                // Accept exact wildcard pattern, base pattern, or any line starting with base
                return line === pattern || line === basePattern || line.startsWith(basePattern);
            }

            // Pattern with trailing slash - check both with and without slash
            if (pattern.endsWith('/')) {
                const basePattern = pattern.slice(0, -1);
                return line === basePattern || line === pattern || line.startsWith(pattern);
            }

            // Line with trailing slash - check if it matches the pattern (e.g., "node_modules/" matches "node_modules")
            if (line.endsWith('/')) {
                const lineBase = line.slice(0, -1);
                return lineBase === pattern || line.startsWith(pattern + '/');
            }

            return false;
        });

        if (!found) {
            missingPatterns.push(pattern);
        }
    }

    // Report missing patterns (relaxed check - allow variations)
    const criticalMissing = missingPatterns.filter(p => !p.includes('coverage') && p !== 'package-lock.json');
    if (criticalMissing.length > 0) {
        checks.gitignore.passed = false;
        checks.gitignore.issues.push(`Missing required patterns: ${criticalMissing.join(', ')}`);
        checks.gitignore.issues.push('These patterns prevent committing build artifacts and sensitive files');
    }

    logger.debug(`Gitignore check: ${checks.gitignore.passed ? 'passed' : 'failed'}`);
}

/**
 * Execute check-development command
 */
export async function execute(config: Config): Promise<string> {
    const logger = getLogger();
    // Get directory from config - check multiple possible locations
    const directory = (config as any).directory ||
                     config.tree?.directories?.[0] ||
                     process.cwd();

    // Get validateRelease flag - controls merge conflicts and open PRs checks
    const validateRelease = (config as any).validateReleaseWorkflow ?? false;

    logger.info(`Checking development readiness in ${directory}${validateRelease ? ' (full release validation)' : ' (quick check)'}`);

    // Build exclusion patterns
    const excludedPatterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        ...DEFAULT_EXCLUDE_SUBPROJECTS.map((pattern: string) => {
            const normalized = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
            return `**/${normalized}/**`;
        }),
    ];

    // Determine if this is a tree or single package
    const packageJsonFiles = await scanForPackageJsonFiles(directory, excludedPatterns);
    const isTree = packageJsonFiles.length > 1;

    logger.info(`Detected ${isTree ? 'tree' : 'single package'} with ${packageJsonFiles.length} package(s)`);

    const checks = {
        gitignore: { passed: true, issues: [] as string[] },
        branch: { passed: true, issues: [] as string[] },
        remoteSync: { passed: true, issues: [] as string[] },
        mergeConflicts: { passed: true, issues: [] as string[], warnings: [] as string[] },
        devVersion: { passed: true, issues: [] as string[] },
        linkStatus: { passed: true, issues: [] as string[], warnings: [] as string[] },
        openPRs: { passed: true, issues: [] as string[], warnings: [] as string[] },
        releaseWorkflow: { passed: true, issues: [] as string[], warnings: [] as string[] },
    };

    const packagesToCheck = isTree ? packageJsonFiles : [path.join(directory, 'package.json')];

    // Check .gitignore patterns (required for publish to succeed)
    await checkGitignorePatterns(directory, checks);

    // Build a set of all local package names for link status checking
    const localPackageNames = new Set<string>();
    for (const pkgJsonPath of packagesToCheck) {
        try {
            const pkgJsonContent = await readFile(pkgJsonPath, 'utf-8');
            const pkgJson = JSON.parse(pkgJsonContent);
            if (pkgJson.name) {
                localPackageNames.add(pkgJson.name);
            }
        } catch {
            // Skip packages we can't read
        }
    }

    for (const pkgJsonPath of packagesToCheck) {
        const pkgDir = path.dirname(pkgJsonPath);
        const pkgJsonContent = await readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(pkgJsonContent);
        const pkgName = pkgJson.name || path.basename(pkgDir);

        // 1. Check branch status
        try {
            const gitStatus = await getGitStatusSummary(pkgDir);
            if (gitStatus.branch === 'main' || gitStatus.branch === 'master') {
                checks.branch.passed = false;
                checks.branch.issues.push(`${pkgName} is on ${gitStatus.branch} branch`);
            }
        } catch (error: any) {
            checks.branch.issues.push(`${pkgName}: Could not check branch - ${error.message || error}`);
        }

        // 2. Check remote sync status
        try {
            await run('git fetch', { cwd: pkgDir });
            const { stdout: statusOutput } = await run('git status -sb', { cwd: pkgDir });

            if (statusOutput.includes('behind')) {
                checks.remoteSync.passed = false;
                const match = statusOutput.match(/behind (\d+)/);
                const count = match ? match[1] : 'some';
                checks.remoteSync.issues.push(`${pkgName} is ${count} commits behind remote`);
            }
        } catch (error: any) {
            checks.remoteSync.issues.push(`${pkgName}: Could not check remote sync - ${error.message || error}`);
        }

        // 3. Check for merge conflicts with target branch (main) - ALWAYS CHECK THIS
        try {
            const gitStatus = await getGitStatusSummary(pkgDir);
            const currentBranch = gitStatus.branch;
            const targetBranch = 'main'; // The branch we'll merge into during publish

            // Skip if we're already on main
            if (currentBranch !== 'main' && currentBranch !== 'master') {
                // Fetch latest to ensure we have up-to-date refs
                await run('git fetch origin', { cwd: pkgDir });

                // Try a test merge to detect conflicts
                // Use --no-commit --no-ff to simulate the merge without actually doing it
                try {
                    // Check if there would be conflicts using git merge --no-commit --no-ff
                    // This is safer as it doesn't modify the working tree
                    await run(
                        `git merge --no-commit --no-ff origin/${targetBranch}`,
                        { cwd: pkgDir }
                    );

                    // If we get here, check if there are conflicts
                    const { stdout: statusAfterMerge } = await run('git status --porcelain', { cwd: pkgDir });

                    if (statusAfterMerge.includes('UU ') || statusAfterMerge.includes('AA ') ||
                            statusAfterMerge.includes('DD ') || statusAfterMerge.includes('AU ') ||
                            statusAfterMerge.includes('UA ') || statusAfterMerge.includes('DU ') ||
                            statusAfterMerge.includes('UD ')) {
                        checks.mergeConflicts.passed = false;
                        checks.mergeConflicts.issues.push(
                            `${pkgName}: Merge conflicts detected with ${targetBranch} branch`
                        );
                    }

                    // Abort the test merge (only if there's actually a merge in progress)
                    try {
                        await run('git merge --abort', { cwd: pkgDir, suppressErrorLogging: true });
                    } catch {
                        // Ignore - there might not be a merge to abort if it was a fast-forward
                    }
                } catch (mergeError: any) {
                    // Abort any partial merge
                    try {
                        await run('git merge --abort', { cwd: pkgDir, suppressErrorLogging: true });
                    } catch {
                        // Ignore abort errors
                    }

                    // If merge failed, there are likely conflicts
                    if (mergeError.message?.includes('CONFLICT') || mergeError.stderr?.includes('CONFLICT') || mergeError.stdout?.includes('CONFLICT')) {
                        checks.mergeConflicts.passed = false;
                        checks.mergeConflicts.issues.push(
                            `${pkgName}: Merge conflicts detected with ${targetBranch} branch`
                        );
                    } else {
                        // Some other error - log as warning
                        checks.mergeConflicts.warnings.push(
                            `${pkgName}: Could not check for merge conflicts - ${mergeError.message || mergeError}`
                        );
                    }
                }
            }
        } catch (error: any) {
            checks.mergeConflicts.warnings.push(
                `${pkgName}: Could not check for merge conflicts - ${error.message || error}`
            );
        }

        // 4. Check dev version status
        const version = pkgJson.version;
        if (!version) {
            checks.devVersion.issues.push(`${pkgName}: No version field in package.json`);
        } else if (!isDevelopmentVersion(version)) {
            checks.devVersion.passed = false;
            checks.devVersion.issues.push(`${pkgName} has non-dev version: ${version}`);
        } else {
            // Check if base version exists on npm
            const baseVersion = version.split('-')[0];
            try {
                const { stdout } = await run(`npm view ${pkgName}@${baseVersion} version`, { cwd: pkgDir, suppressErrorLogging: true });
                if (stdout.trim() === baseVersion) {
                    checks.devVersion.passed = false;
                    checks.devVersion.issues.push(
                        `${pkgName}: Base version ${baseVersion} already published (current: ${version})`
                    );
                }
            } catch {
                // Version doesn't exist on npm, which is good
            }
        }

        // 5. Check link status (warning only - links are recommended but not required)
        if (pkgJson.dependencies || pkgJson.devDependencies) {
            try {
                const linkedDeps = await getLinkedDependencies(pkgDir);
                const allDeps = {
                    ...pkgJson.dependencies,
                    ...pkgJson.devDependencies,
                };

                const localDeps = Object.keys(allDeps).filter(dep => localPackageNames.has(dep));
                const unlinkedLocal = localDeps.filter(dep => !linkedDeps.has(dep));

                if (unlinkedLocal.length > 0) {
                    // Don't fail the check, just warn - links are recommended but not required
                    checks.linkStatus.warnings.push(
                        `${pkgName}: Local dependencies not linked (recommended): ${unlinkedLocal.join(', ')}`
                    );
                }
            } catch (error: any) {
                checks.linkStatus.warnings.push(`${pkgName}: Could not check link status - ${error.message || error}`);
            }
        }

        // 6. Check for open PRs from working branch - only if validateRelease is true
        if (validateRelease && pkgJson.repository?.url) {
            try {
                const gitStatus = await getGitStatusSummary(pkgDir);
                const currentBranch = gitStatus.branch;

                // Extract owner/repo from repository URL
                const repoUrl = pkgJson.repository.url;
                const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);

                if (match) {
                    const [, owner, repo] = match;

                    try {
                        const octokit = getOctokit();
                        const { data: openPRs } = await octokit.pulls.list({
                            owner,
                            repo,
                            state: 'open',
                            head: `${owner}:${currentBranch}`,
                        });

                        if (openPRs.length > 0) {
                            checks.openPRs.passed = false;
                            for (const pr of openPRs) {
                                const prInfo = `PR #${pr.number}: ${pr.title} (${pr.html_url})`;
                                checks.openPRs.issues.push(`${pkgName}: ${prInfo}`);
                            }
                        }
                    } catch (prError: any) {
                        // Only log if it's not a 404 (repo might not exist on GitHub)
                        if (!prError.message?.includes('404') && (!prError.status || prError.status !== 404)) {
                            checks.openPRs.warnings.push(
                                `${pkgName}: Could not check PRs - ${prError.message || prError}`
                            );
                        }
                    }
                }
            } catch (error: any) {
                // Don't fail the check if we can't check PRs
                checks.openPRs.warnings.push(
                    `${pkgName}: Could not check for open PRs - ${error.message || error}`
                );
            }
        }

        // 7. Check release workflow readiness (validate build, test, publish dry-run)
        // This check validates that the package can be successfully published
        // Only run if explicitly requested via config flag
        if ((config as any).validateReleaseWorkflow) {
            try {
                logger.info(`${pkgName}: Validating release workflow readiness...`);

                // Check 1: Build succeeds
                try {
                    await run('npm run build', { cwd: pkgDir });
                    logger.debug(`${pkgName}: Build check passed`);
                } catch (buildError: any) {
                    checks.releaseWorkflow.passed = false;
                    checks.releaseWorkflow.issues.push(
                        `${pkgName}: Build fails - ${buildError.message || buildError}`
                    );
                }

                // Check 2: Tests pass
                try {
                    await run('npm test', { cwd: pkgDir });
                    logger.debug(`${pkgName}: Test check passed`);
                } catch (testError: any) {
                    checks.releaseWorkflow.passed = false;
                    checks.releaseWorkflow.issues.push(
                        `${pkgName}: Tests fail - ${testError.message || testError}`
                    );
                }

                // Check 3: Publish dry-run succeeds
                try {
                    await run('npm publish --dry-run', { cwd: pkgDir });
                    logger.debug(`${pkgName}: Publish dry-run check passed`);
                } catch (publishError: any) {
                    checks.releaseWorkflow.passed = false;
                    checks.releaseWorkflow.issues.push(
                        `${pkgName}: Publish dry-run fails - ${publishError.message || publishError}`
                    );
                }

                // Check 4: NPM_TOKEN environment variable
                if (!process.env.NPM_TOKEN) {
                    checks.releaseWorkflow.warnings.push(
                        `${pkgName}: NPM_TOKEN environment variable not set (required for publishing)`
                    );
                }

                // Check 5: GitHub workflow file exists
                const workflowPath = path.join(pkgDir, '.github', 'workflows', 'npm-publish.yml');
                try {
                    await readFile(workflowPath, 'utf-8');
                    logger.debug(`${pkgName}: GitHub workflow file exists`);
                } catch {
                    checks.releaseWorkflow.warnings.push(
                        `${pkgName}: GitHub workflow file not found at .github/workflows/npm-publish.yml`
                    );
                }

            } catch (error: any) {
                checks.releaseWorkflow.warnings.push(
                    `${pkgName}: Could not validate release workflow - ${error.message || error}`
                );
            }
        }
    }

    // Build summary - linkStatus and releaseWorkflow are not included in allPassed (recommendations)
    // mergeConflicts is ALWAYS checked (critical for preventing post-merge failures)
    // openPRs is only checked when validateRelease is true
    const allPassed = checks.gitignore.passed &&
                     checks.branch.passed &&
                     checks.remoteSync.passed &&
                     checks.mergeConflicts.passed &&
                     checks.devVersion.passed &&
                     (validateRelease ? checks.openPRs.passed : true);

    const hasWarnings = checks.linkStatus.warnings.length > 0 ||
                       checks.mergeConflicts.warnings.length > 0 ||
                       checks.openPRs.warnings.length > 0 ||
                       checks.releaseWorkflow.warnings.length > 0;

    // Log results
    let summary = `\n${'='.repeat(60)}\n`;
    summary += `Development Readiness Check${validateRelease ? ' (Full Release Validation)' : ' (Quick Check)'}\n`;
    summary += `${'='.repeat(60)}\n\n`;
    summary += `Type: ${isTree ? 'Tree (monorepo)' : 'Single package'}\n`;
    summary += `Packages checked: ${packagesToCheck.length}\n\n`;

    if (allPassed) {
        summary += `✅ Status: READY FOR DEVELOPMENT\n\n`;
        summary += `All required checks passed:\n`;
        summary += `  ✓ Gitignore patterns\n`;
        summary += `  ✓ Branch status\n`;
        summary += `  ✓ Remote sync\n`;
        summary += `  ✓ No merge conflicts with main\n`;
        summary += `  ✓ Dev versions\n`;
        if (validateRelease) {
            summary += `  ✓ No open PRs\n`;
        }
        if (!hasWarnings) {
            summary += `  ✓ All local dependencies linked\n`;
        }
    } else {
        summary += `⚠️  Status: NOT READY\n\n`;

        if (!checks.gitignore.passed) {
            summary += `❌ Gitignore Issues:\n`;
            checks.gitignore.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }

        if (!checks.branch.passed) {
            summary += `❌ Branch Issues:\n`;
            checks.branch.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }

        if (!checks.remoteSync.passed) {
            summary += `❌ Remote Sync Issues:\n`;
            checks.remoteSync.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }

        if (!checks.mergeConflicts.passed) {
            summary += `❌ Merge Conflict Issues:\n`;
            checks.mergeConflicts.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
            summary += `   To resolve merge conflicts:\n`;
            summary += `   1. Fetch latest: git fetch origin main\n`;
            summary += `   2. Merge main into your branch: git merge origin/main\n`;
            summary += `   3. Resolve conflicts in your editor\n`;
            summary += `   4. Commit the merge: git add . && git commit\n`;
            summary += `   5. Run check-development again to verify\n`;
            summary += `\n`;
        }

        if (!checks.devVersion.passed) {
            summary += `❌ Dev Version Issues:\n`;
            checks.devVersion.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }

        if (validateRelease && !checks.openPRs.passed) {
            summary += `❌ Open PR Issues:\n`;
            checks.openPRs.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }

        if (!checks.releaseWorkflow.passed) {
            summary += `❌ Release Workflow Issues:\n`;
            checks.releaseWorkflow.issues.forEach(issue => summary += `   - ${issue}\n`);
            summary += `\n`;
        }
    }

    // Log warnings separately (non-blocking)
    if (hasWarnings) {
        summary += `⚠️  Recommendations:\n`;
        checks.linkStatus.warnings.forEach(warning => summary += `   - ${warning}\n`);
        checks.mergeConflicts.warnings.forEach(warning => summary += `   - ${warning}\n`);
        if (validateRelease) {
            checks.openPRs.warnings.forEach(warning => summary += `   - ${warning}\n`);
        }
        checks.releaseWorkflow.warnings.forEach(warning => summary += `   - ${warning}\n`);
        summary += `\n`;
    }

    summary += `${'='.repeat(60)}\n`;

    return summary;
}
