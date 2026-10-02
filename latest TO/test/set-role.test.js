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

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

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

// 4b. The Area Manager rename is DISPLAY-ONLY. The stored value stays
//     'owner' everywhere, so no user document has to be migrated and the
//     rules / chat allowlist / login redirect keep matching. If anyone
//     "tidies" the value to 'area_manager' instead, every existing account
//     silently falls back to the safe default and the rename breaks.
assert(/area manager/i.test(ownerHint), 'the Area Manager hint must name the role by its new label');
assert(
    !/area_manager/.test(stripComments(blockSrc)),
    'script.js must not introduce an "area_manager" role VALUE — the rename is label-only ' +
    '(comments are stripped, so the note warning against it does not trip this)'
);
assert.strictEqual(
    currentUserRoleLabel({ role: 'owner' }), 'owner',
    'a stored role "owner" must still resolve to "owner" (it is now displayed as Area Manager)'
);
assert.strictEqual(
    currentUserRoleLabel({ role: 'Area Manager' }), 'owner',
    'a legacy/hand-edited "Area Manager" value must clamp to "owner", not become an unknown role'
);

// 5. The dropdown value written by getUserDetailData() must be clamped the
//    same way, so a hand-edited <select> cannot inject 'superadmin'.
assert.strictEqual(clampRoleSelection('hr'), 'hr', 'a real HR selection must pass through');
assert.strictEqual(clampRoleSelection('owner'), 'owner', 'a real owner selection must pass through');
assert.strictEqual(clampRoleSelection('superadmin'), 'owner', 'a tampered superadmin value must be clamped');
assert.strictEqual(clampRoleSelection('operator'), 'owner', 'a tampered operator value must be clamped');
assert.strictEqual(clampRoleSelection(null), 'owner', 'a missing selection must default to owner');

assert.strictEqual(clampRoleSelection(null), 'owner', 'a missing selection must default to owner');

// ===========================================================================
// 6. THE "+Ticket" BUTTON — Area Manager only.
//
//    The button was previously REMOVED for every role because tickets were
//    only filed from the public submit-ticket.html. It is back for the Area
//    Manager alone. Three things can silently break that, so each is pinned:
//
//      a) it must SHIP HIDDEN. The role resolves asynchronously from
//         Firestore, so a button that starts visible flashes on screen for
//         HR and superadmin on every single load.
//      b) it must be gated on the ROLE, and the role VALUE is still 'owner'.
//         Gating on the display label ("Area Manager") would never match.
//      c) `[hidden]` must actually hide it — `.btn` sets display:inline-flex,
//         which beats the user-agent [hidden] rule. Without the explicit
//         `.btn[hidden]` rule the attribute is set but the pixels remain.
// ===========================================================================
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

// The button was an <a href="submit-ticket.html"> and is now a <button> that
// opens the in-dashboard full-screen form (js/owner-ticket-form.js). The
// element type is asserted, not just tolerated: an <a> would be middle-clickable
// and would have to be prevented from navigating, and a plain <button> with no
// type defaults to type="submit" inside a form.
const newTicketBtn = (ownerHtml.match(/<button[^>]*id="btnOwnerNewTicket"[^>]*>/) || [])[0];
assert(newTicketBtn, 'ownerdashboard.html must contain the #btnOwnerNewTicket button');
assert(
    !/<a[^>]*id="btnOwnerNewTicket"/.test(ownerHtml),
    '#btnOwnerNewTicket must NOT be an anchor any more — the form is a modal on this ' +
    'page, and a link would let the manager open a new tab with no dashboard context'
);
assert(
    /type="button"/.test(newTicketBtn),
    'the +Ticket button must declare type="button". It opens a modal; the implicit ' +
    'type="submit" default only bites inside a form, but the explicit type is the ' +
    'contract. Found: ' + newTicketBtn
);

