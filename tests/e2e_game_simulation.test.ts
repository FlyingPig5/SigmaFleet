import { describe, it, expect } from 'vitest';
import wasm from 'ergo-lib-wasm-nodejs';
import { ErgoAddress, SColl, SInt, SByte, SGroupElement, OutputBuilder, TransactionBuilder, type Box, type Amount } from '@fleet-sdk/core';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { serializeBox } from '@fleet-sdk/serializer';
import {
  generateBoardCommitment,
  generateMerkleProof,
  hashBlake2b256,
} from '../src/lib/crypto/merkle';
import {
  buildCreateLobbyTx,
  buildCancelLobbyTx,
  buildAcceptLobbyTx,
  buildPlayTurnTx,
  buildClaimWinTx,
  buildClaimTimeoutTx,
  getLobbyErgoTree,
  getBattleshipsErgoTree,
  extractGroupElements,
  extractThreeGroupElements,
} from '../src/lib/blockchain/fleet';

function createSyntheticStateContext(height: number) {
  const headersJson: any[] = [];
  for (let i = 0; i < 10; i++) {
    const h = height - i;
    headersJson.push({
      extensionId: '00'.repeat(32),
      difficulty: '1',
      votes: '000000',
      timestamp: Date.now() - i * 120000,
      size: 1000,
      stateRoot: '00'.repeat(33),
      height: h,
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
  const preHeader = wasm.PreHeader.from_block_header(blockHeaders.get(0));
  const params = wasm.Parameters.default_parameters();
  return new wasm.ErgoStateContext(preHeader, blockHeaders, params);
}

function reduceAndSign(
  unsignedTx: any,
  inputBoxes: any[],
  secretKey: any,
  height: number,
  dataBoxes: any[] = []
): any {
  const stateCtx = createSyntheticStateContext(height);
  const stringifySafe = (obj: any) => JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

  const wasmUnsignedTx = wasm.UnsignedTransaction.from_json(stringifySafe(unsignedTx.toPlainObject ? unsignedTx.toPlainObject() : unsignedTx));
  const wasmBoxes = wasm.ErgoBoxes.empty();
  for (const b of inputBoxes) {
    wasmBoxes.add(wasm.ErgoBox.from_json(stringifySafe(b)));
  }

  const wasmDataBoxes = wasm.ErgoBoxes.empty();
  for (const db of dataBoxes) {
    wasmDataBoxes.add(wasm.ErgoBox.from_json(stringifySafe(db)));
  }

  const reducedTx = wasm.ReducedTransaction.from_unsigned_tx(
    wasmUnsignedTx,
    wasmBoxes,
    wasmDataBoxes,
    stateCtx
  );

  const secrets = new wasm.SecretKeys();
  secrets.add(secretKey);
  const wallet = wasm.Wallet.from_secrets(secrets);

  return wallet.sign_reduced_transaction(reducedTx);
}

function signedOutputToBox(signedTx: any, outputIndex: number): any {
  const outputs = signedTx.outputs();
  const outBox = outputs.get(outputIndex);
  const jsonStr = outBox.to_json();
  const parsed = JSON.parse(jsonStr);
  
  return {
    boxId: parsed.boxId,
    value: parsed.value,
    ergoTree: parsed.ergoTree,
    assets: parsed.assets || [],
    creationHeight: parsed.creationHeight,
    additionalRegisters: parsed.additionalRegisters || {},
    transactionId: parsed.transactionId,
    index: parsed.index ?? outputIndex,
  };
}

function createMockUserUtxo(address: string, nanoErg: bigint = 50000000n, height: number = 1862800): any {
  const ergoAddr = ErgoAddress.fromBase58(address);
  const box: any = {
    value: nanoErg.toString(),
    ergoTree: ergoAddr.ergoTree,
    assets: [],
    creationHeight: height,
    additionalRegisters: {},
    transactionId: 'ab'.repeat(32),
    index: 0,
  };
  box.boxId = bytesToHex(hashBlake2b256(serializeBox(box).toBytes()));
  return box;
}

// Generate valid standard fleet (Carrier 5, Cruiser 3, Patrol 2) with placement positions
function createValidFleetGrid(): { grid: number[]; carrier: number[]; cruiser: number[]; patrol: number[] } {
  const grid = new Array(64).fill(0);
  // Carrier 5 at row 0: (0, 1, 2, 3, 4)
  const carrier = [0, 1, 2, 3, 4];
  carrier.forEach((c) => (grid[c] = 1));

  // Cruiser 3 at row 2: (16, 17, 18)
  const cruiser = [16, 17, 18];
  cruiser.forEach((c) => (grid[c] = 1));

  // Patrol 2 at row 4: (32, 33)
  const patrol = [32, 33];
  patrol.forEach((c) => (grid[c] = 1));

  return { grid, carrier, cruiser, patrol };
}

describe('Bulletproof End-to-End Game Lifecycle Simulation', () => {
  const p1Secret = wasm.SecretKey.dlog_from_bytes(hexToBytes('11'.repeat(32)));
  const p1Addr = ErgoAddress.fromBase58(p1Secret.get_address().to_base58(wasm.NetworkPrefix.Mainnet));
  const p1Pk = bytesToHex(p1Addr.getPublicKeys()[0]);

  const p2Secret = wasm.SecretKey.dlog_from_bytes(hexToBytes('22'.repeat(32)));
  const p2Addr = ErgoAddress.fromBase58(p2Secret.get_address().to_base58(wasm.NetworkPrefix.Mainnet));
  const p2Pk = bytesToHex(p2Addr.getPublicKeys()[0]);

  const DEFAULT_DEV_PK = '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b';

  it('executes full Lobby lifecycle (Create -> Cancel & Create -> Accept)', async () => {
    let currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);

    // 1. Create Lobby
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });

    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    expect(signedCreate).toBeTruthy();

    const lobbyBox = signedOutputToBox(signedCreate, 0);
    expect(String(lobbyBox.value)).toBe('10000000');

    // 2. Test Cancel Lobby
    const cancelTx = buildCancelLobbyTx({
      p1Address: p1Addr.encode(),
      lobbyBox,
      currentHeight,
      userUtxos: [createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight)],
    });
    const signedCancel = reduceAndSign(cancelTx, [lobbyBox, cancelTx.inputs[1]], p1Secret, currentHeight);
    expect(signedCancel).toBeTruthy();

    // 3. Accept Lobby with Player 2
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);
    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);

    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });

    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    expect(signedAccept).toBeTruthy();

    const gameBox = signedOutputToBox(signedAccept, 0);
    expect(String(gameBox.value)).toBe('20000000'); // 10m + 10m
  });

  it('simulates a complete chained match from Turn 1 to Win Settlement (Action 1)', async () => {
    let currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);

    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    // Initial Lobby Acceptance -> Game Box
    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let currentGameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    let p1Hits = 0;
    let p2Hits = 0;

    // --- TURN 1 (Host / P1 opening salvo: Phase 0 -> Phase 1) ---
    currentHeight += 1;
    const p1ShotsRound1 = [0, 1, 2, 3, 4]; // Targets all 5 cells of P2 Carrier!
    const userUtxoP1_1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);

    const turn1Tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p1ShotsRound1,
      proofs: [],
      currentHeight,
      userUtxos: [userUtxoP1_1],
      p1History,
      p2History,
    });

    const signedTurn1 = reduceAndSign(turn1Tx, [currentGameBox, userUtxoP1_1], p1Secret, currentHeight);
    expect(signedTurn1).toBeTruthy();
    p1ShotsRound1.forEach((c) => (p1History[c] = 1));
    currentGameBox = signedOutputToBox(signedTurn1, 0);

    // --- TURN 2 (Challenger / P2 responds: Defends 5 hits, shoots 5 cells: Phase 1 -> Phase 0) ---
    currentHeight += 1;
    const p2DefendProofs = p1ShotsRound1.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    p1Hits += 5; // P1 lands 5 hits on P2 Carrier!

    const p2ShotsRound1 = [5, 6, 7, 8, 9]; // P2 misses
    const userUtxoP2_1 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);

    const turn2Tx = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox: currentGameBox,
      currentPhase: 1,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 5,
      nextSalvo: p2ShotsRound1,
      proofs: p2DefendProofs,
      currentHeight,
      userUtxos: [userUtxoP2_1],
      p1History,
      p2History,
      sunkShipCode: 3, // Carrier sunk
    });

    const signedTurn2 = reduceAndSign(turn2Tx, [currentGameBox, userUtxoP2_1], p2Secret, currentHeight);
    expect(signedTurn2).toBeTruthy();
    p2ShotsRound1.forEach((c) => (p2History[c] = 1));
    currentGameBox = signedOutputToBox(signedTurn2, 0);

    // --- TURN 3 (Host / P1 shoots Cruiser & Patrol: Phase 0 -> Phase 1) ---
    currentHeight += 1;
    const p1DefendProofsRound2 = p2ShotsRound1.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
    const p1ShotsRound2 = [16, 17, 18, 32, 33]; // P1 hits Cruiser (3) + Patrol (2) = 5 more hits!
    const userUtxoP1_2 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);

    const turn3Tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p1ShotsRound2,
      proofs: p1DefendProofsRound2,
      currentHeight,
      userUtxos: [userUtxoP1_2],
      p1History,
      p2History,
    });

    const signedTurn3 = reduceAndSign(turn3Tx, [currentGameBox, userUtxoP1_2], p1Secret, currentHeight);
    expect(signedTurn3).toBeTruthy();
    p1ShotsRound2.forEach((c) => (p1History[c] = 1));
    currentGameBox = signedOutputToBox(signedTurn3, 0);

    // --- TURN 4 (Challenger / P2 defends: registers 5 hits -> P1 total hits = 10 -> P2 fires 5 shots) ---
    currentHeight += 1;
    const p2DefendProofsRound2 = p1ShotsRound2.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    p1Hits += 5; // P1 reaches 10 total hits!

    const p2ShotsRound2 = [10, 11, 12, 13, 14];
    const userUtxoP2_2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const turn4Tx = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox: currentGameBox,
      currentPhase: 1,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 5,
      nextSalvo: p2ShotsRound2,
      proofs: p2DefendProofsRound2,
      currentHeight,
      userUtxos: [userUtxoP2_2],
      p1History,
      p2History,
    });

    const signedTurn4 = reduceAndSign(turn4Tx, [currentGameBox, userUtxoP2_2], p2Secret, currentHeight);
    expect(signedTurn4).toBeTruthy();
    p2ShotsRound2.forEach((c) => (p2History[c] = 1));
    currentGameBox = signedOutputToBox(signedTurn4, 0);

    // --- WIN SETTLEMENT (Action 1: Host P1 claims pot with honest raw board disclosure of P1's board) ---
    currentHeight += 1;
    const userUtxoClaim = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);

    const claimTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox: currentGameBox,
      rawBoardBytes: fleet1.grid, // Disclose P1's board
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(com1.masterSeedHex)),
      currentHeight,
      userUtxos: [userUtxoClaim],
      isP1Claiming: true,
      p1History,
      p2History,
      p1Hits: 10,
      p2Hits: 0,
    });

    const signedClaim = reduceAndSign(claimTx, [currentGameBox, userUtxoClaim], p1Secret, currentHeight);
    expect(signedClaim).toBeTruthy();

    // Verify payout: Output 0 is P1 win payout (19.8 ERG), Output 1 is Dev fee (0.2 ERG)
    const winPayoutBox = signedOutputToBox(signedClaim, 0);
    const devFeeBox = signedOutputToBox(signedClaim, 1);
    expect(BigInt(winPayoutBox.value)).toBeGreaterThanOrEqual(19800000n);
    expect(BigInt(devFeeBox.value)).toBeGreaterThanOrEqual(200000n);
  });

  it('simulates Timeout Claim (Action 2) after abandonment', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // Host abandons the game at Phase 0 without firing Turn 1.
    // Advance simulated height past timeout (1862860 + 31 = 1862891)
    const timeoutHeight = 1862860 + 30;
    const claimHeight = timeoutHeight + 5;

    const userUtxoTimeout = createMockUserUtxo(p2Addr.encode(), 2000000n, claimHeight);
    const timeoutTx = buildClaimTimeoutTx({
      activePlayerAddress: p2Addr.encode(),
      gameBox,
      rawBoardBytes: fleet2.grid, // P2 discloses P2's board
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(com2.masterSeedHex)),
      currentHeight: claimHeight,
      userUtxos: [userUtxoTimeout],
      isP1Claiming: false, // P2 claims timeout
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
      p1Hits: 0,
      p2Hits: 0,
    });

    const signedTimeout = reduceAndSign(timeoutTx, [gameBox, userUtxoTimeout], p2Secret, claimHeight);
    expect(signedTimeout).toBeTruthy();

    const p2Payout = signedOutputToBox(signedTimeout, 0);
    expect(BigInt(p2Payout.value)).toBeGreaterThanOrEqual(19800000n);
  });

  it('simulates a complete 13-round match covering all 64 cells, with Turn 13 4-shot salvo, and resolves Tie Settlement (Action 1)', async () => {
    let currentHeight = 1862860;
    
    // Position fleet at end of grid (rows 6 and 7) so all 13 rounds are played
    const createEndgameFleet = () => {
      const grid = new Array(64).fill(0);
      [56, 57, 58, 59, 60].forEach((c) => (grid[c] = 1)); // Carrier 5 at row 7
      [48, 49, 50].forEach((c) => (grid[c] = 1));         // Cruiser 3 at row 6
      [62, 63].forEach((c) => (grid[c] = 1));             // Patrol 2 at row 7
      return { grid, carrierCoord: [7, 0] as [number, number], cruiserCoord: [6, 0] as [number, number], patrolCoord: [7, 6] as [number, number] };
    };

    const fleet1 = createEndgameFleet();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createEndgameFleet();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let currentGameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    let p1Hits = 0;
    let p2Hits = 0;

    let p1IncomingSalvo: number[] = [];
    let p2IncomingSalvo: number[] = [];

    // Simulate all 13 rounds (26 turns) covering all 64 cells
    for (let round = 1; round <= 13; round++) {
      currentHeight += 1;
      const startCell = (round - 1) * 5;
      const salvoSize = round === 13 ? 4 : 5;
      const salvoCells = Array.from({ length: salvoSize }, (_, i) => startCell + i);

      // --- P1 TURN (Phase 0) ---
      let p1NewHits = 0;
      let p1Proofs: any[] = [];
      if (p1IncomingSalvo.length > 0) {
        p1IncomingSalvo.forEach((c) => {
          if (fleet1.grid[c] === 1) p1NewHits++;
        });
        p1Proofs = p1IncomingSalvo.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
      }
      p2Hits += p1NewHits;

      const p1UserUtxo = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
      const p1TurnTx = buildPlayTurnTx({
        activePlayerAddress: p1Addr.encode(),
        activePlayerPublicKey: p1Pk,
        gameBox: currentGameBox,
        currentPhase: 0,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: p1NewHits,
        nextSalvo: salvoCells,
        proofs: p1Proofs,
        currentHeight,
        userUtxos: [p1UserUtxo],
        p1History,
        p2History,
      });

      const signedP1Turn = reduceAndSign(p1TurnTx, [currentGameBox, p1UserUtxo], p1Secret, currentHeight);
      expect(signedP1Turn).toBeTruthy();
      salvoCells.forEach((c) => (p1History[c] = 1));
      currentGameBox = signedOutputToBox(signedP1Turn, 0);
      p2IncomingSalvo = salvoCells;

      // --- P2 TURN (Phase 1) ---
      currentHeight += 1;
      let p2NewHits = 0;
      const p2Proofs = p2IncomingSalvo.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
      p2IncomingSalvo.forEach((c) => {
        if (fleet2.grid[c] === 1) p2NewHits++;
      });
      p1Hits += p2NewHits;

      const p2UserUtxo = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
      const p2TurnTx = buildPlayTurnTx({
        activePlayerAddress: p2Addr.encode(),
        activePlayerPublicKey: p2Pk,
        gameBox: currentGameBox,
        currentPhase: 1,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: p2NewHits,
        nextSalvo: salvoCells,
        proofs: p2Proofs,
        currentHeight,
        userUtxos: [p2UserUtxo],
        p1History,
        p2History,
      });

      const signedP2Turn = reduceAndSign(p2TurnTx, [currentGameBox, p2UserUtxo], p2Secret, currentHeight);
      expect(signedP2Turn).toBeTruthy();
      salvoCells.forEach((c) => (p2History[c] = 1));
      currentGameBox = signedOutputToBox(signedP2Turn, 0);
      p1IncomingSalvo = salvoCells;
    }

    // P1 scored 10 hits (all recorded in R6). P2 scored 7 hits recorded in R6 + 3 pending hits in R7 = 10 total hits!
    expect(p1Hits).toBe(10);
    expect(p2Hits).toBe(7);

    // --- TIE SETTLEMENT (Action 1: 50/50 Payout) ---
    currentHeight += 1;
    const userUtxoTie = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);

    const tieTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox: currentGameBox,
      rawBoardBytes: fleet1.grid, // P1 discloses P1's board
      carrierCoord: fleet1.carrierCoord,
      cruiserCoord: fleet1.cruiserCoord,
      patrolCoord: fleet1.patrolCoord,
      saltBytes: Array.from(hexToBytes(com1.masterSeedHex)),
      currentHeight,
      userUtxos: [userUtxoTie],
      isP1Claiming: true,
      isTie: true,
      p1History,
      p2History,
      p1Hits: 10,
      p2Hits: 7,
    });

    const signedTie = reduceAndSign(tieTx, [currentGameBox, userUtxoTie], p1Secret, currentHeight);
    expect(signedTie).toBeTruthy();

    // Verify 3 payout outputs: P1 (9.9 ERG), P2 (9.9 ERG), Dev (0.2 ERG)
    const p1Payout = signedOutputToBox(signedTie, 0);
    const p2Payout = signedOutputToBox(signedTie, 1);
    const devPayout = signedOutputToBox(signedTie, 2);

    expect(BigInt(p1Payout.value)).toBeGreaterThanOrEqual(9900000n);
    expect(BigInt(p2Payout.value)).toBeGreaterThanOrEqual(9900000n);
    expect(BigInt(devPayout.value)).toBeGreaterThanOrEqual(200000n);
  });

  it('simulates Player 2 (Challenger) Victory and Settlement (Action 1)', async () => {
    let currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let currentGameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    let p1Hits = 0;
    let p2Hits = 0;

    // Turn 1 (P1 misses: [5, 6, 7, 8, 9])
    currentHeight += 1;
    const p1Shots1 = [5, 6, 7, 8, 9];
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t1 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p1Shots1,
      proofs: [],
      currentHeight,
      userUtxos: [u1],
      p1History,
      p2History,
    });
    const signedT1 = reduceAndSign(t1, [currentGameBox, u1], p1Secret, currentHeight);
    p1Shots1.forEach((c) => (p1History[c] = 1));
    currentGameBox = signedOutputToBox(signedT1, 0);

    // Turn 2 (P2 hits Carrier 5: [0, 1, 2, 3, 4])
    currentHeight += 1;
    const p2Defend1 = p1Shots1.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    const p2Shots1 = [0, 1, 2, 3, 4];
    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const t2 = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox: currentGameBox,
      currentPhase: 1,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p2Shots1,
      proofs: p2Defend1,
      currentHeight,
      userUtxos: [u2],
      p1History,
      p2History,
    });
    const signedT2 = reduceAndSign(t2, [currentGameBox, u2], p2Secret, currentHeight);
    p2Shots1.forEach((c) => (p2History[c] = 1));
    currentGameBox = signedOutputToBox(signedT2, 0);

    // Turn 3 (P1 defends 5 hits from P2 Carrier salvo, fires misses: [10, 11, 12, 13, 14])
    currentHeight += 1;
    const p1Defend2 = p2Shots1.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
    p2Hits += 5; // P2 scores 5 hits on P1 Carrier!
    const p1Shots2 = [10, 11, 12, 13, 14];
    const u3 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t3 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 5,
      nextSalvo: p1Shots2,
      proofs: p1Defend2,
      currentHeight,
      userUtxos: [u3],
      p1History,
      p2History,
    });
    const signedT3 = reduceAndSign(t3, [currentGameBox, u3], p1Secret, currentHeight);
    p1Shots2.forEach((c) => (p1History[c] = 1));
    currentGameBox = signedOutputToBox(signedT3, 0);

    // Turn 4 (P2 shoots Cruiser 3 + Patrol 2: [16, 17, 18, 32, 33])
    currentHeight += 1;
    const p2Defend2 = p1Shots2.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    const p2Shots2 = [16, 17, 18, 32, 33];
    const u4 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const t4 = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox: currentGameBox,
      currentPhase: 1,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p2Shots2,
      proofs: p2Defend2,
      currentHeight,
      userUtxos: [u4],
      p1History,
      p2History,
    });
    const signedT4 = reduceAndSign(t4, [currentGameBox, u4], p2Secret, currentHeight);
    p2Shots2.forEach((c) => (p2History[c] = 1));
    currentGameBox = signedOutputToBox(signedT4, 0);

    // Turn 5 (P1 defends P2's second salvo: registers 5 hits -> P2 hits = 10 -> Game won by P2!)
    // Since P2 won (p2AlreadyWon = isP1Turn && nextP2Hits == 10), P1 fires 0 shots (empty salvo)!
    currentHeight += 1;
    const p1Defend3 = p2Shots2.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
    p2Hits += 5; // P2 reaches 10 hits!
    const u5 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t5 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: p1Hits,
      currentP2Hits: p2Hits,
      newHitsByPreviousPlayer: 5,
      nextSalvo: [], // Empty salvo allowed by contract because P2 already won!
      proofs: p1Defend3,
      currentHeight,
      userUtxos: [u5],
      p1History,
      p2History,
    });
    const signedT5 = reduceAndSign(t5, [currentGameBox, u5], p1Secret, currentHeight);
    expect(signedT5).toBeTruthy();
    currentGameBox = signedOutputToBox(signedT5, 0);

    // --- P2 SETTLEMENT (Action 1: Challenger P2 claims win with honest P2 board disclosure) ---
    currentHeight += 1;
    const userUtxoP2Claim = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const p2ClaimTx = buildClaimWinTx({
      activePlayerAddress: p2Addr.encode(),
      gameBox: currentGameBox,
      rawBoardBytes: fleet2.grid, // P2 discloses P2's board
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(com2.masterSeedHex)),
      currentHeight,
      userUtxos: [userUtxoP2Claim],
      isP1Claiming: false, // P2 is claiming!
      p1History,
      p2History,
      p1Hits: 0,
      p2Hits: 10,
    });

    const signedP2Claim = reduceAndSign(p2ClaimTx, [currentGameBox, userUtxoP2Claim], p2Secret, currentHeight);
    expect(signedP2Claim).toBeTruthy();

    const p2WinBox = signedOutputToBox(signedP2Claim, 0);
    expect(BigInt(p2WinBox.value)).toBeGreaterThanOrEqual(19800000n);
  });

  it('simulates Timeout Claim by Player 1 when Player 2 abandons at Phase 1 (Action 2)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let currentGameBox = signedOutputToBox(signedAccept, 0);

    // Host fires Turn 1 (Phase 0 -> Phase 1)
    const turn1Height = currentHeight + 1;
    const userUtxoP1 = createMockUserUtxo(p1Addr.encode(), 2000000n, turn1Height);
    const turn1Tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: currentGameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight: turn1Height,
      userUtxos: [userUtxoP1],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });
    const signedTurn1 = reduceAndSign(turn1Tx, [currentGameBox, userUtxoP1], p1Secret, turn1Height);
    currentGameBox = signedOutputToBox(signedTurn1, 0);

    // Game is now at Phase 1 (Challenger's turn). Challenger goes AFK / abandons.
    const timeoutHeight = turn1Height + 30;
    const claimHeight = timeoutHeight + 5;

    const userUtxoClaimTimeout = createMockUserUtxo(p1Addr.encode(), 2000000n, claimHeight);
    const timeoutTx = buildClaimTimeoutTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox: currentGameBox,
      rawBoardBytes: fleet1.grid, // P1 discloses P1's board
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(com1.masterSeedHex)),
      currentHeight: claimHeight,
      userUtxos: [userUtxoClaimTimeout],
      isP1Claiming: true, // P1 claims timeout
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
      p1Hits: 0,
      p2Hits: 0,
    });

    const signedTimeout = reduceAndSign(timeoutTx, [currentGameBox, userUtxoClaimTimeout], p1Secret, claimHeight);
    expect(signedTimeout).toBeTruthy();

    const p1Payout = signedOutputToBox(signedTimeout, 0);
    expect(BigInt(p1Payout.value)).toBeGreaterThanOrEqual(19800000n);
  });

  it('rejects Cheating attempt with mismatched board hash on Action 1', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // Attacker tries to submit a fake salt or modified board to claim
    const fakeSalt = '00'.repeat(32);
    const userUtxoCheat = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight + 1);

    const cheatTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoardBytes: fleet1.grid,
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(fakeSalt)), // Fake salt!
      currentHeight: currentHeight + 1,
      userUtxos: [userUtxoCheat],
      isP1Claiming: true,
      p1Hits: 10,
      p2Hits: 0,
    });

    expect(() => {
      reduceAndSign(cheatTx, [gameBox, userUtxoCheat], p1Secret, currentHeight + 1);
    }).toThrow(/Script reduced to false/);
  });

  it('rejects duplicate shot coordinates in salvo on Action 0', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // Duplicate coordinates in salvo: [1, 1, 2, 3, 4]
    const userUtxoDup = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight + 1);
    const dupTx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [1, 1, 2, 3, 4], // Duplicate!
      proofs: [],
      currentHeight: currentHeight + 1,
      userUtxos: [userUtxoDup],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(dupTx, [gameBox, userUtxoDup], p1Secret, currentHeight + 1);
    }).toThrow(/Script reduced to false/);
  });

  it('1. rejects Play Turn with tampered Merkle Proof (Action 0)', async () => {
    let currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    // Turn 1 (P1 fires [0, 1, 2, 3, 4])
    currentHeight += 1;
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t1 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight,
      userUtxos: [u1],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });
    const signedT1 = reduceAndSign(t1, [gameBox, u1], p1Secret, currentHeight);
    gameBox = signedOutputToBox(signedT1, 0);

    // Turn 2: P2 attempts to defend with tampered Merkle proof
    currentHeight += 1;
    const legitProofs = [0, 1, 2, 3, 4].map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    // Tamper one proof by mutating the hit state byte
    const tamperedProofBytes = new Uint8Array(legitProofs[0].proofBytes);
    tamperedProofBytes[0] = tamperedProofBytes[0] === 1 ? 0 : 1;
    const tamperedProof = {
      ...legitProofs[0],
      proofBytes: tamperedProofBytes,
      proofHex: bytesToHex(tamperedProofBytes),
    };
    const tamperedProofs = [tamperedProof, legitProofs[1], legitProofs[2], legitProofs[3], legitProofs[4]];

    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const tamperedTurnTx = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox,
      currentPhase: 1,
      currentP1Hits: 0, // Falsified hits
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [5, 6, 7, 8, 9],
      proofs: tamperedProofs,
      currentHeight,
      userUtxos: [u2],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(tamperedTurnTx, [gameBox, u2], p2Secret, currentHeight);
    }).toThrow();
  });

  it('2. rejects Play Turn with invalid Salvo Size (Action 0)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // P1 fires 6 shots instead of 5
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight + 1);
    const invalidSalvoTx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4, 5], // 6 shots!
      proofs: [],
      currentHeight: currentHeight + 1,
      userUtxos: [u1],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(invalidSalvoTx, [gameBox, u1], p1Secret, currentHeight + 1);
    }).toThrow();
  });

  it('3. rejects Play Turn targeting an already-fired cell (Action 0)', async () => {
    let currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);

    // Turn 1: P1 fires [0, 1, 2, 3, 4]
    currentHeight += 1;
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t1 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight,
      userUtxos: [u1],
      p1History,
      p2History,
    });
    const signedT1 = reduceAndSign(t1, [gameBox, u1], p1Secret, currentHeight);
    [0, 1, 2, 3, 4].forEach((c) => (p1History[c] = 1));
    gameBox = signedOutputToBox(signedT1, 0);

    // Turn 2: P2 responds
    currentHeight += 1;
    const p2Proofs = [0, 1, 2, 3, 4].map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const t2 = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox,
      currentPhase: 1,
      currentP1Hits: 5,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 5,
      nextSalvo: [5, 6, 7, 8, 9],
      proofs: p2Proofs,
      currentHeight,
      userUtxos: [u2],
      p1History,
      p2History,
    });
    const signedT2 = reduceAndSign(t2, [gameBox, u2], p2Secret, currentHeight);
    [5, 6, 7, 8, 9].forEach((c) => (p2History[c] = 1));
    gameBox = signedOutputToBox(signedT2, 0);

    // Turn 3: P1 attempts to re-target cell 0 (already fired)
    currentHeight += 1;
    const p1Proofs = [5, 6, 7, 8, 9].map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
    const u3 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const repeatTargetTx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 5,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 10, 11, 12, 13], // Cell 0 is already fired!
      proofs: p1Proofs,
      currentHeight,
      userUtxos: [u3],
      p1History,
      p2History,
    });

    expect(() => {
      reduceAndSign(repeatTargetTx, [gameBox, u3], p1Secret, currentHeight);
    }).toThrow();
  });

  it('4. rejects Play Turn with out-of-bounds coordinates (Action 0)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // P1 attempts to fire out-of-bounds coordinate 64
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight + 1);
    const oobTx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [60, 61, 62, 63, 64], // 64 is out of bounds!
      proofs: [],
      currentHeight: currentHeight + 1,
      userUtxos: [u1],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(oobTx, [gameBox, u1], p1Secret, currentHeight + 1);
    }).toThrow();
  });

  it('5. rejects Phase Hijacking / Wrong Player Signature (Action 0)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // It is Phase 0 (P1's turn). P2 attempts to sign the transaction.
    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight + 1);
    const hijackTx = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight: currentHeight + 1,
      userUtxos: [u2],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(hijackTx, [gameBox, u2], p2Secret, currentHeight + 1);
    }).toThrow();
  });

  it('6. rejects Play Turn after Timeout expired (Action 0 - Temporal Guard)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // Timeout is at height 1862860 + 30 = 1862890.
    // P1 tries to play at height 1862895 (> timeoutHeight).
    const expiredHeight = 1862860 + 35;
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, expiredHeight);
    const expiredTurnTx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight: expiredHeight,
      userUtxos: [u1],
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
    });

    expect(() => {
      reduceAndSign(expiredTurnTx, [gameBox, u1], p1Secret, expiredHeight);
    }).toThrow();
  });

  it('7. rejects Premature Timeout Claim (Action 2 - Temporal Guard)', async () => {
    const currentHeight = 1862860;
    const fleet1 = createValidFleetGrid();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    const gameBox = signedOutputToBox(signedAccept, 0);

    // Timeout height is exactly 1862860 + 30 = 1862890.
    // Contract requires strict HEIGHT > timeoutHeight. At 1862890, it must fail!
    const exactTimeoutHeight = 1862860 + 30;
    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, exactTimeoutHeight);
    const prematureTimeoutTx = buildClaimTimeoutTx({
      activePlayerAddress: p2Addr.encode(),
      gameBox,
      rawBoardBytes: fleet2.grid,
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(com2.masterSeedHex)),
      currentHeight: exactTimeoutHeight,
      userUtxos: [u2],
      isP1Claiming: false,
      p1History: Array(64).fill(0),
      p2History: Array(64).fill(0),
      p1Hits: 0,
      p2Hits: 0,
    });

    expect(() => {
      reduceAndSign(prematureTimeoutTx, [gameBox, u2], p2Secret, exactTimeoutHeight);
    }).toThrow();
  });

  it('8. rejects Claim Win with overlapping ships (Action 1 - Invalid Geometry)', async () => {
    const currentHeight = 1862860;
    // Overlapping fleet: Carrier at row 0 (0..4) and Cruiser at row 0 (0..2)
    const overlappingGrid = new Array(64).fill(0);
    [0, 1, 2, 3, 4].forEach((c) => (overlappingGrid[c] = 1));
    [0, 1, 2].forEach((c) => (overlappingGrid[c] = 1));
    [16, 17].forEach((c) => (overlappingGrid[c] = 1));
    [32, 33, 34].forEach((c) => (overlappingGrid[c] = 1));

    const comOverlap = generateBoardCommitment(overlappingGrid);
    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: comOverlap.rootHex,
      p1BoardHash: comOverlap.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    // Synthetic game box with p1Hits = 10
    const uClaim = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight + 1);
    const overlapClaimTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoardBytes: overlappingGrid,
      carrierCoord: [0, 0], // Overlaps with cruiser at row 0!
      cruiserCoord: [0, 0],
      patrolCoord: [2, 0],
      saltBytes: Array.from(hexToBytes(comOverlap.masterSeedHex)),
      currentHeight: currentHeight + 1,
      userUtxos: [uClaim],
      isP1Claiming: true,
      p1Hits: 10,
      p2Hits: 0,
    });

    expect(() => {
      reduceAndSign(overlapClaimTx, [gameBox, uClaim], p1Secret, currentHeight + 1);
    }).toThrow();
  });

  it('9. rejects Tie Theft (Action 1 - Invalid Payout)', async () => {
    let currentHeight = 1862860;
    const createEndgameFleet = () => {
      const grid = new Array(64).fill(0);
      [56, 57, 58, 59, 60].forEach((c) => (grid[c] = 1));
      [48, 49, 50].forEach((c) => (grid[c] = 1));
      [62, 63].forEach((c) => (grid[c] = 1));
      return { grid, carrierCoord: [7, 0] as [number, number], cruiserCoord: [6, 0] as [number, number], patrolCoord: [7, 6] as [number, number] };
    };

    const fleet1 = createEndgameFleet();
    const com1 = generateBoardCommitment(fleet1.grid);
    const fleet2 = createEndgameFleet();
    const com2 = generateBoardCommitment(fleet2.grid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    let p1Hits = 0;
    let p2Hits = 0;
    let p1IncomingSalvo: number[] = [];
    let p2IncomingSalvo: number[] = [];

    // Play all 13 rounds so both reach 10 hits
    for (let round = 1; round <= 13; round++) {
      currentHeight += 1;
      const startCell = (round - 1) * 5;
      const salvoSize = round === 13 ? 4 : 5;
      const salvoCells = Array.from({ length: salvoSize }, (_, i) => startCell + i);

      // P1
      let p1NewHits = 0;
      let p1Proofs: any[] = [];
      if (p1IncomingSalvo.length > 0) {
        p1IncomingSalvo.forEach((c) => {
          if (fleet1.grid[c] === 1) p1NewHits++;
        });
        p1Proofs = p1IncomingSalvo.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
      }
      p2Hits += p1NewHits;

      const p1UserUtxo = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
      const p1TurnTx = buildPlayTurnTx({
        activePlayerAddress: p1Addr.encode(),
        activePlayerPublicKey: p1Pk,
        gameBox,
        currentPhase: 0,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: p1NewHits,
        nextSalvo: salvoCells,
        proofs: p1Proofs,
        currentHeight,
        userUtxos: [p1UserUtxo],
        p1History,
        p2History,
      });
      const signedP1 = reduceAndSign(p1TurnTx, [gameBox, p1UserUtxo], p1Secret, currentHeight);
      salvoCells.forEach((c) => (p1History[c] = 1));
      gameBox = signedOutputToBox(signedP1, 0);
      p2IncomingSalvo = salvoCells;

      // P2
      currentHeight += 1;
      let p2NewHits = 0;
      const p2Proofs = p2IncomingSalvo.map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
      p2IncomingSalvo.forEach((c) => {
        if (fleet2.grid[c] === 1) p2NewHits++;
      });
      p1Hits += p2NewHits;

      const p2UserUtxo = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
      const p2TurnTx = buildPlayTurnTx({
        activePlayerAddress: p2Addr.encode(),
        activePlayerPublicKey: p2Pk,
        gameBox,
        currentPhase: 1,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: p2NewHits,
        nextSalvo: salvoCells,
        proofs: p2Proofs,
        currentHeight,
        userUtxos: [p2UserUtxo],
        p1History,
        p2History,
      });
      const signedP2 = reduceAndSign(p2TurnTx, [gameBox, p2UserUtxo], p2Secret, currentHeight);
      salvoCells.forEach((c) => (p2History[c] = 1));
      gameBox = signedOutputToBox(signedP2, 0);
      p1IncomingSalvo = salvoCells;
    }

    // Both players hit 10 ships. P1 maliciously calls buildClaimWinTx with isTie: false (Tie Theft attempt)
    currentHeight += 1;
    const uTheft = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const theftTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoardBytes: fleet1.grid,
      carrierCoord: fleet1.carrierCoord,
      cruiserCoord: fleet1.cruiserCoord,
      patrolCoord: fleet1.patrolCoord,
      saltBytes: Array.from(hexToBytes(com1.masterSeedHex)),
      currentHeight,
      userUtxos: [uTheft],
      isP1Claiming: true,
      isTie: false, // Maliciously claiming full win instead of tie!
      p1History,
      p2History,
      p1Hits: 10,
      p2Hits: 10,
    });

    expect(() => {
      reduceAndSign(theftTx, [gameBox, uTheft], p1Secret, currentHeight);
    }).toThrow();
  });

  it('10. rejects Claim Win for Honest Score Mismatch (Merkle Root vs Board Hash Forgery)', async () => {
    let currentHeight = 1862860;
    const emptyGrid = new Array(64).fill(0);
    const comEmpty = generateBoardCommitment(emptyGrid);

    const validFleet = createValidFleetGrid();
    const comValid = generateBoardCommitment(validFleet.grid);

    const fleet2 = createValidFleetGrid();
    const com2 = generateBoardCommitment(fleet2.grid);

    // P1 commits fake empty Merkle Root and valid Board Hash
    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: comEmpty.rootHex,       // Empty root to fake misses!
      p1BoardHash: comValid.boardHashHex, // Valid hash to pass geometry!
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: com2.rootHex,
      p2BoardHash: com2.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);

    // Turn 1 (P1 fires [0, 1, 2, 3, 4] -> 5 hits on P2 Carrier)
    currentHeight += 1;
    const u1 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t1 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: [],
      currentHeight,
      userUtxos: [u1],
      p1History,
      p2History,
    });
    const signedT1 = reduceAndSign(t1, [gameBox, u1], p1Secret, currentHeight);
    [0, 1, 2, 3, 4].forEach((c) => (p1History[c] = 1));
    gameBox = signedOutputToBox(signedT1, 0);

    // Turn 2 (P2 defends 5 hits, fires at P1 ships: [0, 1, 2, 3, 4])
    currentHeight += 1;
    const p2Proofs = [0, 1, 2, 3, 4].map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    const u2 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const t2 = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox,
      currentPhase: 1,
      currentP1Hits: 5,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 5,
      nextSalvo: [0, 1, 2, 3, 4],
      proofs: p2Proofs,
      currentHeight,
      userUtxos: [u2],
      p1History,
      p2History,
    });
    const signedT2 = reduceAndSign(t2, [gameBox, u2], p2Secret, currentHeight);
    [0, 1, 2, 3, 4].forEach((c) => (p2History[c] = 1));
    gameBox = signedOutputToBox(signedT2, 0);

    // Turn 3 (P1 proves against comEmpty -> falsely reports 0 hits for P2! P1 fires [16, 17, 18, 32, 33] -> 5 hits)
    currentHeight += 1;
    const fakeProofs = [0, 1, 2, 3, 4].map((c) => generateMerkleProof(c, comEmpty.rawLeaves, comEmpty.tree));
    const u3 = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const t3 = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox,
      currentPhase: 0,
      currentP1Hits: 5,
      currentP2Hits: 0, // Falsified 0 hits!
      newHitsByPreviousPlayer: 0,
      nextSalvo: [16, 17, 18, 32, 33],
      proofs: fakeProofs,
      currentHeight,
      userUtxos: [u3],
      p1History,
      p2History,
    });
    const signedT3 = reduceAndSign(t3, [gameBox, u3], p1Secret, currentHeight);
    [16, 17, 18, 32, 33].forEach((c) => (p1History[c] = 1));
    gameBox = signedOutputToBox(signedT3, 0);

    // Turn 4 (P2 defends 5 hits -> P1 total hits = 10. P2 fires [5, 6, 7, 8, 9])
    currentHeight += 1;
    const p2Proofs2 = [16, 17, 18, 32, 33].map((c) => generateMerkleProof(c, com2.rawLeaves, com2.tree));
    const u4 = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
    const t4 = buildPlayTurnTx({
      activePlayerAddress: p2Addr.encode(),
      activePlayerPublicKey: p2Pk,
      gameBox,
      currentPhase: 1,
      currentP1Hits: 10,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 5,
      nextSalvo: [5, 6, 7, 8, 9],
      proofs: p2Proofs2,
      currentHeight,
      userUtxos: [u4],
      p1History,
      p2History,
    });
    const signedT4 = reduceAndSign(t4, [gameBox, u4], p2Secret, currentHeight);
    [5, 6, 7, 8, 9].forEach((c) => (p2History[c] = 1));
    gameBox = signedOutputToBox(signedT4, 0);

    // P1 attempts to claim win disclosing comValid.
    // Contract checks honestScore: opponentTrueHits (5) - pendingHits (0) != opponentRecordedHits (0)!
    currentHeight += 1;
    const uFraudClaim = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const fraudClaimTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoardBytes: validFleet.grid,
      carrierCoord: [0, 0],
      cruiserCoord: [2, 0],
      patrolCoord: [4, 0],
      saltBytes: Array.from(hexToBytes(comValid.masterSeedHex)),
      currentHeight,
      userUtxos: [uFraudClaim],
      isP1Claiming: true,
      p1History,
      p2History,
      p1Hits: 10,
      p2Hits: 0,
    });

    expect(() => {
      reduceAndSign(fraudClaimTx, [gameBox, uFraudClaim], p1Secret, currentHeight);
    }).toThrow();
  });

  it('11. grants Full Win for Ghost Fleet Anti-Cheat Resolution (Action 1)', async () => {
    let currentHeight = 1862860;
    const createEndgameFleet = () => {
      const grid = new Array(64).fill(0);
      [56, 57, 58, 59, 60].forEach((c) => (grid[c] = 1));
      [48, 49, 50].forEach((c) => (grid[c] = 1));
      [62, 63].forEach((c) => (grid[c] = 1));
      return { grid, carrierCoord: [7, 0] as [number, number], cruiserCoord: [6, 0] as [number, number], patrolCoord: [7, 6] as [number, number] };
    };

    const fleet1 = createEndgameFleet();
    const com1 = generateBoardCommitment(fleet1.grid);

    // P2 deploys a ghost fleet (all 0s)
    const ghostGrid = new Array(64).fill(0);
    const comGhost = generateBoardCommitment(ghostGrid);

    const p1Utxo = createMockUserUtxo(p1Addr.encode(), 20000000n, currentHeight);
    const createTx = buildCreateLobbyTx({
      p1Address: p1Addr.encode(),
      p1PublicKey: p1Pk,
      p1BoardRoot: com1.rootHex,
      p1BoardHash: com1.boardHashHex,
      wagerNanoErg: 10000000n,
      currentHeight,
      userUtxos: [p1Utxo],
      timeoutDuration: 30,
    });
    const signedCreate = reduceAndSign(createTx, [p1Utxo], p1Secret, currentHeight);
    const lobbyBox = signedOutputToBox(signedCreate, 0);

    const p2Utxo = createMockUserUtxo(p2Addr.encode(), 20000000n, currentHeight);
    const acceptTx = buildAcceptLobbyTx({
      p2Address: p2Addr.encode(),
      p2PublicKey: p2Pk,
      p2BoardRoot: comGhost.rootHex,
      p2BoardHash: comGhost.boardHashHex,
      lobbyBox,
      currentHeight,
      userUtxos: [p2Utxo],
    });
    const signedAccept = reduceAndSign(acceptTx, [lobbyBox, p2Utxo], p2Secret, currentHeight);
    let gameBox = signedOutputToBox(signedAccept, 0);

    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    let p1Hits = 0;
    let p2Hits = 0;
    let p1IncomingSalvo: number[] = [];
    let p2IncomingSalvo: number[] = [];

    // P1 covers the entire board over 13 rounds, but p1Hits remains 0 because P2 has 0 ships
    for (let round = 1; round <= 13; round++) {
      currentHeight += 1;
      const startCell = (round - 1) * 5;
      const salvoSize = round === 13 ? 4 : 5;
      const salvoCells = Array.from({ length: salvoSize }, (_, i) => startCell + i);

      // P1
      let p1NewHits = 0;
      let p1Proofs: any[] = [];
      if (p1IncomingSalvo.length > 0) {
        p1IncomingSalvo.forEach((c) => {
          if (fleet1.grid[c] === 1) p1NewHits++;
        });
        p1Proofs = p1IncomingSalvo.map((c) => generateMerkleProof(c, com1.rawLeaves, com1.tree));
      }
      p2Hits += p1NewHits;

      const p1UserUtxo = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
      const p1TurnTx = buildPlayTurnTx({
        activePlayerAddress: p1Addr.encode(),
        activePlayerPublicKey: p1Pk,
        gameBox,
        currentPhase: 0,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: p1NewHits,
        nextSalvo: salvoCells,
        proofs: p1Proofs,
        currentHeight,
        userUtxos: [p1UserUtxo],
        p1History,
        p2History,
      });
      const signedP1 = reduceAndSign(p1TurnTx, [gameBox, p1UserUtxo], p1Secret, currentHeight);
      salvoCells.forEach((c) => (p1History[c] = 1));
      gameBox = signedOutputToBox(signedP1, 0);
      p2IncomingSalvo = salvoCells;

      // P2
      currentHeight += 1;
      let p2NewHits = 0;
      const p2Proofs = p2IncomingSalvo.map((c) => generateMerkleProof(c, comGhost.rawLeaves, comGhost.tree));
      p1Hits += p2NewHits;

      const p2UserUtxo = createMockUserUtxo(p2Addr.encode(), 2000000n, currentHeight);
      const p2TurnTx = buildPlayTurnTx({
        activePlayerAddress: p2Addr.encode(),
        activePlayerPublicKey: p2Pk,
        gameBox,
        currentPhase: 1,
        currentP1Hits: p1Hits,
        currentP2Hits: p2Hits,
        newHitsByPreviousPlayer: 0,
        nextSalvo: salvoCells,
        proofs: p2Proofs,
        currentHeight,
        userUtxos: [p2UserUtxo],
        p1History,
        p2History,
      });
      const signedP2 = reduceAndSign(p2TurnTx, [gameBox, p2UserUtxo], p2Secret, currentHeight);
      salvoCells.forEach((c) => (p2History[c] = 1));
      gameBox = signedOutputToBox(signedP2, 0);
      p1IncomingSalvo = salvoCells;
    }

    // P1 covered all 64 cells with 0 hits. P1 claims win via Action 1.
    // On-chain: opponentCheated = p1CoveredBoard && p1Hits < 10 (true!)
    // hasClaimRights = p1CoveredBoard (true!)
    // isTie = opponentHas10 && !opponentCheated (false!)
    // Outcome: P1 receives 100% win payout!
    currentHeight += 1;
    const uGhostClaim = createMockUserUtxo(p1Addr.encode(), 2000000n, currentHeight);
    const ghostClaimTx = buildClaimWinTx({
      activePlayerAddress: p1Addr.encode(),
      gameBox,
      rawBoardBytes: com1.saltedBoardPayload,
      currentHeight,
      userUtxos: [uGhostClaim],
      isP1Claiming: true,
      isTie: false,
      p1History,
      p2History,
      p1Hits: 0,
      p2Hits: 0,
    });

    const signedGhostClaim = reduceAndSign(ghostClaimTx, [gameBox, uGhostClaim], p1Secret, currentHeight);
    expect(signedGhostClaim).toBeTruthy();
    const p1WinBox = signedOutputToBox(signedGhostClaim, 0);
    expect(BigInt(p1WinBox.value)).toBeGreaterThanOrEqual(19800000n);
  });
});

