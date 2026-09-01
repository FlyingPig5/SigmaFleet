import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ShipConfig } from '@/lib/game/gameTypes';

export const GRID_SIZE = 8;
export const TOTAL_CELLS = 64; // 8x8
export const TOTAL_FLEET_HP = 10;
export const MAX_WATER_CELLS = 54; // 64 - 10
export const FRAUD_MISS_THRESHOLD = 55; // Mathematically impossible on a 10-ship board
export const TREE_DEPTH = 6; // 2^6 = 64
export const RAW_LEAF_LENGTH = 32; // 1 byte state + 31 bytes salt
export const SIBLING_HASH_LENGTH = 32;
export const PROOF_LENGTH = RAW_LEAF_LENGTH + TREE_DEPTH * SIBLING_HASH_LENGTH; // 32 + 6 * 32 = 224 bytes

export interface BoardCommitment {
  rootHex: string;
  rootBytes: Uint8Array;
  boardBytes: Uint8Array; // 64 bytes of 0 and 1
  saltedBoardPayload: Uint8Array; // 96 bytes: 64 bytes board + 32 bytes CSPRNG master salt
  boardHashHex: string; // blake2b256(saltedBoardPayload)
  boardHashBytes: Uint8Array;
  rawLeaves: Uint8Array[]; // 64 x 32 bytes
  saltsHex: string[]; // 64 hex strings (31 bytes each)
  masterSeedHex: string; // 32 bytes master salt
  shipIndices: number[]; // Exact 10 ship cell coordinates (0-63)
  tree: Uint8Array[][]; // Levels 0 to 6
}

export interface MerkleProof {
  cellIndex: number;
  isShip: boolean;
  rawLeaf: Uint8Array;
  siblings: Uint8Array[]; // 6 sibling hashes
  proofBytes: Uint8Array; // 224 bytes flat representation
  proofHex: string;
}

/**
 * Computes Blake2b-256 (32 bytes digest) of input data.
 * Matches ErgoScript's native blake2b256 function.
 */
export function hashBlake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

/**
 * Generates a random 32-byte Master Seed for deterministic, auditable board generation.
 */
export function generateMasterSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(seed);
  } else {
    try {
      const nodeCrypto = require('crypto');
      const randomBytes = nodeCrypto.randomBytes(32);
      seed.set(randomBytes);
    } catch {
      for (let i = 0; i < 32; i++) seed[i] = Math.floor(Math.random() * 256);
    }
  }
  return seed;
}

/**
 * Generates a random salt of specified byte length (default 31 bytes).
 */
export function generateSalt(length = 31): Uint8Array {
  const salt = new Uint8Array(length);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(salt);
  } else {
    try {
      const nodeCrypto = require('crypto');
      const randomBytes = nodeCrypto.randomBytes(length);
      salt.set(randomBytes);
    } catch {
      for (let i = 0; i < length; i++) salt[i] = Math.floor(Math.random() * 256);
    }
  }
  return salt;
}

/**
 * Creates 64 salted leaves and computes the 6-level Merkle tree and root.
 * Derived deterministically from a 32-byte Master Seed for anti-fraud auditing.
 * 
 * @param grid 64-element array where 0 = water, 1 = ship.
 * @param optionalMasterSeed Optional 32-byte seed for deterministic reconstruction.
 */
