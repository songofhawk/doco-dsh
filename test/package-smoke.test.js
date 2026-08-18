// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

test('package.json：名称/模块/导出/工作区依赖', () => {
  assert.equal(pkg.name, 'doco-dsh');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(typeof pkg.exports?.['.'], 'string');
  assert.equal(pkg.exports?.['.'], './src/index.js');
  assert.match(pkg.dependencies?.['doco-agent-cli'] ?? '', /^\^0\.1\.3$/);
  // dsh 依赖为 peer（host 提供）+ optional（缺失时不阻断 base 安装）
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], '>=0.1.0-rc.7');
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional, true);
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional, true);
});

test('入口：name / inject / version / apply 形状正确且可被 import', async () => {
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'doco-dsh');
  assert.deepEqual(mod.inject, ['tools', 'commands', 'systemPrompt']);
  assert.equal(mod.pluginVersion, pkg.version);
  assert.equal(typeof mod.apply, 'function');
});