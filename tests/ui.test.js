import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import vm from 'node:vm';

const uiFile = new URL('../lib/ui.js', import.meta.url);

// Executes the shipped browser module. Only the Loader / slots / form boundary
// is simulated; this is a unit contract test, not browser or Host integration.
function reactHarness() {
  let cursor = 0;
  const state = [];
  const React = {
    createElement: (type, props, ...children) => ({type, props: props ?? {}, children: children.flat(Infinity)}),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], next => {state[index] = typeof next === 'function' ? next(state[index]) : next;}];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = {current: initial};
      return state[index];
    },
    useSyncExternalStore() {assert.fail('business components may not subscribe to external stores');},
  };
  return {React, render(component, props) {cursor = 0; return component(props);}};
}

function boot(initial = {}) {
  let loaded;
  const registrations = [];
  const renderer = reactHarness();
  let snapshot = {
    status: 'ready', writable: true, mode: 'host', revision: 7,
    value: {apiUrl: 'http://127.0.0.1:8888', apiKey: 'synthetic-secret-never-render', apiKeyEnv: 'HINDSIGHT_API_KEY',
      bankId: 'deepseek-harness', enabled: true, autoRecall: true, autoRetain: true, recallBudget: 'low'},
    ...initial,
  };
  const calls = [];
  let mutate = async () => true;
  const scope = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: (ops, revision) => {calls.push({ops: plain(ops), revision}); return mutate(ops, revision);},
  };
  const context = vm.createContext({window: {__ModuleLoader__: {load: value => { loaded = value; }}}});
  vm.runInContext(existsSync(uiFile) ? readFileSync(uiFile, 'utf8') : '', context, {filename: 'lib/ui.js'});
  assert.ok(loaded, 'the browser script must register its module with ModuleLoader');
  const required = [];
  const plugin = loaded.factory(name => {
    required.push(name);
    assert.equal(name, 'react', 'the browser module must not import Host packages');
    return renderer.React;
  });
  const namespaces = [];
  const injections = [];
  const ctx = {
    configForms: {get: namespace => {namespaces.push(namespace); return scope;}},
    slots: {
      inject: (name, callback) => {injections.push(name); return callback();},
      register: (options, component) => {registrations.push({options, component}); return () => registrations.pop();},
    },
  };
  plugin.apply(ctx);
  const injected = registrations[0].options.inject();
  const props = {
    save: injected.save,
    useForm: select => {assert.equal(typeof select,'function','the real renderer requires an explicit selector');return select(scope.getSnapshot());},
  };
  const render = () => renderer.render(registrations[0].component, props);
  return {loaded, plugin, required, scope, registrations, namespaces, injections, calls, render,
    publish: next => {snapshot = {...snapshot, ...next};},
    respond: handler => {mutate = handler;},
  };
}

const plain = value => JSON.parse(JSON.stringify(value));
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}
function field(app, name) {
  const result = nodes(app.render()).find(node => node.props?.name === name);
  assert.ok(result, `the settings form must expose ${name}`);
  return result;
}
const text = tree => typeof tree === 'string' ? tree : (tree?.children ?? []).map(text).join(' ');
function change(app, name, value) {
  const control = field(app, name);
  assert.equal(typeof control.props.onChange, 'function', `${name} must be editable`);
  control.props.onChange({target: {value, checked: value}});
}
function save(app) {
  const form = nodes(app.render()).find(node => node.type === 'form');
  assert.ok(form, 'the settings must expose a save form');
  return form.props.onSubmit({preventDefault() {}});
}

test('saves edited fields atomically against the draft revision and preserves blank keys', async () => {
  const app = boot();
  change(app, 'apiUrl', 'https://memory.example.invalid');
  change(app, 'bankId', 'hermes-default');
  change(app, 'apiKey', '');
  change(app, 'enabled', false);
  change(app, 'autoRecall', false);
  change(app, 'autoRetain', false);
  change(app, 'recallBudget', 'high');
  app.publish({revision: 9});
  await save(app);
  assert.equal(app.calls.length, 1, 'multi-field edits must be one atomic write');
  assert.equal(app.calls[0].revision, 7, 'snapshot changes cannot silently rebase an existing draft');
  const operations = app.calls[0].ops.sort((a, b) => a.path[0].localeCompare(b.path[0]));
  assert.deepEqual(operations, [
    {op: 'set', path: ['apiUrl'], value: 'https://memory.example.invalid'},
    {op: 'set', path: ['autoRecall'], value: false},
    {op: 'set', path: ['autoRetain'], value: false},
    {op: 'set', path: ['bankId'], value: 'hermes-default'},
    {op: 'set', path: ['enabled'], value: false},
    {op: 'set', path: ['recallBudget'], value: 'high'},
  ]);
});

test('explicit discard recovers from stale revisions without silently rebasing a draft', async () => {
  const app=boot();app.respond(async()=>false);change(app,'bankId','draft-bank');app.publish({revision:9});await save(app);
  button(app,'discard-draft').props.onClick();
  assert.equal(field(app,'bankId').props.value,'deepseek-harness');
  app.respond(async()=>true);change(app,'bankId','fresh-bank');await save(app);
  assert.equal(app.calls.at(-1).revision,9);assert.equal(app.calls.at(-1).ops[0].value,'fresh-bank');
});

