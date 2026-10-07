import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

function exchange(s,turn=1) {
  s.append('turn/start',{turn});s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'I prefer a small command line interface.'}]}),{surfaceOp:'append'});
  s.append('assistant/message',{turn,step:1,message:createAssistantMessage({source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Preference noted.'}]}),stream:[]},{surfaceOp:'append'});
  return s.append('turn/end',{turn,reason:{kind:'completed'}});
}
async function fixture(t,handler) {
  const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));return `http://127.0.0.1:${server.address().port}`;
}
async function mount(t,url,extra={}) {
  const ctx=new Context();await ctx.plugin(SessionStore);const fiber=await ctx.plugin(plugin,{apiUrl:url,apiKey:'synthetic',bankId:'fixture',autoRecall:false,...extra});
  t.after(()=>ctx.fiber.dispose());return {ctx,fiber};
}

test('operation deadline cancels slow polling instead of waiting for a full request timeout',async t=>{
 let poll;const polled=new Promise(r=>{poll=r;});const url=await fixture(t,(req,res)=>{
  req.resume();res.setHeader('content-type','application/json');
  if(req.method==='POST')res.end('{"success":true,"async":true,"operation_id":"slow-op"}');
  else{poll();}
 });
 const {ctx}=await mount(t,url,{operationTimeoutMs:100,retainTimeoutMs:2000,flushTimeoutMs:2000});const s=ctx.sessions.create(SessionId('poll-deadline'));
 exchange(s);await polled;
 await new Promise(r=>setTimeout(r,250));
 assert.equal(plugin.statusOf(ctx).pending,0,'polling must honor the total operation deadline');assert.equal(plugin.statusOf(ctx).failed,1);
});

test('all asynchronous operation IDs are polled rather than only the first',async t=>{
 const polled=[];const url=await fixture(t,(req,res)=>{
  req.resume();res.setHeader('content-type','application/json');
  if(req.method==='POST')res.end(JSON.stringify({success:true,async:true,operation_id:'operation-a',operation_ids:['operation-a','operation-b']}));
  else{polled.push(req.url);res.end('{"status":"completed"}');}
 });
 const {ctx}=await mount(t,url);const s=ctx.sessions.create(SessionId('multi-op'));exchange(s);await ctx.parallel('session/flush',s);
 assert.deepEqual(polled,['/v1/default/banks/fixture/operations/operation-a','/v1/default/banks/fixture/operations/operation-b']);
 assert.equal(plugin.statusOf(ctx).completed,1);
});

test('plugin unload aborts and settles pending writes within its drain budget',async t=>{
 let seen;const arrived=new Promise(r=>{seen=r;});
 const url=await fixture(t,(req,res)=>{req.resume();seen();});
 const {ctx,fiber}=await mount(t,url,{flushTimeoutMs:100,retainTimeoutMs:5000});const s=ctx.sessions.create(SessionId('unload-write'));
 exchange(s);await arrived;await fiber.dispose();
 assert.equal(plugin.statusOf(ctx),undefined,'unload removes its runtime and settles background work');
});

test('malformed acceptance cannot be reported as completed retention',async t=>{
 const url=await fixture(t,(req,res)=>{req.resume();res.setHeader('content-type','application/json');res.end('{}');});
 const {ctx}=await mount(t,url);const s=ctx.sessions.create(SessionId('malformed-response'));exchange(s);await ctx.parallel('session/flush',s);
 assert.equal(plugin.statusOf(ctx).completed,0);assert.equal(plugin.statusOf(ctx).failed,1);
});

test('subagent origin is excluded even without a parent-session pointer',async t=>{
 let calls=0;const url=await fixture(t,(req,res)=>{calls++;req.resume();res.setHeader('content-type','application/json');res.end('{"success":true}');});
 const {ctx}=await mount(t,url);const child=ctx.sessions.create(SessionId('spawn-child'),{meta:{origin:'subagent'}});
 exchange(child);await ctx.parallel('session/flush',child);assert.equal(calls,0);assert.equal(plugin.statusOf(ctx).pending,0);
});

test('write failures and full queues are visible, bounded, and never retried as new POSTs',async t=>{
  let calls=0;let rejectFirst;const url=await fixture(t,(req,res)=>{
    req.resume();calls++;rejectFirst=()=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"synthetic-private-response"}');};
  });
  const {ctx}=await mount(t,url,{maxPendingWrites:1,flushTimeoutMs:1000});const s=ctx.sessions.create(SessionId('bounded-writes'));
  exchange(s,1);exchange(s,2);
  assert.equal(plugin.statusOf(ctx).dropped,1);assert.equal(plugin.statusOf(ctx).pending,1);
  const deadline=Date.now()+2000;while(!rejectFirst){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  rejectFirst();await ctx.parallel('session/flush',s);
  assert.equal(calls,1);assert.equal(plugin.statusOf(ctx).failed,1);assert.equal(plugin.statusOf(ctx).pending,0);
});

test('flush waits for accepted asynchronous retention to actually complete without blocking turn/end',async t=>{
  let release;let polled=0;
  const url=await fixture(t,(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='POST'){req.resume();res.end(JSON.stringify({success:true,operation_id:'operation-a'}));}
    else {polled++;release=()=>res.end(JSON.stringify({status:'completed'}));}
  });
  const {ctx}=await mount(t,url,{operationPollMs:20});const s=ctx.sessions.create(SessionId('async-write'));
  exchange(s);
  let flushed=false;const pending=ctx.parallel('session/flush',s).then(()=>{flushed=true;});
  await new Promise(r=>setTimeout(r,80));assert.ok(polled>0,'accepted operation must be polled');assert.equal(flushed,false);
  release();await pending;assert.equal(flushed,true);
  assert.equal(plugin.statusOf(ctx).completed,1);assert.equal(plugin.statusOf(ctx).pending,0);
});
