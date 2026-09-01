export const BATTLESHIPS_SCRIPT_REFERENCE = `
/**
 * ============================================================================
 *                    SIGMA FLEET - BATTLESHIPS SMART CONTRACT
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
