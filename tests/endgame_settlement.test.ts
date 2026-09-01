import { describe, it, expect } from 'vitest';
import wasm from 'ergo-lib-wasm-nodejs';
import { ErgoAddress, SColl, SInt, SByte, SGroupElement } from '@fleet-sdk/core';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { serializeBox } from '@fleet-sdk/serializer';
import {
  generateBoardCommitment,
  generateMerkleProof,
  hashBlake2b256,
} from '../src/lib/crypto/merkle';
import {
  buildPlayTurnTx,
  buildClaimWinTx,
  buildClaimTimeoutTx,
  buildBoardAuditPayload,
  getBattleshipsErgoTree,
} from '../src/lib/blockchain/fleet';

const DEV_PK = '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b';
const POT = 20000000n;
const TIMEOUT_BLOCKS = 30;

function createSyntheticStateContext(height: number) {
  const headersJson: any[] = [];
  for (let i = 0; i < 10; i++) {
    headersJson.push({
      extensionId: '00'.repeat(32),
      difficulty: '1',
      votes: '000000',
      timestamp: Date.now() - i * 120000,
      size: 1000,
      stateRoot: '00'.repeat(33),
      height: height - i,
      nBits: 100000,
      version: 2,
      id: (i + 1).toString(16).padStart(64, '0'),
      adProofsRoot: '00'.repeat(32),
      transactionsRoot: '00'.repeat(32),
      extensionHash: '00'.repeat(32),
      parentId: (i + 2).toString(16).padStart(64, '0'),
      powSolutions: {
        pk: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        w: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        n: '0000000000000000',
        d: 0,
      },
    });
  }
  const blockHeaders = wasm.BlockHeaders.from_json(headersJson);
  return new wasm.ErgoStateContext(
    wasm.PreHeader.from_block_header(blockHeaders.get(0)),
    blockHeaders,
    wasm.Parameters.default_parameters()
  );
}

const stringifySafe = (o: any) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

function reduceAndSign(unsignedTx: any, inputBoxes: any[], secretKey: any, height: number): any {
  const wasmUnsignedTx = wasm.UnsignedTransaction.from_json(
    stringifySafe(unsignedTx.toPlainObject ? unsignedTx.toPlainObject() : unsignedTx)
  );
  const wasmBoxes = wasm.ErgoBoxes.empty();
  for (const b of inputBoxes) wasmBoxes.add(wasm.ErgoBox.from_json(stringifySafe(b)));

  const reducedTx = wasm.ReducedTransaction.from_unsigned_tx(
    wasmUnsignedTx,
    wasmBoxes,
    wasm.ErgoBoxes.empty(),
    createSyntheticStateContext(height)
  );
  const secrets = new wasm.SecretKeys();
  secrets.add(secretKey);
  return wasm.Wallet.from_secrets(secrets).sign_reduced_transaction(reducedTx);
}

function withBoxId(box: any): any {
  box.boxId = bytesToHex(hashBlake2b256(serializeBox(box).toBytes()));
  return box;
}

function createMockUserUtxo(address: string, nanoErg: bigint, height: number): any {
  return withBoxId({
    value: nanoErg.toString(),
    ergoTree: ErgoAddress.fromBase58(address).ergoTree,
    assets: [],
    creationHeight: height,
    additionalRegisters: {},
    transactionId: 'ab'.repeat(32),
    index: 0,
  });
}

/**
 * Builds a battleships box parked at an arbitrary mid-game state, so an endgame
 * transaction can be exercised without replaying thirteen rounds first.
 */
function createGameBox(opts: {
  p1Pk: string;
  p2Pk: string;
  p1Hash: string;
  p2Hash: string;
  p1Root: string;
  p2Root: string;
  phase: number;
  p1Hits: number;
  p2Hits: number;
  pendingTargets: number[];
  p1History: number[];
  p2History: number[];
  timeoutHeight: number;
  height: number;
}): any {
  return withBoxId({
    value: POT.toString(),
    ergoTree: getBattleshipsErgoTree().toHex(),
    assets: [],
    creationHeight: opts.height,
    additionalRegisters: {
      R4: SColl(SGroupElement, [hexToBytes(opts.p1Pk), hexToBytes(opts.p2Pk), hexToBytes(DEV_PK)]).toHex(),
      R5: SColl(SColl(SByte), [
        Array.from(hexToBytes(opts.p1Root)),
        Array.from(hexToBytes(opts.p2Root)),
        Array.from(hexToBytes(opts.p1Hash)),
        Array.from(hexToBytes(opts.p2Hash)),
      ]).toHex(),
      R6: SColl(SInt, [opts.phase, opts.p1Hits, opts.p2Hits]).toHex(),
      R7: SColl(SInt, opts.pendingTargets).toHex(),
      R8: SColl(SColl(SByte), [opts.p1History, opts.p2History]).toHex(),
      R9: SColl(SInt, [opts.timeoutHeight, TIMEOUT_BLOCKS]).toHex(),
    },
    transactionId: 'cd'.repeat(32),
    index: 0,
  });
}

