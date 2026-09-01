import {
  OutputBuilder,
  TransactionBuilder,
  SColl,
  SByte,
  SInt,
  SLong,
  SGroupElement,
  ErgoAddress,
  type Box,
  type Amount,
} from '@fleet-sdk/core';
import { compile } from '@fleet-sdk/compiler';
import { parse } from '@fleet-sdk/serializer';
import { blake2b256 } from '@fleet-sdk/crypto';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { DEV_CONFIG } from '@/config/developer';
import { extractShipGeometry } from '@/lib/crypto/merkle';

// Global Game Configuration
export const DEFAULT_DEV_PK = DEV_CONFIG.DEV_PUBLIC_KEY;
export const DEFAULT_DEV_ADDRESS = DEV_CONFIG.DEV_ADDRESS;
export const DEV_FEE_PERCENT = DEV_CONFIG.DEV_FEE_PERCENT;
export const MINER_FEE_NANO_ERG = DEV_CONFIG.MINER_FEE_NANO_ERG;
export const TIMEOUT_BLOCK_DELTA = DEV_CONFIG.TIMEOUT_BLOCKS;
export const SALVO_SIZE = 5;

export const LOBBY_SCRIPT = `
/**
 * ============================================================================
 *                       ERGOSHIPS V2 - LOBBY ESCROW CONTRACT
 * ============================================================================
 * 
 * An on-chain matchmaking and wager escrow contract for Sigma Fleet.
 * 
 * ON-CHAIN BOX REGISTERS:
 * -----------------------
 * - R4: Coll[GroupElement]   -> [0: Host Public Key, 1: Protocol Developer Public Key]
 * - R5: Coll[Coll[Byte]]     -> [0: Host 32B Salted Hash]
 * - R6: Coll[Int]            -> Empty collection []
 * - R7: Coll[Byte]           -> Empty collection []
 * - R8: Coll[Byte]           -> 32-byte Blake2b-256 hash of the compiled Battleships contract ErgoTree
 * - R9: Int                  -> Turn Timeout Duration in Blocks (e.g. 30 blocks ≈ 60 mins)
 * 
 * CONTEXT VARIABLES:
 * ------------------
 * - getVar[Byte](0)          -> Action: 0 = Cancel / Refund, 1 = Accept Match
 */
{
  val action = getVar[Byte](0).getOrElse(0.toByte)

  // Hardcoded Protocol Developer Public Key
  val DEV_PK = decodePoint(fromBase16("026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b"))

  // ==========================================================================
  // ACTION 0: HOST 100% REFUND / CANCEL LOBBY
  // ==========================================================================
  if (action == 0.toByte) {
    val lobbyPlayers = SELF.R4[Coll[GroupElement]].get
    val host = lobbyPlayers(0)
    proveDlog(host)

  // ==========================================================================
  // ACTION 1: ACCEPT LOBBY / MATCH START
  // ==========================================================================
  } else {
    val lobbyPlayers = SELF.R4[Coll[GroupElement]].get
    val host         = lobbyPlayers(0)
    val battleshipsScript = SELF.R8[Coll[Byte]].get

    val outGame = OUTPUTS(0)

    // Rule 1: Player Roster Preservation [Host, Challenger, Dev] with Hardcoded Dev PK
    val outPlayers   = outGame.R4[Coll[GroupElement]].get
    val validPlayers = (outPlayers.size == 3) && 
                       (outPlayers(0) == host) && 
                       (outPlayers(2) == DEV_PK) && 
                       (lobbyPlayers(1) == DEV_PK)

    // Rule 2: Board Commitment Hashes [Host Board Hash, Challenger Board Hash]
    val lobbyHashes  = SELF.R5[Coll[Coll[Byte]]].get
    val outHashes    = outGame.R5[Coll[Coll[Byte]]].get
    val validRoots   = (outHashes.size == 4) && (outHashes(0) == lobbyHashes(0)) && (outHashes(2) == lobbyHashes(1))

    // Rule 3: Initial Match State (Phase 0 = Host first strike, P1 Hits = 0, P2 Hits = 0)
    val validState   = outGame.R6[Coll[Int]].get == Coll(0, 0, 0)

    // Rule 4: Clean Initial Salvo (Opening salvo will be fired by Host on Round 1)
    val initialTargets = outGame.R7[Coll[Int]].get
    val validInitialTargets = initialTargets.size == 0

    // Rule 5: Zero-Initialized Attack Radar Histories (64 zero bytes for both players)
    val histories    = outGame.R8[Coll[Coll[Byte]]].get
    val validHistory = (histories.size == 2) && 
                       (histories(0).size == 64) && 
                       (histories(1).size == 64) && 
                       histories(0).forall({ (b: Byte) => b == 0.toByte }) && 
                       histories(1).forall({ (b: Byte) => b == 0.toByte })

    // Rule 6: Turn Timeout Parameters [Timeout Height, Timeout Blocks] with Minimum Floor (>= 30)
    val timeoutBlocks = SELF.R9[Int].get
    val outTimeouts   = outGame.R9[Coll[Int]].get
    val validTimeouts = (timeoutBlocks >= 30) && (timeoutBlocks <= 720) &&
                        (outTimeouts.size == 2) && 
                        (outTimeouts(1) == timeoutBlocks) && 
                        (outTimeouts(0) >= HEIGHT + timeoutBlocks - 10) && 
                        (outTimeouts(0) <= HEIGHT + timeoutBlocks + 4)

    // Rule 7: Matching Escrow Value & Pure ERG Guard (Tokens Strictly Disallowed)
    val validFunds    = (outGame.value == SELF.value * 2L) && (SELF.tokens.size == 0) && (outGame.tokens.size == 0)

    // Rule 8: Battleships Contract Verification (Output script must match verified ErgoTree hash)
    val validContract = blake2b256(outGame.propositionBytes) == battleshipsScript

    // All match start rules must strictly pass
    val isAccept = validPlayers && 
                   validRoots && 
                   validState && 
                   validInitialTargets && 
                   validTimeouts && 
                   validHistory && 
                   validFunds && 
                   validContract

    sigmaProp(isAccept)
  }
}`;

