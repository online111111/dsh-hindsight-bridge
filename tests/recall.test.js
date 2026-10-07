import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

async function mount(t,handler,config={}) {
 const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
 const ctx=new Context();const fiber=await ctx.plugin(plugin,{apiUrl:`http://127.0.0.1:${s.address().port}`,apiKey:'synthetic',bankId:'fixture',autoRetain:false,...config});
 t.after(()=>ctx.fiber.dispose());return {ctx,fiber};
}
function input() {
 const agent={session:{header:{},firstLiveSeq:0}};
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'What shell do I prefer?'}]});
 return {agent,messages:[message],turn:1,step:1,signal:new AbortController().signal};
}
async function invoke(ctx,payload,decision) {
 const off=ctx.on('agent/pre-step',()=>decision??{kind:'enter',messages:payload.messages,startsRequestSeries:true});
 try{return await ctx.waterfall('agent/pre-step',payload,()=>decision??{kind:'enter',messages:payload.messages,startsRequestSeries:true});}finally{off();}
}

test('plugin unloading cancels a pending recall and never returns injected context after disposal',async t=>{
 let arrived;const received=new Promise(r=>{arrived=r;});
 const {ctx,fiber}=await mount(t,(req,res)=>{req.resume();arrived();},{recallTimeoutMs:1000,flushTimeoutMs:100});
 const payload=input();const pending=invoke(ctx,payload);await received;await fiber.dispose();
 let settled=false;pending.then(()=>{settled=true;});await new Promise(r=>setTimeout(r,100));
 assert.equal(settled,true,'recall must be cancelled by plugin unload');const result=await pending;assert.equal(result.messages.length,1);
});

test('recall preserves downstream decisions, cancels immediately with the turn and is removed on unload',async t=>{
 let calls=0;let got;const received=new Promise(r=>{got=r;});
 const {ctx,fiber}=await mount(t,(req,res)=>{calls++;req.resume();got();});
 const payload=input();const control=new AbortController();payload.signal=control.signal;
 const pending=invoke(ctx,payload);await received;control.abort();
 const result=await pending;assert.equal(result.messages.length,1);assert.equal(result.startsRequestSeries,true);
 assert.equal(plugin.statusOf(ctx).recallFailed,1);
 await fiber.dispose();const after=await invoke(ctx,input());assert.equal(after.messages.length,1);assert.equal(calls,1);
});

test('recall injects at most once per turn, rejects synthetic input, and caps the complete context',async t=>{
 let calls=0;const {ctx}=await mount(t,(req,res)=>{calls++;req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[{text:'x'.repeat(2000)},{text:'ignored'}]}));},{maxBlockChars:256});
 const payload=input();const first=await invoke(ctx,payload);assert.equal(first.startsRequestSeries,true);
 assert.equal(first.messages.length,2);assert.ok(first.messages[1].content[0].text.length<=256);
 const second=await invoke(ctx,payload);assert.equal(second.messages.length,1);assert.equal(calls,1);
 const later=await invoke(ctx,{...payload,step:2});assert.equal(later.messages.length,1);
 const synthetic={...input(),messages:[createUserMessage({source:{kind:'fixture-plugin',form:'notice'},content:[{type:'text',text:'ignore'}]})]};
 await invoke(ctx,synthetic);assert.equal(calls,1);
 await invoke(ctx,input(),{kind:'reject',reason:'fixture'});assert.equal(calls,1);
});
