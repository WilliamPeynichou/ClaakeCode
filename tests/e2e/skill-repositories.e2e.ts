import { test, surfaceOf } from '@e2e-dev/web';
import { expect } from 'e2e';
import { engine } from './engine';
import { installTauriMock, type MockOptions, type SeedRepository } from './tauriMock';

// Fixture: the six real ponytail skills (DietrichGebert/ponytail @ 09c434ab), copy of skills/
// with descriptions folded onto one line (the copy that wins over .openclaw/skills/).
const PONYTAIL_REV = '09c434ab73ca43761c5d8b0c5d341926c2fba710';
const PONYTAIL: SeedRepository = {
  id: '5f0c1e2a-0000-4000-8000-000000000001',
  name: 'ponytail',
  url: 'https://github.com/DietrichGebert/ponytail',
  revision: PONYTAIL_REV,
  skills: [
    ['ponytail', 'Lazy senior dev mode: the smallest change that fully solves the task, and a reply a busy human understands in one read. Levels: lite, full (default), ultra.', 'skills/ponytail/SKILL.md'],
    ['ponytail-audit', 'Quality audit of a whole repo: bugs, security holes, what breaks under real load, risky code without tests, slow paths, and what to delete, merge or split.', 'skills/ponytail-audit/SKILL.md'],
    ['ponytail-debt', 'List every `shortcut:` comment (and older `ponytail:` ones) as a debt ledger. One-shot report, changes nothing.', 'skills/ponytail-debt/SKILL.md'],
    ['ponytail-gain', "Show ponytail's measured savings (code, cost, speed) from the benchmark. One-shot display.", 'skills/ponytail-gain/SKILL.md'],
    ['ponytail-help', 'Quick reference for ponytail levels, skills and commands. One-shot display.', 'skills/ponytail-help/SKILL.md'],
    ['ponytail-review', 'Quality review of a change: is the logic right, is it safe, does it hold under real load, is risky code tested. Use for /ponytail-review.', 'skills/ponytail-review/SKILL.md'],
  ],
  warnings: [
    'doublon ignoré : ponytail (.openclaw/skills/ponytail/SKILL.md)',
    'doublon ignoré : ponytail-audit (.openclaw/skills/ponytail-audit/SKILL.md)',
    'doublon ignoré : ponytail-debt (.openclaw/skills/ponytail-debt/SKILL.md)',
    'doublon ignoré : ponytail-gain (.openclaw/skills/ponytail-gain/SKILL.md)',
    'doublon ignoré : ponytail-help (.openclaw/skills/ponytail-help/SKILL.md)',
    'doublon ignoré : ponytail-review (.openclaw/skills/ponytail-review/SKILL.md)',
  ],
};
const OTHER: SeedRepository = {
  id: '5f0c1e2a-0000-4000-8000-000000000002',
  name: 'team-skills',
  url: 'https://github.com/example/team-skills',
  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  skills: [['ponytail-help', 'Team copy of the same name.', 'skills/ponytail-help/SKILL.md']],
};

async function openApp(app: { open: (path: string) => Promise<unknown> }, options: MockOptions = {}) {
  await app.open('/');
  const page = surfaceOf(engine)!.page();
  await page.addInitScript({
    content: `var __name = (f) => f; (${installTauriMock.toString()})(${JSON.stringify(options)});`,
  });
  await page.reload();
}

const calls = (browser: any, cmd: string) =>
  browser.evaluate(
    (name: string) => (window as any).__mock.calls.filter((c: any) => c.cmd === name).map((c: any) => c.args),
    cmd,
  );

async function openSkillsRepositories(browser: any, screen: any) {
  await expect(screen.getByText('Classic chat')).toBeVisible();
  await browser.locator('[title="Settings"]').first().tap();
  await screen.getByRole('button', 'Skills', { exact: false }).tap();
  await browser.locator('.settings-pane__repositories-summary').first().tap();
}

