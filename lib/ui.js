window.__ModuleLoader__.load({
  id: 'dsh-hindsight-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const defaults = {apiUrl: 'http://127.0.0.1:8888', apiKeyEnv: 'HINDSIGHT_API_KEY', bankId: 'deepseek-harness',
      enabled: true, autoRecall: true, autoRetain: true, recallBudget: 'low'};
    function HindsightSettings(props) {
      const snapshot = props.useForm(value => value);
      const [draft, setDraft] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const inFlight = React.useRef(false);
      const writable = snapshot.status === 'ready' && snapshot.writable !== false && snapshot.mode !== 'memory' && snapshot.revision !== undefined;
      const blocked = saving || !writable;
      const value = {...defaults, ...snapshot.value, ...draft?.fields};
      const edit = (name, next) => {
        if (inFlight.current || !writable) return;
        setMessage(null);
        setDraft(previous => {
          const fields = {...previous?.fields};
          if (name === 'apiKey' && next === '') delete fields.apiKey;
          else fields[name] = next;
          return {fields, revision: previous?.revision ?? snapshot.revision};
        });
      };
      const clearKey = () => {
        if (inFlight.current || !writable) return;
        setMessage(null);
        setDraft(previous => ({fields: {...previous?.fields, apiKey: ''}, revision: previous?.revision ?? snapshot.revision}));
      };
      const submit = async event => {
        event.preventDefault();
        if (inFlight.current || !writable || !draft || !Object.keys(draft.fields).length) return;
        inFlight.current = true;
        setSaving(true);
        setMessage(null);
        const ops = Object.entries(draft.fields).map(([name, next]) => ({op: 'set', path: [name], value: next}));
        try {
          if (await props.save(ops, draft.revision)) setDraft(null);
          else setMessage({error: true, text: '保存未完成，配置可能已更新。草稿已保留，请重新检查。'});
        } catch {
          setMessage({error: true, text: '保存失败。草稿已保留，请检查连接后重试。'});
        } finally {
          inFlight.current = false;
          setSaving(false);
        }
      };
      const input = (name, label, placeholder, secret = false) => h('label', {key: name}, label,
        h('input', {name, type: secret ? 'password' : 'text', value: secret ? draft?.fields.apiKey ?? '' : value[name],
          placeholder, disabled: blocked, onChange: event => edit(name, event.target.value)}));
      const toggle = (name, label) => h('label', {key: name}, label,
        h('input', {name, type: 'checkbox', role: 'switch', checked: value[name], 'aria-label': label, disabled: blocked,
          onChange: event => edit(name, event.target.checked)}));
      return h('form', {className: 'hindsight-settings', onSubmit: submit},
        h('header', {}, h('h2', {}, 'Hindsight 记忆'), h('p', {}, '跨会话记忆 · 安全保存配置')),
        input('apiUrl', 'API 地址', defaults.apiUrl),
        input('apiKey', 'API 密钥', '留空保留现有密钥', true),
        h('button', {type: 'button', 'data-action': 'clear-api-key', disabled: blocked, onClick: clearKey}, '清空已保存密钥'),
        h('p', {}, draft?.fields.apiKey === '' ? '将清空直接配置的密钥；环境变量仍可能提供认证。' : '密钥不会回显；空输入保留旧密钥。'),
        input('apiKeyEnv', '密钥环境变量', defaults.apiKeyEnv),
        input('bankId', '记忆库 ID', defaults.bankId),
        h('p', {}, '默认 deepseek-harness；选择 hermes-default 可与 Hermes 共享记忆。'),
        toggle('enabled', '启用记忆'), toggle('autoRecall', '自动召回'), toggle('autoRetain', '自动保存'),
        h('label', {}, '召回预算', h('select', {name: 'recallBudget', value: value.recallBudget, disabled: blocked,
          onChange: event => edit('recallBudget', event.target.value)},
          ['low', 'mid', 'high'].map(budget => h('option', {key: budget, value: budget}, budget)))),
        h('button', {type: 'submit', disabled: blocked}, saving ? '保存中…' : '保存配置'),
        draft && h('button', {type: 'button', 'data-action': 'discard-draft', disabled: saving,
          onClick: () => {if (!inFlight.current) {setDraft(null);setMessage(null);}}}, '放弃草稿，加载当前配置'),
        !writable && h('p', {role: 'status'}, '配置尚未加载或当前为只读，暂时不能保存。'),
        message && h('p', {role: message.error ? 'alert' : 'status'}, message.text),
      );
    }
    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const scope = ctx.configForms.get('hindsight-memory');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'hindsight-memory', order: 55,
          label: 'Hindsight 记忆',
          inject: () => ({hooks: {form: scope}, save: (ops, revision) => scope.mutate(ops, revision)}),
        }, HindsightSettings));
      },
    };
  },
});
