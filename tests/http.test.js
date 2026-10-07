import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {HindsightClient} from '../lib/http.js';

function classified(error, code, httpStatus) {
  assert.equal(error.name,'HindsightError');
  assert.equal(error.code,code);
  assert.equal(error.httpStatus,httpStatus);
  return true;
}

async function server(t, handler) {
  const s=createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  return `http://127.0.0.1:${s.address().port}`;
}

test('HTTP client refuses every redirect without sending any request to its destination',async t=>{
  const {HindsightClient}=await import('../lib/http.js');let leaks=0;
  const target=await server(t,(_req,res)=>{leaks++;res.end('{}');});
  for(const status of [301,302,303,307,308]) {
    let requestCount=0;
    const base=await server(t,(req,res)=>{requestCount++;res.writeHead(status,{location:target+'/stolen'});res.end();});
    const client=new HindsightClient({apiUrl:base,apiKey:'synthetic-key',bankId:'bank',timeoutMs:500});
    await assert.rejects(()=>client.recall({query:'x'}),/HTTP 30/);
    assert.equal(requestCount,1);assert.equal(leaks,0,'redirect destination must receive zero requests');
  }
  let sameOriginFollowed=0;
  const base=await server(t,(req,res)=>{
    if(req.url==='/stolen') {sameOriginFollowed++;res.end('{}');return;}
    res.writeHead(307,{location:'/stolen'});res.end();
  });
  await assert.rejects(()=>new HindsightClient({apiUrl:base,bankId:'bank'}).recall({query:'x'}),/HTTP 307/);
  assert.equal(sameOriginFollowed,0);
});

test('HTTP client authenticates recall and encodes the bank as one path component',async t=>{
  let seen;
  const base=await server(t,(req,res)=>{
    seen={url:req.url,auth:req.headers.authorization};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[{text:'Known preference'}]}));
  });
  const {HindsightClient}=await import('../lib/http.js').catch(()=>({HindsightClient:undefined}));
  assert.equal(typeof HindsightClient,'function','HindsightClient must exist');
  const client=new HindsightClient({apiUrl:base,apiKey:'synthetic-key',bankId:'team/a',timeoutMs:500});
  const response=await client.recall({query:'preference',budget:'low',max_tokens:400});
  assert.equal(response.results[0].text,'Known preference');
  assert.deepEqual(seen,{url:'/v1/default/banks/team%2Fa/memories/recall',auth:'Bearer synthetic-key'});
});

test('HTTP client rejects unsafe base URLs before any authenticated request',async t=>{
  let requests=0;
  const base=await server(t,(_req,res)=>{requests++;res.end('{}');});
  const unsafe=[undefined,'not a URL','file:///tmp/synthetic-key','ftp://localhost',
    'http://example.com','http://127.0.0.2','http://localhost.evil.example',
    base.replace('://','://synthetic-key:password@'),`${base}?query=synthetic-key`,
    `${base}#synthetic-key`,`${base}?`,`${base}#`];
  for(const apiUrl of unsafe) {
    assert.throws(()=>new HindsightClient({apiUrl,apiKey:'synthetic-key',bankId:'bank'}),error=>{
      classified(error,'CONFIG');
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/synthetic-key|password|example\.com|file:\/\/\/tmp\/|query=/);
      return true;
    });
  }
  assert.equal(requests,0);
});

test('HTTP client validates bank and finite limits and applies safe defaults',async t=>{
  const base=await server(t,(_req,res)=>res.end('{}'));
  const valid={apiUrl:base,bankId:'bank'};
  const invalid=[...['', ' ', null, undefined, 1].map(bankId=>({bankId})),
    ...[0,-1,Infinity,NaN,'500',1.5,2147483648].map(timeoutMs=>({timeoutMs})),
    ...[0,-1,Infinity,NaN,'100',1.5,Number.MAX_SAFE_INTEGER+1].map(maxResponseBytes=>({maxResponseBytes})),
    {apiKey:'synthetic-key\r\nInjected: value'},{apiKey:42}];
  for(const override of invalid) {
    assert.throws(()=>new HindsightClient({...valid,...override}),error=>classified(error,'CONFIG'));
  }
  const client=new HindsightClient(valid);
  assert.equal(client.config.timeoutMs,8000);
  assert.equal(client.config.maxResponseBytes,1048576);
  for(const apiUrl of ['https://example.com/base/','http://localhost:8000','http://[::1]:8000']) {
    assert.doesNotThrow(()=>new HindsightClient({...valid,apiUrl}));
  }
});

