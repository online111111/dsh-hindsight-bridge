import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {statusOf} from '../lib/index.js';
import {loadComposition,waitFor} from './helpers.js';

async function fixture(t) {
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
    requests.push({path:req.url,method:req.method,body,auth:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url.endsWith('/recall')) res.end(JSON.stringify({results:[{text:'User prefers fish shell.'}]}));
    else if(req.url.endsWith('/memories')) res.end(JSON.stringify({success:true,async:true,operation_id:'fixture-'+requests.filter(r=>r.path.endsWith('/memories')).length}));
    else if(req.url.includes('/operations/')) res.end(JSON.stringify({status:'completed'}));
    else {res.statusCode=404;res.end(JSON.stringify({error:'unexpected fixture route'}));}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return {requests,url:`http://127.0.0.1:${server.address().port}`};
}

class Adapter extends LlmAdapter {
  requests=[];
  async resolveModel(provider,model) {return {provider,id:model,name:model};}
  async *stream(options) {
    this.requests.push(options);const text='Preference recorded.';
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
test('real Loader composition recalls before a model request, records durable context, and retains two distinct turns',{timeout:15000},async t=>{
  const api=await fixture(t);
  const ctx=await loadComposition(t,{apiUrl:api.url,apiKey:'synthetic-key',bankId:'deepseek-harness',minRetainChars:1});
  const adapter=new Adapter();const releaseAdapter=ctx.llm.registerAdapter(['fixture'],adapter);t.after(releaseAdapter);
  const agent=await ctx.agentLoop.create(SessionId('composition-main'),{provider:'fixture',model:'fixture'});
  for(const text of ['My preferred shell is fish.','My preferred editor is neovim.']) {
    agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await agent.whenIdle();
  }
  await ctx.sessions.flush(agent.session);
  await waitFor(()=>statusOf(ctx).completed===2,'both Retain responses must be settled before teardown');
  assert.equal(statusOf(ctx).failed,0);
  assert.equal(statusOf(ctx).pending,0);
  const polls=api.requests.filter(r=>r.path.includes('/operations/'));
  assert.deepEqual(polls.map(r=>r.path.split('/').at(-1)),['fixture-1','fixture-2']);
  assert.ok(polls.every(r=>r.method==='GET'));
  assert.equal(api.requests.filter(r=>r.path.endsWith('/recall')).length,2);
  assert.equal(adapter.requests.length,2);
  const wire=adapter.requests[0].messages.flatMap(m=>m.content).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  assert.match(wire,/User prefers fish shell/);
  assert.ok(agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.source?.kind==='hindsight-memory'));
  const retained=api.requests.filter(r=>r.path.endsWith('/memories'));
  assert.notEqual(retained[0].body.items[0].document_id,retained[1].body.items[0].document_id);
  assert.match(retained[0].body.items[0].content,/User: My preferred shell is fish/);
  assert.ok(!retained[0].body.items[0].content.includes('Relevant memory'));
  assert.equal(retained[0].auth,'Bearer synthetic-key');
});
