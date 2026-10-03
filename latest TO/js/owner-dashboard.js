// Area Manager dashboard (ownerdashboard.html) - Firebase-connected and role-aware
//
// ⚠️ The role displayed as "Area Manager" is stored as 'owner'. The rename was
// DISPLAY-ONLY on purpose: no user document is migrated, and every check that
// authorises on the value (chat allowlist, firestore.rules, the login redirect,
// the operator redirect below) still compares 'owner'. Do not "tidy" the value.
const $owner = (id) => document.getElementById(id);

const ownerNavItems = Array.from(document.querySelectorAll('#ownerSidebarNav .nav-item'));
const ownerTabContents = Array.from(document.querySelectorAll('#ownerMainContent .tab-content'));
const ownerPageTitle = $owner('ownerPageTitle');
const ownerPageSubtitle = $owner('ownerPageSubtitle');
const ownerUserEmail = $owner('ownerUserEmail');
const ownerUserRoleBadge = $owner('ownerUserRoleBadge');
const ownerBranchFilter = $owner('ownerBranchFilter');
const ownerBranchList = $owner('ownerBranchList');
const ownerPermSummary = $owner('ownerPermSummary');
const ownerLogoutBtn = $owner('ownerLogoutBtn');
// The "+Ticket" entry point. The Area Manager (stored role 'owner') is the one
// role that files tickets from this dashboard; it opens the public form.
const ownerNewTicketBtn = $owner('btnOwnerNewTicket');
const ownerReportModal = $owner('ownerReportModal');
const ownerReportModalBody = $owner('ownerReportModalBody');
const closeOwnerReportModal = $owner('closeOwnerReportModal');
const ownerReportDetailsStatus = $owner('ownerReportDetailsStatus');

const kpiMonthlyReports = $owner('totalMonthlyReports');
const kpiAssignedReports = $owner('totalAssignedReports');
const kpiActiveBranches = $owner('totalActiveBranches');
const kpiAccessLevel = $owner('accessLevelValue');

// Owner Tickets tab elements
const ownerTicketSearch = $owner('ownerTicketSearch');
// Replaces the old #ownerTicketStatusFilter, which listed seven statuses but
// was force-locked to "Resolved" and disabled for every role that can reach
// this page — ~170px of permanently dead control that read as a broken filter.
// The list is approved-only now, so the distinction that still matters is
// whether the viewing window is open.
const ownerTicketAccessFilter = $owner('ownerTicketAccessFilter');
const ownerTicketPriorityFilter = $owner('ownerTicketPriorityFilter');
const ownerTicketBranchFilter = $owner('ownerTicketBranchFilter');
const ownerTicketsBody = $owner('ownerTicketsBody');
const ownerTicketPagination = $owner('ownerTicketPagination');
// The Tickets-tab sentence explaining the approved-only + expiring-window
// rules. Its text is filled in from formatTrackingAccessWindow() so it reads
// "1 minute" while the window is time-compressed and "2 days" in production.
const ownerWindowNote = $owner('ownerWindowNote');

let ownerAllBranches = [];
let ownerAssignedBranches = [];
let activeUserRole = 'viewer';
let activeUserPermissions = {
  branches: [],
  permissions: { viewOnly: false, canEdit: false, canDownload: false }
};
let activeUserIsSuperAdmin = false;
// The signed-in manager's display name, read from their `users` doc. Used as
// `requestedBy` on a re-access request, so the superadmin sees a person rather
// than a bare email in the Approvals chip and the confirm dialog.
let ownerActiveUserName = '';
// The ticket the open modal is showing, for the delegated re-access submit.
// Set by openOwnerReport(), cleared by closeOwnerReportModalFn() — never read
// from the DOM, so a re-render mid-flight cannot redirect a request.
let ownerReopenTicketId = '';
// The same ticket the open modal is showing, for the delegated FOOTAGE submit.
// Kept separate from ownerReopenTicketId rather than shared: the two forms are
// mutually exclusive by branch (re-access only renders when expired, footage only
// when it has not), so a shared id would be correct today and silently start
// writing to the wrong flow the first time both could render.
let ownerFootageTicketId = '';

// One-shot flag: owner refresh state (saved tab/modal) is restored exactly once
// per page load so a later auth callback (e.g. ID-token refresh) can never yank
// the user off the view they are currently using.
let ownerStateRestored = false;

// ===== Deep link from the approval email: ?ticket=BNW-TIX007 =====
// `ownerdashboard.html` is LOGIN-GATED, so an Area Manager who clicks the link
// while signed out is bounced to login.html and returned here. js/auth.js carries
// `?ticket=` across that bounce (see redirectToLogin / withTicketParam) - this is
// the half that finally opens the ticket.
//
// ONE-SHOT, consumed once, mirroring `deepLinkPrefillDone` on submit-ticket.html.
// Without that, the next auth callback (Firebase fires them freely, e.g. on
// ID-token refresh) would re-open the modal under the manager, trapping them in
// a report they already closed.
let ownerDeepLinkTicket = '';
let ownerDeepLinkDone = false;

/**
 * Read the ticket number out of the URL, once.
 *
 * ⚠️ SECURITY - this is a redirect target a stranger can edit, and the value is
 * used as a Firestore document id. The allowlist mirrors js/auth.js exactly: no
 * `/`, `?`, `#` or scheme characters can reach Firestore, so the id cannot be
 * walked out of the `tickets` collection, and it cannot smuggle anything into
 * the page URL. Same rule as the public `?track=` link, which also never carries
 * anything but the ticket number.
 */
function readOwnerDeepLink() {
    if (ownerDeepLinkDone) return '';
    ownerDeepLinkDone = true;
    try {
        const raw = new URLSearchParams(window.location.search || '').get('ticket');
        if (!raw) return '';
        const value = String(raw).trim();
        return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : '';
    } catch (e) {
        return '';
    }
}

// Capture it as early as possible - the auth observer below decides when to act.
ownerDeepLinkTicket = readOwnerDeepLink();

/**
 * Open the deep-linked ticket, but ONLY if it is in the list this manager is
 * already allowed to see.
 *
 * ⚠️ THIS GATE IS THE WHOLE POINT. `openOwnerReport()` reads a ticket straight
 * from Firestore by id and renders it. The visible list, by contrast, is filtered
 * in renderOwnerTickets() to APPROVED tickets in the manager's assigned branches.
 * Calling openOwnerReport() on an unfiltered id would hand any signed-in user a
 * way to read ANY ticket document just by editing the URL - including other
 * branches' tickets and unapproved work. So this does NOT trust the URL: it looks
 * the id up in the SAME already-filtered list the UI itself renders.
 *
 * Must run after loadBranches()/loadActiveUserPermissions(), because the branch
 * allowlist is not known until then. Before that every ticket would look
 * out-of-scope and the deep link would always fail.
 */
function applyOwnerDeepLink(allTickets) {
    if (!ownerDeepLinkTicket) return;
    if (typeof window.openOwnerReport !== 'function') return;

    // ⚠️ Consume it HERE, before anything can return early. The ticket listener
    // fires on every snapshot (and this list re-renders often), so a deep link
    // left set would re-open the report modal over and over, trapping the
    // manager in a ticket they already closed. Consuming first also means the
    // "not available" toast can only ever appear once.
    const ticketId = ownerDeepLinkTicket;
    ownerDeepLinkTicket = '';

    const rows = (Array.isArray(allTickets) ? allTickets : []).map((doc) => normalizeTicketReport(doc));

    // ⚠️ WHY THIS GATE IS "APPROVED", NOT "IN MY BRANCH LIST".
    //
    // The original version required the ticket to appear in the manager's
    // branch-scoped LIST, and called that a security control. It was not one:
    // firestore.rules already reads
    //     allow read: if isSignedIn() || resource.data.approvalStatus == 'approved'
    // so ANY signed-in user can already read ANY approved ticket straight from
    // Firestore. Requiring it to pass a UI branch filter blocked nothing — it
    // just stopped the legitimate recipient of an approval email from opening
    // the ticket they had been emailed about, whenever their branch list was
    // empty (see the approveUser() branches:[] bug) or a name differed by case.
    //
    // So the gate is now exactly what the rules enforce: signed in + approved.
    // The branch list still scopes the visible TICKETS, which is where scoping
    // belongs; the deep link reports a branch mismatch as information.
    const match = rows.find((t) => String(t.id || '') === ticketId);
    if (!match) {
        ownerToast('Ticket ' + ticketId + ' could not be found.', 'error');
        return;
    }

    if (!isApprovedTicket(match)) {
        ownerToast('Ticket ' + ticketId + ' has not been approved yet.', 'error');
        return;
    }

    // Informational only — it opens regardless. Branch scoping lives in the list.
    const allowedBranches = activeUserIsSuperAdmin ? ownerAllBranches : ownerAssignedBranches;
    const ticketBranch = ownerBranchKey(match.branch || match.branchName || '');
    const inScope = activeUserIsSuperAdmin
        || allowedBranches.some((b) => ownerBranchKey(b) === ticketBranch);
    if (!inScope) {
        console.warn('[Deep link] ' + ticketId + ' is outside this manager\'s branch list (' +
            (match.branch || match.branchName || 'unknown') + '). Opening it anyway: firestore.rules '
            + 'already permits any signed-in user to read an approved ticket.');
    }

    // Land on the Tickets tab first - the report modal renders over whatever
    // tab is showing, so without this they get a popup over Overview.
    switchOwnerTab('tickets');
    window.openOwnerReport(ticketId);
}


