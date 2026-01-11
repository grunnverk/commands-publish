import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@eldrforge/core';

// Mock dependencies
vi.mock('@eldrforge/core', () => ({
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
    KODRDRIV_DEFAULTS: { development: { semver: 'patch' } },
}));

vi.mock('@eldrforge/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '' })),
    runSecure: vi.fn(() => ({ stdout: '' })),
    runWithDryRunSupport: vi.fn(() => ({ stdout: '' })),
    runGitWithLock: vi.fn((cwd, fn) => fn()),
    localBranchExists: vi.fn(() => false),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

vi.mock('@eldrforge/shared', () => ({
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
});
