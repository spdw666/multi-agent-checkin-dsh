import test from 'node:test';
import assert from 'node:assert/strict';
test('real DSH adapter keeps live1M context and gateway ownership on plain and relay routes',async t=>{
 let createGatewayAdapter;try{({createGatewayAdapter}=await import('../bundle/index.mjs'));}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Optional DSH peer packages absent');return;}throw error;}
 const {resolveRetryPolicy}=await import('@deepseek-ai/dsh-llm');assert.equal(resolveRetryPolicy().maxRetries,5);
 const plain={id:'fixture/glm-5.3',name:'Fixture',contextWindow:1000000,maxTokens:64000,capabilities:{multimodal:true}},relay={...plain,modelRelay:{deliveryMode:'verified_request_buffer',requestTimeoutMs:180000}};
 const gateway=createGatewayAdapter({runtime:{baseUrl:'http://127.0.0.1:1',key:'offline-fixture'},models:[relay]});
 const profile=()=>gateway.adapter.config.profiles().get('ai-credit');
 assert.equal((await gateway.adapter.resolveModel('ai-credit',relay.id)).context.contextWindow,1000000);assert.equal(profile().retryPolicy.maxRetries,1);assert.equal(profile().streamIdleTimeoutMs,190000);
 assert.equal(gateway.update([plain]),true);assert.equal(profile().retryPolicy.maxRetries,1);assert.equal(profile().streamIdleTimeoutMs,180000);
 assert.equal(gateway.update([relay]),true);assert.equal(profile().retryPolicy.maxRetries,1);assert.equal(profile().retryPolicy.retryableCodes.includes('INVALID_REQUEST'),false);assert.equal(profile().retryPolicy.retryableCodes.includes('CONTEXT_WINDOW_EXCEEDED'),false);
 assert.equal(resolveRetryPolicy().maxRetries,5);
});
