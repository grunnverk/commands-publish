import { describe, it, expect } from 'vitest';

describe('publish modules', () => {
    it('loads release module', async () => {
        const module = await import('../../src/commands/release');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads publish module', async () => {
        const module = await import('../../src/commands/publish');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads development module', async () => {
        const module = await import('../../src/commands/development');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('index exports all commands', async () => {
        const module = await import('../../src/index');
        expect(module.release).toBeDefined();
        expect(module.publish).toBeDefined();
        expect(module.development).toBeDefined();
    });
});

