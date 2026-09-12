import test from 'node:test';
import assert from 'node:assert/strict';
import { DocoClient } from 'doco-agent-cli/client';
import { makeFakeState } from './helpers/fake-context.js';
import { createDocoGetSpreadsheet, createDocoGetCells, createDocoUpdateCells } from '../src/tools/spreadsheet.js';
import { writeGuard, preExecuteDecision } from '../src/policy.js';

const cells = { C15: '10', C16: '20', C17: '=SUM(C15:C16)', C18: '' };
const args = { document_id: 'doc/1', sheet_id: 'sheet/1', range: 'C15:C18', cells, if_match: 'old' };
function fixture(status = 200, code = 'document_version_conflict', allowWrites = true, scopes = ['documents:write']) {
  const calls = [];
  const client = new DocoClient({ baseUrl: 'http://localhost/api/v1', token: 'test-token', fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify(status === 200 ? { data: { version: 'new', cells, updated_count: 4 } } : {
      error: { code, message: 'rejected', details: { current_version: 'new' } }, request_id: 'request-test',
    }), { status });
  } });
  const state = makeFakeState({ config: { allowWrites }, client: {
    request: client.request.bind(client), me: async () => ({ data: { scopes } }),
  } });
  return { state, calls };
}

test('spreadsheet tools use published client transport: paths, raw strings, Bearer, If-Match', async () => {
  const { state, calls } = fixture();
  for (const factory of [createDocoGetSpreadsheet, createDocoGetCells, createDocoUpdateCells]) {
    const tool = factory({ state, name: 'test' });
    const result = await tool.execute(args);
    assert.deepEqual(result.cells, cells);
    assert.equal(result.version, 'new');
    assert.match(tool.render(args, result)[0].text, /SUM/);
  }
  assert.equal(calls[0].url.pathname, '/api/v1/documents/doc%2F1/spreadsheet');
  assert.equal(calls[1].url.pathname, '/api/v1/documents/doc%2F1/spreadsheet/sheets/sheet%2F1/cells');
  assert.equal(calls[1].url.searchParams.get('range'), 'C15:C18');
  assert.equal(calls[2].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[2].headers['If-Match'], '"old"');
  assert.deepEqual(JSON.parse(calls[2].body), { cells });
});

for (const [status, code] of [[409, 'document_version_conflict'], [409, 'document_type_mismatch'], [400, 'invalid_spreadsheet_range'], [404, 'spreadsheet_sheet_not_found']]) {
  test(`spreadsheet error ${status} ${code} preserved with no retry`, async () => {
    const { state, calls } = fixture(status, code);
    const result = await createDocoUpdateCells({ state, name: 'test' }).execute(args);
    assert.equal(result.kind, 'doco_error');
    assert.equal(result.code, code);
    assert.equal(result.http_status, status);
    assert.equal(result.details.current_version, 'new');
    assert.equal(calls.length, 1);
    if (code === 'document_version_conflict') assert.match(result.next_step, /current_version=new/);
    else assert.doesNotMatch(result.next_step, /current_version/);
  });
}

test('spreadsheet write gate includes prefix, scope, direct execution, explicit version', async () => {
  const exec = { name: 'kb_update_cells', arguments: args };
  const disabled = fixture(200, '', false);
  assert.match(writeGuard(exec, disabled.state, 'kb_'), /doco_write_not_confirmed/);
  assert.equal((await createDocoUpdateCells({ state: disabled.state, name: exec.name }).execute(args)).code, 'doco_write_not_confirmed');
  assert.equal(disabled.calls.length, 0);
  const readonly = fixture(200, '', true, ['documents:read']);
  assert.equal((await preExecuteDecision(exec, () => assert.fail(), readonly.state, 'kb_')).kind, 'deny');
  assert.equal((await createDocoUpdateCells({ state: readonly.state, name: exec.name }).execute(args)).code, 'doco_write_scope_required');
  const enabled = fixture();
  assert.equal((await preExecuteDecision(exec, () => assert.fail(), enabled.state, 'kb_')).kind, 'ask');
  const tool = createDocoUpdateCells({ state: enabled.state, name: exec.name });
  for (const if_match of [undefined, '', '*']) assert.equal((await tool.execute({ ...args, if_match })).code, 'invalid_request');
  assert.equal(enabled.calls.length, 0);
});
