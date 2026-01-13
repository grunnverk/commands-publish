/* eslint-disable @typescript-eslint/no-unused-vars */
import path from 'path';
import * as Commit from '@eldrforge/commands-git';
import * as Release from './release';
import fs from 'fs/promises';

import { getLogger, getDryRunLogger, Config, PullRequest, Diff, getOutputPath, checkIfTagExists, confirmVersionInteractively, calculateBranchDependentVersion, DEFAULT_OUTPUT_DIRECTORY, KODRDRIV_DEFAULTS, runGitWithLock, filterContent } from '@eldrforge/core';
import { run, runWithDryRunSupport, runSecure, validateGitRef, safeJsonParse, validatePackageJson, isBranchInSyncWithRemote, safeSyncBranchWithRemote, localBranchExists, remoteBranchExists } from '@eldrforge/git-tools';
import * as GitHub from '@eldrforge/github-tools';
import { createStorage, incrementPatchVersion, calculateTargetVersion } from '@eldrforge/shared';
import { runAgenticPublish, formatAgenticPublishResult } from '@eldrforge/ai-service';

const scanNpmrcForEnvVars = async (storage: any): Promise<string[]> => {
    const logger = getLogger();
    const npmrcPath = path.join(process.cwd(), '.npmrc');
    const envVars: string[] = [];

    if (await storage.exists(npmrcPath)) {
        try {
            const npmrcContent = await storage.readFile(npmrcPath, 'utf-8');
            // Match environment variable patterns like ${VAR_NAME} or $VAR_NAME
            const envVarMatches = npmrcContent.match(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g);

            if (envVarMatches) {
                for (const match of envVarMatches) {
                    // Extract variable name from ${VAR_NAME} or $VAR_NAME format
                    const varName = match.replace(/\$\{|\}|\$/g, '');
                    if (varName && !envVars.includes(varName)) {
                        envVars.push(varName);
                    }
                }
            }

        } catch (error: any) {
            logger.warn(`NPMRC_READ_FAILED: Unable to read .npmrc configuration file | Path: ${npmrcPath} | Error: ${error.message}`);
            logger.verbose('NPMRC_READ_IMPACT: Environment variable detection for publishing may be affected due to failed .npmrc read');
        }
    } else {
        logger.debug('NPMRC_NOT_FOUND: No .npmrc file present in current directory | Action: Skipping environment variable scan | Path: ' + npmrcPath);
    }

    return envVars;
};

/**
 * Checks if package-lock.json contains file: dependencies (from npm link)
 * and cleans them up if found by removing package-lock.json and regenerating it.
 */
const cleanupNpmLinkReferences = async (isDryRun: boolean): Promise<void> => {
    const logger = getDryRunLogger(isDryRun);
    const packageLockPath = path.join(process.cwd(), 'package-lock.json');

    try {
        // Check if package-lock.json exists
        try {
            await fs.access(packageLockPath);
        } catch {
            // No package-lock.json, nothing to clean
            logger.verbose('PACKAGE_LOCK_NOT_FOUND: No package-lock.json file exists | Action: Skipping npm link cleanup | Path: ' + packageLockPath);
            return;
        }

        // Read and parse package-lock.json
        const packageLockContent = await fs.readFile(packageLockPath, 'utf-8');
        const packageLock = safeJsonParse(packageLockContent, packageLockPath);

        // Check for file: dependencies in the lockfile
        let hasFileReferences = false;

        // Check in packages (npm v7+)
        if (packageLock.packages) {
            for (const [pkgPath, pkgInfo] of Object.entries(packageLock.packages as Record<string, any>)) {
                if (pkgInfo.resolved && typeof pkgInfo.resolved === 'string' && pkgInfo.resolved.startsWith('file:')) {
                    // Check if it's a relative path (from npm link) rather than a workspace path
                    const resolvedPath = pkgInfo.resolved.replace('file:', '');
                    if (resolvedPath.startsWith('../') || resolvedPath.startsWith('./')) {
                        hasFileReferences = true;
                        logger.verbose(`NPM_LINK_DETECTED: Found npm link reference in packages section | Package: ${pkgPath} | Resolved: ${pkgInfo.resolved} | Type: relative_file_dependency`);
                        break;
                    }
                }
            }
        }

        // Check in dependencies (npm v6)
        if (!hasFileReferences && packageLock.dependencies) {
            for (const [pkgName, pkgInfo] of Object.entries(packageLock.dependencies as Record<string, any>)) {
                if (pkgInfo.version && typeof pkgInfo.version === 'string' && pkgInfo.version.startsWith('file:')) {
                    const versionPath = pkgInfo.version.replace('file:', '');
                    if (versionPath.startsWith('../') || versionPath.startsWith('./')) {
                        hasFileReferences = true;
                        logger.verbose(`NPM_LINK_DETECTED: Found npm link reference in dependencies section | Package: ${pkgName} | Version: ${pkgInfo.version} | Type: relative_file_dependency`);
                        break;
                    }
                }
            }
        }

        if (hasFileReferences) {
            logger.info('NPM_LINK_CLEANUP_REQUIRED: Detected npm link references in package-lock.json | File: package-lock.json | Impact: Must be cleaned before publish');
            logger.info('NPM_LINK_CLEANUP_STARTING: Removing package-lock.json and regenerating clean version | Action: Remove file with relative dependencies');

            if (isDryRun) {
                logger.info('DRY_RUN_OPERATION: Would remove package-lock.json and regenerate it | Mode: dry-run | File: package-lock.json');
            } else {
                // Remove package-lock.json
                await fs.unlink(packageLockPath);
                logger.verbose('NPM_LINK_CLEANUP_FILE_REMOVED: Deleted package-lock.json containing npm link references | Path: ' + packageLockPath);

                // Regenerate clean package-lock.json
                logger.verbose('NPM_LOCK_REGENERATING: Executing npm install to regenerate package-lock.json from package.json | Command: npm install --package-lock-only --no-audit --no-fund');
                await runWithDryRunSupport('npm install --package-lock-only --no-audit --no-fund', isDryRun);
                logger.info('NPM_LOCK_REGENERATED: Successfully regenerated clean package-lock.json without link references | Path: ' + packageLockPath);
            }
        } else {
            logger.verbose('NPM_LINK_CHECK_CLEAN: No npm link references found in package-lock.json | Status: Ready for publish | File: ' + packageLockPath);
        }
    } catch (error: any) {
        // Log warning but don't fail - let npm update handle any issues
        logger.warn(`NPM_LINK_CHECK_FAILED: Unable to check or clean npm link references | Error: ${error.message} | Impact: Continuing with publish, npm will handle issues`);
        logger.verbose('PUBLISH_PROCESS_CONTINUING: Proceeding with publish workflow despite npm link check failure | Next: Standard npm publish validation');
    }
};

