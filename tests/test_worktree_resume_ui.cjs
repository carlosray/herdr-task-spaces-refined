const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

test('the worktree picker resumes only this task’s saved creation and still offers a new worktree', () => {
  const source = readFileSync(join(__dirname, '../mods/task-spaces-refined/main.js'), 'utf8')
    .replace(/^import [^\n]*\n/gm, '').replace('export default ', '');
  const machines = () => [{ name: 'ivm', layout: 'ready' }];
  const view = vm.runInNewContext(source + '\nnew TaskSpaces()', {
    View: class {}, shared: () => ({}), spaces: () => [], machines,
  });
  const row = (name, owner) => ({ folder: '/repo/' + name, branch: name + '-idle',
    owner: { task: owner, space: name, launch: { phase: 'creating-checkout' } } });
  Object.assign(view, { step: 'add', machine: 'ivm', assignable: [],
    unavailable: [row('pending', 'task'), row('other', 'different')],
    wizardTask: () => ({ id: 'task' }),
  });
  const [pending, other, create] = view.navigationRows();
  assert.equal(pending.label, 'Resume setup for pending');
  assert.equal(pending.disabled, false);
  assert.equal(other.disabled, true);
  assert.equal(create.disabled, false);
  let command, focus;
  view.mutate = (args, _, done) => {
    command = Array.from(args);
    done({ space: 'pending' });
  };
  view.focusResult = id => { focus = id; };
  pending.open({});
  assert.deepEqual(command, ['resume-worktree', '--space', 'pending']);
  assert.equal(focus, 'pending');
  command = undefined;
  other.open({});
  assert.equal(command, undefined);
});
