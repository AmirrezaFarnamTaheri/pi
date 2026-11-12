import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, readPinnedVersion, identifyStale } from './check-provider-client-versions.mjs';

test('numeric versions compare segment by segment, never lexically', () => {
  assert.equal(compareVersions('2.1.322', '2.1.290'), 1);
  assert.equal(compareVersions('1.146.0', '1.107.0'), 1);
  assert.equal(compareVersions('0.43.0', '0.43.0'), 0);
  assert.equal(compareVersions('0.35.0', '0.43.0'), -1);
});

test('pinned source constants are detected safely', () => {
  assert.equal(readPinnedVersion('const claudeCodeVersion = "2.1.322";', 'claudeCodeVersion'), '2.1.322');
  assert.equal(readPinnedVersion('const COPILOT_CHAT_VERSION = "0.43.0";', 'COPILOT_CHAT_VERSION'), '0.43.0');
  assert.throws(() => readPinnedVersion('const x = getVersion();', 'x'), /not found/);
});

test('stale detection reports only genuinely newer stable releases', () => {
  const reported = identifyStale([
    { label: 'Claude', installed: '2.1.322', latest: 'v2.1.322' },
    { label: 'Copilot', installed: '0.35.0', latest: 'v0.43.0' },
    { label: 'VS Code', installed: '1.146.0', latest: '1.145.3' },
  ]);
  assert.deepEqual(reported.map((x) => x.label), ['Copilot']);
  assert.equal(reported[0].latest, '0.43.0');
});
