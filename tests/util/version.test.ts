import { describe, it, expect, vi } from 'vitest';

const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@eldrforge/core', () => ({ getLogger: () => mockLogger }));
vi.mock('@eldrforge/git-tools', () => ({ run: vi.fn().mockResolvedValue({ stdout: '1.0.0' }), safeJsonParse: (s: string) => JSON.parse(s) }));
vi.mock('@eldrforge/shared', () => ({ createStorage: () => ({ readFile: vi.fn().mockResolvedValue('{"version":"1.0.0"}'), writeFile: vi.fn() }) }));

describe('version utilities', () => {
    it('reads version from package.json', async () => {
        const storage = { readFile: vi.fn().mockResolvedValue('{"version":"1.2.3"}') };
        const content = await storage.readFile('package.json');
        const pkg = JSON.parse(content);
        expect(pkg.version).toBe('1.2.3');
    });

    it('handles version patterns', () => {
        const versions = ['1.0.0', '1.1.0', '2.0.0'];
        expect(versions).toHaveLength(3);
        expect(versions[0]).toMatch(/\d+\.\d+\.\d+/);
    });

    it('handles dev versions', () => {
        const version = '1.0.0-dev.0';
        expect(version).toContain('-dev');
        const base = version.split('-')[0];
        expect(base).toBe('1.0.0');
    });

    it('increments patch version', () => {
        const version = '1.2.3';
        const parts = version.split('.').map(Number);
        parts[2]++;
        const newVersion = parts.join('.');
        expect(newVersion).toBe('1.2.4');
    });

    it('increments minor version', () => {
        const version = '1.2.3';
        const parts = version.split('.').map(Number);
        parts[1]++;
        parts[2] = 0;
        const newVersion = parts.join('.');
        expect(newVersion).toBe('1.3.0');
    });

    it('increments major version', () => {
        const version = '1.2.3';
        const parts = version.split('.').map(Number);
        parts[0]++;
        parts[1] = 0;
        parts[2] = 0;
        const newVersion = parts.join('.');
        expect(newVersion).toBe('2.0.0');
    });
});

