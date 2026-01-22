/**
 * Dry-run reporting for publish operations
 *
 * Provides comprehensive preview of what would happen during publish
 */

import { getLogger } from '@grunnverk/core';

export interface DryRunReport {
    operations: Array<{
        step: string;
        command?: string;
        files?: Array<{
            path: string;
            changes: string;
        }>;
        description: string;
    }>;
    versionChanges: {
        current: string;
        proposed: string;
    };
    tags: string[];
    npmPublish: {
        package: string;
        version: string;
        files: string[];
    };
    prDetails?: {
        title: string;
        targetBranch: string;
        sourceBranch: string;
    };
}

export interface TreeDryRunReport {
    packages: Array<{
        name: string;
        order: number;
        dependencies: string[];
        operations: string[];
        versionChange?: {
            from: string;
            to: string;
        };
    }>;
    dependencyUpdates: Array<{
        package: string;
        dependency: string;
        from: string;
        to: string;
    }>;
    buildOrder: string[];
}

/**
 * Log dry-run report for single package publish
 */
export function logDryRunReport(report: DryRunReport): void {
    const logger = getLogger();

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('                    DRY RUN REPORT                          ');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');

    // Version changes
    logger.info('📦 VERSION CHANGES:');
    logger.info(`   Current:  ${report.versionChanges.current}`);
    logger.info(`   Proposed: ${report.versionChanges.proposed}`);
    logger.info('');

    // Operations
    logger.info('🔧 OPERATIONS TO BE PERFORMED:');
    report.operations.forEach((op, idx) => {
        logger.info(`   ${idx + 1}. ${op.step}`);
        logger.info(`      ${op.description}`);
        if (op.command) {
            logger.info(`      Command: ${op.command}`);
        }
        if (op.files && op.files.length > 0) {
            logger.info('      Files:');
            op.files.forEach(file => {
                logger.info(`         - ${file.path}`);
                if (file.changes) {
                    logger.info(`           ${file.changes}`);
                }
            });
        }
    });
    logger.info('');

    // Tags
    if (report.tags.length > 0) {
        logger.info('🏷️  TAGS TO BE CREATED:');
        report.tags.forEach(tag => {
            logger.info(`   - ${tag}`);
        });
        logger.info('');
    }

    // NPM publish
    logger.info('📤 NPM PUBLISH:');
    logger.info(`   Package: ${report.npmPublish.package}`);
    logger.info(`   Version: ${report.npmPublish.version}`);
    if (report.npmPublish.files.length > 0) {
        logger.info('   Files to be published:');
        report.npmPublish.files.forEach(file => {
            logger.info(`      - ${file}`);
        });
    }
    logger.info('');

    // PR details
    if (report.prDetails) {
        logger.info('🔀 PULL REQUEST:');
        logger.info(`   Title:  ${report.prDetails.title}`);
        logger.info(`   Source: ${report.prDetails.sourceBranch}`);
        logger.info(`   Target: ${report.prDetails.targetBranch}`);
        logger.info('');
    }

    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('                  END DRY RUN REPORT                        ');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');
    logger.info('ℹ️  This was a dry run. No actual changes were made.');
    logger.info('   To execute these operations, run without --dry-run flag.');
    logger.info('');
}

/**
 * Log dry-run report for tree operations
 */
export function logTreeDryRunReport(report: TreeDryRunReport): void {
    const logger = getLogger();

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('                 TREE DRY RUN REPORT                        ');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');

    // Build order
    logger.info('📦 PACKAGE BUILD ORDER:');
    logger.info(`   Total packages: ${report.buildOrder.length}`);
    logger.info('   Execution order:');
    report.buildOrder.forEach((pkg, idx) => {
        logger.info(`      ${idx + 1}. ${pkg}`);
    });
    logger.info('');

    // Package details
    logger.info('🔧 PACKAGE OPERATIONS:');
    report.packages.forEach(pkg => {
        logger.info(`   [${pkg.order}] ${pkg.name}`);
        if (pkg.dependencies.length > 0) {
            logger.info(`       Dependencies: ${pkg.dependencies.join(', ')}`);
        }
        if (pkg.versionChange) {
            logger.info(`       Version: ${pkg.versionChange.from} → ${pkg.versionChange.to}`);
        }
        if (pkg.operations.length > 0) {
            logger.info('       Operations:');
            pkg.operations.forEach(op => {
                logger.info(`          - ${op}`);
            });
        }
        logger.info('');
    });

    // Dependency updates
    if (report.dependencyUpdates.length > 0) {
        logger.info('🔗 INTER-PROJECT DEPENDENCY UPDATES:');
        report.dependencyUpdates.forEach(update => {
            logger.info(`   ${update.package}`);
            logger.info(`      ${update.dependency}: ${update.from} → ${update.to}`);
        });
        logger.info('');
    }

    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('                END TREE DRY RUN REPORT                     ');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');
    logger.info('ℹ️  This was a dry run. No actual changes were made.');
    logger.info('   To execute these operations, run without --dry-run flag.');
    logger.info('');
}

/**
 * Create a dry-run report for a single package publish
 */
export function createDryRunReport(
    currentVersion: string,
    proposedVersion: string,
    packageName: string,
    operations: DryRunReport['operations'],
    targetBranch?: string,
    sourceBranch?: string
): DryRunReport {
    return {
        operations,
        versionChanges: {
            current: currentVersion,
            proposed: proposedVersion
        },
        tags: [`v${proposedVersion}`],
        npmPublish: {
            package: packageName,
            version: proposedVersion,
            files: [] // Would be populated by analyzing package.json files field
        },
        prDetails: targetBranch && sourceBranch ? {
            title: `Release ${proposedVersion}`,
            targetBranch,
            sourceBranch
        } : undefined
    };
}
