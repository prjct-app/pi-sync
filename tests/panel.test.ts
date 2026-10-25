import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel, panelText, type PanelControl, type PanelSpec } from '@prjct.app/pi-tui-kit';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { runSyncPanel, syncPanelSpec, type SyncIntent, type SyncSnapshot } from '../src/panel.ts';
import type { BackupInfo } from '../src/archive-schema.ts';

const backup: BackupInfo = { id: '11111111-1111-4111-8111-111111111111', deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceName: 'Source laptop', createdAt: '2026-10-25T12:00:00Z', fileCount: 20, packageCount: 3, totalBytes: 1000 };
const disconnected: SyncSnapshot = { connected: false, deviceName: 'Target desktop', serviceUrl: 'https://sync.example', serviceReady: false, backups: [] };
const connected: SyncSnapshot = { ...disconnected, connected: true, serviceReady: true, backups: [backup] };
const control: PanelControl = { close() {}, refresh() {}, notice() {}, select() {} };
const specFor = (snap: SyncSnapshot, request: (intent: SyncIntent) => void = () => undefined) => syncPanelSpec({ reload: async () => snap, request }, { snap, busy: false, notice: undefined });
const action = (spec: PanelSpec, key: string) => { const value = spec.actions?.find(action => action.key === key); assert.ok(value); return value; };

test('the disconnected screen has one obvious login row activated by Enter', async () => {
  const intents: SyncIntent[] = [];
  const spec = specFor(disconnected, intent => intents.push(intent));
  assert.deepEqual(spec.items().map(item => item.id), ['login']);
  assert.ok(spec.activate?.when?.(spec.items()[0]));
  await spec.activate?.run(spec.items()[0], control);
  assert.deepEqual(intents, [{ action: 'login' }]);
});

test('the first connected row backs up this machine; saved rows are machine snapshots, not files', async () => {
  const intents: SyncIntent[] = [];
  const spec = specFor(connected, intent => intents.push(intent));
  assert.equal(spec.items()[0]?.id, 'this-machine');
  assert.equal(spec.items()[1]?.label, 'Source laptop');
  assert.match(spec.items()[1]!.meta!, /20 files/);
  await spec.activate!.run(spec.items()[0], control);
  await spec.activate!.run(spec.items()[1], control);
  assert.deepEqual(intents, [{ action: 'backup' }, { action: 'restore', id: backup.id }]);
  assert.match(JSON.stringify(spec.detail(spec.items()[1]!)), /Installs.*automatically/);
});

test('backup and restore are directional actions without preview, accept-code, or per-file modes', () => {
  const spec = specFor(connected);
  assert.ok(action(spec, 'b').when?.(undefined));
  assert.equal(action(spec, 'r').when?.(spec.items()[0]), false);
  assert.equal(action(spec, 'r').when?.(spec.items()[1]), true);
  assert.ok(!spec.actions?.some(action => ['s', 'y', 'v'].includes(action.key)));
  assert.equal(action(spec, 'r').confirm, undefined, 'the command asks once using the final downloaded archive');
});

test('multiple backups from the same machine keep distinct snapshot IDs and dates', () => {
  const spec = specFor({ ...connected, backups: [backup, { ...backup, id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-24T12:00:00Z' }] });
  assert.equal(new Set(spec.items().map(item => item.id)).size, 3);
  assert.notEqual(spec.items()[1]?.meta, spec.items()[2]?.meta);
});

test('an empty account explains how to create the first machine backup', () => {
  const spec = specFor({ ...connected, backups: [] });
  assert.match(panelText(spec), /Back up this machine/);
  assert.match(panelText(spec), /No backups yet/);
  assert.doesNotMatch(panelText(spec), /In sync/);
});

test('an expired login can be reconnected directly without a logout/login sequence', () => {
  const spec = specFor({ ...connected, needsLogin: true, remoteError: 'expired' });
  assert.equal(spec.items()[0]?.id, 'login');
  assert.equal(action(spec, 'b').when?.(undefined), false);
  assert.equal(action(spec, 'l').when?.(undefined), true);
});

test('legacy backups stay visible as partial and cannot be deleted as a new machine snapshot', () => {
  const spec = specFor({ ...connected, serviceReady: false, remoteError: 'Service upgrade required', backups: [{ ...backup, id: 'legacy', legacy: true }] });
  const item = spec.items().find(item => item.id === 'backup:legacy')!;
  assert.match(item.meta!, /partial/);
  assert.match(JSON.stringify(spec.detail(item)), /not a complete/);
  assert.equal(action(spec, 'b').when?.(undefined), false);
  assert.equal(action(spec, 'r').when?.(item), true);
  assert.equal(action(spec, 'd').when?.(item), false);
});

test('login and backup continue working in one session; a successful restore stops before runtime reload', async () => {
  const cell = { snap: disconnected, opened: 0 };
  const intents: SyncIntent[] = [];
  const choices = ['login', 'this-machine', `backup:${backup.id}`];
  const result = await runSyncPanel({
    reload: async () => cell.snap,
    fulfil: async intent => {
      intents.push(intent);
      cell.snap = connected;
      return { text: 'Done', tone: 'accent', reload: intent.action === 'restore' };
    },
  }, async spec => {
    const choice = choices[cell.opened++];
    assert.ok(choice, 'must not reopen an old runtime after restore');
    await spec.activate!.run(spec.items().find(item => item.id === choice), control);
  });
  assert.deepEqual(intents, [{ action: 'login' }, { action: 'backup' }, { action: 'restore', id: backup.id }]);
  assert.equal(result?.reload, true);
  assert.equal(cell.opened, 3);
});

test('failed operations show the result and keep subsequent backup actions usable', async () => {
  const cell = { attempts: 0, opened: 0 };
  await runSyncPanel({
    reload: async () => connected,
    fulfil: async () => { cell.attempts++; if (cell.attempts === 1) throw new Error('registry unavailable'); return { text: 'Backed up', tone: 'accent' }; },
  }, async spec => {
    cell.opened++;
    if (cell.opened === 2) assert.match(panelText(spec), /registry unavailable/);
    if (cell.opened < 3) await action(spec, 'b').run(undefined, control);
  });
  assert.equal(cell.attempts, 2, 'closing the final panel must not replay its last action');
});

test('the actual shared panel renders machine snapshots at narrow and wide terminal sizes', () => {
  const spec = specFor(connected);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
  const panel = createPanel(spec, tui, theme, () => undefined);
  try {
    for (const width of [40, 80, 120]) assert.ok(panel.render(width).every(line => visibleWidth(line) <= width));
    assert.match(panel.render(80).at(-1)!, /b Back up this machine/);
  } finally { panel.dispose(); }
});
