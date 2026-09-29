// Functional test for the User Approvals "Set Role" (Owner / HR) helpers.
//
// The superadmin assigns each user one of two roles. HR and Owner use the
// SAME dashboard; the only differences are the profile label and chat
// access (HR has it, owner does not). These helpers normalise/clamp what
// the dropdown can write, so a tampered DOM value can never grant a
// privileged role such as 'superadmin'.
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const start = src.indexOf('const ASSIGNABLE_ROLES');
assert(start > -1, 'ASSIGNABLE_ROLES not found in script.js');
const blockStart = src.lastIndexOf('// ====', start);
const end = src.indexOf('function toggleUserDetails', start);
assert(end > blockStart, 'end of the role-assignable block not found in script.js');
const blockSrc = src.slice(blockStart, end);

console.log('Testing "Set Role" (Owner / HR) assignment...');

const sandbox = { console, window: {} };
vm.createContext(sandbox);
vm.runInContext(blockSrc, sandbox);

const { ASSIGNABLE_ROLES, currentUserRoleLabel, roleHintHtml, clampRoleSelection } =
    sandbox.window.__setRoleInternals;
assert(ASSIGNABLE_ROLES, 'the role helpers were not exposed on window.__setRoleInternals');

// 1. Exactly the two assignable roles exist.
assert.strictEqual(
    ASSIGNABLE_ROLES.slice().sort().join(','),
    'hr,owner',
    'ASSIGNABLE_ROLES must be exactly owner + hr'
);
assert.strictEqual(ASSIGNABLE_ROLES.indexOf('superadmin'), -1, 'superadmin must not be assignable');
assert.strictEqual(ASSIGNABLE_ROLES.indexOf('operator'), -1, 'operator must not be assignable');

// 2. Normal roles round-trip, case- and whitespace-insensitively.
assert.strictEqual(currentUserRoleLabel({ role: 'owner' }), 'owner', 'owner must be preserved');
assert.strictEqual(currentUserRoleLabel({ role: 'hr' }), 'hr', 'hr must be preserved');
assert.strictEqual(currentUserRoleLabel({ role: 'HR' }), 'hr', 'uppercase HR must normalise');
assert.strictEqual(currentUserRoleLabel({ role: '  Owner ' }), 'owner', 'padded owner must normalise');

// 3. Anything unknown falls back to 'owner' — the safe default (no chat).
['superadmin', 'admin', 'operator', 'viewer', '', null, undefined, 'hr-admin', 'the-hr']
    .forEach((role) => {
        assert.strictEqual(
            currentUserRoleLabel({ role: role }),
            'owner',
            `role ${JSON.stringify(role)} must fall back to owner`
        );
    });
assert.strictEqual(currentUserRoleLabel({}), 'owner', 'a user doc with no role must default to owner');
assert.strictEqual(currentUserRoleLabel(null), 'owner', 'a null user must default to owner');

// 4. The hint text must describe the REAL consequence of each role, so the
//    superadmin is not surprised by chat appearing/disappearing.
const ownerHint = roleHintHtml({ role: 'owner' });
const hrHint = roleHintHtml({ role: 'hr' });
assert.notStrictEqual(ownerHint, hrHint, 'the two roles must have different hints');
assert(/no chat access/i.test(ownerHint), 'the owner hint must say there is no chat access');
assert(/chat/i.test(hrHint), 'the HR hint must mention chat');
assert(/branches/i.test(hrHint), 'the HR hint must mention branches');

// 5. The dropdown value written by getUserDetailData() must be clamped the
//    same way, so a hand-edited <select> cannot inject 'superadmin'.
assert.strictEqual(clampRoleSelection('hr'), 'hr', 'a real HR selection must pass through');
assert.strictEqual(clampRoleSelection('owner'), 'owner', 'a real owner selection must pass through');
assert.strictEqual(clampRoleSelection('superadmin'), 'owner', 'a tampered superadmin value must be clamped');
assert.strictEqual(clampRoleSelection('operator'), 'owner', 'a tampered operator value must be clamped');
assert.strictEqual(clampRoleSelection(null), 'owner', 'a missing selection must default to owner');

console.log('✅ Set Role tests passed (owner + hr only; unknown/privileged roles clamped).');
