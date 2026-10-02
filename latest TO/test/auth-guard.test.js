// Functional test for the login gate (js/auth.js).
//
// THE BUG THIS LOCKS DOWN:
//   The body of the `if (isIndexPage && !user)` branch in the auth observer
//   was commented out ("to allow public access to index"), so the redirect
//   never ran. Typing main.html in the address bar loaded the dashboard
//   shell with no session at all.
//
//   This is a UX gate, NOT a security boundary — anyone determined can skip
//   a JS redirect. The authoritative gate is firestore.rules, where
//   status_logs / violations / users are already closed to anonymous users.
//   See README-interface.md for the rules that remain open.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const authSrc = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');

// Markers are matched loosely on purpose: the banner comments in auth.js are
// hand-aligned (`// LOGIN` vs `//  LOGIN`), and a test that breaks when someone
// tidies a comment is a test that gets deleted instead of fixed.
const start = authSrc.search(/\/\/\s+PAGE GATING/);
assert(start > -1, 'the PAGE GATING block not found in js/auth.js');
const blockStart = authSrc.lastIndexOf('// ===', start);
// Anchor the end on the next real declaration, not on a banner comment — the
// banner text between the two blocks is cosmetic and gets realigned often.
const end = authSrc.indexOf('async function resolveLoginDestination', start);
assert(end > blockStart, 'end of the PAGE GATING block not found in js/auth.js');
const blockSrc = authSrc.slice(blockStart, end);

console.log('Testing the login gate (protected pages must require a session)...');