// ===== Flash-free restore =====
// Runs synchronously during parsing — before the first paint — so a refresh
// re-opens the saved tab (Overview / Reports) with no visible default-then-jump.
// The async auth observer re-checks the actual role afterwards.
(function preRestoreOwnerTab() {
    try {
        if (!window.RefreshState) return;
        const saved = window.RefreshState.restore('owner') || {};
        const tabId = saved.tab;
        // 'violations' is the HR-only transferred-violations tab. It is restored
        // here like any other, but the section only becomes reachable once
        // js/hr-violations.js confirms the role is hr/superadmin — an owner who
        // was last on it is moved back to the overview by that module's
        // applyRole(), which is why this is safe to allow unconditionally.
        if (!['overview', 'tickets', 'violations'].includes(tabId)) return;

        ownerNavItems.forEach((btn) => { btn.classList.toggle('active', btn.dataset.tab === tabId); });
        ownerTabContents.forEach((section) => { section.classList.toggle('active', section.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`); });
    } catch (e) { /* ignore */ }
})();

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ⚠️ This is deliberately a PRIVATE `const`, not a top-level `function`.
//
// A top-level `function` in a classic script becomes a property of `window`.
// js/notifications.js (loaded EARLIER on this page) already defines the real
// `window.showToast`, so declaring a global `showToast` here silently
// OVERWROTE it — and because the old body delegated to `window.showToast`, the
// wrapper ended up calling ITSELF, throwing
// `RangeError: Maximum call stack size exceeded` on every toast on this page
// (HR violation report download, logout failure, chat, error reports).
//
// Keeping it private means this module can never clobber the real toast again.
// The `!== ownerToast` self-check is belt-and-braces: if a future edit
// reintroduces a same-named global, this degrades to console.log instead of
// hanging the tab. Mirrors the local `toast()` helper in js/hr-violations.js.
const ownerToast = (message, type = 'info') => {
  if (typeof window.showToast === 'function' && window.showToast !== ownerToast) {
    window.showToast(message, type);
  } else {
    console.log(message);
  }
};

/**
 * The signed-in user's normalised role, for other scripts on this page.
 *
 * ⚠️ `activeUserRole` is declared with `let` at the top level of a classic
 * script, which creates a SCRIPT-SCOPED binding, not a property on `window`.
 * Other <script> files therefore cannot read `window.activeUserRole` — it is
 * always undefined for them. This accessor is how js/hr-violations.js reads it.
 */
window.getOwnerRole = function () {
  return activeUserRole;
};

/**
 * True for the Area Manager.
 *
 * ⚠️ The stored role VALUE stays `'owner'` in Firestore (only the display label
 * became "Area Manager"), so this is a rename, NOT a new role. Everything that
 * authorises on the value — js/chat.js's CHAT_ALLOWED_ROLES, isHrOrSuperAdmin()
 * in firestore.rules, the operator redirect below — keeps comparing 'owner'.
 */
function isAreaManager() {
  return activeUserRole === 'owner';
}

/**
 * The human-readable role name, used by BOTH the header role badge and the
 * "My Access Level" KPI tile.
 *
 * ⚠️ ONE definition on purpose: the badge and the tile previously carried two
 * byte-identical ternaries, which is precisely how a rename like this one ends
 * up applied to one and forgotten on the other. The badge text is also parsed
 * back out of the DOM as a role fallback by js/hr-violations.js (see readRole
 * there), so it must stay in step with that module's matcher.
 */
function accessLevelLabel() {
  return activeUserRole === 'superadmin'
    ? 'Superadmin'
    : activeUserRole === 'hr'
      ? 'HR'
      : isAreaManager()
        ? 'Area Manager'
        : (activeUserPermissions.permissions && activeUserPermissions.permissions.canEdit ? 'Editor' : 'Viewer');
}

/**
 * Show the "+Ticket" button to the Area Manager only.
 *
 * HR and superadmin keep the header as it was: this entry point was previously
 * removed for EVERY role precisely because tickets are filed from the public
 * submit-ticket.html, and it is coming back for one role only — the person who
 * raises tickets for their own branches instead of resolving someone else's.
 *
 * Called from setActiveUser() rather than only on first load, so a role change
 * made in another tab shows/hides the button immediately. An <a> with
 * `hidden` is removed from the tab order AND the accessibility tree, so
 * `hidden` (not a class) is what keeps it from being keyboard-reachable while
 * the role is still unknown.
 */
function syncNewTicketButton() {
  if (!ownerNewTicketBtn) return;
  const show = isAreaManager();
  ownerNewTicketBtn.hidden = !show;
  // The `u-hidden` class is the codebase's other hide idiom (main.html uses it
  // for #btnNewViolation). Set both so the button is hidden even if the
  // stylesheet and the `hidden` attribute ever disagree.
  ownerNewTicketBtn.classList.toggle('u-hidden', !show);
  ownerNewTicketBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  ownerNewTicketBtn.title = show ? 'Submit an incident ticket' : '';
}

// Open the full-screen submission modal. Guarded by the same isAreaManager()
// check as the button's visibility: `hidden` is a CSS/AT concern, not a
// security boundary, and a caller with a reference to the element can always
// set hidden = false. The real gate is the Firestore rules (see README).
if (ownerNewTicketBtn) {
  ownerNewTicketBtn.addEventListener('click', function () {
    if (!isAreaManager()) return;
    if (window.OwnerTicketForm && typeof window.OwnerTicketForm.open === 'function') {
      window.OwnerTicketForm.open();
    }
  });
}

// ==============================================================
//  CONTEXT BRIDGE FOR js/owner-ticket-form.js
//
//  ⚠️ WHY THIS EXISTS. The ticket form is a separate file and cannot see this
//  module's lexical `let` bindings — `ownerAssignedBranches` and
//  `ownerActiveUserName` are module-private, not properties of `window`. Two
//  files reading the same Firestore docs to get the same answers would be a
//  second source of truth that can drift.
//
//  Exposing a narrow READ-ONLY API is the smaller cost. It hands over copies,
//  so a consumer cannot mutate the dashboard's own state by accident. The email
//  is NOT bridged: the form reads `auth.currentUser.email` itself, which is the
//  same source the dashboard uses and needs no second copy.
//
//  Read by the form as: getOwnerAssignedBranches(), getOwnerDisplayName().
// ==============================================================
window.getOwnerAssignedBranches = function () {
  return ownerAssignedBranches.slice();
};
window.getOwnerDisplayName = function () {
  return activeUserDisplayName();
};

function setActiveUser(permissions, role = 'viewer') {
  activeUserPermissions = permissions || {
    branches: [],
    permissions: { viewOnly: false, canEdit: false, canDownload: false }
  };

  const normalizedRole = String(role || 'viewer').toLowerCase();
  activeUserRole = normalizedRole;
  activeUserIsSuperAdmin = normalizedRole === 'superadmin';

  const accessLevel = accessLevelLabel();

  if (ownerUserRoleBadge) {
    ownerUserRoleBadge.textContent = accessLevel;
    ownerUserRoleBadge.className = 'role-badge ' + (
      normalizedRole === 'superadmin'
        ? 'superadmin'
        : normalizedRole === 'hr'
          ? 'hr'
          : normalizedRole === 'owner'
            ? 'owner'
            : (activeUserPermissions.permissions?.canEdit ? 'editor' : 'viewer')
    );
  }

  if (kpiAccessLevel) {
    kpiAccessLevel.textContent = accessLevel;
  }

  // The "+Ticket" shortcut is Area Manager only. This runs on every
  // setActiveUser() call, so it is correct on first load and after a re-role.
  syncNewTicketButton();

  // The approved-only + expiring-window sentence on the Tickets tab, plus the
  // Access column / access filter, which only exist for a role that actually
  // has a viewing window (the Area Manager).
  applyViewerExpiryChrome();

  // ===== HR <-> Superadmin chat =====
  // This page serves Area Managers, HR and superadmins, but chat is for HR and
  // superadmin ONLY — an Area Manager gets the same dashboard minus the chat.
  // canChat() rejects 'owner' (the stored value), operators and anything unknown.
  if (window.ChatService && typeof window.ChatService.init === 'function') {
    try {
      window.ChatService.init({ surface: 'owner', role: normalizedRole });
    } catch (e) {
      console.warn('Chat init failed:', e);
    }
  }

  applyAssignedBranches();

  // Tell the transferred-violations module who signed in, so it can show its
  // tab to HR and hide it again from owners. Called here (not only on first
  // load) so a role change made in another tab takes effect immediately.
  if (window.HrViolations && typeof window.HrViolations.applyRole === 'function') {
    try {
      window.HrViolations.applyRole(normalizedRole);
    } catch (e) {
      console.warn('HR violations role gate failed:', e);
    }
  }
}

function switchOwnerTab(tabId) {
  ownerNavItems.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  ownerTabContents.forEach((section) => {
    section.classList.toggle('active', section.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
  });
  try { if (window.RefreshState) window.RefreshState.captureTab('owner', tabId); } catch (e) { /* ignore */ }
}

function populateBranchDropdowns() {
  const assignedOptions = ownerAssignedBranches
    .map((branch) => `<option value="${escapeHTML(branch)}">${escapeHTML(branch)}</option>`)
    .join('');

  const html = `<option value="">All Branches</option>${assignedOptions}`;

  if (ownerBranchFilter) ownerBranchFilter.innerHTML = html;
  if (ownerTicketBranchFilter) ownerTicketBranchFilter.innerHTML = html;
}

function renderBranchAccessList() {
  if (!ownerBranchList) return;

  if (!ownerAssignedBranches.length) {
    ownerBranchList.innerHTML = '<div class="empty-state"><i class="fas fa-map-pin"></i><p>No branch access assigned yet.</p></div>';
    return;
  }

  ownerBranchList.innerHTML = ownerAssignedBranches
    .map((branch) => `
      <div class="quick-status-item">
        <span>${escapeHTML(branch)}</span>
        <span class="status-badge online">Assigned</span>
      </div>
    `)
    .join('');
}

function renderPermissionSummary() {
  if (!ownerPermSummary) return;

  const p = activeUserPermissions.permissions || {};
  const chips = [
    p.viewOnly ? '<span class="perm-chip">View Only</span>' : '',
    p.canEdit ? '<span class="perm-chip perm-chip-edit">Can Edit</span>' : '',
    p.canDownload ? '<span class="perm-chip perm-chip-download">Can Download</span>' : ''
  ].filter(Boolean);

  ownerPermSummary.innerHTML = chips.length ? chips.join('') : '<span class="perm-chip">No extra permissions</span>';
}

function renderKpiCards() {
  // Same helper the header badge uses, so the two can never disagree.
  const accessLabel = accessLevelLabel();

  if (kpiMonthlyReports) kpiMonthlyReports.textContent = '0';
  if (kpiAssignedReports) kpiAssignedReports.textContent = String(ownerAssignedBranches.length);
  if (kpiActiveBranches) kpiActiveBranches.textContent = String(ownerAssignedBranches.length);
  if (kpiAccessLevel) kpiAccessLevel.textContent = accessLabel;
}

/**
 * ⚠️ THE COMPARISON KEY FOR A BRANCH NAME.
 *
 * Branch names are written in several places by several people: picked from a
 * dropdown, typed into the Manage Branches form, seeded by scripts/seed.js, and
 * entered by hand in the Firestore console. Comparing them with `===` means a
 * single stray space or a lowercase 'banawe' against 'Banawe' silently yields
 * an EMPTY branch list — and the dashboard then shows "No branch access
 * assigned yet" and refuses every ticket deep link, with no error anywhere.
 *
 * Both sides now go through this, so the name that is displayed is still the
 * name that is matched; only the comparison is normalised.
 */
const ownerBranchKey = (name) => String(name === null || name === undefined ? '' : name).trim().toLowerCase();

function applyAssignedBranches() {
  if (!ownerAllBranches.length) {
    ownerAssignedBranches = [];
  } else if (activeUserIsSuperAdmin) {
    ownerAssignedBranches = [...ownerAllBranches];
  } else {
    // Compare on the normalised key, not the raw string.
    const granted = new Set((activeUserPermissions.branches || []).map(ownerBranchKey).filter(Boolean));
    ownerAssignedBranches = ownerAllBranches.filter((branch) => granted.has(ownerBranchKey(branch)));
  }

  populateBranchDropdowns();
  renderBranchAccessList();
  renderPermissionSummary();
  renderKpiCards();
  loadOwnerTickets();
}

async function loadBranches() {
  try {
    if (!window.firestoreService || typeof window.firestoreService.getBranches !== 'function') {
      throw new Error('firestoreService.getBranches is not available');
    }

    const branches = await window.firestoreService.getBranches();
    ownerAllBranches = branches
      .map((b) => b.branchName || b.id || '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    applyAssignedBranches();
  } catch (error) {
    // ⚠️ WAS SILENT. An empty branch list makes every ticket deep link fail and
    // the "+Ticket" form show no branch dropdown, but nothing said why — so a
    // permission error looked identical to "this manager has no branches".
    console.error('Failed to load branches:', error);
    ownerAllBranches = [];
    ownerAssignedBranches = [];
    populateBranchDropdowns();
    renderBranchAccessList();
    renderPermissionSummary();
    ownerToast('Could not load branches — ticket links and branch filters may not work.', 'error');
  }
}

async function loadActiveUserPermissions(user) {
  if (!user || !user.email) return;

  if (ownerUserEmail) ownerUserEmail.textContent = user.email;

  try {
    const emailKey = window.normalizeUserEmail(user.email);
    const userDoc = await db.collection('users').doc(emailKey).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const role = String((userData && userData.role) || 'owner').toLowerCase();
    // Remember the name for a re-access request. `users.name` is the name given
    // at registration, so it is the best "who is asking" the dashboard has; the
    // chat profile name is a separate, opt-in thing we deliberately do not read.
    ownerActiveUserName = String((userData && userData.name) || '').trim();
    const permissions = userData ? {
      branches: Array.isArray(userData.branches) ? userData.branches : [],
      permissions: userData.permissions || { viewOnly: false, canEdit: false, canDownload: false }
    } : {
      branches: [],
      permissions: { viewOnly: false, canEdit: false, canDownload: false }
    };

    setActiveUser(permissions, role);
  } catch (error) {
    console.error('Failed to load user permissions:', error);
    setActiveUser(activeUserPermissions, false);
  }
}

function formatDate(dateValue) {
  if (!dateValue) return '—';
  if (dateValue.toDate) {
    return dateValue.toDate().toLocaleString();
  }
  return new Date(dateValue).toLocaleString();
}

function normalizeTicketReport(ticket) {
  const report = ticket || {};
  const branchName = String(report.branch || report.branchName || '—').trim() || '—';
  const authorName = String(report.author || report.reporter || report.name || 'Unknown').trim() || 'Unknown';
  const title = String(report.title || report.reportName || report.incident || 'Untitled Report').trim() || 'Untitled Report';
  const submittedAt = report.createdAt || report.dateCreated || report.submittedAt || report.datetime || report.dateTime || null;

  return {
    ...report,
    branchName,
    authorName,
    title,
    submittedAt,
    ticketNumber: report.ticketNumber || report.id || 'N/A'
  };
}

// ==============================================================
//  APPROVAL + EXPIRY GATE
//
//  A ticket reaches the Area Manager's list only once the SUPERADMIN has
//  APPROVED it — not merely when the operator resolved it. The lifecycle is
//  (script.js):
//
//    operator resolves  → status 'Resolved', approvalStatus 'pending_approval'
//    superadmin approves → approvalStatus 'approved'   (+ accessWindowStartsOnOpen)
//
//  So `status === 'Resolved'` alone is NOT enough: it also matches work that
//  is still queued for review, and work the superadmin SENT BACK. The list
//  must gate on `approvalStatus === 'approved'`.
//
//  Once approved, the same viewing window the public "Track Ticket Status"
//  page uses applies here (see the 2-day window in firebase.js — currently
//  time-compressed to 1 minute for testing). An APPROVED but LAPSED ticket
//  stays in the list, badged, but its sensitive payload (description,
//  resolution notes, all footage) is withheld.
//
//  ⚠️ CLIENT-SIDE ONLY. firestore.rules lets any signed-in user read all
//  tickets, so this is a display gate, not an authorisation one — the same
//  trade-off the public track page already makes (see the `TODO (security)`
//  note there). Enforcing it server-side is a separate, larger change.
// ==============================================================

/**
 * True when the superadmin has signed this ticket off.
 *
 * Case-insensitive, and a MISSING field is treated as NOT approved
 * (`'pending'`), which is the same default script.js uses — a legacy ticket
 * that predates the approval workflow must not be assumed approved.
 */
function isApprovedTicket(ticket) {
  if (!ticket) return false;
  return String(ticket.approvalStatus || 'pending').trim().toLowerCase() === 'approved';
}

/**
 * ⚠️ DOES THE EXPIRING VIEWING WINDOW APPLY TO WHO IS LOOKING?
 *
 * The 2-day window is the REQUESTER's condition, not an employee's: it exists
 * so a store manager reads a CCTV incident while it is fresh and then asks a
 * superadmin to reopen it if they still need it. HR are staff who review these
 * for a living, and a superadmin has permanent command-centre access anyway, so
 * for both roles the window is enforced nowhere useful — it only withheld the
 * report from someone whose job is to read it.
 *
 * ⚠️ IT IS DELIBERATELY NOT FOLDED INTO isOwnerTicketExpired(). That function
 * answers a factual question about a TICKET ("has its window closed?") and is
 * used by the row badges and the modal alike; mixing in "…and does the current
 * person care" would make it untestable in isolation and would silently change
 * what the pure-function tests assert. Keep the fact and the policy apart:
 *   isOwnerTicketExpired(ticket)  → the fact
 *   expiryAppliesToViewer()       → the policy
 */
function expiryAppliesToViewer() {
  return activeUserRole === 'owner';
}

/**
 * True when a approved ticket's viewing window has already lapsed FOR THE
 * CURRENT VIEWER. This is the predicate every UI decision uses, so HR and
 * superadmins never see an expiry — they simply get `false` here.
 */
function isOwnerTicketExpiredForViewer(ticket) {
  if (!expiryAppliesToViewer()) return false;
  return isOwnerTicketExpired(ticket);
}

/**
 * True when a approved ticket's viewing window has already lapsed.
 *
 * Delegates to the single source of truth in firebase.js rather than
 * re-deriving the arithmetic here, so the Area Manager and the public track
 * page can never disagree about when a ticket expires.
 */
function isOwnerTicketExpired(ticket) {
  if (typeof window.isTrackingAccessExpired !== 'function') return false;
  try {
    return !!window.isTrackingAccessExpired(ticket);
  } catch (e) {
    return false;
  }
}

/** The moment an approved ticket's window closes, or null when untracked. */
function ownerTicketExpiry(ticket) {
  if (typeof window.getTrackingAccessExpiry !== 'function') return null;
  try {
    return window.getTrackingAccessExpiry(ticket) || null;
  } catch (e) {
    return null;
  }
}

/**
 * The window's length as words — "1 minute" while time-compressed, "2 days"
 * in production. Read from firebase.js so reverting
 * TRACKING_ACCESS_WINDOW_MS rewords the UI automatically; never hardcoded.
 */
function ownerAccessWindowLabel() {
  if (typeof window.formatTrackingAccessWindow === 'function') {
    try {
      return window.formatTrackingAccessWindow(window.TRACKING_ACCESS_WINDOW_MS);
    } catch (e) { /* fall through */ }
  }
  return 'the approved window';
}

// ==============================================================
//  RE-ACCESS REQUEST (the Area Manager's "Request Access")
//
//  ⚠️ THE SUPERADMIN SIDE ALREADY EXISTS. `submit-ticket.html` files the same
//  request from the public Track page, and `script.js` renders it in Approvals
//  as the amber "Reopen requested" chip plus an **Approve Request & Resend**
//  button that opens a fresh window and flips status → 'fulfilled'. So this
//  does NOT invent a second workflow: it writes the identical two fields, and
//  the whole superadmin half — the desktop notification, the chip, the confirm
//  dialog that quotes the reason, the "Access Approved" email to
//  requestedByEmail — works unchanged.
//
//  The two fields, and why both are needed:
//    comments[]            a { type: 'access_reopen_request' } note
//                          → countAccessReopenRequests() in js/notifications.js
//                            counts these, so REPEATED asks still notify, while
//                            a Resend (which adds no note) never re-fires.
//    accessReopenRequest   the current state: status / reason / requester /
//                          requestCount — this is what the Approvals chip and
//                          the detail card read.
//
//  ⚠️ The email recipient is `requestedByEmail` FIRST (resolveReopenRecipient),
//  not the ticket's original reporter — a manager asking to re-open their own
//  branch's ticket is a different person from whoever filed it. That is exactly
//  why the account email is stored rather than reusing ticket.email.
// ==============================================================

/** This ticket's latest re-access request state, or null when there is none. */
function ownerReopenState(ticket) {
  if (!ticket) return null;
  const state = ticket.accessReopenRequest;
  return (state && typeof state === 'object') ? state : null;
}

/** True while a request is awaiting the superadmin's approval. */
function ownerReopenPending(ticket) {
  const state = ownerReopenState(ticket);
  return !!state && String(state.status || 'pending') === 'pending';
}

/** Every access_reopen_request note on a ticket, oldest first. */
function ownerReopenNotes(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  return comments.filter((c) => c && c.type === 'access_reopen_request');
}

/** The signed-in manager's display name, for `requestedBy`. */
function activeUserDisplayName() {
  if (ownerActiveUserName) return ownerActiveUserName;
  // Fall back to the account email, never a blank "Requester" — the superadmin
  // sees this string in the Approvals chip tooltip and the email recipient line.
  if (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) {
    return String(auth.currentUser.email);
  }
  return 'Area Manager';
}

/**
 * File a re-access request for an expired ticket. Shared by the modal form and
 * anything that wants to ask on the manager's behalf.
 *
 * Returns the promise so a caller can chain, and never throws: the UI reports a
 * failure through `ownerToast` and the inline error, not an unhandled rejection.
 */
function requestOwnerAccess(ticketId, reason) {
  const clean = String(reason || '').trim();
  if (!ticketId) return Promise.resolve(false);
  if (clean.replace(/\s+/g, '').length < 5) {
    ownerToast('Please tell us why you need access again (at least 5 characters).', 'error');
    return Promise.resolve(false);
  }
  if (!db || typeof db.collection !== 'function') {
    ownerToast('Could not send your request — try again.', 'error');
    return Promise.resolve(false);
  }

  const requestedByEmail = (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email)
    ? String(auth.currentUser.email)
    : '';
  const requestedBy = activeUserDisplayName();
  const when = new Date();

  return db.collection('tickets').doc(ticketId).get().then((snap) => {
    if (!snap || !snap.exists) throw new Error('ticket not found');
    const data = snap.data() || {};
    // Re-check the gate on the FRESH document. The button was rendered from a
    // read that may be a minute old, and a ticket that was just resent must
    // not accept a stale request (or one for a ticket that is not approved).
    if (!isOwnerTicketExpiredForViewer(data)) {
      throw new Error('not expired');
    }
    const note = {
      type: 'access_reopen_request',
      text: clean,
      requestedBy: requestedBy,
      requestedByEmail: requestedByEmail,
      requestedByContact: '',
      requestedAt: when
    };
    const prev = ownerReopenState(data);
    const prevCount = (prev && Number(prev.requestCount)) || 0;
    const reopenState = {
      status: 'pending',
      reason: clean,
      requestedBy: requestedBy,
      requestedByEmail: requestedByEmail,
      requestedByContact: '',
      requestedAt: when,
      // Monotonic, so the Approvals chip's ×N is the true number of asks even
      // if two requests are filed in quick succession.
      requestCount: prevCount + 1
    };
    return db.collection('tickets').doc(ticketId).update({
      comments: firebase.firestore.FieldValue.arrayUnion(note),
      accessReopenRequest: reopenState,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }).then(() => {
    ownerToast('Request sent — a superadmin will review it.', 'success');
    return true;
  }).catch((error) => {
    // A ticket that was reopened between render and click is not an error the
    // manager can act on, so it gets its own message.
    if (error && error.message === 'not expired') {
      ownerToast('Access was already reopened for this ticket.', 'info');
    } else {
      console.error('Re-access request error:', error);
      ownerToast('Failed to send your request. Please try again.', 'error');
    }
    return false;
  });
}

// ==============================================================
//  REQUEST ADDITIONAL FOOTAGE (Area Manager -> Operator hand-off)
//
//  ⚠️ THE OPERATOR HALF ALREADY EXISTS. The public Track page files the identical
//  request from submit-ticket.html (submitFootageRequest), and the app already
//  consumes it:
//    js/notifications.js  countFootageRequests() -> the 🎥 desktop notification
//    script.js            detects a prior footage_request on resolve, so the new
//                         clips are filed under `resolvedAdditionalFootage`
//    script.js            renders the request list in the operator's ticket modal
//  So this does NOT invent a second workflow: it writes the identical two fields
//  and the whole operator half works unchanged.
//
//  The write, deliberately identical to submit-ticket.html:
//    comments[]   a { type: 'footage_request' } note, appended with arrayUnion
//                 so REPEAT requests accumulate rather than overwrite
//    status       'Insufficient Footage' + approvalStatus 'pending' — this
//                 hands the ticket back to the operator AND un-approves it, so
//                 the Area Manager's own approved-only list drops the row until
//                 the operator re-resolves and a superadmin approves again.
//  ⚠️ The note `type` string is load-bearing: countFootageRequests() filters on
//  exactly 'footage_request', so a typo means the operator is never notified.
// ==============================================================

/** Every footage_request note on a ticket, oldest first. */
function ownerFootageNotes(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  return comments.filter((c) => c && c.type === 'footage_request');
}

/**
 * True while the ticket is sitting with the operator awaiting more footage.
 *
 * Count-based rather than "is there any note": an old, already-answered request
 * must not lock the manager out of asking again, so what matters is whether the
 * ticket is CURRENTLY parked in the footage-requested state.
 */
function ownerFootagePending(ticket) {
  if (!ticket) return false;
  const status = String(ticket.status || '').trim();
  const approval = String(ticket.approvalStatus || 'pending').trim().toLowerCase();
  return status === 'Insufficient Footage' && approval !== 'approved';
}

/**
 * File an "additional footage" request against a ticket.
 *
 * Returns the promise so a caller can chain, and never throws: the UI reports a
 * failure through `ownerToast`, not an unhandled rejection. Mirrors
 * requestOwnerAccess() above.
 */
function requestOwnerFootage(ticketId, details) {
  const clean = String(details || '').trim();
  if (!ticketId) return Promise.resolve(false);
  if (clean.replace(/\s+/g, '').length < 5) {
    ownerToast('Please describe what footage you need (at least 5 characters).', 'error');
    return Promise.resolve(false);
  }
  if (!db || typeof db.collection !== 'function') {
    ownerToast('Could not send your request — try again.', 'error');
    return Promise.resolve(false);
  }

  const requestedBy = activeUserDisplayName();
  const when = new Date();
  const note = {
    type: 'footage_request',
    text: clean,
    requestedBy: requestedBy,
    requestedAt: when
  };

  return db.collection('tickets').doc(ticketId).get().then((snap) => {
    if (!snap || !snap.exists) throw new Error('ticket not found');
    // Re-check on the FRESH document. The form was rendered from a read that may
    // be a minute old, and a ticket the operator has just re-resolved must not
    // accept a stale request that would undo their work.
    const data = snap.data() || {};
    if (!isApprovedTicket(data) && !ownerFootagePending(data)) {
      throw new Error('not available');
    }
    return db.collection('tickets').doc(ticketId).update({
      status: 'Insufficient Footage',
      approvalStatus: 'pending',
      comments: firebase.firestore.FieldValue.arrayUnion(note),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }).then(() => {
    ownerToast('Footage requested — the operator has been notified.', 'success');
    return true;
  }).catch((error) => {
    if (error && error.message === 'not available') {
      ownerToast('This ticket is no longer awaiting footage.', 'info');
    } else {
      console.error('Footage request error:', error);
      ownerToast('Failed to send your request. Please try again.', 'error');
    }
    return false;
  });
}

/**
 * Fill in the Tickets-tab sentence.
 *
 * Uses the same ownerAccessWindowLabel() the expiry notice uses, so the tab
 * blurb and the modal can never quote different windows. Runs from
 * setActiveUser() rather than at load, so it is correct on first paint and
 * after the page's scripts finish wiring.
 */
/**
 * ⚠️ The "Access" column and its filter are about the VIEWING WINDOW, so for
 * HR (and a superadmin) both are meaningless: nothing expires, so the column
 * would be a permanent dash and the filter would match nothing.
 *
 * The column is hidden with CSS rather than by omitting the <th>/<td>, because
 * test/owner-mobile.test.js requires the <th> count in the markup to equal the
 * <td data-label> count in the renderer — and both are STATIC. Dropping a cell
 * in one place and not the other renders an empty cell on a phone
 * (`content: attr(data-label)` on a cell with no attribute is an empty string).
 * "Access" is the 7th of 8 columns; see style in ownerdashboard.html.
 */
function applyViewerExpiryChrome() {
  const showsWindow = expiryAppliesToViewer();

  // The filter dropdown. Hidden rather than emptied: an <option> that can never
  // match is a control that lies about what it does.
  const accessFilterWrap = ownerTicketAccessFilter ? ownerTicketAccessFilter.closest('.filter-group') : null;
  if (ownerTicketAccessFilter) ownerTicketAccessFilter.style.display = showsWindow ? '' : 'none';
  if (accessFilterWrap) accessFilterWrap.style.display = showsWindow ? '' : 'none';

  const table = document.getElementById('ownerTicketsTable');
  if (table) table.classList.toggle('owner-hides-access', !showsWindow);

  renderOwnerWindowNote();
}

function renderOwnerWindowNote() {
  if (!ownerWindowNote) return;
  try {
    // ⚠️ Only the Area Manager has a window. Telling HR "each stays readable for
    // 2 days" on a page where nothing expires would be a false statement, so the
    // note is withheld rather than reworded.
    if (!expiryAppliesToViewer()) {
      ownerWindowNote.textContent = '';
      return;
    }
    // ⚠️ "AFTER YOU FIRST OPEN IT", NOT "after approval". The window starts
    // when the manager opens the ticket; before that there is no deadline at
    // all, so the old wording described a countdown that is not running yet.
    ownerWindowNote.textContent =
      'Once you open a ticket it stays readable for ' + ownerAccessWindowLabel() +
      '; after that the row remains but the report and evidence are withheld.';
  } catch (e) { /* the tab still works without the note */ }
}

/**
 * Split a ticket's files into the requester's original attachments and the
 * operator's added footage so the two never blend into one list:
 *  - requester files: `requesterAttachments` (written when the ticket is created)
 *  - operator footage: everything else (`resolution.operatorFootage`,
 *    `resolvedAdditionalFootage`)
 *  - legacy tickets that only carry a single merged list show it under the
 *    requester so nothing is hidden from the viewer.
 *
 * ⚠️ THE REQUESTER'S LIST IS AUTHORITATIVE. `requesterAttachments` is written
 * once at ticket creation from the manager's own upload array, so it is an exact
 * record of what THEY attached. This used to instead subtract `operatorFootage`
 * out of the merged list and call the remainder the manager's — which silently
 * re-attributed any clip missing from a truncated `operatorFootage` to the
 * manager. A manager then saw the operator's CCTV filed under "Requester's
 * Attachments". Reading the manager's list directly makes that unrepresentable,
 * and repairs the already-damaged tickets for free.
 *
 * `addedKeys` marks the clips that arrived in response to a footage request, so
 * the caller can ring them without splitting the list into two sections.
 */
function splitOwnerAttachments(rawData) {
  const resolution = (rawData && rawData.resolution) || {};
  let merged = Array.isArray(resolution.attachments) ? resolution.attachments.slice() : [];
  if (merged.length === 0 && rawData && Array.isArray(rawData.attachments)) {
    merged = rawData.attachments.slice();
  }
  if (merged.length === 0 && rawData && rawData.resolutionAttachmentUrl) {
    merged = [{
      secure_url: rawData.resolutionAttachmentUrl,
      name: rawData.resolutionAttachmentName || 'Resolution attachment',
      resource_type: 'raw',
      format: ''
    }];
  }

  let footage = Array.isArray(resolution.operatorFootage) ? resolution.operatorFootage.slice() : [];
  if (footage.length === 0 && rawData && Array.isArray(rawData.resolvedAdditionalFootage)) {
    footage = rawData.resolvedAdditionalFootage.slice();
  }

  const requester = (rawData && Array.isArray(rawData.requesterAttachments)) ? rawData.requesterAttachments.slice() : null;
  const keyOf = (a) => (a && (a.public_id || a.secure_url)) || '';
  const excludeKeys = (list) => new Set((list || []).map(keyOf).filter(Boolean));
  // The clips added in response to a footage request — a SUBSET of the operator's
  // footage, and the only thing that tells an added clip from an original one.
  const addedKeys = excludeKeys(Array.isArray(rawData && rawData.resolvedAdditionalFootage)
    ? rawData.resolvedAdditionalFootage : []);

  if (requester && requester.length > 0) {
    const requesterKeys = excludeKeys(requester);
    return {
      requester: requester,
      operator: merged.filter(a => !requesterKeys.has(keyOf(a))),
      addedKeys: addedKeys
    };
  }
  if (footage.length > 0) {
    const footageKeys = excludeKeys(footage);
    return {
      requester: merged.filter(a => !footageKeys.has(keyOf(a))),
      operator: footage,
      addedKeys: addedKeys
    };
  }
  return { requester: merged, operator: [], addedKeys: addedKeys };
}

window.openOwnerReport = function(reportId) {
  if (!reportId || !db) return;
  // Remembered for the delegated submit handler, which has no access to the
  // rendered form's markup. Cleared when the modal closes so a stale id can
  // never be written to after a different ticket is opened.
  ownerReopenTicketId = reportId;
  // Same for the footage form's delegated handler (see ownerFootageTicketId).
  ownerFootageTicketId = reportId;
  try { if (window.RefreshState) window.RefreshState.capture('owner', { tab: 'reports', modal: 'report', id: reportId }); } catch (e) { /* ignore */ }

  db.collection('tickets').doc(reportId).get().then(async (snap) => {
    if (!snap.exists) return;

    // Get full ticket data including attachments
    const rawData = snap.data();
    const data = normalizeTicketReport(rawData);

    // ⚠️ FIRST OPEN STARTS THE CLOCK.
    //
    // An approved ticket nobody has opened has NO expiry at all — it does not
    // lapse. This is where that clock begins: the first time THIS manager opens
    // the modal, `accessOpenedAt` is stamped and the window runs from that
    // moment onwards, continuously. Closing the modal stops nothing.
    //
    // ⚠️ ROLE-GATED. Only the Area Manager has a window (expiryAppliesToViewer()
    // is `activeUserRole === 'owner'`). HR and superadmins read these tickets for
    // a living; stamping on THEIR behalf would silently start — and burn — the
    // manager's window during someone else's review, which is the exact failure
    // this feature exists to prevent.
    if (expiryAppliesToViewer()
        && typeof window.markTrackingAccessOpened === 'function') {
        await window.markTrackingAccessOpened(rawData);
    }

    // Attachment cards come from the SHARED builder in js/attachment-viewer.js —
    // the same .attachment-item card the five grids in script.js render. This
    // used to be a local buildAttachmentRow() that emitted a bare icon chip
    // (owner-attachment-row) with NO thumbnail, plus a third getAttachmentColor
    // that disagreed with script.js's, so the same CCTV clip looked like a
    // thumbnail card on one dashboard and a grey icon row on the other.
    // Clicking a card opens the shared viewer.
    function buildAttachmentRow(att, index, added) {
        const v = window.AttachmentViewer;
        if (!v) return '';
        // `added` rings the clip as footage that arrived in response to a
        // request. The shared builder takes it as an OPT, so every other grid
        // that calls this same function is unaffected.
        return v.buildAttachmentCard(att, { index: index || 0, added: !!added });
    }
    // Split the ticket's files into requester attachments vs operator footage
    const attachments = splitOwnerAttachments(rawData);

    // Status badge in the modal header
    const statusText = String(data.status || 'Resolved');
    const statusClass = statusText.toLowerCase().replace(/\s+/g, '-');
    if (ownerReportDetailsStatus) {
      ownerReportDetailsStatus.textContent = statusText;
      ownerReportDetailsStatus.className = 'status-badge ' + statusClass;
      ownerReportDetailsStatus.style.display = 'inline-flex';
    }

    const resolution = (rawData && rawData.resolution) || {};
    // NOTE: the operator's identity (resolvedBy) is intentionally NOT shown to
    // owners here — their name/email is private. Only the timestamp + notes are
    // displayed in the Operator's Resolution card.
    const resolvedAt = formatDate(resolution.resolvedAt || rawData.resolvedAt || null);
    const resNotes = resolution.notes || rawData.resolutionNotes || 'No resolution notes provided.';

    // Render the file lists, skipping any broken entries (no link)
    const requesterFiles = attachments.requester.filter(a => a && (a.secure_url || a.url));
    const operatorFiles = attachments.operator.filter(a => a && (a.secure_url || a.url));
    const addedKeys = attachments.addedKeys || new Set();
    // ⚠️ `.map(fn)` would call fn(value, INDEX, THE WHOLE ARRAY) — and that third
    // argument is a truthy Array, so passing buildAttachmentRow straight to map
    // would ring EVERY clip as "added". Both groups are wrapped so the flag is
    // a real decision. Only the operator group is ever marked: the manager's own
    // uploads are the original request, never "added footage".
    const requesterAttHtml = requesterFiles.length > 0
      ? requesterFiles.map((a, i) => buildAttachmentRow(a, i, false)).join('')
      : '<p class="review-empty-files">No files available.</p>';
    const operatorAttHtml = operatorFiles.length > 0
      ? operatorFiles.map((a, i) => buildAttachmentRow(a, i, addedKeys.has(a.public_id || a.secure_url))).join('')
      : '<p class="review-empty-files">No files available.</p>';

    // ⚠️ THE EXPIRY GATE — the sensitive payload is withheld, not the row.
    //
    // An approved ticket whose viewing window has lapsed keeps its METADATA
    // (who, where, when, which incident) so the manager can still see that it
    // exists and chase it, but the issue description, the operator's findings
    // and EVERY attachment — the CCTV evidence — are the things the window
    // exists to protect, and none of them are rendered.
    //
    // It is checked HERE, at the point of rendering, not in the list: the list
    // is a live listener, so a ticket that expires while the page is open
    // would still be clickable, and a check on the row alone would then open
    // the full report for a ticket whose window closed a second ago.
    //
    // ⚠️ The withheld text must not leak through any other field: `resNotes`
    // and `data.description` are the two that carry findings, and both are only
    // interpolated inside the sections that this branch replaces wholesale.
    const expired = isOwnerTicketExpiredForViewer(rawData);
    const expiresAt = ownerTicketExpiry(rawData);
    const windowLabel = ownerAccessWindowLabel();

    // ===== The re-access request UI, shown inside the expired notice =====
    //
    // THREE states, so a manager is never asked to re-request something already
    // in flight (the Approvals chip would just show ×2 for the same ask):
    //   no request      → the reason form
    //   pending         → "Awaiting approval" (and the form is gone)
    //   fulfilled       → "Fulfilled — access resent on <date>"
    // A request already pending also means the ticket is ABOUT to be reopened,
    // so the form is hidden rather than disabled: a greyed button invites
    // people to click it twice.
    const reopen = ownerReopenState(rawData);
    const reopenPending = ownerReopenPending(rawData);
    const reopenNotes = ownerReopenNotes(rawData);
    const reopenFormHtml = reopenPending
      ? `<div class="owner-reopen-status pending">
           <i class="fas fa-hourglass-half"></i>
           Awaiting approval — a superadmin has your request and will reopen access if they approve it.
           ${reopen && reopen.requestedAt ? `<span class="owner-reopen-when">Requested ${escapeHTML(formatDate(reopen.requestedAt))}</span>` : ''}
         </div>`
      : `<form class="owner-reopen-form" id="ownerReopenForm">
           <label for="ownerReopenReason"><i class="fas fa-key"></i> Request to open this ticket again</label>
           <textarea id="ownerReopenReason" rows="3" maxlength="500"
                     placeholder="Why do you need this again? e.g. dispute follow-up, audit, insurance claim"></textarea>
           <div class="owner-reopen-actions">
             <span class="owner-reopen-hint">A superadmin reviews every request. Nothing is reopened automatically.</span>
             <button type="submit" class="btn btn-primary btn-sm" id="ownerReopenSubmit">
               <i class="fas fa-paper-plane"></i> Send request
             </button>
           </div>
         </form>`;

    // The history of previous asks, mirroring the public Track page. Only the
    // LATEST can still be pending; anything older was superseded.
    const reopenHistoryHtml = reopenNotes.length
      ? `<div class="owner-reopen-history">
           <h4>Request history</h4>
           ${reopenNotes.map((n, i) => {
             const isLatest = i === reopenNotes.length - 1;
             const fulfilled = !isLatest || String((reopen && reopen.status) || '') === 'fulfilled';
             return `<div class="owner-reopen-item">
               <div class="owner-reopen-item-text">Reason: ${escapeHTML(n.text || '—')}</div>
               <div class="owner-reopen-item-meta">
                 ${escapeHTML(n.requestedBy || 'Area Manager')}${n.requestedAt ? ' · ' + escapeHTML(formatDate(n.requestedAt)) : ''}
               </div>
               <div class="owner-reopen-status ${fulfilled ? 'fulfilled' : 'pending'}">
                 ${fulfilled ? 'Fulfilled' : 'Awaiting approval'}
               </div>
             </div>`;
           }).join('')}
         </div>`
      : '';

// ===== "Request Additional Footage" UI (NON-EXPIRED tickets only) =====
    //
    // TWO states, mirroring the re-access form above:
    //   no pending request → the details form
    //   pending            → "Awaiting additional footage" (the form is REPLACED,
    //                        not disabled — a greyed button invites a double click
    //                        and the operator gets asked for the same clip twice)
    //
    // ⚠️ Rendered in the NON-EXPIRED branch ONLY. On an expired ticket the whole
    // payload is withheld, so there is nothing here the manager could have found
    // insufficient; asking to see a closed ticket again is the re-access request's
    // job above, and offering both at once would be two doors to one problem.
    const footagePending = ownerFootagePending(rawData);
    const footageFormHtml = footagePending
      ? `<div class="owner-footage-status pending">
           <i class="fas fa-hourglass-half"></i>
           Awaiting additional footage — the operator has your request and will upload the missing clips.
         </div>`
      : `<form class="owner-footage-form" id="ownerFootageForm">
           <label for="ownerFootageDetails"><i class="fas fa-video"></i> Request additional footage</label>
           <textarea id="ownerFootageDetails" rows="3" maxlength="500"
                     placeholder="What is missing? e.g. the 7:15 PM clip of the till counter, entrance camera"></textarea>
           <div class="owner-footage-actions">
             <span class="owner-footage-hint">The operator is notified straight away. You can request again once they respond.</span>
             <button type="submit" class="btn btn-primary btn-sm" id="ownerFootageSubmit">
               <i class="fas fa-paper-plane"></i> Request footage
             </button>
           </div>
         </form>`;

    // What they already asked for, so a manager does not re-type the same request
    // after the operator responds. Independent of the pending state: an answered
    // ask stays visible, which is the whole point of keeping a history.
    const footageHistoryHtml = (function () {
      const notes = ownerFootageNotes(rawData);
      if (!notes.length) return '';
      return `<div class="owner-footage-history">
          <h4>Footage request history</h4>
          ${notes.map((n) => `
            <div class="owner-footage-item">
              <div class="owner-footage-item-text">${escapeHTML(n.text || '\u2014')}</div>
              <div class="owner-footage-item-meta">
                ${escapeHTML(n.requestedBy || 'Area Manager')}${n.requestedAt ? ' \u00b7 ' + escapeHTML(formatDate(n.requestedAt)) : ''}
              </div>
            </div>`).join('')}
        </div>`;
    })();
    const html = expired ? `
      <!-- ===== EXPIRED: metadata only, no payload ===== -->
      <div class="owner-access-expired">
        <p class="owner-access-expired-title"><i class="fas fa-lock"></i> Viewing access expired</p>
        <p class="owner-access-expired-body">
          The ${escapeHTML(windowLabel)} viewing window for this approved ticket has closed,
          so the report and its CCTV evidence are no longer available here.
          You can ask a superadmin to open it again.
        </p>
        ${expiresAt ? `<p class="owner-access-expired-when">Access closed ${escapeHTML(formatDate(expiresAt))}</p>` : ''}
        ${reopenFormHtml}
        ${reopenHistoryHtml}
      </div>

      <div class="review-card">
        <div class="review-card-header">
          <h3><i class="fas fa-ticket-alt"></i> Ticket Details</h3>
        </div>
        <div class="review-meta-grid">
          <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(data.ticketNumber || data.id || 'N/A')}</span></div>
          <div class="review-meta"><label>Branch</label><span>${escapeHTML(data.branchName)}</span></div>
          <div class="review-meta"><label>Reporter</label><span>${escapeHTML(data.authorName)}</span></div>
          <div class="review-meta"><label>Reported Date</label><span>${escapeHTML(formatDate(data.submittedAt))}</span></div>
          <div class="review-meta"><label>Incident</label><span>${escapeHTML(data.title)}</span></div>
          <div class="review-meta"><label>Priority</label><span>${escapeHTML(data.priority || '—')}</span></div>
          <div class="review-meta"><label>Status</label><span>${escapeHTML(data.status || 'Resolved')}</span></div>
          <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resolvedAt)}</span></div>
        </div>
        <div class="owner-withheld-note">
          <i class="fas fa-eye-slash"></i>
          Issue description, operator findings and all attachments are withheld while access is closed.
        </div>
      </div>
    ` : `
      <!-- ===== SECTION 1: REQUESTER'S ORIGINAL REQUEST (collapsible, on top) ===== -->
      <details class="review-collapse">
        <summary>
          <span class="review-collapse-title"><i class="fas fa-user-tie"></i> Requester's Original Request</span>
          <span class="review-collapse-sub"><i class="fas fa-user-circle"></i> Submitted by ${escapeHTML(data.authorName)}</span>
          <i class="fas fa-chevron-down review-collapse-caret"></i>
        </summary>
        <div class="review-collapse-body">
          <div class="review-meta-grid">
            <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(data.ticketNumber || data.id || 'N/A')}</span></div>
            <div class="review-meta"><label>Branch</label><span>${escapeHTML(data.branchName)}</span></div>
            <div class="review-meta"><label>Reporter</label><span>${escapeHTML(data.authorName)}</span></div>
            <div class="review-meta"><label>Reported Date</label><span>${escapeHTML(formatDate(data.submittedAt))}</span></div>
            <div class="review-meta"><label>Incident</label><span>${escapeHTML(data.title)}</span></div>
            <div class="review-meta"><label>Incident Date</label><span>${escapeHTML(data.datetime || data.dateTime || '—')}</span></div>
            <div class="review-meta"><label>Location</label><span>${escapeHTML(data.location || '—')}</span></div>
            <div class="review-meta"><label>Priority</label><span>${escapeHTML(data.priority || '—')}</span></div>
            <div class="review-meta"><label>Position</label><span>${escapeHTML(data.position || '—')}</span></div>
            <div class="review-meta"><label>Contact</label><span>${escapeHTML(data.contact || '—')}</span></div>
            <div class="review-meta full"><label>Email</label><span>${escapeHTML(data.email || '—')}</span></div>
            <div class="review-meta full"><label>Issue Description</label><p class="review-note">${escapeHTML(data.description || 'No description provided.')}</p></div>
          </div>
          <div class="review-attachments-label"><i class="fas fa-paperclip"></i> Requester's Attachments <span>(${requesterFiles.length})</span></div>
          <div class="owner-attachment-list">${requesterAttHtml}</div>
        </div>
      </details>

      <!-- ===== SECTION 2: OPERATOR'S RESOLUTION ===== -->
      <div class="review-card operator">
        <div class="review-card-header">
          <h3><i class="fas fa-video"></i> Operator's Resolution Report</h3>
        </div>
        <div class="review-meta-grid">
          <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resolvedAt)}</span></div>
          <div class="review-meta"><label>Status</label><span>${escapeHTML(data.status || 'Resolved')}</span></div>
          <div class="review-meta full"><label>Action Taken / Findings</label><p class="review-note">${escapeHTML(resNotes)}</p></div>
        </div>
        <!-- ⚠️ WAS "Operator's Added Footage". Now that clips added in response to
             a footage request carry their own ring + badge, calling the WHOLE list
             "added" would contradict the marking inside it — the original clips
             are not added. The manager's own heading is untouched. -->
        <div class="review-attachments-label"><i class="fas fa-film"></i> Operator's Resolution Footage <span>(${operatorFiles.length})</span></div>
        <div class="owner-attachment-list">${operatorAttHtml}</div>
      </div>

      <!-- ===== SECTION 3: REQUEST ADDITIONAL FOOTAGE ===== -->
      <div class="review-card owner-footage-card">
        <div class="review-card-header">
          <h3><i class="fas fa-video"></i> Need More Footage?</h3>
        </div>
        ${footageFormHtml}
        ${footageHistoryHtml}
      </div>
    `;

    if (ownerReportModalBody) ownerReportModalBody.innerHTML = html;
    if (ownerReportModal) ownerReportModal.classList.add('active');
  }).catch((error) => {
    console.error('Failed to open report:', error);
  });
};

/**
 * Submit handler for the "Request to open this ticket again" form.
 *
 * DELEGATED from the modal body, and bound ONCE, because the body is
 * re-rendered on every open: a listener attached to the form itself would be
 * discarded each time, and one attached inside the render would stack up.
 *
 * Re-reads the ticket and re-renders afterwards so the row flips to the amber
 * "Reopen requested" chip immediately — the manager should not have to close
 * and reopen the modal to see that their request landed.
 */
function handleOwnerReopenSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form || form.id !== 'ownerReopenForm') return;

  const reasonEl = $owner('ownerReopenReason');
  const reason = reasonEl ? reasonEl.value : '';
  const ticketId = ownerReopenTicketId;
  if (!ticketId) {
    ownerToast('Could not tell which ticket this is. Close and reopen it.', 'error');
    return;
  }

  const btn = $owner('ownerReopenSubmit');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  }

  requestOwnerAccess(ticketId, reason).then((ok) => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    if (ok) {
      // Re-render from the fresh document so the pending state is real data,
      // not an optimistic guess — a request that was recorded server-side is
      // what must be shown.
      window.openOwnerReport(ticketId);
    }
  });
}

/**
 * Submit handler for the "Request additional footage" form.
 *
 * DELEGATED from the modal body and bound ONCE, for the same reason as
 * handleOwnerReopenSubmit above: the body is re-rendered on every open, so a
 * listener bound inside the render would stack up and file one request per open.
 *
 * The guard on the form id is load-bearing now that BOTH forms are delegated from
 * the same element — without it, submitting the footage form would fall into the
 * re-access handler (and vice versa) and write the wrong workflow.
 */
function handleOwnerFootageSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form || form.id !== 'ownerFootageForm') return;

  const detailsEl = $owner('ownerFootageDetails');
  const details = detailsEl ? detailsEl.value : '';
  const ticketId = ownerFootageTicketId;
  if (!ticketId) {
    ownerToast('Could not tell which ticket this is. Close and reopen it.', 'error');
    return;
  }

  const btn = $owner('ownerFootageSubmit');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  }

  requestOwnerFootage(ticketId, details).then((ok) => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    if (ok) {
      // Re-render from the fresh document so the "Awaiting additional footage"
      // state is real data, not an optimistic guess.
      window.openOwnerReport(ticketId);
    }
  });
}

function closeOwnerReportModalFn() {
  if (ownerReportModal) ownerReportModal.classList.remove('active');
  // The re-access form's ticket id is only valid while the modal is open.
  ownerReopenTicketId = '';
  // Same for the footage form — a stale id must never outlive the modal.
  ownerFootageTicketId = '';
  try { if (window.RefreshState) window.RefreshState.clearModal('owner'); } catch (e) { /* ignore */ }
}

/**
 * Load the tickets scoped to the branches this owner owns / has access to.
 * Superadmins see tickets for every branch; owners/editors/viewers only see
 * tickets from their assigned (owned) branches.
 */
function renderOwnerTickets(allTickets) {
  try {
    if (!ownerTicketsBody) return;

    if (!db || typeof db.collection !== 'function') {
      ownerTicketsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><em>Firebase is unavailable.</em></td></tr>';
      return;
    }

    // Branch owners, HR and superadmins may only view APPROVED tickets.
    // HR is deliberately included: it is an owner in every respect except
    // chat access, so it must not gain a wider ticket scope by accident.
    const ownerResolvedOnly = activeUserRole === 'owner' || activeUserRole === 'hr' || activeUserIsSuperAdmin;

    // ⚠️ THE ACCESS SPLIT — expired vs not expired. Plain labels, no counts.
    // 'all' is the default so nothing disappears on load, and an unrecognised
    // value falls through to "show everything" so an <option> added to the
    // markup before this script is updated cannot blank the list.
    const selectedAccess = ownerTicketAccessFilter ? ownerTicketAccessFilter.value : 'all';
    const selectedPriority = ownerTicketPriorityFilter ? ownerTicketPriorityFilter.value : 'all';
    const selectedBranch = ownerTicketBranchFilter ? ownerTicketBranchFilter.value : '';
    const searchText = ownerTicketSearch ? ownerTicketSearch.value.trim().toLowerCase() : '';

    const allRaw = Array.isArray(allTickets) ? allTickets : [];
    let tickets = allRaw.map((doc) => normalizeTicketReport(doc));

    // ⚠️ THE APPROVAL GATE. A ticket is only shown once the SUPERADMIN has
    // approved it. `status === 'Resolved'` alone is NOT that signal — it also
    // matches work still queued for review ('pending_approval') and work sent
    // back for revision ('rejected'), neither of which the manager should be
    // reading. An expired-but-approved ticket is deliberately NOT filtered out
    // here: it stays listed, badged, with its content withheld (openOwnerReport).
    if (ownerResolvedOnly) {
      tickets = tickets.filter((t) => isApprovedTicket(t));
    }

    // The Resolved-only scope, kept EXPLICIT rather than left implicit in the
    // approval gate above. test/chat-ticket-mentions.test.js asserts this exact
    // line, because js/chat.js's @ticket picker mirrors the same scope.
    let selectedStatus = 'all';
    if (ownerResolvedOnly) selectedStatus = 'Resolved';

    // Restrict to the owner's assigned branches (superadmin sees all branches).
    const allowedBranches = activeUserIsSuperAdmin ? ownerAllBranches : ownerAssignedBranches;
    tickets = tickets.filter((t) => {
      const branch = String(t.branch || t.branchName || '').trim();
      return allowedBranches.includes(branch);
    });

    if (selectedBranch) {
      tickets = tickets.filter((t) => String(t.branch || t.branchName || '').trim() === selectedBranch);
    }

    if (selectedStatus !== 'all') {
      tickets = tickets.filter((t) => String(t.status || 'Pending').trim() === selectedStatus);
    }

    if (selectedPriority !== 'all') {
      tickets = tickets.filter((t) => String(t.priority || 'Low').trim() === selectedPriority);
    }

    if (searchText) {
      tickets = tickets.filter((t) => {
        const haystack = [
          t.ticketNumber, t.title, t.incident, t.authorName, t.author,
          t.reporter, t.name, t.branch, t.branchName, t.description, t.location
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(searchText);
      });
    }

    // ⚠️ The EXPIRED predicate is the SAME helper the row badges use, so the
    // filter and the badge can never disagree about which rows are expired.
    const accessMatches = (t) => {
      if (selectedAccess === 'active') return !isOwnerTicketExpiredForViewer(t);
      if (selectedAccess === 'expired') return isOwnerTicketExpiredForViewer(t);
      return true;
    };
    tickets = tickets.filter(accessMatches);

    tickets.sort((a, b) => {
      const aTime = a.submittedAt && a.submittedAt.toDate ? a.submittedAt.toDate().getTime() : new Date(a.submittedAt || 0).getTime();
      const bTime = b.submittedAt && b.submittedAt.toDate ? b.submittedAt.toDate().getTime() : new Date(b.submittedAt || 0).getTime();
      return bTime - aTime;
    });

    if (!tickets.length) {
      // The copy names the gate, because "no tickets found" while tickets
      // plainly exist in the system (just not approved yet) reads as a bug.
      const emptyText = ownerResolvedOnly
        ? 'No approved tickets yet. A ticket appears here once the superadmin approves it.'
        : 'No tickets found for your branches.';
      ownerTicketsBody.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="fas fa-ticket-alt"></i><p>${escapeHTML(emptyText)}</p></td></tr>`;
      return;
    }
    ownerTicketsBody.innerHTML = tickets.map((t) => {
      const status = String(t.status || 'Pending');
      const statusClass = status.toLowerCase().replace(/\s+/g, '-');
      const priority = String(t.priority || 'Low').toLowerCase();
      const dotClass = priority === 'high' ? 'high' : 'low';
      const createdDate = t.submittedAt?.toDate ? formatDate(t.submittedAt.toDate()) : formatDate(t.submittedAt);
      // The approved-but-lapsed case. The row STAYS (so the manager can see
      // that a ticket exists and that its window closed) and is badged, rather
      // than vanishing and looking like data loss. `.status-badge.expired`
      // already exists in style.css for the Approvals table, so this reuses
      // that exact treatment instead of inventing a second one.
      const expired = isOwnerTicketExpiredForViewer(t);
      const expiresAt = expired ? ownerTicketExpiry(t) : null;
      const expiryTitle = expired && expiresAt
        ? 'Viewing access closed ' + formatDate(expiresAt)
        : 'Approved — viewing access closed';

      // ⚠️ APPROVED BUT NOT YET OPENED. Not expired, and there is no date to
      // show: the window has not started. It gets its own quiet label because
      // the neighbouring states are misleading without it — a muted dash reads
      // as "nothing to report", when in fact this ticket's clock is simply
      // waiting on the manager. Anything that rendered an "Until <date>" here
      // would be inventing a deadline out of nothing.
      const awaitingFirstOpen = !expired
        && expiryAppliesToViewer()
        && typeof window.trackingAccessStartsOnOpen === 'function'
        && window.trackingAccessStartsOnOpen(t)
        && !(typeof window.getTrackingAccessOpenedAt === 'function'
             && window.getTrackingAccessOpenedAt(t));

      // A PENDING re-access request swaps the red "Expired" badge for the amber
      // "Reopen requested" chip — the exact treatment script.js already uses in
      // the Approvals table, including the ×N count. The manager's own list and
      // the superadmin's list then say the same thing about the same ticket, and
      // the chip replaces the badge rather than sitting beside it so the row
      // stays one line tall.
      const reopen = ownerReopenState(t);
      const reopenPending = ownerReopenPending(t);
      const reopenCount = (reopen && Number(reopen.requestCount)) || 0;
      const reopenTitle = 'Reopen requested'
        + (reopenCount > 1 ? ' ×' + reopenCount : '')
        + (reopen && reopen.reason ? ' — Reason: ' + reopen.reason : '')
        + (expiresAt ? ' · Access closed ' + formatDate(expiresAt) : '')
        + ' · Awaiting superadmin approval';

      // ⚠️ TWO CELLS, NOT ONE. "Status" (where is this in the resolution
      // pipeline) and "Access" (can this person still OPEN it) are orthogonal
      // questions, and they were sharing a single cell under one heading. Two
      // badges side by side under the label "Status" is why this read as
      // cluttered: the LABEL was doing the damage, not the badges.
      //
      // `.status-badge.expired` is kept as the CLASS even though the visible
      // word is now "Access closed": that class is shared with the superadmin
      // Approvals table, and test/owner-ticket-approval.test.js pins it by name.
      // Only the WORD changes — the class is a machine-readable hook, and
      // renaming it here would be a breaking change for code this page does
      // not own.
      let accessCell;
      if (reopenPending && expiryAppliesToViewer()) {
        // The amber chip REPLACES the red one, as before — the manager asked,
        // so "expired" alone would be a downgrade in meaning.
        accessCell = `<span class="access-reopen-badge" title="${escapeHTML(reopenTitle)}">`
          + `<i class="fas fa-envelope-open-text"></i> Reopen requested`
          + (reopenCount > 1 ? ` ×${reopenCount}` : '')
          + `</span>`;
      } else if (expired) {
        accessCell = `<span class="status-badge expired" title="${escapeHTML(expiryTitle)}">`
          + `Access closed</span>`;
      } else if (awaitingFirstOpen) {
        // Sits between "expired" and the neutral dash. It is NOT a green "Open"
        // badge: opening is what starts the clock, so calling it open would be
        // a promise the ticket is not yet making.
        accessCell = '<span class="owner-access-none" title="'
          + escapeHTML('Approved — your viewing window starts when you first open it')
          + '">Not yet opened</span>';
      } else {
        // A muted dash rather than a green "Open" badge. Most rows ARE open, so
        // a badge on every row is noise that says nothing — the Access column
        // should light up only when it has something to report. This matches
        // the Approvals table's own "no tracking window" convention.
        accessCell = '<span class="owner-access-none">&mdash;</span>';
      }

      // ⚠️ THE NOTE IS WHY A `title` ATTRIBUTE IS NOT ENOUGH. Everything that
      // explains the access state — when it closed, and the reason the manager
      // gave for asking again — lives in `title`, and a PHONE HAS NO HOVER. So
      // on a phone the badge was a bare unexplained word. The card layout has
      // vertical room, so the detail is rendered as real text there. It stays
      // `display: none` on the desktop table, which must keep one line per row.
      let accessNote = '';
      if (reopenPending && reopen && reopen.reason && expiryAppliesToViewer()) {
        accessNote = '<div class="owner-access-note">' + escapeHTML(reopen.reason) + '</div>';
      } else if (expired && expiresAt) {
        accessNote = '<div class="owner-access-note">Viewing closed '
          + escapeHTML(formatDate(expiresAt)) + '</div>';
      }

      const statusCell = `<span class="status-badge ${expired ? 'resolved' : statusClass}">`
        + escapeHTML(status) + '</span>';
      return `
      <tr onclick="window.openOwnerReport('${escapeHTML(t.id)}')">
        <td data-label="Ticket"><span class="priority-dot"><span class="dot ${dotClass}"></span><span class="ticket-link">${escapeHTML(t.ticketNumber)}</span></span></td>
        <td data-label="Created">${escapeHTML(createdDate)}</td>
        <td data-label="Branch">${escapeHTML(t.branchName)}</td>
        <td data-label="Reporter">${escapeHTML(t.authorName)}</td>
        <td data-label="Incident">${escapeHTML(t.title)}</td>
        <td data-label="Status">${statusCell}</td>
        <td data-label="Access">${accessCell}${accessNote}</td>
        <td>
          <div class="action-stack compact">
            <button type="button" class="btn btn-icon action-btn view" data-tooltip="${expired ? 'View details (access closed)' : 'View'}">
              <i class="fas fa-eye"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
    }).join('');

    if (ownerTicketPagination) {
      ownerTicketPagination.innerHTML = `<span class="page-info">${tickets.length} ticket(s)</span>`;
    }
  } catch (error) {
    console.error('Failed to render owner tickets:', error);
    if (ownerTicketsBody) {
      ownerTicketsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><em>Unable to load tickets.</em></td></tr>';
    }
  }
}

let ownerTicketListenerStarted = false;
let ownerAllTicketsCache = [];

/**
 * Initial load used only as a fallback when the realtime listener is unavailable.
 */
async function loadOwnerTickets() {
  try {
    if (!ownerTicketsBody) return;

    if (!db || typeof db.collection !== 'function') {
      ownerTicketsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><em>Firebase is unavailable.</em></td></tr>';
      return;
    }

    const snapshot = await db.collection('tickets').get();
    const allTickets = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    ownerAllTicketsCache = allTickets;
    renderOwnerTickets(allTickets);
    // Same deep link as the listener path: this is the fallback when
    // firestoreService.listenTickets is unavailable, and a manager who arrived
    // from the approval email must not be silently ignored just because the
    // realtime listener was not available.
    applyOwnerDeepLink(allTickets);
  } catch (error) {
    console.error('Failed to load owner tickets:', error);
    if (ownerTicketsBody) {
      ownerTicketsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><em>Unable to load tickets.</em></td></tr>';
    }
  }
}

/**
 * Real-time listener: every time a ticket is added, modified, or removed, the
 * ticket list re-renders automatically — so new tickets appear instantly
 * without any Refresh button.
 */
function setupOwnerTicketListener() {
  if (ownerTicketListenerStarted) return;
  ownerTicketListenerStarted = true;

  if (!window.firestoreService || typeof window.firestoreService.listenTickets !== 'function') {
    loadOwnerTickets();
    return;
  }

  window.firestoreService.listenTickets(
    (allTickets) => {
      ownerAllTicketsCache = allTickets;
      renderOwnerTickets(allTickets);
      // The approval-email deep link can only be resolved once the real ticket
      // list has arrived - the branch allowlist AND the approved-only filter
      // both live off this data, so there is nothing to check before this.
      // applyOwnerDeepLink() consumes the link, so later snapshots no-op.
      applyOwnerDeepLink(allTickets);
    },
    (error) => {
      console.error('Owner ticket listener error:', error);
    }
  );
}

function bindOwnerEvents() {
  ownerNavItems.forEach((item) => {
    item.addEventListener('click', () => {
      switchOwnerTab(item.dataset.tab);
      // Close the mobile drawer after choosing a tab.
      document.body.classList.remove('mobile-nav-open');
    });
  });

  ownerTicketSearch?.addEventListener('input', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketAccessFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketPriorityFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketBranchFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  closeOwnerReportModal?.addEventListener('click', closeOwnerReportModalFn);

  // The re-access form is re-created on every modal open, so its submit is
  // DELEGATED from the body and bound exactly once here. Binding it inside the
  // render would attach a second listener each time the modal opened, firing
  // the request N times for N opens.
  ownerReportModalBody?.addEventListener('submit', handleOwnerReopenSubmit);
  // The footage form is re-created on every modal open for the same reason, so it
  // is delegated and bound once here too. Both handlers guard on their own form
  // id, so sharing this one listener element is safe.
  ownerReportModalBody?.addEventListener('submit', handleOwnerFootageSubmit);

  ownerReportModal?.addEventListener('click', (e) => {
    if (e.target === ownerReportModal) closeOwnerReportModalFn();
  });

  ownerLogoutBtn?.addEventListener('click', async () => {
    try {
      if (window.RefreshState) window.RefreshState.clearPage('owner');
      await auth.signOut();
      window.location.href = 'login.html';
    } catch (error) {
      console.error('Logout error:', error);
      ownerToast('Failed to log out.', 'error');
    }
  });
}

bindOwnerEvents();

// ===== Mobile navigation drawer (hamburger + backdrop) =====
(function initMobileOwnerNav() {
  const toggle = document.getElementById('ownerSidebarToggle');
  const backdrop = document.getElementById('ownerSidebarBackdrop');
  const close = () => document.body.classList.remove('mobile-nav-open');

  if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('mobile-nav-open'));
  if (backdrop) backdrop.addEventListener('click', close);
})();

auth.onAuthStateChanged(async (user) => {
  if (user) {
    clearTimeout(window.__ownerLoginTimer);

    // Restore the open report modal right away — its content loads directly from
    // Firestore and does not depend on the branch/user lookups below, so it
    // reappears immediately instead of popping in only after the page finishes
    // loading (part of the "refresh trail" on this screen).
    if (!ownerStateRestored) {
      try {
        const early = (window.RefreshState && window.RefreshState.restore('owner')) || {};
        if (early.modal === 'report' && early.id && typeof window.openOwnerReport === 'function') {
          window.openOwnerReport(early.id);
        }
      } catch (e) { /* ignore */ }
    }

    if (ownerUserEmail) ownerUserEmail.textContent = user.email;

    try {
      await loadBranches();
      await loadActiveUserPermissions(user);

      // ===== Role guard: this page is NOT the superadmin's dashboard =====
      // ⚠️ Operators AND superadmins both belong in the main Command Center.
      //
      // This used to bounce OPERATORS ONLY, which stranded superadmins here.
      // That was reachable because the approval email links to
      // `ownerdashboard.html?ticket=…`, and `js/auth.js` honours `?next=` before
      // a superadmin's `main.html` default — so a superadmin who followed an
      // approval link landed here and could never get back: this page only has
      // Overview / Tickets / Violations, while Ticket Reviews and User Approvals
      // live on main.html. The symptom was "my superadmin dashboard is missing a
      // tab".
      //
      // HR is deliberately NOT redirected — HR belongs here (same page as an
      // owner; only the profile label and chat access differ).
      if (activeUserRole === 'operator' || activeUserRole === 'superadmin') {
        // Carry `?ticket=` across so the Command Center can open the SAME ticket
        // this link was pointing at. Without it the redirect silently discards
        // the whole reason the user followed the link. Consume it first so the
        // listener below can never also fire it on this page.
        const deepTicket = ownerDeepLinkTicket;
        ownerDeepLinkTicket = '';
        window.location.href = deepTicket
          ? 'main.html?ticket=' + encodeURIComponent(deepTicket)
          : 'main.html';
        return;
      }
    } catch (error) {
      console.error('Owner dashboard Firebase init failed:', error);
    }

    // ===== Real-time tickets: re-render automatically when a new ticket arrives =====
    setupOwnerTicketListener();

    // ===== Refresh resilience: stay on the current owner tab/filter after refresh =====
    // Only runs on the first auth callback of a page load (see ownerStateRestored).
    if (!ownerStateRestored) {
      try {
        const savedOwner = (window.RefreshState && window.RefreshState.restore('owner')) || {};
        // 'violations' is the HR-only transferred-violations tab.
        const OWNER_VALID_TABS = ['overview', 'tickets', 'violations'];
        if (savedOwner.tab && OWNER_VALID_TABS.includes(savedOwner.tab)) {
          switchOwnerTab(savedOwner.tab);
        }
        ownerStateRestored = true;
      } catch (e) {
        console.error('Owner restore-state error:', e);
      }
    }
  } else {
    // Never bounce to login.html instantly on a transient `null` auth callback —
    // Firebase can fire it while the persisted session is still being restored,
    // which would show a refresh trail to the login page and straight back.
    // Only redirect when no session actually materialises.
    clearTimeout(window.__ownerLoginTimer);
    window.__ownerLoginTimer = setTimeout(() => {
      if (!auth.currentUser) window.location.href = 'login.html';
    }, 1500);
  }
});
