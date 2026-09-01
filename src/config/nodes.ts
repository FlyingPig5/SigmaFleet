/**
 * Ergo nodes the app talks to, and the order it tries them in.
 *
 * Kept separate from the indexer so that anything needing only a node URL — the transaction
 * reducer, tests, tooling — does not have to pull in the whole chain-indexing layer.
 *
 * 213.239.193.208 is deliberately last: it is the least reliable of the three, and being
 * plain HTTP it is blocked as mixed content on an HTTPS page. The two ahead of it are HTTPS,
 * respond faster, and both serve the `/blockchain/*` indexer routes.
 */
export const DEFAULT_NODE_URL = 'https://node.sigmaspace.io';

export const FALLBACK_NODE_URLS = [
  'https://node.sigmaspace.io',
  'https://ergo-node-1.eutxo.de',
  'http://213.239.193.208:9053',
];
