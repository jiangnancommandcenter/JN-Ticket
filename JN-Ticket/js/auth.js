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
 * Send the visitor to the login screen, remembering where they were
 * headed so login can return them there.
 *
 * `location.replace` (not `href`) so the BACK button cannot walk from the
 * login page straight back into the protected page.
 */
function redirectToLogin() {
    const here = currentPageName(window.location.pathname);
    window.location.replace('login.html?next=' + encodeURIComponent(here));
}

// Exposed for the unit test (test/auth-guard.test.js), which runs this
// block in a vm sandbox where a bare `const` would not reach the global.
window.__authGuardInternals = {
    PROTECTED_PAGES: PROTECTED_PAGES,
    currentPageName: currentPageName,
    isProtectedPage: isProtectedPage
};

// ==============================================================
// LOGIN
// ==============================================================

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
        if (role === 'superadmin') return next || 'main.html';
        // 'hr' uses the SAME dashboard as an owner — the only differences
        // are the profile label and chat access — so both route here.
        if (role === 'owner' || role === 'hr') return 'ownerdashboard.html';
        return next || 'main.html';
    } catch (err) {
        console.warn('Role lookup failed, defaulting to main.html:', err && err.message ? err.message : err);
        return 'main.html';
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

