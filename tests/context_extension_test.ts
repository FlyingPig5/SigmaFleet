import { describe, it, expect } from 'vitest';
import { orderContextExtension, toBroadcastTx } from '../src/lib/blockchain/fleet';

/**
 * The Ergo node re-serializes a ContextExtension from its own Scala Map before
 * computing the transaction id and the message input signatures are checked
 * against. Fleet writes entries in ascending key order, which only agrees with
 * that Map up to four entries. From five the node uses a CHAMP HashMap ordered by
 * `improve(hash) & 31`.
 *
 * Node-confirmed (mainnet 6.0.3, via /transactions/check): for contiguous keys
 * 0..N-1, transactions carrying 6, 7, 8 and 10 context variables were rejected
 * with `Success((false, <cost>))` in ascending order and accepted in the order
 * below. The order for keys {0,1,2,3,4,5} was additionally brute-forced against
 * the node's reported transaction id. The sparse-key case is the model's
 * prediction only -- the bot never uses sparse keys, so it is untested on-chain.
 */
describe('context extension ordering', () => {
  const ext = (keys: number[]) =>
    Object.fromEntries(keys.map((k) => [k, `0e0${k}`])) as Record<string, string>;
  const orderOf = (keys: number[]) =>
    Object.keys(orderContextExtension(ext(keys))).map(Number);

  it('leaves four or fewer entries alone (node Map is insertion-ordered there)', () => {
    expect(orderOf([0])).toEqual([0]);
    expect(orderOf([0, 1])).toEqual([0, 1]);
    expect(orderOf([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
  });

  it('matches the node Map order once the extension reaches five entries', () => {
    expect(orderOf([0, 1, 2, 3, 4])).toEqual([0, 1, 2, 3, 4]);
    // A five-shot salvo: action byte + five Merkle proofs. This is the case that
    // made every turn after the opening salvo unbroadcastable.
    expect(orderOf([0, 1, 2, 3, 4, 5])).toEqual([0, 5, 1, 2, 3, 4]);
    expect(orderOf([0, 1, 2, 3, 4, 5, 6])).toEqual([0, 5, 1, 6, 2, 3, 4]);
    expect(orderOf([0, 1, 2, 3, 4, 5, 6, 7])).toEqual([0, 5, 1, 6, 2, 7, 3, 4]);
    // Sparse keys: model prediction, not verified against a node (unused by the bot).
    expect(orderOf([0, 1, 2, 3, 4, 9])).toEqual([0, 1, 9, 2, 3, 4]);
  });

  it('keeps every entry and its value intact while reordering', () => {
    const source = ext([0, 1, 2, 3, 4, 5]);
    const ordered = orderContextExtension(source);
    expect(Object.keys(ordered)).toHaveLength(6);
    for (const [k, v] of Object.entries(source)) {
      expect(ordered[String(Number(k)).padStart(3, '0')]).toBe(v);
    }
  });

  it('emits keys JavaScript will not re-sort as array indices', () => {
    // A plain object would silently restore ascending order and undo the fix.
    const ordered = orderContextExtension(ext([0, 1, 2, 3, 4, 5]));
    const roundTripped = Object.keys({ ...ordered });
    expect(roundTripped).toEqual(['000', '005', '001', '002', '003', '004']);
  });

  // The JSON key order on the wire does not matter: the node parses the extension
  // into its own Map and re-derives the serialization order from that. What matters
  // is that the keys are plain decimals and every value survives.
  it('normalises padded keys back to plain decimals for broadcast', () => {
    const signed = {
      id: 'ab'.repeat(32),
      inputs: [{ boxId: 'cd'.repeat(32), spendingProof: { proofBytes: 'ff', extension: orderContextExtension(ext([0, 1, 2, 3, 4, 5])) } }],
      outputs: [],
    };
    const broadcast = toBroadcastTx(signed);
    const sent = broadcast.inputs[0].spendingProof.extension;
    expect(Object.keys(sent).sort()).toEqual(['0', '1', '2', '3', '4', '5']);
    for (let k = 0; k <= 5; k++) expect(sent[String(k)]).toBe(`0e0${k}`);
    expect(broadcast.inputs[0].spendingProof.proofBytes).toBe('ff');
  });

  it('fills in an empty proof and extension when an input has neither', () => {
    const broadcast = toBroadcastTx({ inputs: [{ boxId: 'ef'.repeat(32) }], outputs: [] });
    expect(broadcast.inputs[0].spendingProof).toEqual({ proofBytes: '', extension: {} });
  });
});
