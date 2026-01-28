/**
 * Checkpoint System for Publish Recovery
 *
 * Saves state at critical points during publish to enable recovery from failures.
 * Checkpoints are saved locally and help determine the appropriate recovery strategy.
 */

import { getLogger } from '@grunnverk/core';
import { createStorage } from '@grunnverk/shared';
import path from 'path';

const logger = getLogger();

/**
 * Phases of the publish workflow
 */
export type PublishPhase =
    | 'initialized'        // Publish command started
    | 'validated'          // Pre-publish validation passed
    | 'pr-created'         // Pull request created
    | 'pr-merged'          // Pull request merged to main
    | 'tagged'             // Git tag created
    | 'npm-publishing'     // npm publish in progress
    | 'npm-published'      // npm publish completed
    | 'completed'          // Entire workflow completed
    | 'failed';            // Workflow failed

/**
 * Checkpoint data structure
 */
export interface PublishCheckpoint {
    /** Current phase of the publish workflow */
    phase: PublishPhase;

    /** Timestamp when checkpoint was created */
    timestamp: string;

    /** Package name */
    packageName: string;

    /** Target version being published */
    version: string;

    /** Current git branch */
    branch: string;

    /** Working directory */
    workingDirectory: string;

    /** Pull request number (if created) */
    prNumber?: number;

    /** Pull request URL (if created) */
    prUrl?: string;

    /** Git tags created during this publish */
    tags: string[];

    /** Whether npm publish completed successfully */
    npmPublished: boolean;

    /** GitHub workflow run ID (if available) */
    workflowRunId?: string;

    /** GitHub workflow run URL (if available) */
    workflowRunUrl?: string;

    /** Error message if failed */
    error?: string;

    /** Additional metadata */
    metadata?: {
        targetBranch?: string;
        fromBranch?: string;
        commitSha?: string;
        [key: string]: any;
    };
}

/**
 * Get the checkpoint file path for a directory
 */
function getCheckpointPath(workingDirectory: string): string {
    return path.join(workingDirectory, '.kodrdriv-publish-checkpoint.json');
}

/**
 * Save a checkpoint
 */
export async function saveCheckpoint(checkpoint: PublishCheckpoint): Promise<void> {
    const storage = createStorage();
    const checkpointPath = getCheckpointPath(checkpoint.workingDirectory);

    try {
        await storage.writeFile(
            checkpointPath,
            JSON.stringify(checkpoint, null, 2),
            'utf-8'
        );

        logger.debug(`CHECKPOINT_SAVED: Saved publish checkpoint | Phase: ${checkpoint.phase} | Package: ${checkpoint.packageName} | Version: ${checkpoint.version}`);
    } catch (error: any) {
        logger.warn(`CHECKPOINT_SAVE_FAILED: Failed to save checkpoint | Error: ${error.message}`);
    }
}

/**
 * Load the most recent checkpoint
 */
export async function loadCheckpoint(workingDirectory: string): Promise<PublishCheckpoint | null> {
    const storage = createStorage();
    const checkpointPath = getCheckpointPath(workingDirectory);

    try {
        if (!await storage.exists(checkpointPath)) {
            return null;
        }

        const content = await storage.readFile(checkpointPath, 'utf-8');
        const checkpoint = JSON.parse(content) as PublishCheckpoint;

        logger.debug(`CHECKPOINT_LOADED: Loaded publish checkpoint | Phase: ${checkpoint.phase} | Package: ${checkpoint.packageName} | Version: ${checkpoint.version}`);

        return checkpoint;
    } catch (error: any) {
        logger.warn(`CHECKPOINT_LOAD_FAILED: Failed to load checkpoint | Error: ${error.message}`);
        return null;
    }
}

/**
 * Delete checkpoint (cleanup after successful publish)
 */
export async function deleteCheckpoint(workingDirectory: string): Promise<void> {
    const storage = createStorage();
    const checkpointPath = getCheckpointPath(workingDirectory);

    try {
        if (await storage.exists(checkpointPath)) {
            await storage.deleteFile(checkpointPath);
            logger.debug('CHECKPOINT_DELETED: Removed publish checkpoint after successful completion');
        }
    } catch (error: any) {
        logger.warn(`CHECKPOINT_DELETE_FAILED: Failed to delete checkpoint | Error: ${error.message}`);
    }
}

/**
 * Update an existing checkpoint with new data
 */
export async function updateCheckpoint(
    workingDirectory: string,
    updates: Partial<PublishCheckpoint>
): Promise<void> {
    const existing = await loadCheckpoint(workingDirectory);

    if (!existing) {
        logger.warn('CHECKPOINT_UPDATE_FAILED: No existing checkpoint to update');
        return;
    }

    const updated: PublishCheckpoint = {
        ...existing,
        ...updates,
        timestamp: new Date().toISOString(),
    };

    await saveCheckpoint(updated);
}

/**
 * Analyze checkpoint to determine recovery strategy
 */
export interface RecoveryStrategy {
    /** Can this publish be recovered? */
    recoverable: boolean;

    /** Recommended recovery action */
    action: 'rollback' | 'fix-forward' | 'reset' | 'continue' | 'none';

    /** Human-readable explanation */
    explanation: string;

    /** Detailed recovery steps */
    steps: string[];

    /** Risks of the recovery action */
    risks: string[];
}

/**
 * Determine the appropriate recovery strategy based on checkpoint
 */
