import { describe, it, expect, beforeEach } from 'vitest';
import { ErgoAddress, SColl, SInt, SByte, SGroupElement } from '@fleet-sdk/core';
import { serializeBox } from '@fleet-sdk/serializer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { generateBoardCommitment, generateMerkleProof, hashBlake2b256 } from '../src/lib/crypto/merkle';
import { buildPlayTurnTx, getBattleshipsErgoTree } from '../src/lib/blockchain/fleet';
import { reduceUnsignedTx } from '../src/lib/blockchain/reducer';

describe('Fleet Play Turn Tx', () => {
  beforeEach(() => {
    (global as any).fetch = (async (url: string) => {
      if (url.includes('/info')) {
        return { ok: true, json: async () => ({ bestHeaderId: '01'.repeat(32) }) };
      }
      if (url.includes('/header')) {
        return {
          ok: true,
          json: async () => ({
            id: '01'.repeat(32),
            parentId: '02'.repeat(32),
            height: 1862862,
            version: 2,
            timestamp: Date.now(),
            nBits: 100000,
            votes: '000000',
            size: 1000,
            difficulty: '1',
            stateRoot: '00'.repeat(33),
            adProofsRoot: '00'.repeat(32),
            transactionsRoot: '00'.repeat(32),
            extensionHash: '00'.repeat(32),
            powSolutions: {
              pk: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
              w: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
              n: '0000000000000000',
              d: 0,
            },
          }),
        };
      }
      return { ok: false };
    }) as any;
  });

  it('reduces P2 turn correctly', async () => {
    const DEFAULT_DEV_PK = '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b';
    const grid1 = new Array(64).fill(0);
    const grid2 = new Array(64).fill(0);
    grid2[5] = 1;
    grid2[6] = 1;
    grid2[7] = 1;
    grid2[39] = 1;
    const com1 = generateBoardCommitment(grid1);
    const com2 = generateBoardCommitment(grid2);
    
    const userAddr = ErgoAddress.fromPublicKey(DEFAULT_DEV_PK);

    // Initial state: P1 just played Turn 0. Now it's P2's turn (Phase 1)
    const initialP1History = Array(64).fill(0);
    // P1 fired at [4, 5, 6, 7, 39]
    initialP1History[4] = 1;
    initialP1History[5] = 1;
    initialP1History[6] = 1;
    initialP1History[7] = 1;
    initialP1History[39] = 1;
    
    const initialP2History = Array(64).fill(0);

    const mockGameBox: any = {
      value: '6000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1862215,
      additionalRegisters: {
        R4: SColl(SGroupElement, [hexToBytes(DEFAULT_DEV_PK), hexToBytes(DEFAULT_DEV_PK), hexToBytes(DEFAULT_DEV_PK)]).toHex(),
        R5: SColl(SColl(SByte), [Array.from(hexToBytes(com1.rootHex)), Array.from(hexToBytes(com2.rootHex))]).toHex(),
        R6: SColl(SInt, [1, 0, 0]).toHex(), // Phase 1, P1Hits 0, P2Hits 0
        R7: SColl(SInt, [4, 5, 6, 7, 39]).toHex(), // P1's shots
        R8: SColl(SColl(SByte), [initialP1History, initialP2History]).toHex(),
        R9: SColl(SInt, [1862245, 30]).toHex(),
      },
      transactionId: '00'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockGameBox).toBytes()));

    const mockUserBox: any = {
      value: '2000000',
      ergoTree: userAddr.ergoTree,
      assets: [],
      creationHeight: 1862215,
      additionalRegisters: {},
      transactionId: '11'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const turnProofs = [4, 5, 6, 7, 39].map(idx => generateMerkleProof(idx, com2.rawLeaves, com2.tree));

    const tx = buildPlayTurnTx({
      activePlayerAddress: userAddr.encode(),
      activePlayerPublicKey: DEFAULT_DEV_PK,
      gameBox: mockGameBox,
      currentPhase: 1,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 4,
      nextSalvo: [0, 1, 2, 3, 8], // P2 fires back
      proofs: turnProofs,
      currentHeight: 1862221,
      userUtxos: [mockUserBox],
      p1History: initialP1History,
      p2History: initialP2History,
    });

    const wasm = await import('ergo-lib-wasm-nodejs');
    const secret = wasm.SecretKey.dlog_from_bytes(hexToBytes("00".repeat(31) + "01")); // dummy PK?
    
    // Actually wait, let's just use Fleet's sign? Wait, Fleet doesn't prove dlog.
    // Let's use WASM wallet!
    const secretKeys = new wasm.SecretKeys();
    secretKeys.add(secret);
    
    // We just want to see if we can instantiate a ReducedTransaction and maybe check its properties?
    // Wait, let's see what happens.
    
    const plainTx = tx.toPlainObject();
    const reducedBase64 = await reduceUnsignedTx(plainTx, [mockGameBox, mockUserBox]);
    expect(reducedBase64).toBeTruthy();
  });

  it('reduces Host (P1) Phase 0 opening salvo correctly', async () => {
    const wasm = await import('ergo-lib-wasm-nodejs');
    const secret = wasm.SecretKey.dlog_from_bytes(hexToBytes("11".repeat(32)));
    const p1Addr = ErgoAddress.fromBase58(secret.get_address().to_base58(wasm.NetworkPrefix.Mainnet));
    const p1Pk = bytesToHex(p1Addr.getPublicKeys()[0]);

    const DEFAULT_DEV_PK = '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b';
    const p2Pk = '026de0128c091617fc38f870254ba2d1b45da45c79166e15cbc4fd414cbfff8d65';
    const devPk = '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b';

    const grid1 = new Array(64).fill(0);
    const grid2 = new Array(64).fill(0);
    const com1 = generateBoardCommitment(grid1);
    const com2 = generateBoardCommitment(grid2);

    const initialP1History = Array(64).fill(0);
    const initialP2History = Array(64).fill(0);

    const mockGameBox: any = {
      value: '20000000',
      ergoTree: getBattleshipsErgoTree().toHex(),
      assets: [],
      creationHeight: 1862848,
      additionalRegisters: {
        R4: SColl(SGroupElement, [hexToBytes(p1Pk), hexToBytes(p2Pk), hexToBytes(devPk)]).toHex(),
        R5: SColl(SColl(SByte), [
          Array.from(hexToBytes(com1.rootHex)),
          Array.from(hexToBytes(com2.rootHex)),
          Array.from(hexToBytes(com1.boardHashHex)),
          Array.from(hexToBytes(com2.boardHashHex)),
        ]).toHex(),
        R6: SColl(SInt, [0, 0, 0]).toHex(), // Phase 0
        R7: SColl(SInt, []).toHex(), // Empty initial shots
        R8: SColl(SColl(SByte), [initialP1History, initialP2History]).toHex(),
        R9: SColl(SInt, [1862878, 30]).toHex(),
      },
      transactionId: '00'.repeat(32),
      index: 0,
    };
    mockGameBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockGameBox).toBytes()));

    const mockUserBox: any = {
      value: '2000000',
      ergoTree: p1Addr.ergoTree,
      assets: [],
      creationHeight: 1862848,
      additionalRegisters: {},
      transactionId: '11'.repeat(32),
      index: 0,
    };
    mockUserBox.boxId = bytesToHex(hashBlake2b256(serializeBox(mockUserBox).toBytes()));

    const tx = buildPlayTurnTx({
      activePlayerAddress: p1Addr.encode(),
      activePlayerPublicKey: p1Pk,
      gameBox: mockGameBox,
      currentPhase: 0,
      currentP1Hits: 0,
      currentP2Hits: 0,
      newHitsByPreviousPlayer: 0,
      nextSalvo: [0, 1, 2, 3, 4], // P1 fires first salvo
      proofs: [],
      currentHeight: 1862862,
      userUtxos: [mockUserBox],
      p1History: initialP1History,
      p2History: initialP2History,
    });

    const plainTx = tx.toPlainObject();
    const reducedBase64 = await reduceUnsignedTx(plainTx, [mockGameBox, mockUserBox]);
    expect(reducedBase64).toBeTruthy();

    const secretKeys = new wasm.SecretKeys();
    secretKeys.add(secret);
    const wallet = wasm.Wallet.from_secrets(secretKeys);
    const reducedTx = wasm.ReducedTransaction.sigma_parse_bytes(Buffer.from(reducedBase64, 'base64'));
    const signed = wallet.sign_reduced_transaction(reducedTx);
    expect(signed).toBeTruthy();
  });
});
