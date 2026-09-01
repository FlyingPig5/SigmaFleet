import { describe, it, expect } from 'vitest';
import { LOBBY_SCRIPT, BATTLESHIPS_SCRIPT } from '../src/lib/blockchain/fleet';
import { LOBBY_SCRIPT_REFERENCE } from '../src/contracts/lobby';
import { BATTLESHIPS_SCRIPT_REFERENCE } from '../src/contracts/sigma_fleet';

/**
 * The files in src/contracts are readable copies of the contracts, kept for review. Nothing
 * compiles them, so an edit there is silently inert — and worse, a change to the live script
 * in fleet.ts would leave the reference quietly describing a contract that no longer exists.
 *
 * These tests make that drift loud instead of silent.
 */
describe('contract reference copies match the deployed source', () => {
  it('lobby.ts matches LOBBY_SCRIPT', () => {
    expect(LOBBY_SCRIPT_REFERENCE).toBe(LOBBY_SCRIPT);
  });

  it('sigma_fleet.ts matches BATTLESHIPS_SCRIPT', () => {
    expect(BATTLESHIPS_SCRIPT_REFERENCE).toBe(BATTLESHIPS_SCRIPT);
  });
});