export function generateBoardCommitment(
  grid: number[],
  optionalMasterSeed?: Uint8Array | string
): BoardCommitment {
  if (grid.length !== TOTAL_CELLS) {
    throw new Error(`Grid must have exactly ${TOTAL_CELLS} cells, got ${grid.length}`);
  }

  const masterSeed =
    typeof optionalMasterSeed === 'string'
      ? hexToBytes(optionalMasterSeed)
      : optionalMasterSeed || generateMasterSeed();

  const rawLeaves: Uint8Array[] = new Array(TOTAL_CELLS);
  const saltsHex: string[] = new Array(TOTAL_CELLS);
  const level0Nodes: Uint8Array[] = new Array(TOTAL_CELLS);
  const shipIndices: number[] = [];

  const boardBytes = new Uint8Array(TOTAL_CELLS);
  for (let i = 0; i < TOTAL_CELLS; i++) {
    const isShip = grid[i] === 1;
    boardBytes[i] = isShip ? 1 : 0;
    if (isShip) shipIndices.push(i);

    const cellState = isShip ? 0x01 : 0x00;

    // Derive deterministic 31-byte salt from master seed + cell index
    const seedWithIndex = new Uint8Array(33);
    seedWithIndex.set(masterSeed, 0);
    seedWithIndex[32] = i;
    const saltHash = hashBlake2b256(seedWithIndex);
    const salt = saltHash.slice(0, 31);

    const rawLeaf = new Uint8Array(RAW_LEAF_LENGTH);
    rawLeaf[0] = cellState;
    rawLeaf.set(salt, 1);

    rawLeaves[i] = rawLeaf;
    saltsHex[i] = bytesToHex(salt);
    level0Nodes[i] = hashBlake2b256(rawLeaf);
  }

  // Build Merkle Tree from Level 0 to Level 6
  const tree: Uint8Array[][] = [level0Nodes];

  for (let level = 0; level < TREE_DEPTH; level++) {
    const currentLevelNodes = tree[level];
    const nextLevelNodes: Uint8Array[] = new Array(currentLevelNodes.length / 2);

    for (let i = 0; i < currentLevelNodes.length; i += 2) {
      const left = currentLevelNodes[i];
      const right = currentLevelNodes[i + 1];
      const combined = new Uint8Array(64);
      combined.set(left, 0);
      combined.set(right, 32);
      nextLevelNodes[i / 2] = hashBlake2b256(combined);
    }

    tree.push(nextLevelNodes);
  }

  const rootBytes = tree[TREE_DEPTH][0];
  const rootHex = bytesToHex(rootBytes);
  const masterSeedHex = bytesToHex(masterSeed);

  // 102-byte Geometry-Enforced Salted Board Payload:
  // - Bytes 0..63 (64B): Binary grid mask
  // - Bytes 64..69 (6B): Ship geometry descriptors [cStart, cDir, crStart, crDir, dStart, dDir]
  // - Bytes 70..101 (32B): CSPRNG master salt
  const saltedBoardPayload = new Uint8Array(102);
  saltedBoardPayload.set(boardBytes, 0);
  const geometry = extractShipGeometry(boardBytes);
  saltedBoardPayload.set(geometry, 64);
  saltedBoardPayload.set(masterSeed, 70);

  const boardHashBytes = hashBlake2b256(saltedBoardPayload);
  const boardHashHex = bytesToHex(boardHashBytes);

  return {
    rootHex,
    rootBytes,
    boardBytes,
    saltedBoardPayload,
    boardHashHex,
    boardHashBytes,
    rawLeaves,
    saltsHex,
    masterSeedHex,
    shipIndices,
    tree,
  };
}

/**
 * Extracts 6-byte compact geometry descriptor from a 64-cell grid
 * [carrierStart, carrierDir, cruiserStart, cruiserDir, destroyerStart, destroyerDir]
 * where dir = 0 (Horizontal) or 1 (Vertical)
 */
export function extractShipGeometry(grid: number[] | Uint8Array): Uint8Array {
  const remaining = Array.from(grid);
  const desc = new Uint8Array(6);

  const findShip = (len: number): { start: number; dir: number } | null => {
    // Check horizontal lines
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c <= 8 - len; c++) {
        const start = r * 8 + c;
        let match = true;
        for (let k = 0; k < len; k++) {
          if (remaining[start + k] !== 1) {
            match = false;
            break;
          }
        }
        if (match) {
          for (let k = 0; k < len; k++) remaining[start + k] = 0;
          return { start, dir: 0 };
        }
      }
    }
    // Check vertical lines
    for (let c = 0; c < 8; c++) {
      for (let r = 0; r <= 8 - len; r++) {
        const start = r * 8 + c;
        let match = true;
        for (let k = 0; k < len; k++) {
          if (remaining[start + k * 8] !== 1) {
            match = false;
            break;
          }
        }
        if (match) {
          for (let k = 0; k < len; k++) remaining[start + k * 8] = 0;
          return { start, dir: 1 };
        }
      }
    }
    return null;
  };

  const carrier = findShip(5);
  const cruiser = findShip(3);
  const destroyer = findShip(2);

  if (carrier) {
    desc[0] = carrier.start;
    desc[1] = carrier.dir;
  }
  if (cruiser) {
    desc[2] = cruiser.start;
    desc[3] = cruiser.dir;
  }
  if (destroyer) {
    desc[4] = destroyer.start;
    desc[5] = destroyer.dir;
  }

  return desc;
}

/**
 * Reconstructs exact canonical ShipConfig array with cells from a 64-element grid
 */
