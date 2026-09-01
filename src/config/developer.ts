/**
 * Developer and Protocol Escrow Configuration for Sigma Fleet
 */
export const DEV_CONFIG = {
  /**
   * Developer Fee Address (Receives protocol fees on every concluded match / timeout)
   */
  DEV_ADDRESS: '9fLYPigGHXkTyyQvU9zzoT3RTAXJ4dfHjbkg6ik2fHKKxjprSrh',

  /**
   * 33-byte compressed GroupElement public key for DEV_ADDRESS
   */
  DEV_PUBLIC_KEY: '026bcf848952cd3e2b1f6f53e06a31808b16c00bf98a46cb2e252170752bd83b1b',

  /**
   * Protocol Fee Percentage (1% of the total escrow pot)
   */
  DEV_FEE_PERCENT: 1n,

  /**
   * Minimum Fee Floor to satisfy Ergo UTXO minimum box value (0.001 ERG = 1,000,000 NanoERG)
   */
  MIN_DEV_FEE_NANO_ERG: 1000000n,

  /**
   * Helper to compute dynamic dev fee for any pot size
   */
  calculateDevFeeNano: (totalPotNano: bigint): bigint => {
    const raw = (totalPotNano * 1n) / 100n;
    return raw < 1000000n ? 1000000n : raw;
  },

  /**
   * Miner Transaction Fee (0.0011 ERG = 1,100,000 NanoERG)
   */
  MINER_FEE_NANO_ERG: 1100000n,

  /**
   * Turn Timeout in Blocks (30 blocks ≈ 60 minutes)
   */
  TIMEOUT_BLOCKS: 30,
};
