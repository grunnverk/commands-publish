import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';
import type { Logger } from '@grunnverk/git-tools';
import { safeJsonParse, validatePackageJson } from '@grunnverk/git-tools';

/** Same contract as @grunnverk/shared storage utility used by publish/development. */
export interface VersionWriteStorage {
    readFile: (filePath: string, encoding: string) => Promise<string>;
    writeFile: (filePath: string, data: string, encoding: string) => Promise<void>;
    exists: (filePath: string) => Promise<boolean>;
}

export function hasNpmWorkspaces(pkgJson: Record<string, unknown>): boolean {
    const w = pkgJson.workspaces;
    if (Array.isArray(w) && w.length > 0) {
        return true;
    }
    if (w && typeof w === 'object' && w !== null && Array.isArray((w as { packages?: unknown }).packages)) {
        const pkgs = (w as { packages: unknown[] }).packages;
        return pkgs.length > 0;
    }
    return false;
}

function getWorkspaceGlobs(pkgJson: Record<string, unknown>): string[] {
    const w = pkgJson.workspaces;
    if (Array.isArray(w)) return w as string[];
    if (w && typeof w === 'object' && Array.isArray((w as { packages?: unknown }).packages)) {
        return (w as { packages: string[] }).packages;
    }
    return [];
}

function hasPostVersionBumpScript(pkgJson: Record<string, unknown>): boolean {
    const scripts = pkgJson.scripts;
    if (!scripts || typeof scripts !== 'object' || scripts === null) {
        return false;
    }
    const hook = (scripts as Record<string, unknown>)['kodrdriv:post-version-bump'];
    return typeof hook === 'string' && hook.trim().length > 0;
}

/**
 * Write version to all workspace package.json files directly (no npm version).
 * This avoids npm's dependency resolver which fails when internal deps are stale.
 */
async function cascadeVersionToWorkspaces(
    newVersion: string,
    pkgJson: Record<string, unknown>,
    storage: VersionWriteStorage,
    logger: Logger
): Promise<void> {
    const validated = validatePackageJson(pkgJson, 'package.json') as Record<string, unknown> & { version: string };
    validated.version = newVersion;
    await storage.writeFile('package.json', JSON.stringify(validated, null, 2) + '\n', 'utf-8');

    const workspaceGlobs = getWorkspaceGlobs(pkgJson);
    const cwd = process.cwd();
    let count = 0;

    for (const pattern of workspaceGlobs) {
        const pkgJsonPattern = path.join(cwd, pattern, 'package.json');
        for await (const absPath of fs.glob(pkgJsonPattern)) {
            try {
                const raw = await fs.readFile(absPath, 'utf-8');
                const wsPkg = JSON.parse(raw);
                wsPkg.version = newVersion;
                await fs.writeFile(absPath, JSON.stringify(wsPkg, null, 2) + '\n', 'utf-8');
                count++;
            } catch (e: any) {
                logger.warn(`Could not update ${absPath}: ${e.message}`);
            }
        }
    }
    logger.info(`Version ${newVersion} written to root + ${count} workspace package(s)`);
}

async function resolveStagingPaths(
    hasWorkspaces: boolean,
    stagingHint: 'development-bump' | 'publish-bump',
    lockfilePolicy: 'ignore' | 'commit' | undefined,
    storage: VersionWriteStorage
): Promise<string> {
    const packageLockPath = path.join(process.cwd(), 'package-lock.json');
    const lockExists = await storage.exists(packageLockPath);
    const includeLock =
        lockExists &&
        lockfilePolicy === 'commit' &&
        (stagingHint === 'publish-bump' || (stagingHint === 'development-bump' && hasWorkspaces));

    if (hasWorkspaces) {
        const parts = ['package.json', 'packages/*/package.json'];
        if (includeLock) {
            parts.push('package-lock.json');
        }
        return parts.join(' ');
    }

    if (stagingHint === 'publish-bump' && includeLock) {
        return 'package.json package-lock.json';
    }

    return 'package.json';
}

/**
 * Writes root (and workspace) package versions, optionally runs kodrdriv:post-version-bump,
 * and returns a space-separated list of paths for targeted `git add` (never `git add -A`).
 *
 * For workspace monorepos, writes version directly to each package.json file rather than
 * using `npm version --workspaces` (which triggers dependency resolution and fails when
 * internal dep ranges are stale). The post-version-bump hook handles dep range syncing.
 */
export async function writeVersionWithWorkspaceSupport(
    newVersion: string,
    storage: VersionWriteStorage,
    logger: Logger,
    options: {
        stagingHint: 'development-bump' | 'publish-bump';
        lockfilePolicy?: 'ignore' | 'commit';
    }
): Promise<string> {
    const pkgJsonContents = await storage.readFile('package.json', 'utf-8');
    const pkgJson = safeJsonParse(pkgJsonContents, 'package.json') as Record<string, unknown>;
    const hasWorkspaces = hasNpmWorkspaces(pkgJson);
    const runHook = hasPostVersionBumpScript(pkgJson);

    if (hasWorkspaces) {
        logger.info(`Workspace monorepo detected, cascading version ${newVersion} to all workspaces`);
        await cascadeVersionToWorkspaces(newVersion, pkgJson, storage, logger);
    } else {
        const validated = validatePackageJson(pkgJson, 'package.json') as Record<string, unknown> & { version: string };
        validated.version = newVersion;
        await storage.writeFile('package.json', JSON.stringify(validated, null, 2) + '\n', 'utf-8');
    }

    if (runHook) {
        logger.info('Running kodrdriv:post-version-bump hook');
        execSync('npm run kodrdriv:post-version-bump', {
            cwd: process.cwd(),
            stdio: 'inherit',
            env: { ...process.env, KODRDRIV_VERSION: newVersion }
        });
        logger.info('Post-version-bump hook completed');
    }

    return resolveStagingPaths(hasWorkspaces, options.stagingHint, options.lockfilePolicy, storage);
}