export function getShipsFromGrid(grid: number[] | Uint8Array): ShipConfig[] {
  if (!grid || grid.length !== TOTAL_CELLS) return [];
  const geom = extractShipGeometry(grid);
  const carrierStart = geom[0];
  const carrierDir = geom[1];
  const cruiserStart = geom[2];
  const cruiserDir = geom[3];
  const patrolStart = geom[4];
  const patrolDir = geom[5];

  const carrierCells = [0, 1, 2, 3, 4].map((k) => carrierStart + (carrierDir === 0 ? k : k * 8));
  const cruiserCells = [0, 1, 2].map((k) => cruiserStart + (cruiserDir === 0 ? k : k * 8));
  const patrolCells = [0, 1].map((k) => patrolStart + (patrolDir === 0 ? k : k * 8));

  return [
    { id: 'carrier', name: 'Supercarrier', length: 5, placed: true, orientation: carrierDir === 0 ? 'horizontal' : 'vertical', cells: carrierCells },
    { id: 'cruiser', name: 'Heavy Cruiser', length: 3, placed: true, orientation: cruiserDir === 0 ? 'horizontal' : 'vertical', cells: cruiserCells },
    { id: 'destroyer', name: 'Stealth Destroyer', length: 2, placed: true, orientation: patrolDir === 0 ? 'horizontal' : 'vertical', cells: patrolCells },
  ];
}

/**
 * Reconstructs a BoardCommitment from known grid and saltsHex
 */
export function reconstructCommitment(
  grid: number[],
  saltsHex: string[],
  masterSeedHex: string = ''
): BoardCommitment {
  const saltsBytes = saltsHex.map((s) => hexToBytes(s));
  const rawLeaves: Uint8Array[] = new Array(TOTAL_CELLS);
  const level0Nodes: Uint8Array[] = new Array(TOTAL_CELLS);
  const shipIndices: number[] = [];
  const boardBytes = new Uint8Array(TOTAL_CELLS);

  for (let i = 0; i < TOTAL_CELLS; i++) {
    const isShip = grid[i] === 1;
    boardBytes[i] = isShip ? 1 : 0;
    if (isShip) shipIndices.push(i);
    const cellState = isShip ? 0x01 : 0x00;
    const salt = saltsBytes[i];

    const rawLeaf = new Uint8Array(RAW_LEAF_LENGTH);
    rawLeaf[0] = cellState;
    rawLeaf.set(salt, 1);

    rawLeaves[i] = rawLeaf;
    level0Nodes[i] = hashBlake2b256(rawLeaf);
  }

  const tree: Uint8Array[][] = [level0Nodes];
  for (let level = 0; level < TREE_DEPTH; level++) {
    const currentLevelNodes = tree[level];
    const nextLevelNodes: Uint8Array[] = new Array(currentLevelNodes.length / 2);
    for (let i = 0; i < currentLevelNodes.length; i += 2) {
      const left = currentLevelNodes[i];
      const right = currentLevelNodes[i + 1];
      const combined = new Uint8Array(64);
      combined.set(left, 0);
      combined.set(right, 32);
      nextLevelNodes[i / 2] = hashBlake2b256(combined);
    }
    tree.push(nextLevelNodes);
  }

  const rootBytes = tree[TREE_DEPTH][0];
  const saltedBoardPayload = new Uint8Array(102);
  saltedBoardPayload.set(boardBytes, 0);
  const geometry = extractShipGeometry(boardBytes);
  saltedBoardPayload.set(geometry, 64);
  if (masterSeedHex && masterSeedHex.length === 64) {
    saltedBoardPayload.set(hexToBytes(masterSeedHex), 70);
  }
  const boardHashBytes = hashBlake2b256(saltedBoardPayload);
  const boardHashHex = bytesToHex(boardHashBytes);

  return {
    rootHex: bytesToHex(rootBytes),
    rootBytes,
    boardBytes,
    saltedBoardPayload,
    boardHashHex,
    boardHashBytes,
    rawLeaves,
    saltsHex,
    masterSeedHex,
    shipIndices,
    tree,
  };
}

/**
 * Verifies that a revealed Master Seed and declared ship indices produce the exact committed root
 * and contain EXACTLY 10 ship cells (100% Anti-Fraud Guarantee).
 */
export function verifyFleetIntegrity(
  masterSeedHex: string,
  shipIndices: number[],
  expectedRootHex: string
): boolean {
  if (shipIndices.length !== TOTAL_FLEET_HP) return false;

  const grid = new Array(TOTAL_CELLS).fill(0);
  for (const idx of shipIndices) {
    if (idx < 0 || idx >= TOTAL_CELLS) return false;
    grid[idx] = 1;
  }

  const reconstructed = generateBoardCommitment(grid, masterSeedHex);
  return reconstructed.rootHex.toLowerCase() === expectedRootHex.toLowerCase();
}