test('HTTP client classifies redirection and status failures without exposing service content',async t=>{
  for(const status of [301,302,303,307,308,401,429,500]) {
    const base=await server(t,(_req,res)=>{
      res.writeHead(status,{location:'/stolen?synthetic-key'});
      res.end('synthetic-key response-body query-private http://secret.example');
    });
    const client=new HindsightClient({apiUrl:base,apiKey:'synthetic-key',bankId:'bank'});
    await assert.rejects(()=>client.recall({query:'query-private'}),error=>{
      classified(error,status<400?'REDIRECT':'HTTP',status);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/synthetic-key|response-body|query-private|secret\.example|stolen/);
      assert.equal(error.cause,undefined);
      return true;
    });
  }
});

test('HTTP client counts actual UTF-8 response bytes for successes and error statuses',async t=>{
  const payload=JSON.stringify({value:'界'.repeat(40)});
  assert.ok(payload.length<100);
  assert.ok(Buffer.byteLength(payload)>100);
  for(const status of [200,302,503]) {
    const base=await server(t,(_req,res)=>{res.writeHead(status);res.write(payload.slice(0,12));res.end(payload.slice(12));});
    const client=new HindsightClient({apiUrl:base,bankId:'bank',maxResponseBytes:100});
    await assert.rejects(()=>client.recall({query:'x'}),error=>classified(error,'RESPONSE_TOO_LARGE',status));
  }
  const exactBase=await server(t,(_req,res)=>res.end('{}'));
  assert.deepEqual(await new HindsightClient({apiUrl:exactBase,bankId:'bank',maxResponseBytes:2}).recall({}),{});
});

test('HTTP client has one deadline across headers and streamed body even for error statuses',async t=>{
  for(const phase of ['headers','body','error-body']) {
    let closed;
    const connectionClosed=new Promise(resolve=>{closed=resolve;});
    const base=await server(t,(_req,res)=>{
      res.on('close',closed);
      if(phase==='headers') return;
      res.writeHead(phase==='error-body'?503:200);
      res.write('{"value":"');
      const interval=setInterval(()=>res.write('x'),25);
      res.on('close',()=>clearInterval(interval));
    });
    const client=new HindsightClient({apiUrl:base,bankId:'bank',timeoutMs:200});
    const started=performance.now();
    await assert.rejects(()=>client.recall({query:'private-query'}),error=>classified(error,'TIMEOUT',phase==='headers'?undefined:phase==='body'?200:503));
    assert.ok(performance.now()-started<1500,'continuous chunks must not renew the deadline');
    await connectionClosed;
  }
});

test('HTTP client honors caller cancellation before dispatch and throughout streamed responses',async t=>{
  let requests=0;
  const noSend=await server(t,(_req,res)=>{requests++;res.end('{}');});
  const preaborted=new AbortController();
  preaborted.abort(new Error('synthetic-key private-reason'));
  const client=new HindsightClient({apiUrl:noSend,bankId:'bank',timeoutMs:500});
  await assert.rejects(()=>client.recall({query:'x'},{signal:preaborted.signal}),error=>{
    classified(error,'ABORTED');
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/synthetic-key|private-reason/);
    return true;
  });
  assert.equal(requests,0);
  for(const phase of ['headers','body']) {
    const caller=new AbortController();
    let started,closed;
    const received=new Promise(resolve=>{started=resolve;});
    const disconnected=new Promise(resolve=>{closed=resolve;});
    const base=await server(t,(_req,res)=>{
      res.on('close',closed);
      if(phase==='body') {res.writeHead(200);res.write('{');}
      started();
    });
    const client=new HindsightClient({apiUrl:base,bankId:'bank',timeoutMs:1000});
    const pending=client.request('/abort',{query:'x'},{signal:caller.signal});
    const rejected=assert.rejects(pending,error=>classified(error,'ABORTED',phase==='body'?200:undefined));
    await received;
    if(phase==='body') await new Promise(resolve=>setTimeout(resolve,40));
    caller.abort(new Error('synthetic-key'));
    await rejected;
    await disconnected;
  }
});

