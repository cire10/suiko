// @ts-check
// Process liveness probe used by file locks, waiter presence and temp-file recovery.

/**
 * True when a process with this pid exists on this host. `process.kill(pid, 0)` throws ESRCH for a missing
 * process and EPERM for an existing process owned by another user (which counts as alive).
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}