test('retains drafts when an atomic mutation returns false', async () => {
  const app = boot();
  app.respond(async () => false);
  change(app, 'bankId', 'hermes-default');
  await save(app);
  assert.equal(field(app, 'bankId').props.value, 'hermes-default');
  const error = nodes(app.render()).find(node => node.props.role === 'alert');
  assert.ok(error, 'refused writes need a visible failure, not a success acknowledgement');
  assert.equal(nodes(app.render()).some(node => node.props.role === 'status' && text(node).includes('已保存')), false);
});

test('contains rejected writes and never displays transport credentials', async () => {
  const app = boot();
  app.respond(async () => {throw new Error('Bearer synthetic-transport-secret');});
  change(app, 'apiKey', 'synthetic-replacement-secret');
  await assert.doesNotReject(() => save(app));
  assert.equal(field(app, 'apiKey').props.value, 'synthetic-replacement-secret');
  assert.equal(text(app.render()).includes('synthetic-transport-secret'), false);
  assert.ok(nodes(app.render()).some(node => node.props.role === 'alert'));
});

test('locks edits and duplicate submissions until an atomic save settles', async () => {
  const app = boot();
  let finish;
  app.respond(() => new Promise(resolve => {finish = resolve;}));
  change(app, 'bankId', 'hermes-default');
  const staleInput = field(app, 'bankId');
  const saving = save(app);
  for (const control of nodes(app.render()).filter(node => ['input', 'select', 'button'].includes(node.type))) {
    assert.equal(control.props.disabled, true, 'every editor action must be disabled while saving');
  }
  staleInput.props.onChange({target: {value: 'must-not-be-edited'}});
  await save(app);
  assert.equal(app.calls.length, 1);
  assert.equal(field(app, 'bankId').props.value, 'hermes-default');
  finish(true);
  await saving;
  assert.equal(field(app, 'bankId').props.disabled, false);
  assert.equal(field(app, 'bankId').props.value, 'deepseek-harness', 'successful saves clear only the committed draft');
});

function button(app, action) {
  const control = nodes(app.render()).find(node => node.props['data-action'] === action);
  assert.ok(control, `missing explicit ${action} action`);
  return control;
}

test('stages explicit secret clearing as an empty override, not inheritance reset', async () => {
  const app = boot({base: {apiKey: 'synthetic-inherited-secret'}});
  change(app, 'apiKey', 'synthetic-new-secret');
  button(app, 'clear-api-key').props.onClick();
  assert.equal(field(app, 'apiKey').props.value, '');
  await save(app);
  assert.deepEqual(app.calls, [{ops: [{op: 'set', path: ['apiKey'], value: ''}], revision: 7}]);
  assert.equal(JSON.stringify(app.render()).includes('synthetic-inherited-secret'), false);
});

test('disables writes when the Host form is not ready or writable', async () => {
  for (const initial of [{status: 'loading'}, {status: 'unavailable'}, {writable: false}, {mode: 'memory'}, {revision: undefined}]) {
    const app = boot(initial);
    assert.equal(field(app, 'bankId').props.disabled, true);
    change(app, 'bankId', 'must-not-be-written');
    await save(app);
    assert.deepEqual(app.calls, [], 'unavailable and read-only states must never mutate');
    assert.ok(nodes(app.render()).some(node => node.props.role === 'status'));
  }
});

test('renders configured fields without echoing the stored password', () => {
  const app = boot();
  assert.equal(field(app, 'apiUrl').props.value, 'http://127.0.0.1:8888');
  assert.equal(field(app, 'apiKey').props.type, 'password');
  assert.equal(field(app, 'apiKey').props.value, '');
  assert.equal(field(app, 'apiKeyEnv').props.value, 'HINDSIGHT_API_KEY');
  assert.equal(field(app, 'bankId').props.value, 'deepseek-harness');
  for (const name of ['enabled', 'autoRecall', 'autoRetain']) {
    assert.equal(field(app, name).props.role, 'switch');
    assert.equal(field(app, name).props.checked, true);
  }
  assert.equal(field(app, 'recallBudget').props.value, 'low');
  assert.ok(text(app.render()).includes('hermes-default'));
  assert.equal(JSON.stringify(app.render()).includes('synthetic-secret-never-render'), false);
});

test('registers a standalone settings.section with framework-owned form hook', () => {
  const app = boot();
  assert.equal(app.loaded.id, 'dsh-hindsight-bridge');
  assert.deepEqual(plain(app.plugin.inject), ['slots', 'configForms']);
  assert.deepEqual(app.required, ['react']);
  assert.deepEqual(app.namespaces, ['hindsight-memory']);
  assert.deepEqual(app.injections, ['settings.section']);
  assert.equal(app.registrations.length, 1);
  const {options, component} = app.registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'hindsight-memory');
  assert.equal(typeof component, 'function');
  const injected = options.inject();
  assert.equal(injected.hooks.form, app.scope);
  assert.equal(typeof injected.save, 'function');
  assert.deepEqual(Object.keys(injected).sort(), ['hooks', 'save']);
});
