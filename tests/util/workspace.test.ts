import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }));

vi.mock('@grunnverk/git-tools', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@grunnverk/git-tools')>();
    return {
        ...actual,
        run: runMock
    };
});

import { hasNpmWorkspaces, writeVersionWithWorkspaceSupport } from '../../src/utils/workspace';

describe('hasNpmWorkspaces', () => {
    it('returns false when workspaces is missing', () => {
        expect(hasNpmWorkspaces({ name: 'x' })).toBe(false);
    });

    it('returns false for empty workspaces array', () => {
        expect(hasNpmWorkspaces({ workspaces: [] })).toBe(false);
    });

    it('returns true for non-empty workspaces array', () => {
        expect(hasNpmWorkspaces({ workspaces: ['packages/*'] })).toBe(true);
    });

    it('returns true for workspaces.packages array', () => {
        expect(hasNpmWorkspaces({ workspaces: { packages: ['packages/*'] } })).toBe(true);
    });

    it('returns false for workspaces object with empty packages', () => {
        expect(hasNpmWorkspaces({ workspaces: { packages: [] } })).toBe(false);
    });
});

describe('writeVersionWithWorkspaceSupport', () => {
    beforeEach(() => {
        runMock.mockClear();
        runMock.mockResolvedValue({ stdout: '', stderr: '' });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('writes root package.json and returns package.json when no workspaces', async () => {
        const storage = {
            readFile: vi.fn().mockResolvedValue(JSON.stringify({ name: 'r', version: '1.0.0' })),
            writeFile: vi.fn().mockResolvedValue(undefined),
            exists: vi.fn().mockResolvedValue(false)
        };
        const logger = {
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            verbose: vi.fn(),
            debug: vi.fn()
        };

        const paths = await writeVersionWithWorkspaceSupport('2.0.0', storage as any, logger as any, {
            stagingHint: 'development-bump'
        });

        expect(paths).toBe('package.json');
        expect(storage.writeFile).toHaveBeenCalledWith(
            'package.json',
            expect.stringContaining('"version": "2.0.0"'),
            'utf-8'
        );
    });

    it('writes root package.json directly and returns workspace staging paths', async () => {
        const storage = {
            readFile: vi.fn().mockResolvedValue(
                JSON.stringify({ name: 'r', version: '1.0.0', workspaces: ['packages/*'] })
            ),
            writeFile: vi.fn().mockResolvedValue(undefined),
            exists: vi.fn().mockResolvedValue(false)
        };
        const logger = {
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            verbose: vi.fn(),
            debug: vi.fn()
        };

        const paths = await writeVersionWithWorkspaceSupport('1.1.0', storage as any, logger as any, {
            stagingHint: 'publish-bump',
            lockfilePolicy: 'ignore'
        });

        expect(paths).toBe('package.json packages/*/package.json');
        expect(storage.writeFile).toHaveBeenCalledWith(
            'package.json',
            expect.stringContaining('"version": "1.1.0"'),
            'utf-8'
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Workspace monorepo detected')
        );
    });
});
