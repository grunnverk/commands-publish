import { describe, it, expect } from 'vitest';

describe('command imports and basic validation', () => {
    it('should import release command', async () => {
        const module = await import('../../src/index');
        expect(module.release).toBeDefined();
        expect(typeof module.release).toBe('function');
    });

    it('should import publish command', async () => {
        const module = await import('../../src/index');
        expect(module.publish).toBeDefined();
        expect(typeof module.publish).toBe('function');
    });

    it('should import development command', async () => {
        const module = await import('../../src/index');
        expect(module.development).toBeDefined();
        expect(typeof module.development).toBe('function');
    });
});

