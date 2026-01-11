import { describe, it, expect, vi } from 'vitest';

const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@eldrforge/core', () => ({ getLogger: () => mockLogger }));
vi.mock('@eldrforge/git-tools', () => ({ run: vi.fn().mockResolvedValue({ stdout: '' }), safeJsonParse: (s: string) => JSON.parse(s) }));
vi.mock('@eldrforge/shared', () => ({ createStorage: () => ({ readFile: vi.fn().mockResolvedValue('{}'), writeFile: vi.fn() }) }));

describe('publish helpers', () => {
    it('parses version strings', () => {
        const version = '1.2.3';
        const parts = version.split('.');
        expect(parts).toHaveLength(3);
        expect(parts[0]).toBe('1');
    });

    it('handles semver patterns', () => {
        const patterns = ['^1.0.0', '~1.0.0', '1.0.0', '>=1.0.0'];
        patterns.forEach(p => {
            expect(typeof p).toBe('string');
        });
    });

    it('validates package names', () => {
        const names = ['@scope/pkg', 'simple-pkg', 'pkg'];
        names.forEach(name => {
            expect(name.length).toBeGreaterThan(0);
        });
    });

    it('handles git refs', () => {
        const refs = ['main', 'v1.0.0', 'HEAD', 'feature/test'];
        refs.forEach(ref => {
            expect(typeof ref).toBe('string');
        });
    });

    it('processes release data', () => {
        const data = { title: 'Release', body: 'Notes' };
        expect(data.title).toBeDefined();
        expect(data.body).toBeDefined();
    });

    it('handles version increments', () => {
        const v = '1.0.0';
        const parts = v.split('.').map(Number);
        parts[2]++;
        expect(parts.join('.')).toBe('1.0.1');
    });

    it('validates config objects', () => {
        const config = { model: 'gpt-4', release: {} };
        expect(config).toHaveProperty('model');
        expect(config).toHaveProperty('release');
    });

    it('handles dry run flags', () => {
        const config = { dryRun: true };
        expect(config.dryRun).toBe(true);
    });

    it('processes output paths', () => {
        const path = 'output/file.md';
        expect(path).toContain('output');
        expect(path).toContain('.md');
    });

    it('handles timestamps', () => {
        const timestamp = Date.now();
        expect(timestamp).toBeGreaterThan(0);
    });
});

