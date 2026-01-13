#!/usr/bin/env node
/**
 * Development command - Manages transition to working branch for active development
 *
 * This command handles the workflow of moving to the working branch from any other branch:
 *
 * New behavior:
 * 1. Fetch latest remote information
 * 2. Switch to the "working" branch (create if needed) and sync with remote
 * 3. Merge latest changes from "development" branch if it exists
 * 4. Run npm install and commit any changes (e.g., package-lock.json)
 * 5. Run `npm version pre<incrementLevel> --preid=<tag>` to bump version
 *
 * This is designed for reverse flow - taking you back to working for active development.
 */

import { getDryRunLogger, Config, findDevelopmentBranch, KODRDRIV_DEFAULTS, incrementPatchVersion, incrementMinorVersion, incrementMajorVersion } from '@eldrforge/core';
import { run, localBranchExists, getCurrentBranch, safeJsonParse, validatePackageJson } from '@eldrforge/git-tools';
import { createStorage } from '@eldrforge/shared';

/**
 * Create retroactive working branch tags for past releases
 * Scans git history for X.X.X-dev.0 commits and tags them
 */
async function createRetroactiveTags(
    workingBranch: string,
    isDryRun: boolean,
    logger: any,
    tagPrefix: string = 'working/'
): Promise<void> {
    logger.info('');
    logger.info('DEV_TAG_SCAN_STARTING: Scanning git history for past release points | Purpose: Create retroactive tags | Pattern: X.X.X-dev.0 version bumps');
    logger.info('DEV_TAG_SCAN_PATTERN: Looking for development version bump commits | Version Format: X.X.X-dev.0 | Purpose: Identify release points');
    logger.info('');

    try {
        // Get all commits on working branch with oneline format
        const { stdout } = await run(`git log ${workingBranch} --oneline --all`);
        const commits = stdout.trim().split('\n');

        // Find commits that are version bumps to -dev.0 (these mark release points)
        const devCommits = commits.filter(line => {
            // Match patterns like: "4.4.52-dev.0" or "chore: bump version to 4.4.52-dev.0"
            return /\b\d+\.\d+\.\d+-dev\.0\b/.test(line);
        });

        logger.info(`DEV_TAG_COMMITS_FOUND: Found potential development version commits | Count: ${devCommits.length} | Status: Analyzing for tag creation`);

        const tagsCreated: string[] = [];
        const tagsSkipped: string[] = [];

        for (const commitLine of devCommits) {
            const [sha, ...messageParts] = commitLine.split(' ');
            const message = messageParts.join(' ');

            // Extract version from message (e.g., "4.4.52-dev.0" → "4.4.52")
            const versionMatch = message.match(/(\d+\.\d+\.\d+)-dev\.0/);
            if (!versionMatch) continue;

            const releaseVersion = versionMatch[1]; // e.g., "4.4.52"
            const workingTagName = `${tagPrefix}v${releaseVersion}`;

            // Check if tag already exists
            const tagExistsResult = await run(`git tag -l "${workingTagName}"`);
            const tagExists = tagExistsResult.stdout.trim() !== '';

            if (tagExists) {
                tagsSkipped.push(workingTagName);
                logger.verbose(`   Skip: ${workingTagName} (already exists)`);
                continue;
            }

            if (!isDryRun) {
                // Tag the commit that represents the dev version bump
                // This is the commit AFTER the release, which marks the starting point
                logger.verbose(`   Create: ${workingTagName} at ${sha.substring(0, 7)}`);
                await run(`git tag ${workingTagName} ${sha}`);
                tagsCreated.push(workingTagName);
            } else {
                logger.info(`DEV_TAG_DRY_RUN: Would create retroactive tag | Mode: dry-run | Tag: ${workingTagName} | Commit: ${sha.substring(0, 7)}`);
                tagsCreated.push(workingTagName);
            }
        }

        logger.info('');

        if (tagsCreated.length > 0 && !isDryRun) {
            logger.info(`DEV_TAG_PUSHING: Pushing retroactive tags to remote | Count: ${tagsCreated.length} | Remote: origin | Command: git push origin --tags`);
            await run('git push origin --tags');
            logger.info('');
            logger.info(`DEV_TAG_PUSH_SUCCESS: Successfully created and pushed retroactive tags | Count: ${tagsCreated.length} | Remote: origin | Status: completed`);
            tagsCreated.forEach(tag => logger.info(`DEV_TAG_CREATED: Retroactive tag created | Tag: ${tag} | Status: pushed`));
        } else if (tagsCreated.length > 0 && isDryRun) {
            logger.info(`DEV_TAG_DRY_RUN_SUMMARY: Would create and push retroactive tags | Mode: dry-run | Count: ${tagsCreated.length}`);
            tagsCreated.forEach(tag => logger.info(`DEV_TAG_DRY_RUN_TAG: Would create tag | Tag: ${tag} | Mode: dry-run`));
        }

        if (tagsSkipped.length > 0) {
            logger.verbose('');
            logger.verbose(`Skipped ${tagsSkipped.length} existing tags:`);
            tagsSkipped.forEach(tag => logger.verbose(`   - ${tag}`));
        }

        if (tagsCreated.length === 0 && tagsSkipped.length === 0) {
            logger.info('DEV_TAG_NO_COMMITS: No development version commits found in history | Pattern: X.X.X-dev.0 | Status: Nothing to tag | Action: No retroactive tags created');
        }

        logger.info('');

    } catch (error: any) {
        logger.warn(`DEV_TAG_CREATION_FAILED: Unable to create retroactive tags | Error: ${error.message} | Impact: Past releases not tagged | Alternative: Manual tagging available`);
        logger.warn('DEV_TAG_MANUAL_OPTION: Manual tagging option available | Action: Use git tag manually for past releases | Purpose: Tag historical releases');
        // Don't throw - retroactive tagging is optional
    }
}

