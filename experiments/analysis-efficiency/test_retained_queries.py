"""Deterministic RPC receipt failures; not real-provider or model evidence."""
import json
from pathlib import Path
import subprocess
import unittest


class RetainedQueryReceipts(unittest.TestCase):
    def run_node(self, body):
        module = Path(__file__).with_name('retained-query-calls.mjs').resolve().as_uri()
        source = ('import assert from "node:assert/strict";\n'
                  'const {createRetainedQueryCaller} = await import(' + json.dumps(module) + ');\n' + body)
        result = subprocess.run(['node', '--input-type=module', '-'], input=source,
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejected_call_preserves_request_phase_cost_and_original_failure(self):
        self.run_node('''
const failure = new Error('owned server closed');
const input = {offset:0, limit:2}; const rows=[]; const events=[];
const call = createRetainedQueryCaller({callTool:async request=>{
  assert.strictEqual(request.arguments,input);throw failure;
}}, async(row,event)=>{rows.push(row);events.push(event);});
await assert.rejects(call('list_unknowns',input,'resume-2'), e=>e===failure);
assert.equal(rows.length,1);assert.equal(events.length,1);
assert.strictEqual(rows[0].input,input);assert.equal(rows[0].name,'list_unknowns');
assert.equal(rows[0].phase,'resume-2');assert.ok(rows[0].elapsed_ms>=0);
assert.equal(rows[0].reply_bytes,null);assert.equal(rows[0].is_error,true);
assert.deepEqual(events[0].failure,{name:'Error',message:'owned server closed'});
''')

    def test_protocol_error_is_a_received_reply_with_known_bytes(self):
        self.run_node('''
const reply={isError:true,content:[{type:'text',text:'capacity refusal'}]};const rows=[];
const call=createRetainedQueryCaller({callTool:async()=>reply},async row=>rows.push(row));
assert.strictEqual(await call('get_evidence_bundle',{},'complete'),reply);
assert.equal(rows.length,1);assert.equal(rows[0].is_error,true);
assert.equal(rows[0].reply_bytes,Buffer.byteLength(JSON.stringify(reply)));
assert.equal(Object.hasOwn(rows[0],'failure'),false);
''')

    def test_receipt_write_error_does_not_reclassify_a_completed_rpc(self):
        self.run_node('''
const failure=new Error('receipt disk unavailable');const rows=[];
const call=createRetainedQueryCaller({callTool:async()=>({content:[]})},async row=>{
  rows.push(row);throw failure;
});
await assert.rejects(call('list_unknowns',{},'read'),e=>e===failure);
assert.equal(rows.length,1);assert.equal(rows[0].is_error,false);
assert.equal(Object.hasOwn(rows[0],'failure'),false);
''')

    def test_failed_recording_preserves_the_prior_rpc_failure(self):
        self.run_node('''
const rpc=new Error('request timeout');const disk=new Error('receipt close failed');
const call=createRetainedQueryCaller({callTool:async()=>{throw rpc;}},async()=>{throw disk;});
await assert.rejects(call('inspect_analysis_view',{},'selected'),e=>
  e instanceof AggregateError && e.errors[0]===rpc && e.errors[1]===disk);
''')
