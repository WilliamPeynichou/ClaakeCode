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

// The RLM chat opens from the "RLM" tab next to "Chat" in the chat header.
const openRlmTab = (browser: any) => browser.locator('.chat-surface-tab[data-surface="rlm"]').first().tap();
const openChatTab = (browser: any) => browser.locator('.chat-surface-tab[data-surface="chat"]').first().tap();

const calls = (browser: any, cmd: string) =>
  browser.evaluate(
    (name: string) => (window as any).__mock.calls.filter((c: any) => c.cmd === name).map((c: any) => c.args),
    cmd,
  );

test('RLM chat: create, isolation banner, streamed reply, same model as classic chat', async ({ app, browser, screen }) => {
  await openApp(app);
  await expect(screen.getByText('Classic chat')).toBeVisible();

  await openRlmTab(browser);
  await screen.getByRole('button', 'Nouveau chat RLM').tap();

  // The isolation banner is shown and the RLM history only lists RLM conversations.
  await expect(screen.getByText('RLM · confiance locale')).toBeVisible();
  await expect(screen.getByText('/tmp/e2e-workspace-claakecode-rlm-c-rlm-1')).toBeVisible();
  await expect(screen.getByText('Classic chat')).not.toBeVisible();

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
  await openRlmTab(browser);
  await screen.getByRole('button', 'Nouveau chat RLM').tap();
  await expect(screen.getByText('needs a git repository', { exact: false })).toBeVisible();
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
  await openRlmTab(browser);
  await screen.getByRole('button', 'Nouveau chat RLM').tap();
  const composer = browser.locator('textarea').first();
  await composer.fill('bonjour prime');
  await composer.press('Enter');
  await expect(screen.getByText('RLM reply to: bonjour prime', { exact: false })).toBeVisible();
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/rlm-chat.png' });
});

test('RLM chat: Stop interrupts the turn through the RLM command', async ({ app, browser, screen }) => {
  await openApp(app);
  await openRlmTab(browser);
  await screen.getByRole('button', 'Nouveau chat RLM').tap();
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
  // Separate histories: the RLM conversation lives under the RLM tab only.
  await expect(screen.getByText('Old RLM chat')).not.toBeVisible();
  await openRlmTab(browser);
  await screen.getByText('Old RLM chat').tap();
  await expect(screen.getByText("réponse persistée d'hier")).toBeVisible();
  await expect(screen.getByText('RLM · confiance locale')).toBeVisible();
  await expect(screen.getByText('/tmp/e2e-workspace-claakecode-rlm-old')).toBeVisible();
  // Switching back to the Chat tab restores the classic conversation, without the RLM banner.
  await openChatTab(browser);
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await expect(screen.getByText('RLM · confiance locale')).not.toBeVisible();
});

test('RLM tab: empty state, then back to the agent chat', async ({ app, browser, screen }) => {
  await openApp(app);
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await openRlmTab(browser);
  await expect(screen.getByText('Aucun chat RLM')).toBeVisible();
  await expect(screen.getByRole('button', 'Nouveau chat RLM')).toBeVisible();
  // Nothing is created just by opening the tab (a worktree is created only on demand).
  expect(await calls(browser, 'create_rlm_conversation')).toHaveLength(0);
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/rlm-empty.png' });
  await openChatTab(browser);
  await expect(screen.getByText('Classic chat')).toBeVisible();
});

test('Auto Compute: one click hands the agent chat to a new RLM chat', async ({ app, browser, screen }) => {
  await openApp(app, { seedClassic: true });
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await screen.getByRole('button', 'Auto Compute', { exact: false }).tap();

  // The RLM tab is now active on a new conversation titled after the source chat.
  await expect(screen.getByText('RLM · confiance locale')).toBeVisible();
  await expect(screen.getByText('Auto Compute · Classic chat')).toBeVisible();
  await expect(screen.getByText('Classic chat', { exact: true })).not.toBeVisible();
  await expect(screen.getByText('RLM reply to: Auto Compute', { exact: false })).toBeVisible();
  // The handed-over message itself is visible as the first user message.
  const firstUser = await browser.evaluate(() => (document.querySelector('.chat-body') as HTMLElement).innerText);
  expect(firstUser.startsWith('Auto Compute from the agent chat')).toBe(true);

  const sends = await calls(browser, 'send_rlm_message');
  expect(sends).toHaveLength(1);
  expect(sends[0].input.text).toContain('quelle est la latence médiane ?');
  expect(sends[0].input.text).toContain('Il faut charger runs.csv');
  expect(sends[0].input.model).toMatchObject({ provider: 'anthropic' });
  expect(await calls(browser, 'send_message')).toHaveLength(0);
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/auto-compute.png' });

  // The agent chat is untouched and still one click away.
  await openChatTab(browser);
  await expect(screen.getByText('Il faut charger runs.csv', { exact: false })).toBeVisible();
});

test('Settings: agent memory is listed, editable and deletable', async ({ app, browser, screen }) => {
  await openApp(app);
  await browser.locator('[title="Settings"]').first().tap();
  await screen.getByRole('button', 'Python persistant', { exact: false }).tap();
  await expect(screen.getByText('Median latency')).toBeVisible();
  await expect(screen.getByText('runs.csv encoding')).toBeVisible();
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/rlm-memory.png' });

  await screen.getByRole('button', 'Modifier').first().tap();
  await browser.locator('.rlm-memory__edit textarea').fill('Use p50, never the mean.');
  await screen.getByRole('button', 'Enregistrer').tap();
  await expect(screen.getByText('Use p50, never the mean.')).toBeVisible();
  expect(await calls(browser, 'edit_rlm_memory')).toHaveLength(1);

  await screen.getByRole('button', 'Supprimer').first().tap();
  await screen.getByRole('button', 'Confirmer la suppression').tap();
  expect(await calls(browser, 'delete_rlm_memory')).toHaveLength(1);
});

