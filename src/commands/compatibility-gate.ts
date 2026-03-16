import { Config, getDryRunLogger } from '@grunnverk/core';
import { execute as runCheckDevelopment } from './check-development';

export type CompatibilityProfile = 'quick' | 'strict';

export interface CompatibilityGateIssue {
    code: string;
    message: string;
    remediation?: string[];
}

export interface CompatibilityGateResult {
    ready: boolean;
    profile: CompatibilityProfile;
    classification: 'ok' | 'blocked' | 'warning' | 'bypassed';
    blockers: CompatibilityGateIssue[];
    warnings: CompatibilityGateIssue[];
    summary: string;
}

const SECTION_TO_CODE: Record<string, string> = {
    'Gitignore Issues': 'GITIGNORE_POLICY',
    'Branch Issues': 'BRANCH_STATE',
    'Remote Sync Issues': 'REMOTE_BEHIND',
    'Merge Conflict Issues': 'MERGE_CONFLICT_RISK',
    'Dev Version Issues': 'NON_DEV_VERSION',
    'Open PR Issues': 'OPEN_PULL_REQUEST',
    'Release Workflow Issues': 'RELEASE_WORKFLOW',
};

const isCiEnvironment = (): boolean => process.env.CI === 'true' || process.env.CI === '1';

const parseBullets = (lines: string[]): string[] =>
    lines
        .map(line => line.trim())
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2).trim())
        .filter(Boolean);

const parseCompatibilitySummary = (summary: string): Omit<CompatibilityGateResult, 'profile' | 'classification'> => {
    const lines = summary.split('\n');
    const blockers: CompatibilityGateIssue[] = [];
    const warnings: CompatibilityGateIssue[] = [];
    const ready = summary.includes('Status: READY FOR DEVELOPMENT');

    for (let i = 0; i < lines.length; i++) {
        const sectionMatch = lines[i].match(/^❌\s+(.+):\s*$/);
        if (sectionMatch) {
            const sectionName = sectionMatch[1];
            const details: string[] = [];
            let j = i + 1;
            while (j < lines.length && !lines[j].startsWith('❌ ') && !lines[j].startsWith('⚠️ ') && !lines[j].startsWith('====')) {
                details.push(lines[j]);
                j++;
            }
            const bullets = parseBullets(details);
            for (const bullet of bullets) {
                blockers.push({
                    code: SECTION_TO_CODE[sectionName] || 'COMPATIBILITY_BLOCKER',
                    message: bullet,
                });
            }
            i = j - 1;
            continue;
        }

        if (lines[i].startsWith('⚠️  Recommendations:')) {
            const details: string[] = [];
            let j = i + 1;
            while (j < lines.length && !lines[j].startsWith('====')) {
                details.push(lines[j]);
                j++;
            }
            const bullets = parseBullets(details);
            for (const bullet of bullets) {
                warnings.push({
                    code: 'COMPATIBILITY_RECOMMENDATION',
                    message: bullet,
                });
            }
            break;
        }
    }

    return {
        ready,
        blockers,
        warnings,
        summary,
    };
};

export async function runCompatibilityGate(
    runConfig: Config,
    options?: { profile?: CompatibilityProfile; directory?: string }
): Promise<CompatibilityGateResult> {
    const profile: CompatibilityProfile =
        options?.profile ||
        ((runConfig.publish as any)?.compatibilityProfile as CompatibilityProfile) ||
        (runConfig as any).compatibility?.profile ||
        'quick';

    const gateConfig: Config = {
        ...runConfig,
        ...(options?.directory ? { directory: options.directory } : {}),
        // Strict profile enables the deeper release-oriented checks.
        ...(profile === 'strict' ? { validateReleaseWorkflow: true } : { validateReleaseWorkflow: false }),
    } as Config;

    const summary = await runCheckDevelopment(gateConfig);
    const parsed = parseCompatibilitySummary(summary);
    const classification: CompatibilityGateResult['classification'] =
        parsed.ready ? (parsed.warnings.length > 0 ? 'warning' : 'ok') : 'blocked';

    return {
        ...parsed,
        profile,
        classification,
    };
}

export async function enforceCompatibilityGateOrThrow(
    runConfig: Config,
    options?: { operation?: 'publish' | 'tree-publish'; profile?: CompatibilityProfile; directory?: string }
): Promise<CompatibilityGateResult> {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const operation = options?.operation || 'publish';
    const result = await runCompatibilityGate(runConfig, options);
    const bypassRequested = !!(runConfig.publish as any)?.allowPrecheckBypass;
    const bypassReason = (((runConfig.publish as any)?.bypassReason || '') as string).trim();
    const bypassAllowedInCi = !!(runConfig.publish as any)?.allowPrecheckBypassInCi;
    const enforcement = ((runConfig.publish as any)?.precheckEnforcement || 'enforce') as 'warn' | 'enforce';

    if (!result.ready) {
        logger.error(
            `COMPATIBILITY_BLOCKED: Compatibility gate failed | Operation: ${operation} | Profile: ${result.profile} | Blocker Count: ${result.blockers.length}`
        );
        for (const blocker of result.blockers) {
            logger.error(`COMPATIBILITY_BLOCKER: ${blocker.code} | ${blocker.message}`);
        }

        if (bypassRequested) {
            if (isCiEnvironment() && !bypassAllowedInCi) {
                throw new Error(
                    'Compatibility gate bypass is disabled in CI. Set publish.allowPrecheckBypassInCi=true only for emergency use.'
                );
            }
            if (!bypassReason) {
                throw new Error(
                    'Compatibility gate bypass requires a reason. Re-run with --bypass-reason "<why this emergency bypass is required>".'
                );
            }

            logger.warn(
                `COMPATIBILITY_BYPASS_ACTIVE: Emergency bypass enabled | Operation: ${operation} | Reason: ${bypassReason}`
            );

            return {
                ...result,
                classification: 'bypassed',
                warnings: [
                    ...result.warnings,
                    {
                        code: 'COMPATIBILITY_BYPASS_ACTIVE',
                        message: `Emergency bypass accepted for ${operation}. Reason: ${bypassReason}`,
                    },
                ],
            };
        }

        if (enforcement === 'warn') {
            logger.warn(
                `COMPATIBILITY_WARN_ONLY: Gate failed but enforcement is warn-only | Operation: ${operation}`
            );
            return {
                ...result,
                classification: 'warning',
            };
        }

        throw new Error(
            `Compatibility gate blocked ${operation}. Resolve blockers or use emergency bypass with --allow-precheck-bypass --bypass-reason "<reason>".`
        );
    }

    logger.info(
        `COMPATIBILITY_OK: Compatibility gate passed | Operation: ${operation} | Profile: ${result.profile}`
    );

    return result;
}
