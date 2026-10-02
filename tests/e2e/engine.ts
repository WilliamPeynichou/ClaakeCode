import { web } from '@e2e-dev/web';

/** Shared so tests can reach the Playwright context (init scripts) through `surfaceOf`. */
export const engine = web();