export const BATTLESHIPS_SCRIPT = `
/**
 * ============================================================================
 *                    ERGOSHIPS V2 - BATTLESHIPS SMART CONTRACT
 * ============================================================================
 * 
 * An on-chain, trustless, peer-to-peer Battleships game running on Ergo (eUTXO).
 * 
 * ON-CHAIN BOX REGISTERS:
 * -----------------------
 * - R4: Coll[GroupElement]   -> [0: Player 1 PK, 1: Player 2 PK, 2: Protocol Dev PK]
 * - R5: Coll[Coll[Byte]]     -> [0: P1 32B Salted Hash, 1: P2 32B Salted Hash]
 * - R6: Coll[Int]            -> [0: Turn Phase (0=P1, 1=P2), 1: P1 Hits (0-10), 2: P2 Hits (0-10)]
 * - R7: Coll[Int]            -> [Target Coordinates (0-63) fired in the current in-flight salvo]
 * - R8: Coll[Coll[Byte]]     -> [0: P1 64-Byte Attack History, 1: P2 64-Byte Attack History]
 * - R9: Coll[Int]            -> [0: Expiration Block Height, 1: Timeout Window in Blocks]
 * 
 * CONTEXT VARIABLES:
 * ------------------
 * - getVar[Byte](0)          -> Action: 0 = Play Turn, 1 = Claim Win/Settlement, 2 = Claim Timeout
 * - getVar[Coll[Byte]](99)   -> 96-byte salted board payload (64 bytes grid + 32 bytes CSPRNG salt)
 */
{
  // --------------------------------------------------------------------------
  // 1. CONTEXT & STATE EXTRACTION
  // --------------------------------------------------------------------------

  val action = getVar[Byte](0).get

  // Hardcoded Protocol Developer Proposition
  val DEV_PK  = decodePoint(fromBase16("026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b"))
  val devProp = proveDlog(DEV_PK)

  val players = SELF.R4[Coll[GroupElement]].get
  val p1Prop  = proveDlog(players(0))
  val p2Prop  = proveDlog(players(1))

  val roots       = SELF.R5[Coll[Coll[Byte]]].get
  val p1Root      = roots(0)
  val p2Root      = roots(1)
  val p1BoardHash = if (roots.size >= 4) roots(2) else roots(0)
  val p2BoardHash = if (roots.size >= 4) roots(3) else roots(1)

  val gameState = SELF.R6[Coll[Int]].get
  val phase  = gameState(0)
  val p1Hits = gameState(1)
  val p2Hits = gameState(2)

  val histories = SELF.R8[Coll[Coll[Byte]]].get
  val p1History = histories(0)
  val p2History = histories(1)

  val timeouts = SELF.R9[Coll[Int]].get
  val timeoutHeight = timeouts(0)
  val timeoutBlocks = timeouts(1)

  val totalPot   = SELF.value
  val devFeeNano = totalPot / 100
  val winPayout  = totalPot - devFeeNano
  val tiePayout  = winPayout / 2

  // --------------------------------------------------------------------------
  // 2. ACTION BRANCHES
  // --------------------------------------------------------------------------

  // ==========================================================================
  // ACTION 0: PLAY TURN / COUNTER-SALVO (WITH REAL-TIME MERKLE PROOFS)
  // ==========================================================================
  if (action == 0.toByte) {
    val outGame = OUTPUTS(0)

    val outState   = outGame.R6[Coll[Int]].get
    val nextPhase  = outState(0)
    val nextP1Hits = outState(1)
    val nextP2Hits = outState(2)

    val nextSalvo     = outGame.R7[Coll[Int]].get
    val nextHistories = outGame.R8[Coll[Coll[Byte]]].get
    val nextP1History = nextHistories(0)
    val nextP2History = nextHistories(1)

    val nextTimeouts      = outGame.R9[Coll[Int]].get
    val nextTimeoutHeight = nextTimeouts(0)

    // Rule 1: Alternating Phase Transition (0 -> 1 or 1 -> 0)
    val validPhase = if (phase == 0) (nextPhase == 1) else (nextPhase == 0)
    val isP1Turn   = (phase == 0)
    val targetRoot = if (isP1Turn) p1Root else p2Root
    
    // Rule 2: Salvo Size Constraints (Strict 5 shots, except the final endgame turn with 4 remaining cells: 64 = 12*5 + 4)
    val activeHistory = if (isP1Turn) p1History else p2History
    val alreadyFiredCount = activeHistory.fold(0, { (acc: Int, b: Byte) => if (b == 1.toByte) acc + 1 else acc })
    val expectedSalvoSize = if (alreadyFiredCount <= 59) 5 else (64 - alreadyFiredCount)
    
    val p2AlreadyWon = isP1Turn && (nextP2Hits == 10)
    val validSalvoSize = if (p2AlreadyWon) (nextSalvo.size == 0) else (nextSalvo.size == expectedSalvoSize) && (nextSalvo.size > 0)
    
    // Rule 3: Coordinate Uniqueness (Prevents duplicate coordinate exploit within the same salvo)
    val validSalvoUnique = if (nextSalvo.size == 5) {
      nextSalvo(0) < nextSalvo(1) && nextSalvo(1) < nextSalvo(2) && nextSalvo(2) < nextSalvo(3) && nextSalvo(3) < nextSalvo(4)
    } else if (nextSalvo.size == 4) {
      nextSalvo(0) < nextSalvo(1) && nextSalvo(1) < nextSalvo(2) && nextSalvo(2) < nextSalvo(3)
    } else if (nextSalvo.size == 3) {
      nextSalvo(0) < nextSalvo(1) && nextSalvo(1) < nextSalvo(2)
    } else if (nextSalvo.size == 2) {
      nextSalvo(0) < nextSalvo(1)
    } else {
      true
    }
    
    // Rule 4: Append-Only Cumulative History Integrity
    val validHistories = if (isP1Turn) {
      val alreadyShot = nextSalvo.exists({ (cell: Int) => p1History(cell) == 1.toByte })
      val expectedNextP1History = nextSalvo.fold(p1History, { (acc: Coll[Byte], cell: Int) => acc.updated(cell, 1.toByte) })
      (!alreadyShot) && (nextP1History == expectedNextP1History) && (nextP2History == p2History)
    } else {
      val alreadyShot = nextSalvo.exists({ (cell: Int) => p2History(cell) == 1.toByte })
      val expectedNextP2History = nextSalvo.fold(p2History, { (acc: Coll[Byte], cell: Int) => acc.updated(cell, 1.toByte) })
      (!alreadyShot) && (nextP2History == expectedNextP2History) && (nextP1History == p1History)
    }

    // Rule 5: Cryptographic Merkle Proof Verification & Real-Time Score Enforcement
    val targets = SELF.R7[Coll[Int]].get
    val isIncoming4 = (targets.size == 4)
    val hasIncoming = (targets.size > 0)

    val proofResult = if (hasIncoming) {
      val powers = Coll(1, 2, 4, 8, 16, 32)
      val levels = Coll(0, 1, 2, 3, 4, 5)

      val pr0 = getVar[Coll[Byte]](1).get
      val pr1 = getVar[Coll[Byte]](2).get
      val pr2 = getVar[Coll[Byte]](3).get
      val pr3 = getVar[Coll[Byte]](4).get

      val t0 = targets(0); val t1 = targets(1); val t2 = targets(2); val t3 = targets(3)

      val root0 = levels.fold(blake2b256(pr0.slice(0, 32)), { (curr: Coll[Byte], lvl: Int) =>
        val sib = pr0.slice(32 + lvl * 32, 64 + lvl * 32)
        if (((t0 / powers(lvl)) % 2) == 0) blake2b256(curr ++ sib) else blake2b256(sib ++ curr)
      })
      val v0 = (root0 == targetRoot) && (pr0.size == 224) && (pr0(0) == 0.toByte || pr0(0) == 1.toByte)
      val hit0 = if (pr0(0) == 1.toByte) 1 else 0

      val root1 = levels.fold(blake2b256(pr1.slice(0, 32)), { (curr: Coll[Byte], lvl: Int) =>
        val sib = pr1.slice(32 + lvl * 32, 64 + lvl * 32)
        if (((t1 / powers(lvl)) % 2) == 0) blake2b256(curr ++ sib) else blake2b256(sib ++ curr)
      })
      val v1 = (root1 == targetRoot) && (pr1.size == 224) && (pr1(0) == 0.toByte || pr1(0) == 1.toByte)
      val hit1 = if (pr1(0) == 1.toByte) 1 else 0

      val root2 = levels.fold(blake2b256(pr2.slice(0, 32)), { (curr: Coll[Byte], lvl: Int) =>
        val sib = pr2.slice(32 + lvl * 32, 64 + lvl * 32)
        if (((t2 / powers(lvl)) % 2) == 0) blake2b256(curr ++ sib) else blake2b256(sib ++ curr)
      })
      val v2 = (root2 == targetRoot) && (pr2.size == 224) && (pr2(0) == 0.toByte || pr2(0) == 1.toByte)
      val hit2 = if (pr2(0) == 1.toByte) 1 else 0

      val root3 = levels.fold(blake2b256(pr3.slice(0, 32)), { (curr: Coll[Byte], lvl: Int) =>
        val sib = pr3.slice(32 + lvl * 32, 64 + lvl * 32)
        if (((t3 / powers(lvl)) % 2) == 0) blake2b256(curr ++ sib) else blake2b256(sib ++ curr)
      })
      val v3 = (root3 == targetRoot) && (pr3.size == 224) && (pr3(0) == 0.toByte || pr3(0) == 1.toByte)
      val hit3 = if (pr3(0) == 1.toByte) 1 else 0

      val proofsValid4 = v0 && v1 && v2 && v3
      val hits4        = hit0 + hit1 + hit2 + hit3

      if (isIncoming4) {
        (proofsValid4, hits4)
      } else {
        val pr4   = getVar[Coll[Byte]](5).get
        val t4    = targets(4)
        val root4 = levels.fold(blake2b256(pr4.slice(0, 32)), { (curr: Coll[Byte], lvl: Int) =>
          val sib = pr4.slice(32 + lvl * 32, 64 + lvl * 32)
          if (((t4 / powers(lvl)) % 2) == 0) blake2b256(curr ++ sib) else blake2b256(sib ++ curr)
        })
        val v4   = (root4 == targetRoot) && (pr4.size == 224) && (pr4(0) == 0.toByte || pr4(0) == 1.toByte)
        val hit4 = if (pr4(0) == 1.toByte) 1 else 0
        (proofsValid4 && v4, hits4 + hit4)
      }
    } else {
      (true, 0)
    }

    val proofsValid = proofResult._1
    val newHits     = proofResult._2

    val expectedNextP1Hits = if (isP1Turn) p1Hits else (p1Hits + newHits)
    val expectedNextP2Hits = if (isP1Turn) (p2Hits + newHits) else p2Hits
    val validHits = (nextP1Hits == expectedNextP1Hits) && 
                    (nextP2Hits == expectedNextP2Hits) && 
                    (nextP1Hits <= 10) && 
                    (nextP2Hits <= 10) && 
                    proofsValid

    // Rule 6: Immutability of Players, Fleet Hashes, Developer Key, and Timeout Settings
    val outPlayers = outGame.R4[Coll[GroupElement]].get
    val outHashes  = outGame.R5[Coll[Coll[Byte]]].get
    val validPreservation = (outPlayers == players) && 
                            (outPlayers(2) == DEV_PK) && 
                            (outHashes == roots) && 
                            (nextTimeouts(1) == timeoutBlocks)

    // Rule 7: Mempool Timeout Window (allows up to 10 blocks of mempool delay, max +4)
    val validTimeout = (nextTimeoutHeight >= HEIGHT + timeoutBlocks - 10) && (nextTimeoutHeight <= HEIGHT + timeoutBlocks + 4)

    // Rule 8: Value & Contract Preservation (Pure ERG Guard)
    val validTokens = (SELF.tokens.size == 0) && (outGame.tokens.size == 0)
    val validOutput = (outGame.propositionBytes == SELF.propositionBytes) && (outGame.value == SELF.value) && validTokens

    // Rule 9: Temporal Anti-Front-Running Guard (Cannot play turn if turn has already timed out)
    val notTimedOut = HEIGHT <= timeoutHeight

    // Rule 10: Active Player Signature Required
    val signer = if (isP1Turn) p1Prop else p2Prop

    sigmaProp(validPhase && validSalvoSize && validSalvoUnique && validHistories && validHits && validPreservation && validTimeout && validOutput && notTimedOut) && signer

  // ==========================================================================
  // SETTLEMENT / TIMEOUT COMMON VALIDATION (102-BYTE BOARD AUDIT)
  // ==========================================================================
  } else {
    val rawPayload = getVar[Coll[Byte]](99).get
    val rawBoard   = rawPayload.slice(0, 64)

    val shipCount = rawBoard.fold(0, { (acc: Int, b: Byte) => acc + b.toInt })
    val validCells = rawBoard.forall({ (b: Byte) => b == 0.toByte || b == 1.toByte })

    // Cryptographic Geometry Validation: 102 bytes total (64 grid + 6 descriptors + 32 salt)
    val carrierStart = rawPayload(64).toInt
    val carrierDir   = rawPayload(65).toInt
    val carrierStep  = if (carrierDir == 0) 1 else 8
    val validCarrierBounds = if (carrierDir == 0) ((carrierStart % 8) <= 3) else (carrierStart <= 31)
    val validCarrier = validCarrierBounds &&
      (rawBoard(carrierStart) == 1.toByte) &&
      (rawBoard(carrierStart + carrierStep) == 1.toByte) &&
      (rawBoard(carrierStart + carrierStep * 2) == 1.toByte) &&
      (rawBoard(carrierStart + carrierStep * 3) == 1.toByte) &&
      (rawBoard(carrierStart + carrierStep * 4) == 1.toByte)

    val cruiserStart = rawPayload(66).toInt
    val cruiserDir   = rawPayload(67).toInt
    val cruiserStep  = if (cruiserDir == 0) 1 else 8
    val validCruiserBounds = if (cruiserDir == 0) ((cruiserStart % 8) <= 5) else (cruiserStart <= 47)
    val validCruiser = validCruiserBounds &&
      (rawBoard(cruiserStart) == 1.toByte) &&
      (rawBoard(cruiserStart + cruiserStep) == 1.toByte) &&
      (rawBoard(cruiserStart + cruiserStep * 2) == 1.toByte)

    val destroyerStart = rawPayload(68).toInt
    val destroyerDir   = rawPayload(69).toInt
    val destroyerStep  = if (destroyerDir == 0) 1 else 8
    val validDestroyerBounds = if (destroyerDir == 0) ((destroyerStart % 8) <= 6) else (destroyerStart <= 55)
    val validDestroyer = validDestroyerBounds &&
      (rawBoard(destroyerStart) == 1.toByte) &&
      (rawBoard(destroyerStart + destroyerStep) == 1.toByte)

    // Ship Non-Intersection Guard (Prevents overlapping ships & phantom submarine exploits)
    val carrierCells = Coll(carrierStart, carrierStart + carrierStep, carrierStart + carrierStep * 2, carrierStart + carrierStep * 3, carrierStart + carrierStep * 4)
    val cruiserCells = Coll(cruiserStart, cruiserStart + cruiserStep, cruiserStart + cruiserStep * 2)
    val destroyerCells = Coll(destroyerStart, destroyerStart + destroyerStep)

    val noOverlapCruiserCarrier   = cruiserCells.forall({ (r: Int) => carrierCells.forall({ (c: Int) => c != r }) })
    val noOverlapDestroyerCarrier = destroyerCells.forall({ (d: Int) => carrierCells.forall({ (c: Int) => c != d }) })
    val noOverlapDestroyerCruiser = destroyerCells.forall({ (d: Int) => cruiserCells.forall({ (r: Int) => r != d }) })
    val validNoOverlap = noOverlapCruiserCarrier && noOverlapDestroyerCarrier && noOverlapDestroyerCruiser

    val validGeometry = validCarrier && validCruiser && validDestroyer && validNoOverlap
    val validBoardFormat = (rawPayload.size == 102) && (shipCount == 10) && validCells && validGeometry

    // ========================================================================
    // ACTION 1: CLAIM WIN / MATCH SETTLEMENT
    // ========================================================================
    if (action == 1.toByte) {
      // Full 64-Cell Grid Coverage Check (Prevents Score Denial Deadlock & Ghost Fleet)
      val p1CoveredBoard = p1History.forall({ (b: Byte) => b == 1.toByte })
      val p2CoveredBoard = p2History.forall({ (b: Byte) => b == 1.toByte })

      val payloadHash = blake2b256(rawPayload)
      val isP1Claiming = payloadHash == p1BoardHash
      val isP2Claiming = payloadHash == p2BoardHash
      val validHash = isP1Claiming || isP2Claiming

      // The claimant must have actual claim rights
      val hasClaimRights = if (isP1Claiming) (p1Hits == 10) || p1CoveredBoard else (p2Hits == 10) || p2CoveredBoard
      val claimerHasPendingSalvo = if (isP1Claiming) (phase == 1) else (phase == 0)
      val validClaim = validHash && hasClaimRights && !claimerHasPendingSalvo

      val opponentHistory      = if (isP1Claiming) p2History else p1History
      val opponentRecordedHits = if (isP1Claiming) p2Hits else p1Hits

      // Calculate true total hits landed by opponent on claimant's board
      val opponentTrueHits = rawBoard.fold((0, 0), { (acc: (Int, Int), cell: Byte) =>
          val idx   = acc._1
          val hits  = acc._2
          val fired = opponentHistory(idx) == 1.toByte
          val isHit = (cell == 1.toByte) && fired
          val newHits = if (isHit) hits + 1 else hits
          (idx + 1, newHits)
      })._2
      
      // SECURE PENDING HITS ATTRIBUTION FIX:
      // Opponent only has an un-evaluated pending salvo in R7 if:
      // - P1 is claiming AND phase == 0 (P2 fired R7 in previous turn)
      // - P2 is claiming AND phase == 1 (P1 fired R7 in previous turn)
      val opponentHasPendingSalvo = if (isP1Claiming) (phase == 0) else (phase == 1)
      val pendingHits = if (opponentHasPendingSalvo) {
          val pendingTargets = SELF.R7[Coll[Int]].get
          pendingTargets.fold(0, { (hits: Int, idx: Int) =>
              if (rawBoard(idx) == 1.toByte) hits + 1 else hits
          })
      } else {
          0
      }
      
      val honestScore = (opponentTrueHits - pendingHits) == opponentRecordedHits

      // Proper Winner Evaluation:
      // If P1 claims, P1's effective score is 10 (since they have claim rights). P2's true score is evaluated.
      // If P2 claims, P2's effective score is 10 (since they have claim rights). P1's true score is evaluated.
      val claimerHas10 = true // Guaranteed by hasClaimRights
      val opponentHas10 = opponentTrueHits >= 10

      // If a player covered the board but has <10 hits, their opponent cheated
      val opponentCheated = if (isP1Claiming) (p1CoveredBoard && p1Hits < 10) else (p2CoveredBoard && p2Hits < 10)

      // A tie is only granted if the opponent hit 10 ships AND didn't cheat
      val isTie = opponentHas10 && !opponentCheated

      // If it's not a tie, the claimant MUST have won (since opponent didn't get 10)
      val claimerProp = if (isP1Claiming) p1Prop else p2Prop

      val validPayout = if (isTie) {
        (OUTPUTS(0).propositionBytes == p1Prop.propBytes) && (OUTPUTS(0).value >= tiePayout) &&
        (OUTPUTS(1).propositionBytes == p2Prop.propBytes) && (OUTPUTS(1).value >= tiePayout) &&
        (OUTPUTS(2).propositionBytes == devProp.propBytes) && (OUTPUTS(2).value >= devFeeNano)
      } else {
        (OUTPUTS(0).propositionBytes == claimerProp.propBytes) && (OUTPUTS(0).value >= winPayout) &&
        (OUTPUTS(1).propositionBytes == devProp.propBytes) && (OUTPUTS(1).value >= devFeeNano)
      }

      sigmaProp(validClaim && validBoardFormat && validHash && honestScore && validPayout) && claimerProp

    // ========================================================================
    // ACTION 2: CLAIM TIMEOUT / FORFEIT ESCROW SWEEP
    // ========================================================================
    } else if (action == 2.toByte) {
      val timeoutValid = HEIGHT > timeoutHeight

      val winnerProp           = if (phase == 0) p2Prop else p1Prop
      val winnerBoardHash      = if (phase == 0) p2BoardHash else p1BoardHash
      val opponentHistory      = if (phase == 0) p1History else p2History
      val opponentRecordedHits = if (phase == 0) p1Hits else p2Hits

      val validHash = blake2b256(rawPayload) == winnerBoardHash

      // True hits scored by the timed-out player on the claimant's board
      val opponentTrueHits = rawBoard.fold((0, 0), { (acc: (Int, Int), cell: Byte) =>
          val idx   = acc._1
          val hits  = acc._2
          val fired = opponentHistory(idx) == 1.toByte
          val isHit = (cell == 1.toByte) && fired
          val newHits = if (isHit) hits + 1 else hits
          (idx + 1, newHits)
      })._2

      // Timed-out player was the active player whose turn it was, so they have NO pending salvo in R7
      val honestScore = opponentTrueHits == opponentRecordedHits
      
      val validPayout = (OUTPUTS(0).propositionBytes == winnerProp.propBytes) && (OUTPUTS(0).value >= winPayout) &&
                        (OUTPUTS(1).propositionBytes == devProp.propBytes) && (OUTPUTS(1).value >= devFeeNano)

      sigmaProp(timeoutValid && validBoardFormat && validHash && honestScore && validPayout) && winnerProp

    // ========================================================================
    // DEFAULT: UNKNOWN ACTION REJECTED
    // ========================================================================
    } else {
      sigmaProp(false)
    }
  }
}`;

