import { test, surfaceOf } from '@e2e-dev/web';
import { expect } from 'e2e';
import { engine } from './engine';
import { installTauriMock, type MockOptions } from './tauriMock';

async function openApp(app: { open: (path: string) => Promise<unknown> }, options: MockOptions = {}) {
  // The page exists only after app.open, so: open, register the mock, reload. The mock must
  // run before any app script. The test transpiler injects `__name(...)` helpers into function
  // bodies; define it so the serialized function runs in the page.
  await app.open('/');
  const page = surfaceOf(engine)!.page();
  await page.addInitScript({
    content: `var __name = (f) => f; (${installTauriMock.toString()})(${JSON.stringify(options)});`,
  });
  if (process.env.E2E_DEBUG) {
    page.on('pageerror', (err: Error) => console.log('[pageerror]', err.message));
    page.on('console', (msg: any) => msg.type() === 'error' && console.log('[console]', msg.text()));
  }
  await page.reload();
}

const calls = (browser: any, cmd: string) =>
  browser.evaluate(
    (name: string) => (window as any).__mock.calls.filter((c: any) => c.cmd === name).map((c: any) => c.args),
    cmd,
  );

test('RLM chat: create, isolation banner, streamed reply, same model as classic chat', async ({ app, browser, screen }) => {
  await openApp(app);
  await expect(screen.getByText('Classic chat')).toBeVisible();

  await screen.getByRole('button', 'New RLM chat (experimental)').tap();

  // The new conversation is listed with its RLM badge and the isolation banner is shown.
  await expect(screen.getByText('RLM · confiance locale')).toBeVisible();
  await expect(screen.getByText('/tmp/e2e-workspace-claakecode-rlm-c-rlm-1')).toBeVisible();

  const composer = browser.locator('textarea').first();
  await composer.fill('bonjour prime');
  await composer.press('Enter');

  await expect(screen.getByText('RLM reply to: bonjour prime', { exact: false })).toBeVisible();

  // The turn went to the RLM command (never the classic one) with the chat's selected model.
  const rlmSends = await calls(browser, 'send_rlm_message');
  expect(rlmSends).toHaveLength(1);
  expect(rlmSends[0].input.text).toBe('bonjour prime');
  expect(rlmSends[0].input.model).toMatchObject({ provider: 'anthropic' });
  expect(await calls(browser, 'send_message')).toHaveLength(0);
});

test('RLM chat: creation failure is shown to the user', async ({ app, browser, screen }) => {
  await openApp(app, { rlmCreateFails: true });
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await browser.evaluate(() => {
    (window as any).__alerts = [];
    window.alert = (m?: any) => (window as any).__alerts.push(String(m));
  });
  await screen.getByRole('button', 'New RLM chat (experimental)').tap();
  await new Promise((r) => setTimeout(r, 500));
  const alerts: string[] = await browser.evaluate(() => (window as any).__alerts);
  expect(alerts.join()).toContain('needs a git repository');
});

test('Settings: persistent Python section shows the Prime environment', async ({ app, browser, screen }) => {
  await openApp(app);
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await browser.locator('[title="Settings"]').first().tap();
  await screen.getByRole('button', 'Python persistant', { exact: false }).tap();
  await expect(screen.getByRole('heading', 'Python persistant')).toBeVisible();
  await expect(screen.getByText('3.12.4')).toBeVisible();
  await expect(screen.getByText('En marche')).toBeVisible();
  await expect(screen.getByText('pandas')).toBeVisible();
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/python-settings.png' });

  await screen.getByRole('button', 'Redémarrer').tap();
  expect(await calls(browser, 'restart_python_runtime')).toHaveLength(1);
});

test('RLM chat screenshot', async ({ app, browser, screen }) => {
  await openApp(app);
  await screen.getByRole('button', 'New RLM chat (experimental)').tap();
  const composer = browser.locator('textarea').first();
  await composer.fill('bonjour prime');
  await composer.press('Enter');
  await expect(screen.getByText('RLM reply to: bonjour prime', { exact: false })).toBeVisible();
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/rlm-chat.png' });
});

test('RLM chat: Stop interrupts the turn through the RLM command', async ({ app, browser, screen }) => {
  await openApp(app);
  await screen.getByRole('button', 'New RLM chat (experimental)').tap();
  const composer = browser.locator('textarea').first();
  await composer.fill('slow answer please');
  await composer.press('Enter');
  await expect(screen.getByText('w5', { exact: false })).toBeVisible();
  await browser.locator('.composer__send-label', { hasText: 'Stop' }).first().tap();
  await expect(browser.locator('.composer__send-label', { hasText: 'Send' }).first()).toBeVisible();
  const stops = await calls(browser, 'stop_rlm_turn');
  expect(stops.length).toBeGreaterThanOrEqual(1);
  // The classic stop must never be used for an RLM conversation.
  expect(await calls(browser, 'stop_turn')).toHaveLength(0);
  // The stream really stopped: the last word never arrives.
  await new Promise((r) => setTimeout(r, 500));
  expect(await browser.locator('text=w399').count()).toBe(0);
});

test('RLM chat: reopening a saved conversation restores history and banner', async ({ app, browser, screen }) => {
  await openApp(app, { seedRlm: true });
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await screen.getByText('Old RLM chat').tap();
  await expect(screen.getByText("réponse persistée d'hier")).toBeVisible();
  await expect(screen.getByText('RLM · confiance locale')).toBeVisible();
  await expect(screen.getByText('/tmp/e2e-workspace-claakecode-rlm-old')).toBeVisible();
  // Switching back to the classic chat hides the RLM banner.
  await screen.getByText('Classic chat').tap();
  await expect(screen.getByText('RLM · confiance locale')).not.toBeVisible();
});
