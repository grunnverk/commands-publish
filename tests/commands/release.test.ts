import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@eldrforge/core';

// Mock ALL dependencies BEFORE importing
vi.mock('@riotprompt/riotprompt', () => ({
    Formatter: { create: vi.fn(() => ({ formatPrompt: vi.fn(() => ({ messages: [] })) })) },
    Model: {}
}));

vi.mock('dotenv/config', () => ({}));

vi.mock('@eldrforge/git-tools', () => ({
    getDefaultFromRef: vi.fn(() => 'v1.0.0'),
    getCurrentBranch: vi.fn(() => 'main'),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
}));

vi.mock('@eldrforge/core', () => ({
    Config: {},
    Log: { create: vi.fn(() => ({ get: vi.fn(() => 'log content') })) },
    Diff: { create: vi.fn(() => ({ get: vi.fn(() => 'diff content') })) },
    DEFAULT_EXCLUDED_PATTERNS: ['node_modules'],
    DEFAULT_TO_COMMIT_ALIAS: 'HEAD',
    DEFAULT_OUTPUT_DIRECTORY: 'output',
    DEFAULT_MAX_DIFF_BYTES: 500000,
    improveContentWithLLM: vi.fn(),
    toAIConfig: vi.fn(() => ({ model: 'gpt-4o', commands: {} })),
    createStorageAdapter: vi.fn(() => ({})),
    createLoggerAdapter: vi.fn(() => ({})),
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getOutputPath: vi.fn((dir, file) => `${dir}/${file}`),
    getTimestampedRequestFilename: vi.fn(() => 'request.json'),
    getTimestampedResponseFilename: vi.fn(() => 'response.json'),
    getTimestampedReleaseNotesFilename: vi.fn(() => 'release-notes.md'),
    validateReleaseSummary: vi.fn((r) => r),
    ReleaseSummary: {},
    filterContent: vi.fn((content) => ({ filtered: content, removed: [] })),
}));

vi.mock('@eldrforge/ai-service', () => ({
    createCompletionWithRetry: vi.fn(() => ({ content: '{}' })),
    getUserChoice: vi.fn(() => 'c'),
    editContentInEditor: vi.fn((content) => ({ content })),
    getLLMFeedbackInEditor: vi.fn(() => 'feedback'),
    requireTTY: vi.fn(),
    STANDARD_CHOICES: { CONFIRM: { key: 'c' }, EDIT: { key: 'e' }, SKIP: { key: 's' }, IMPROVE: { key: 'i' } },
    ReleaseContext: {},
    runAgenticRelease: vi.fn(() => ({
        releaseNotes: { title: 'v1.1.0 Release', body: 'Changes in this release' },
        iterations: 1,
        toolCallsExecuted: 2,
        toolMetrics: [],
        conversationHistory: []
    })),
    generateReflectionReport: vi.fn(() => 'reflection report'),
    createReleasePrompt: vi.fn(() => ({ prompt: {}, messages: [] })),
}));

vi.mock('@eldrforge/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

vi.mock('@eldrforge/github-tools', () => ({
    getMilestoneIssuesForRelease: vi.fn(() => ''),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('release command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
        expect(result.title).toBeDefined();
        expect(result.body).toBeDefined();
    });

    it('handles from ref config', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { from: 'v0.9.0' }
        }));
        expect(result).toBeDefined();
    });

    it('handles to ref config', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { to: 'develop' }
        }));
        expect(result).toBeDefined();
    });

    it('handles fromMain flag', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { fromMain: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles focus parameter', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { focus: 'security improvements' }
        }));
        expect(result).toBeDefined();
    });

    it('handles context files', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { contextFiles: ['CHANGELOG.md'] }
        }));
        expect(result).toBeDefined();
    });

    it('handles context parameter', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { context: 'Major refactoring release' }
        }));
        expect(result).toBeDefined();
    });

    it('handles selfReflection mode', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { selfReflection: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles noMilestones flag', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { noMilestones: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles custom output directory', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            outputDirectory: '/tmp/release'
        }));
        expect(result).toBeDefined();
    });

    it('handles excluded patterns', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            excludedPatterns: ['*.log']
        }));
        expect(result).toBeDefined();
    });

    it('handles max diff bytes', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { maxDiffBytes: 1000000 }
        }));
        expect(result).toBeDefined();
    });

    it('handles message limit', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { messageLimit: 100 }
        }));
        expect(result).toBeDefined();
    });

    it('handles maxAgenticIterations', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { maxAgenticIterations: 50 }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });

    it('handles stopContext filtering', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            stopContext: { enabled: true, strings: ['INTERNAL'] }
        }));
        expect(result).toBeDefined();
    });

    it('handles overrides config', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            overrides: true
        }));
        expect(result).toBeDefined();
    });

    it('handles contextDirectories', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            contextDirectories: ['docs']
        }));
        expect(result).toBeDefined();
    });

    it('handles currentBranch override', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            release: { currentBranch: 'release/1.0' }
        }));
        expect(result).toBeDefined();
    });

    it('handles publish targetVersion integration', async () => {
        const { execute } = await import('../../src/commands/release');
        const result = await execute(createConfig({
            dryRun: true,
            publish: { targetVersion: '2.0.0' }
        }));
        expect(result).toBeDefined();
    });
});

