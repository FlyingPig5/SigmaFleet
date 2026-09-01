# Sigma Fleet — Contracts & Cryptography

On-chain Battleships for the [Ergo](https://ergoplatform.org) blockchain.
You can Play it at https://games.ebiome.cc

Two players each stake ERG, hide three ships on an 8×8 grid, and fire five-shot salvos at
each other. Neither player can see the other's board — and neither can lie about it. Every
shot is answered with a Merkle proof that the contract verifies itself, so the score is
derived on chain rather than reported by a client.

This repository contains **the smart contracts and the cryptography that backs them**. The
game client is not open source; nothing here needs it. Everything below can be read,
compiled and tested on its own.

---

## Why this is worth reviewing

The interesting problem is that Battleships needs hidden state, and a public ledger has
none. The solution here:

- Before a shot is fired, each player commits to a **Merkle root** of their 64-cell board.
- When shot at, the defender supplies a **Merkle proof per targeted cell**. The contract
  recomputes the root from the proof and compares it to the committed one.
- The leaf's first byte is the answer — `1` hit, `0` miss — and it is bound by the proof.
  **The contract counts the hits itself.** Neither client ever supplies a score.
- To collect, the winner reveals their whole board. The contract checks it hashes to the
  original commitment, is a legal `{5,3,2}` fleet, and that the recorded score matches the
  revealed board.

If any of that is wrong, the funds are wrong. That is what this repository is for.

---

## Layout

```
src/contracts/
  sigma_fleet.ts        ErgoScript — the battle contract, readable copy
  lobby.ts              ErgoScript — the matchmaking/escrow contract, readable copy

src/lib/blockchain/
  fleet.ts              THE SOURCE OF TRUTH. Both contracts as template literals,
                        plus every transaction builder that spends them.
  reducer.ts            Reduces an unsigned tx via ergo-lib-wasm (used by the tests)

src/lib/crypto/
  merkle.ts             Board commitment, 6-level Merkle tree, proof generation.
                        The off-chain half of the protocol.

src/lib/game/gameTypes.ts   Fleet definition ({5,3,2}) and shared types
src/config/developer.ts     Protocol fee address and constants
src/config/nodes.ts         Public Ergo nodes used by the reducer/tests

tests/                  62 tests, including adversarial ones (see below)
```

### Reading order

1. `src/contracts/sigma_fleet.ts` — the battle contract, top to bottom.
2. `src/lib/crypto/merkle.ts` — the proof format the contract expects.
3. `tests/e2e_game_simulation.test.ts` — a full match, played out.

> **`src/contracts/*.ts` are reference copies.** The text that is actually compiled lives in
> `fleet.ts`. The copies exist so the scripts can be read and diffed on their own, and
> `tests/contract_reference.test.ts` fails if the two ever drift apart.

---

## The battle contract

An 8×8 board is 64 cells; a fleet is one 5-cell carrier, one 3-cell cruiser and one 2-cell
destroyer, so **10 hits sinks a fleet**.

### Box registers

| Register | Type | Contents |
|---|---|---|
| `R4` | `Coll[GroupElement]` | `[P1 key, P2 key, protocol key]` |
| `R5` | `Coll[Coll[Byte]]` | `[P1 root, P2 root, P1 board hash, P2 board hash]` |
| `R6` | `Coll[Int]` | `[phase, P1 hits, P2 hits, last sunk code]` |
| `R7` | `Coll[Int]` | Coordinates of the salvo currently in flight |
| `R8` | `Coll[Coll[Byte]]` | `[P1 64-byte shot history, P2 64-byte shot history]` |
| `R9` | `Coll[Int]` | `[expiry height, timeout window in blocks]` |

### Actions

Selected by context variable `0`.

**`0` — Play turn.** Answers the incoming salvo with one Merkle proof per target (context
vars `1`–`5`), then fires back. Enforced: alternating phase; exactly five shots (four on the
final turn, since 64 = 12×5 + 4); strictly ascending coordinates, so a salvo cannot contain
duplicates; append-only shot history with no cell fired twice; hit counts equal to what the
proofs prove; players, commitments and timeout window unchanged; pot and script unchanged;
and the turn clock not yet expired.

**`1` — Claim / settle.** Reveals the claimant's 102-byte board payload in context var `99`.
Checked: it hashes to the commitment in `R5`; it is a legal fleet — three ships of the right
lengths, straight, in bounds and non-overlapping; the claimant actually has claim rights
(10 hits, or full board coverage); and `honestScore` — the opponent's recorded hits must
equal their true hits against the revealed board, allowing for a salvo still unevaluated in
`R7`. A draw is paid when the opponent also reached 10.

**`2` — Claim timeout.** After `HEIGHT > timeoutHeight`, the player who is *not* the active
one sweeps the pot. Note this is decided by phase, not by score.

Anything else is rejected.

### Payouts

A 1% protocol fee is taken on settlement. The winner receives `pot − fee`; a draw splits
`(pot − fee)` evenly. A timeout pays the whole `pot − fee` to the claimant.

---

## The commitment scheme

`merkle.ts` builds a **6-level Blake2b-256 Merkle tree** over 64 leaves, one per cell.

Each leaf is `blake2b256(cellState ‖ perCellSalt)`, where the per-cell salt is derived from a
32-byte CSPRNG master salt. The salt is what stops an opponent brute-forcing a 64-cell board
from its root, and it means a per-cell proof reveals that cell and nothing else.

A proof is **224 bytes**: a 32-byte leaf preimage followed by six 32-byte siblings. The
contract folds it with `powers = [1,2,4,8,16,32]`, taking the cell index bit by bit to decide
sibling order — identical to `generateMerkleProof`. `tests/merkle.test.ts` checks the two
agree for ship and water cells across the tree.

The settlement payload is 102 bytes: 64 grid bytes, 6 geometry descriptors (start and
direction per ship), and the 32-byte master salt.

---

## Running it

```bash
npm install
npx vitest run                 # 62 tests
npx vitest run tests/merkle.test.ts
```

`vitest` compiles both contracts with `@fleet-sdk/compiler` and reduces real transactions
through `ergo-lib-wasm`, so the tests exercise the deployed scripts rather than a model
of them.

For reference, the current build produces:

```
battleships ErgoTree   3383 bytes
lobby      ErgoTree     473 bytes
battleships tree hash   b146c39cfb9f603450be9521feeafe91587afc44db3a2aab1d16cf8f680df438
```

The lobby contract stores that tree hash in `R8` and refuses to open a match whose output
script does not match it — so a lobby can only ever hand its escrow to this exact contract.

### The adversarial tests

These are the ones worth reading. Each builds a transaction that *should* fail and asserts
the contract rejects it:

- playing a turn after the clock expired
- claiming a timeout before it expired
- settling with overlapping ships
- claiming a draw that is not a draw ("tie theft")
- forging a board hash that disagrees with the play-time Merkle root
- an opponent denying hits, resolved by full-board coverage

---

## Known issues

Reviewed by the author, not by an outside auditor. Two things worth knowing before you read
the code and find them yourself:

**The play-time Merkle root is not bound to the settlement board hash.** `R5` carries two
independent commitments per player — the root used during play, and the hash revealed at
settlement — and nothing forces them to describe the same board. Someone can therefore commit
an all-water root for play, so every shot against them reads as a miss.

It is not exploitable for profit. To collect they must reveal a board matching their hash,
and `honestScore` then rejects the claim, so they forfeit their stake and the honest player
takes the pot by claim or by timeout. Because the attack only ever loses money, it is
deliberately left open rather than risk rewriting working contract code. The fix, should the
trade-off change, is to embed the root inside the hashed payload and compare it at
settlement — O(1).

**`cleanHex32` strips leading type-prefix bytes unconditionally**, which can corrupt an
otherwise valid 32-byte root whose first bytes happen to match a prefix pattern. No attacker
is involved; a player could lock up their own deposit. Unlike the above this has no economic
argument protecting it.

Turn timeouts are currently fixed at 24 hours, and the client caps wagers at 1 ERG. Neither
is a contract limit.

---

## Please note

This is new software holding real funds on mainnet. Play with amounts you would not mind
losing. If you find something, open an issue — and if it is a live vulnerability, contact the
author privately first.

Contracts and cryptography released for review and reuse. The game client is not included.