let cachedLobbyErgoTree: any = null;
let cachedBattleshipsErgoTree: any = null;

export function getLobbyErgoTree() {
  if (!cachedLobbyErgoTree) {
    cachedLobbyErgoTree = compile(LOBBY_SCRIPT, { version: 1 });
  }
  return cachedLobbyErgoTree;
}

export function getLobbyAddress(): string {
  const tree = getLobbyErgoTree();
  return ErgoAddress.fromErgoTree(tree.toHex()).encode();
}

export function getBattleshipsErgoTree() {
  if (!cachedBattleshipsErgoTree) {
    cachedBattleshipsErgoTree = compile(BATTLESHIPS_SCRIPT, { version: 1 });
  }
  return cachedBattleshipsErgoTree;
}

export function getBattleshipsAddress(): string {
  const tree = getBattleshipsErgoTree();
  return ErgoAddress.fromErgoTree(tree.toHex()).encode();
}

export function normalizeInputBox(box: Box<Amount>): Box<Amount> {
  const valStr = typeof box.value === 'bigint' ? box.value.toString() : String(box.value);

  const normalizedRegisters: Record<string, string> = {};
  if (box.additionalRegisters && typeof box.additionalRegisters === 'object') {
    for (const [key, val] of Object.entries(box.additionalRegisters)) {
      if (typeof val === 'string') {
        normalizedRegisters[key] = val.startsWith('0x') ? val.slice(2) : val;
      } else if (val && typeof val === 'object') {
        const hex = (val as any).serializedValue || (val as any).hex;
        if (typeof hex === 'string') {
          normalizedRegisters[key] = hex.startsWith('0x') ? hex.slice(2) : hex;
        }
      }
    }
  }

  return {
    ...box,
    value: valStr as any,
    assets: (box.assets || []).map((a: any) => ({
      tokenId: a.tokenId || a.id,
      amount: typeof a.amount === 'bigint' ? a.amount.toString() : String(a.amount || 0),
    })),
    additionalRegisters: normalizedRegisters as any,
  };
}