const sandbox = { console, window: {}, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext(blockSrc, sandbox);

const { PROTECTED_PAGES, currentPageName, isProtectedPage, readSafeTicketParam } = sandbox.window.__authGuardInternals;
assert(PROTECTED_PAGES, 'the page gate helpers were not exposed on window.__authGuardInternals');
assert.strictEqual(typeof readSafeTicketParam, 'function',
    'the ?ticket= reader must be exposed so its allowlist can be tested directly');

// 1. currentPageName takes the LAST segment, so it works from any subdirectory
//    and cannot be fooled by a folder name that merely contains the page name.
assert.strictEqual(currentPageName('/main.html'), 'main.html');
assert.strictEqual(currentPageName('/Implement/main.html'), 'main.html');
assert.strictEqual(currentPageName('/a/b/c/ownerdashboard.html'), 'ownerdashboard.html');
assert.strictEqual(currentPageName('/main.html?next=x'), 'main.html');
assert.strictEqual(currentPageName('/Main.HTML'), 'main.html', 'page names must be case-normalised');
assert.strictEqual(currentPageName('/main.html.bak'), 'main.html.bak');

// 2. ⚠️ The old check used `pathname.includes('main.html')`, which would also
//    match a decoy path. A substring match must NOT be enough to gate a page.
assert.strictEqual(isProtectedPage('/backup/main.html.bak'), false,
    'a decoy path that merely CONTAINS main.html must not be treated as protected');
assert.strictEqual(isProtectedPage('/main.html.backup'), false,
    'a decoy path containing main.html must not be treated as protected');

// 3. The dashboards ARE gated.
assert.strictEqual(isProtectedPage('/main.html'), true, 'main.html must require a login');
assert.strictEqual(isProtectedPage('/ownerdashboard.html'), true, 'ownerdashboard.html must require a login');

// 4. ⚠️ REGRESSION GUARD for locking real users out. submit-ticket.html is the
//    PUBLIC complaint form and pending-approval.html is where a not-yet-
//    approved user is sent — gating either would break a real flow (the first
//    locks out your customers, the second traps a new signup in a redirect
//    loop). Both MUST stay public.
['/login.html', '/submit-ticket.html', '/pending-approval.html'].forEach((p) => {
    assert.strictEqual(isProtectedPage(p), false,
        `${p} must stay publicly reachable — gating it locks real users out`);
});

// 5. The gate must not have been satisfied by accident: the redirect really is
//    wired into the auth observer, and it uses replace() so the BACK button
//    cannot walk straight from the login page into the dashboard.
const observer = authSrc.slice(authSrc.indexOf('auth.onAuthStateChanged'));
assert(
    /onProtectedPage\s*&&\s*!user/.test(observer),
    'the auth observer must redirect when on a protected page with no user'
);
assert(
    /redirectToLogin\(\)/.test(observer),
    'the observer must actually call redirectToLogin()'
);
assert(
    /function redirectToLogin[\s\S]*?location\.replace\(/.test(authSrc),
    'redirectToLogin must use location.replace(), not href — otherwise Back returns to the protected page'
);

// 6. The dead code that caused the bug must be gone for good.
assert(
    authSrc.indexOf('Comment out to allow public access to index') === -1,
    'the "allow public access" opt-out must not be reintroduced'
);
assert(
    !/if\s*\(isIndexPage\s*&&\s*!user\)\s*\{\s*(\/\/[^\n]*\s*)*\}/.test(authSrc),
    'the auth observer must not contain an empty isIndexPage guard again'
);

// 7. ?next= must only ever redirect to a KNOWN protected page. Accepting an
//    arbitrary value would be an open redirect (a phishing link wearing your
//    login page). The allowlist check is the whole point.
assert(
    /next\s*\|\|\s*'main\.html'/.test(authSrc),
    'resolveLoginDestination must honour ?next= with main.html as the default'
);
assert(
    /PROTECTED_PAGES\.indexOf\(candidate\)\s*>\s*-1/.test(authSrc),
    '?next= must be validated against PROTECTED_PAGES or it is an open redirect'
);

// 8. Sanity: the gate is wired into a page that actually loads auth.js.
assert(
    /src="js\/auth\.js"/.test(mainHtml),
    'main.html must load js/auth.js, or the gate never runs'
);

// ============================================================================
// 9. THE ?ticket= DEEP LINK FROM THE APPROVAL EMAIL
// ============================================================================
// THE BUG THIS LOCKS DOWN: the approval email links
// `ownerdashboard.html?ticket=BNW-TIX007`, and ownerdashboard.html is
// login-gated. A manager who is signed out is bounced to login.html and
// returned — so the ticket number MUST survive that round trip, or the deep
// link silently degrades into "landed on the dashboard with no idea which
// ticket this was about".
assert(
    /ticket=/.test(authSrc.slice(authSrc.indexOf('function redirectToLogin'))),
    'redirectToLogin() must carry ?ticket= through to login.html'
);
assert(
    /withTicketParam\('ownerdashboard\.html'\)/.test(authSrc),
    'an owner/hr must be returned to ownerdashboard.html WITH the ticket param'
);

// ⚠️ SECURITY — the value comes off a URL a stranger can edit and is spliced
// into a location.href. Anything that could alter the shape of that URL (a
// second `?`, a `#`, a `/`, a scheme) must be dropped, or the login page
// becomes an open redirect wearing a trusted login form.
assert.strictEqual(readSafeTicketParam('?ticket=BNW-TIX007'), 'BNW-TIX007',
    'a real ticket number must pass through untouched');
assert.strictEqual(readSafeTicketParam('?ticket=bnw-tix-007'), 'bnw-tix-007',
    'case must be preserved - the value is matched against Firestore ids');
assert.strictEqual(readSafeTicketParam(''), '', 'no param means no ticket');
assert.strictEqual(readSafeTicketParam('?other=1'), '', 'an unrelated query must not read as a ticket');

[
    'https://evil.example.com',       // off-site redirect
    'main.html?x=1',                   // smuggle a second query
    'BNW-TIX007#frag',                 // smuggle a fragment
    '../../tickets/other',             // path traversal into Firestore
    'BNW TIX007',                      // raw space
    'a'.repeat(65),                    // absurd length
    'x&y=z'                            // parameter injection
].forEach(function (hostile) {
    assert.strictEqual(readSafeTicketParam('?ticket=' + encodeURIComponent(hostile)), '',
        'a hostile ?ticket= value must be dropped, not forwarded: ' + hostile);
});

// The allowlist must be applied on the way OUT of login too, not only on the
// way in — the login page is itself attacker-reachable.
assert(
    /withTicketParam\s*\(/.test(authSrc),
    'the post-login destination must re-validate ?ticket= (withTicketParam)'
);

console.log('✅ Login gate tests passed (main.html + ownerdashboard.html require a session; public pages stay reachable; ?next= cannot be used as an open redirect; the ?ticket= deep link survives the login bounce and cannot smuggle a redirect).');

// ============================================================================
// 10. A SUPERADMIN MUST NEVER BE STRANDED ON THE OWNER DASHBOARD
// ============================================================================
// THE BUG THIS LOCKS DOWN: the approval email links
// `ownerdashboard.html?ticket=…`, and js/auth.js honours `?next=` ahead of a
// superadmin's `main.html` default — so a superadmin who followed an approval
// link landed on the Owner Dashboard. The role guard there then bounced
// OPERATORS ONLY, so nobody moved them back, and they were stuck on a page with
// three tabs (Overview / Tickets / Violations) while Ticket Reviews and User
// Approvals live on main.html. Reported as: "my superadmin dashboard is missing
// a tab".
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

// ⚠️ Window generously: the guard is preceded by a long explanatory comment, and
// a slice too small to reach the redirect would make this assertion pass/fail for
// the wrong reason (it measured the comment, not the code).
const guardStart = ownerJs.indexOf("if (activeUserRole === 'operator'");
const ownerGuard = ownerJs.slice(guardStart, guardStart + 1200);
assert(guardStart > -1, 'the Owner Dashboard role guard was not found at all');
assert(
    /activeUserRole === 'superadmin'/.test(ownerGuard),
    "the Owner Dashboard role guard must also redirect a SUPERADMIN to main.html — "
    + 'otherwise a superadmin who follows an approval link is stranded here with no '
    + 'way back to Ticket Reviews / User Approvals'
);
assert(
    /main\.html\?ticket=/.test(ownerGuard),
    'the redirect must CARRY ?ticket= across to main.html, or it silently discards the '
    + 'reason the user followed the link in the first place');

// HR must NOT be swept up by that redirect — HR is routed to this page on purpose.
assert(
    !/activeUserRole === 'hr'/.test(ownerGuard),
    "HR belongs on the Owner Dashboard; the guard must not redirect the 'hr' role"
);

// And main.html has to HONOUR the ?ticket= it now receives, or the redirect is
// just another silent discard.
assert(
    /function applyMainDeepLink/.test(scriptJs) && /function captureMainDeepLink/.test(scriptJs),
    'main.html must read ?ticket= so the superadmin redirect still opens the ticket'
);
assert(
    /window\.openTicketModal\(ticketId\)/.test(scriptJs),
    'the main.html deep link must open the ticket modal'
);
// Both sides must use the SAME allowlist, or one of them is the weak link.
assert(/\{1,64\}/.test(ownerJs) && /\{1,64\}/.test(scriptJs),
    'both deep-link readers must bound the ticket id to 64 chars with the same charset');
// It must actually be called, not merely defined.
assert(
    /await applyMainDeepLink\(\)/.test(scriptJs),
    'applyMainDeepLink() must be called from the auth observer or the link does nothing'
);

// The two dashboards really are different pages with different tab sets — that is
// the whole reason being stranded here is a bug and not a cosmetic detail.
const mainHtml2 = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
assert(/id="tabApprovals"/.test(mainHtml2),
    'Ticket Reviews lives on main.html');
assert(!/id="tabApprovals"/.test(ownerHtml),
    'the Owner Dashboard must not have gained an approvals tab as a side effect of this fix');
console.log('  PASS  a superadmin is returned to main.html, carrying ?ticket=, and main.html opens it');
