const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const base = join(__dirname, '..', 'mods');
const policyKey = 'task-spaces.close-policies';

function element(id) {
  const node = { elementId: id, items: [] };
  const proxy = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'id') return value => { target.elementId = value; return proxy; };
      if (key === 'child') return value => { target.items.push(value); return proxy; };
      if (key === 'children') return values => { target.items.push(...values); return proxy; };
      if (key === 'on_click') return callback => { target.click = callback; return proxy; };
      return () => proxy;
    },
  });
  return proxy;
}

function find(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.items ?? []) {
    const result = find(child, id);
    if (result) return result;
  }
}

function content(node) {
  return typeof node === 'string' ? node : (node?.items ?? []).map(content).join(' ');
}

function harness(given, responses = [], sharedData = {}) {
  const calls = [], pending = [];
  let disposed = false;
  const cx = {
    focus_handle: () => ({ focus() {} }),
    notify() {},
    spawn(callback) {
      pending.push(Promise.resolve().then(() => {
        if (!disposed) return callback(cx);
      }));
    },
  };
  const sandbox = {
    div: element, v_flex: element, h_flex: element, View: class {},
    theme: () => ({}), props: () => given, spaces: () => [], DIRECTORY_TINTS: [],
    InputState: { new: ({ value }) => ({ value: () => value, on() {} }) },
    dialogHeader: title => element().child(title),
    dialogInput: (state, id) => element(id).child(state.value()),
    trackInputFocus() {},
    button: (id, title, onClick) => element(id).child(title).on_click(onClick),
    shared: key => sharedData[key],
    setShared: (key, value) => { sharedData[key] = value; },
    closeOverlay: id => { calls.push(['close', id]); disposed = true; },
    openOverlay: spec => calls.push(['open', spec]),
    exec: async (name, args, opts) => {
      calls.push(['exec', name, Array.from(args), opts.on]);
      const data = responses.shift();
      if (data instanceof Error) throw data;
      return data;
    },
  };
  vm.createContext(sandbox);
  for (const path of ['better-sidebar-refined/views/space-menu.js', 'worktree-close-refined/main.js']) {
    const source = readFileSync(join(base, path), 'utf8')
      .replace(/^import [^\n]*\n/gm, '').replace(/^export (?:default )?/gm, '');
    vm.runInContext(source, sandbox);
  }
  return {
    cx, calls, sharedData,
    create: name => vm.runInContext('new ' + name + '()', sandbox),
    settle: () => Promise.all(pending),
  };
}

test('the directory menu opens settings before its short-lived view is closed', async () => {
  const h = harness({ folder: '/repos/foo', name: 'foo', machine: 'ivm', overlay: 'menu' });
  const menu = h.create('DirectoryMenu');
  menu.init();
  find(menu.render(), 'directory-close-settings').click({}, h.cx);
  await h.settle();
  assert.deepEqual(h.calls.map(([action]) => action), ['open', 'close']);
  assert.equal(h.calls[0][1].mod, 'worktree-close-refined');
  assert.equal(h.calls[0][1].props.folder, '/repos/foo');
  assert.equal(h.calls[0][1].props.machine, 'ivm');
});

test('the settings view resolves the repository on its own host and loads the canonical policy', async () => {
  const key = JSON.stringify(['ivm', '/repos/foo/.git']);
  const h = harness({ mode: 'settings', folder: '/alias', machine: 'ivm', overlay: 'settings' },
    [{ code: 0, stdout: JSON.stringify({ repo: '/repos/foo/.git', folder: '/repos/foo' }) }],
    { [policyKey]: { [key]: { enabled: true, branch: 'pool-idle', command: 'git branch-idle' } } });
  const view = h.create('WorktreeClose');
  view.init({}, h.cx);
  assert.match(content(view.render()), /Checking repository/);
  assert.equal(find(view.render(), 'save'), undefined);
  await h.settle();
  assert.deepEqual(h.calls, [['exec', 'herdr-task', ['resolve-directory', '--folder', '/alias'], 'ivm']]);
  assert.match(content(view.render()), /Return options enabled.*pool-idle.*git branch-idle/);
  assert.ok(find(view.render(), 'save'));
});

test('an unavailable host shows a retry and a plain directory never gets a Save action', async () => {
  const h = harness({ mode: 'settings', folder: '/notes', machine: 'ivm' },
    [Error('IVM offline'), { code: 0, stdout: JSON.stringify({ repo: null, folder: '/notes' }) }]);
  const view = h.create('WorktreeClose');
  view.init({}, h.cx);
  await h.settle();
  assert.match(content(view.render()), /IVM offline/);
  assert.equal(find(view.render(), 'save'), undefined);
  find(view.render(), 'retry-settings').click(h.cx);
  await h.settle();
  assert.match(content(view.render()), /not a Git repository/);
  assert.equal(find(view.render(), 'save'), undefined);
  assert.equal(h.sharedData[policyKey], undefined);
});
