/**
 * Authentication Module
 * Handles login/logout using Firebase Auth
 */

// ==============================================================
// DOM REFERENCES
// ==============================================================

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const messageEl = document.getElementById('message');

// ==============================================================
// PAGE GATING
//
// The redirect to login.html was DISABLED (the body of the `if` was
// commented out to "allow public access to index"), which let anyone
// type main.html and land on the dashboard shell unauthenticated.
//
// Two rules this must respect, or real users get locked out:
//   * PROTECTED: main.html, ownerdashboard.html  -> require a login
//   * PUBLIC:    login.html, submit-ticket.html, pending-approval.html
//     submit-ticket.html is the PUBLIC complaint form and is never gated;
//     pending-approval.html is where a not-yet-approved user is sent, so
//     gating it would trap them in a redirect loop.
// ==============================================================

const PROTECTED_PAGES = ['main.html', 'ownerdashboard.html'];

/** Last path segment, e.g. '/a/b/main.html' -> 'main.html'. */
function currentPageName(pathname) {
    const raw = String(pathname == null ? '' : pathname);
    const last = raw.split('/').pop() || '';
    // Strip a query/hash if one somehow rode along, and case-normalise.
    return last.split('?')[0].split('#')[0].toLowerCase();
}

function isProtectedPage(pathname) {
    return PROTECTED_PAGES.indexOf(currentPageName(pathname)) > -1;
}

/**
 * A ticket number is `[A-Z]{3}-TIX\d+` in practice (BNW-TIX007), but this gate
 * is deliberately looser than that pattern on purpose: it exists to stop a
 * crafted `?ticket=` from smuggling anything into the URL we re-emit after
 * login (a second `?`, a `#`, a `/`, an encoded scheme), NOT to validate the
 * real numbering scheme. A pattern that rejected a legitimately-numbered future
 * ticket would be a worse bug than the one it prevents.
 */
const SAFE_TICKET_PARAM = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Read `?ticket=` from a search string, or '' when absent/unsafe.
 * NEVER returns anything that could alter the shape of the URL it is spliced
 * into — that is the whole point of the allowlist.
 */
function readSafeTicketParam(search) {
    try {
        const raw = new URLSearchParams(search || '').get('ticket');
        if (!raw) return '';
        const value = String(raw).trim();
        return SAFE_TICKET_PARAM.test(value) ? value : '';
    } catch (err) {
        return '';
    }
}

/**
 * Send the visitor to the login screen, remembering where they were
 * headed so login can return them there.
 *
 * `location.replace` (not `href`) so the BACK button cannot walk from the
 * login page straight back into the protected page.
 *
 * ⚠️ The `?ticket=` deep link (the approval email points at
 * `ownerdashboard.html?ticket=BNW-TIX007`) MUST ride along, otherwise a manager
 * who is not yet signed in clicks the link, signs in, and lands on a dashboard
 * with no indication of which ticket was approved — the deep link silently
 * becoming a no-op. It travels as its OWN parameter rather than being baked
 * into `next`, because `next` is validated against PROTECTED_PAGES and must
 * stay a bare page name.
 */
function redirectToLogin() {
    const here = currentPageName(window.location.pathname);
    let target = 'login.html?next=' + encodeURIComponent(here);
    const ticket = readSafeTicketParam(window.location.search);
    if (ticket) target += '&ticket=' + encodeURIComponent(ticket);
    window.location.replace(target);
}

// Exposed for the unit test (test/auth-guard.test.js), which runs this
// block in a vm sandbox where a bare `const` would not reach the global.
window.__authGuardInternals = {
    PROTECTED_PAGES: PROTECTED_PAGES,
    currentPageName: currentPageName,
    isProtectedPage: isProtectedPage,
    readSafeTicketParam: readSafeTicketParam
};

// ==============================================================
// LOGIN
// ==============================================================

/**
 * Re-attach a validated `?ticket=` to the page we are about to send the user to.
 *
 * ⚠️ SECURITY — the value is passed through `readSafeTicketParam()` again, NOT
 * forwarded blind. This page is reachable by anyone editing a URL, and the value
 * is spliced into a `location.href`; one carrying `?`, `#`, `/` or a scheme
 * could otherwise redirect the login off-site. The allowlist is applied at BOTH
 * ends of the round trip on purpose — once on the way in (redirectToLogin) and
 * once on the way out (here) — so neither end has to trust the other.
 *
 * Returns the page name unchanged when there is nothing safe to carry.
 */
