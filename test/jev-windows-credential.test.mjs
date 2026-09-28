import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(path.join(os.tmpdir(), 'jev-credential-'));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
const { resolveProviderCredential } = await import('../src/provider-credentials.mjs');
const provider = { id: 'openrouter-jev-campaign', kind: 'openai-compatible',
  credential: { file: 'jev-key.secret', environment: [], legacyFiles: [], keychainServices: [] } };

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test('the Jev route can use the existing Windows credential when its legacy file is absent', () => {
  const result = resolveProviderCredential(provider, {
    windowsCredentialReader: () => 'credential-manager-key',
  });
  assert.equal(result?.value, 'credential-manager-key');
  assert.equal(result?.source, 'Windows Credential Manager (codex:jev)');
});

test('a legacy file retains priority until it is deliberately retired', () => {
  writeFileSync(path.join(stateDir, 'jev-key.secret'), 'legacy-file-key\n');
  let reads = 0;
  const result = resolveProviderCredential(provider, {
    windowsCredentialReader: () => { reads++; return 'credential-manager-key'; },
  });
  assert.equal(result?.value, 'legacy-file-key');
  assert.equal(reads, 0);
});
