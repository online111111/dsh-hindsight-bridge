export function textOf(message) {
  return (message?.content??[]).filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
}

export function cleanText(text,redact=true) {
  let value=String(text??'').replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/gi,'');
  if(redact) value=value
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g,'[REDACTED]')
    .replace(/\b(?:sk-|HsApi_|HsUi_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g,'[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[REDACTED]@');
  return value.trim();
}

export class TurnCapture {
  constructor(config) {this.config=config;this.states=new WeakMap();}
  consume(session,event) {
    if(event.seq<session.firstLiveSeq) return;
    if(event.type==='turn/start') {this.states.set(session,{turn:event.data.turn,user:'',assistant:''});return;}
    const state=this.states.get(session);if(!state)return;
    const cap=this.config.maxRetainChars??16000;
    if(event.surfaceOp&&event.surfaceOp!=='append')return;
    if(event.type==='user/message'&&event.data.source?.kind==='user') {
      const text=cleanText(textOf(event.data),this.config.redactSecrets!==false);if(text)state.user=(state.user?state.user+'\n'+text:text).slice(0,cap);
    }
    if(event.type==='assistant/message'&&!event.data.interrupted) {
      state.assistant=cleanText(textOf(event.data.message),this.config.redactSecrets!==false).slice(0,cap);
    }
    if(event.type==='turn/end') {
      this.states.delete(session);
      if(event.data.turn!==state.turn||event.data.reason?.kind!=='completed'||!state.user||!state.assistant)return;
      const labelChars='User: \n\nAssistant: '.length;
      const userCap=Math.max(1,Math.floor((cap-labelChars)/2));
      const user=state.user.slice(0,userCap);
      const assistant=state.assistant.slice(0,Math.max(0,cap-labelChars-user.length));
      return {sessionId:session.id,turn:state.turn,time:event.time,content:`User: ${user}\n\nAssistant: ${assistant}`};
    }
  }
}
