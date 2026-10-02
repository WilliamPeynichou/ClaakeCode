import type { E2EConfig } from 'e2e';
import { engine } from './tests/e2e/engine';

// Deterministic browser tests of the frontend against an in-page Tauri mock (tests/e2e/tauriMock.ts).
// No agent steps, so no model provider is configured.
export default {
  targets: [{
    engine,
    app: {
      url: process.env.APP_URL ?? 'http://localhost:1420',
      command: { executable: 'npm', args: ['run', 'dev'], reuseExisting: true, log: '.e2e/logs/app.log' },
    },
  }],
} satisfies E2EConfig;