/**
 * Generates Merkle Proof for a single cell index (0 to 63).
 */
export function generateMerkleProof(
  cellIndex: number,
  rawLeaves: Uint8Array[],
  tree: Uint8Array[][]
): MerkleProof {
  if (cellIndex < 0 || cellIndex >= TOTAL_CELLS) {
    throw new Error(`Invalid cell index: ${cellIndex}. Must be 0-63.`);
  }

  const rawLeaf = rawLeaves[cellIndex];
  const isShip = rawLeaf[0] === 0x01;
  const siblings: Uint8Array[] = [];

  let currentIndex = cellIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const isEven = currentIndex % 2 === 0;
    const siblingIndex = isEven ? currentIndex + 1 : currentIndex - 1;
    siblings.push(tree[level][siblingIndex]);
    currentIndex = Math.floor(currentIndex / 2);
  }

  const proofBytes = new Uint8Array(PROOF_LENGTH);
  proofBytes.set(rawLeaf, 0);
  for (let i = 0; i < TREE_DEPTH; i++) {
    proofBytes.set(siblings[i], RAW_LEAF_LENGTH + i * SIBLING_HASH_LENGTH);
  }

  return {
    cellIndex,
    isShip,
    rawLeaf,
    siblings,
    proofBytes,
    proofHex: bytesToHex(proofBytes),
  };
}

/**
 * Verifies a 224-byte Merkle proof on client side.
 */
export function verifyMerkleProof(
  cellIndex: number,
  proofBytes: Uint8Array,
  expectedRoot: Uint8Array
): { valid: boolean; isShip: boolean } {
  if (proofBytes.length !== PROOF_LENGTH) return { valid: false, isShip: false };

  const rawLeaf = proofBytes.slice(0, RAW_LEAF_LENGTH);
  const isShip = rawLeaf[0] === 0x01;
  let currentHash = hashBlake2b256(rawLeaf);

  let currentIndex = cellIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const siblingOffset = RAW_LEAF_LENGTH + level * SIBLING_HASH_LENGTH;
    const siblingHash = proofBytes.slice(siblingOffset, siblingOffset + SIBLING_HASH_LENGTH);

    const combined = new Uint8Array(64);
    if (currentIndex % 2 === 0) {
      combined.set(currentHash, 0);
      combined.set(siblingHash, 32);
    } else {
      combined.set(siblingHash, 0);
      combined.set(currentHash, 32);
    }

    currentHash = hashBlake2b256(combined);
    currentIndex = Math.floor(currentIndex / 2);
  }

  const valid = bytesToHex(currentHash) === bytesToHex(expectedRoot);
  return { valid, isShip };
}

export function normalizeRootHex(raw: string): string {
  if (!raw) return '';
  let clean = String(raw).trim().toLowerCase();
  if (clean.startsWith('0x')) clean = clean.slice(2);
  while (clean.startsWith('0e20') || clean.startsWith('1302') || clean.startsWith('1102') || clean.startsWith('1a02')) {
    if (clean.startsWith('0e20')) clean = clean.slice(4);
    if (clean.startsWith('1302')) clean = clean.slice(4);
    if (clean.startsWith('1102')) clean = clean.slice(4);
    if (clean.startsWith('1a02')) clean = clean.slice(4);
  }
  if (clean.length === 64) return clean;
  if (clean.length > 64) return clean.slice(clean.length - 64);
  return clean;
}

/**
 * LocalStorage caching for master seeds, salts, and ship configurations
 */
export function saveBoardSalts(
  gameIdOrRoot: string,
  saltsHex: string[],
  grid: number[],
  masterSeedHex?: string,
  userAddress?: string
) {
  if (typeof window === 'undefined') return;
  const cleanRoot = normalizeRootHex(gameIdOrRoot);
  let boardHash = '';
  let root = '';
  try {
    const com = generateBoardCommitment(grid, masterSeedHex);
    boardHash = normalizeRootHex(com.boardHashHex);
    root = normalizeRootHex(com.rootHex);
  } catch {}

  const data = {
    gameId: cleanRoot,
    rootHex: root,
    boardHashHex: boardHash,
    saltsHex,
    grid,
    masterSeedHex,
    timestamp: Date.now(),
  };
  const json = JSON.stringify(data);
  if (cleanRoot) localStorage.setItem(`ergo_battleships_${cleanRoot}`, json);
  if (boardHash) localStorage.setItem(`ergo_battleships_${boardHash}`, json);
  if (root) localStorage.setItem(`ergo_battleships_${root}`, json);
  if (userAddress) {
    localStorage.setItem(`ergo_battleships_user_${userAddress.toLowerCase()}`, json);
  }
  localStorage.setItem('ergo_battleships_last_placed', json);
}

