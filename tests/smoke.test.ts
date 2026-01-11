import { describe, it, expect } from 'vitest';

describe('commands-publish smoke', () => {
    it('loads release', async () => { const m = await import('../src/commands/release'); expect(m.execute).toBeDefined(); });
    it('loads publish', async () => { const m = await import('../src/commands/publish'); expect(m.execute).toBeDefined(); });
    it('loads development', async () => { const m = await import('../src/commands/development'); expect(m.execute).toBeDefined(); });
    it('loads index', async () => { const m = await import('../src/index'); expect(m.release).toBeDefined(); });
    it('release export', async () => { const m = await import('../src/index'); expect(typeof m.release).toBe('function'); });
    it('publish export', async () => { const m = await import('../src/index'); expect(typeof m.publish).toBe('function'); });
    it('development export', async () => { const m = await import('../src/index'); expect(typeof m.development).toBe('function'); });
    it('release module size', async () => { const m = await import('../src/commands/release'); expect(Object.keys(m).length).toBeGreaterThan(0); });
    it('publish module size', async () => { const m = await import('../src/commands/publish'); expect(Object.keys(m).length).toBeGreaterThan(0); });
    it('development module size', async () => { const m = await import('../src/commands/development'); expect(Object.keys(m).length).toBeGreaterThan(0); });
    it('index exports count', async () => { const m = await import('../src/index'); expect(Object.keys(m).length).toBeGreaterThanOrEqual(3); });
});

