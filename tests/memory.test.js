import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm';

export async function harness(t) {
  const ctx=new Context();await ctx.plugin(SessionStore);t.after(()=>ctx.fiber.dispose());return ctx;
}
export function appendExchange(session,turn,user,assistant) {
  session.append('turn/start',{turn});
  session.append('user/message',createUserMessage({content:[{type:'text',text:user}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('assistant/message',{turn,step:1,message:createAssistantMessage({content:[{type:'text',text:assistant}],source:{kind:'model',provider:'fixture',model:'fixture'}}),stream:[]},{surfaceOp:'append'});
  return session.append('turn/end',{turn,reason:{kind:'completed'}});
}

test('surface replacements are model history edits, never fresh human memories',async t=>{
 const ctx=await harness(t);const {TurnCapture}=await import('../lib/memory.js');const outputs=[];
 const capture=new TurnCapture({maxRetainChars:1000});ctx.on('session/event',(s,e)=>{const v=capture.consume(s,e);if(v)outputs.push(v);});
 const s=ctx.sessions.create(SessionId('projection-replacement'));s.append('turn/start',{turn:1});
 const prior=s.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'notice'},content:[{type:'text',text:'Synthetic old text'}]}),{surfaceOp:'append'});
 s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Projected human text not a real input'}]}),{surfaceOp:{op:'replace',startSeq:prior.seq,endSeq:prior.seq},sourceEventSeqs:[prior.seq]});
 s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'An artificial answer.'}]}),stream:[]},{surfaceOp:'append'});
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});assert.equal(outputs.length,0);
});

test('replayed, failed, child and synthetic-only turns cannot become user memories',async t=>{
  const ctx=await harness(t);const {TurnCapture}=await import('../lib/memory.js');const outputs=[];
  const capture=new TurnCapture({maxRetainChars:1000,redactSecrets:true});ctx.on('session/event',(s,e)=>{const v=capture.consume(s,e);if(v)outputs.push(v);});
  const original=ctx.sessions.create(SessionId('original'));appendExchange(original,1,'A genuine preference.','Preference recorded.');
  const seed=original.snapshotEvents();const resumed=ctx.sessions.create(SessionId('resumed'),{seed});
  assert.equal(outputs.length,1,'restored history must not be retained again');
  appendExchange(resumed,2,'A new preference.','New preference recorded.');assert.equal(outputs.length,2);
  const s=ctx.sessions.create(SessionId('failed'));s.append('turn/start',{turn:1});
  s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'A secret rejected request.'}]}),{surfaceOp:'append'});
  s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Partial reply'}]}),stream:[],interrupted:true},{surfaceOp:'append'});
  s.append('turn/end',{turn:1,reason:{kind:'aborted'}});assert.equal(outputs.length,2);
  const synthetic=ctx.sessions.create(SessionId('synthetic'));synthetic.append('turn/start',{turn:1});
  synthetic.append('user/message',createUserMessage({source:{kind:'hindsight-memory',form:'snapshot',sections:[]},content:[{type:'text',text:'Old recalled text'}]}),{surfaceOp:'append'});
  synthetic.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Synthetic summary'}]}),stream:[]},{surfaceOp:'append'});
  synthetic.append('turn/end',{turn:1,reason:{kind:'completed'}});assert.equal(outputs.length,2);
});

test('capture excludes plugin context, reasoning, interrupted output and secrets; bounds final retained text',async t=>{
  const ctx=await harness(t);const {TurnCapture}=await import('../lib/memory.js');let captured;
  const capture=new TurnCapture({maxRetainChars:160,redactSecrets:true});ctx.on('session/event',(s,e)=>{captured=capture.consume(s,e)??captured;});
  const s=ctx.sessions.create(SessionId('filtered'));
  s.append('turn/start',{turn:1});
  s.append('user/message',createUserMessage({content:[{type:'text',text:'<system-reminder>CATALOG_PRIVATE</system-reminder>My API key is sk-testSECRET1234567890; use fish.'}],source:{kind:'user'}}),{surfaceOp:'append'});
  s.append('user/message',createUserMessage({content:[{type:'text',text:'INJECTED_DO_NOT_RETAIN'}],source:{kind:'hindsight-memory',form:'snapshot',sections:[]}}),{surfaceOp:'append'});
  s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:'Intermediate commentary'}],source:{kind:'model',provider:'fixture',model:'fixture'}}),stream:[]},{surfaceOp:'append'});
  s.append('assistant/message',{turn:1,step:2,message:createAssistantMessage({content:[{type:'text',text:'Confirmed preference. '+ 'x'.repeat(500)}],source:{kind:'model',provider:'fixture',model:'fixture'}}),stream:[]},{surfaceOp:'append'});
  s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.ok(captured.content.length<=160);assert.match(captured.content,/Confirmed preference/);
  for(const forbidden of ['CATALOG_PRIVATE','INJECTED_DO_NOT_RETAIN','PRIVATE_REASONING','Intermediate commentary','sk-testSECRET'])assert.ok(!captured.content.includes(forbidden),forbidden);
  assert.match(captured.content,/\[REDACTED\]/);
});

test('live session feed captures each completed turn without reading a deprecated session array',async t=>{
  const ctx=await harness(t);let captured;
  const {TurnCapture}=await import('../lib/memory.js').catch(()=>({TurnCapture:undefined}));
  assert.equal(typeof TurnCapture,'function','TurnCapture must exist');
  const capture=new TurnCapture({maxRetainChars:2000,redactSecrets:true});
  ctx.on('session/event',(session,event)=>{const payload=capture.consume(session,event);if(payload)captured=payload;});
  const session=ctx.sessions.create(SessionId('session-a'));
  appendExchange(session,1,'My preferred shell is fish.','I will remember that preference.');
  assert.equal(captured.turn,1);assert.equal(captured.sessionId,'session-a');
  assert.match(captured.content,/User: My preferred shell is fish/);assert.match(captured.content,/Assistant: I will remember/);
});
