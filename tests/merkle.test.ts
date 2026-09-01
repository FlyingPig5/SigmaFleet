import { describe, it, expect } from 'vitest';
import {
  generateBoardCommitment,
  generateMerkleProof,
  verifyMerkleProof,
  reconstructCommitment,
  verifyFleetIntegrity,
  TOTAL_CELLS,
  PROOF_LENGTH,
} from '../src/lib/crypto/merkle';
import { hexToBytes } from '@noble/hashes/utils.js';

describe('ErgoBattleships Merkle Cryptography Engine', () => {
  // Test board: 3 ships of lengths 5, 3, 2 = 10 HP total
  const sampleGrid = new Array(TOTAL_CELLS).fill(0);
  // Ship 1 (Carrier, length 5): indices 0, 1, 2, 3, 4
  [0, 1, 2, 3, 4].forEach((idx) => (sampleGrid[idx] = 1));
  // Ship 2 (Cruiser, length 3): indices 18, 19, 20
  [18, 19, 20].forEach((idx) => (sampleGrid[idx] = 1));
  // Ship 3 (Destroyer, length 2): indices 45, 53
  [45, 53].forEach((idx) => (sampleGrid[idx] = 1));

  it('generates a valid 32-byte Merkle root and 64 salted leaves', () => {
    const commitment = generateBoardCommitment(sampleGrid);
    expect(commitment.rootHex).toHaveLength(64); // 32 bytes hex
    expect(commitment.rootBytes.length).toBe(32);
    expect(commitment.rawLeaves.length).toBe(64);
    expect(commitment.saltsHex.length).toBe(64);
    expect(commitment.tree.length).toBe(7); // Depth 6 means 7 levels (0 to 6)
    expect(commitment.tree[0].length).toBe(64);
    expect(commitment.tree[6].length).toBe(1);
  });

  it('generates valid Merkle proofs for every cell (0 to 63)', () => {
    const commitment = generateBoardCommitment(sampleGrid);

    for (let idx = 0; idx < TOTAL_CELLS; idx++) {
      const proof = generateMerkleProof(idx, commitment.rawLeaves, commitment.tree);
      expect(proof.proofBytes.length).toBe(PROOF_LENGTH);
      expect(proof.siblings.length).toBe(6);

      const expectedIsShip = sampleGrid[idx] === 1;
      expect(proof.isShip).toBe(expectedIsShip);

      const verification = verifyMerkleProof(
        idx,
        proof.proofBytes,
        commitment.rootBytes
      );
      expect(verification.valid).toBe(true);
      expect(verification.isShip).toBe(expectedIsShip);
    }
  });

  it('rejects tampered leaf content (e.g. claiming a ship is water)', () => {
    const commitment = generateBoardCommitment(sampleGrid);
    const shipIndex = 0; // Ship cell
    const proof = generateMerkleProof(shipIndex, commitment.rawLeaves, commitment.tree);

    // Tamper with byte 0: change 0x01 (ship) to 0x00 (water)
    const tamperedProof = new Uint8Array(proof.proofBytes);
    tamperedProof[0] = 0x00;

    const result = verifyMerkleProof(shipIndex, tamperedProof, commitment.rootBytes);
    expect(result.valid).toBe(false);
  });

  it('rejects tampered sibling hashes', () => {
    const commitment = generateBoardCommitment(sampleGrid);
    const targetIndex = 19;
    const proof = generateMerkleProof(targetIndex, commitment.rawLeaves, commitment.tree);

    // Tamper with sibling 2
    const tamperedProof = new Uint8Array(proof.proofBytes);
    tamperedProof[32 + 2 * 32] ^= 0xff; // flip bits

    const result = verifyMerkleProof(targetIndex, tamperedProof, commitment.rootBytes);
    expect(result.valid).toBe(false);
  });

  it('rejects proof verified against wrong cell index', () => {
    const commitment = generateBoardCommitment(sampleGrid);
    const proofIdx0 = generateMerkleProof(0, commitment.rawLeaves, commitment.tree);

    // Verify proof for index 0 against index 1
    const result = verifyMerkleProof(1, proofIdx0.proofBytes, commitment.rootBytes);
    expect(result.valid).toBe(false);
  });

  it('reconstructs identical commitment and proofs from saved salts', () => {
    const commitmentOriginal = generateBoardCommitment(sampleGrid);
    const reconstructed = reconstructCommitment(sampleGrid, commitmentOriginal.saltsHex);

    expect(reconstructed.rootHex).toBe(commitmentOriginal.rootHex);

    const proof = generateMerkleProof(45, reconstructed.rawLeaves, reconstructed.tree);
    const result = verifyMerkleProof(45, proof.proofBytes, reconstructed.rootBytes);
    expect(result.valid).toBe(true);
    expect(result.isShip).toBe(true);
  });

  it('proves and validates fleet integrity from master seed', () => {
    const commitment = generateBoardCommitment(sampleGrid);
    expect(commitment.masterSeedHex).toHaveLength(64);
    expect(commitment.shipIndices).toHaveLength(10);

    // Valid honest fleet verification
    const isValid = verifyFleetIntegrity(
      commitment.masterSeedHex,
      commitment.shipIndices,
      commitment.rootHex
    );
    expect(isValid).toBe(true);

    // Fraudulent fleet attempt: cheater tries to claim 0 ships / missing ships
    const isFakeValid = verifyFleetIntegrity(
      commitment.masterSeedHex,
      [0, 1, 2], // Only 3 ship indices instead of 10
      commitment.rootHex
    );
    expect(isFakeValid).toBe(false);
  });
});
