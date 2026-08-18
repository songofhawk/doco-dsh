// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeContext, makeFakeState } from './helpers/fake-context.js';
import {
  hasScope, writeToolName, isCommitCall, writeGuard, preExecuteDecision, applyPolicy,
  SCOPE_READ, SCOPE_WRITE,
} from '../src/policy.js';

test('hasScope / writeToolName', () => {
  assert.equal(hasScope(['documents:read', 'documents:write'], SCOPE_WRITE), true);
  assert.equal(hasScope(['documents:read'], SCOPE_WRITE), false);
  assert.equal(hasScope(undefined, SCOPE_READ), false);
  assert.equal(writeToolName('doco_'), 'doco_save_draft');
});

test('isCommitCall：仅识别 doco_save_draft 的 commit 调用', () => {
  assert.equal(isCommitCall({ name: 'doco_save_draft', arguments: { mode: 'commit' } }, 'doco_'), true);
  assert.equal(isCommitCall({ name: 'doco_save_draft', arguments: { mode: 'preview' } }, 'doco_'), false);
  assert.equal(isCommitCall({ name: 'doco_read', arguments: { mode: 'commit' } }, 'doco_'), false);
  assert.equal(isCommitCall(null, 'doco_'), false);
});

test('writeGuard：非 commit 放行；commit 且 allowWrites 未开 → 拒绝并给 doco_write_not_confirmed', () => {
  const state = { config: { allowWrites: false } };
  assert.equal(writeGuard({ name: 'doco_save_draft', arguments: { mode: 'preview' } }, state, 'doco_'), undefined);
  const reason = writeGuard({ name: 'doco_save_draft', arguments: { mode: 'commit' } }, state, 'doco_');
  assert.ok(reason.includes('doco_write_not_confirmed'));
  assert.equal(writeGuard({ name: 'doco_save_draft', arguments: { mode: 'commit' } }, { config: { allowWrites: true } }, 'doco_'), undefined);
});

test('preExecuteDecision：非 commit 直接透传 next()', async () => {
  const next = async () => ({ kind: 'allow' });
  const r = await preExecuteDecision({ name: 'doco_search' }, next, makeFakeState(), 'doco_');
  assert.deepEqual(r, { kind: 'allow' });
});

test('preExecuteDecision：allowWrites 未开 → deny doco_write_not_confirmed', async () => {
  const next = async () => ({ kind: 'allow' });
  const r = await preExecuteDecision(
    { name: 'doco_save_draft', arguments: { mode: 'commit' } },
    next,
    makeFakeState({ config: { allowWrites: false } }),
    'doco_',
  );
  assert.equal(r.kind, 'deny');
  assert.ok(r.reason.includes('doco_write_not_confirmed'));
});

test('preExecuteDecision：有 write scope → ask 用户确认', async () => {
  const next = async () => ({ kind: 'allow' });
  const state = makeFakeState({
    config: { allowWrites: true },
    client: { me: async () => ({ data: { scopes: ['documents:read', 'documents:write'] } }) },
  });
  const r = await preExecuteDecision(
    { name: 'doco_save_draft', arguments: { mode: 'commit', title: '移动端设计' } },
    next, state, 'doco_',
  );
  assert.equal(r.kind, 'ask');
  assert.ok(r.reason.includes('移动端设计'));
});

test('preExecuteDecision：有 allowWrites 但无 write scope → deny doco_write_scope_required', async () => {
  const next = async () => ({ kind: 'allow' });
  const state = makeFakeState({ config: { allowWrites: true }, client: { me: async () => ({ data: { scopes: ['documents:read'] } }) } });
  const r = await preExecuteDecision({ name: 'doco_save_draft', arguments: { mode: 'commit' } }, next, state, 'doco_');
  assert.equal(r.kind, 'deny');
  assert.ok(r.reason.includes('doco_write_scope_required'));
});

test('applyPolicy：装配 guard + pre-execute 并返回 disposers', () => {
  const { ctx, guards, preExecute } = makeFakeContext();
  const state = makeFakeState();
  const disposers = applyPolicy(ctx, state, 'doco_');
  assert.equal(guards.length, 1);
  assert.equal(preExecute.length, 1);
  assert.equal(disposers.length, 2);
  assert.ok(disposers.every((d) => typeof d === 'function'));
});