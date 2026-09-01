export interface ShipConfig {
  id: string;
  name: string;
  length: number;
  placed: boolean;
  orientation: 'horizontal' | 'vertical';
  cells: number[]; // Grid indices 0..63
}

export const FLEET_SHIPS: Omit<ShipConfig, 'placed' | 'orientation' | 'cells'>[] = [
  { id: 'carrier', name: 'Supercarrier', length: 5 },
  { id: 'cruiser', name: 'Heavy Cruiser', length: 3 },
  { id: 'destroyer', name: 'Stealth Destroyer', length: 2 },
];

export const TOTAL_FLEET_HP = 10; // 5 + 3 + 2

export type CellStateOwn = 'water' | 'ship' | 'hit' | 'miss';
export type CellStateEnemy = 'unfired' | 'selected' | 'hit' | 'miss';

export interface GameSession {
  gameId: string;
  isHost: boolean; // Player 1 (Host) vs Player 2 (Challenger)
  playerRole: 'P1' | 'P2';
  wagerNanoErg: bigint;
  myGrid: number[]; // 64 array (0 or 1)
  myBoardRootHex: string;
  saltsHex: string[];
  enemyBoardRootHex?: string;
  myHitsSuffered: number; // Max 10
  enemyHitsLanded: number; // Max 10
  currentPhase: number; // 0 or 1
  isMyTurn: boolean;
  lastIncomingSalvo?: number[];
  isSelfPlay?: boolean;
  timeoutHeight?: number;
  creationHeight?: number;
  p1History?: number[];
  p2History?: number[];
  confirmedBoxId?: string;
  p1Address?: string;
  p2Address?: string;
  opponentAddress?: string;
  status: 'SETUP' | 'LOBBY_WAITING' | 'BATTLE_ACTIVE' | 'BATTLE_MEMPOOL' | 'BATTLE_ANIMATING' | 'GAME_OVER';
  winner?: 'P1' | 'P2' | 'TIE' | 'TIMEOUT';
  lastSunkCode?: number; // 0=None, 1=Patrol, 2=Cruiser, 3=Carrier
}

export interface AnimationEvent {
  coordinates: number[];
  results: ('hit' | 'miss')[];
  timestamp: number;
}

/**
 * Board coordinate labels.
 *
 * Rows are lettered A–H down the left edge and columns numbered 1–8 across the top, which
 * is the convention every paper Battleship board uses — you read the letter first, then the
 * number, exactly as the label is spoken.
 *
 * The cell index itself is unchanged and stays row-major (`row = idx / 8`, `col = idx % 8`);
 * only the labelling differs. Every coordinate shown to a player must come from
 * {@link formatCell} so the grid headers and the written read-outs can never disagree.
 */
export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export const COLUMN_LABELS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Formats a 0–63 cell index as a player-facing coordinate, e.g. 6 -> "A7". */
export function formatCell(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 63) return '??';
  return `${ROW_LABELS[Math.floor(index / 8)]}${(index % 8) + 1}`;
}

/** Formats a list of cell indices, e.g. "A7, B1, C3". */
export function formatCells(indices: number[]): string {
  return (indices || []).map(formatCell).join(', ');
}
