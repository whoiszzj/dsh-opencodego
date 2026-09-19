/**
 * Deprecated entry point.
 *
 * The acceptance run used to live here and drove the 0.8 key-rotation pool. The
 * 0.8.2 redesign removed that pool (one ACTIVE subscription pays, switching is
 * an operator act), and the run moved to `e2e-active-sub.mjs` with it.
 *
 * This file stays as a forwarder so the documented command keeps working:
 *
 *   npm run e2e:multi-sub      # -> node scripts/e2e-active-sub.mjs
 *
 * It can be deleted along with the `e2e:multi-sub` script in package.json once
 * nothing references the old name.
 *
 * @module scripts/e2e-multi-sub
 */

await import('./e2e-active-sub.mjs')