export function loadBoardSalts(
  gameIdOrRoot: string,
  userAddress?: string
): {
  saltsHex: string[];
  grid: number[];
  masterSeedHex?: string;
  rootHex?: string;
  boardHashHex?: string;
} | null {
  if (typeof window === 'undefined') return null;
  const cleanRoot = normalizeRootHex(gameIdOrRoot);

  if (cleanRoot) {
    // 1. Try exact normalized key
    const exact = localStorage.getItem(`ergo_battleships_${cleanRoot}`);
    if (exact) {
      try {
        const parsed = JSON.parse(exact);
        if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
          return parsed;
        }
      } catch {}
    }

    // 2. Scan all localStorage items and match by cryptographic Merkle root OR boardHashHex
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('ergo_battleships_') || k.startsWith('ergo_'))) {
          const val = localStorage.getItem(k);
          if (val) {
            try {
              const parsed = JSON.parse(val);
              if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
                if (
                  (parsed.rootHex && normalizeRootHex(parsed.rootHex) === cleanRoot) ||
                  (parsed.boardHashHex && normalizeRootHex(parsed.boardHashHex) === cleanRoot) ||
                  (parsed.gameId && normalizeRootHex(parsed.gameId) === cleanRoot)
                ) {
                  return parsed;
                }
                const com = generateBoardCommitment(parsed.grid, parsed.masterSeedHex);
                const rHex = normalizeRootHex(com.rootHex);
                const bHex = normalizeRootHex(com.boardHashHex);
                if (rHex === cleanRoot || bHex === cleanRoot) {
                  return parsed;
                }
              }
            } catch {}
          }
        }
      }
    } catch {}

    // 3. Fallback to user address key
    if (userAddress) {
      const userSaved = localStorage.getItem(`ergo_battleships_user_${userAddress.toLowerCase()}`);
      if (userSaved) {
        try {
          const parsed = JSON.parse(userSaved);
          if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
            const com = generateBoardCommitment(parsed.grid, parsed.masterSeedHex);
            const rHex = normalizeRootHex(com.rootHex);
            const bHex = normalizeRootHex(com.boardHashHex);
            if (rHex === cleanRoot || bHex === cleanRoot) {
              return parsed;
            }
          }
        } catch {}
      }
    }

    // 4. Fallback to last placed board
    const fallback = localStorage.getItem('ergo_battleships_last_placed');
    if (fallback) {
      try {
        const parsed = JSON.parse(fallback);
        if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
          const com = generateBoardCommitment(parsed.grid, parsed.masterSeedHex);
          const rHex = normalizeRootHex(com.rootHex);
          const bHex = normalizeRootHex(com.boardHashHex);
          if (rHex === cleanRoot || bHex === cleanRoot) {
            return parsed;
          }
        }
      } catch {}
    }

    return null;
  }

  // If no root provided, try last placed fallback
  const lastPlaced = localStorage.getItem('ergo_battleships_last_placed');
  if (lastPlaced) {
    try {
      const parsed = JSON.parse(lastPlaced);
      if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
        return parsed;
      }
    } catch {}
  }

  return null;
}

/**
 * Robust opponent board loader for local matches / shared localStorage
 */