export function analyzeRecoveryStrategy(checkpoint: PublishCheckpoint): RecoveryStrategy {
    const phase = checkpoint.phase;

    // Phase: initialized, validated, pr-created
    // These are safe - nothing permanent has happened yet
    if (phase === 'initialized' || phase === 'validated' || phase === 'pr-created') {
        return {
            recoverable: true,
            action: 'continue',
            explanation: 'Publish can be continued or restarted safely',
            steps: [
                'Fix any issues that caused the failure',
                'Run: kodrdriv publish --continue',
                'Or restart: kodrdriv publish'
            ],
            risks: ['None - no permanent changes have been made']
        };
    }

    // Phase: pr-merged (but not published)
    // This is the danger zone - merge is permanent but npm publish hasn't happened
    if (phase === 'pr-merged' && !checkpoint.npmPublished) {
        return {
            recoverable: true,
            action: 'rollback',
            explanation: 'PR merged but npm publish failed - can rollback the merge',
            steps: [
                'Revert the merge commit on main branch',
                'Delete any git tags that were created',
                'Reset working branch to clean state',
                'Increment version for next attempt',
                'Run: kodrdriv publish --rollback'
            ],
            risks: [
                'Creates a revert commit in main branch history',
                'Any work based on the merge will need to be rebased',
                'Tags will be deleted and recreated on next publish'
            ]
        };
    }

    // Phase: tagged, npm-publishing (but not completed)
    // Tags exist but npm publish incomplete
    if ((phase === 'tagged' || phase === 'npm-publishing') && !checkpoint.npmPublished) {
        return {
            recoverable: true,
            action: 'rollback',
            explanation: 'Tags created but npm publish incomplete - can rollback',
            steps: [
                'Delete git tags',
                'Revert merge commit if it exists',
                'Reset working branch',
                'Increment version',
                'Run: kodrdriv publish --rollback'
            ],
            risks: [
                'Tags will be deleted and recreated',
                'Merge commit will be reverted if it exists'
            ]
        };
    }

    // Phase: npm-published or completed
    // Package is published - can't rollback npm
    if (checkpoint.npmPublished || phase === 'npm-published' || phase === 'completed') {
        return {
            recoverable: false,
            action: 'fix-forward',
            explanation: 'Package already published to npm - must fix forward',
            steps: [
                'Package is live on npm - cannot unpublish',
                'If there are issues, publish a patch version',
                'Run: kodrdriv publish --target-version patch',
                'Or manually fix and increment version'
            ],
            risks: [
                'Cannot undo npm publish',
                'Must publish new version to fix issues'
            ]
        };
    }

    // Phase: failed (generic failure)
    if (phase === 'failed') {
        // Determine based on what was completed
        if (checkpoint.npmPublished) {
            return analyzeRecoveryStrategy({ ...checkpoint, phase: 'npm-published' });
        } else if (checkpoint.prNumber) {
            return analyzeRecoveryStrategy({ ...checkpoint, phase: 'pr-merged' });
        } else {
            return analyzeRecoveryStrategy({ ...checkpoint, phase: 'initialized' });
        }
    }

    // Unknown phase or state
    return {
        recoverable: false,
        action: 'none',
        explanation: 'Unable to determine recovery strategy from checkpoint',
        steps: [
            'Manually inspect the repository state',
            'Check: git status, git log, npm view <package>',
            'Determine what was completed',
            'Contact support if needed'
        ],
        risks: ['Manual intervention required']
    };
}

/**
 * Get a human-readable summary of the checkpoint
 */
export function getCheckpointSummary(checkpoint: PublishCheckpoint): string {
    const lines: string[] = [];

    lines.push('='.repeat(60));
    lines.push('Publish Checkpoint Summary');
    lines.push('='.repeat(60));
    lines.push('');
    lines.push(`Package: ${checkpoint.packageName}`);
    lines.push(`Version: ${checkpoint.version}`);
    lines.push(`Phase: ${checkpoint.phase}`);
    lines.push(`Branch: ${checkpoint.branch}`);
    lines.push(`Timestamp: ${checkpoint.timestamp}`);
    lines.push('');

    if (checkpoint.prNumber) {
        lines.push(`Pull Request: #${checkpoint.prNumber}`);
        if (checkpoint.prUrl) {
            lines.push(`PR URL: ${checkpoint.prUrl}`);
        }
    }

    if (checkpoint.tags.length > 0) {
        lines.push(`Tags Created: ${checkpoint.tags.join(', ')}`);
    }

    if (checkpoint.npmPublished) {
        lines.push('✅ npm Published: Yes');
    } else {
        lines.push('❌ npm Published: No');
    }

    if (checkpoint.workflowRunUrl) {
        lines.push(`Workflow: ${checkpoint.workflowRunUrl}`);
    }

    if (checkpoint.error) {
        lines.push('');
        lines.push('Error:');
        lines.push(`  ${checkpoint.error}`);
    }

    lines.push('');
    lines.push('='.repeat(60));

    return lines.join('\n');
}

/**
 * Check if a checkpoint indicates a failed publish
 */
export function isFailedPublish(checkpoint: PublishCheckpoint): boolean {
    return checkpoint.phase === 'failed' ||
           (checkpoint.phase === 'pr-merged' && !checkpoint.npmPublished) ||
           (checkpoint.phase === 'tagged' && !checkpoint.npmPublished) ||
           (checkpoint.phase === 'npm-publishing' && !checkpoint.npmPublished);
}