assert(
    /\shidden(\s|>|=)/.test(newTicketBtn),
    'the +Ticket button must ship with the `hidden` attribute — the role is not known at ' +
    'parse time, so a visible-by-default button flashes for HR/superadmin on every load. Found: ' + newTicketBtn
);
assert(
    !/href=/.test(newTicketBtn),
    'the +Ticket button must not carry an href any more. Found: ' + newTicketBtn
);

// The click handler must open the modal AND re-check the role. `hidden` is a
// CSS/AT concern, not a security boundary: anything holding a reference to the
// element can clear it, so the handler is the actual gate.
assert(
    /ownerNewTicketBtn\.addEventListener\('click'/.test(ownerJs),
    'the +Ticket button must be wired to a click handler that opens the ticket form'
);
const newTicketHandler = ownerJs.slice(
    ownerJs.indexOf("ownerNewTicketBtn.addEventListener('click'"),
    ownerJs.indexOf('// ==============================================================\n//  CONTEXT BRIDGE')
);
assert(
    /if\s*\(!isAreaManager\(\)\)\s*return;/.test(newTicketHandler),
    'the +Ticket click handler must re-check isAreaManager() before opening the form. ' +
    '`hidden` can be cleared by any code holding a reference to the element, so the ' +
    'handler itself is the only real gate. Found: ' + newTicketHandler.trim()
);
assert(
    /OwnerTicketForm\.open\(\)/.test(newTicketHandler),
    'the +Ticket click handler must call OwnerTicketForm.open()'
);

// (b) The gate compares the stored role value, not the label.
assert(
    /function isAreaManager\(\)\s*\{\s*return activeUserRole === 'owner';/.test(ownerJs),
    'isAreaManager() must test the STORED role value "owner" — comparing the "Area Manager" ' +
    'label would never match and the button would never appear'
);
assert(
    /syncNewTicketButton\(\);/.test(ownerJs),
    'setActiveUser() must call syncNewTicketButton() so the button is gated on the live role'
);
// Calling it anywhere other than setActiveUser() would miss a re-role in
// another tab, which is why the call must sit inside that function.
const setActiveUserBody = ownerJs.slice(
    ownerJs.indexOf('function setActiveUser('),
    ownerJs.indexOf('function switchOwnerTab(')
);
assert(
    /syncNewTicketButton\(\);/.test(setActiveUserBody),
    'syncNewTicketButton() must be called from setActiveUser(), not only at first load, ' +
    'so a role changed in another tab takes effect immediately'
);

// (c) The stylesheet must make `hidden` beat `.btn { display: inline-flex }`.
const btnHiddenRule = styleCss.match(/\.btn\[hidden\]\s*\{[^}]*\}/);
assert(btnHiddenRule, 'style.css must define `.btn[hidden]` — .btn sets display:inline-flex, ' +
    'which is an author declaration and beats the user-agent [hidden] rule, so the attribute ' +
    'alone would leave the button visible');
assert(
    /display:\s*none/.test(btnHiddenRule[0]),
    '`.btn[hidden]` must set display:none. Found: ' + btnHiddenRule[0]
);

// The button must not leak into the OTHER roles' markup: it lives on the
// shared Area Manager / HR page, so the gate is the only thing separating
// them and it is asserted above.
assert(
    !/id="btnOwnerNewTicket"/.test(fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8')),
    'the +Ticket button belongs to the Area Manager dashboard only; main.html is the ' +
    'operator/superadmin command center and must not gain it'
);

// The label rename must be visible in the header the user actually sees.
assert(
    /'Area Manager'/.test(ownerJs),
    'js/owner-dashboard.js must label the role "Area Manager"'
);
assert(
    />Area Manager<\/option>/.test(src),
    'the User Approvals role dropdown must offer "Area Manager" (value stays "owner")'
);

console.log('✅ Set Role tests passed (owner + hr only; unknown/privileged roles clamped; ' +
    'Area Manager is a label-only rename; +Ticket is gated, ship-hidden and really hides).');
