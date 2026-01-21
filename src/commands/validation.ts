/**
 * Comprehensive pre-flight validation for publish operations
 *
 * Runs ALL validation checks and collects ALL issues before reporting,
 * allowing users to fix multiple problems at once rather than one at a time.
 */

import { run } from '@eldrforge/git-tools';
import { getLogger, ValidationError } from '@eldrforge/core';
import { createStorage } from '@eldrforge/shared';
import path from 'path';
import type { Config } from '@eldrforge/core';

export interface ValidationIssue {
    check: string;
    message: string;
    files?: string[];
    suggestion?: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
}

/**
 * Run comprehensive pre-flight validation
 */
export async function runPreflightValidation(
    runConfig: Config,
    targetBranch?: string
): Promise<ValidationResult> {
    const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: []
    };

    const isDryRun = runConfig.dryRun || false;

    // Run all checks in parallel to collect all issues at once
    await Promise.all([
        checkGitRepository(result, isDryRun),
        checkGitStatus(result, isDryRun),
        checkCurrentBranch(result, targetBranch, isDryRun),
        checkTargetBranchSync(result, targetBranch, isDryRun),
        checkScripts(result, isDryRun),
        checkWorkspaceStructure(result, runConfig, isDryRun),
        checkCredentials(result, runConfig, isDryRun),
    ]);

    result.valid = result.errors.length === 0;
    return result;
}

/**
 * Check if we're in a git repository
 */
async function checkGitRepository(result: ValidationResult, isDryRun: boolean): Promise<void> {
    try {
        if (!isDryRun) {
            await run('git rev-parse --git-dir');
        }
    } catch {
        result.errors.push({
            check: 'git_repository',
            message: 'Not in a git repository or git command failed',
            suggestion: 'Please run this command from within a git repository'
        });
    }
}

/**
 * Check for uncommitted changes
 */
async function checkGitStatus(result: ValidationResult, isDryRun: boolean): Promise<void> {
    try {
        if (!isDryRun) {
            const { stdout } = await run('git status --porcelain');
            if (stdout.trim()) {
                const files = stdout.trim().split('\n').map(line => line.substring(3).trim());
                result.errors.push({
                    check: 'git_status',
                    message: 'Working directory has uncommitted changes',
                    files: files,
                    suggestion: 'Please commit or stash your changes before running publish'
                });
            }
        }
    } catch (error: any) {
        result.errors.push({
            check: 'git_status',
            message: `Failed to check git status: ${error.message}`,
            suggestion: 'Ensure you are in a valid git repository and try again'
        });
    }
}

/**
 * Check that we're not running from the target branch
 */
async function checkCurrentBranch(result: ValidationResult, targetBranch: string | undefined, isDryRun: boolean): Promise<void> {
    try {
        if (!isDryRun && targetBranch) {
            const { stdout } = await run('git branch --show-current');
            const currentBranch = stdout.trim();

            if (currentBranch === targetBranch) {
                result.errors.push({
                    check: 'current_branch',
                    message: `Cannot run publish from the target branch '${targetBranch}'`,
                    suggestion: 'Please switch to a different branch before running publish'
                });
            }
        }
    } catch (error: any) {
        result.errors.push({
            check: 'current_branch',
            message: `Failed to check current branch: ${error.message}`
        });
    }
}

/**
 * Check target branch sync with remote
 */
async function checkTargetBranchSync(result: ValidationResult, targetBranch: string | undefined, isDryRun: boolean): Promise<void> {
    try {
        if (!isDryRun && targetBranch) {
            // Check if local target branch exists
            try {
                await run(`git rev-parse --verify ${targetBranch}`);

                // Check if in sync with remote
                const { stdout: localSha } = await run(`git rev-parse ${targetBranch}`);
                const { stdout: remoteSha } = await run(`git rev-parse origin/${targetBranch}`);

                if (localSha.trim() !== remoteSha.trim()) {
                    result.warnings.push({
                        check: 'target_branch_sync',
                        message: `Target branch '${targetBranch}' is not in sync with remote`,
                        suggestion: `Run: git checkout ${targetBranch} && git pull origin ${targetBranch}`
                    });
                }
            } catch {
                // Branch doesn't exist locally - that's okay
            }
        }
    } catch (error: any) {
        // Non-critical - just warn
        result.warnings.push({
            check: 'target_branch_sync',
            message: `Could not verify target branch sync: ${error.message}`
        });
    }
}

/**
 * Check for required scripts in package.json
 */
