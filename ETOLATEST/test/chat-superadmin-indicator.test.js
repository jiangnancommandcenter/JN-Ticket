// The Super Admin indicator (blue avatar + gold rank ring) in the Area Manager
// and RM/SM chat lists — the same indicator HR already shows.
//
// HR knows a Super Admin's role from its `users` roster. Store roles have no
// roster (and, deliberately, no `users` read at all — test/chat-rules.test.js
// pins that), so their only source is the self-published directory. The fix:
//   1. syncMyDirectoryRole(): a Super Admin stamps role:'superadmin' on their
//      OWN directory entry on every mount when missing/wrong; an account whose
//      entry still says superadmin but no longer is one corrects it; nobody
//      else writes. Only { email, role } (inside the deployed allowlist).
//   2. init() calls it; firestore.rules gains NO store-role users read.
//   3. personProfileFor() then resolves the role from the directory.
//   4. an EXISTING store-role <-> Super Admin thread stays listed (now blue)
//      instead of vanishing once the role is known; no new row is offered.
//
// Run: node test/chat-superadmin-indicator.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const rules = read('firestore.rules');
const chat = read('js/chat.js');

console.log('Testing the Super Admin indicator for Area Manager / RM-SM...');

const grab = (name) => {
    const m = chat.match(new RegExp('    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}'));
    assert(m, name + '() not found in js/chat.js');
    return m[0];
};

// ---------- rules unchanged ----------
const usersBlock = rules.slice(rules.indexOf('match /users/'));
assert(!/allow read: if isAreaManager\(\)/.test(usersBlock), 'store roles still read NO account docs');
console.log('  PASS  rules: no new users read for store roles');

// ---------- syncMyDirectoryRole (functional) ----------
const syncSrc = grab('syncMyDirectoryRole');
assert(/syncMyDirectoryRole\(\);/.test(grab('init')), 'init() must sync the directory role on every mount');

function runSync(role, existing) {
    const writes = [];
    const sb = {
        console: { warn() {} },
        currentUserEmail: 'boss@x.com',
        currentRole: role,
        normalizeRole: (r) => String(r || '').trim().toLowerCase(),
        db: { collection() {} },
        myDirectoryRef() {
            return {
                get: () => Promise.resolve({ exists: !!existing, data: () => existing }),
                set: (data, opts) => { writes.push([data, opts]); return Promise.resolve(); }
            };
        }
    };
    vm.createContext(sb);
    vm.runInContext(syncSrc + '\nthis.run = syncMyDirectoryRole;', sb);
    sb.run();
    // JSON round-trip: objects built inside the vm realm fail cross-realm deepStrictEqual.
    return new Promise((r) => setTimeout(() => r(JSON.parse(JSON.stringify(writes))), 10));
}

(async () => {
    let w = await runSync('superadmin', null);
    assert.deepStrictEqual(w, [[{ email: 'boss@x.com', role: 'superadmin' }, { merge: true }]],
        'a Super Admin with no entry publishes { email, role } (merge, inside the allowlist)');
    w = await runSync('superadmin', { email: 'boss@x.com', role: '', displayName: 'Boss' });
    assert.strictEqual(w.length, 1, 'a role-less entry is fixed');
    w = await runSync('superadmin', { email: 'boss@x.com', role: 'superadmin' });
    assert.strictEqual(w.length, 0, 'an already-correct entry is not rewritten');
    w = await runSync('owner', { email: 'boss@x.com', role: 'superadmin' });
    assert.deepStrictEqual(w[0] && w[0][0], { email: 'boss@x.com', role: 'owner' },
        'an ex-Super Admin corrects the stale badge');
    w = await runSync('hr', null);
    assert.strictEqual(w.length, 0, 'other roles publish nothing (no list changes elsewhere)');
    w = await runSync('owner', { email: 'boss@x.com', role: 'owner' });
    assert.strictEqual(w.length, 0, 'a non-superadmin entry is never touched');
    console.log('  PASS  syncMyDirectoryRole: publishes/fixes the superadmin role, clears a stale one, else no-op');

    // ---------- personProfileFor resolves it ----------
    const sb = { directory: { 'boss@x.com': { email: 'boss@x.com', role: 'superadmin', displayName: 'Boss' } }, rosterEntries: {} };
    vm.createContext(sb);
    vm.runInContext(grab('personProfileFor') + '\nthis.profile = personProfileFor;', sb);
    assert.strictEqual(sb.profile('boss@x.com').role, 'superadmin', 'with no roster, the directory supplies the role');
    console.log('  PASS  personProfileFor: store roles get the superadmin role from the directory');

    // ---------- existing thread kept ----------
    const rowsFn = grab('collectConversationRows');
    assert(/keepSuperadminThread = \(myRole === 'owner' \|\| myRole === 'rmsm'\)/.test(rowsFn) &&
        /normalizeRole\(peerEntry\.role\) === 'superadmin'/.test(rowsFn),
        'an existing store-role <-> Super Admin thread must stay listed (now blue)');
    assert(/if \(!isStartable\(entry\)\) return;/.test(rowsFn), 'never-started rows still come only from isStartable()');
    console.log('  PASS  rows: existing Super Admin thread kept; no new Super Admin row offered');

    console.log('\n✅ Super Admin indicator tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
