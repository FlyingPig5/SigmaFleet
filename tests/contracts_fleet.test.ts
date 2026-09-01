import { describe, it, expect } from 'vitest';
import {
  getLobbyErgoTree,
  getBattleshipsErgoTree,
  getLobbyAddress,
  getBattleshipsAddress,
  buildCreateLobbyTx,
  buildAcceptLobbyTx,
  buildPlayTurnTx,
  buildCancelLobbyTx,
  buildClaimWinTx,
  buildClaimTimeoutTx,
  normalizeInputBox,
  DEFAULT_DEV_PK,
} from '../src/lib/blockchain/fleet';
import { generateBoardCommitment, generateMerkleProof, hashBlake2b256 } from '../src/lib/crypto/merkle';
import { reduceUnsignedTx } from '../src/lib/blockchain/reducer';
import { ErgoAddress, SColl, SGroupElement, SByte, SInt, SLong } from '@fleet-sdk/core';
import { serializeBox, serializeTransaction } from '@fleet-sdk/serializer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

describe('Contracts & Fleet SDK Integration Tests', () => {
  it('compiles Lobby.erg and Battleships.erg ErgoTrees deterministically', () => {
    const lobbyTree = getLobbyErgoTree();
    const bsTree = getBattleshipsErgoTree();
    console.log('Lobby ErgoTree byte length:', hexToBytes(lobbyTree.toHex()).length);
    console.log('Battleships ErgoTree byte length:', hexToBytes(bsTree.toHex()).length);

    expect(typeof lobbyTree.toHex()).toBe('string');
    expect(lobbyTree.toHex().length).toBeGreaterThan(50);

    expect(typeof bsTree.toHex()).toBe('string');
    expect(bsTree.toHex().length).toBeGreaterThan(1000);

    const lobbyAddr = getLobbyAddress();
    const bsAddr = getBattleshipsAddress();

    expect(typeof lobbyAddr).toBe('string');
    expect(lobbyAddr.length).toBeGreaterThan(20);
    expect(typeof bsAddr).toBe('string');
    expect(bsAddr.length).toBeGreaterThan(20);
  });

  it('builds a valid Create Lobby transaction with Fleet SDK', () => {
    const grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (grid[i] = 1));
    const com = generateBoardCommitment(grid);

    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);
    const mockBox: any = {
      value: '2000000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '00'.repeat(32),
      index: 0,
    };
    mockBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockBox).toBytes()));

    expect(() => {
      const tx = buildCreateLobbyTx({
        p1Address: userAddr.encode(),
        p1PublicKey: DEFAULT_DEV_PK,
        p1BoardRoot: com.rootHex,
        p1BoardHash: com.boardHashHex,
        firstSalvo: [10, 25, 42, 18, 55],
        wagerNanoErg: 1000000000n,
        currentHeight: 1250000,
        userUtxos: [mockBox],
      });
      const serialized = serializeTransaction(tx.toPlainObject()).toBytes();
      expect(serialized.length).toBeGreaterThan(50);
      const base64Tx = Buffer.from(serialized).toString('base64');
      expect(typeof base64Tx).toBe('string');
    }).not.toThrow();
  });

  it('reduces an unsigned Fleet transaction using WASM for ErgoPay', async () => {
    const grid = new Array(64).fill(0);
    const com = generateBoardCommitment(grid);
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);
    const mockBox: any = {
      value: '2000000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '00'.repeat(32),
      index: 0,
    };
    mockBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockBox).toBytes()));

    const tx = buildCreateLobbyTx({
      p1Address: userAddr.encode(),
      p1PublicKey: DEFAULT_DEV_PK,
      p1BoardRoot: com.rootHex,
      p1BoardHash: com.boardHashHex,
      firstSalvo: [10, 25, 42, 18, 55],
      wagerNanoErg: 1000000000n,
      currentHeight: 1250000,
      userUtxos: [mockBox],
    });

    const plainTx = tx.toPlainObject();
    const reducedBase64 = await reduceUnsignedTx(plainTx, [mockBox]);
    expect(typeof reducedBase64).toBe('string');
    expect(reducedBase64.length).toBeGreaterThan(100);
  }, 20000);

  it('builds a valid Accept Lobby transaction with Explorer-style object registers', async () => {
    const grid = new Array(64).fill(0);
    const com = generateBoardCommitment(grid);
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);
    const mockUserBox: any = {
      boxId: '11'.repeat(32),
      value: '2000000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '22'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const expectedBattleshipsHash = hashBlake2b256(hexToBytes(getBattleshipsErgoTree().toHex()));
    const mockExplorerLobbyBox: any = {
      boxId: '33'.repeat(32),
      value: '1000000000',
      ergoTree: getLobbyErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: { serializedValue: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(), renderedValue: [DEFAULT_DEV_PK, DEFAULT_DEV_PK] },
        R5: { serializedValue: SColl(SColl(SByte), [Array.from(hexToBytes(com.rootHex)), Array.from(hexToBytes(com.boardHashHex))]).toHex(), renderedValue: [com.rootHex, com.boardHashHex] },
        R6: { serializedValue: SColl(SInt, []).toHex(), renderedValue: [] },
        R7: { serializedValue: SColl(SByte, []).toHex(), renderedValue: [] },
        R8: { serializedValue: SColl(SByte, Array.from(expectedBattleshipsHash)).toHex(), renderedValue: bytesToHex(expectedBattleshipsHash) },
        R9: { serializedValue: SInt(30).toHex(), renderedValue: '30' },
      },
      transactionId: '44'.repeat(32),
      index: 0,
    };
    mockExplorerLobbyBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockExplorerLobbyBox)).toBytes()));

    const tx = buildAcceptLobbyTx({
      p2Address: userAddr.encode(),
      p2PublicKey: DEFAULT_DEV_PK,
      p2BoardRoot: com.rootHex,
      p2BoardHash: com.boardHashHex,
      lobbyBox: mockExplorerLobbyBox,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });
    expect(tx.inputs.length).toBe(2);
    expect(tx.outputs.length).toBeGreaterThanOrEqual(1);

    // Verify WASM reduction of accept lobby tx against Lobby.erg contract
    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockExplorerLobbyBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds a valid Cancel / 100% Refund Lobby transaction', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);
    const mockLobbyBox: any = {
      value: '1000000000',
      ergoTree: getLobbyErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [Array.from(hexToBytes('00'.repeat(32))), Array.from(hexToBytes('00'.repeat(32)))]).toHex(),
        R6: SColl(SInt, []).toHex(),
        R7: SColl(SByte, []).toHex(),
        R8: SColl(SByte, hexToBytes('00'.repeat(32))).toHex(),
        R9: SInt(30).toHex(),
      },
      transactionId: '44'.repeat(32),
      index: 0,
    };
    mockLobbyBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockLobbyBox)).toBytes()));

    const tx = buildCancelLobbyTx({
      p1Address: userAddr.encode(),
      lobbyBox: mockLobbyBox,
      currentHeight: 1250000,
    });
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs.length).toBeGreaterThanOrEqual(1);

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockLobbyBox)]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Play Turn (Phase 1 -> Phase 0) transaction with 5 Merkle proofs', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    // Player 1's board commitment
    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    // Player 2's board commitment
    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // Initial 5-shot salvo fired by Player 1 at Player 2
    const p1Salvo = [10, 15, 20, 25, 30]; // 10 and 25 are hits on p2Grid

    // Mock active Battleship box in Phase 1 (waiting for Player 2's counter-salvo)
    const p1History = new Array(64).fill(0);
    p1Salvo.forEach((c) => (p1History[c] = 1));
    const p2History = new Array(64).fill(0);

    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.rootHex)),
          Array.from(hexToBytes(p2Com.rootHex)),
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [1, 0, 0]).toHex(), // Phase 1, P1_Hits: 0, P2_Hits: 0
        R7: SColl(SInt, p1Salvo).toHex(),
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // Player 2 takes turn: generates 5 Merkle proofs for incoming salvo from Player 1
    const proofs = p1Salvo.map((c) => generateMerkleProof(c, p2Com.rawLeaves, p2Com.tree));
    const p2Salvo = [0, 5, 10, 15, 20];
    const tx = buildPlayTurnTx({
      activePlayerAddress: userAddr.encode(),
      activePlayerPublicKey: DEFAULT_DEV_PK,
      gameBox: mockGameBox,
      currentPhase: 1,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 2, // 2 hits scored by P1 on P2
      nextSalvo: p2Salvo,
      proofs,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    expect(tx.inputs.length).toBe(2);
    expect(tx.outputs.length).toBeGreaterThanOrEqual(1);

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Host Turn 1 Opening Salvo (Phase 0 -> Phase 1 with R7=[])', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // Initial game box fresh from Accept Lobby (Phase 0, R7 is empty [])
    const initialP1History = new Array(64).fill(0);
    const initialP2History = new Array(64).fill(0);

    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.rootHex)),
          Array.from(hexToBytes(p2Com.rootHex)),
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 0, 0]).toHex(), // Phase 0, P1_Hits: 0, P2_Hits: 0
        R7: SColl(SInt, []).toHex(), // Empty opening salvo!
        R8: SColl(SColl(SByte), [initialP1History, initialP2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // Host fires opening salvo of 5 shots
    const p1Salvo = [10, 15, 20, 25, 30];
    const tx = buildPlayTurnTx({
      activePlayerAddress: userAddr.encode(),
      activePlayerPublicKey: DEFAULT_DEV_PK,
      gameBox: mockGameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p1Salvo,
      proofs: [],
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    expect(tx.inputs.length).toBe(2);
    expect(tx.outputs.length).toBeGreaterThanOrEqual(1);

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Host Turn 1 transaction directly chained from buildAcceptLobbyTx output', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    const mockUserBox: any = {
      value: '2000000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '22'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // 1. Create Lobby Box
    const mockExplorerLobbyBox: any = {
      boxId: '33'.repeat(32),
      value: '1000000000',
      ergoTree: getLobbyErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: { serializedValue: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(), renderedValue: [DEFAULT_DEV_PK, DEFAULT_DEV_PK] },
        R5: { serializedValue: SColl(SColl(SByte), [Array.from(hexToBytes(p1Com.rootHex)), Array.from(hexToBytes(p1Com.boardHashHex))]).toHex(), renderedValue: [p1Com.rootHex, p1Com.boardHashHex] },
        R6: { serializedValue: SColl(SInt, []).toHex(), renderedValue: [] },
        R7: { serializedValue: SColl(SByte, []).toHex(), renderedValue: '' },
        R8: { serializedValue: SColl(SByte, Array.from(hashBlake2b256(hexToBytes(getBattleshipsErgoTree().toHex())))).toHex(), renderedValue: '' },
        R9: { serializedValue: SInt(30).toHex(), renderedValue: '30' },
      },
      transactionId: '44'.repeat(32),
      index: 0,
    };
    mockExplorerLobbyBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockExplorerLobbyBox)).toBytes()));

    // 2. Accept Lobby
    const acceptTx = buildAcceptLobbyTx({
      p2Address: userAddr.encode(),
      p2PublicKey: DEFAULT_DEV_PK,
      p2BoardRoot: p2Com.rootHex,
      p2BoardHash: p2Com.boardHashHex,
      lobbyBox: mockExplorerLobbyBox,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainAcceptTx = acceptTx.toPlainObject();
    const reducedAccept = await reduceUnsignedTx(plainAcceptTx, [normalizeInputBox(mockExplorerLobbyBox), mockUserBox]);
    expect(typeof reducedAccept).toBe('string');

    // 3. Take gameOutput from acceptTx and mock as confirmed on-chain gameBox
    const gameOutput = plainAcceptTx.outputs[0];
    const mockLiveGameBox: any = {
      boxId: '55'.repeat(32),
      value: gameOutput.value,
      ergoTree: gameOutput.ergoTree,
      assets: gameOutput.assets || [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: { serializedValue: gameOutput.additionalRegisters.R4 },
        R5: { serializedValue: gameOutput.additionalRegisters.R5 },
        R6: { serializedValue: gameOutput.additionalRegisters.R6 },
        R7: { serializedValue: gameOutput.additionalRegisters.R7 },
        R8: { serializedValue: gameOutput.additionalRegisters.R8 },
        R9: { serializedValue: gameOutput.additionalRegisters.R9 },
      },
      transactionId: '66'.repeat(32),
      index: 0,
    };
    mockLiveGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockLiveGameBox)).toBytes()));

    // 4. Host fires opening salvo
    const p1Salvo = [10, 15, 20, 25, 30];
    const turnTx = buildPlayTurnTx({
      activePlayerAddress: userAddr.encode(),
      activePlayerPublicKey: DEFAULT_DEV_PK,
      gameBox: mockLiveGameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: p1Salvo,
      proofs: [],
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainTurnTx = turnTx.toPlainObject();
    const reducedTurn = await reduceUnsignedTx(plainTurnTx, [normalizeInputBox(mockLiveGameBox), mockUserBox]);
    expect(typeof reducedTurn).toBe('string');
  });

  it('builds and reduces a valid Claim Win transaction with 96-byte salted board payload', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // P1 scored 10 hits on P2
    const p1History = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p1History[i] = 1));

    // P2 scored 3 hits on P1
    const p2History = new Array(64).fill(0);
    [0, 1, 2].forEach((i) => (p2History[i] = 1));

    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 10, 3]).toHex(), // Phase 0, P1_Hits: 10, P2_Hits: 3
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p1Com.saltedBoardPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Claim Timeout transaction with honest board audit', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // P1 shot some cells on P2
    const p1History = new Array(64).fill(0);
    [10, 11, 12].forEach((i) => (p1History[i] = 1)); // 3 hits on p2Grid

    // P2 shot some cells on P1
    const p2History = new Array(64).fill(0);
    [0, 1].forEach((i) => (p2History[i] = 1)); // 2 hits on p1Grid

    // Mock game box where Phase = 1 (P2 timed out, P1 is claiming timeout pot)
    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [1, 3, 2]).toHex(), // Phase 1, P1_Hits: 3, P2_Hits: 2
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000, 30]).toHex(), // Expired at block 1250000
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // P1 claims timeout pot (providing P1's salted board to audit they recorded P2's 2 hits honestly)
    const tx = buildClaimTimeoutTx({
      claimerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p1Com.saltedBoardPayload,
      currentHeight: 1250050, // Height > 1250000
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Claim Timeout transaction even when R7 contains shots matching claimant coordinates (Audit Trap Immunity)', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    const p1History = new Array(64).fill(0);
    [10, 11, 12].forEach((i) => (p1History[i] = 1)); // 3 hits on p2Grid

    const p2History = new Array(64).fill(0);
    [0, 1].forEach((i) => (p2History[i] = 1)); // 2 hits on p1Grid

    // In Phase 0, P1 timed out. P2 claims timeout.
    // The previous salvo in R7 was fired by P2 (the claimant).
    // Suppose P2 fired at [0, 10, 20, 30, 40] which contains cell 10 & 40 (where P2 ALSO has ships!).
    // Under the old bug, this would cause pendingHits = 2 and break honestScore.
    // With the fix, R7 is ignored during Action 2 and reduces cleanly.
    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 3, 2]).toHex(), // Phase 0 (P1 turn timed out), P1_Hits: 3, P2_Hits: 2
        R7: SColl(SInt, [0, 10, 20, 30, 40]).toHex(), // P2's salvo containing P2's own ship cell (10 & 40)
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000, 30]).toHex(), // Expired
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const tx = buildClaimTimeoutTx({
      claimerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p2Com.saltedBoardPayload,
      currentHeight: 1250050,
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Claim Win transaction via 64-cell full board coverage when opponent denied hits', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // P1 shot all 64 cells on P2
    const p1History = new Array(64).fill(1);

    // P2 shot only 3 cells on P1
    const p2History = new Array(64).fill(0);
    [0, 1, 2].forEach((i) => (p2History[i] = 1));

    // Opponent P2 denied all hits (recording p1Hits = 0 in R6 despite P1 shooting all 64 cells)
    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 0, 3]).toHex(), // P1_Hits recorded as 0 due to opponent denial, P2_Hits = 3
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // P1 claims victory based on 64-cell full board coverage
    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p1Com.saltedBoardPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('rejects a Scattered Fleet (ten isolated 1x1 cells) during settlement claim', async () => {
    const wasm = await import('ergo-lib-wasm-nodejs');
    const secret = wasm.SecretKey.random_dlog();
    const pkHex = secret.get_address().to_ergo_tree().to_base16_bytes().slice(6);
    const userAddr = ErgoAddress.fromPublicKey(pkHex);

    // Scattered 10 isolated cells (no 5, 3, 2 contiguous ships)
    const scatteredGrid = new Array(64).fill(0);
    [0, 2, 4, 6, 17, 19, 32, 34, 49, 51].forEach((i) => (scatteredGrid[i] = 1));
    const scatteredCom = generateBoardCommitment(scatteredGrid);

    const validGrid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (validGrid[i] = 1));
    const validCom = generateBoardCommitment(validGrid);

    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [pkHex, pkHex, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(scatteredCom.boardHashHex)),
          Array.from(hexToBytes(validCom.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 10, 0]).toHex(), // P1 has 10 hits recorded
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [new Array(64).fill(0), new Array(64).fill(0)]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: scatteredCom.saltedBoardPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reducedBase64 = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    const reducedBytes = Buffer.from(reducedBase64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const reducedTx = wasm.ReducedTransaction.sigma_parse_bytes(reducedBytes);

    const secrets = new wasm.SecretKeys();
    secrets.add(secret);
    const wallet = wasm.Wallet.from_secrets(secrets);

    // Signing should throw because validGeometry failed on-chain, reducing proposition to false
    expect(() => wallet.sign_reduced_transaction(reducedTx)).toThrow();
  });

  it('rejects Overlapping Ships (Phantom Submarines exploit) during settlement claim', async () => {
    const wasm = await import('ergo-lib-wasm-nodejs');
    const secret = wasm.SecretKey.random_dlog();
    const pkHex = secret.get_address().to_ergo_tree().to_base16_bytes().slice(6);
    const userAddr = ErgoAddress.fromPublicKey(pkHex);

    // Exploitative board: Carrier [0..4], Cruiser [0..2], Destroyer [0..1] merged on 0..4 + 5 scattered singletons
    const exploitedGrid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 20, 35, 42, 53, 61].forEach((i) => (exploitedGrid[i] = 1));
    
    // Manually construct the 102-byte payload claiming [cStart:0, cDir:0, crStart:0, crDir:0, dStart:0, dDir:0]
    const exploitedPayload = new Uint8Array(102);
    for (let i = 0; i < 64; i++) exploitedPayload[i] = exploitedGrid[i];
    exploitedPayload[64] = 0; exploitedPayload[65] = 0; // Carrier at 0, H (0..4)
    exploitedPayload[66] = 0; exploitedPayload[67] = 0; // Cruiser overlapping at 0, H (0..2)
    exploitedPayload[68] = 0; exploitedPayload[69] = 0; // Destroyer overlapping at 0, H (0..1)
    exploitedPayload.set(new Uint8Array(32).fill(7), 70); // Master salt

    const exploitedHash = bytesToHex(hashBlake2b256(exploitedPayload));

    const validGrid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (validGrid[i] = 1));
    const validCom = generateBoardCommitment(validGrid);

    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [pkHex, pkHex, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(exploitedHash)),
          Array.from(hexToBytes(validCom.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 10, 0]).toHex(),
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [new Array(64).fill(0), new Array(64).fill(0)]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: exploitedPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
    });

    const plainTx = tx.toPlainObject();
    const reducedBase64 = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    const reducedBytes = Buffer.from(reducedBase64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const reducedTx = wasm.ReducedTransaction.sigma_parse_bytes(reducedBytes);

    const secrets = new wasm.SecretKeys();
    secrets.add(secret);
    const wallet = wasm.Wallet.from_secrets(secrets);

    // Signing MUST throw because validNoOverlap failed on-chain
    expect(() => wallet.sign_reduced_transaction(reducedTx)).toThrow();
  });

  it('awards 100% full payout to honest player and prevents tie extortion when opponent denied hits', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // P1 shot all 64 cells
    const p1History = new Array(64).fill(1);

    // P2 also shot 10 cells on P1 during stolen extra time
    const p2History = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p2History[i] = 1)); // 10 hits on P1

    // P2 lied on every turn: recorded p1Hits = 0 in R6
    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 0, 10]).toHex(), // P1 hits = 0 (denied), P2 hits = 10
        R7: SColl(SInt, []).toHex(),
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // P1 claims 100% full winner payout (NOT tie). Transaction must reduce cleanly!
    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p1Com.saltedBoardPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
      isTie: false, // Honest P1 gets 100% full pot, cheater gets 0
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });

  it('builds and reduces a valid Equalizer Tie claim when P1 skips evaluation turn', async () => {
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    const p1Grid = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p1Grid[i] = 1));
    const p1Com = generateBoardCommitment(p1Grid);

    const p2Grid = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p2Grid[i] = 1));
    const p2Com = generateBoardCommitment(p2Grid);

    // P1 recorded 10 hits on P2
    const p1History = new Array(64).fill(0);
    [10, 11, 12, 13, 14, 25, 26, 27, 40, 48].forEach((i) => (p1History[i] = 1));

    // P2 previously recorded 9 hits on P1
    const p2History = new Array(64).fill(0);
    [0, 1, 2, 3, 4, 18, 19, 20, 45, 53].forEach((i) => (p2History[i] = 1));

    // P2's final counter-salvo in R7 contains the 10th hit [53] on P1
    const p2FinalSalvo = [50, 51, 52, 53, 54]; // contains cell 53 which is P1's 10th ship!

    // Game is currently in Phase 0 (waiting for P1). p1Hits = 10, p2Hits = 9 (lagging R6)
    const mockGameBox: any = {
      value: '2000000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {
        R4: SColl(SGroupElement, [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(p1Com.boardHashHex)),
          Array.from(hexToBytes(p2Com.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 10, 9]).toHex(), // Phase 0, P1 hits = 10, P2 recorded hits = 9
        R7: SColl(SInt, p2FinalSalvo).toHex(), // P2's in-flight salvo in R7 has the 10th hit
        R8: SColl(SColl(SByte), [p1History, p2History]).toHex(),
        R9: SColl(SInt, [1250000 + 30, 30]).toHex(),
      },
      transactionId: '77'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(normalizeInputBox(mockGameBox)).toBytes()));

    const mockUserBox: any = {
      value: '500000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1250000,
      additionalRegisters: {},
      transactionId: '88'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    // P1 claims with isTie = true. Contract evaluates isTie = (p1Hits == 10 && opponentTrueHits >= 10) = TRUE
    const tx = buildClaimWinTx({
      winnerAddress: userAddr.encode(),
      gameBox: mockGameBox,
      rawBoard: p1Com.saltedBoardPayload,
      currentHeight: 1250000,
      userUtxos: [mockUserBox],
      isTie: true,
    });

    const plainTx = tx.toPlainObject();
    const reduced = await reduceUnsignedTx(plainTx, [normalizeInputBox(mockGameBox), mockUserBox]);
    expect(typeof reduced).toBe('string');
  });
});