test('HTTP client redacts network failures and never retries a failed POST',async t=>{
  for(const phase of ['connection','body']) {
    let requests=0;
    const base=await server(t,(req,res)=>{
      requests++;
      if(phase==='connection') {req.socket.destroy();return;}
      res.writeHead(200);res.write('{"synthetic-key":"');
      setTimeout(()=>res.destroy(new Error('synthetic-key private-query')),30);
    });
    const client=new HindsightClient({apiUrl:base,apiKey:'synthetic-key',bankId:'bank'});
    await assert.rejects(()=>client.retain({text:'private-query'}),error=>{
      classified(error,'NETWORK',phase==='body'?200:undefined);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/synthetic-key|private-query|127\.0\.0\.1/);
      assert.equal(error.cause,undefined);
      return true;
    });
    assert.equal(requests,1);
  }
});

test('HTTP health and operation methods are authenticated read-only GETs with encoded components',async t=>{
  const seen=[];
  const base=await server(t,async(req,res)=>{
    let body='';
    for await(const chunk of req) body+=chunk;
    seen.push({method:req.method,url:req.url,auth:req.headers.authorization,body});
    res.end(JSON.stringify({status:'ok'}));
  });
  const client=new HindsightClient({apiUrl:`${base}/proxy///`,apiKey:'synthetic-key',bankId:'team/a'});
  assert.deepEqual(await client.health(),{status:'ok'});
  assert.deepEqual(await client.operation('task/a ?#'),{status:'ok'});
  assert.deepEqual(await client.request('/health',undefined,{method:'GET'}),{status:'ok'});
  assert.deepEqual(seen,[
    {method:'GET',url:'/proxy/health',auth:'Bearer synthetic-key',body:''},
    {method:'GET',url:'/proxy/v1/default/banks/team%2Fa/operations/task%2Fa%20%3F%23',auth:'Bearer synthetic-key',body:''},
    {method:'GET',url:'/proxy/health',auth:'Bearer synthetic-key',body:''},
  ]);
});

test('HTTP client rejects unsafe request options without sending credentials',async t=>{
  let requests=0;
  const base=await server(t,(_req,res)=>{requests++;res.end('{}');});
  const client=new HindsightClient({apiUrl:base,bankId:'bank',apiKey:'synthetic-key'});
  for(const path of ['https://secret.example','//secret.example','/x?synthetic-key','/x#synthetic-key','/x\\secret',undefined]) {
    await assert.rejects(()=>client.request(path,{}),error=>classified(error,'CONFIG'));
  }
  for(const method of ['DELETE','CONNECT','get']) {
    await assert.rejects(()=>client.request('/health',undefined,{method}),error=>classified(error,'CONFIG'));
  }
  await assert.rejects(()=>client.request('/health',undefined,{method:'GET',signal:{}}),error=>classified(error,'CONFIG'));
  const cyclic={};cyclic.self=cyclic;
  await assert.rejects(()=>client.request('/retain',cyclic),error=>classified(error,'CONFIG'));
  assert.equal(requests,0);
});

test('HTTP client requires a JSON object and redacts invalid-response parser errors',async t=>{
  for(const payload of ['null','[]','1','true','"synthetic-key"','{synthetic-key private-query','']) {
    const base=await server(t,(_req,res)=>res.end(payload));
    const client=new HindsightClient({apiUrl:base,apiKey:'synthetic-key',bankId:'bank'});
    await assert.rejects(()=>client.recall({query:'private-query'}),error=>{
      classified(error,'INVALID_RESPONSE',200);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/synthetic-key|private-query/);
      assert.equal(error.cause,undefined);
      return true;
    });
  }
});