// Carrier 0-4, Cruiser 16-18, Patrol 32-33
function createValidFleetGrid(): number[] {
  const grid = new Array(64).fill(0);
  [0, 1, 2, 3, 4, 16, 17, 18, 32, 33].forEach((c) => (grid[c] = 1));
  return grid;
}

function historyOf(cells: number[]): number[] {
  const h = new Array(64).fill(0);
  cells.forEach((c) => (h[c] = 1));
  return h;
}

describe('Bot endgame settlement transactions', () => {
  const p1Secret = wasm.SecretKey.dlog_from_bytes(hexToBytes('11'.repeat(32)));
  const p1Addr = ErgoAddress.fromBase58(p1Secret.get_address().to_base58(wasm.NetworkPrefix.Mainnet));
  const p1Pk = bytesToHex(p1Addr.getPublicKeys()[0]);

  const p2Secret = wasm.SecretKey.dlog_from_bytes(hexToBytes('22'.repeat(32)));
  const p2Addr = ErgoAddress.fromBase58(p2Secret.get_address().to_base58(wasm.NetworkPrefix.Mainnet));
  const p2Pk = bytesToHex(p2Addr.getPublicKeys()[0]);

  const grid = createValidFleetGrid();
  const com1 = generateBoardCommitment(grid);
  const com2 = generateBoardCommitment(grid, 'ff'.repeat(32));

  const baseBox = {
    p1Pk, p2Pk,
    p1Root: com1.rootHex, p2Root: com2.rootHex,
    p1Hash: com1.boardHashHex, p2Hash: com2.boardHashHex,
  };

  // ---------------------------------------------------------------------------
  // Regression for the Success((false,907)) rejection: a 64-byte grid alone left
  // bytes 64..69 zeroed, so every ship "started" on cell 0 and both the overlap
  // audit and the payload hash failed.
  // ---------------------------------------------------------------------------
  describe('102-byte board audit payload', () => {
    it('recovers ship geometry when only a 64-byte grid is supplied', () => {
      const payload = buildBoardAuditPayload({
        rawBoard: grid,
        saltBytes: hexToBytes(com1.masterSeedHex),
      });

      expect(payload.length).toBe(102);
      // [carrierStart, carrierDir, cruiserStart, cruiserDir, destroyerStart, destroyerDir]
      expect(Array.from(payload.slice(64, 70))).toEqual([0, 0, 16, 0, 32, 0]);
      expect(bytesToHex(hashBlake2b256(payload))).toBe(com1.boardHashHex);
    });

    it('passes a full committed payload through byte for byte', () => {
      const payload = buildBoardAuditPayload({ rawBoard: com1.saltedBoardPayload });
      expect(Array.from(payload)).toEqual(Array.from(com1.saltedBoardPayload));
      expect(bytesToHex(hashBlake2b256(payload))).toBe(com1.boardHashHex);
    });

    it('produces an all-zero geometry for an empty grid, as the old builder did', () => {
      // Guards the assertion above: the zeroed payload the bot used to broadcast
      // really is distinguishable from a valid one.
      const payload = buildBoardAuditPayload({ rawBoard: new Array(64).fill(0) });
      expect(Array.from(payload.slice(64, 70))).toEqual([0, 0, 0, 0, 0, 0]);
      expect(bytesToHex(hashBlake2b256(payload))).not.toBe(com1.boardHashHex);
    });
  });

  // ---------------------------------------------------------------------------
  // A. Claim Win
  // ---------------------------------------------------------------------------
  it('A. P1 claims the win on its own phase with the committed 102-byte payload', () => {
    const height = 1862860;
    // P2 has fired ten cells, five of which are ships; the last five are still
    // pending in R7 and land no hits, so p2Hits == 5 satisfies honestScore.
    const p2Fired = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12];
    const gameBox = createGameBox({
      ...baseBox,
      phase: 0,
      p1Hits: 10,
      p2Hits: 5,
      pendingTargets: [8, 9, 10, 11, 12],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
      timeoutHeight: height + 20,
      height,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, height);

    const tx = buildClaimWinTx({
      winnerAddress: p1Addr.encode(),
      activePlayerAddress: p1Addr.encode(),
      isTie: false,
      gameBox,
      rawBoard: com1.saltedBoardPayload,
      currentHeight: height,
      userUtxos: [utxo],
      isP1Claiming: true,
    });

    const signed = reduceAndSign(tx, [gameBox, utxo], p1Secret, height);
    expect(signed).toBeTruthy();

    const payout = JSON.parse(signed.outputs().get(0).to_json());
    expect(payout.ergoTree).toBe(p1Addr.ergoTree);
    expect(BigInt(payout.value)).toBeGreaterThanOrEqual(POT - POT / 100n);
  });

  // ---------------------------------------------------------------------------
  // B. Confirm defeat: the empty-salvo concede turn
  // ---------------------------------------------------------------------------
  it('B. P1 concedes with an empty salvo when the incoming salvo lands P2 tenth hit', () => {
    const height = 1862860;
    // R7 sinks the cruiser: 3 fresh hits on top of P2's recorded 7 -> exactly 10.
    const pending = [16, 17, 18, 40, 41];
    const p2Fired = [0, 1, 2, 3, 4, 32, 33, ...pending];
    const gameBox = createGameBox({
      ...baseBox,
      phase: 0,
      p1Hits: 4,
      p2Hits: 7,
      pendingTargets: pending,
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
      timeoutHeight: height + 20,
      height,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, height);

    const proofs = pending.map((i) => generateMerkleProof(i, com1.rawLeaves, com1.tree));

    const tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 4,
      currentP2Hits: 7,
      newHitsByPreviousPlayer: 3,
      nextSalvo: [], // contract's p2AlreadyWon branch demands an empty salvo
      proofs,
      currentHeight: height,
      userUtxos: [utxo],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
    });

    const signed = reduceAndSign(tx, [gameBox, utxo], p1Secret, height);
    expect(signed).toBeTruthy();

    // Phase handed to P2 so they can settle, with P2 recorded on 10 hits.
    const nextGame = JSON.parse(signed.outputs().get(0).to_json());
    expect(nextGame.ergoTree).toBe(getBattleshipsErgoTree().toHex());
  });

  it('B2. the same concede turn is rejected if P1 fires a normal salvo instead', () => {
    const height = 1862860;
    const pending = [16, 17, 18, 40, 41];
    const p2Fired = [0, 1, 2, 3, 4, 32, 33, ...pending];
    const gameBox = createGameBox({
      ...baseBox,
      phase: 0,
      p1Hits: 4,
      p2Hits: 7,
      pendingTargets: pending,
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
      timeoutHeight: height + 20,
      height,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, height);
    const proofs = pending.map((i) => generateMerkleProof(i, com1.rawLeaves, com1.tree));

    const tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 4,
      currentP2Hits: 7,
      newHitsByPreviousPlayer: 3,
      nextSalvo: [20, 21, 22, 23, 24],
      proofs,
      currentHeight: height,
      userUtxos: [utxo],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
    });

    expect(() => reduceAndSign(tx, [gameBox, utxo], p1Secret, height)).toThrow(/Script reduced to false/);
  });

  // ---------------------------------------------------------------------------
  // C. Tie-breaker
  // ---------------------------------------------------------------------------
  it('C. P1 settles a 50/50 tie when the revealed board shows P2 also reached 10', () => {
    const height = 1862860;
    // P2 has hit all ten of P1's cells; two of them sit in the pending salvo,
    // so honestScore is (10 - 2) == p2Hits == 8, and opponentTrueHits == 10 ties.
    const pending = [30, 31, 32, 33, 34];
    const p2Fired = [0, 1, 2, 3, 4, 16, 17, 18, ...pending];
    const gameBox = createGameBox({
      ...baseBox,
      phase: 0,
      p1Hits: 10,
      p2Hits: 8,
      pendingTargets: pending,
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
      timeoutHeight: height + 20,
      height,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, height);

    const tx = buildClaimWinTx({
      winnerAddress: p1Addr.encode(),
      activePlayerAddress: p1Addr.encode(),
      isTie: true,
      gameBox,
      rawBoard: com1.saltedBoardPayload,
      currentHeight: height,
      userUtxos: [utxo],
      isP1Claiming: true,
    });

    const signed = reduceAndSign(tx, [gameBox, utxo], p1Secret, height);
    expect(signed).toBeTruthy();

    const tiePayout = (POT - POT / 100n) / 2n;
    const out0 = JSON.parse(signed.outputs().get(0).to_json());
    const out1 = JSON.parse(signed.outputs().get(1).to_json());
    expect(out0.ergoTree).toBe(p1Addr.ergoTree);
    expect(out1.ergoTree).toBe(p2Addr.ergoTree);
    expect(BigInt(out0.value)).toBeGreaterThanOrEqual(tiePayout);
    expect(BigInt(out1.value)).toBeGreaterThanOrEqual(tiePayout);
  });

  it('C2. the tie payout shape is rejected when the opponent did not reach 10', () => {
    const height = 1862860;
    const gameBox = createGameBox({
      ...baseBox,
      phase: 0,
      p1Hits: 10,
      p2Hits: 5,
      pendingTargets: [8, 9, 10, 11, 12],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf([0, 1, 2, 3, 4, 8, 9, 10, 11, 12]),
      timeoutHeight: height + 20,
      height,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, height);

    const tx = buildClaimWinTx({
      winnerAddress: p1Addr.encode(),
      activePlayerAddress: p1Addr.encode(),
      isTie: true, // wrong shape for a clean win
      gameBox,
      rawBoard: com1.saltedBoardPayload,
      currentHeight: height,
      userUtxos: [utxo],
      isP1Claiming: true,
    });

    expect(() => reduceAndSign(tx, [gameBox, utxo], p1Secret, height)).toThrow(/Script reduced to false/);
  });

  // ---------------------------------------------------------------------------
  // D. Claim timeout
  // ---------------------------------------------------------------------------
  it('D. P1 sweeps the pot when P2 abandons its phase', () => {
    const timeoutHeight = 1862890;
    const claimHeight = timeoutHeight + 5;
    // Phase 1 = P2 to move, so the contract pays P1 and demands P1's board.
    // Action 2 allows no pending salvo, so p2Hits must equal P2's true hits (3).
    const p2Fired = [0, 1, 2, 40, 41];
    const gameBox = createGameBox({
      ...baseBox,
      phase: 1,
      p1Hits: 6,
      p2Hits: 3,
      pendingTargets: [5, 6, 7, 13, 14],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf(p2Fired),
      timeoutHeight,
      height: timeoutHeight - TIMEOUT_BLOCKS,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, claimHeight);

    const tx = buildClaimTimeoutTx({
      claimerAddress: p1Addr.encode(),
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoard: com1.saltedBoardPayload,
      currentHeight: claimHeight,
      userUtxos: [utxo],
      isP1Claiming: true,
    });

    const signed = reduceAndSign(tx, [gameBox, utxo], p1Secret, claimHeight);
    expect(signed).toBeTruthy();

    const payout = JSON.parse(signed.outputs().get(0).to_json());
    expect(payout.ergoTree).toBe(p1Addr.ergoTree);
    expect(BigInt(payout.value)).toBeGreaterThanOrEqual(POT - POT / 100n);
  });

  it('D2. the same claim is rejected when the payload carries no ship geometry', () => {
    const timeoutHeight = 1862890;
    const claimHeight = timeoutHeight + 5;
    const gameBox = createGameBox({
      ...baseBox,
      phase: 1,
      p1Hits: 6,
      p2Hits: 3,
      pendingTargets: [5, 6, 7, 13, 14],
      p1History: historyOf([5, 6, 7, 13, 14]),
      p2History: historyOf([0, 1, 2, 40, 41]),
      timeoutHeight,
      height: timeoutHeight - TIMEOUT_BLOCKS,
    });
    const utxo = createMockUserUtxo(p1Addr.encode(), 5000000n, claimHeight);

    // Exactly what the bot used to send: 64-byte grid, no geometry, no salt.
    const tx = buildClaimTimeoutTx({
      claimerAddress: p1Addr.encode(),
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoard: grid,
      saltBytes: undefined,
      currentHeight: claimHeight,
      userUtxos: [utxo],
      isP1Claiming: true,
    });

    expect(() => reduceAndSign(tx, [gameBox, utxo], p1Secret, claimHeight)).toThrow(/Script reduced to false/);
  });
});