async function checkScripts(result: ValidationResult, _isDryRun: boolean): Promise<void> {
    const storage = createStorage();
    const packageJsonPath = path.join(process.cwd(), 'package.json');

    try {
        if (!await storage.exists(packageJsonPath)) {
            result.errors.push({
                check: 'package_json',
                message: 'package.json not found in current directory',
                files: [packageJsonPath]
            });
            return;
        }

        const content = await storage.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);

        if (!packageJson.scripts?.prepublishOnly) {
            result.errors.push({
                check: 'prepublish_script',
                message: 'prepublishOnly script is required in package.json but was not found',
                files: [packageJsonPath],
                suggestion: 'Add a prepublishOnly script that runs your pre-flight checks (e.g., clean, lint, build, test)'
            });
        }
    } catch (error: any) {
        result.errors.push({
            check: 'package_json',
            message: `Failed to check package.json: ${error.message}`,
            files: [packageJsonPath]
        });
    }
}

/**
 * Check workspace structure (for tree operations)
 */
async function checkWorkspaceStructure(result: ValidationResult, runConfig: Config, _isDryRun: boolean): Promise<void> {
    // Only check if this looks like a tree operation
    if (runConfig.tree) {
        const storage = createStorage();
        const rootPath = process.cwd();
        const packageJsonPath = path.join(rootPath, 'package.json');

        try {
            if (!await storage.exists(packageJsonPath)) {
                result.errors.push({
                    check: 'workspace_structure',
                    message: 'No package.json found at workspace root',
                    files: [packageJsonPath],
                    suggestion: 'Expected workspace root with package.json containing "workspaces" field'
                });
            }
        } catch (error: any) {
            result.warnings.push({
                check: 'workspace_structure',
                message: `Could not verify workspace structure: ${error.message}`
            });
        }
    }
}

/**
 * Check for required environment variables
 */
async function checkCredentials(result: ValidationResult, runConfig: Config, _isDryRun: boolean): Promise<void> {
    const requiredEnvVars = runConfig.publish?.requiredEnvVars || [];
    const missingVars: string[] = [];

    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            missingVars.push(envVar);
        }
    }

    if (missingVars.length > 0) {
        if (_isDryRun) {
            result.warnings.push({
                check: 'environment_variables',
                message: `Required environment variables not set: ${missingVars.join(', ')}`,
                suggestion: 'Would fail in real publish. Please set these environment variables.'
            });
        } else {
            result.errors.push({
                check: 'environment_variables',
                message: `Missing required environment variables: ${missingVars.join(', ')}`,
                suggestion: 'Please set these environment variables before running publish'
            });
        }
    }
}

/**
 * Log validation results
 */
export function logValidationResults(result: ValidationResult): void {
    const logger = getLogger();

    if (result.errors.length > 0) {
        logger.error('');
        logger.error('VALIDATION_FAILED: Pre-flight validation failed | Errors: ' + result.errors.length + ' | Status: cannot-proceed');
        logger.error('');
        logger.error('VALIDATION_ERRORS: The following issues must be fixed:');
        result.errors.forEach((error, idx) => {
            logger.error(`  ${idx + 1}. [${error.check}] ${error.message}`);
            if (error.files && error.files.length > 0) {
                logger.error(`     Files: ${error.files.join(', ')}`);
            }
            if (error.suggestion) {
                logger.error(`     → ${error.suggestion}`);
            }
        });
        logger.error('');
    }

    if (result.warnings.length > 0) {
        logger.warn('');
        logger.warn('VALIDATION_WARNINGS: Pre-flight validation warnings | Warnings: ' + result.warnings.length + ' | Status: proceed-with-caution');
        logger.warn('');
        result.warnings.forEach((warning, idx) => {
            logger.warn(`  ${idx + 1}. [${warning.check}] ${warning.message}`);
            if (warning.suggestion) {
                logger.warn(`     → ${warning.suggestion}`);
            }
        });
        logger.warn('');
    }

    if (result.valid) {
        logger.info('VALIDATION_PASSED: All pre-flight validation checks passed | Status: ready-to-proceed');
    }
}

/**
 * Throw ValidationError if validation failed
 */
export function throwIfValidationFailed(result: ValidationResult): void {
    if (!result.valid) {
        throw new ValidationError(
            `Pre-flight validation failed with ${result.errors.length} error(s)`,
            {
                phase: 'pre_flight_validation'
            },
            result.errors,
            result.warnings
        );
    }
}
