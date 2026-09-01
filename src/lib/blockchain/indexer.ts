import { ErgoAddress, type Box, type Amount } from '@fleet-sdk/core';
import { parse } from '@fleet-sdk/serializer';
import { hexToBytes } from '@noble/hashes/utils.js';
import { blake2b256 } from '@fleet-sdk/crypto';
import { normalizeRootHex, loadMatchShotHistory, loadBoardSalts } from '@/lib/crypto/merkle';
import { getLobbyErgoTree, getBattleshipsErgoTree, getBattleshipsAddress, getLobbyAddress, extractRegisterHex, extractGroupElements } from './fleet';

/**
 * Node used when the player has not set one in Network Settings.
 * See {@link FALLBACK_NODE_URLS} for the full priority order.
 */
/** Coerces a decoded register element to hex, whatever shape the parser handed back. */
function bytesToHexSafe(v: any): string {
  if (typeof v === 'string') return v;
  try {
    return Array.from(v as ArrayLike<number>).map((b) => Number(b).toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

export const DEFAULT_NODE_URL = 'https://node.sigmaspace.io';

/**
 * Nodes tried, in order, when the player's configured node cannot answer.
 *
 * 213.239.193.208 is deliberately last: it is the least reliable of the three, and being
 * plain HTTP it is blocked outright as mixed content on an HTTPS page. The two ahead of it
 * are HTTPS, respond faster, and both serve the `/blockchain/*` indexer routes.
 */
export const FALLBACK_NODE_URLS = [
  'https://node.sigmaspace.io',
  'https://ergo-node-1.eutxo.de',
  'http://213.239.193.208:9053',
];

export class NetworkConfig {
  private static nodeUrl: string = DEFAULT_NODE_URL;

  public static getNodeUrl(): string {
    if (typeof window !== 'undefined') {
      let saved = localStorage.getItem('ergoships_node_url');
      if (saved) {
        saved = saved.trim().replace(/\/+$/, '');
        if (!saved.startsWith('http://') && !saved.startsWith('https://')) {
          saved = saved.includes('localhost') || /^(\d{1,3}\.){3}\d{1,3}/.test(saved)
            ? `http://${saved}`
            : `https://${saved}`;
        }
        return saved;
      }
    }
    let current = this.nodeUrl.replace(/\/+$/, '');
    if (!current.startsWith('http://') && !current.startsWith('https://')) {
      current = current.includes('localhost') || /^(\d{1,3}\.){3}\d{1,3}/.test(current)
        ? `http://${current}`
        : `https://${current}`;
    }
    return current;
  }

  public static setNodeUrl(url: string): void {
    let clean = (url || DEFAULT_NODE_URL).trim().replace(/\/+$/, '');
    if (clean && !clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = clean.includes('localhost') || /^(\d{1,3}\.){3}\d{1,3}/.test(clean)
        ? `http://${clean}`
        : `https://${clean}`;
    }
    this.nodeUrl = clean;
    if (typeof window !== 'undefined') {
      localStorage.setItem('ergoships_node_url', clean);
    }
  }

  public static resetDefaults(): void {
    this.nodeUrl = DEFAULT_NODE_URL;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('ergoships_node_url');
    }
  }
}

export const ERGO_GRAPHQL_URL = 'https://graphql.ergoplatform.com/';

/** Next.js proxy route that forwards read-only Ergo node calls from the browser. */
export const NODE_PROXY_BASE = '/api/node';

/** Next.js routes that run the historical indexer server-side. */
export const INDEXER_API_BASE = '/api/indexer';

export function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Ordered list of nodes to try for a request: the player's configured node first, then the
 * shared fallbacks. node.ergopool.io is deliberately absent — it answers `/info` but returns
 * 403 for every `/blockchain/*` indexer route, so it can never serve historical data.
 */
export function resolveNodeUrls(preferred?: string): string[] {
  const candidates = [
    (preferred || '').trim().replace(/\/+$/, ''),
    NetworkConfig.getNodeUrl(),
    ...FALLBACK_NODE_URLS,
  ].filter(Boolean);
  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}

/**
 * Builds a URL that routes an Ergo node path through the Next.js proxy.
 *
 * Reserved for the historical indexer, where a ~60-request fan-out has to happen somewhere
 * the browser's per-host connection cap does not apply. Normal gameplay must NOT use this —
 * see {@link fetchFromNode}.
 */
export function nodeEndpoint(nodeBaseUrl: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (!isBrowserRuntime()) return `${nodeBaseUrl}${clean}`;
  const [pathname, search] = clean.split('?');
  const params = new URLSearchParams(search || '');
  params.set('node', nodeBaseUrl);
  return `${NODE_PROXY_BASE}${pathname}?${params.toString()}`;
}

/**
 * Remembers whether this browser can reach a given node directly.
 *
 * Cleared on reload, which is what we want: it is a property of this device and network,
 * not of the node.
 */
const directNodeReachable = new Map<string, boolean>();

/**
 * Fetches an Ergo node path from the player's own browser.
 *
 * Direct is the default and the normal case — gameplay traffic must not flow through the
 * app server, or a hundred concurrent players become a hundred players' worth of polling on
 * one box. The proxy is a fallback for the cases where the browser genuinely cannot make the
 * call itself: a LAN node opened from a phone, or a plain-HTTP node on an HTTPS page. The
 * outcome is cached per node, so a working node is only ever contacted directly and a
 * broken one only costs a single failed attempt per page load.
 */
export async function fetchFromNode(
  nodeUrl: string,
  path: string,
  opts: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const { method = 'GET', body, headers, timeoutMs = 6000 } = opts;
  const build = () => ({
    method,
    body,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!isBrowserRuntime()) return fetch(`${nodeUrl}${clean}`, build());

  const known = directNodeReachable.get(nodeUrl);
  if (known !== false) {
    try {
      const res = await fetch(`${nodeUrl}${clean}`, build());
      directNodeReachable.set(nodeUrl, true);
      return res;
    } catch (err) {
      // A node that has answered before is reachable; this is a genuine request failure
      // (timeout, node down) and must not be retried through the server.
      if (known === true) throw err;
      directNodeReachable.set(nodeUrl, false);
      console.warn(`Node ${nodeUrl} is not reachable from this browser; falling back to the app proxy.`);
    }
  }

  return fetch(nodeEndpoint(nodeUrl, clean), build());
}

/**
 * Runs `fn` over `items` with a bounded number of in-flight requests.
 * Public Ergo nodes refuse (ECONNREFUSED) a large simultaneous burst, and browsers queue
 * anything past 6 per host while `AbortSignal.timeout` keeps counting down, so an
 * unbounded `Promise.all` fan-out loses most of its results.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Server-side TTL cache. Scanning the contract's whole history costs ~60 node requests, and
 * the leaderboard and every player's match history all need the same scan, so the result is
 * shared for a short window. Caching the promise also collapses concurrent callers into one
 * scan, which matters because public nodes refuse bursts.
 */
const settlementTxCache = new Map<string, { expiresAt: number; value: Promise<any[]> }>();
const SETTLEMENT_TX_TTL_MS = 5 * 60_000;

function cachedSettlementTxs(key: string, load: () => Promise<any[]>): Promise<any[]> {
  const now = Date.now();
  const hit = settlementTxCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = load().catch((err) => {
    settlementTxCache.delete(key);
    throw err;
  });
  settlementTxCache.set(key, { expiresAt: now + SETTLEMENT_TX_TTL_MS, value });
  return value;
}

export interface GameBoxState {
  box: Box<Amount>;
  p1PublicKey?: string;
  p2PublicKey?: string;
  p1Address?: string;
  p2Address?: string;
  p1BoardRoot?: string;
  p2BoardRoot?: string;
  phase: number;
  p1Hits: number;
  p2Hits: number;
  pendingTargets: number[];
  timeoutHeight: number;
  isMempoolPending: boolean;
  spendingTxId?: string;
  p1History?: number[];
  p2History?: number[];
  lastSunkCode?: number;
}

export interface LobbyBoxState {
  box: Box<Amount>;
  p1Address: string;
  p1PublicKey: string;
  p1BoardRoot: string;
  firstSalvo: number[];
  wagerNanoErg: bigint;
  isMempool?: boolean;
  timeoutDuration?: number;
}

export class ErgoIndexer {
  /**
   * Fetches current blockchain height using configured node
   */
  public static async getCurrentHeight(): Promise<number> {
    // Configured node first, then the shared fallbacks.
    for (const nodeUrl of resolveNodeUrls()) {
      try {
        const res = await fetchFromNode(nodeUrl, '/info', { timeoutMs: 6000 });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.fullHeight === 'number') return data.fullHeight;
          if (typeof data.headersHeight === 'number') return data.headersHeight;
          if (typeof data.height === 'number') return data.height;
        }
      } catch (err) {}
    }
    return 1863570;
  }

  /**
   * Fetches unspent boxes for a given address with real-time node priority and fallback
   */
  public static async getUnspentBoxesByAddress(address: string): Promise<Box<Amount>[]> {
    for (const nodeUrl of resolveNodeUrls()) {
      try {
        const nodeRes = await fetchFromNode(nodeUrl, '/blockchain/box/unspent/byAddress?offset=0&limit=100', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(address),
          timeoutMs: 10000,
        });
        if (nodeRes.ok) {
          const nodeBoxes = await nodeRes.json();
          if (Array.isArray(nodeBoxes)) {
            return nodeBoxes.map((b: any) => ({
              ...b,
              boxId: b.boxId || b.id,
              value: b.value?.toString() || '0',
              assets: b.assets || [],
              ergoTree: b.ergoTree || '',
              creationHeight: b.creationHeight || b.inclusionHeight || 1860000,
              additionalRegisters: b.additionalRegisters || {},
              transactionId: b.transactionId || (b.boxId ? b.boxId.slice(0, 64) : '00'.repeat(32)),
              index: b.index ?? 0,
            }));
          }
        }
      } catch (err) {
        console.warn(`Node unspent boxes fetch failed for ${address} at ${nodeUrl}:`, err);
      }
    }
    return [];
  }

  /**
   * Fetches single box by ID with fallback
   */
  public static async getBoxById(boxId: string): Promise<Box<Amount> | null> {
    for (const nodeUrl of resolveNodeUrls()) {
      try {
        const nodeRes = await fetch(`${nodeUrl}/blockchain/box/byId/${boxId}`, { signal: AbortSignal.timeout(3500) });
        if (nodeRes.ok) return await nodeRes.json();
      } catch (err) {}
    }
    return null;
  }

  /**
   * Checks if a box is currently being spent by a transaction in the Mempool.
   * This determines whether the game is in the MEMPOOL PHASE.
   */
  public static async checkMempoolForSpendingTx(boxId: string): Promise<{ isPending: boolean; txId?: string }> {
    try {
      const nodeRes = await fetch(`${NetworkConfig.getNodeUrl()}/transactions/unconfirmed`);
      if (nodeRes.ok) {
        const txs = await nodeRes.json();
        for (const tx of txs || []) {
          if (tx.inputs?.some((inp: any) => inp.boxId === boxId)) {
            return { isPending: true, txId: tx.id };
          }
        }
      }
    } catch (err) {
      console.warn('Node mempool check failed:', err);
    }
    return { isPending: false };
  }

  /**
   * Parses Battleships Game Box registers into strongly-typed GameBoxState
   */
  public static parseGameBox(
    box: Box<Amount>,
    isMempoolPending = false,
    spendingTxId?: string,
    allowSpent = false,
  ): GameBoxState | null {
    const boxVal = BigInt(box.value || 0);
    // Minimum 1v1 battle pot is 0.002 ERG (2x 0.001 ERG wager minus tx fees). Discards dust boxes.
    if (boxVal < 2000000n) {
      return null;
    }

    // Reject if spending/spent indicator is present.
    // Historical indexing (leaderboard / match history) reads exactly these already-spent
    // boxes, so it opts in via allowSpent.
    if (!allowSpent && ((box as any).spentTransactionId || (box as any).spendingTransactionId || (box as any).spent === true)) {
      return null;
    }

    const r4 = box.additionalRegisters?.R4;
    const r5 = box.additionalRegisters?.R5;
    const r6 = box.additionalRegisters?.R6;
    const r7 = box.additionalRegisters?.R7;
    const r8 = box.additionalRegisters?.R8;
    const r9 = box.additionalRegisters?.R9;

    let p1Pk = '';
    let p2Pk = '';
    let p1Addr = '';
    let p2Addr = '';
    let p1Root = '';
    let p2Root = '';

    // Parse R4: [p1Pk, p2Pk, devPk]
    const r4Hex = typeof r4 === 'string' ? (r4.startsWith('0x') ? r4.slice(2) : r4) : ((r4 as any)?.serializedValue?.replace(/^0x/, '') || '');
    if (r4 && typeof r4 === 'object' && Array.isArray((r4 as any).renderedValue)) {
      p1Pk = (r4 as any).renderedValue[0] || '';
      p2Pk = (r4 as any).renderedValue[1] || '';
    } else if (r4 && typeof r4 === 'object' && typeof (r4 as any).renderedValue === 'string') {
      const clean = (r4 as any).renderedValue.replace(/[\[\]\s]/g, '');
      const parts = clean.split(',');
      if (parts[0] && parts[0].length === 66) p1Pk = parts[0];
      if (parts[1] && parts[1].length === 66) p2Pk = parts[1];
    }
    if ((!p1Pk || !p2Pk) && r4Hex) {
      if ((r4Hex.startsWith('1303') || r4Hex.startsWith('1103')) && r4Hex.length >= 136) {
        p1Pk = r4Hex.slice(4, 70);
        p2Pk = r4Hex.slice(70, 136);
      } else if (r4Hex.length >= 132) {
        p1Pk = r4Hex.slice(0, 66);
        p2Pk = r4Hex.slice(66, 132);
      }
    }
    try {
      if (p1Pk && p1Pk.length === 66) p1Addr = ErgoAddress.fromPublicKey(p1Pk).encode();
    } catch {}
    try {
      if (p2Pk && p2Pk.length === 66) p2Addr = ErgoAddress.fromPublicKey(p2Pk).encode();
    } catch {}

    // Parse R5: [p1Root, p2Root, (optional p1BoardHash, p2BoardHash)]
    const r5Hex = typeof r5 === 'string' ? (r5.startsWith('0x') ? r5.slice(2) : r5) : ((r5 as any)?.serializedValue?.replace(/^0x/, '') || '');
    if (r5 && typeof r5 === 'object' && Array.isArray((r5 as any).renderedValue)) {
      p1Root = normalizeRootHex((r5 as any).renderedValue[0]);
      p2Root = normalizeRootHex((r5 as any).renderedValue[1]);
    } else if (r5 && typeof r5 === 'object' && typeof (r5 as any).renderedValue === 'string') {
      const clean = (r5 as any).renderedValue.replace(/[\[\]\s]/g, '').split(',');
      if (clean[0]) p1Root = normalizeRootHex(clean[0]);
      if (clean[1]) p2Root = normalizeRootHex(clean[1]);
    } else if (r5Hex) {
      if ((r5Hex.startsWith('1a0420') || r5Hex.startsWith('130420') || r5Hex.startsWith('110420') ||
           r5Hex.startsWith('1a0220') || r5Hex.startsWith('130220') || r5Hex.startsWith('110220')) && r5Hex.length >= 136) {
        p1Root = r5Hex.slice(6, 70);
        p2Root = r5Hex.slice(72, 136);
      } else if ((r5Hex.startsWith('1302') || r5Hex.startsWith('1102') || r5Hex.startsWith('1a02') ||
                  r5Hex.startsWith('1a04') || r5Hex.startsWith('1304') || r5Hex.startsWith('1104')) && r5Hex.length >= 136) {
        p1Root = r5Hex.slice(6, 70);
        p2Root = r5Hex.slice(72, 136);
      } else if (r5Hex.length >= 128) {
        p1Root = r5Hex.slice(0, 64);
        p2Root = r5Hex.slice(64, 128);
      }
    }

    let phase = 0;
    let p1Hits = 0;
    let p2Hits = 0;
    let pendingTargets: number[] = [];
    
    let timeoutHeight = 0;
    let lastSunkCode = 0;

    // Parse R6: [phase, p1Hits, p2Hits, optional sunkCode]
    if (r6 && typeof r6 === 'object' && Array.isArray((r6 as any).renderedValue)) {
      const vals = (r6 as any).renderedValue;
      phase = Number(vals[0] ?? 0);
      p1Hits = Number(vals[1] ?? 0);
      p2Hits = Number(vals[2] ?? 0);
      lastSunkCode = Number(vals[3] ?? 0);
    } else {
      try {
        const hex = extractRegisterHex(r6);
        if (hex) {
          const parsed = parse<number[]>(hex);
          if (Array.isArray(parsed) && parsed.length >= 3) {
            phase = Number(parsed[0] ?? 0);
            p1Hits = Number(parsed[1] ?? 0);
            p2Hits = Number(parsed[2] ?? 0);
            lastSunkCode = Number(parsed[3] ?? 0);
          }
        }
      } catch (e) {
        console.warn('Failed to parse R6', e);
      }
    }

    // Parse R7: [incomingSalvo]
    if (r7 && typeof r7 === 'object' && Array.isArray((r7 as any).renderedValue)) {
      pendingTargets = (r7 as any).renderedValue.map(Number);
    } else {
      try {
        const r7Hex = extractRegisterHex(r7);
        if (r7Hex) {
          const parsed = parse<number[]>(r7Hex);
          if (Array.isArray(parsed)) {
            pendingTargets = parsed.map(Number);
          }
        }
      } catch (e) {
        console.warn('Failed to parse R7 with Fleet SDK', e);
      }
    }

    // Parse R8: [p1History, p2History] (Coll[Coll[Byte]])
    let p1History = Array(64).fill(0);
    let p2History = Array(64).fill(0);
    if (r8 && typeof r8 === 'object' && Array.isArray((r8 as any).renderedValue)) {
      const vals = (r8 as any).renderedValue;
      if (typeof vals[0] === 'string' && vals[0].length >= 128) {
        p1History = Array.from(hexToBytes(vals[0].slice(0, 128)));
      } else if (Array.isArray(vals[0])) {
        p1History = vals[0].map(Number);
      }
      if (typeof vals[1] === 'string' && vals[1].length >= 128) {
        p2History = Array.from(hexToBytes(vals[1].slice(0, 128)));
      } else if (Array.isArray(vals[1])) {
        p2History = vals[1].map(Number);
      }
    } else {
      try {
        const hex = extractRegisterHex(r8);
        if (hex) {
          const decoded = parse<any>(hex);
          if (Array.isArray(decoded) && decoded.length === 2) {
            if (decoded[0] && decoded[0].length === 64) p1History = Array.from(decoded[0]).map(Number);
            if (decoded[1] && decoded[1].length === 64) p2History = Array.from(decoded[1]).map(Number);
          }
        }
      } catch {}
    }

    // Parse R9: [timeoutHeight, timeoutBlocks]
    if (r9 && typeof r9 === 'object' && Array.isArray((r9 as any).renderedValue)) {
      timeoutHeight = Number((r9 as any).renderedValue[0]);
    } else {
      try {
        const r9Hex = extractRegisterHex(r9);
        if (r9Hex) {
          const parsed = parse<number[]>(r9Hex);
          if (Array.isArray(parsed) && parsed.length > 0) {
            timeoutHeight = Number(parsed[0]);
          }
        }
      } catch (e) {
        console.warn('Failed to parse R9', e);
      }
    }

    return {
      box,
      p1PublicKey: p1Pk,
      p2PublicKey: p2Pk,
      p1Address: p1Addr,
      p2Address: p2Addr,
      p1BoardRoot: p1Root,
      p2BoardRoot: p2Root,
      phase,
      p1Hits,
      p2Hits,
      pendingTargets,
      timeoutHeight,
      isMempoolPending,
      spendingTxId,
      p1History,
      p2History,
      lastSunkCode,
    };
  }

  /**
   * Parses Lobby Box registers into strongly-typed LobbyBoxState
   */
  public static parseLobbyBox(b: any, isMempool = false): LobbyBoxState | null {
    const boxVal = BigInt(b.value || 0);
    if (boxVal < 1000000n) {
      return null;
    }
    try {
      let p1Pk = '';
      const r4 = b.additionalRegisters?.R4;

      if (r4 && typeof r4 === 'object') {
        if (Array.isArray((r4 as any).renderedValue) && (r4 as any).renderedValue[0]) {
          p1Pk = (r4 as any).renderedValue[0];
        } else if (typeof (r4 as any).renderedValue === 'string') {
          const clean = (r4 as any).renderedValue.replace(/[\[\]\s]/g, '');
          const parts = clean.split(',');
          if (parts[0] && parts[0].length === 66) {
            p1Pk = parts[0];
          }
        }
        if (!p1Pk && typeof (r4 as any).serializedValue === 'string') {
          const hex = (r4 as any).serializedValue.startsWith('0x') ? (r4 as any).serializedValue.slice(2) : (r4 as any).serializedValue;
          if ((hex.startsWith('1302') || hex.startsWith('1102')) && hex.length >= 70) {
            p1Pk = hex.slice(4, 70);
          } else if (hex.length >= 136) {
            p1Pk = hex.slice(4, 70);
          } else if (hex.length === 66) {
            p1Pk = hex;
          }
        }
      } else if (typeof r4 === 'string') {
        const hex = r4.startsWith('0x') ? r4.slice(2) : r4;
        if ((hex.startsWith('1302') || hex.startsWith('1102')) && hex.length >= 70) {
          p1Pk = hex.slice(4, 70);
        } else if (hex.length >= 136) {
          p1Pk = hex.slice(4, 70);
        } else if (hex.length === 66) {
          p1Pk = hex;
        }
      }

      let addr = '';
      try {
        if (p1Pk && p1Pk.length === 66) {
          addr = ErgoAddress.fromPublicKey(p1Pk).encode();
        }
      } catch (e) {
        console.warn('ErgoAddress encode failed for pk:', p1Pk, e);
      }

      let firstSalvo = [10, 25, 42, 18, 55];
      const r6 = b.additionalRegisters?.R6;
      const r6Hex = typeof r6 === 'string' ? (r6.startsWith('0x') ? r6.slice(2) : r6) : ((r6 as any)?.serializedValue?.replace(/^0x/, '') || '');
      if (r6 && typeof r6 === 'object') {
        if (Array.isArray((r6 as any).renderedValue)) {
          firstSalvo = (r6 as any).renderedValue.map(Number);
        } else if (typeof (r6 as any).renderedValue === 'string') {
          const clean = (r6 as any).renderedValue.replace(/[\[\]\s]/g, '');
          const nums = clean.split(',').map(Number).filter((n: number) => !isNaN(n));
          if (nums.length === 5) firstSalvo = nums;
        }
      } else if (r6Hex) {
        try {
          const parsed = parse<number[]>(r6Hex);
          if (Array.isArray(parsed) && parsed.length === 5) {
            firstSalvo = parsed.map(Number);
          }
        } catch (e) {
          console.warn('Failed to parse lobby R6', e);
        }
      }

      let rawRoot = '';
      const r5 = b.additionalRegisters?.R5;
      if (r5 && typeof r5 === 'object') {
        if (Array.isArray((r5 as any).renderedValue) && (r5 as any).renderedValue[0]) {
          rawRoot = (r5 as any).renderedValue[0];
        } else if (typeof (r5 as any).renderedValue === 'string') {
          const clean = (r5 as any).renderedValue.replace(/[\[\]\s]/g, '');
          rawRoot = clean.split(',')[0] || '';
        } else if (typeof (r5 as any).serializedValue === 'string') {
          rawRoot = (r5 as any).serializedValue;
        }
      } else if (typeof r5 === 'string') {
        rawRoot = r5;
      }
      if (typeof rawRoot === 'string') {
        rawRoot = rawRoot.replace(/["\s]/g, '');
        if (rawRoot.startsWith('0x')) rawRoot = rawRoot.slice(2);
        if (rawRoot.startsWith('1a0220') || rawRoot.startsWith('130220') || rawRoot.startsWith('110220') ||
            rawRoot.startsWith('1a0120') || rawRoot.startsWith('130120') || rawRoot.startsWith('110120')) {
          rawRoot = rawRoot.slice(6, 70);
        } else if (rawRoot.startsWith('1a02') || rawRoot.startsWith('1302') || rawRoot.startsWith('1a01') || rawRoot.startsWith('1301')) {
          rawRoot = rawRoot.slice(4, 68);
        } else if (rawRoot.startsWith('0e20')) {
          rawRoot = rawRoot.slice(4);
        }
      }

      const completeBox = {
        ...b,
        boxId: b.boxId,
        value: b.value?.toString() || '1000000000',
        ergoTree: b.ergoTree || (b.address ? b.address : ''),
        assets: b.assets || [],
        creationHeight: b.creationHeight || 1860000,
        additionalRegisters: b.additionalRegisters || {},
        transactionId: b.transactionId || (b.boxId ? b.boxId.slice(0, 64) : '00'.repeat(32)),
        index: b.index ?? 0,
      };

      // SInt is ZigZag + multi-byte VLQ. Reading only the first byte silently truncates
      // anything over 63 blocks — a 720-block (24h) lobby decoded as 80 blocks and
      // displayed as "2h 40m". Use the real decoder.
      let timeoutDuration = 30;
      const r9 = b.additionalRegisters?.R9;
      if (r9 && typeof r9 === 'object' && 'renderedValue' in r9) {
        const val = parseInt((r9 as any).renderedValue);
        if (!isNaN(val)) timeoutDuration = val;
      } else {
        try {
          const r9Hex = extractRegisterHex(r9);
          if (r9Hex) {
            const decoded = parse<number>(r9Hex);
            if (typeof decoded === 'number' && Number.isFinite(decoded) && decoded > 0) {
              timeoutDuration = decoded;
            }
          }
        } catch {}
      }

      return {
        box: completeBox,
        p1Address: addr,
        p1PublicKey: p1Pk,
        p1BoardRoot: rawRoot,
        firstSalvo,
        wagerNanoErg: BigInt(b.value || '1000000000'),
        isMempool,
        timeoutDuration,
      };
    } catch (err) {
      console.warn('parseLobbyBox error:', err);
      return null;
    }
  }

  /**
   * Fetches open lobby boxes from on-chain confirmed boxes AND unconfirmed mempool transactions.
   * Automatically scans node mempool and explorer mempools, removing any lobby box currently being spent.
   */
  public static async getOpenLobbies(lobbyAddress: string, userAddress?: string): Promise<LobbyBoxState[]> {
    const results: LobbyBoxState[] = [];
    const seenBoxIds = new Set<string>();
    const spentInMempoolBoxIds = new Set<string>();

    let lobbyTreeHex = '';
    try {
      lobbyTreeHex = getLobbyErgoTree().toHex();
    } catch {}

    const processMempoolTx = (tx: any) => {
      // Track inputs being spent in mempool (e.g. battles being accepted or refunded)
      for (const inp of (tx.inputs || [])) {
        if (inp.boxId) spentInMempoolBoxIds.add(inp.boxId);
      }

      const outputs = tx.outputs || [];
      for (const out of outputs) {
        let outAddr = out.address;
        if (!outAddr && out.ergoTree) {
          try {
            outAddr = ErgoAddress.fromErgoTree(out.ergoTree).encode();
          } catch {}
        }
        const matchesLobby = (outAddr && outAddr === lobbyAddress) ||
                             (out.ergoTree && (out.ergoTree === lobbyAddress || out.ergoTree === lobbyTreeHex));
        if (matchesLobby && out.boxId && !seenBoxIds.has(out.boxId)) {
          seenBoxIds.add(out.boxId);
          const completeOut = {
            ...out,
            address: outAddr || lobbyAddress,
            ergoTree: out.ergoTree || lobbyTreeHex,
            transactionId: tx.id || out.transactionId,
          };
          const parsed = this.parseLobbyBox(completeOut, true);
          if (parsed) results.unshift(parsed); // Place mempool at top
        }
      }
    };

    // 1. Query Ergo Node unconfirmed mempool (Fastest & most direct real-time mempool source!)
    try {
      const nodeRes = await fetch(`${NetworkConfig.getNodeUrl()}/transactions/unconfirmed?limit=100`);
      if (nodeRes.ok) {
        const nodeTxs = await nodeRes.json();
        for (const tx of (nodeTxs || [])) {
          processMempoolTx(tx);
        }
      }
    } catch (e) {
      console.warn('Node mempool lobby query error:', e);
    }

    // 2. Fetch confirmed boxes
    try {
      const confirmedBoxes = await this.getUnspentBoxesByAddress(lobbyAddress);
      for (const b of confirmedBoxes) {
        if (!b.boxId || seenBoxIds.has(b.boxId) || spentInMempoolBoxIds.has(b.boxId)) continue;
        seenBoxIds.add(b.boxId);
        const parsed = this.parseLobbyBox(b, false);
        if (parsed) results.push(parsed);
      }
    } catch (e) {
      console.warn('Confirmed lobby boxes fetch error:', e);
    }

    // Filter out any lobby box that is being spent in the mempool
    return results.filter((l) => !spentInMempoolBoxIds.has(l.box.boxId));
  }

  /**
   * Fetches active Battleships game boxes from on-chain confirmed boxes, unconfirmed mempool transactions,
   * and user transaction output history for all contract versions.
   */
  public static async getActiveBattles(
    battleshipsAddress: string,
    userAddress?: string
  ): Promise<GameBoxState[]> {
    const results: GameBoxState[] = [];
    const seenBoxIds = new Set<string>();
    const spentInMempoolBoxIds = new Map<string, string>(); // boxId -> spendingTxId

    let battlesTreeHex = '';
    try {
      battlesTreeHex = getBattleshipsErgoTree().toHex();
    } catch {}

    const processBattleMempoolTx = (tx: any) => {
      for (const inp of tx.inputs || []) {
        if (inp.boxId) spentInMempoolBoxIds.set(inp.boxId, tx.id);
      }

      const outputs = tx.outputs || [];
      for (const out of outputs) {
        let outAddr = out.address;
        if (!outAddr && out.ergoTree) {
          try {
            outAddr = ErgoAddress.fromErgoTree(out.ergoTree).encode();
          } catch {}
        }
        const matchesBattle = (outAddr && outAddr === battleshipsAddress) ||
                              (out.ergoTree && (out.ergoTree === battleshipsAddress || out.ergoTree === battlesTreeHex));
        if (matchesBattle && out.boxId && !seenBoxIds.has(out.boxId)) {
          if (out.additionalRegisters?.R4 && out.additionalRegisters?.R5) {
            seenBoxIds.add(out.boxId);
            const completeBox: any = {
              ...out,
              boxId: out.boxId,
              value: out.value?.toString() || '2000000000',
              ergoTree: out.ergoTree || (outAddr ? outAddr : ''),
              address: outAddr || battleshipsAddress,
              assets: out.assets || [],
              creationHeight: out.creationHeight || 1860000,
              additionalRegisters: out.additionalRegisters || {},
              transactionId: tx.id || out.transactionId || '00'.repeat(32),
              index: out.index ?? 0,
            };
            const parsed = this.parseGameBox(completeBox, true, tx.id);
            if (parsed) results.unshift(parsed);
          }
        }
      }
    };

    // 1. Query Ergo Node unconfirmed mempool for battles (Fastest direct source!)
    try {
      const nodeRes = await fetch(`${NetworkConfig.getNodeUrl()}/transactions/unconfirmed?limit=100`);
      if (nodeRes.ok) {
        const nodeTxs = await nodeRes.json();
        for (const tx of (nodeTxs || [])) {
          processBattleMempoolTx(tx);
        }
      }
    } catch (e) {
      console.warn('Node mempool battles query error:', e);
    }

    // 2. Fetch confirmed boxes by current battleshipsAddress
    try {
      const confirmedBoxes = await this.getUnspentBoxesByAddress(battleshipsAddress);
      for (const b of confirmedBoxes) {
        if (!b.boxId || seenBoxIds.has(b.boxId)) continue;
        const isSpentInMempool = spentInMempoolBoxIds.has(b.boxId);
        const spendingTxId = spentInMempoolBoxIds.get(b.boxId);
        seenBoxIds.add(b.boxId);
        const parsed = this.parseGameBox(b, isSpentInMempool, spendingTxId);
        if (parsed) results.push(parsed);
      }
    } catch (e) {
      console.warn('Confirmed battleships boxes fetch error:', e);
    }

    // 3. User History Scan: Discover unspent battle boxes from user transactions
    if (userAddress) {
      try {
        const txRes = await fetch(`${NetworkConfig.getNodeUrl()}/blockchain/transaction/byAddress?limit=15`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(userAddress),
        });
        if (txRes.ok) {
          const txData = await txRes.json();
          const userTxs = Array.isArray(txData) ? txData : txData.items || [];
          for (const tx of userTxs) {
            for (const out of tx.outputs || []) {
              const matchesCurrentVersion = (out.address === battleshipsAddress) || (out.ergoTree && out.ergoTree === battlesTreeHex);
              if (
                out.boxId &&
                !seenBoxIds.has(out.boxId) &&
                matchesCurrentVersion &&
                out.additionalRegisters?.R4 &&
                out.additionalRegisters?.R5 &&
                out.additionalRegisters?.R6
              ) {
                try {
                  const boxRes = await fetch(`${NetworkConfig.getNodeUrl()}/blockchain/box/byId/${out.boxId}`);
                  if (boxRes.ok) {
                    const boxDetail = await boxRes.json();
                    const isSpent =
                      boxDetail.spent === true ||
                      boxDetail.spendingStatus?.spent === true ||
                      Boolean(boxDetail.spendingTransactionId) ||
                      Boolean(boxDetail.spentTransactionId) ||
                      Boolean(boxDetail.spendingTxId) ||
                      spentInMempoolBoxIds.has(out.boxId);

                    const boxVal = BigInt(boxDetail.value || 0);

                    if (!isSpent && boxVal >= 2000000n) {
                      seenBoxIds.add(out.boxId);
                      const isSpentInMempool = spentInMempoolBoxIds.has(out.boxId);
                      const spendingTxId = spentInMempoolBoxIds.get(out.boxId);
                      const parsed = this.parseGameBox(boxDetail, isSpentInMempool, spendingTxId);
                      if (parsed) results.push(parsed);
                    }
                  }
                } catch {}
              }
            }
          }
        }
      } catch (e) {
        console.warn('User transaction battle scan error:', e);
      }
    }

    // Deduplicate battles by match identity so a match only appears once (newest state takes precedence)
    const finalResults: GameBoxState[] = [];
    const seenMatchKeys = new Set<string>();

    for (const g of results) {
      if (BigInt(g.box.value || 0) < 2000000n) continue;
      if (spentInMempoolBoxIds.has(g.box.boxId)) continue; // Discard input boxes being spent

      const matchKey = (g.p1BoardRoot && g.p2BoardRoot)
        ? `${g.p1BoardRoot}_${g.p2BoardRoot}`
        : `${(g.p1Address || g.p1PublicKey || '').toLowerCase()}_${(g.p2Address || g.p2PublicKey || '').toLowerCase()}_${g.box.value}`;

      if (!seenMatchKeys.has(matchKey)) {
        seenMatchKeys.add(matchKey);
        finalResults.push(g);
      }
    }

    return finalResults;
  }

  /**
   * Reconstructs full shot history (hits, misses, pending) for Player 1 and Player 2
   * from the on-chain transaction chain. Works across all devices/browsers!
   *
   * The extension (context variables) containing Merkle proofs lives at:
   *   - Node API: input.spendingProof.extension  (object with keys "0","1",...)
   *   - Explorer API: input.extension  (object with keys "0","1",...)
   * We check both locations.
   */
  public static async getMatchShotHistory(
    gameBox: Box<Amount>,
    userAddress?: string
  ): Promise<{
    p1Shots: Record<number, 'hit' | 'miss' | 'pending'>;
    p2Shots: Record<number, 'hit' | 'miss' | 'pending'>;
    latestP1Salvo?: { targets: number[]; hits: number[]; misses: number[] };
    latestP2Salvo?: { targets: number[]; hits: number[]; misses: number[] };
  }> {
    const history = {
      p1Shots: {} as Record<number, 'hit' | 'miss' | 'pending'>,
      p2Shots: {} as Record<number, 'hit' | 'miss' | 'pending'>,
      latestP1Salvo: undefined as { targets: number[]; hits: number[]; misses: number[] } | undefined,
      latestP2Salvo: undefined as { targets: number[]; hits: number[]; misses: number[] } | undefined,
    };

    try {
      // 1. Base baseline from existing local cache and R8
      const matchKey = (gameBox.additionalRegisters?.R5) ? extractRegisterHex(gameBox.additionalRegisters?.R5) : '';
      if (matchKey && typeof window !== 'undefined') {
        const cached = loadMatchShotHistory(matchKey) || loadMatchShotHistory(gameBox.boxId);
        if (cached) {
          Object.entries(cached.p1Shots || {}).forEach(([k, v]) => {
            if (v === 'hit' || v === 'miss') history.p1Shots[Number(k)] = v;
          });
          Object.entries(cached.p2Shots || {}).forEach(([k, v]) => {
            if (v === 'hit' || v === 'miss') history.p2Shots[Number(k)] = v;
          });
        }
      }

      const r8Hex = extractRegisterHex(gameBox.additionalRegisters?.R8);
      if (r8Hex) {
        try {
          const parsed = parse<any>(r8Hex);
          if (Array.isArray(parsed) && parsed.length === 2) {
            Array.from(parsed[0]).forEach((val: any, idx: number) => {
              if (Number(val) === 1 && !history.p1Shots[idx]) history.p1Shots[idx] = 'pending';
            });
            Array.from(parsed[1]).forEach((val: any, idx: number) => {
              if (Number(val) === 1 && !history.p2Shots[idx]) history.p2Shots[idx] = 'pending';
            });
          }
        } catch {}
      }

      // 2. Base pending targets from current gameBox R7
      const r6Hex = extractRegisterHex(gameBox.additionalRegisters?.R6);
      let currentPhase = 0;
      if (r6Hex) {
        try {
          const parsedR6 = parse<number[]>(r6Hex);
          if (Array.isArray(parsedR6) && parsedR6.length >= 1) {
            currentPhase = Number(parsedR6[0]);
          }
        } catch {}
      }

      const r7Hex = extractRegisterHex(gameBox.additionalRegisters?.R7);
      if (r7Hex) {
        try {
          const parsedR7 = parse<number[]>(r7Hex);
          if (Array.isArray(parsedR7)) {
            parsedR7.forEach((cellIdx: number) => {
              if (cellIdx >= 0 && cellIdx < 64) {
                // If currentPhase === 1: P1 just fired this salvo at P2 (pending P2 evaluation)
                // If currentPhase === 0: P2 just fired this salvo at P1 (pending P1 evaluation)
                if (currentPhase === 1 && history.p1Shots[cellIdx] !== 'hit' && history.p1Shots[cellIdx] !== 'miss') {
                  history.p1Shots[cellIdx] = 'pending';
                } else if (currentPhase === 0 && history.p2Shots[cellIdx] !== 'hit' && history.p2Shots[cellIdx] !== 'miss') {
                  history.p2Shots[cellIdx] = 'pending';
                }
              }
            });
          }
        } catch {}
      }

      // 3. Resolve Player addresses & public keys
      const r4Hex = extractRegisterHex(gameBox.additionalRegisters?.R4);
      let p1Pk = '';
      let p2Pk = '';
      let p1Address = '';
      let p2Address = '';
      if (r4Hex) {
        try {
          const [pk1, pk2] = extractGroupElements(r4Hex);
          p1Pk = pk1 || '';
          p2Pk = pk2 || '';
          if (p1Pk) p1Address = ErgoAddress.fromPublicKey(p1Pk).encode();
          if (p2Pk) p2Address = ErgoAddress.fromPublicKey(p2Pk).encode();
        } catch {}
      }

      const r5Hex = extractRegisterHex(gameBox.additionalRegisters?.R5);
      let battleshipsAddr = '';
      try {
        battleshipsAddr = getBattleshipsAddress();
      } catch {}

      const addressesToQuery = Array.from(
        new Set([userAddress, p1Address, p2Address].filter(Boolean) as string[])
      );

      // 4. Fetch CONFIRMED transactions in parallel from node (Mempool excluded to prevent premature hit reveal)
      const confirmedTxsMap = new Map<string, any>();
      const confirmedTxsList: any[] = [];

      const queryNodeForTxs = async (nodeBase: string) => {
        await Promise.all(
          addressesToQuery.map(async (addr) => {
            try {
              const res = await fetchFromNode(nodeBase, '/blockchain/transaction/byAddress?limit=50', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(addr),
                timeoutMs: 10000,
              });
              if (res.ok) {
                const data = await res.json();
                const txs = Array.isArray(data) ? data : data.items || [];
                txs.forEach((tx: any) => {
                  if (tx?.id && !confirmedTxsMap.has(tx.id)) {
                    confirmedTxsMap.set(tx.id, tx);
                    confirmedTxsList.push(tx);
                  }
                });
              }
            } catch {}
          })
        );
      };

      await queryNodeForTxs(NetworkConfig.getNodeUrl());

      // Configured node returned nothing — walk the shared fallbacks in priority order.
      for (const fallbackNode of resolveNodeUrls().slice(1)) {
        if (confirmedTxsList.length > 0) break;
        await queryNodeForTxs(fallbackNode);
      }

      // Sort confirmed transactions chronologically (oldest to newest)
      confirmedTxsList.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      // Build a map of all known output boxes to resolve input registers
      const knownBoxesMap = new Map<string, any>();
      if (gameBox?.boxId) knownBoxesMap.set(gameBox.boxId, gameBox);

      for (const tx of confirmedTxsList) {
        for (const out of (tx.outputs || [])) {
          if (out?.boxId) {
            knownBoxesMap.set(out.boxId, out);
          }
        }
      }

      // 5. Parse Merkle proofs across all CONFIRMED match transactions
      for (const tx of confirmedTxsList) {
        let gameInput: any = null;
        let sourceBox: any = null;
        let ext: any = null;

        for (const inp of (tx.inputs || [])) {
          const e = inp.spendingProof?.extension || inp.extension;
          if (e && (e['1'] || e[1] || e['001'] || e['01'])) {
            let sBox = knownBoxesMap.get(inp.boxId) || inp;
            let inR6 = extractRegisterHex(sBox?.additionalRegisters?.R6);
            let inR7 = extractRegisterHex(sBox?.additionalRegisters?.R7);

            if (!inR6 || !inR7) {
              // Fetch the input box directly from node if not in local map
              try {
                const boxRes = await fetchFromNode(NetworkConfig.getNodeUrl(), `/blockchain/box/byId/${inp.boxId}`, { timeoutMs: 8000 });
                if (boxRes.ok) {
                  sBox = await boxRes.json();
                  knownBoxesMap.set(inp.boxId, sBox);
                  inR6 = extractRegisterHex(sBox?.additionalRegisters?.R6);
                  inR7 = extractRegisterHex(sBox?.additionalRegisters?.R7);
                }
              } catch {
                try {
                  const fRes = await fetchFromNode(FALLBACK_NODE_URLS[0], `/blockchain/box/byId/${inp.boxId}`, { timeoutMs: 8000 });
                  if (fRes.ok) {
                    sBox = await fRes.json();
                    knownBoxesMap.set(inp.boxId, sBox);
                    inR6 = extractRegisterHex(sBox?.additionalRegisters?.R6);
                    inR7 = extractRegisterHex(sBox?.additionalRegisters?.R7);
                  }
                } catch {}
              }
            }

            if (inR6 && inR7) {
              gameInput = inp;
              sourceBox = sBox;
              ext = e;
              break;
            }
          }
        }

        if (!gameInput || !sourceBox || !ext) continue;

        const inR4Hex = extractRegisterHex(sourceBox.additionalRegisters?.R4 || gameInput.additionalRegisters?.R4);
        const inR5Hex = extractRegisterHex(sourceBox.additionalRegisters?.R5 || gameInput.additionalRegisters?.R5);
        const inR6Hex = extractRegisterHex(sourceBox.additionalRegisters?.R6 || gameInput.additionalRegisters?.R6);
        const inR7Hex = extractRegisterHex(sourceBox.additionalRegisters?.R7 || gameInput.additionalRegisters?.R7);

        if (!inR6Hex || !inR7Hex || !ext) continue;

        // Check if this input belongs to this match
        if (r5Hex && inR5Hex) {
          if (inR5Hex.toLowerCase() !== r5Hex.toLowerCase()) continue;
        } else if (inR4Hex && p1Pk) {
          try {
            const [inPk1] = extractGroupElements(inR4Hex);
            if (inPk1 && inPk1.toLowerCase() !== p1Pk.toLowerCase()) continue;
          } catch {}
        }

        let inputPhase = 0;
        try {
          const parsedR6 = parse<number[]>(inR6Hex);
          inputPhase = Number(parsedR6[0]);
        } catch { continue; }

        let salvo: number[] = [];
        try {
          salvo = parse<number[]>(inR7Hex);
          if (!Array.isArray(salvo) || salvo.length === 0) continue;
        } catch { continue; }

        // Sort salvo as required by contract
        const sortedSalvo = [...salvo].sort((a, b) => a - b);
        const roundHits: number[] = [];
        const roundMisses: number[] = [];

        for (let i = 0; i < sortedSalvo.length; i++) {
          const cellIdx = sortedSalvo[i];
          const keyCandidates = [
            (i + 1).toString(),
            i + 1,
            String(i + 1).padStart(3, '0'),
            String(i + 1).padStart(2, '0'),
          ];
          let prHex: any = null;
          for (const k of keyCandidates) {
            if (ext[k as any]) {
              prHex = ext[k as any];
              break;
            }
          }
          if (!prHex || typeof prHex !== 'string') continue;

          const clean = prHex.startsWith('0x') ? prHex.slice(2) : prHex;
          let isHit = false;
          if (clean.includes('e00101') || clean.startsWith('01') || clean.slice(6, 8) === '01') {
            isHit = true;
          }

          const result: 'hit' | 'miss' = isHit ? 'hit' : 'miss';
          if (result === 'hit') roundHits.push(cellIdx);
          else roundMisses.push(cellIdx);

          // If inputPhase === 0: Input box contained P2's targets in R7. P1 spent the box and provided defender proofs -> this is P2's shot on P1!
          // If inputPhase === 1: Input box contained P1's targets in R7. P2 spent the box and provided defender proofs -> this is P1's shot on P2!
          if (inputPhase === 0) {
            history.p2Shots[cellIdx] = result;
          } else if (inputPhase === 1) {
            history.p1Shots[cellIdx] = result;
          }
        }

        // Track latest evaluated salvo round for each player
        if (inputPhase === 1 && sortedSalvo.length > 0) {
          history.latestP1Salvo = { targets: sortedSalvo, hits: roundHits, misses: roundMisses };
        } else if (inputPhase === 0 && sortedSalvo.length > 0) {
          history.latestP2Salvo = { targets: sortedSalvo, hits: roundHits, misses: roundMisses };
        }
      }
    } catch (e) {
      console.warn('getMatchShotHistory error:', e);
    }

    return history;
  }

  /**
   * Discovers and reconstructs past completed matches for a given user address.
   * Filters out simple lobby cancellations and only returns actual finished games.
  /**
   * Fetches every box (spent & unspent) ever held by a contract address, straight from an
   * Ergo node's indexer. Pages through the full history rather than reading a single page,
   * so the leaderboard covers all matches of all time.
   */
  public static async fetchContractBoxesFromNodes(
    contractAddress: string,
    preferredNodeUrl?: string,
  ): Promise<any[]> {
    const PAGE_SIZE = 500;
    const MAX_PAGES = 40;

    for (const nodeUrl of resolveNodeUrls(preferredNodeUrl)) {
      try {
        const collected: any[] = [];
        let total = Infinity;

        for (let page = 0; page < MAX_PAGES; page++) {
          const offset = page * PAGE_SIZE;
          if (offset >= total) break;

          const res = await fetch(
            nodeEndpoint(nodeUrl, `/blockchain/box/byAddress?offset=${offset}&limit=${PAGE_SIZE}`),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(contractAddress),
              signal: AbortSignal.timeout(20000),
            },
          );
          if (!res.ok) throw new Error(`Status ${res.status}`);

          const data = await res.json();
          const items: any[] = Array.isArray(data) ? data : data.items || [];
          if (typeof data?.total === 'number') total = data.total;
          collected.push(...items);
          if (items.length < PAGE_SIZE) break;
        }

        if (collected.length > 0) return collected;
      } catch (err) {
        console.warn(`Contract box fetch failed at ${nodeUrl}:`, err);
      }
    }
    return [];
  }

  /**
   * Fetches transaction by ID from Ergo nodes.
   */
  public static async fetchTxByIdFromNodes(txId: string, preferredNodeUrl?: string): Promise<any | null> {
    for (const nodeUrl of resolveNodeUrls(preferredNodeUrl)) {
      try {
        const res = await fetch(nodeEndpoint(nodeUrl, `/blockchain/transaction/byId/${txId}`), {
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) return await res.json();
      } catch {}
    }
    return null;
  }

  /**
   * Discovers every transaction that spent a Battleships contract box — i.e. every move,
   * settlement and timeout claim the contract has ever seen. This is the single network-heavy
   * step shared by the leaderboard and match history.
   */
  public static async fetchSettlementTxs(
    contractAddress: string,
    preferredNodeUrl?: string,
  ): Promise<any[]> {
    const cacheKey = `${preferredNodeUrl || NetworkConfig.getNodeUrl()}|${contractAddress}`;
    if (!isBrowserRuntime()) {
      return cachedSettlementTxs(cacheKey, () => this.loadSettlementTxs(contractAddress, preferredNodeUrl));
    }
    return this.loadSettlementTxs(contractAddress, preferredNodeUrl);
  }

  private static async loadSettlementTxs(
    contractAddress: string,
    preferredNodeUrl?: string,
  ): Promise<any[]> {
    const contractBoxes = await this.fetchContractBoxesFromNodes(contractAddress, preferredNodeUrl);

    const spentTxIds = Array.from(
      new Set<string>(
        contractBoxes
          .map((b: any) => b.spentTransactionId || b.spendingTxId)
          .filter(Boolean),
      ),
    );

    // Bounded fan-out: public nodes refuse a large simultaneous burst outright.
    const txs = await mapWithConcurrency(spentTxIds, 6, (id) =>
      this.fetchTxByIdFromNodes(id, preferredNodeUrl),
    );
    return txs.filter((t): t is any => Boolean(t && t.id));
  }

  /**
   * Builds the on-chain Match History for a player address by inspecting every spent
   * Battleships contract box. Talks to Ergo nodes directly, so it is meant to run on the
   * server; the browser should call `getMatchHistory`, which proxies here via /api/indexer.
   */
  public static async computeMatchHistory(
    userAddress: string,
    contractAddress?: string,
    preferredNodeUrl?: string,
  ): Promise<MatchHistoryItem[]> {
    if (!userAddress) return [];
    const results: MatchHistoryItem[] = [];
    const seenTxIds = new Set<string>();
    const contractAddr = contractAddress || getBattleshipsAddress();

    try {
      const txs = await this.fetchSettlementTxs(contractAddr, preferredNodeUrl);

      for (const tx of txs) {
        if (!tx || !tx.id || seenTxIds.has(tx.id)) continue;

        let battleInp = tx.inputs?.find(
          (inp: any) =>
            inp.additionalRegisters?.R4 &&
            inp.additionalRegisters?.R5 &&
            inp.additionalRegisters?.R6
        );

        let battleOut = tx.outputs?.find(
          (out: any) =>
            out.additionalRegisters?.R4 &&
            out.additionalRegisters?.R5 &&
            out.additionalRegisters?.R6
        );

        /**
         * A match is over only when the game box is spent WITHOUT producing a new one —
         * that is a settlement or a timeout sweep. A turn that merely records the tenth hit
         * still leaves the box and the whole pot in play, and treating it as finished
         * produced a phantom second result for every match that went the distance.
         */
        const isFinished = Boolean(battleInp && !battleOut);
        const boxForStats: any = isFinished ? battleInp : null;

        if (isFinished && boxForStats) {
          seenTxIds.add(tx.id);

          const parsedBox = this.parseGameBox(boxForStats, false, undefined, true);
          if (!parsedBox) continue;

          const p1Addr = parsedBox.p1Address;
          const p2Addr = parsedBox.p2Address;
          if (!p1Addr || !p2Addr) continue;

          // Check if this match involved userAddress
          const isP1 = p1Addr.toLowerCase() === userAddress.toLowerCase();
          const isP2 = p2Addr.toLowerCase() === userAddress.toLowerCase();
          if (!isP1 && !isP2) continue;

          const potVal = BigInt(boxForStats.value || 0);
          const wager = potVal > 0n ? potVal / 2n : 10000000n;

          const isSelfFight = p1Addr.toLowerCase() === p2Addr.toLowerCase();
          const myRole: 'P1' | 'P2' | 'SELF' = isSelfFight ? 'SELF' : isP1 ? 'P1' : 'P2';
          const opponentAddr = isSelfFight
            ? 'Self Battle'
            : isP1
            ? p2Addr || 'Unknown'
            : p1Addr || 'Unknown';

          const p1WonByHits = parsedBox.p1Hits >= 10;
          const p2WonByHits = parsedBox.p2Hits >= 10;
          const isCompletedByHits = p1WonByHits || p2WonByHits;

          // Determine winner based on hits or settlement outputs
          /**
           * A tie pays each player (pot - devFee) / 2, which is slightly LESS than their
           * wager — 0.198 against a 0.2 stake on a 0.4 pot. Testing `>= wager` therefore
           * never matched a draw, and every tie was reported as an outright victory with
           * the full winner's payout. Half a wager is comfortably above dust and below any
           * real settlement share.
           */
          const settlementShare = wager / 2n;
          const p1Received = tx.outputs?.some(
            (o: any) => o.address && p1Addr && o.address.toLowerCase() === p1Addr.toLowerCase() && BigInt(o.value || 0) >= settlementShare
          );
          const p2Received = tx.outputs?.some(
            (o: any) => o.address && p2Addr && o.address.toLowerCase() === p2Addr.toLowerCase() && BigInt(o.value || 0) >= settlementShare
          );

          let outcome: 'VICTORY' | 'DEFEAT' | 'TIE' | 'TIMEOUT_WON' | 'TIMEOUT_LOST' = 'VICTORY';
          let profitNanoErg = 0n;

          if (isSelfFight) {
            outcome = 'VICTORY';
            profitNanoErg = 0n;
          } else if (p1Received && p2Received) {
            // Each side gets (pot - devFee) / 2 back, so a draw costs half the dev fee.
            const devFee = potVal / 100n > 1000000n ? potVal / 100n : 1000000n;
            outcome = 'TIE';
            profitNanoErg = -(devFee / 2n);
          } else if (isP1) {
            if (p1WonByHits) {
              outcome = 'VICTORY';
              profitNanoErg = (wager * 98n) / 100n;
            } else if (p1Received && !p2Received) {
              outcome = isCompletedByHits ? 'VICTORY' : 'TIMEOUT_WON';
              profitNanoErg = (wager * 98n) / 100n;
            } else if (p2WonByHits) {
              outcome = 'DEFEAT';
              profitNanoErg = -wager;
            } else {
              outcome = 'TIMEOUT_LOST';
              profitNanoErg = -wager;
            }
          } else {
            // My Role is P2
            if (p2WonByHits) {
              outcome = 'VICTORY';
              profitNanoErg = (wager * 98n) / 100n;
            } else if (p2Received && !p1Received) {
              outcome = isCompletedByHits ? 'VICTORY' : 'TIMEOUT_WON';
              profitNanoErg = (wager * 98n) / 100n;
            } else if (p1WonByHits) {
              outcome = 'DEFEAT';
              profitNanoErg = -wager;
            } else {
              outcome = 'TIMEOUT_LOST';
              profitNanoErg = -wager;
            }
          }

          const dateObj = new Date(tx.timestamp || Date.now());
          const dateFormatted = `${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

          results.push({
            gameId: parsedBox.box?.boxId?.slice(0, 12) || tx.id.slice(0, 12),
            txId: tx.id,
            timestamp: tx.timestamp || Date.now(),
            dateFormatted,
            myRole,
            p1Address: p1Addr || '',
            p2Address: p2Addr || '',
            opponentAddress: opponentAddr,
            wagerNanoErg: wager,
            finalPotNanoErg: potVal,
            outcome,
            profitNanoErg,
            p1Hits: parsedBox.p1Hits,
            p2Hits: parsedBox.p2Hits,
            status: isCompletedByHits ? 'COMPLETED' : 'TIMED_OUT',
            isSelfFight,
            explorerTxUrl: `https://explorer.ergoplatform.com/en/transactions/${tx.id}`,
          });
        }
      }
    } catch (e) {
      console.warn('Match history fetch error:', e);
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Aggregates global on-chain battle records into a competitive Player Leaderboard.
   * Dynamically inspects all spent contract boxes to discover all players and matches of all time.
   */
  public static async computeLeaderboard(
    battleshipsAddress?: string,
    userAddress?: string,
    preferredNodeUrl?: string,
  ): Promise<PlayerLeaderboardEntry[]> {
    const playersMap = new Map<string, {
      address: string;
      totalGames: number;
      wins: number;
      losses: number;
      ties: number;
      totalWonNanoErg: bigint;
      totalLostNanoErg: bigint;
      totalWageredNanoErg: bigint;
      netProfitNanoErg: bigint;
      lastPlayedTimestamp: number;
    }>();

    const seenTxIds = new Set<string>();
    const DEFAULT_BOT_ADDRESS = '9fbotA98uapaNeye1U9ke5VByg8nvk5Y18CJDEgY66tkzUXfNnt';
    const contractAddr = battleshipsAddress || getBattleshipsAddress();

    const getOrCreatePlayer = (addr: string) => {
      const normalized = addr.trim();
      if (!playersMap.has(normalized)) {
        playersMap.set(normalized, {
          address: normalized,
          totalGames: 0,
          wins: 0,
          losses: 0,
          ties: 0,
          totalWonNanoErg: 0n,
          totalLostNanoErg: 0n,
          totalWageredNanoErg: 0n,
          netProfitNanoErg: 0n,
          lastPlayedTimestamp: 0,
        });
      }
      return playersMap.get(normalized)!;
    };

    try {
      const txs = await this.fetchSettlementTxs(contractAddr, preferredNodeUrl);

      for (const tx of txs) {
        if (!tx || !tx.id || seenTxIds.has(tx.id)) continue;

        const battleInp = tx.inputs?.find(
          (inp: any) =>
            inp.additionalRegisters?.R4 &&
            inp.additionalRegisters?.R5 &&
            inp.additionalRegisters?.R6
        );

        const battleOut = tx.outputs?.find(
          (out: any) =>
            out.additionalRegisters?.R4 &&
            out.additionalRegisters?.R5 &&
            out.additionalRegisters?.R6
        );

        /**
         * A match is over only when the game box is spent WITHOUT producing a new one —
         * that is a settlement or a timeout sweep. A turn that merely records the tenth hit
         * still leaves the box and the whole pot in play, and treating it as finished
         * produced a phantom second result for every match that went the distance.
         */
        const isFinished = Boolean(battleInp && !battleOut);
        const boxForStats: any = isFinished ? battleInp : null;

        if (isFinished && boxForStats) {
          seenTxIds.add(tx.id);

          const parsedBox = this.parseGameBox(boxForStats, false, undefined, true);
          if (!parsedBox) continue;

          const p1Addr = parsedBox.p1Address;
          const p2Addr = parsedBox.p2Address;
          if (!p1Addr && !p2Addr) continue;

          const potVal = BigInt(boxForStats.value || 0);
          const wager = potVal > 0n ? potVal / 2n : 10000000n;
          const txTimestamp = tx.timestamp || Date.now();

          const p1 = p1Addr ? getOrCreatePlayer(p1Addr) : null;
          const p2 = p2Addr ? getOrCreatePlayer(p2Addr) : null;

          const isSelfFight = Boolean(
            p1Addr && p2Addr && p1Addr.toLowerCase() === p2Addr.toLowerCase()
          );

          const p1WonByHits = parsedBox.p1Hits >= 10;
          const p2WonByHits = parsedBox.p2Hits >= 10;

          /**
           * A tie pays each player (pot - devFee) / 2, which is slightly LESS than their
           * wager — 0.198 against a 0.2 stake on a 0.4 pot. Testing `>= wager` therefore
           * never matched a draw, and every tie was reported as an outright victory with
           * the full winner's payout. Half a wager is comfortably above dust and below any
           * real settlement share.
           */
          const settlementShare = wager / 2n;
          const p1Received = tx.outputs?.some(
            (o: any) => o.address && p1Addr && o.address.toLowerCase() === p1Addr.toLowerCase() && BigInt(o.value || 0) >= settlementShare
          );
          const p2Received = tx.outputs?.some(
            (o: any) => o.address && p2Addr && o.address.toLowerCase() === p2Addr.toLowerCase() && BigInt(o.value || 0) >= settlementShare
          );

          if (isSelfFight && p1) {
            p1.totalGames += 1;
            p1.wins += 1;
            p1.totalWageredNanoErg += wager;
            p1.lastPlayedTimestamp = Math.max(p1.lastPlayedTimestamp, txTimestamp);
          } else if (p1Received && p2Received) {
            // Tie / Refund
            if (p1) {
              p1.totalGames += 1;
              p1.ties += 1;
              p1.totalWageredNanoErg += wager;
              p1.lastPlayedTimestamp = Math.max(p1.lastPlayedTimestamp, txTimestamp);
            }
            if (p2) {
              p2.totalGames += 1;
              p2.ties += 1;
              p2.totalWageredNanoErg += wager;
              p2.lastPlayedTimestamp = Math.max(p2.lastPlayedTimestamp, txTimestamp);
            }
          } else if (p1WonByHits || (p1Received && !p2Received)) {
            // P1 Won, P2 Lost
            const winProfit = (wager * 98n) / 100n;
            if (p1) {
              p1.totalGames += 1;
              p1.wins += 1;
              p1.totalWonNanoErg += winProfit;
              p1.totalWageredNanoErg += wager;
              p1.netProfitNanoErg += winProfit;
              p1.lastPlayedTimestamp = Math.max(p1.lastPlayedTimestamp, txTimestamp);
            }
            if (p2) {
              p2.totalGames += 1;
              p2.losses += 1;
              p2.totalLostNanoErg += wager;
              p2.totalWageredNanoErg += wager;
              p2.netProfitNanoErg -= wager;
              p2.lastPlayedTimestamp = Math.max(p2.lastPlayedTimestamp, txTimestamp);
            }
          } else if (p2WonByHits || (p2Received && !p1Received)) {
            // P2 Won, P1 Lost
            const winProfit = (wager * 98n) / 100n;
            if (p2) {
              p2.totalGames += 1;
              p2.wins += 1;
              p2.totalWonNanoErg += winProfit;
              p2.totalWageredNanoErg += wager;
              p2.netProfitNanoErg += winProfit;
              p2.lastPlayedTimestamp = Math.max(p2.lastPlayedTimestamp, txTimestamp);
            }
            if (p1) {
              p1.totalGames += 1;
              p1.losses += 1;
              p1.totalLostNanoErg += wager;
              p1.totalWageredNanoErg += wager;
              p1.netProfitNanoErg -= wager;
              p1.lastPlayedTimestamp = Math.max(p1.lastPlayedTimestamp, txTimestamp);
            }
          }
        }
      }
    } catch (err) {
      console.warn('getLeaderboard spent box indexer error:', err);
    }

    // Ensure bot is always present if indexed
    getOrCreatePlayer(DEFAULT_BOT_ADDRESS);

    const leaderboard: PlayerLeaderboardEntry[] = Array.from(playersMap.values())
      .filter((p) => p.totalGames > 0 || p.address === DEFAULT_BOT_ADDRESS)
      .map((p) => {
        const isBot = p.address === DEFAULT_BOT_ADDRESS;
        const shortAddress = isBot ? '🤖 9fbot (Simulator)' : `${p.address.slice(0, 6)}...${p.address.slice(-4)}`;
        const winRate = p.totalGames > 0 ? Math.round((p.wins / p.totalGames) * 100) : 0;
        return {
          ...p,
          shortAddress,
          winRate,
        };
      });

    return leaderboard.sort((a, b) => Number(b.netProfitNanoErg - a.netProfitNanoErg));
  }

  /**
   * Rebuilds both boards of a settled match — see {@link MatchBoards}.
   */
  public static async getMatchBoards(txId: string, userAddress: string): Promise<MatchBoards> {
    const empty: MatchBoards = { myGrid: null, theirGrid: null, myShots: [], theirShots: [], revealedBy: null };
    try {
      const tx = await this.fetchTxByIdFromNodes(txId);
      if (!tx) return empty;

      const gameInput = (tx.inputs || []).find(
        (i: any) => i.additionalRegisters?.R4 && i.additionalRegisters?.R5 && i.additionalRegisters?.R8,
      );
      if (!gameInput) return empty;

      const [pk1, pk2] = extractGroupElements(extractRegisterHex(gameInput.additionalRegisters.R4) || '');
      const p1Address = pk1 ? ErgoAddress.fromPublicKey(pk1).encode() : '';
      const isP1 = p1Address.toLowerCase() === userAddress.toLowerCase();

      // R8 holds both 64-byte shot histories.
      let p1History: number[] = [];
      let p2History: number[] = [];
      try {
        const decoded = parse<any>(extractRegisterHex(gameInput.additionalRegisters.R8) || '');
        if (Array.isArray(decoded) && decoded.length === 2) {
          p1History = Array.from(decoded[0]).map(Number);
          p2History = Array.from(decoded[1]).map(Number);
        }
      } catch {}

      const myShots: number[] = [];
      const theirShots: number[] = [];
      const mine = isP1 ? p1History : p2History;
      const theirs = isP1 ? p2History : p1History;
      for (let i = 0; i < 64; i++) {
        if (mine[i] === 1) myShots.push(i);
        if (theirs[i] === 1) theirShots.push(i);
      }

      const roots = parse<any>(extractRegisterHex(gameInput.additionalRegisters.R5) || '');
      const myRoot = Array.isArray(roots) ? normalizeRootHex(bytesToHexSafe(roots[isP1 ? 0 : 1])) : '';
      const local = myRoot ? loadBoardSalts(myRoot, userAddress) : null;
      let myGrid: number[] | null = local?.grid && local.grid.length === 64 ? local.grid : null;

      /**
       * The claimant's board, revealed in context variable 99 to settle the match.
       *
       * Whose board it is comes from hashing the payload and matching it against the board
       * hashes in R5 — exactly what the contract itself does. Guessing by comparing against
       * the locally stored grid gets it backwards whenever this browser does not happen to
       * hold that board, which is precisely the case where the answer matters.
       */
      let revealedGrid: number[] | null = null;
      let revealedIsP1: boolean | null = null;
      const ext = (gameInput.spendingProof?.extension || gameInput.extension || {}) as Record<string, string>;
      const raw = ext['99'] ?? ext[99 as any];
      if (typeof raw === 'string' && raw.length > 4) {
        try {
          const bytes = parse<any>(raw);
          const arr = Array.from(bytes as ArrayLike<number>).map(Number);
          if (arr.length >= 64) {
            revealedGrid = arr.slice(0, 64);
            const digest = bytesToHexSafe(blake2b256(Uint8Array.from(arr)));
            if (Array.isArray(roots) && roots.length >= 4) {
              const p1Hash = normalizeRootHex(bytesToHexSafe(roots[2]));
              const p2Hash = normalizeRootHex(bytesToHexSafe(roots[3]));
              if (digest === p1Hash) revealedIsP1 = true;
              else if (digest === p2Hash) revealedIsP1 = false;
            }
          }
        } catch {}
      }

      let revealedBy: 'me' | 'opponent' | null = null;
      let theirGrid: number[] | null = null;
      if (revealedGrid && revealedIsP1 !== null) {
        revealedBy = revealedIsP1 === isP1 ? 'me' : 'opponent';
        if (revealedBy === 'opponent') theirGrid = revealedGrid;
        else if (!myGrid) myGrid = revealedGrid;
      }

      /**
       * If we sank all ten of their cells, our own confirmed hits ARE their ships — so their
       * fleet is knowable even when they never revealed it. Resolved from the match's Merkle
       * proofs on chain rather than a local cache, so it works in any browser.
       */
      if (!theirGrid) {
        try {
          const shots = await this.getMatchShotHistory(gameInput, userAddress);
          const resolved = isP1 ? shots.p1Shots : shots.p2Shots;
          const hitCells = Object.entries(resolved)
            .filter(([, v]) => v === 'hit')
            .map(([k]) => Number(k));
          if (hitCells.length >= 10) {
            const derived = new Array(64).fill(0);
            hitCells.forEach((c) => (derived[c] = 1));
            theirGrid = derived;
          }
        } catch {}
      }

      return { myGrid, theirGrid, myShots, theirShots, revealedBy };
    } catch {
      return empty;
    }
  }

  /**
   * Global player leaderboard, aggregated from every spent Battleships contract box.
   *
   * In the browser this is one call to /api/indexer/leaderboard, which runs the scan on the
   * Next.js server. That keeps the ~60 node requests off the browser, where the per-host
   * connection cap and CORS/mixed-content rules make the fan-out unreliable.
   */
  public static async getLeaderboard(
    battleshipsAddress?: string,
    userAddress?: string,
  ): Promise<PlayerLeaderboardEntry[]> {
    if (isBrowserRuntime()) {
      try {
        const params = new URLSearchParams({ node: NetworkConfig.getNodeUrl() });
        if (battleshipsAddress) params.set('contract', battleshipsAddress);
        if (userAddress) params.set('user', userAddress);

        const res = await fetch(`${INDEXER_API_BASE}/leaderboard?${params.toString()}`, {
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`Leaderboard API returned ${res.status}`);

        const data = await res.json();
        return (data.entries || []).map(deserializeLeaderboardEntry);
      } catch (err) {
        console.warn('Leaderboard API failed, falling back to direct node scan:', err);
      }
    }
    return this.computeLeaderboard(battleshipsAddress, userAddress);
  }

  /**
   * Completed matches for a single player. Proxied through /api/indexer/match-history in the
   * browser for the same reasons as {@link getLeaderboard}.
   */
  public static async getMatchHistory(userAddress: string): Promise<MatchHistoryItem[]> {
    if (!userAddress) return [];

    if (isBrowserRuntime()) {
      try {
        const params = new URLSearchParams({ user: userAddress, node: NetworkConfig.getNodeUrl() });
        const res = await fetch(`${INDEXER_API_BASE}/match-history?${params.toString()}`, {
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`Match history API returned ${res.status}`);

        const data = await res.json();
        return (data.items || []).map(deserializeMatchHistoryItem);
      } catch (err) {
        console.warn('Match history API failed, falling back to direct node scan:', err);
      }
    }
    return this.computeMatchHistory(userAddress);
  }
}

/**
 * Both boards of a finished match, reconstructed for review.
 *
 * A settlement reveals the claimant's whole board on chain (context variable 99), and the
 * spent game box carries both players' shot histories in R8. Between that and the board
 * this browser holds locally, a completed match can be replayed exactly — which is what
 * makes the review shareable and, more importantly, checkable: a player can see for
 * themselves where every shot landed rather than taking the result on trust.
 *
 * theirGrid is null only when the opponent never revealed and we did not sink them, i.e.
 * when nothing on chain can prove where their ships were.
 */
export interface MatchBoards {
  myGrid: number[] | null;
  theirGrid: number[] | null;
  myShots: number[];
  theirShots: number[];
  revealedBy: 'me' | 'opponent' | null;
}

export interface MatchHistoryItem {
  gameId: string;
  txId: string;
  timestamp: number;
  dateFormatted: string;
  myRole: 'P1' | 'P2' | 'SELF';
  p1Address: string;
  p2Address: string;
  opponentAddress: string;
  wagerNanoErg: bigint;
  finalPotNanoErg: bigint;
  outcome: 'VICTORY' | 'DEFEAT' | 'TIE' | 'TIMEOUT_WON' | 'TIMEOUT_LOST';
  profitNanoErg: bigint;
  p1Hits: number;
  p2Hits: number;
  status: 'COMPLETED' | 'TIMED_OUT';
  isSelfFight: boolean;
  explorerTxUrl: string;
}

export interface PlayerLeaderboardEntry {
  address: string;
  shortAddress: string;
  totalGames: number;
  wins: number;
  losses: number;
  ties: number;
  totalWonNanoErg: bigint;
  totalLostNanoErg: bigint;
  totalWageredNanoErg: bigint;
  netProfitNanoErg: bigint;
  winRate: number; // 0 - 100%
  lastPlayedTimestamp: number;
}

/**
 * BigInt does not survive JSON, so the /api/indexer routes send the nanoERG amounts as
 * decimal strings and the client revives them here.
 */
export type Wire<T, K extends keyof T> = Omit<T, K> & Record<K, string>;

export type WireLeaderboardEntry = Wire<
  PlayerLeaderboardEntry,
  'totalWonNanoErg' | 'totalLostNanoErg' | 'totalWageredNanoErg' | 'netProfitNanoErg'
>;

export type WireMatchHistoryItem = Wire<
  MatchHistoryItem,
  'wagerNanoErg' | 'finalPotNanoErg' | 'profitNanoErg'
>;

export function serializeLeaderboardEntry(entry: PlayerLeaderboardEntry): WireLeaderboardEntry {
  return {
    ...entry,
    totalWonNanoErg: entry.totalWonNanoErg.toString(),
    totalLostNanoErg: entry.totalLostNanoErg.toString(),
    totalWageredNanoErg: entry.totalWageredNanoErg.toString(),
    netProfitNanoErg: entry.netProfitNanoErg.toString(),
  };
}

export function deserializeLeaderboardEntry(entry: WireLeaderboardEntry): PlayerLeaderboardEntry {
  return {
    ...entry,
    totalWonNanoErg: BigInt(entry.totalWonNanoErg || 0),
    totalLostNanoErg: BigInt(entry.totalLostNanoErg || 0),
    totalWageredNanoErg: BigInt(entry.totalWageredNanoErg || 0),
    netProfitNanoErg: BigInt(entry.netProfitNanoErg || 0),
  };
}

export function serializeMatchHistoryItem(item: MatchHistoryItem): WireMatchHistoryItem {
  return {
    ...item,
    wagerNanoErg: item.wagerNanoErg.toString(),
    finalPotNanoErg: item.finalPotNanoErg.toString(),
    profitNanoErg: item.profitNanoErg.toString(),
  };
}

export function deserializeMatchHistoryItem(item: WireMatchHistoryItem): MatchHistoryItem {
  return {
    ...item,
    wagerNanoErg: BigInt(item.wagerNanoErg || 0),
    finalPotNanoErg: BigInt(item.finalPotNanoErg || 0),
    profitNanoErg: BigInt(item.profitNanoErg || 0),
  };
}
