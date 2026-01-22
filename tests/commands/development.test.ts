import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@grunnverk/core';

// Mock dependencies
vi.mock('@grunnverk/core', () => ({
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
    KODRDRIV_DEFAULTS: {
        development: { semver: 'patch' },
        branches: {}
    },
    incrementPatchVersion: vi.fn((v: string) => {
        const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
        if (match) {
            return `${match[1]}.${match[2]}.${parseInt(match[3]) + 1}`;
        }
        return v;
    }),
    incrementMinorVersion: vi.fn(),
    incrementMajorVersion: vi.fn(),
    findDevelopmentBranch: vi.fn(() => 'working'),
}));

vi.mock('@grunnverk/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '' })),
    runSecure: vi.fn(() => ({ stdout: '' })),
    runWithDryRunSupport: vi.fn(() => ({ stdout: '' })),
    runGitWithLock: vi.fn((cwd, fn) => fn()),
    localBranchExists: vi.fn(() => false),
    getCurrentBranch: vi.fn(() => 'working'),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

vi.mock('@grunnverk/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
        fileExists: vi.fn(() => true),
        exists: vi.fn(() => true),
    })),
    ValidationError: class ValidationError extends Error {},
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('development command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/development');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
    });

    it('handles targetVersion parameter', async () => {
        const { execute } = await import('../../src/commands/development');
        const result = await execute(createConfig({
            dryRun: true,
            development: { targetVersion: 'minor' }
        }));
        expect(result).toBeDefined();
    });

    it('handles noMilestones flag', async () => {
        const { execute } = await import('../../src/commands/development');
        const result = await execute(createConfig({
            dryRun: true,
            development: { noMilestones: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles tagWorkingBranch flag', async () => {
        const { execute } = await import('../../src/commands/development');
        const result = await execute(createConfig({
            dryRun: true,
            development: { tagWorkingBranch: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/development');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });

    it.skip('uses target branch version for increment after publish', async () => {
        // This test verifies the critical fix: after publishing v0.0.15,
        // the development command should bump to 0.0.16-dev.0, not 0.0.15-dev.0
        const { run } = await import('@grunnverk/git-tools');
        const { createStorage } = await import('@grunnverk/shared');

        // Mock git show to return version from main branch (simulating post-publish state)
        vi.mocked(run).mockImplementation(async (cmd: string) => {
            if (cmd.includes('git show main:package.json')) {
                return { stdout: '{"name": "@test/pkg", "version": "0.0.15"}', stderr: '' };
            }
            if (cmd.includes('git status --porcelain')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });

        // Mock working branch package.json (might have old dev version)
        const mockStorage = {
            readFile: vi.fn(() => '{"name": "@test/pkg", "version": "0.0.14-dev.0"}'),
            writeFile: vi.fn(),
            ensureDirectory: vi.fn(),
            fileExists: vi.fn(() => true),
            exists: vi.fn(() => true),
        };
        vi.mocked(createStorage).mockReturnValue(mockStorage as any);

        const { execute } = await import('../../src/commands/development');
        await execute(createConfig({
            dryRun: false,
            branches: {
                working: { targetBranch: 'main', version: { type: 'prerelease', tag: 'dev', incrementLevel: 'patch' } }
            }
        }));

        // Verify that writeFile was called with the CORRECT version (0.0.16-dev.0)
        // not the incorrect version (0.0.15-dev.0)
        expect(mockStorage.writeFile).toHaveBeenCalled();
        const writtenContent = mockStorage.writeFile.mock.calls[0][1];
        const writtenPkg = JSON.parse(writtenContent);
        expect(writtenPkg.version).toBe('0.0.16-dev.0');
    });
});
