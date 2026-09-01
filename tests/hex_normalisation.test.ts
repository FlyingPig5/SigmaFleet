import { describe, it, expect } from 'vitest';
import { cleanHex32 } from '../src/lib/blockchain/fleet';
import { normalizeRootHex } from '../src/lib/crypto/merkle';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';

/**
 * A commitment must survive normalisation untouched.
 *
 * These helpers exist to strip Ergo's serialisation prefix off a register read back from a
 * node. They used to strip unconditionally, so a raw 32-byte root that merely BEGAN with one
 * of those byte patterns was truncated and zero-padded into a different, still well-formed
 * commitment — putting the wrong root on chain about once in 39,000 values. The player could
 * then neither prove a shot nor claim a win, and forfeited their own stake.
 */
describe('hex normalisation preserves raw 32-byte commitments', () => {
  const prefixes = ['0e20', '1a02', '1302', '1102', '1a0220'];

  it('leaves a raw 32-byte value alone even when it starts with a prefix pattern', () => {
    for (const prefix of prefixes) {
      // Build a genuine 32-byte value whose leading bytes look like a type prefix.
      const raw = (prefix + bytesToHex(randomBytes(32))).slice(0, 64);
      expect(raw).toHaveLength(64);
      expect(cleanHex32(raw)).toBe(raw);
      expect(normalizeRootHex(raw)).toBe(raw);
    }
  });

  it('still strips a real serialised Coll[Byte] prefix', () => {
    const raw = bytesToHex(randomBytes(32));
    expect(cleanHex32('0e20' + raw)).toBe(raw);
    expect(normalizeRootHex('0e20' + raw)).toBe(raw);
  });

  it('round-trips random commitments unchanged', () => {
    for (let i = 0; i < 20000; i++) {
      const raw = bytesToHex(randomBytes(32));
      expect(cleanHex32(raw)).toBe(raw);
      expect(normalizeRootHex(raw)).toBe(raw);
    }
  });
});
