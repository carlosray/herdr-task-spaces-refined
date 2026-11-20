const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const checkout = { id: 'ivm/checkout', name: 'nebo3' };
const other = { id: 'checkout', name: 'nebo3' };
const gitlab = 'https://gitlab.com/demo/orbit/-/merge_requests/';
const github = 'https://github.com/demo/orbit/pull/';
const badgeCounts = { open: 1, closed: 1, merged: 1 };

function element() {
  const handlers = {};
  const node = new Proxy({ handlers }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'when') return (condition, apply) => condition ? (apply(node) ?? node) : node;
      if (prop === 'on_click') return callback => { handlers.click = callback; return node; };
      if (prop === 'on_mouse_down' || prop === 'on_mouse_up') {
        return (_button, callback) => { handlers[prop] = callback; return node; };
      }
      if (prop === 'tooltip') return value => { target.hint = value; return node; };
      return () => node;
    },
  });
  return node;
}

function renderBadge(platform = 'macos') {
  const actions = [], urls = [];
  let stopped = 0;
  const requests = [
    { provider: 'gitlab', url: gitlab + '42', state: 'OPEN', spaces: [checkout, other] },
    { provider: 'github', url: github + '12', state: 'MERGED', spaces: [checkout] },
    { provider: 'gitlab', url: gitlab + '41', state: 'CLOSED', spaces: [checkout] },
    { provider: 'gitlab', url: gitlab + '42', state: 'OPEN', spaces: [checkout] },
    { provider: 'gitlab', url: gitlab + '55', state: 'OPEN', spaces: [other] },
    { provider: 'gitlab', url: 'file:///private/log', state: 'OPEN', spaces: [checkout] },
  ];
  const state = vm.createContext({
    div: element, svg: element,
    window: () => ({ platform }),
    shared: key => key === 'better-sidebar.merge-requests' ? { requests } : undefined,
    setShared: (key, value) => actions.push(['filter', key, value]),
    run: name => actions.push(['command', name]),
  });
  for (const path of ['git/requests-index.js', 'views/ui.js', 'views/spaces.js']) {
    const base = join(__dirname, '..', 'mods', 'better-sidebar-refined');
    const code = readFileSync(join(base, path), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '').replace(/^export (?:default )?/gm, '');
    vm.runInContext(code, state);
  }
  const badge = vm.runInContext('new Spaces()', state).requestBadge(checkout, badgeCounts, {});
  const cx = {
    stop_propagation() { stopped++; },
    open_url(url) { urls.push(url); },
  };
  return {
    actions, urls, badge,
    click(modifiers) {
      const event = { modifiers };
      for (const type of ['on_mouse_down', 'on_mouse_up', 'click']) badge.handlers[type](event, cx);
      assert.equal(stopped, 3);
    },
  };
}

test('Command-click opens every distinct valid URL assigned to the exact worktree', () => {
  const ui = renderBadge();
  ui.click({ platform: true });
  assert.deepEqual(ui.urls, [gitlab + '42', github + '12', gitlab + '41']);
  assert.deepEqual(ui.actions, []);
  assert.match(ui.badge.hint, /Cmd-click to open all in browser/);
});

test('ordinary click keeps the Space filter and the MRs panel action', () => {
  const ui = renderBadge();
  ui.click({});
  assert.deepEqual(ui.urls, []);
  assert.deepEqual(ui.actions, [
    ['filter', 'better-sidebar.merge-request-space', checkout.id],
    ['command', 'layout.select'],
    ['command', 'layout.show'],
  ]);
});

test('non-Mac modified links use the existing Control-click convention', () => {
  const ui = renderBadge('linux');
  ui.click({ control: true });
  assert.equal(ui.urls.length, 3);
  assert.deepEqual(ui.actions, []);
});