export function loadOpponentBoard(
  enemyRootHex: string,
  myRootHex?: string
): { saltsHex: string[]; grid: number[]; masterSeedHex?: string; rootHex?: string; boardHashHex?: string } | null {
  if (typeof window === 'undefined') return null;
  const cleanEnemy = normalizeRootHex(enemyRootHex);
  const cleanMy = myRootHex ? normalizeRootHex(myRootHex) : '';

  // 1. Try exact match on enemyRoot
  if (cleanEnemy) {
    const direct = loadBoardSalts(cleanEnemy);
    if (direct?.grid && Array.isArray(direct.grid) && direct.grid.length === 64) {
      return direct;
    }
  }

  // 2. Scan all boards in localStorage and find the valid board that is not myRoot
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('ergo_battleships_') || k.startsWith('ergo_'))) {
        const val = localStorage.getItem(k);
        if (val) {
          try {
            const parsed = JSON.parse(val);
            if (parsed && Array.isArray(parsed.grid) && parsed.grid.length === 64) {
              const bHex = normalizeRootHex(parsed.boardHashHex || '');
              const rHex = normalizeRootHex(parsed.rootHex || '');
              if (cleanEnemy && (bHex === cleanEnemy || rHex === cleanEnemy)) {
                return parsed;
              }
              const shipCount = parsed.grid.filter((x: number) => x === 1).length;
              if (shipCount === 10) {
                if (cleanMy && bHex !== cleanMy && rHex !== cleanMy) {
                  return parsed;
                }
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Persists match shot history into localStorage to instantly restore hits/misses upon reload or resume
 */
export function saveMatchShotHistory(
  matchKey: string,
  p1Shots: Record<number, 'hit' | 'miss' | 'pending'>,
  p2Shots: Record<number, 'hit' | 'miss' | 'pending'>
) {
  if (typeof window === 'undefined' || !matchKey) return;
  try {
    const rawExisting =
      localStorage.getItem(`ergo_battleships_shots_v2_${matchKey}`) ||
      (normalizeRootHex(matchKey) ? localStorage.getItem(`ergo_battleships_shots_v2_${normalizeRootHex(matchKey)}`) : null);
    let existingP1 = {};
    let existingP2 = {};
    if (rawExisting) {
      try {
        const parsed = JSON.parse(rawExisting);
        if (parsed?.p1Shots) existingP1 = parsed.p1Shots;
        if (parsed?.p2Shots) existingP2 = parsed.p2Shots;
      } catch {}
    }

    const mergedP1: Record<number, 'hit' | 'miss' | 'pending'> = { ...existingP1 };
    Object.entries(p1Shots || {}).forEach(([k, v]) => {
      const idx = Number(k);
      // NEVER downgrade 'hit' or 'miss' to 'pending'
      if (v === 'hit' || v === 'miss' || !mergedP1[idx]) {
        mergedP1[idx] = v;
      }
    });

    const mergedP2: Record<number, 'hit' | 'miss' | 'pending'> = { ...existingP2 };
    Object.entries(p2Shots || {}).forEach(([k, v]) => {
      const idx = Number(k);
      // NEVER downgrade 'hit' or 'miss' to 'pending'
      if (v === 'hit' || v === 'miss' || !mergedP2[idx]) {
        mergedP2[idx] = v;
      }
    });

    const payload = JSON.stringify({
      p1Shots: mergedP1,
      p2Shots: mergedP2,
      updatedAt: Date.now(),
    });
    localStorage.setItem(`ergo_battleships_shots_v2_${matchKey}`, payload);
    const cleanKey = normalizeRootHex(matchKey);
    if (cleanKey && cleanKey !== matchKey) {
      localStorage.setItem(`ergo_battleships_shots_v2_${cleanKey}`, payload);
    }
  } catch {}
}

/**
 * Instantly loads cached shot history from localStorage
 */
export function loadMatchShotHistory(
  matchKey: string
): { p1Shots: Record<number, 'hit' | 'miss' | 'pending'>; p2Shots: Record<number, 'hit' | 'miss' | 'pending'> } | null {
  if (typeof window === 'undefined' || !matchKey) return null;
  try {
    const cleanKey = normalizeRootHex(matchKey);
    const raw =
      localStorage.getItem(`ergo_battleships_shots_v2_${matchKey}`) ||
      (cleanKey ? localStorage.getItem(`ergo_battleships_shots_v2_${cleanKey}`) : null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.p1Shots === 'object' && typeof parsed.p2Shots === 'object') {
        return {
          p1Shots: parsed.p1Shots || {},
          p2Shots: parsed.p2Shots || {},
        };
      }
    }

    // Fallback search across localStorage keys
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('ergo_battleships_shots_v2_')) {
        if (key.includes(matchKey) || (cleanKey && cleanKey.length >= 8 && key.includes(cleanKey))) {
          const item = localStorage.getItem(key);
          if (item) {
            const parsed = JSON.parse(item);
            if (parsed && typeof parsed.p1Shots === 'object' && typeof parsed.p2Shots === 'object') {
              return {
                p1Shots: parsed.p1Shots || {},
                p2Shots: parsed.p2Shots || {},
              };
            }
          }
        }
      }
    }
  } catch {}
  return null;
}