/**
 * Execute the development command
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    logger.info('DEV_BRANCH_NAVIGATION: Navigating to working branch for development | Purpose: Start development cycle | Next: Version bump and sync');

    try {
        // Get current branch
        const currentBranch = isDryRun ? 'mock-branch' : await getCurrentBranch();
        logger.info(`DEV_CURRENT_BRANCH: Current branch identified | Branch: ${currentBranch} | Action: Determine working branch`);

        // Find the working/development branch from configuration
        let workingBranch = 'working'; // Default fallback

        if (runConfig.branches) {
            const configuredDevBranch = findDevelopmentBranch(runConfig.branches);
            if (configuredDevBranch) {
                workingBranch = configuredDevBranch;
                logger.info(`DEV_WORKING_BRANCH_CONFIGURED: Using configured working branch | Branch: ${workingBranch} | Source: config | Current: ${currentBranch}`);
            } else {
                logger.info(`DEV_WORKING_BRANCH_DEFAULT: No working branch configured | Branch: ${workingBranch} | Source: default | Current: ${currentBranch}`);
            }
        } else {
            logger.info(`DEV_WORKING_BRANCH_NO_CONFIG: No branch configuration found | Branch: ${workingBranch} | Source: default | Current: ${currentBranch}`);
        }

        // Track what actions are taken to determine the appropriate return message
        let branchCreated = false;
        let branchUpdated = false;
        let alreadyOnBranch = false;
        let mergedDevelopmentIntoWorking = false;

        // Determine prerelease tag and increment level from configuration
        const allBranchConfig = runConfig.branches || KODRDRIV_DEFAULTS.branches;
        let prereleaseTag = 'dev'; // Default
        let incrementLevel = 'patch'; // Default

        // Check for development command specific targetVersion override
        if (runConfig.development?.targetVersion) {
            const targetVersion = runConfig.development.targetVersion;

            // Validate targetVersion
            if (!['patch', 'minor', 'major'].includes(targetVersion) && !/^\d+\.\d+\.\d+$/.test(targetVersion.replace(/^v/, ''))) {
                throw new Error(`Invalid target version: ${targetVersion}. Expected "patch", "minor", "major", or a valid version string like "2.1.0"`);
            }

            incrementLevel = targetVersion;
        } else if (allBranchConfig && (allBranchConfig as any)[workingBranch]) {
            const workingBranchConfig = (allBranchConfig as any)[workingBranch];
            if (workingBranchConfig.version) {
                if (workingBranchConfig.version.tag) {
                    prereleaseTag = workingBranchConfig.version.tag;
                }
                if (workingBranchConfig.version.incrementLevel) {
                    incrementLevel = workingBranchConfig.version.incrementLevel;
                }
            }
        }

        logger.info(`DEV_VERSION_CONFIG: Development version configuration | Prerelease Tag: ${prereleaseTag} | Increment Level: ${incrementLevel}`);
        logger.info(`DEV_VERSION_STRATEGY: Version increment strategy | Level: ${incrementLevel} | Tag: ${prereleaseTag} | Purpose: Development version management`);

        // Step 1: Fetch latest remote information
        if (!isDryRun) {
            logger.info('DEV_GIT_FETCH: Fetching latest remote information | Remote: origin | Purpose: Ensure sync before branch operations');
            try {
                await run('git fetch origin');
                logger.info('DEV_GIT_FETCH_SUCCESS: Successfully fetched remote information | Remote: origin | Status: up-to-date');
            } catch (error: any) {
                logger.warn(`DEV_GIT_FETCH_FAILED: Unable to fetch remote | Remote: origin | Error: ${error.message} | Impact: May have stale branch info`);
            }
        } else {
            logger.info('DEV_GIT_FETCH_DRY_RUN: Would fetch latest remote information | Mode: dry-run | Remote: origin');
        }

        // Special case: If currently on development branch, merge development into working
        if (currentBranch === 'development') {
            if (!isDryRun) {
                logger.info('DEV_MERGE_STARTING: Currently on development branch, merging into working | Source: development | Target: working | Purpose: Sync branches before development');
                await run(`git checkout ${workingBranch}`);
                await run(`git merge development --no-ff -m "Merge development into working for continued development"`);
                await run('npm install');

                // Check if npm install created any changes and commit them
                const gitStatus = await run('git status --porcelain');
                if (gitStatus.stdout.trim()) {
                    await run('git add -A');
                    await run('git commit -m "chore: update dependencies after merge"');
                }

                // Stay on working branch for development (removed checkout development)
                mergedDevelopmentIntoWorking = true;
            } else {
                logger.info('DEV_MERGE_DRY_RUN: Would merge development into working | Mode: dry-run | Source: development | Target: working');
                mergedDevelopmentIntoWorking = true;
            }
        }

        // Step 2: Switch to working branch (create if needed) - skip if we handled development branch case
        if (!isDryRun && !mergedDevelopmentIntoWorking) {
            const workingBranchExists = await localBranchExists(workingBranch);
            if (!workingBranchExists) {
                logger.info(`DEV_BRANCH_CREATING: Working branch does not exist, creating now | Branch: ${workingBranch} | Action: Create and checkout | Source: current HEAD`);
                await run(`git checkout -b ${workingBranch}`);
                logger.info(`DEV_BRANCH_CREATED: Successfully created and switched to branch | Branch: ${workingBranch} | Status: checked-out`);
                branchCreated = true;
            } else if (currentBranch !== workingBranch) {
                logger.info(`DEV_BRANCH_SWITCHING: Switching to working branch | Branch: ${workingBranch} | Action: checkout | Previous: ${currentBranch}`);
                await run(`git checkout ${workingBranch}`);
                logger.info(`DEV_BRANCH_SWITCHED: Successfully switched to branch | Branch: ${workingBranch} | Status: checked-out`);
                branchUpdated = true;
            } else {
                logger.info(`DEV_BRANCH_CURRENT: Already on working branch | Branch: ${workingBranch} | Status: no-switch-needed`);
                alreadyOnBranch = true;
            }
        } else if (!mergedDevelopmentIntoWorking) {
            // For dry run, we need to mock the logic
            const workingBranchExists = await localBranchExists(workingBranch);
            if (!workingBranchExists) {
                branchCreated = true;
            } else if (currentBranch !== workingBranch) {
                branchUpdated = true;
            } else {
                alreadyOnBranch = true;
            }
            logger.info(`DEV_BRANCH_DRY_RUN: Would switch to working branch | Mode: dry-run | Branch: ${workingBranch} | Action: Create if needed`);
            logger.info(`DEV_SYNC_DRY_RUN: Would sync branch with remote | Mode: dry-run | Branch: ${workingBranch} | Purpose: Avoid conflicts`);
        }

        // Step 2.1: Sync with remote working branch to avoid conflicts
        if (!isDryRun) {
            try {
                logger.info(`DEV_BRANCH_SYNCING: Synchronizing working branch with remote | Branch: ${workingBranch} | Remote: origin/${workingBranch} | Purpose: Avoid conflicts`);
                const remoteExists = await run(`git ls-remote --exit-code --heads origin ${workingBranch}`).then(() => true).catch(() => false);

                if (remoteExists) {
                    // Use explicit fetch+merge instead of pull to avoid git config conflicts
                    await run(`git fetch origin ${workingBranch}`);
                    await run(`git merge origin/${workingBranch} --no-edit`);
                    logger.info(`DEV_BRANCH_SYNCED: Successfully synchronized with remote | Branch: ${workingBranch} | Remote: origin/${workingBranch} | Status: in-sync`);
                } else {
                    logger.info(`DEV_REMOTE_BRANCH_NOT_FOUND: No remote branch exists | Branch: ${workingBranch} | Remote: origin | Action: Will be created on first push`);
                }
            } catch (error: any) {
                if (error.message && error.message.includes('CONFLICT')) {
                    logger.error(`DEV_MERGE_CONFLICTS: Merge conflicts detected when syncing with remote | Branch: ${workingBranch} | Remote: origin | Status: conflicts-detected`);
                    logger.error(`DEV_CONFLICT_RESOLUTION: Manual conflict resolution required:`);
                    logger.error(`   Step 1: Resolve conflicts in the files`);
                    logger.error(`   Step 2: Stage resolved files | Command: git add <resolved-files>`);
                    logger.error(`   Step 3: Complete merge | Command: git commit`);
                    logger.error(`   Step 4: Resume development | Command: kodrdriv development`);
                    throw new Error(`Merge conflicts detected when syncing ${workingBranch} with remote. Please resolve conflicts manually.`);
                } else {
                    logger.warn(`DEV_SYNC_FAILED: Could not sync with remote | Branch: ${workingBranch} | Remote: origin | Error: ${error.message}`);
                }
            }
        }

        // Step 2.5: Sync with target branch (main) if it exists
        // This is a safety net for when publish fails or user ends up on target branch
        if (!isDryRun) {
            // Determine target branch from config
            const targetBranch = allBranchConfig && (allBranchConfig as any)[workingBranch]?.targetBranch || 'main';
            const targetBranchExists = await localBranchExists(targetBranch);

            if (targetBranchExists) {
                logger.info(`DEV_TARGET_SYNC: Syncing working branch with target branch | Working: ${workingBranch} | Target: ${targetBranch} | Strategy: fast-forward`);
                try {
                    await run(`git merge ${targetBranch} --ff-only`);
                    logger.info(`DEV_TARGET_MERGED_FF: Fast-forward merged target into working | Target: ${targetBranch} | Working: ${workingBranch} | Status: merged`);
                } catch (error: any) {
                    // Fast-forward failed, might need regular merge
                    if (error.message && error.message.includes('Not possible to fast-forward')) {
                        logger.warn(`DEV_NO_FAST_FORWARD: Cannot fast-forward merge | Target: ${targetBranch} | Working: ${workingBranch} | Reason: Divergent history`);
                        logger.info(`DEV_REGULAR_MERGE_ATTEMPTING: Attempting regular merge | Strategy: fast-forward preferred | Purpose: Sync branches`);
                        try {
                            await run(`git merge ${targetBranch} -m "Merge ${targetBranch} into ${workingBranch} for sync"`);
                            logger.info(`DEV_TARGET_MERGED: Merged target into working | Target: ${targetBranch} | Working: ${workingBranch} | Status: merged`);

                            // Run npm install after merge
                            logger.info('DEV_POST_MERGE_INSTALL: Running npm install after merge | Command: npm install | Purpose: Update dependencies');
                            await run('npm install');

                            // Check if npm install created changes
                            const gitStatus = await run('git status --porcelain');
                            if (gitStatus.stdout.trim()) {
                                logger.info('DEV_POST_MERGE_COMMIT: Committing changes from npm install | Purpose: Finalize merge');
                                await run('git add -A');
                                await run('git commit -m "chore: update dependencies after merge"');
                            }
                        } catch (mergeError: any) {
                            if (mergeError.message && mergeError.message.includes('CONFLICT')) {
                                logger.error(`DEV_MERGE_CONFLICTS: Merge conflicts detected | Target: ${targetBranch} | Working: ${workingBranch} | Status: conflicts-detected`);
                                logger.error(`DEV_CONFLICT_RESOLUTION: Manual conflict resolution required:`);
                                logger.error(`   Step 1: Resolve conflicts in the files`);
                                logger.error(`   Step 2: Stage resolved files | Command: git add <resolved-files>`);
                                logger.error(`   Step 3: Complete merge | Command: git commit`);
                                logger.error(`   Step 4: Update dependencies | Command: npm install`);
                                logger.error(`   Step 5: Resume development | Command: kodrdriv development`);
                                throw new Error(`Merge conflicts detected when merging ${targetBranch} into ${workingBranch}. Please resolve conflicts manually.`);
                            } else {
                                throw mergeError;
                            }
                        }
                    } else {
                        logger.warn(`DEV_TARGET_MERGE_FAILED: Could not merge target into working | Target: ${targetBranch} | Working: ${workingBranch} | Error: ${error.message}`);
                    }
                }
            } else {
                logger.info(`DEV_TARGET_NOT_EXISTS: Target branch does not exist | Branch: ${targetBranch} | Action: Skipping target sync | Status: no-target-branch`);
            }
        } else {
            logger.info('Would sync working branch with target branch (main) if it exists');
        }

        // Step 3: Merge latest changes from development branch if it exists
        if (!isDryRun) {
            const developmentBranchExists = await localBranchExists('development');
            if (mergedDevelopmentIntoWorking) {
                logger.info('DEV_ALREADY_MERGED: Already merged from development | Reason: Was on development branch | Action: Skipping');
            } else if (developmentBranchExists) {
                logger.info('DEV_DEVELOPMENT_MERGE: Merging latest changes from development branch | Source: development | Target: ' + workingBranch + ' | Purpose: Sync development changes');

                try {
                    await run(`git merge development --no-ff -m "Merge latest development changes into ${workingBranch}"`);
                    logger.info('DEV_DEVELOPMENT_MERGED: Successfully merged development changes | Source: development | Target: ' + workingBranch + ' | Status: merged');

                    // Run npm install after merge to update dependencies
                    logger.info('DEV_DEVELOPMENT_INSTALL: Running npm install after merge | Command: npm install | Purpose: Update dependencies');
                    await run('npm install');

                    // Check if npm install created any changes (e.g., package-lock.json)
                    const gitStatus = await run('git status --porcelain');
                    if (gitStatus.stdout.trim()) {
                        logger.info('DEV_POST_MERGE_COMMIT: Committing changes from npm install | Purpose: Finalize merge');
                        await run('git add -A');
                        await run(`git commit -m "chore: update package-lock.json after merge"`);
                        logger.info('DEV_CHANGES_COMMITTED: Changes committed successfully | Status: committed');
                    }

                } catch (error: any) {
                    if (error.message && error.message.includes('CONFLICT')) {
                        logger.error(`DEV_DEV_MERGE_CONFLICTS: Merge conflicts detected | Source: development | Target: ${workingBranch} | Status: conflicts-detected`);
                        logger.error(`DEV_DEV_CONFLICT_RESOLUTION: Manual conflict resolution required:`);
                        logger.error(`   Step 1: Resolve conflicts in the files`);
                        logger.error(`   Step 2: Stage resolved files | Command: git add <resolved-files>`);
                        logger.error(`   Step 3: Complete merge | Command: git commit`);
                        logger.error(`   Step 4: Update dependencies | Command: npm install`);
                        logger.error(`   Step 5: Bump version | Command: npm version pre${incrementLevel} --preid=${prereleaseTag}`);
                        throw new Error(`Merge conflicts detected when merging development into ${workingBranch}. Please resolve conflicts manually.`);
                    } else {
                        logger.error(`DEV_DEV_MERGE_FAILED: Failed to merge development branch | Source: development | Target: ${workingBranch} | Error: ${error.message}`);
                        throw error;
                    }
                }
            } else {
                logger.info('DEV_NO_DEV_BRANCH: Development branch does not exist | Branch: development | Action: Skipping merge step | Status: not-found');
            }
        } else {
            logger.info('DEV_DEV_MERGE_DRY_RUN: Would merge development if exists | Mode: dry-run | Source: development | Target: working');
            logger.info('DEV_INSTALL_DRY_RUN: Would run npm install after merge | Mode: dry-run | Command: npm install');
            logger.info('DEV_COMMIT_DRY_RUN: Would commit npm install changes | Mode: dry-run');
        }

        // Step 4.5: Create retroactive tags if requested (one-time operation)
        if (runConfig.development?.createRetroactiveTags) {
            const tagPrefix = runConfig.development?.workingTagPrefix || 'working/';
            await createRetroactiveTags(workingBranch, isDryRun, logger, tagPrefix);
        }

        // Step 5: Check if we already have a proper development version
        if (alreadyOnBranch && !mergedDevelopmentIntoWorking) {
            // Check if current version is already a development version with the right tag
            const fs = await import('fs/promises');
            try {
                const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
                const currentVersion = packageJson.version;

                // If current version already has the dev tag, we're done
                if (currentVersion.includes(`-${prereleaseTag}.`)) {
                    logger.info(`DEV_ALREADY_DEV_VERSION: Already on working branch with development version | Branch: ${workingBranch} | Version: ${currentVersion} | Status: no-bump-needed`);
                    return 'Already on working branch with development version';
                }
            } catch {
                logger.debug('Could not check current version, proceeding with version bump');
            }
        }

        // Step 5.5: Tag working branch with current release version BEFORE bumping
        if (runConfig.development?.tagWorkingBranch !== false) {
            try {
                const fs = await import('fs/promises');
                const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8'));
                const currentVersion = packageJson.version;

                // Only tag if current version is a release version (not already a dev version)
                const isReleaseVersion = currentVersion &&
                                        !currentVersion.includes('-dev.') &&
                                        !currentVersion.includes('-alpha.') &&
                                        !currentVersion.includes('-beta.') &&
                                        !currentVersion.includes('-rc.');

                if (isReleaseVersion) {
                    const tagPrefix = runConfig.development?.workingTagPrefix || 'working/';
                    const workingTagName = `${tagPrefix}v${currentVersion}`;

                    if (!isDryRun) {
                        logger.info(`DEV_TAG_RELEASE_VERSION: Current version is release version | Version: ${currentVersion} | Type: release | Action: Will tag before bump`);
                        logger.verbose(`Checking if tag ${workingTagName} exists...`);

                        // Check if tag already exists
                        const tagExistsResult = await run(`git tag -l "${workingTagName}"`);
                        const tagExists = tagExistsResult.stdout.trim() !== '';

                        if (tagExists) {
                            logger.info(`DEV_TAG_EXISTS: Tag already exists | Tag: ${workingTagName} | Action: Skipping tag creation | Status: already-tagged`);
                        } else {
                            // Create tag on current commit (working branch at release version)
                            logger.verbose(`Creating tag ${workingTagName} at current HEAD...`);
                            await run(`git tag ${workingTagName}`);

                            // Push tag to remote
                            logger.verbose(`Pushing tag ${workingTagName} to origin...`);
                            await run(`git push origin ${workingTagName}`);

                            logger.info(`DEV_TAG_CREATED: Tagged working branch | Tag: ${workingTagName} | Version: ${currentVersion} | Status: tagged-and-pushed`);
                            logger.info(`DEV_TAG_RELEASE_NOTES_HINT: Release notes can be generated | Version: v${currentVersion} | Command: kodrdriv release --from {previous-tag} --to ${workingTagName}`);
                        }
                    } else {
                        logger.info(`DEV_TAG_DRY_RUN: Would tag working branch | Mode: dry-run | Tag: ${workingTagName} | Version: ${currentVersion}`);
                    }
                } else if (currentVersion) {
                    logger.verbose(`Current version is ${currentVersion} (prerelease), skipping tag creation`);
                } else {
                    logger.debug('Could not determine current version, skipping tag creation');
                }
            } catch (error: any) {
                if (!isDryRun) {
                    logger.warn(`DEV_TAG_FAILED: Could not tag working branch | Error: ${error.message} | Impact: Not critical | Alternative: Manual tagging`);
                    logger.warn('DEV_TAG_MANUAL: Manual tagging option available | Action: Tag manually later | Purpose: Mark release point');
                } else {
                    logger.info('Would tag working branch with current release version if applicable');
                }
                // Don't throw - tagging is optional, continue with version bump
            }
        } else if (isDryRun) {
            logger.info('Tagging disabled (--no-tag-working-branch)');
        }

        // Step 6: Bump version manually to avoid npm version's automatic git add
        // Note: npm version --no-git-tag-version still runs "git add package.json package-lock.json"
        // which fails when package-lock.json is gitignored
        if (['patch', 'minor', 'major'].includes(incrementLevel)) {
            logger.info(`DEV_VERSION_BUMPING: Bumping version with prerelease tag | Level: ${incrementLevel} | Tag: ${prereleaseTag}`);
        } else {
            logger.info(`DEV_VERSION_EXPLICIT: Setting explicit version | Version: ${incrementLevel}-${prereleaseTag}.0 | Type: explicit`);
        }

        if (!isDryRun) {
            try {
                const storage = createStorage();
                const pkgJsonContents = await storage.readFile('package.json', 'utf-8');
                const pkgJson = safeJsonParse(pkgJsonContents, 'package.json');
                const validatedPkgJson = validatePackageJson(pkgJson, 'package.json');
                const currentVersion = validatedPkgJson.version;
                
                let newVersion: string;
                if (['patch', 'minor', 'major'].includes(incrementLevel)) {
                    // First increment the base version, then add prerelease tag
                    let baseVersion: string;
                    switch (incrementLevel) {
                        case 'patch':
                            baseVersion = incrementPatchVersion(currentVersion);
                            break;
                        case 'minor':
                            baseVersion = incrementMinorVersion(currentVersion);
                            break;
                        case 'major':
                            baseVersion = incrementMajorVersion(currentVersion);
                            break;
                        default:
                            baseVersion = incrementPatchVersion(currentVersion);
                    }
                    newVersion = `${baseVersion}-${prereleaseTag}.0`;
                } else {
                    // Explicit version like "3.5.0"
                    const cleanVersion = incrementLevel.replace(/^v/, '');
                    newVersion = `${cleanVersion}-${prereleaseTag}.0`;
                }
                
                // Update package.json with new version
                validatedPkgJson.version = newVersion;
                await storage.writeFile('package.json', JSON.stringify(validatedPkgJson, null, 2) + '\n', 'utf-8');
                
                logger.info(`DEV_VERSION_BUMPED: Version bumped successfully | New Version: ${newVersion} | Status: completed`);
                
                // Manually commit the version bump (package-lock.json is ignored)
                await run('git add package.json');
                await run(`git commit -m "chore: bump to ${newVersion}"`);

                // Return appropriate message based on what actions were taken
                if (mergedDevelopmentIntoWorking) {
                    return 'Merged development into working and ready for development';
                } else if (branchCreated) {
                    return 'Created working branch with development version';
                } else if (branchUpdated) {
                    return 'Updated working branch with development version';
                } else if (alreadyOnBranch) {
                    return 'Already on working branch with development version';
                } else {
                    return `Ready for development on ${workingBranch} with version ${newVersion}`;
                }
            } catch (error: any) {
                logger.error(`DEV_VERSION_BUMP_FAILED: Failed to bump version | Error: ${error.message} | Impact: Version not updated`);
                throw new Error(`Failed to bump ${incrementLevel} version: ${error.message}`);
            }
        } else {
            if (['patch', 'minor', 'major'].includes(incrementLevel)) {
                logger.info(`Would bump version with prerelease tag: ${incrementLevel} --preid=${prereleaseTag}`);
            } else {
                logger.info(`Would set explicit version: ${incrementLevel}-${prereleaseTag}.0`);
            }

            // Return appropriate message based on what actions were taken
            if (mergedDevelopmentIntoWorking) {
                return 'Merged development into working and ready for development';
            } else if (branchCreated) {
                return 'Created working branch with development version';
            } else if (branchUpdated) {
                return 'Updated working branch with development version';
            } else if (alreadyOnBranch) {
                return 'Already on working branch with development version';
            } else {
                return `Ready for development on ${workingBranch} (dry run)`;
            }
        }

    } catch (error: any) {
        logger.error('Failed to prepare working branch for development:', error.message);
        throw error;
    }
};
