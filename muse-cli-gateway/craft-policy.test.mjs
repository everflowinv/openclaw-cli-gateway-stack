import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateRequest, MODEL } from './request.mjs';
test('Craft namespaces remain intersected with explicit request tools',()=>{
  const body={model:MODEL,messages:[{role:'user',content:'read a document'}],tools:[
    {function:{name:'gridcraft__read_range'}},{function:{name:'mcp__wordcraft__get_text'}},
    {function:{name:'mcp__openclaw__pdfcraft__doc_info'}},{function:{name:'evil__shell'}}]};
  assert.deepEqual(translateRequest(body).allowedTools,['gridcraft__read_range','wordcraft__get_text','pdfcraft__doc_info']);
  assert.deepEqual(translateRequest({...body,tools:[]}).allowedTools,[]);
  assert.deepEqual(translateRequest({...body,tool_choice:'none'}).allowedTools,[]);
});