function withTicketParam(page) {
    const ticket = readSafeTicketParam(window.location.search);
    return ticket ? page + '?ticket=' + encodeURIComponent(ticket) : page;
}

// Roles are managed in Firebase user documents, not in hardcoded app code.
async function resolveLoginDestination(user) {
    // `?next=` is set by redirectToLogin() so a user bounced off a protected
    // page lands back on it. Only ever honoured for a page in the known
    // PROTECTED_PAGES list — accepting an arbitrary value would be an open
    // redirect (someone could send you to an external phishing page).
    let next = null;
    try {
        const raw = new URLSearchParams(window.location.search || '').get('next');
        if (raw) {
            const candidate = currentPageName(String(raw).trim());
            if (PROTECTED_PAGES.indexOf(candidate) > -1) next = candidate;
        }
    } catch (err) {
        console.warn('Could not read ?next= from the URL:', err && err.message ? err.message : err);
    }

    try {
        const email = user && user.email ? user.email : '';
        const profile = await window.getUserProfile(email);
        const data = profile || null;

        if (data && (data.status || '').toLowerCase() === 'pending') return 'pending-approval.html';

        const role = (data && data.role) || 'operator';
        if (role === 'superadmin') return withTicketParam(next || 'main.html');
        // 'hr' uses the SAME dashboard as an owner — the only differences
        // are the profile label and chat access — so both route here.
        if (role === 'owner' || role === 'hr') return withTicketParam('ownerdashboard.html');
        return withTicketParam(next || 'main.html');
    } catch (err) {
        console.warn('Role lookup failed, defaulting to main.html:', err && err.message ? err.message : err);
        return withTicketParam('main.html');
    }
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            if (messageEl) messageEl.textContent = 'Please enter email and password.';
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = 'LOGGING IN...';

        try {
            await auth.signInWithEmailAndPassword(email, password);
            if (messageEl) messageEl.textContent = '';
            // Route to the correct dashboard based on role.
            const destination = await resolveLoginDestination(auth.currentUser);
            window.location.href = destination;
        } catch (error) {
            console.error('Login error:', error);
            if (messageEl) messageEl.textContent = error.message;
            loginBtn.disabled = false;
            loginBtn.textContent = 'LOGIN';
        }
    });
}

// ==============================================================
// AUTH STATE OBSERVER
// ==============================================================

auth.onAuthStateChanged(async (user) => {
    // On pages that require auth, redirect to login.
    // NOTE: this is a UX gate, not a security boundary. The authoritative
    // check is firestore.rules — a determined user can always skip a JS
    // redirect, which is why the sensitive collections are gated there.
    const page = currentPageName(window.location.pathname);
    const isLoginPage = page === 'login.html';
    const isPendingPage = page === 'pending-approval.html';
    const onProtectedPage = isProtectedPage(window.location.pathname);

    if (onProtectedPage && !user) {
        redirectToLogin();
        return;
    }

    // Already signed in? Do not leave someone sitting on the login screen.
    // Routes through resolveLoginDestination so this lands on the SAME page as
    // the login form's own submit handler — a plain `main.html` here would race
    // that handler and briefly load the wrong dashboard for owners/HR.
    if (isLoginPage && user) {
        window.location.replace(await resolveLoginDestination(user));
        return;
    }

    // Route PENDING (not-yet-approved) users away from the dashboard.
    if (onProtectedPage && user && !isLoginPage && !isPendingPage && db) {
        const email = user && user.email ? user.email : '';
        db.collection('users').doc(window.normalizeUserEmail(email)).get()
            .then(snap => {
                if (snap.exists && (snap.data().status || '').toLowerCase() === 'pending') {
                    window.location.replace('pending-approval.html');
                }
            })
            .catch(err => console.warn('Approval status check skipped:', err && err.message ? err.message : err));
    }
});

// ==============================================================
// LOGOUT
// ==============================================================

window.handleLogout = async function() {
    if (!confirm('Are you sure you want to log out?')) return;
    try {
        await auth.signOut();
        showToast('Logged out successfully', 'success');
        // Send the user back to the login page (reload kept them on main.html).
        window.location.href = 'login.html';
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Failed to log out', 'error');
    }
};

