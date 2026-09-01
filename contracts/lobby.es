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
