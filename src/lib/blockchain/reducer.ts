import { DEFAULT_NODE_URL } from '@/config/nodes';

let headersCache: any = null;
let headersCacheTime = 0;

function stringifySafe(obj: any): string {
  return JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export async function reduceUnsignedTx(
  unsignedTxJson: any,
  inputBoxes: any[],
  dataBoxes: any[] = [],
  nodeUrl?: string
): Promise<string> {
  const wasm = await import('ergo-lib-wasm-nodejs');

  const now = Date.now();
  if (!headersCache || now - headersCacheTime > 5_000) {
    try {
      const targetNodeUrl = nodeUrl ? nodeUrl.replace(/\/$/, '') : DEFAULT_NODE_URL;
      
      // The node's /blocks/lastHeaders endpoint is frequently stuck/bugged and returns stale data.
      // To ensure we get the exact live headers, we fetch /info to get bestHeaderId, 
      // then walk backwards 10 blocks.
      const infoRes = await fetch(`${targetNodeUrl}/info`, { signal: AbortSignal.timeout(2000) });
      if (!infoRes.ok) throw new Error('Failed to fetch node info');
      const info = await infoRes.json();
      
      let currentHeaderId = info.bestHeaderId;
      const headers = [];
      
      for (let i = 0; i < 10; i++) {
        const headerRes = await fetch(`${targetNodeUrl}/blocks/${currentHeaderId}/header`, { signal: AbortSignal.timeout(2000) });
        if (!headerRes.ok) throw new Error(`Failed to fetch header ${currentHeaderId}`);
        const header = await headerRes.json();
        headers.push(header);
        currentHeaderId = header.parentId;
      }
      
      headersCache = headers;
      headersCacheTime = now;
    } catch (e) {
      // Offline or unreachable node: generate synthetic headers matching transaction height
      const targetHeight = unsignedTxJson?.creationHeight || (inputBoxes && inputBoxes.length > 0 && inputBoxes[0]?.creationHeight ? inputBoxes[0].creationHeight + 1 : 1250000);
      const fallbackHeaders = [];
      for (let i = 0; i < 10; i++) {
        fallbackHeaders.push({
          id: (i + 1).toString(16).padStart(64, '0'),
          parentId: (i + 2).toString(16).padStart(64, '0'),
          height: targetHeight - i,
          version: 2,
          timestamp: Date.now() - i * 120000,
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
        });
      }
      headersCache = fallbackHeaders;
      headersCacheTime = now;
    }
  }

  if (!headersCache) {
    const targetHeight = unsignedTxJson?.creationHeight || (inputBoxes && inputBoxes.length > 0 && inputBoxes[0]?.creationHeight ? inputBoxes[0].creationHeight + 1 : 1250000);
    const fallbackHeaders = [];
    for (let i = 0; i < 10; i++) {
      fallbackHeaders.push({
        id: (i + 1).toString(16).padStart(64, '0'),
        parentId: (i + 2).toString(16).padStart(64, '0'),
        height: targetHeight - i,
        version: 2,
        timestamp: Date.now() - i * 120000,
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
      });
    }
    headersCache = fallbackHeaders;
    headersCacheTime = now;
  }

  const blockHeaders = wasm.BlockHeaders.from_json(headersCache as any[]);
  const preHeader = wasm.PreHeader.from_block_header(blockHeaders.get(0));
  const params = wasm.Parameters.default_parameters();
  const stateCtx = new wasm.ErgoStateContext(preHeader, blockHeaders, params);
  const wasmUnsignedTx = wasm.UnsignedTransaction.from_json(stringifySafe(unsignedTxJson));
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

  const reducedBytes = reducedTx.sigma_serialize_bytes();
  return Buffer.from(reducedBytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
