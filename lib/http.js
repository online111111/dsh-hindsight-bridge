export class HindsightError extends Error {
  constructor(code, httpStatus) {
    super(httpStatus === undefined ? `Hindsight ${code}` : `Hindsight HTTP ${httpStatus} (${code})`);
    this.name = 'HindsightError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

function validateUrl(apiUrl) {
  let url;
  try {
    if (typeof apiUrl !== 'string') throw new Error();
    url = new URL(apiUrl);
  } catch {
    throw new HindsightError('CONFIG');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || apiUrl.includes('?') || apiUrl.includes('#') ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new HindsightError('CONFIG');
  }
  return url.href.replace(/\/+$/, '');
}

export class HindsightClient {
  constructor(config) {
    const {timeoutMs=8000,maxResponseBytes=1048576,bankId,apiKey}=config ?? {};
    const apiUrl=validateUrl(config?.apiUrl);
    if (typeof bankId !== 'string' || !bankId.trim() ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
        (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)))) {
      throw new HindsightError('CONFIG');
    }
    this.config=Object.freeze({apiUrl,apiKey,bankId,timeoutMs,maxResponseBytes});
  }
  async request(path,body,{signal,method='POST'}={}) {
    const {apiUrl,apiKey,timeoutMs,maxResponseBytes}=this.config;
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\s]/.test(path) ||
        !['GET','POST'].includes(method) || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new HindsightError('CONFIG');
    }
    if (signal?.aborted) throw new HindsightError('ABORTED');
    let requestBody;
    try { requestBody=method==='GET'?undefined:JSON.stringify(body); }
    catch { throw new HindsightError('CONFIG'); }
    const controller=new AbortController();
    let abortCode;
    const abort=code=>{
      if (controller.signal.aborted) return;
      abortCode=code;
      controller.abort();
    };
    const onCallerAbort=()=>abort('ABORTED');
    signal?.addEventListener('abort',onCallerAbort,{once:true});
    const timer=setTimeout(()=>abort('TIMEOUT'),timeoutMs);
    let response;
    try {
      response=await fetch(apiUrl+path,{
        method,headers:{'content-type':'application/json',...(apiKey?{authorization:`Bearer ${apiKey}`}:{})},
        body:requestBody,signal:controller.signal,redirect:'manual',
      });
      const chunks=[];
      let size=0;
      const reader=response.body?.getReader();
      try {
        if (reader) {
          while (true) {
            const {done,value}=await reader.read();
            if (done) break;
            size+=value.byteLength;
            if (size>maxResponseBytes) {
              await reader.cancel();
              throw new HindsightError('RESPONSE_TOO_LARGE',response.status);
            }
            chunks.push(value);
          }
        }
      } finally { reader?.releaseLock(); }
      if(!response.ok) {
        throw new HindsightError(response.status>=300&&response.status<400?'REDIRECT':'HTTP',response.status);
      }
      let result;
      try { result=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HindsightError('INVALID_RESPONSE',response.status); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new HindsightError('INVALID_RESPONSE',response.status);
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new HindsightError(abortCode,response?.status);
      if (error instanceof HindsightError) throw error;
      throw new HindsightError('NETWORK',response?.status);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',onCallerAbort);
    }
  }
  recall(body,options) { return this.request(`/v1/default/banks/${encodeURIComponent(this.config.bankId)}/memories/recall`,body,options); }
  retain(body,options) { return this.request(`/v1/default/banks/${encodeURIComponent(this.config.bankId)}/memories`,body,options); }
  operation(id,{signal}={}) { return this.request(`/v1/default/banks/${encodeURIComponent(this.config.bankId)}/operations/${encodeURIComponent(id)}`,undefined,{signal,method:'GET'}); }
  health({signal}={}) { return this.request('/health',undefined,{signal,method:'GET'}); }
}
