/**
 * Bounds how long a promise is waited on without cancelling the underlying
 * work — on timeout, the original promise's eventual resolution/rejection is
 * simply ignored by the caller. Used wherever a dependency we don't control
 * (Redis, an ONVIF device over the network) could legitimately hang longer
 * than a caller should ever wait.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
