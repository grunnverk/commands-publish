import { describe, it, expect } from 'vitest';
import * as commands from '../src/index';

describe('commands-publish exports', () => {
    it('should export release', () => {
        expect(commands.release).toBeDefined();
        expect(typeof commands.release).toBe('function');
    });

    it('should export publish', () => {
        expect(commands.publish).toBeDefined();
        expect(typeof commands.publish).toBe('function');
    });

    it('should export development', () => {
        expect(commands.development).toBeDefined();
        expect(typeof commands.development).toBe('function');
    });
});