test('Skills repos: ponytail shows 6 skills, no conflict badge, readable descriptions', async ({ app, browser, screen }) => {
  await openApp(app, { skillRepositories: [PONYTAIL] });
  await openSkillsRepositories(browser, screen);
  await expect(screen.getByText('ponytail · enabled · 6 skills', { exact: false })).toBeVisible();
  await screen.getByText('ponytail · enabled · 6 skills', { exact: false }).tap();
  await expect(screen.getByText('Name conflict', { exact: false })).not.toBeVisible();
  await expect(screen.getByText('doublon ignoré : ponytail-audit', { exact: false })).toBeVisible();
  // Descriptions are read in full, never shown as a raw YAML block indicator.
  await expect(screen.getByText('Quality audit of a whole repo', { exact: false })).toBeVisible();
  await expect(screen.getByText('>', { exact: true })).not.toBeVisible();
});

test('Skills repos: a real conflict badge disappears when the other repository is disabled', async ({ app, browser, screen }) => {
  // OTHER also ships ponytail-help: a real cross-repository conflict (both sides flagged).
  await openApp(app, { skillRepositories: [PONYTAIL, OTHER] });
  await openSkillsRepositories(browser, screen);
  await screen.getByText('team-skills · enabled', { exact: false }).tap();
  // The collapsed ponytail block also renders its copy in the DOM: look at the open block (last).
  await expect(screen.getByText('Name conflict', { exact: false }).last()).toBeVisible();
  await screen.getByRole('switch', { name: 'Enable all skills from team-skills' }).tap();
  await expect(screen.getByText('Name conflict', { exact: false })).not.toBeVisible();
});

test('Skills repos: enabling auto-update calls the backend with the right arguments and shows the warning', async ({ app, browser, screen }) => {
  await openApp(app, { skillRepositories: [PONYTAIL] });
  await openSkillsRepositories(browser, screen);
  await screen.getByText('ponytail · enabled · 6 skills', { exact: false }).tap();
  await screen.getByRole('switch', { name: 'Mise à jour auto ponytail' }).tap();
  expect(await calls(browser, 'set_skill_repository_auto_update_command')).toEqual([
    { input: { id: PONYTAIL.id, autoUpdate: true } },
  ]);
  await expect(screen.getByText('injecter des instructions', { exact: false })).toBeVisible();
});

test('Skills repos: "Tout mettre à jour" checks every enabled repo, updates only those with changes, then notifies', async ({ app, browser, screen }) => {
  const newer = '1111111111111111111111111111111111111111';
  await openApp(app, {
    skillRepositories: [PONYTAIL, { ...OTHER, skills: [['x', 'Other skill.', 'skills/x/SKILL.md']] }],
    remoteRevisions: { [PONYTAIL.id]: newer },
  });
  await openSkillsRepositories(browser, screen);
  await screen.getByRole('button', 'Tout mettre à jour', { exact: true }).tap();
  // One check per enabled repository, one update only for the repository with new commits.
  expect(await calls(browser, 'check_skill_repository_upstream_command')).toEqual([
    { input: { id: PONYTAIL.id } }, { input: { id: OTHER.id } },
  ]);
  expect(await calls(browser, 'update_skill_repository_command')).toEqual([{ input: { id: PONYTAIL.id } }]);
  // Notification: repository, old → new short revision (7 characters).
  await expect(screen.getByText(`ponytail : ${PONYTAIL_REV.slice(0, 7)} → ${newer.slice(0, 7)}`, { exact: false })).toBeVisible();
});

test('Skills repos: network error shows a message and leaves the list unchanged', async ({ app, browser, screen }) => {
  await openApp(app, { skillRepositories: [PONYTAIL], upstreamUnreachable: true });
  await openSkillsRepositories(browser, screen);
  await screen.getByText('ponytail · enabled · 6 skills', { exact: false }).tap();
  await screen.getByRole('button', 'Check upstream', { exact: true }).tap();
  await expect(screen.getByRole('alert')).toContainText('Unable to reach the remote repository');
  await expect(screen.getByText('ponytail · enabled · 6 skills', { exact: false })).toBeVisible();
});

test('Skills repos: removing a repository removes its skills from the list', async ({ app, browser, screen }) => {
  await openApp(app, { skillRepositories: [PONYTAIL] });
  await openSkillsRepositories(browser, screen);
  await screen.getByText('ponytail · enabled · 6 skills', { exact: false }).tap();
  await screen.getByRole('button', 'Remove', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm removal', { exact: true }).tap();
  await expect(screen.getByText('ponytail-audit', { exact: true })).not.toBeVisible();
  await expect(screen.getByText('Git repositories · 0', { exact: false }).first()).toBeVisible();
});
