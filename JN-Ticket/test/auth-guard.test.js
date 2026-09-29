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

const { PROTECTED_PAGES, currentPageName, isProtectedPage } = sandbox.window.__authGuardInternals;
assert(PROTECTED_PAGES, 'the page gate helpers were not exposed on window.__authGuardInternals');

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


console.log('✅ Login gate tests passed (main.html + ownerdashboard.html require a session; public pages stay reachable; ?next= cannot be used as an open redirect).');