test('Learn button: asks the RLM agent to consolidate through its memory API', async ({ app, browser, screen }) => {
  await openApp(app, { seedRlm: true });
  await openRlmTab(browser);
  await screen.getByText('Old RLM chat').tap();
  await screen.getByRole('button', 'Apprendre de ce chat').tap();
  const sent = await calls(browser, 'send_rlm_message');
  expect(sent).toHaveLength(1);
  expect(sent[0].input.text).toContain('rlm.harness');
  expect(sent[0].input.text).toContain('Never store secrets');
});

test('Claaky: empty editor greets, quick start opens a chat, Settings can turn him off', async ({ app, browser, screen }) => {
  await openApp(app);
  await expect(screen.getByText('Que faisons-nous ?')).toBeVisible();
  await new Promise((r) => setTimeout(r, 1500));
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/claaky-empty.png' });

  await screen.getByRole('button', 'Calculer avec Claaky (RLM)').tap();
  expect(await calls(browser, 'create_rlm_conversation')).toHaveLength(1);

  await browser.locator('[title="Settings"]').first().tap();
  await screen.getByRole('button', 'Claaky', { exact: true }).tap();
  await expect(screen.getByText('Afficher Claaky', { exact: false })).toBeVisible();
  await new Promise((r) => setTimeout(r, 1200));
  await surfaceOf(engine)!.page().screenshot({ path: '.e2e/shots/claaky-settings.png' });
  await browser.locator('.claaky-settings__toggle input').tap();
  expect(await calls(browser, 'set_claaky_enabled')).toEqual([{ enabled: false }]);
});

test('Claaky follows the agent: working during a turn, done after, and every pose renders', async ({ app, browser, screen }) => {
  await openApp(app);
  const page = surfaceOf(engine)!.page();
  await page.evaluate(() => {
    (window as any).__claakyStates = [];
    new MutationObserver(() => {
      const el = document.querySelector('.chat-head__claaky');
      const st = el?.getAttribute('data-state');
      const seen = (window as any).__claakyStates;
      if (st && seen[seen.length - 1] !== st) seen.push(st);
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'], childList: true });
  });
  await openRlmTab(browser);
  await screen.getByRole('button', 'Nouveau chat RLM').tap();
  const composer = browser.locator('textarea').first();
  await composer.fill('bonjour claaky');
  await composer.press('Enter');
  await expect(screen.getByText('RLM reply to: bonjour claaky', { exact: false })).toBeVisible();
  await new Promise((r) => setTimeout(r, 800));
  const seen: string[] = await page.evaluate(() => (window as any).__claakyStates);
  expect(seen).toContain('working');
  expect(seen).toContain('done');
  // The 26 px header Claaky is flat: clay filters only from 48 px (GPU cost in long histories).
  const head = await page.evaluate(() => ({
    found: document.querySelectorAll('.chat-head__claaky').length,
    lights: document.querySelectorAll('.chat-head__claaky feDiffuseLighting').length,
  }));
  expect(head.found).toBe(1);
  expect(head.lights).toBe(0);

  await browser.locator('[title="Settings"]').first().tap();
  await screen.getByRole('button', 'Claaky', { exact: true }).tap();
  for (const [label, state] of [['Code', 'working'], ['Terminé', 'done'], ['Erreur', 'error'], ['Dort', 'sleeping']] as const) {
    await screen.getByRole('button', `Voir la pose : ${label}`).tap();
    await page.waitForFunction((st) => document.querySelector('.claaky-settings__preview .claaky')?.getAttribute('data-state') === st, state);
    await new Promise((r) => setTimeout(r, label === 'Terminé' ? 450 : 1100));
    await page.locator('.claaky-settings__preview').screenshot({ path: `.e2e/shots/claaky-pose-${label}.png` });
  }
});

test('Claaky 2D: clay SVG on the empty screen (no WebGL), animation stays smooth', async ({ app }) => {
  await openApp(app);
  const page = surfaceOf(engine)!.page();
  await page.waitForFunction(() => document.querySelectorAll('.claaky-empty svg.claaky').length === 1);
  // Large Claaky carries the clay lighting filters; no canvas anywhere (three.js is gone).
  const dom = await page.evaluate(() => ({
    lights: document.querySelectorAll('.claaky-empty feDiffuseLighting').length,
    canvases: document.querySelectorAll('.claaky-empty canvas').length,
  }));
  expect(dom.lights).toBeGreaterThan(0);
  expect(dom.canvases).toBe(0);
  // Frame pacing while Claaky animates: count rAF frames for 3 s.
  // Passed as a string: the test bundler injects a `__name` helper into named functions, absent in the page.
  const stats: { fps: number; long: number } = await page.evaluate(`new Promise((resolve) => {
    let frames = 0, long = 0, last = performance.now();
    const t0 = last;
    function tick(t) {
      frames++;
      if (t - last > 50) long++;
      last = t;
      if (t - t0 < 3000) requestAnimationFrame(tick);
      else resolve({ fps: (frames * 1000) / (t - t0), long });
    }
    requestAnimationFrame(tick);
  })`);
  console.log('claaky 2D frame pacing', JSON.stringify(stats));
  expect(stats.fps).toBeGreaterThan(20);
});