export function extractRegisterHex(reg: any): string | null {
  if (!reg) return null;
  if (typeof reg === 'string') return reg.startsWith('0x') ? reg.slice(2) : reg;
  if (typeof reg === 'object') {
    const s = (reg as any).serializedValue || (reg as any).hex;
    if (typeof s === 'string') return s.startsWith('0x') ? s.slice(2) : s;
  }
  return null;
}

export function extractGroupElements(reg: any): [string, string] {
  if (!reg) return [DEFAULT_DEV_PK, DEFAULT_DEV_PK];

  if (typeof reg === 'object' && Array.isArray(reg.renderedValue) && reg.renderedValue.length >= 2) {
    return [
      String(reg.renderedValue[0] || DEFAULT_DEV_PK),
      String(reg.renderedValue[1] || DEFAULT_DEV_PK),
    ];
  }

  if (typeof reg === 'object' && typeof reg.renderedValue === 'string') {
    const clean = reg.renderedValue.replace(/[\[\]\s]/g, '');
    const parts = clean.split(',');
    if (parts[0] && parts[1] && parts[0].length === 66 && parts[1].length === 66) {
      return [parts[0], parts[1]];
    }
  }

  const hex = extractRegisterHex(reg);
  if (hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    try {
      const parsed = parse<Uint8Array[]>(clean);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return [bytesToHex(parsed[0]), bytesToHex(parsed[1])];
      }
    } catch {}

    if ((clean.startsWith('1303') || clean.startsWith('1103') || clean.startsWith('1a03') ||
         clean.startsWith('1302') || clean.startsWith('1102') || clean.startsWith('1a02')) && clean.length >= 136) {
      return [clean.slice(4, 70), clean.slice(70, 136)];
    }
    if (clean.length >= 132) {
      return [clean.slice(0, 66), clean.slice(66, 132)];
    }
  }

  return [DEFAULT_DEV_PK, DEFAULT_DEV_PK];
}