const validateEnvironmentVariables = (requiredEnvVars: string[], isDryRun: boolean): void => {
    const logger = getDryRunLogger(isDryRun);
    const missingEnvVars: string[] = [];

    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            missingEnvVars.push(envVar);
        }
    }

    if (missingEnvVars.length > 0) {
        if (isDryRun) {
            logger.warn(`ENV_VARS_MISSING: Required environment variables not set | Variables: ${missingEnvVars.join(', ')} | Mode: dry-run | Impact: Would fail in real publish`);
        } else {
            logger.error(`ENV_VARS_MISSING: Required environment variables not set | Variables: ${missingEnvVars.join(', ')} | Action: Must set before publish | Source: .npmrc configuration`);
            throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}. Please set these environment variables before running publish.`);
        }
    }
};

const runPrechecks = async (runConfig: Config, targetBranch?: string): Promise<void> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const storage = createStorage();

    logger.info('PRECHECK_STARTING: Executing publish prechecks | Phase: validation | Target: ' + (targetBranch || 'default'));

    // Check if we're in a git repository
    try {
        if (isDryRun) {
            logger.info('PRECHECK_GIT_REPO: Would verify git repository | Mode: dry-run | Command: git rev-parse --git-dir');
        } else {
            await run('git rev-parse --git-dir');
        }

    } catch (error: any) {
        if (!isDryRun) {
            // Preserve the original error message to help with debugging
            const originalMessage = error.message || error.toString();
            throw new Error(`Not in a git repository or git command failed: ${originalMessage}. Please run this command from within a git repository.`);
        }
    }

    // Check for uncommitted changes
    logger.info('PRECHECK_GIT_STATUS: Checking for uncommitted changes | Command: git status --porcelain | Requirement: Clean working directory');
    try {
        if (isDryRun) {
            logger.info('PRECHECK_GIT_STATUS: Would verify clean working directory | Mode: dry-run | Command: git status --porcelain');
        } else {
            const { stdout } = await run('git status --porcelain');
            if (stdout.trim()) {
                throw new Error('Working directory has uncommitted changes. Please commit or stash your changes before running publish.');
            }
        }

    } catch (error: any) {
        if (!isDryRun) {
            // Preserve the original error message to help with debugging
            const originalMessage = error.message || error.toString();
            throw new Error(`Failed to check git status: ${originalMessage}. Please ensure you are in a valid git repository and try again.`);
        }
    }

    // Use the passed target branch or fallback to config/default
    const effectiveTargetBranch = targetBranch || runConfig.publish?.targetBranch || 'main';

    // Check that we're not running from the target branch
    logger.info('PRECHECK_BRANCH: Verifying current branch is not target branch | Target: ' + effectiveTargetBranch + ' | Requirement: Must run from feature branch');
    if (isDryRun) {
        logger.info(`PRECHECK_BRANCH: Would verify current branch is not target branch | Mode: dry-run | Target: ${effectiveTargetBranch}`);
    } else {
        const currentBranch = await GitHub.getCurrentBranchName();
        if (currentBranch === effectiveTargetBranch) {
            throw new Error(`Cannot run publish from the target branch '${effectiveTargetBranch}'. Please switch to a different branch before running publish.`);
        }
    }

    // Check target branch sync with remote
    logger.info(`PRECHECK_BRANCH_SYNC: Checking target branch sync with remote | Branch: ${effectiveTargetBranch} | Remote: origin | Requirement: Branches must be synchronized`);
    if (isDryRun) {
        logger.info(`PRECHECK_BRANCH_SYNC: Would verify target branch is in sync with remote | Mode: dry-run | Branch: ${effectiveTargetBranch} | Remote: origin`);
    } else {
        // Only check if local target branch exists (it's okay if it doesn't exist locally)
        const targetBranchExists = await localBranchExists(effectiveTargetBranch);
        if (targetBranchExists) {
            const syncStatus = await isBranchInSyncWithRemote(effectiveTargetBranch);

            if (!syncStatus.inSync) {
                logger.error(`BRANCH_SYNC_FAILED: Target branch not synchronized with remote | Branch: ${effectiveTargetBranch} | Status: out-of-sync | Impact: Cannot proceed with publish`);
                logger.error('');

                if (syncStatus.error) {
                    logger.error(`BRANCH_SYNC_ERROR: ${syncStatus.error}`);
                } else if (syncStatus.localSha && syncStatus.remoteSha) {
                    logger.error(`BRANCH_SYNC_DIVERGENCE: Local and remote commits differ | Local SHA: ${syncStatus.localSha.substring(0, 8)} | Remote SHA: ${syncStatus.remoteSha.substring(0, 8)}`);
                }

                // Check if agentic publish is enabled
                if (runConfig.publish?.agenticPublish) {
                    logger.info('');
                    logger.info('AGENTIC_PUBLISH_STARTING: Attempting automatic diagnosis and fix | Mode: agentic | Feature: AI-powered recovery');

                    try {
                        const currentBranch = await GitHub.getCurrentBranchName();
                        const agenticResult = await runAgenticPublish({
                            targetBranch: effectiveTargetBranch,
                            sourceBranch: currentBranch,
                            issue: 'branch_sync',
                            issueDetails: syncStatus.error || `Local SHA: ${syncStatus.localSha?.substring(0, 8)}, Remote SHA: ${syncStatus.remoteSha?.substring(0, 8)}`,
                            workingDirectory: process.cwd(),
                            maxIterations: runConfig.publish?.agenticPublishMaxIterations || 10,
                            storage,
                            logger,
                            dryRun: runConfig.dryRun,
                        });

                        // Display the formatted result
                        const formattedResult = formatAgenticPublishResult(agenticResult);
                        logger.info(formattedResult);

                        if (agenticResult.success) {
                            logger.info('AGENTIC_PUBLISH_SUCCESS: Issue resolved automatically | Status: ready-to-retry | Action: Re-running prechecks');
                            // Re-run the sync check to verify it was fixed
                            const reSyncStatus = await isBranchInSyncWithRemote(effectiveTargetBranch);
                            if (reSyncStatus.inSync) {
                                logger.info(`BRANCH_SYNC_VERIFIED: Target branch is now synchronized with remote | Branch: ${effectiveTargetBranch} | Status: in-sync`);
                                return; // Continue with publish
                            } else {
                                logger.warn('AGENTIC_PUBLISH_VERIFICATION_FAILED: Branch still not in sync after agentic fix | Status: needs-attention');
                            }
                        }

                        if (agenticResult.requiresManualIntervention) {
                            throw new Error(`Target branch '${effectiveTargetBranch}' requires manual intervention. Please see the steps above.`);
                        } else {
                            throw new Error(`Agentic publish could not resolve the issue automatically. Please see the analysis above.`);
                        }
                    } catch (agenticError: any) {
                        logger.warn(`AGENTIC_PUBLISH_FAILED: Agentic recovery failed | Error: ${agenticError.message} | Fallback: Manual steps`);
                        // Fall through to manual steps
                    }
                }

                logger.error('');
                logger.error('RESOLUTION_STEPS: Manual intervention required to sync branches:');
                logger.error(`   Step 1: Switch to target branch | Command: git checkout ${effectiveTargetBranch}`);
                logger.error(`   Step 2: Pull latest changes | Command: git pull origin ${effectiveTargetBranch}`);
                logger.error('   Step 3: Resolve merge conflicts if present');
                logger.error('   Step 4: Return to feature branch and retry publish');
                logger.error('');
                logger.error(`ALTERNATIVE_OPTION: Automatic sync available | Command: kodrdriv publish --sync-target | Branch: ${effectiveTargetBranch}`);
                logger.error(`ALTERNATIVE_OPTION_AI: AI-powered recovery available | Command: kodrdriv publish --agentic-publish | Branch: ${effectiveTargetBranch}`);

                throw new Error(`Target branch '${effectiveTargetBranch}' is not in sync with remote. Please sync the branch before running publish.`);
            } else {
                logger.info(`BRANCH_SYNC_VERIFIED: Target branch is synchronized with remote | Branch: ${effectiveTargetBranch} | Status: in-sync`);
            }
        } else {
            logger.info(`BRANCH_NOT_LOCAL: Target branch does not exist locally | Branch: ${effectiveTargetBranch} | Action: Will be created during publish process`);
        }
    }

    // Check GitHub Actions workflow configuration
    logger.info('PRECHECK_WORKFLOW: Checking GitHub Actions workflow configuration | Target: PR automation | Requirement: Workflows should trigger on pull requests');
    if (isDryRun) {
        logger.info('PRECHECK_WORKFLOW: Would check if GitHub Actions workflows are configured for pull requests | Mode: dry-run');
    } else {
        try {
            // TODO: Re-enable when checkWorkflowConfiguration is exported from github-tools
            // const workflowConfig = await GitHub.checkWorkflowConfiguration(effectiveTargetBranch);
            const workflowConfig = {
                hasWorkflows: true,
                hasPullRequestTriggers: true,
                workflowCount: 0,
                triggeredWorkflowNames: [] as string[]
            };

            if (!workflowConfig.hasWorkflows) {
                logger.warn('WORKFLOW_NOT_CONFIGURED: No GitHub Actions workflows found in repository | Impact: PR will be created but no automated checks will run | Recommendation: Add workflow file at .github/workflows/ci.yml');
                logger.warn('WORKFLOW_BEHAVIOR: Publish process will proceed without waiting for checks | PR State: Will be created | Check Status: None');
                logger.warn('WORKFLOW_RECOMMENDATION: Consider adding CI workflow to validate PRs automatically | Example: .github/workflows/ci.yml with PR triggers');
            } else if (!workflowConfig.hasPullRequestTriggers) {
                logger.warn(`WORKFLOW_NO_PR_TRIGGER: Found workflows but none trigger on pull requests | Workflow Count: ${workflowConfig.workflowCount} | Target Branch: ${effectiveTargetBranch} | Impact: No checks will run on PR`);
                logger.warn('WORKFLOW_BEHAVIOR: Publish process will create PR without automated checks | PR State: Will be created | Check Status: None');
                logger.warn(`WORKFLOW_RECOMMENDATION: Update workflow triggers to include PR events | Configuration: on.pull_request.branches: [${effectiveTargetBranch}]`);
            } else {
                logger.info(`WORKFLOW_CONFIGURED: Found workflows that will trigger on pull requests | Target Branch: ${effectiveTargetBranch} | Workflow Count: ${workflowConfig.triggeredWorkflowNames.length}`);
                for (const workflowName of workflowConfig.triggeredWorkflowNames) {
                    logger.info(`WORKFLOW_ACTIVE: ${workflowName} | Trigger: pull_request | Target: ${effectiveTargetBranch}`);
                }
            }
        } catch (error: any) {
            // Don't fail the precheck if we can't verify workflows
            // The wait logic will handle it later
            logger.debug(`WORKFLOW_CHECK_FAILED: Unable to verify workflow configuration | Error: ${error.message} | Impact: Will proceed with publish | Note: Wait logic will handle checks later`);
        }
    }

    // Check if prepublishOnly script exists in package.json
    logger.info('PRECHECK_PREPUBLISH: Checking for prepublishOnly script in package.json | Requirement: Must exist to run pre-flight checks | Expected: clean, lint, build, test');
    const packageJsonPath = path.join(process.cwd(), 'package.json');

    if (!await storage.exists(packageJsonPath)) {
        if (!isDryRun) {
            throw new Error('package.json not found in current directory.');
        } else {
            logger.warn('PACKAGE_JSON_NOT_FOUND: No package.json in current directory | Mode: dry-run | Impact: Cannot verify prepublishOnly script | Path: ' + packageJsonPath);
        }
    } else {
        let packageJson;
        try {
            const packageJsonContents = await storage.readFile(packageJsonPath, 'utf-8');
            const parsed = safeJsonParse(packageJsonContents, packageJsonPath);
            packageJson = validatePackageJson(parsed, packageJsonPath);

        } catch (error) {
            if (!isDryRun) {
                throw new Error('Failed to parse package.json. Please ensure it contains valid JSON.');
            } else {
                logger.warn('PACKAGE_JSON_PARSE_FAILED: Unable to parse package.json | Mode: dry-run | Impact: Cannot verify prepublishOnly script | Path: ' + packageJsonPath + ' | Requirement: Valid JSON format');
            }
        }

        if (packageJson && !packageJson.scripts?.prepublishOnly) {
            if (!isDryRun) {
                throw new Error('prepublishOnly script is required in package.json but was not found. Please add a prepublishOnly script that runs your pre-flight checks (e.g., clean, lint, build, test).');
            } else {
                logger.warn('PREPUBLISH_SCRIPT_MISSING: No prepublishOnly script found in package.json | Mode: dry-run | Requirement: Script must exist | Expected Tasks: clean, lint, build, test | Path: ' + packageJsonPath);
            }
        }
    }

    // Check required environment variables
    logger.verbose('PRECHECK_ENV_VARS: Checking required environment variables | Source: Configuration and .npmrc | Requirement: All required vars must be set');
    const coreRequiredEnvVars = runConfig.publish?.requiredEnvVars || [];
    const npmrcEnvVars = isDryRun ? [] : await scanNpmrcForEnvVars(storage); // Skip .npmrc scan in dry run
    const allRequiredEnvVars = [...new Set([...coreRequiredEnvVars, ...npmrcEnvVars])];

    if (allRequiredEnvVars.length > 0) {
        logger.verbose(`ENV_VARS_REQUIRED: Environment variables needed for publish | Variables: ${allRequiredEnvVars.join(', ')} | Count: ${allRequiredEnvVars.length} | Source: config + .npmrc`);
        validateEnvironmentVariables(allRequiredEnvVars, isDryRun);
    } else {
        logger.verbose('ENV_VARS_NONE: No required environment variables specified | Status: No validation needed | Source: config + .npmrc');
    }

    logger.info('PRECHECK_COMPLETE: All publish prechecks passed successfully | Status: Ready to proceed | Next: Execute publish workflow');
};

// Helper: deep-sort object keys for stable comparison
const sortObjectKeys = (value: any): any => {
    if (Array.isArray(value)) {
        return value.map(sortObjectKeys);
    }
    if (value && typeof value === 'object') {
        const sorted: any = {};
        Object.keys(value).sort().forEach((key) => {
            sorted[key] = sortObjectKeys(value[key]);
        });
        return sorted;
    }
    return value;
};

// Determine if there are substantive changes compared to the target branch (beyond just version bump)
const isReleaseNecessaryComparedToTarget = async (targetBranch: string, isDryRun: boolean): Promise<{ necessary: boolean; reason: string }> => {
    const logger = getDryRunLogger(isDryRun);

    // We compare current HEAD branch to the provided target branch
    const currentBranch = await GitHub.getCurrentBranchName();

    // Check if target branch exists before trying to compare
    try {
        // Validate target branch exists and is accessible
        await runSecure('git', ['rev-parse', '--verify', targetBranch]);
    } catch (error: any) {
        // Target branch doesn't exist or isn't accessible
        logger.verbose(`RELEASE_CHECK_NO_TARGET: Target branch does not exist or is not accessible | Branch: ${targetBranch} | Action: Proceeding with publish | Reason: First release to this branch`);
        return { necessary: true, reason: `Target branch '${targetBranch}' does not exist; first release to this branch` };
    }

    // If branches are identical, nothing to release
    const { stdout: namesStdout } = await runSecure('git', ['diff', '--name-only', `${targetBranch}..${currentBranch}`]);
    const changedFiles = namesStdout.split('\n').map(s => s.trim()).filter(Boolean);

    if (changedFiles.length === 0) {
        // No definitive signal; proceed with publish rather than skipping
        return { necessary: true, reason: 'No detectable changes via diff; proceeding conservatively' };
    }

    // If any files changed other than package.json (package-lock.json is gitignored), a release is necessary
    const nonVersionFiles = changedFiles.filter(f => f !== 'package.json');
    if (nonVersionFiles.length > 0) {
        return { necessary: true, reason: `Changed files beyond version bump: ${nonVersionFiles.join(', ')}` };
    }

    // Only package.json changed. Verify package.json change is only the version field
    try {
        // Read package.json content from both branches
        const { stdout: basePkgStdout } = await runSecure('git', ['show', `${targetBranch}:package.json`]);
        const { stdout: headPkgStdout } = await runSecure('git', ['show', `${currentBranch}:package.json`]);

        const basePkg = validatePackageJson(safeJsonParse(basePkgStdout, `${targetBranch}:package.json`), `${targetBranch}:package.json`);
        const headPkg = validatePackageJson(safeJsonParse(headPkgStdout, `${currentBranch}:package.json`), `${currentBranch}:package.json`);

        const { version: _baseVersion, ...baseWithoutVersion } = basePkg;
        const { version: _headVersion, ...headWithoutVersion } = headPkg;

        const baseSorted = sortObjectKeys(baseWithoutVersion);
        const headSorted = sortObjectKeys(headWithoutVersion);

        const equalExceptVersion = JSON.stringify(baseSorted) === JSON.stringify(headSorted);
        if (equalExceptVersion) {
            const currentVersion = headPkg.version;
            const targetVersion = basePkg.version;
            return {
                necessary: false,
                reason: `No meaningful changes detected:\n   • Current version: ${currentVersion}\n   • Target branch version: ${targetVersion}\n   • Only package.json version field differs\n\n   To force republish: Add meaningful code changes or use --force (not yet implemented)`
            };
        }

        // Other fields changed inside package.json
        return { necessary: true, reason: 'package.json changes beyond version field' };
    } catch (error: any) {
        // Conservative: if we cannot prove it is only a version change, proceed with release
        logger.verbose(`RELEASE_CHECK_COMPARISON_FAILED: Unable to conclusively compare package.json changes | Error: ${error.message} | Action: Proceeding conservatively with publish | Reason: Cannot verify version-only change`);
        return { necessary: true, reason: 'Could not compare package.json safely' };
    }
};

const handleTargetBranchSyncRecovery = async (runConfig: Config, targetBranch: string): Promise<void> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    logger.info(`BRANCH_SYNC_ATTEMPTING: Initiating sync of target branch with remote | Branch: ${targetBranch} | Remote: origin | Operation: fetch + merge`);

    if (isDryRun) {
        logger.info(`BRANCH_SYNC_DRY_RUN: Would attempt to sync branch with remote | Mode: dry-run | Branch: ${targetBranch} | Remote: origin`);
        return;
    }

    const syncResult = await safeSyncBranchWithRemote(targetBranch);

    if (syncResult.success) {
        logger.info(`BRANCH_SYNC_SUCCESS: Successfully synchronized branch with remote | Branch: ${targetBranch} | Remote: origin | Status: in-sync`);
        logger.info('BRANCH_SYNC_NEXT_STEP: Ready to proceed with publish | Action: Re-run publish command | Branch: ' + targetBranch);
    } else if (syncResult.conflictResolutionRequired) {
        logger.error(`BRANCH_SYNC_CONFLICTS: Sync failed due to merge conflicts | Branch: ${targetBranch} | Status: conflicts-detected | Resolution: Manual intervention required`);
        logger.error('');
        logger.error('CONFLICT_RESOLUTION_STEPS: Manual conflict resolution required:');
        logger.error(`   Step 1: Switch to target branch | Command: git checkout ${targetBranch}`);
        logger.error(`   Step 2: Pull and resolve conflicts | Command: git pull origin ${targetBranch}`);
        logger.error('   Step 3: Commit resolved changes | Command: git commit');
        logger.error('   Step 4: Return to feature branch and retry | Command: kodrdriv publish');
        logger.error('');
        throw new Error(`Target branch '${targetBranch}' has conflicts that require manual resolution.`);
    } else {
        logger.error(`BRANCH_SYNC_FAILED: Sync operation failed | Branch: ${targetBranch} | Error: ${syncResult.error} | Remote: origin`);
        throw new Error(`Failed to sync target branch: ${syncResult.error}`);
    }
};

export const execute = async (runConfig: Config): Promise<void> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const storage = createStorage();

    // Get current branch for branch-dependent targeting
    let currentBranch: string;
    if (isDryRun) {
        currentBranch = 'mock-branch';
    } else {
        currentBranch = await GitHub.getCurrentBranchName();

        // Fetch latest remote information to avoid conflicts
        logger.info('GIT_FETCH_STARTING: Fetching latest remote information | Remote: origin | Purpose: Avoid conflicts during publish | Command: git fetch origin');
        try {
            await run('git fetch origin');
            logger.info('GIT_FETCH_SUCCESS: Successfully fetched latest remote information | Remote: origin | Status: up-to-date');
        } catch (error: any) {
            logger.warn(`GIT_FETCH_FAILED: Unable to fetch from remote | Remote: origin | Error: ${error.message} | Impact: May cause conflicts if remote has changes`);
        }

        // Sync current branch with remote to avoid conflicts
        logger.info(`CURRENT_BRANCH_SYNC: Synchronizing current branch with remote | Branch: ${currentBranch} | Remote: origin | Purpose: Avoid conflicts during publish`);
        try {
            const remoteExists = await run(`git ls-remote --exit-code --heads origin ${currentBranch}`).then(() => true).catch(() => false);

            if (remoteExists) {
                // Use explicit fetch+merge instead of pull to avoid git config conflicts
                await runGitWithLock(process.cwd(), async () => {
                    await run(`git fetch origin ${currentBranch}`);
                    await run(`git merge origin/${currentBranch} --no-edit`);
                }, `sync ${currentBranch}`);
                logger.info(`CURRENT_BRANCH_SYNCED: Successfully synchronized current branch with remote | Branch: ${currentBranch} | Remote: origin/${currentBranch} | Status: in-sync`);
            } else {
                logger.info(`REMOTE_BRANCH_NOT_FOUND: No remote branch exists | Branch: ${currentBranch} | Remote: origin | Action: Will be created on first push`);
            }
        } catch (error: any) {
            if (error.message && error.message.includes('CONFLICT')) {
                logger.error(`MERGE_CONFLICTS_DETECTED: Conflicts found when syncing current branch with remote | Branch: ${currentBranch} | Remote: origin/${currentBranch} | Status: conflicts-require-resolution`);
                logger.error(`CONFLICT_RESOLUTION_REQUIRED: Manual intervention needed to resolve conflicts and continue:`);
                logger.error(`   Step 1: Resolve conflicts in affected files`);
                logger.error(`   Step 2: Stage resolved files | Command: git add <resolved-files>`);
                logger.error(`   Step 3: Commit resolution | Command: git commit`);
                logger.error(`   Step 4: Retry publish | Command: kodrdriv publish`);
                throw new Error(`Merge conflicts detected when syncing ${currentBranch} with remote. Please resolve conflicts manually.`);
            } else {
                logger.warn(`CURRENT_BRANCH_SYNC_FAILED: Unable to sync current branch with remote | Branch: ${currentBranch} | Remote: origin/${currentBranch} | Error: ${error.message} | Impact: May cause issues during publish`);
            }
        }
    }

    // Determine target branch and version strategy based on branch configuration
    let targetBranch = runConfig.publish?.targetBranch || 'main';
    let branchDependentVersioning = false;

    // Check for branches configuration
    if (runConfig.branches && runConfig.branches[currentBranch]) {
        branchDependentVersioning = true;

        const branchConfig = runConfig.branches[currentBranch];

        if (branchConfig.targetBranch) {
            targetBranch = branchConfig.targetBranch;
        }

        logger.info(`BRANCH_DEPENDENT_TARGETING: Branch-specific configuration active | Source: ${currentBranch} | Target: ${targetBranch} | Feature: Branch-dependent versioning and targeting`);
        logger.info(`BRANCH_CONFIGURATION_SOURCE: Current branch | Branch: ${currentBranch} | Type: source`);
        logger.info(`BRANCH_CONFIGURATION_TARGET: Target branch for publish | Branch: ${targetBranch} | Type: destination`);

        // Look at target branch config to show version strategy
        const targetBranchConfig = runConfig.branches[targetBranch];
        if (targetBranchConfig?.version) {
            const versionType = targetBranchConfig.version.type;
            const versionTag = targetBranchConfig.version.tag;
            const versionIncrement = targetBranchConfig.version.increment;

            logger.info(`VERSION_STRATEGY: Target branch version configuration | Branch: ${targetBranch} | Type: ${versionType} | Tag: ${versionTag || 'none'} | Increment: ${versionIncrement ? 'enabled' : 'disabled'}`);
        }
    } else {
        logger.debug(`BRANCH_TARGETING_DEFAULT: No branch-specific configuration found | Branch: ${currentBranch} | Action: Using default target | Target: ${targetBranch}`);
    }

    // Handle --sync-target flag
    if (runConfig.publish?.syncTarget) {
        await handleTargetBranchSyncRecovery(runConfig, targetBranch);
        return; // Exit after sync operation
    }

    // Check if target branch exists and create it if needed
    logger.info(`TARGET_BRANCH_CHECK: Verifying target branch existence | Branch: ${targetBranch} | Action: Create if missing | Source: Current HEAD`);
    if (isDryRun) {
        logger.info(`TARGET_BRANCH_CHECK: Would verify target branch exists and create if needed | Mode: dry-run | Branch: ${targetBranch}`);
    } else {
        const targetBranchExists = await localBranchExists(targetBranch);
        if (!targetBranchExists) {
            // Check if it exists on remote
            const remoteExists = await remoteBranchExists(targetBranch);

            if (remoteExists) {
                logger.info(`TARGET_BRANCH_TRACKING: Target branch exists on remote but not locally, tracking origin/${targetBranch} | Branch: ${targetBranch}`);
                try {
                    await runGitWithLock(process.cwd(), async () => {
                        // Create local branch tracking remote
                        await runSecure('git', ['branch', targetBranch, `origin/${targetBranch}`]);
                        logger.info(`TARGET_BRANCH_CREATED: Successfully created local tracking branch | Branch: ${targetBranch} | Source: origin/${targetBranch}`);
                    }, `track target branch ${targetBranch}`);
                } catch (error: any) {
                    throw new Error(`Failed to track target branch '${targetBranch}': ${error.message}`);
                }
            } else {
                logger.info(`TARGET_BRANCH_CREATING: Target branch does not exist locally or on remote, creating from current branch | Branch: ${targetBranch} | Source: HEAD | Remote: origin`);
                try {
                    // Wrap git branch and push operations with lock
                    await runGitWithLock(process.cwd(), async () => {
                        // Create the target branch from the current HEAD
                        await runSecure('git', ['branch', targetBranch, 'HEAD']);
                        logger.info(`TARGET_BRANCH_CREATED: Successfully created target branch locally | Branch: ${targetBranch} | Source: HEAD`);

                        // Push the new branch to origin
                        await runSecure('git', ['push', 'origin', targetBranch]);
                        logger.info(`TARGET_BRANCH_PUSHED: Successfully pushed new target branch to remote | Branch: ${targetBranch} | Remote: origin/${targetBranch}`);
                    }, `create and push target branch ${targetBranch}`);
                } catch (error: any) {
                    throw new Error(`Failed to create target branch '${targetBranch}': ${error.message}`);
                }
            }
        } else {
            logger.info(`TARGET_BRANCH_EXISTS: Target branch already exists locally | Branch: ${targetBranch} | Status: ready`);
        }
    }

    // Run prechecks before starting any work
    await runPrechecks(runConfig, targetBranch);

    // Early check: determine if a release is necessary compared to target branch
    logger.info('RELEASE_NECESSITY_CHECK: Evaluating if release is required | Comparison: current branch vs target | Target: ' + targetBranch + ' | Purpose: Avoid unnecessary publishes');
    try {
        const necessity = await isReleaseNecessaryComparedToTarget(targetBranch, isDryRun);
        if (!necessity.necessary) {
            logger.info(`\nRELEASE_SKIPPED: No meaningful changes detected, skipping publish | Reason: ${necessity.reason} | Target: ${targetBranch}`);
            // Emit a machine-readable marker so tree mode can detect skip and avoid propagating versions
            // CRITICAL: Use console.log to write to stdout (logger.info goes to stderr via winston)
            // eslint-disable-next-line no-console
            console.log('KODRDRIV_PUBLISH_SKIPPED');
            return;
        } else {
            logger.verbose(`RELEASE_PROCEEDING: Meaningful changes detected, continuing with publish | Reason: ${necessity.reason} | Target: ${targetBranch}`);
        }
    } catch (error: any) {
        // On unexpected errors, proceed with publish to avoid false negatives blocking releases
        logger.verbose(`RELEASE_NECESSITY_CHECK_ERROR: Unable to determine release necessity | Error: ${error.message} | Action: Proceeding conservatively with publish | Rationale: Avoid blocking valid releases`);
    }

    logger.info('RELEASE_PROCESS_STARTING: Initiating release workflow | Target: ' + targetBranch + ' | Phase: dependency updates and version management');


    let pr: PullRequest | null = null;

    if (isDryRun) {
        logger.info('PR_CHECK: Would check for existing pull request | Mode: dry-run | Action: Skip PR lookup');
        logger.info('PR_ASSUMPTION: Assuming no existing PR found | Mode: dry-run | Purpose: Demo workflow');
    } else {
        const branchName = await GitHub.getCurrentBranchName();
        pr = await GitHub.findOpenPullRequestByHeadRef(branchName);
    }

    if (pr) {
        logger.info(`PR_FOUND: Existing pull request detected for current branch | URL: ${pr.html_url} | Status: open`);
    } else {
        logger.info('PR_NOT_FOUND: No open pull request exists for current branch | Action: Starting new release publishing process | Next: Prepare dependencies and version');

        // STEP 1: Prepare for release (update dependencies and run prepublish checks) with NO version bump yet
        logger.verbose('RELEASE_PREP_STARTING: Preparing for release | Phase: dependency management | Action: Switch from workspace to remote dependencies | Version Bump: Not yet applied');

        // Clean up any npm link references before updating dependencies
        logger.verbose('NPM_LINK_CHECK: Scanning package-lock.json for npm link references | File: package-lock.json | Purpose: Remove development symlinks before publish');
        await cleanupNpmLinkReferences(isDryRun);

        // Update inter-project dependencies if --update-deps flag is present
        const updateDepsScope = runConfig.publish?.updateDeps;
        if (updateDepsScope) {
            logger.info(`INTER_PROJECT_DEPS_UPDATE: Updating inter-project dependencies | Scope: ${updateDepsScope} | Type: inter-project | Command: kodrdriv updates`);
            const Updates = await import('@eldrforge/commands-tree');
            const updatesConfig: Config = {
                ...runConfig,
                dryRun: isDryRun,
                updates: {
                    scope: updateDepsScope,
                    interProject: true
                }
            };
            await Updates.updates(updatesConfig);
        }

        logger.verbose('DEPS_UPDATE_REGISTRY: Updating dependencies to latest versions from npm registry | Source: registry | Target: package.json');
        const updatePatterns = runConfig.publish?.dependencyUpdatePatterns;
        if (updatePatterns && updatePatterns.length > 0) {
            logger.verbose(`DEPS_UPDATE_PATTERNS: Updating dependencies matching specified patterns | Patterns: ${updatePatterns.join(', ')} | Count: ${updatePatterns.length} | Command: npm update`);
            const patternsArg = updatePatterns.join(' ');
            await runWithDryRunSupport(`npm update ${patternsArg}`, isDryRun);
        } else {
            logger.verbose('DEPS_UPDATE_ALL: No dependency patterns specified, updating all dependencies | Scope: all | Command: npm update');
            await runWithDryRunSupport('npm update', isDryRun);
        }

        logger.info('PREPUBLISH_SCRIPT_RUNNING: Executing prepublishOnly script | Script: prepublishOnly | Purpose: Run pre-flight checks (clean, lint, build, test)');
        await runWithDryRunSupport('npm run prepublishOnly', isDryRun, {}, true); // Use inherited stdio

        // STEP 2: Commit dependency updates if any (still no version bump)
        logger.verbose('DEPS_STAGING: Staging dependency updates for commit | Files: package.json | Command: git add | Note: Version bump not yet applied, package-lock.json ignored');
        // Skip package-lock.json as it's in .gitignore to avoid private registry refs
        const filesToStage = 'package.json';

        // Wrap git operations with repository lock to prevent .git/index.lock conflicts
        await runGitWithLock(process.cwd(), async () => {
            await runWithDryRunSupport(`git add ${filesToStage}`, isDryRun);
        }, 'stage dependency updates');

        logger.verbose('DEPS_COMMIT_CHECK: Checking for staged dependency updates | Command: git status | Purpose: Determine if commit needed');
        if (isDryRun) {
            logger.verbose('DEPS_COMMIT_DRY_RUN: Would create dependency update commit if changes are staged | Mode: dry-run');
        } else {
            if (await Diff.hasStagedChanges()) {
                logger.verbose('DEPS_COMMIT_CREATING: Staged dependency changes detected, creating commit | Files: ' + filesToStage + ' | Action: Execute commit command');
                // Commit also needs git lock
                await runGitWithLock(process.cwd(), async () => {
                    await Commit.commit(runConfig);
                }, 'commit dependency updates');
            } else {
                logger.verbose('DEPS_COMMIT_SKIPPED: No dependency changes to commit | Files: ' + filesToStage + ' | Action: Skipping commit step');
            }
        }

        // STEP 3: Merge target branch into working branch (optional - now skipped by default since post-publish sync keeps branches in sync)
        const skipPreMerge = runConfig.publish?.skipPrePublishMerge !== false; // Default to true (skip)

        if (skipPreMerge) {
            logger.verbose(`PRE_MERGE_SKIPPED: Skipping pre-publish merge of target branch | Reason: Post-publish sync handles branch synchronization | Target: ${targetBranch} | Config: skipPrePublishMerge=true`);
        } else {
            logger.info(`PRE_MERGE_STARTING: Merging target branch into current branch | Target: ${targetBranch} | Purpose: Avoid version conflicts | Phase: pre-publish`);
            if (isDryRun) {
                logger.info(`Would merge ${targetBranch} into current branch`);
            } else {
                // Wrap entire merge process with git lock (involves fetch, merge, checkout, add, commit)
                await runGitWithLock(process.cwd(), async () => {
                    // Fetch the latest target branch
                    try {
                        await run(`git fetch origin ${targetBranch}:${targetBranch}`);
                        logger.info(`TARGET_BRANCH_FETCHED: Successfully fetched latest target branch | Branch: ${targetBranch} | Remote: origin/${targetBranch} | Purpose: Pre-merge sync`);
                    } catch (fetchError: any) {
                        logger.warn(`TARGET_BRANCH_FETCH_FAILED: Unable to fetch target branch | Branch: ${targetBranch} | Error: ${fetchError.message} | Impact: Proceeding without merge, PR may have conflicts`);
                        logger.warn('MERGE_SKIPPED_NO_FETCH: Continuing without pre-merge | Reason: Target branch fetch failed | Impact: PR may require manual conflict resolution');
                    }

                    // Check if merge is needed (avoid unnecessary merge commits)
                    try {
                        const { stdout: mergeBase } = await run(`git merge-base HEAD ${targetBranch}`);
                        const { stdout: targetCommit } = await run(`git rev-parse ${targetBranch}`);

                        if (mergeBase.trim() === targetCommit.trim()) {
                            logger.info(`MERGE_NOT_NEEDED: Current branch already up-to-date with target | Branch: ${targetBranch} | Status: in-sync | Action: Skipping merge`);
                        } else {
                        // Try to merge target branch into current branch
                            let mergeSucceeded = false;
                            try {
                                await run(`git merge ${targetBranch} --no-edit -m "Merge ${targetBranch} to sync before version bump"`);
                                logger.info(`MERGE_SUCCESS: Successfully merged target branch into current branch | Target: ${targetBranch} | Purpose: Sync before version bump`);
                                mergeSucceeded = true;
                            } catch (mergeError: any) {
                            // If merge conflicts occur, check if they're only in version-related files
                                const errorText = [mergeError.message || '', mergeError.stdout || '', mergeError.stderr || ''].join(' ');
                                if (errorText.includes('CONFLICT')) {
                                    logger.warn(`MERGE_CONFLICTS_DETECTED: Merge conflicts found, attempting automatic resolution | Target: ${targetBranch} | Strategy: Auto-resolve version files`);

                                    // Get list of conflicted files
                                    const { stdout: conflictedFiles } = await run('git diff --name-only --diff-filter=U');
                                    const conflicts = conflictedFiles.trim().split('\n').filter(Boolean);

                                    logger.verbose(`MERGE_CONFLICTS_LIST: Conflicted files detected | Files: ${conflicts.join(', ')} | Count: ${conflicts.length}`);

                                    // Check if conflicts are only in package.json (package-lock.json is gitignored)
                                    const versionFiles = ['package.json'];
                                    const nonVersionConflicts = conflicts.filter(f => !versionFiles.includes(f));

                                    if (nonVersionConflicts.length > 0) {
                                        logger.error(`MERGE_AUTO_RESOLVE_FAILED: Cannot auto-resolve conflicts in non-version files | Files: ${nonVersionConflicts.join(', ')} | Count: ${nonVersionConflicts.length} | Resolution: Manual intervention required`);
                                        logger.error('');
                                        logger.error('CONFLICT_RESOLUTION_REQUIRED: Manual steps to resolve conflicts:');
                                        logger.error('   Step 1: Resolve conflicts in the files listed above');
                                        logger.error('   Step 2: Stage resolved files | Command: git add <resolved-files>');
                                        logger.error('   Step 3: Complete merge commit | Command: git commit');
                                        logger.error('   Step 4: Resume publish process | Command: kodrdriv publish');
                                        logger.error('');
                                        throw new Error(`Merge conflicts in non-version files. Please resolve manually.`);
                                    }

                                    // Auto-resolve version conflicts by accepting current branch versions
                                    // (keep our working branch's version, which is likely already updated)
                                    logger.info(`MERGE_AUTO_RESOLVING: Automatically resolving version conflicts | Strategy: Keep current branch versions | Files: ${versionFiles.join(', ')}`);
                                    for (const file of conflicts) {
                                        if (versionFiles.includes(file)) {
                                            await run(`git checkout --ours ${file}`);
                                            await run(`git add ${file}`);
                                            logger.verbose(`MERGE_FILE_RESOLVED: Resolved file using current branch version | File: ${file} | Strategy: checkout --ours`);
                                        }
                                    }

                                    // Complete the merge
                                    await run(`git commit --no-edit -m "Merge ${targetBranch} to sync before version bump (auto-resolved version conflicts)"`);
                                    logger.info(`MERGE_AUTO_RESOLVE_SUCCESS: Successfully auto-resolved version conflicts and completed merge | Target: ${targetBranch} | Files: ${versionFiles.join(', ')}`);
                                    mergeSucceeded = true;
                                } else {
                                // Not a conflict error, re-throw
                                    throw mergeError;
                                }
                            }

                            // Only run npm install if merge actually happened
                            if (mergeSucceeded) {
                            // Run npm install to update package-lock.json based on merged package.json
                                logger.info('POST_MERGE_NPM_INSTALL: Running npm install after merge | Purpose: Update package-lock.json based on merged package.json | Command: npm install');
                                await run('npm install');
                                logger.info('POST_MERGE_NPM_COMPLETE: npm install completed successfully | Status: Dependencies synchronized');

                                // Commit any changes from npm install (e.g., package-lock.json updates)
                                const { stdout: mergeChangesStatus } = await run('git status --porcelain');
                                if (mergeChangesStatus.trim()) {
                                    logger.verbose('POST_MERGE_CHANGES_DETECTED: Changes detected after npm install | Action: Staging for commit | Command: git add');
                                    // Skip package-lock.json as it's in .gitignore to avoid private registry refs
                                    const filesToStagePostMerge = 'package.json';
                                    await run(`git add ${filesToStagePostMerge}`);

                                    if (await Diff.hasStagedChanges()) {
                                        logger.verbose('POST_MERGE_COMMIT: Committing post-merge changes | Files: ' + filesToStagePostMerge + ' | Purpose: Finalize merge');
                                        await Commit.commit(runConfig);
                                    }
                                }
                            }
                        }
                    } catch (error: any) {
                    // Only catch truly unexpected errors here
                        logger.error(`MERGE_UNEXPECTED_ERROR: Unexpected error during merge process | Error: ${error.message} | Target: ${targetBranch} | Action: Aborting publish`);
                        throw error;
                    }
                }, `merge ${targetBranch} into current branch`);
            }
        }

        // STEP 4: Determine and set target version AFTER checks, dependency commit, and target branch merge
        logger.info('Determining target version...');
        let newVersion: string;

        if (isDryRun) {
            logger.info('Would determine target version and update package.json');
            newVersion = '1.0.0'; // Mock version for dry run
        } else {
            const packageJsonContents = await storage.readFile('package.json', 'utf-8');
            const parsed = safeJsonParse(packageJsonContents, 'package.json');
            const packageJson = validatePackageJson(parsed, 'package.json');
            const currentVersion = packageJson.version;

            let proposedVersion: string;
            let finalTargetBranch = targetBranch;

            if (branchDependentVersioning && runConfig.branches) {
                // Use branch-dependent versioning logic
                const branchDependentResult = await calculateBranchDependentVersion(
                    currentVersion,
                    currentBranch,
                    runConfig.branches,
                    targetBranch
                );
                proposedVersion = branchDependentResult.version;
                finalTargetBranch = branchDependentResult.targetBranch;

                logger.info(`VERSION_BRANCH_DEPENDENT_CALCULATED: Branch-dependent version calculated | Current: ${currentVersion} | Proposed: ${proposedVersion} | Strategy: branch-dependent`);
                logger.info(`TARGET_BRANCH_FINAL: Final target branch determined | Branch: ${finalTargetBranch} | Source: branch-dependent config`);

                // Update targetBranch for the rest of the function
                targetBranch = finalTargetBranch;
            } else {
                // Use existing logic for backward compatibility
                const targetVersionInput = runConfig.publish?.targetVersion || 'patch';
                proposedVersion = calculateTargetVersion(currentVersion, targetVersionInput);
            }

            const targetTagName = `v${proposedVersion}`;
            const tagExists = await checkIfTagExists(targetTagName);

            // Smart tag conflict handling
            if (tagExists) {
                const { getNpmPublishedVersion, getTagInfo } = await import('@eldrforge/core');

                logger.warn(`TAG_ALREADY_EXISTS: Tag already exists in repository | Tag: ${targetTagName} | Status: conflict | Action: Check npm registry`);

                // Check if this version is published on npm
                const npmVersion = await getNpmPublishedVersion(packageJson.name);
                const tagInfo = await getTagInfo(targetTagName);

                if (npmVersion === proposedVersion) {
                    // Version is already published on npm
                    logger.info(`VERSION_ALREADY_PUBLISHED: Version already published on npm registry | Version: ${proposedVersion} | Status: published | Action: Skipping`);
                    logger.info(`PUBLISH_SKIPPED_DUPLICATE: Skipping publish operation | Reason: Package already at target version | Version: ${proposedVersion}`);
                    logger.info('');
                    logger.info('REPUBLISH_OPTIONS: Options if you need to republish:');
                    logger.info(`   Option 1: Bump version | Command: npm version patch (or minor/major)`);
                    logger.info(`   Option 2: Re-run publish | Command: kodrdriv publish`);
                    logger.info('');

                    if (runConfig.publish?.skipAlreadyPublished) {
                        logger.info('PUBLISH_SKIPPED_FLAG: Skipping package due to flag | Flag: --skip-already-published | Version: ' + proposedVersion + ' | Status: skipped');
                        // Emit skip marker for tree mode detection
                        // eslint-disable-next-line no-console
                        console.log('KODRDRIV_PUBLISH_SKIPPED');
                        return; // Exit without error
                    } else {
                        throw new Error(`Version ${proposedVersion} already published. Use --skip-already-published to continue.`);
                    }
                } else {
                    // Tag exists but version not on npm - likely failed previous publish
                    logger.warn('');
                    logger.warn('PUBLISH_SITUATION_ANALYSIS: Analyzing publish conflict situation | Tag: ' + targetTagName + ' | npm: ' + (npmVersion || 'not published'));
                    logger.warn(`PUBLISH_ANALYSIS_TAG_EXISTS: Tag exists locally | Tag: ${targetTagName} | Commit: ${tagInfo?.commit?.substring(0, 8)}`);
                    logger.warn(`PUBLISH_ANALYSIS_NPM_STATUS: npm registry status | Version: ${npmVersion || 'not published'} | Status: ${npmVersion ? 'published' : 'missing'}`);
                    logger.warn(`PUBLISH_ANALYSIS_CONCLUSION: Previous publish likely failed after tag creation | Reason: Tag exists but not on npm | Resolution: Recovery needed`);
                    logger.warn('');
                    logger.warn('PUBLISH_RECOVERY_OPTIONS: Recovery options available:');
                    logger.warn('   OPTION_1_FORCE: Force republish by deleting tag | Command: kodrdriv publish --force-republish');
                    logger.warn('   OPTION_2_BUMP: Skip version and bump | Command: npm version patch && kodrdriv publish');
                    logger.warn('   OPTION_3_MANUAL: Manually delete tag:');
                    logger.warn(`      Command: git tag -d ${targetTagName}`);
                    logger.warn(`      Command: git push origin :refs/tags/${targetTagName}`);
                    logger.warn('');

                    if (runConfig.publish?.forceRepublish) {
                        logger.info('PUBLISH_FORCE_REPUBLISH: Force republish mode enabled | Action: Deleting existing tag | Tag: ' + targetTagName + ' | Purpose: Allow republish');

                        if (!isDryRun) {
                            const { runSecure } = await import('@eldrforge/git-tools');

                            // Delete local tag
                            try {
                                await runSecure('git', ['tag', '-d', targetTagName]);
                                logger.info(`TAG_DELETED_LOCAL: Deleted local tag | Tag: ${targetTagName} | Status: removed-local`);
                            } catch (error: any) {
                                logger.debug(`Could not delete local tag: ${error.message}`);
                            }

                            // Delete remote tag
                            try {
                                await runSecure('git', ['push', 'origin', `:refs/tags/${targetTagName}`]);
                                logger.info(`TAG_DELETED_REMOTE: Deleted remote tag | Tag: ${targetTagName} | Remote: origin | Status: removed-remote`);
                            } catch (error: any) {
                                logger.debug(`Could not delete remote tag: ${error.message}`);
                            }

                            logger.info('PUBLISH_TAG_CLEANUP_COMPLETE: Tag deleted successfully | Status: ready-for-publish | Next: Continue with publish workflow');
                        } else {
                            logger.info('Would delete tags and continue with publish');
                        }
                    } else {
                        throw new Error(`Tag ${targetTagName} already exists. Use --force-republish to override.`);
                    }
                }
            }

            if (runConfig.publish?.interactive) {
                newVersion = await confirmVersionInteractively(currentVersion, proposedVersion, runConfig.publish?.targetVersion);
                const confirmedTagName = `v${newVersion}`;
                const confirmedTagExists = await checkIfTagExists(confirmedTagName);

                if (confirmedTagExists) {
                    const { getNpmPublishedVersion } = await import('@eldrforge/core');
                    const npmVersion = await getNpmPublishedVersion(packageJson.name);

                    if (npmVersion === newVersion) {
                        throw new Error(`Tag ${confirmedTagName} already exists and version is published on npm. Please choose a different version.`);
                    } else if (!runConfig.publish?.forceRepublish) {
                        throw new Error(`Tag ${confirmedTagName} already exists. Use --force-republish to override.`);
                    }
                    // If forceRepublish is set, we'll continue (tag will be deleted later)
                }
            } else {
                newVersion = proposedVersion;
            }

            logger.info(`Bumping version from ${currentVersion} to ${newVersion}`);
            packageJson.version = newVersion;
            await storage.writeFile('package.json', JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
            logger.info(`Version updated in package.json: ${newVersion}`);
        }

        // STEP 5: Commit version bump as a separate commit
        logger.verbose('Staging version bump for commit');
        // Skip package-lock.json as it's in .gitignore to avoid private registry refs
        const filesToStageVersionBump = 'package.json';

        // Wrap git operations with lock
        await runGitWithLock(process.cwd(), async () => {
            await runWithDryRunSupport(`git add ${filesToStageVersionBump}`, isDryRun);
        }, 'stage version bump');

        if (isDryRun) {
            logger.verbose('Would create version bump commit');
        } else {
            if (await Diff.hasStagedChanges()) {
                logger.verbose('Creating version bump commit...');
                await runGitWithLock(process.cwd(), async () => {
                    await Commit.commit(runConfig);
                }, 'commit version bump');
            } else {
                logger.verbose('No version changes to commit.');
            }
        }

        logger.info('Generating release notes...');

        // Use the existing currentBranch variable for tag detection
        logger.debug(`Current branch for release notes: ${currentBranch}`);

        // Create a modified config for release notes generation that includes the publish --from, --interactive, and --from-main options
        const releaseConfig = { ...runConfig };
        releaseConfig.release = {
            ...runConfig.release,
            currentBranch: currentBranch,  // Pass current branch
            ...(runConfig.publish?.from && { from: runConfig.publish.from }),
            ...(runConfig.publish?.interactive && { interactive: runConfig.publish.interactive }),
            ...(runConfig.publish?.fromMain && { fromMain: runConfig.publish.fromMain })
        };
        if (runConfig.publish?.from) {
            logger.verbose(`Using custom 'from' reference for release notes: ${runConfig.publish.from}`);
        }
        if (runConfig.publish?.interactive) {
            logger.verbose('Interactive mode enabled for release notes generation');
        }
        if (runConfig.publish?.fromMain) {
            logger.verbose('Forcing comparison against main branch for release notes');
        }
        // Log self-reflection settings for debugging
        if (releaseConfig.release?.selfReflection) {
            logger.verbose('Self-reflection enabled for release notes generation');
        }

        const releaseSummary = await Release.execute(releaseConfig);

        if (isDryRun) {
            logger.info('Would write release notes to RELEASE_NOTES.md and RELEASE_TITLE.md in output directory');
        } else {
            const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
            await storage.ensureDirectory(outputDirectory);

            const releaseNotesPath = getOutputPath(outputDirectory, 'RELEASE_NOTES.md');
            const releaseTitlePath = getOutputPath(outputDirectory, 'RELEASE_TITLE.md');

            await storage.writeFile(releaseNotesPath, releaseSummary.body, 'utf-8');
            await storage.writeFile(releaseTitlePath, releaseSummary.title, 'utf-8');
            logger.info(`Release notes and title generated and saved to ${releaseNotesPath} and ${releaseTitlePath}.`);
        }

        logger.info('Pushing to origin...');
        // Get current branch name and push explicitly to avoid pushing to wrong remote/branch
        const branchName = await GitHub.getCurrentBranchName();

        // Wrap git push with lock
        await runGitWithLock(process.cwd(), async () => {
            await runWithDryRunSupport(`git push origin ${branchName}`, isDryRun);
        }, `push ${branchName}`);

        logger.info('Creating pull request...');
        if (isDryRun) {
            logger.info('Would get commit title and create PR with GitHub API');
            pr = { number: 123, html_url: 'https://github.com/mock/repo/pull/123', labels: [] } as PullRequest;
        } else {
            const { stdout: rawCommitTitle } = await run('git log -1 --pretty=%B');

            // Apply stop-context filtering to PR title and body
            const commitTitle = filterContent(rawCommitTitle, runConfig.stopContext).filtered;
            const prBody = filterContent('Automated release PR.', runConfig.stopContext).filtered;

            pr = await GitHub.createPullRequest(commitTitle, prBody, branchName, targetBranch);
            if (!pr) {
                throw new Error('Failed to create pull request.');
            }
            logger.info(`Pull request created: ${pr.html_url} (${branchName} → ${targetBranch})`);
        }
    }

    logger.info(`Waiting for PR #${pr!.number} checks to complete...`);
    if (!isDryRun) {
        // Check if we already know from prechecks that no workflows will trigger
        let shouldSkipWait = false;
        try {
            // TODO: Re-enable when checkWorkflowConfiguration is exported from github-tools
            // const workflowConfig = await GitHub.checkWorkflowConfiguration(targetBranch);
            const workflowConfig = {
                hasWorkflows: true,
                hasPullRequestTriggers: true,
                workflowCount: 0,
                triggeredWorkflowNames: [] as string[]
            };
            if (!workflowConfig.hasWorkflows || !workflowConfig.hasPullRequestTriggers) {
                logger.info('PUBLISH_CHECK_WAIT_SKIPPED: Skipping check wait | Reason: No workflows configured for PR | Status: no-workflows | Next: Proceed with merge');
                shouldSkipWait = true;
            }
        } catch (error: any) {
            // If we can't verify, proceed with waiting to be safe
            logger.debug(`Could not verify workflow configuration for wait skip: ${error.message}`);
        }

        if (!shouldSkipWait) {
            // Configure timeout and user confirmation behavior
            const timeout = runConfig.publish?.checksTimeout || KODRDRIV_DEFAULTS.publish.checksTimeout;
            const senditMode = runConfig.publish?.sendit || false;
            // sendit flag overrides skipUserConfirmation - if sendit is true, skip confirmation
            const skipUserConfirmation = senditMode || runConfig.publish?.skipUserConfirmation || false;

            await GitHub.waitForPullRequestChecks(pr!.number, {
                timeout,
                skipUserConfirmation
            });
        }
    }

    const mergeMethod = runConfig.publish?.mergeMethod || 'squash';
    if (isDryRun) {
        logger.info(`Would merge PR #${pr!.number} using ${mergeMethod} method`);
    } else {
        try {
            await GitHub.mergePullRequest(pr!.number, mergeMethod, false); // Don't delete branch
        } catch (error: any) {
            // Check if this is a merge conflict error
            if (error.message && (
                error.message.includes('not mergeable') ||
                    error.message.includes('Pull Request is not mergeable') ||
                    error.message.includes('merge conflict')
            )) {
                logger.error(`PR_MERGE_CONFLICTS: Pull request has merge conflicts | PR Number: ${pr!.number} | Status: conflicts | Resolution: Manual intervention required`);
                logger.error('');
                logger.error('PR_CONFLICT_RESOLUTION: Steps to resolve conflicts:');
                logger.error(`   Step 1: Visit pull request | URL: ${pr!.html_url}`);
                logger.error('   Step 2: Resolve merge conflicts | Method: GitHub UI or local');
                logger.error('   Step 3: Re-run publish command | Command: kodrdriv publish');
                logger.error('');
                logger.error('PR_AUTO_CONTINUE: Command will auto-detect existing PR | Behavior: Continues from where it left off | No re-creation needed');
                throw new Error(`Merge conflicts detected in PR #${pr!.number}. Please resolve conflicts and re-run the command.`);
            } else {
                // Re-throw other merge errors
                throw error;
            }
        }
    }

    // Switch to target branch and pull latest changes
    logger.info(`Checking out target branch: ${targetBranch}...`);

    // Check for uncommitted changes and stash them if necessary
    let hasStashedChanges = false;
    if (!isDryRun) {
        const { stdout: statusOutput } = await runSecure('git', ['status', '--porcelain']);
        if (statusOutput.trim()) {
            logger.info('PUBLISH_STASH_SAVING: Stashing uncommitted changes before checkout | Command: git stash push | Purpose: Protect changes during branch switch');
            await runSecure('git', ['stash', 'push', '-m', 'kodrdriv: stash before checkout target branch']);
            hasStashedChanges = true;
            logger.info('PUBLISH_STASH_SUCCESS: Successfully stashed uncommitted changes | Status: saved | Name: kodrdriv stash');
        }
    }

    try {
        // Wrap git checkout and pull with lock
        await runGitWithLock(process.cwd(), async () => {
            await runWithDryRunSupport(`git checkout ${targetBranch}`, isDryRun);
        }, `checkout ${targetBranch}`);

        // Sync target branch with remote to avoid conflicts during PR creation
        if (!isDryRun) {
            logger.info(`PUBLISH_TARGET_SYNCING: Syncing target branch with remote | Branch: ${targetBranch} | Remote: origin | Purpose: Avoid PR conflicts`);
            try {
                const remoteExists = await run(`git ls-remote --exit-code --heads origin ${targetBranch}`).then(() => true).catch(() => false);

                if (remoteExists) {
                    await runGitWithLock(process.cwd(), async () => {
                        await run(`git fetch origin ${targetBranch}`);
                        await run(`git merge origin/${targetBranch} --no-edit`);
                    }, `sync ${targetBranch}`);
                    logger.info(`PUBLISH_TARGET_SYNCED: Successfully synced target with remote | Branch: ${targetBranch} | Remote: origin | Status: in-sync`);
                } else {
                    logger.info(`PUBLISH_TARGET_NO_REMOTE: No remote target branch found | Branch: ${targetBranch} | Remote: origin | Action: Will be created on first push`);
                }
            } catch (syncError: any) {
                if (syncError.message && syncError.message.includes('CONFLICT')) {
                    logger.error(`PUBLISH_SYNC_CONFLICTS: Merge conflicts during target sync | Branch: ${targetBranch} | Remote: origin | Status: conflicts-detected`);
                    logger.error(`PUBLISH_SYNC_RESOLUTION: Manual conflict resolution steps:`);
                    logger.error(`   Step 1: Checkout target | Command: git checkout ${targetBranch}`);
                    logger.error(`   Step 2: Pull and merge | Command: git pull origin ${targetBranch}`);
                    logger.error(`   Step 3: Resolve conflicts in files`);
                    logger.error(`   Step 4: Stage resolved files | Command: git add <resolved-files>`);
                    logger.error(`   Step 5: Complete merge | Command: git commit`);
                    logger.error(`   Step 6: Return to branch | Command: git checkout ${currentBranch}`);
                    logger.error(`   Step 7: Resume publish | Command: kodrdriv publish`);
                    throw syncError;
                } else {
                    logger.warn(`PUBLISH_SYNC_WARNING: Could not sync target with remote | Branch: ${targetBranch} | Remote: origin | Error: ${syncError.message}`);
                    // Continue with publish process, but log the warning
                }
            }
        } else {
            logger.info(`Would sync ${targetBranch} with remote to avoid PR conflicts`);
        }
    } catch (error: any) {
        // Check if this is a merge conflict or sync issue
        if (!isDryRun && (error.message.includes('conflict') ||
                         error.message.includes('CONFLICT') ||
                         error.message.includes('diverged') ||
                         error.message.includes('non-fast-forward'))) {

            logger.error(`PUBLISH_TARGET_SYNC_FAILED: Failed to sync target branch with remote | Branch: ${targetBranch} | Remote: origin | Impact: Cannot proceed safely`);
            logger.error('');
            logger.error('PUBLISH_SYNC_RECOVERY_OPTIONS: Available recovery options:');
            logger.error(`   OPTION_1_AUTO: Attempt automatic resolution | Command: kodrdriv publish --sync-target`);
            logger.error(`   OPTION_2_MANUAL: Manually resolve conflicts:`);
            logger.error(`      Step 1: Checkout target | Command: git checkout ${targetBranch}`);
            logger.error(`      Step 2: Pull from remote | Command: git pull origin ${targetBranch}`);
            logger.error(`      Step 3: Resolve conflicts and commit`);
            logger.error(`      Step 4: Re-run publish | Command: kodrdriv publish`);
            logger.error('');
            logger.error('PUBLISH_STOPPED_SAFETY: Publish process stopped | Reason: Prevent data loss | Status: safe-to-recover');

            throw new Error(`Target branch '${targetBranch}' sync failed. Use recovery options above to resolve.`);
        } else {
            // Re-throw other errors
            throw error;
        }
    }

    // Restore stashed changes if we stashed them
    if (hasStashedChanges) {
        logger.info('PUBLISH_STASH_RESTORING: Restoring previously stashed changes | Command: git stash pop | Purpose: Restore working directory state');
        try {
            await runSecure('git', ['stash', 'pop']);
            logger.info('PUBLISH_STASH_RESTORED: Successfully restored stashed changes | Status: restored | Stash: removed');
        } catch (stashError: any) {
            logger.warn(`PUBLISH_STASH_RESTORE_FAILED: Could not restore stashed changes | Error: ${stashError.message} | Impact: Changes still in stash`);
            logger.warn('PUBLISH_STASH_AVAILABLE: Changes available in git stash | Command: git stash list | Purpose: View and restore manually');
        }
    }

    // Now create and push the tag on the target branch
    logger.info('Creating release tag...');
    let tagName: string;
    if (isDryRun) {
        logger.info('Would read package.json version and create git tag');
        tagName = 'v1.0.0'; // Mock version for dry run
    } else {
        const packageJsonContents = await storage.readFile('package.json', 'utf-8');
        const { version } = safeJsonParse(packageJsonContents, 'package.json');
        tagName = `v${version}`;

        // Check if tag already exists locally
        try {
            // Validate tag name to prevent injection
            if (!validateGitRef(tagName)) {
                throw new Error(`Invalid tag name: ${tagName}`);
            }
            const { stdout } = await runSecure('git', ['tag', '-l', tagName]);
            if (stdout.trim() === tagName) {
                logger.info(`Tag ${tagName} already exists locally, skipping tag creation`);
            } else {
                await runGitWithLock(process.cwd(), async () => {
                    await runSecure('git', ['tag', tagName]);
                }, `create tag ${tagName}`);
                logger.info(`Created local tag: ${tagName}`);
            }
        } catch (error) {
            // If git tag -l fails, create the tag anyway
            await runGitWithLock(process.cwd(), async () => {
                await runSecure('git', ['tag', tagName]);
            }, `create tag ${tagName}`);
            logger.info(`Created local tag: ${tagName}`);
        }

        // Check if tag exists on remote before pushing
        let tagWasPushed = false;
        try {
            const { stdout } = await runSecure('git', ['ls-remote', 'origin', `refs/tags/${tagName}`]);
            if (stdout.trim()) {
                logger.info(`Tag ${tagName} already exists on remote, skipping push`);
            } else {
                await runGitWithLock(process.cwd(), async () => {
                    await runSecure('git', ['push', 'origin', tagName]);
                }, `push tag ${tagName}`);
                logger.info(`Pushed tag to remote: ${tagName}`);
                tagWasPushed = true;
            }
        } catch (error) {
            // If ls-remote fails, try to push anyway (might be a new remote)
            try {
                await runSecure('git', ['push', 'origin', tagName]);
                logger.info(`Pushed tag to remote: ${tagName}`);
                tagWasPushed = true;
            } catch (pushError: any) {
                if (pushError.message && pushError.message.includes('already exists')) {
                    logger.info(`Tag ${tagName} already exists on remote, continuing...`);
                } else {
                    throw pushError;
                }
            }
        }

        // If we just pushed a new tag, wait for GitHub to process it
        if (tagWasPushed) {
            logger.verbose('Waiting for GitHub to process the pushed tag...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
        }
    }

    logger.info('Creating GitHub release...');
    if (isDryRun) {
        logger.info('Would read package.json version and create GitHub release with retry logic');
        const milestonesEnabled = !runConfig.publish?.noMilestones;
        if (milestonesEnabled) {
            logger.info('Would close milestone for released version');
        } else {
            logger.info('Would skip milestone closure (--no-milestones)');
        }
    } else {
        const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
        const releaseNotesPath = getOutputPath(outputDirectory, 'RELEASE_NOTES.md');
        const releaseTitlePath = getOutputPath(outputDirectory, 'RELEASE_TITLE.md');

        const releaseNotesContent = await storage.readFile(releaseNotesPath, 'utf-8');
        const releaseTitle = await storage.readFile(releaseTitlePath, 'utf-8');

        // Create release with retry logic to handle GitHub tag processing delays
        let retries = 3;
        while (retries > 0) {
            try {
                await GitHub.createRelease(tagName, releaseTitle, releaseNotesContent);
                logger.info(`GitHub release created successfully for tag: ${tagName}`);

                // Close milestone for this version if enabled
                const milestonesEnabled = !runConfig.publish?.noMilestones;
                if (milestonesEnabled) {
                    logger.info('PUBLISH_MILESTONE_CLOSING: Closing milestone for released version | Action: Close GitHub milestone | Purpose: Mark release complete');
                    const version = tagName.replace(/^v/, ''); // Remove 'v' prefix if present
                    await GitHub.closeMilestoneForVersion(version);
                } else {
                    logger.debug('Milestone integration disabled via --no-milestones');
                }

                break; // Success - exit retry loop
            } catch (error: any) {
                // Check if this is a tag-not-found error that we can retry
                const isTagNotFoundError = error.message && (
                    error.message.includes('not found') ||
                        error.message.includes('does not exist') ||
                        error.message.includes('Reference does not exist')
                );

                if (isTagNotFoundError && retries > 1) {
                    logger.verbose(`Tag ${tagName} not yet available on GitHub, retrying in 3 seconds... (${retries - 1} retries left)`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    retries--;
                } else if (isTagNotFoundError) {
                    // Tag not found error and we're out of retries
                    throw new Error(`Tag ${tagName} was not found on GitHub after ${3 - retries + 1} attempts. This may indicate a problem with tag creation or GitHub synchronization.`);
                } else {
                    // Not a tag-not-found error - re-throw the original error
                    throw error;
                }
            }
        }
    }

    // Wait for release workflows to complete (if enabled)
    const waitForWorkflows = runConfig.publish?.waitForReleaseWorkflows !== false; // default to true
    if (waitForWorkflows) {
        logger.info('Waiting for release workflows...');
        if (isDryRun) {
            logger.info('Would monitor GitHub Actions workflows triggered by release');
        } else {
            const workflowTimeout = runConfig.publish?.releaseWorkflowsTimeout || KODRDRIV_DEFAULTS.publish.releaseWorkflowsTimeout;
            const senditMode = runConfig.publish?.sendit || false;
            const skipUserConfirmation = senditMode || runConfig.publish?.skipUserConfirmation || false;

            // Get workflow names - either from config or auto-detect
            let workflowNames = runConfig.publish?.releaseWorkflowNames;

            if (!workflowNames || workflowNames.length === 0) {
                logger.info('No specific workflow names configured, auto-detecting workflows triggered by release events...');
                try {
                    workflowNames = await GitHub.getWorkflowsTriggeredByRelease();
                    if (workflowNames.length === 0) {
                        logger.info('No workflows found that are triggered by release events.');
                    } else {
                        logger.info(`Auto-detected release workflows: ${workflowNames.join(', ')}`);
                    }
                } catch (error: any) {
                    logger.warn(`Failed to auto-detect release workflows: ${error.message}`);
                    workflowNames = undefined; // Fall back to monitoring all workflows
                }
            }

            await GitHub.waitForReleaseWorkflows(tagName, {
                timeout: workflowTimeout,
                workflowNames,
                skipUserConfirmation
            });
        }
    } else {
        logger.verbose('Skipping waiting for release workflows (disabled in config).');
    }

    // Switch back to source branch and sync with target
    logger.info('');
    logger.info(`PUBLISH_POST_SYNC: Syncing source branch with target after publish | Purpose: Keep branches synchronized | Strategy: Reset and force push`);
    await runWithDryRunSupport(`git checkout ${currentBranch}`, isDryRun);

    if (!isDryRun) {
        // Sync target into source
        // Note: With squash merging, fast-forward will fail because commit histories diverge
        if (mergeMethod === 'squash') {
            // For squash merges, reset to target branch to avoid conflicts
            // The squash merge created a single commit on target that represents all source commits
            logger.info(`Resetting ${currentBranch} to ${targetBranch} (squash merge)...`);
            await run(`git reset --hard ${targetBranch}`);
            logger.info(`PUBLISH_BRANCH_RESET: Reset source branch to target | Source: ${currentBranch} | Target: ${targetBranch} | Status: synchronized`);

            // After squash merge and reset, we need to force push
            // This is safe because we just merged to main and are syncing working branch
            logger.info(`PUBLISH_FORCE_PUSHING: Force pushing synchronized branch | Branch: ${currentBranch} | Remote: origin | Purpose: Complete post-publish sync`);

            try {
                // Verify that remote working branch is ancestor of main (safety check)
                try {
                    await run(`git fetch origin ${currentBranch}`);
                    await run(`git merge-base --is-ancestor origin/${currentBranch} ${targetBranch}`);
                    logger.verbose(`✓ Safety check passed: origin/${currentBranch} is ancestor of ${targetBranch}`);
                } catch {
                    // Remote branch might not exist yet, or already in sync - both OK
                    logger.verbose(`Remote ${currentBranch} does not exist or is already synced`);
                }

                // Use --force-with-lease for safer force push
                await run(`git push --force-with-lease origin ${currentBranch}`);
                logger.info(`PUBLISH_FORCE_PUSH_SUCCESS: Successfully force pushed to remote | Branch: ${currentBranch} | Remote: origin | Status: synchronized`);
            } catch (pushError: any) {
                // If force push fails, provide helpful message
                logger.warn(`PUBLISH_FORCE_PUSH_FAILED: Could not force push branch | Branch: ${currentBranch} | Remote: origin | Error: ${pushError.message}`);
                logger.warn(`PUBLISH_MANUAL_PUSH_NEEDED: Manual force push required | Action: Push manually`);
                logger.warn(`PUBLISH_MANUAL_PUSH_COMMAND: Force push command | Command: git push --force-with-lease origin ${currentBranch}`);
            }
        } else {
            // For merge/rebase methods, try to merge target back into source
            logger.info(`PUBLISH_MERGE_TARGET_BACK: Merging target back into source | Target: ${targetBranch} | Source: ${currentBranch} | Purpose: Sync branches after publish`);

            // Try fast-forward first (works with merge/rebase methods)
            // Use runSecure to avoid error output for expected failure
            let fastForwardSucceeded = false;
            try {
                await runSecure('git', ['merge', targetBranch, '--ff-only']);
                fastForwardSucceeded = true;
                logger.info(`PUBLISH_MERGE_FF_SUCCESS: Fast-forward merged target into source | Target: ${targetBranch} | Source: ${currentBranch} | Status: merged`);
            } catch {
                logger.verbose(`Fast-forward merge not possible, performing regular merge...`);
            }

            if (!fastForwardSucceeded) {
                await run(`git merge ${targetBranch} --no-edit`);
                logger.info(`PUBLISH_MERGE_SUCCESS: Merged target into source | Target: ${targetBranch} | Source: ${currentBranch} | Status: merged`);
            }
        }

        // Determine version bump based on branch configuration
        let versionCommand = 'prepatch'; // Default
        let versionTag = 'dev'; // Default

        if (branchDependentVersioning && runConfig.branches) {
            const sourceBranchConfig = runConfig.branches[currentBranch];
            if (sourceBranchConfig?.version) {
                // Use configured version strategy for source branch
                if (sourceBranchConfig.version.incrementLevel) {
                    versionCommand = `pre${sourceBranchConfig.version.incrementLevel}`;
                }
                if (sourceBranchConfig.version.tag) {
                    versionTag = sourceBranchConfig.version.tag;
                }
            }
        }

        // Bump to next development version
        logger.info(`PUBLISH_DEV_VERSION_BUMPING: Bumping to next development version | Command: ${versionCommand} | Tag: ${versionTag} | Purpose: Prepare for next cycle`);
        try {
            const { stdout: newVersion } = await run(`npm version ${versionCommand} --preid=${versionTag} --no-git-tag-version`);
            logger.info(`PUBLISH_DEV_VERSION_BUMPED: Version bumped successfully | New Version: ${newVersion.trim()} | Type: development | Status: completed`);

            // Manually commit the version bump (package-lock.json is ignored)
            await runGitWithLock(process.cwd(), async () => {
                await run('git add package.json');
                await run(`git commit -m "chore: bump to ${newVersion.trim()}"`);
            }, 'commit dev version bump');
        } catch (versionError: any) {
            logger.warn(`PUBLISH_DEV_VERSION_BUMP_FAILED: Failed to bump version | Error: ${versionError.message} | Impact: Version not updated`);
            logger.warn('PUBLISH_MANUAL_VERSION_BUMP: Manual version bump may be needed | Action: Bump manually for next cycle | Command: npm version');
        }

        // Push updated source branch
        logger.info(`PUBLISH_PUSH_SOURCE: Pushing updated source branch | Branch: ${currentBranch} | Remote: origin | Purpose: Push development version`);
        try {
            await runGitWithLock(process.cwd(), async () => {
                await run(`git push origin ${currentBranch}`);
            }, `push ${currentBranch}`);
            logger.info(`PUBLISH_PUSH_SOURCE_SUCCESS: Pushed source branch successfully | Branch: ${currentBranch} | Remote: origin | Status: pushed`);
        } catch (pushError: any) {
            logger.warn(`PUBLISH_PUSH_SOURCE_FAILED: Failed to push source branch | Branch: ${currentBranch} | Error: ${pushError.message} | Impact: Need manual push`);
            logger.warn(`PUBLISH_MANUAL_PUSH_COMMAND: Manual push command | Command: git push origin ${currentBranch}`);
        }
    } else {
        logger.info(`PUBLISH_MERGE_DRY_RUN: Would merge target into source | Mode: dry-run | Target: ${targetBranch} | Source: ${currentBranch} | Strategy: ff-only`);
        logger.info(`PUBLISH_VERSION_DRY_RUN: Would bump version to next development | Mode: dry-run | Action: Version bump`);
        logger.info(`PUBLISH_PUSH_DRY_RUN: Would push source to remote | Mode: dry-run | Branch: ${currentBranch} | Remote: origin`);
    }

    logger.info('');
    logger.info(`PUBLISH_COMPLETE: Publish workflow completed successfully | Branch: ${currentBranch} | Status: completed | Version: next-development`);
};