export function extractThreeGroupElements(reg: any): [string, string, string] {
  if (!reg) return [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK];

  if (typeof reg === 'object' && Array.isArray(reg.renderedValue) && reg.renderedValue.length >= 3) {
    return [
      String(reg.renderedValue[0] || DEFAULT_DEV_PK),
      String(reg.renderedValue[1] || DEFAULT_DEV_PK),
      String(reg.renderedValue[2] || DEFAULT_DEV_PK),
    ];
  }

  if (typeof reg === 'object' && typeof reg.renderedValue === 'string') {
    const clean = reg.renderedValue.replace(/[\[\]\s]/g, '');
    const parts = clean.split(',');
    if (parts[0] && parts[1] && parts[2] && parts[0].length === 66 && parts[1].length === 66 && parts[2].length === 66) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  const hex = extractRegisterHex(reg);
  if (hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if ((clean.startsWith('1303') || clean.startsWith('1103') || clean.startsWith('1a03')) && clean.length >= 202) {
      return [clean.slice(4, 70), clean.slice(70, 136), clean.slice(136, 202)];
    }
    if (clean.length >= 198) {
      return [clean.slice(0, 66), clean.slice(66, 132), clean.slice(132, 198)];
    }
  }

  return [DEFAULT_DEV_PK, DEFAULT_DEV_PK, DEFAULT_DEV_PK];
}

export function cleanHex32(val: any): string {
  if (!val) return '00'.repeat(32);
  let str = '';
  if (typeof val === 'string') {
    str = val;
  } else if (typeof val === 'object') {
    str = (val as any).serializedValue || (val as any).renderedValue || (val as any).hex || '';
  }
  str = String(str).replace(/[\[\]\s]/g, '');
  if (str.startsWith('0x')) str = str.slice(2);
  if (str.startsWith('0e20')) str = str.slice(4);
  if (str.startsWith('1a0220')) str = str.slice(6);
  if (str.startsWith('1a02')) str = str.slice(4);
  if (str.length === 64) return str;
  if (str.length > 64) return str.slice(str.length - 64);
  return str.padStart(64, '0');
}

// ============================================================================
// CONTEXT EXTENSION ORDERING (Ergo node interop)
// ============================================================================

/**
 * Scala's `collection.immutable.Hashing.improve`, the hash scrambler behind the
 * CHAMP HashMap the Ergo node stores a ContextExtension in.
 */
function scalaHashImprove(hash: number): number {
  let h = (hash + ~(hash << 9)) | 0;
  h = (h ^ (h >>> 14)) | 0;
  h = (h + (h << 4)) | 0;
  return (h ^ (h >>> 10)) | 0;
}

// Scala's immutable Map keeps insertion order in its Map1..Map4 specialisations
// and switches to a CHAMP HashMap from the fifth entry onwards.
const SCALA_MAP_HASH_THRESHOLD = 5;

/**
 * Orders context-extension entries the way the Ergo node's own Map iterates them.
 *
 * The node parses the extension into a Scala immutable Map and re-serializes it
 * in that map's iteration order when it computes the transaction id and the
 * message every input signature is verified against. Up to four entries the map
 * is insertion-ordered, so plain ascending keys agree; from five entries it is a
 * CHAMP HashMap ordered by `improve(hash) & 31`, which for keys 0..5 comes out as
 * [0, 5, 1, 2, 3, 4]. Fleet (and sigma-rust) always write ascending, so any
 * transaction carrying six or more context variables is signed over different
 * bytes than the node verifies, and every input fails with
 * `Success((false, <cost>))` even though the script itself is satisfied. A
 * five-shot salvo needs exactly six (action + five Merkle proofs), which is why
 * only the very first turn of a match -- the one with no incoming salvo to prove
 * -- could ever be broadcast.
 *
 * Keys come back zero-padded so JavaScript does not re-sort them as array
 * indices; consumers read them with Number(), and `toBroadcastTx` normalises them
 * to plain decimals before the transaction leaves the process.
 */
export function orderContextExtension(
  extension: Record<string | number, string>
): Record<string, string> {
  const keys = Object.keys(extension || {});
  if (keys.length < SCALA_MAP_HASH_THRESHOLD) {
    return { ...(extension as Record<string, string>) };
  }

  const ordered = keys
    .map(Number)
    .sort((a, b) => (scalaHashImprove(a) & 31) - (scalaHashImprove(b) & 31));

  const out: Record<string, string> = {};
  for (const key of ordered) {
    out[String(key).padStart(3, '0')] = extension[key];
  }
  return out;
}

/**
 * Restores plain decimal extension keys and the flat spending-proof shape the
 * node's REST API expects.
 */
export function toBroadcastTx(signedTx: any): any {
  return {
    ...signedTx,
    inputs: signedTx.inputs.map((input: any) => {
      const extension = input.spendingProof?.extension || input.extension || {};
      const normalized: Record<string, string> = {};
      for (const key of Object.keys(extension)) {
        normalized[String(Number(key))] = extension[key];
      }
      return {
        ...input,
        spendingProof: {
          proofBytes: input.spendingProof?.proofBytes || '',
          extension: normalized,
        },
      };
    }),
  };
}

export function buildCreateLobbyTx(params: {
  p1Address: string;
  p1PublicKey: string; // 33-byte compressed hex
  p1BoardRoot: string; // 32-byte hex
  p1BoardHash: string; // 32-byte hex
  firstSalvo?: number[]; // optional/legacy
  wagerNanoErg: bigint;
  currentHeight: number;
  userUtxos: Box<Amount>[];
  devPublicKey?: string;
  timeoutDuration?: number; // Configurable timeout duration
}) {
  const devPk = params.devPublicKey || DEFAULT_DEV_PK;
  const lobbyAddress = getLobbyAddress();
  const timeoutDuration = params.timeoutDuration && params.timeoutDuration >= 30 ? params.timeoutDuration : 30;

  const battleshipsTreeHex = compile(BATTLESHIPS_SCRIPT, { version: 1 }).toHex();
  const expectedHash = blake2b256(hexToBytes(battleshipsTreeHex));

  const lobbyOutput = new OutputBuilder(params.wagerNanoErg, lobbyAddress)
    .setAdditionalRegisters({
      R4: SColl(SGroupElement, [hexToBytes(params.p1PublicKey), hexToBytes(devPk)]).toHex(),
      R5: SColl(SColl(SByte), [
        Array.from(hexToBytes(cleanHex32(params.p1BoardRoot))),
        Array.from(hexToBytes(cleanHex32(params.p1BoardHash))),
      ]).toHex(),
      R6: SColl(SInt, []).toHex(), // Pure blind: no shots in lobby box
      R7: SColl(SByte, []).toHex(),
      R8: SColl(SByte, Array.from(expectedHash)).toHex(),
      R9: SInt(timeoutDuration).toHex(),
    });

  const normalizedUserUtxos = params.userUtxos.map(normalizeInputBox);

  const tx = new TransactionBuilder(params.currentHeight + 1)
    .from(normalizedUserUtxos)
    .to(lobbyOutput)
    .sendChangeTo(params.p1Address)
    .payFee(MINER_FEE_NANO_ERG)
    .build();

  return tx;
}

export function buildAcceptLobbyTx(params: {
  p2Address: string;
  p2PublicKey: string; // 33-byte compressed hex
  p2BoardRoot: string; // 32-byte hex
  p2BoardHash: string; // 32-byte hex
  initialSalvo?: number[]; // optional/legacy
  lobbyBox: Box<Amount>;
  currentHeight: number;
  userUtxos: Box<Amount>[];
}) {
  const battleshipsAddress = getBattleshipsAddress();

  // Action = 1 (Accept Lobby / Start Match)
  const contextVars = { 0: SByte(1).toHex() };
  const normalizedLobbyBox = {
    ...normalizeInputBox(params.lobbyBox),
    extension: contextVars,
  };
  const normalizedUserUtxos = params.userUtxos.map(normalizeInputBox);

  const [p1Pk, devPk] = extractGroupElements(params.lobbyBox.additionalRegisters?.R4);

  // Extract p1BoardRoot and p1BoardHash from Lobby R5
  let p1BoardRoot = '00'.repeat(32);
  let p1BoardHash = '00'.repeat(32);
  try {
    const r5Hex = extractRegisterHex(params.lobbyBox.additionalRegisters?.R5);
    if (r5Hex) {
      const parsedR5 = parse<Uint8Array[]>(r5Hex);
      if (Array.isArray(parsedR5)) {
        if (parsedR5[0]) p1BoardRoot = bytesToHex(parsedR5[0]);
        if (parsedR5[1]) p1BoardHash = bytesToHex(parsedR5[1]);
      }
    }
  } catch (e) {}

  const p2BoardHash = cleanHex32(params.p2BoardHash);

  let timeoutDuration = TIMEOUT_BLOCK_DELTA;
  try {
    const r9Hex = extractRegisterHex(params.lobbyBox.additionalRegisters?.R9);
    if (r9Hex) {
      const parsed = parse<number>(r9Hex);
      if (typeof parsed === 'number' && parsed >= 30 && parsed <= 720) {
        timeoutDuration = parsed;
      }
    }
  } catch (e) {}

  const lobbyValue = BigInt(params.lobbyBox.value);
  const totalPot = lobbyValue * 2n;

  // History initialized strictly to 64 zero bytes for both players
  const initialP1History = Array(64).fill(0);
  const initialP2History = Array(64).fill(0);

  const gameOutput = new OutputBuilder(totalPot, battleshipsAddress)
    .setAdditionalRegisters({
      R4: SColl(SGroupElement, [hexToBytes(p1Pk), hexToBytes(params.p2PublicKey), hexToBytes(devPk)]).toHex(),
      R5: SColl(SColl(SByte), [
        Array.from(hexToBytes(cleanHex32(p1BoardRoot))),
        Array.from(hexToBytes(cleanHex32(params.p2BoardRoot))),
        Array.from(hexToBytes(cleanHex32(p1BoardHash))),
        Array.from(hexToBytes(cleanHex32(params.p2BoardHash))),
      ]).toHex(),
      R6: SColl(SInt, [0, 0, 0]).toHex(),
      R7: SColl(SInt, []).toHex(), // Pure blind: opening salvo will be fired by Host on Turn 1
      R8: SColl(SColl(SByte), [initialP1History, initialP2History]).toHex(),
      R9: SColl(SInt, [params.currentHeight + 1 + timeoutDuration, timeoutDuration]).toHex(),
    });

  const tx = new TransactionBuilder(params.currentHeight + 1)
    .from([normalizedLobbyBox as any, ...normalizedUserUtxos])
    .to(gameOutput)
    .sendChangeTo(params.p2Address)
    .payFee(MINER_FEE_NANO_ERG)
    .build();

  return tx;
}

export function buildCancelLobbyTx(params: {
  p1Address: string;
  lobbyBox: Box<Amount>;
  currentHeight: number;
  userUtxos?: Box<Amount>[];
}) {
  // Action = 0 (Cancel / 100% Refund)
  const contextVars = { 0: SByte(0).toHex() };
  const normalizedLobbyBox = {
    ...normalizeInputBox(params.lobbyBox),
    extension: contextVars,
  };
  const normalizedUserUtxos = (params.userUtxos || []).map(normalizeInputBox);
  const lobbyValue = BigInt(params.lobbyBox.value);

  let totalInputVal = lobbyValue;
  for (const u of normalizedUserUtxos) {
    totalInputVal += BigInt(u.value);
  }

  const refundAmount =
    totalInputVal > lobbyValue
      ? lobbyValue
      : lobbyValue > MINER_FEE_NANO_ERG
      ? lobbyValue - MINER_FEE_NANO_ERG
      : lobbyValue;

  const refundOutput = new OutputBuilder(refundAmount, params.p1Address);
  
  // SECURE REFUND FIX: Ensure any tokens locked in the lobby are refunded to the host
  if (params.lobbyBox.assets && params.lobbyBox.assets.length > 0) {
    refundOutput.addTokens(params.lobbyBox.assets);
  }

  // Pre-populate registers on refundOutput so legacy contracts with top-level register evaluation pass cleanly
  try {
    refundOutput.setAdditionalRegisters({
      R4: normalizedLobbyBox.additionalRegisters?.R4 || '1302' + '02'.repeat(33) + '02'.repeat(33),
      R5: normalizedLobbyBox.additionalRegisters?.R5 || '1a0120' + '00'.repeat(32),
      R6: SColl(SInt, [0, 0, 0]).toHex(),
      R7: SColl(SInt, []).toHex(),
      R8: SColl(SColl(SByte), [Array(64).fill(0), Array(64).fill(0)]).toHex(),
      R9: SColl(SInt, [params.currentHeight + 100, 30]).toHex(),
    });
  } catch (e) {}

  const tx = new TransactionBuilder(params.currentHeight + 1)
    .from([normalizedLobbyBox as any, ...normalizedUserUtxos])
    .to(refundOutput)
    .sendChangeTo(params.p1Address)
    .payFee(MINER_FEE_NANO_ERG)
    .build();

  return tx;
}

export function buildPlayTurnTx(params: {
  activePlayerAddress: string;
  activePlayerPublicKey?: string;
  gameBox: Box<Amount>;
  currentPhase: number;
  currentP1Hits: number;
  currentP2Hits: number;
  newHitsByPreviousPlayer: number;
  nextSalvo: number[]; 
  proofs?: any[];
  currentHeight: number;
  userUtxos: Box<Amount>[];
  p1History?: number[]; // the 64-byte array from R8(0)
  p2History?: number[]; // the 64-byte array from R8(1)
  sunkShipCode?: number; // 0=None, 1=Patrol, 2=Cruiser, 3=Carrier
}) {
  const battleshipsAddress = params.gameBox.ergoTree
    ? ErgoAddress.fromErgoTree(params.gameBox.ergoTree).encode()
    : getBattleshipsAddress();

  // Read current on-chain phase and hits directly from gameBox R6
  let activePhase = params.currentPhase;
  let activeP1Hits = params.currentP1Hits;
  let activeP2Hits = params.currentP2Hits;
  try {
    const r6Hex = extractRegisterHex(params.gameBox.additionalRegisters?.R6);
    if (r6Hex) {
      const parsedR6 = parse<number[]>(r6Hex);
      if (Array.isArray(parsedR6) && parsedR6.length >= 3) {
        activePhase = Number(parsedR6[0]);
        activeP1Hits = Number(parsedR6[1]);
        activeP2Hits = Number(parsedR6[2]);
      }
    }
  } catch (e) {}

  const nextPhase = activePhase === 0 ? 1 : 0;

  let incomingCount = 0;
  try {
    const r7Hex = extractRegisterHex(params.gameBox.additionalRegisters?.R7);
    if (r7Hex) {
      const parsed = parse<number[]>(r7Hex);
      if (Array.isArray(parsed)) incomingCount = parsed.length;
    }
  } catch (e) {}

  const actualNewHits = incomingCount > 0 ? params.newHitsByPreviousPlayer : 0;

  // SECURE SCORE FIX: P1 (Phase 0) evaluates P2's previous shot and increments P2's hits. 
  // P2 (Phase 1) evaluates P1's previous shot and increments P1's hits.
  const newP1Hits = activePhase === 1 ? activeP1Hits + actualNewHits : activeP1Hits;
  const newP2Hits = activePhase === 0 ? activeP2Hits + actualNewHits : activeP2Hits;

  // Action = 0 (Play Turn)
  const contextVars: Record<number, string> = { 0: SByte(0).toHex() };
  if (params.proofs && params.proofs.length > 0) {
    for (let i = 0; i < params.proofs.length; i++) {
      const p = params.proofs[i];
      let bytes: Uint8Array;
      if (typeof p === 'string') {
        bytes = hexToBytes(p);
      } else if (p instanceof Uint8Array) {
        bytes = p;
      } else if (Array.isArray(p)) {
        bytes = new Uint8Array(p);
      } else if ((p as any).proof_hex || (p as any).proofHex) {
        bytes = hexToBytes((p as any).proof_hex || (p as any).proofHex);
      } else if ((p as any).proof_bytes || (p as any).proofBytes) {
        const raw = (p as any).proof_bytes || (p as any).proofBytes;
        if (typeof raw === 'string') {
          bytes = hexToBytes(raw);
        } else {
          bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        }
      } else {
        bytes = new Uint8Array(224);
      }
      contextVars[i + 1] = SColl(SByte, Array.from(bytes)).toHex();
    }
  }

  const normalizedGameBox = {
    ...normalizeInputBox(params.gameBox),
    extension: contextVars,
  };
  const normalizedUserUtxos = params.userUtxos.map(normalizeInputBox);

  // SECURE SALVO FIX: Sort the salvo to pass strict anti-duplicate contract checks
  const sortedSalvo = [...params.nextSalvo].sort((a, b) => a - b);

  // Guarantee valid 64-element history arrays
  let p1Hist = Array(64).fill(0);
  let p2Hist = Array(64).fill(0);

  if (params.p1History && params.p1History.length === 64) {
    p1Hist = [...params.p1History];
  } else {
    try {
      const r8Hex = extractRegisterHex(normalizedGameBox.additionalRegisters?.R8 || params.gameBox.additionalRegisters?.R8);
      if (r8Hex) {
        const parsed = parse<any>(r8Hex);
        if (Array.isArray(parsed) && parsed[0] && parsed[0].length === 64) {
          p1Hist = Array.from(parsed[0]).map(Number);
        }
      }
    } catch (e) {}
  }

  if (params.p2History && params.p2History.length === 64) {
    p2Hist = [...params.p2History];
  } else {
    try {
      const r8Hex = extractRegisterHex(normalizedGameBox.additionalRegisters?.R8 || params.gameBox.additionalRegisters?.R8);
      if (r8Hex) {
        const parsed = parse<any>(r8Hex);
        if (Array.isArray(parsed) && parsed[1] && parsed[1].length === 64) {
          p2Hist = Array.from(parsed[1]).map(Number);
        }
      }
    } catch (e) {}
  }

  const nextP1History = [...p1Hist];
  const nextP2History = [...p2Hist];
  
  // Follow activePhase (re-read from R6), not the caller's snapshot: a stale
  // params.currentPhase would append the salvo to the wrong player's history and
  // fail the contract's append-only history rule.
  if (activePhase === 0) {
    sortedSalvo.forEach(cell => { nextP1History[cell] = 1; });
  } else {
    sortedSalvo.forEach(cell => { nextP2History[cell] = 1; });
  }

  // SECURE STATE PRESERVATION FIX: Properly deserialize the R9 array
  let timeoutBlocks = 30;
  try {
    const r9Hex = extractRegisterHex(normalizedGameBox.additionalRegisters?.R9 || params.gameBox.additionalRegisters?.R9);
    if (r9Hex) {
      const parsedR9 = parse<number[]>(r9Hex);
      if (Array.isArray(parsedR9) && parsedR9.length === 2) {
        timeoutBlocks = Number(parsedR9[1]);
      }
    }
  } catch (e) {}

  const r4Hex = normalizedGameBox.additionalRegisters?.R4 || extractRegisterHex(params.gameBox.additionalRegisters?.R4);
  const r5Hex = normalizedGameBox.additionalRegisters?.R5 || extractRegisterHex(params.gameBox.additionalRegisters?.R5);

  const gameOutput = new OutputBuilder(params.gameBox.value, battleshipsAddress)
    .addTokens(params.gameBox.assets)
    .setAdditionalRegisters({
      R4: r4Hex!,
      R5: r5Hex!,
      R6: SColl(SInt, [nextPhase, newP1Hits, newP2Hits, params.sunkShipCode || 0]).toHex(),
      R7: SColl(SInt, sortedSalvo).toHex(),
      R8: SColl(SColl(SByte), [nextP1History, nextP2History]).toHex(),
      // The contract accepts nextTimeoutHeight in [HEIGHT + tb - 10, HEIGHT + tb + 4].
      // currentHeight + tb + 4 is the choice that stays valid for the widest range
      // of inclusion heights (currentHeight .. currentHeight + 14), which buys the
      // most mempool delay before the turn has to be rebuilt.
      R9: SColl(SInt, [params.currentHeight + timeoutBlocks + 4, timeoutBlocks]).toHex(),
    });

  return new TransactionBuilder(params.currentHeight + 1)
    .from([normalizedGameBox as any, ...normalizedUserUtxos])
    .to(gameOutput)
    .sendChangeTo(params.activePlayerAddress)
    .payFee(MINER_FEE_NANO_ERG)
    .build();
}

/**
 * Assembles the 102-byte board audit payload read from context variable 99 by
 * Actions 1 and 2: 64-byte grid mask + 6-byte ship geometry + 32-byte master salt.
 *
 * The contract hashes these exact 102 bytes and compares the digest against the
 * board hash committed in R5, and separately walks bytes 64..69 to prove the
 * three ships fit the grid without overlapping. A bare 64-byte grid therefore can
 * never validate: it leaves every ship starting on cell 0, which both overlaps
 * and hashes to the wrong digest. Prefer passing the committed
 * `BoardCommitment.saltedBoardPayload` straight through.
 */
export function buildBoardAuditPayload(params: {
  rawBoard?: Uint8Array | number[];
  rawBoardBytes?: Uint8Array | number[];
  carrierCoord?: [number, number];
  carrierDir?: number;
  cruiserCoord?: [number, number];
  cruiserDir?: number;
  patrolCoord?: [number, number];
  patrolDir?: number;
  saltBytes?: number[] | Uint8Array;
}): Uint8Array {
  const board = params.rawBoard || params.rawBoardBytes || [];
  const payload = new Uint8Array(102);

  for (let i = 0; i < 64; i++) {
    payload[i] = (board[i] || 0) > 0 ? 1 : 0;
  }

  // Full committed payload supplied: preserve geometry and salt bytes verbatim,
  // otherwise the digest would not match the on-chain commitment.
  if (board.length >= 102) {
    for (let i = 64; i < 102; i++) {
      payload[i] = board[i] || 0;
    }
    return payload;
  }

  // Only a grid was supplied: recover the geometry descriptors from it so the
  // non-overlap audit has real ship positions to walk.
  payload.set(extractShipGeometry(payload.subarray(0, 64)), 64);

  if (params.carrierCoord) {
    payload[64] = params.carrierCoord[0] * 8 + params.carrierCoord[1];
    payload[65] = params.carrierDir || 0;
  }
  if (params.cruiserCoord) {
    payload[66] = params.cruiserCoord[0] * 8 + params.cruiserCoord[1];
    payload[67] = params.cruiserDir || 0;
  }
  if (params.patrolCoord) {
    payload[68] = params.patrolCoord[0] * 8 + params.patrolCoord[1];
    payload[69] = params.patrolDir || 0;
  }
  if (params.saltBytes && params.saltBytes.length >= 32) {
    for (let i = 0; i < 32; i++) {
      payload[70 + i] = params.saltBytes[i] || 0;
    }
  }

  return payload;
}

export function buildClaimWinTx(params: {
  winnerAddress?: string;
  activePlayerAddress?: string;
  opponentAddress?: string;
  isTie?: boolean;
  devAddress?: string;
  gameBox: Box<Amount>;
  rawBoard?: Uint8Array | number[];
  rawBoardBytes?: Uint8Array | number[];
  carrierCoord?: [number, number];
  carrierDir?: number;
  cruiserCoord?: [number, number];
  cruiserDir?: number;
  patrolCoord?: [number, number];
  patrolDir?: number;
  saltBytes?: number[] | Uint8Array;
  currentHeight: number;
  userUtxos: Box<Amount>[];
  isP1Claiming?: boolean;
  p1History?: number[];
  p2History?: number[];
  p1Hits?: number;
  p2Hits?: number;
}) {
  const totalPot = BigInt(params.gameBox.value);
  const contractDevFee = totalPot / 100n;
  const winPayout = totalPot - contractDevFee;
  const minUtxoFee = 1000000n;
  const devFee = contractDevFee < minUtxoFee ? minUtxoFee : contractDevFee;

  const claimerAddr = params.winnerAddress || params.activePlayerAddress || '';
  let p1Addr = claimerAddr;
  let p2Addr = params.opponentAddress || claimerAddr;
  let devAddr = params.devAddress || DEFAULT_DEV_ADDRESS;
  try {
    const r4 = params.gameBox.additionalRegisters?.R4;
    const [p1Pk, p2Pk, devPk] = extractThreeGroupElements(r4);
    if (p1Pk) p1Addr = ErgoAddress.fromPublicKey(p1Pk).encode();
    if (p2Pk) p2Addr = ErgoAddress.fromPublicKey(p2Pk).encode();
    if (devPk) devAddr = ErgoAddress.fromPublicKey(devPk).encode();
  } catch (e) {}

  const isClaimingP1 = params.isP1Claiming ?? (claimerAddr === p1Addr);
  const winnerAddr = isClaimingP1 ? p1Addr : p2Addr;

  const sanitizedPayload = buildBoardAuditPayload(params);

  // Action = 1 (Claim Win / Settlement), 99 = sanitized 102-byte salted board
  const contextVars = { 
    0: SByte(1).toHex(),
    99: SColl(SByte, Array.from(sanitizedPayload)).toHex()
  };

  const normalizedGameBox = {
    ...normalizeInputBox(params.gameBox),
    extension: contextVars,
  };
  const normalizedUserUtxos = params.userUtxos.map(normalizeInputBox);

  const outputs: OutputBuilder[] = [];

  if (params.isTie) {
    const tiePayout = winPayout / 2n;
    const p1Output = new OutputBuilder(tiePayout, p1Addr);
    if (params.gameBox.assets && params.gameBox.assets.length > 0) {
      p1Output.addTokens(params.gameBox.assets);
    }
    const p2Output = new OutputBuilder(tiePayout, p2Addr);
    const devOutput = new OutputBuilder(devFee, devAddr);
    outputs.push(p1Output, p2Output, devOutput);
  } else {
    const winnerOutput = new OutputBuilder(winPayout, winnerAddr);
    if (params.gameBox.assets && params.gameBox.assets.length > 0) {
      winnerOutput.addTokens(params.gameBox.assets);
    }
    const devOutput = new OutputBuilder(devFee, devAddr);
    outputs.push(winnerOutput, devOutput);
  }

  return new TransactionBuilder(params.currentHeight + 1)
    .from([normalizedGameBox as any, ...normalizedUserUtxos])
    .to(outputs)
    .sendChangeTo(claimerAddr)
    .payFee(MINER_FEE_NANO_ERG)
    .build();
}

export function buildClaimTimeoutTx(params: {
  claimerAddress?: string;
  activePlayerAddress?: string;
  devAddress?: string;
  gameBox: Box<Amount>;
  rawBoard?: Uint8Array | number[];
  rawBoardBytes?: Uint8Array | number[];
  carrierCoord?: [number, number];
  carrierDir?: number;
  cruiserCoord?: [number, number];
  cruiserDir?: number;
  patrolCoord?: [number, number];
  patrolDir?: number;
  saltBytes?: number[] | Uint8Array;
  currentHeight: number;
  userUtxos: Box<Amount>[];
  isP1Claiming?: boolean;
  p1History?: number[];
  p2History?: number[];
  p1Hits?: number;
  p2Hits?: number;
}) {
  const totalPot = BigInt(params.gameBox.value);
  const contractDevFee = totalPot / 100n;
  const winPayout = totalPot - contractDevFee;
  const minUtxoFee = 1000000n;
  const devFee = contractDevFee < minUtxoFee ? minUtxoFee : contractDevFee;

  const claimerAddr = params.claimerAddress || params.activePlayerAddress || '';
  let p1Addr = claimerAddr;
  let p2Addr = claimerAddr;
  let devAddr = params.devAddress || DEFAULT_DEV_ADDRESS;
  try {
    const r4 = params.gameBox.additionalRegisters?.R4;
    const [p1Pk, p2Pk, devPk] = extractThreeGroupElements(r4);
    if (p1Pk) p1Addr = ErgoAddress.fromPublicKey(p1Pk).encode();
    if (p2Pk) p2Addr = ErgoAddress.fromPublicKey(p2Pk).encode();
    if (devPk) devAddr = ErgoAddress.fromPublicKey(devPk).encode();
  } catch (e) {}

  let r6Phase = 0;
  try {
    const r6Hex = extractRegisterHex(params.gameBox.additionalRegisters?.R6);
    if (r6Hex) {
      const parsedR6 = parse<number[]>(r6Hex);
      if (Array.isArray(parsedR6) && parsedR6.length >= 1) {
        r6Phase = Number(parsedR6[0]);
      }
    }
  } catch (e) {}

  // In Action 2: if phase == 0, winner is P2; if phase == 1, winner is P1
  const winnerPropAddr = r6Phase === 0 ? p2Addr : p1Addr;

  const sanitizedPayload = buildBoardAuditPayload(params);

  // Action = 2 (Claim Timeout), 99 = claimant's 102-byte salted board payload
  const contextVars = { 
    0: SByte(2).toHex(),
    99: SColl(SByte, Array.from(sanitizedPayload)).toHex()
  };

  const normalizedGameBox = {
    ...normalizeInputBox(params.gameBox),
    extension: contextVars,
  };
  const normalizedUserUtxos = params.userUtxos.map(normalizeInputBox);

  const winnerOutput = new OutputBuilder(winPayout, winnerPropAddr);
  if (params.gameBox.assets && params.gameBox.assets.length > 0) {
    winnerOutput.addTokens(params.gameBox.assets);
  }
  const devOutput = new OutputBuilder(devFee, devAddr);

  return new TransactionBuilder(params.currentHeight + 1)
    .from([normalizedGameBox as any, ...normalizedUserUtxos])
    .to([winnerOutput, devOutput])
    .sendChangeTo(claimerAddr)
    .payFee(MINER_FEE_NANO_ERG)
    .build();
}
