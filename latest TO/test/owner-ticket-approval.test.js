// Functional test for the AREA MANAGER ticket list: superadmin-APPROVED only,
// and an expiring viewing window on the approved ticket.
//
// THE RULE BEING TESTED. The ticket lifecycle (script.js) is:
//
//    operator resolves   → status 'Resolved', approvalStatus 'pending_approval'
//    superadmin approves → approvalStatus 'approved'  (+ accessExpiresAt)
//
// So `status === 'Resolved'` is NOT the approval signal: it also matches work
// still queued for review and work sent back for revision. The list must gate
// on `approvalStatus === 'approved'`, and an approved-but-LAPSED ticket stays
// in the list, badged, with its report + CCTV evidence withheld.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

console.log('Testing the Area Manager ticket approval + expiry gate...');

/** Extract a named top-level function (brace-matched) from the source. */
function extractFn(name) {
    const start = ownerJs.indexOf('function ' + name + '(');
    assert(start > -1, name + '() not found in js/owner-dashboard.js');
    let depth = 0;
    for (let j = ownerJs.indexOf('{', start); j < ownerJs.length; j++) {
        if (ownerJs[j] === '{') depth++;
        else if (ownerJs[j] === '}') {
            depth--;
            if (depth === 0) return ownerJs.slice(start, j + 1);
        }
    }
    throw new Error('could not find the end of ' + name + '()');
}

const HOUR = 60 * 60 * 1000;

// The expiry helpers are DELEGATED to firebase.js in the browser, so the
// sandbox supplies stand-ins with the same semantics. Mirroring them here is
// deliberate: these assertions are about owner-dashboard.js's decisions, and
// firebase.js's own arithmetic is covered by test/tracking-access.test.js.
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`
  var TRACKING_ACCESS_WINDOW_MS = ${HOUR};
  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function getTrackingAccessExpiry(t) {
    if (!t) return null;
    if ((t.approvalStatus || 'pending') !== 'approved') return null;
    var stored = toDate(t.accessExpiresAt);
    if (stored) return stored;
    var approved = toDate(t.approvedAt);
    if (!approved) return null;
    return new Date(approved.getTime() + TRACKING_ACCESS_WINDOW_MS);
  }
  function isTrackingAccessExpired(t, now) {
    var e = getTrackingAccessExpiry(t);
    if (!e) return false;
    var ref = now ? toDate(now) : new Date();
    return e.getTime() <= (ref ? ref.getTime() : Date.now());
  }
  function formatTrackingAccessWindow(ms) {
    var v = Number(ms) > 0 ? Number(ms) : TRACKING_ACCESS_WINDOW_MS;
    var minutes = Math.round(v / 60000);
    if (minutes < 60) return minutes === 1 ? '1 minute' : minutes + ' minutes';
    var hours = Math.round(v / 3600000);
    if (hours < 48) return hours === 1 ? '1 hour' : hours + ' hours';
    var days = Math.round(v / 86400000);
    return days === 1 ? '1 day' : days + ' days';
  }

  ${extractFn('isApprovedTicket')}
  ${extractFn('isOwnerTicketExpired')}
  ${extractFn('ownerTicketExpiry')}
  ${extractFn('ownerAccessWindowLabel')}

  globalThis.__api = {
    isApprovedTicket: isApprovedTicket,
    isOwnerTicketExpired: isOwnerTicketExpired,
    ownerTicketExpiry: ownerTicketExpiry,
    ownerAccessWindowLabel: ownerAccessWindowLabel
  };
`, sandbox);

const api = sandbox.__api;
assert(api, 'the approval/expiry helpers were not loaded into the sandbox');

// ---------------------------------------------------------------------------
// 1. isApprovedTicket() — the approval gate itself.
// ---------------------------------------------------------------------------
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'approved' }), true,
    'an approved ticket must pass the gate');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'APPROVED' }), true,
    'approval must be case-insensitive');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: '  approved  ' }), true,
    'a padded approval must pass');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'pending_approval' }), false,
    'a ticket still QUEUED for the superadmin must NOT pass — this is the whole point');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'rejected' }), false,
    'a ticket sent back for revision must NOT pass');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'pending' }), false, 'a pending ticket must NOT pass');
// A legacy ticket that predates the approval workflow has NO field. It must
// default to NOT approved — assuming otherwise would leak unapproved work.
assert.strictEqual(api.isApprovedTicket({}), false,
    'a ticket with no approvalStatus must NOT be treated as approved');
assert.strictEqual(api.isApprovedTicket(null), false, 'null must be rejected');
assert.strictEqual(api.isApprovedTicket(undefined), false, 'undefined must be rejected');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'approved-ish' }), false,
    'a near-miss value must NOT pass');
console.log('  PASS  the approval gate: approved only, legacy/unknown defaults to NOT approved');

// ---------------------------------------------------------------------------
// 2. The helpers DELEGATE to firebase.js rather than re-deriving the
//    arithmetic, so the manager and the public track page cannot disagree.
// ---------------------------------------------------------------------------
assert(
    /window\.isTrackingAccessExpired\(ticket\)/.test(extractFn('isOwnerTicketExpired')),
    'isOwnerTicketExpired() must delegate to window.isTrackingAccessExpired() — re-deriving the ' +
    'arithmetic here is how the two surfaces would drift apart'
);
assert(
    /window\.getTrackingAccessExpiry\(ticket\)/.test(extractFn('ownerTicketExpiry')),
    'ownerTicketExpiry() must delegate to window.getTrackingAccessExpiry()'
);
assert(
    /window\.formatTrackingAccessWindow\(window\.TRACKING_ACCESS_WINDOW_MS\)/.test(extractFn('ownerAccessWindowLabel')),
    'ownerAccessWindowLabel() must read the window from firebase.js, never hardcode "2 days" — the ' +
    'window is time-compressed to 1 minute for testing and the copy must follow it'
);

// ---------------------------------------------------------------------------
// 3. Expiry semantics: approved + lapsed => expired; everything else not.
//    Dates are relative to the REAL clock, because the helper takes no "now".
// ---------------------------------------------------------------------------
const realNow = Date.now();
const lapsed = new Date(realNow - HOUR);
const live = new Date(realNow + HOUR);

assert.strictEqual(api.isOwnerTicketExpired({ approvalStatus: 'approved', accessExpiresAt: lapsed }), true,
    'an APPROVED ticket whose window has closed must be expired');
assert.strictEqual(api.isOwnerTicketExpired({ approvalStatus: 'approved', accessExpiresAt: live }), false,
    'an approved ticket still inside its window must NOT be expired');
assert.strictEqual(
    api.isOwnerTicketExpired({ status: 'Resolved', approvalStatus: 'pending_approval', accessExpiresAt: lapsed }),
    false,
    'a ticket that was never approved must never report expired — there was no window to lapse'
);
assert.strictEqual(
    api.isOwnerTicketExpired({ approvalStatus: 'approved' }),
    false,
    'an approved ticket with no derivable window (no accessExpiresAt, no approvedAt) must not be expired'
);
assert.strictEqual(api.isOwnerTicketExpired({}), false, 'an empty ticket must not be expired');
assert.strictEqual(api.isOwnerTicketExpired(null), false, 'null must not be expired');
assert.strictEqual(
    api.isOwnerTicketExpired({ approvalStatus: 'approved', approvedAt: new Date(realNow - 2 * HOUR) }),
    true,
    'a legacy approved ticket (no accessExpiresAt) must fall back to approvedAt + window and expire'
);
assert.strictEqual(api.ownerAccessWindowLabel(), '1 hour',
    'the label must describe the CONFIGURED window (the sandbox uses 1 hour)');
assert.strictEqual(api.ownerTicketExpiry({ approvalStatus: 'approved', accessExpiresAt: live }).getTime(),
    live.getTime(), 'ownerTicketExpiry() must return the stored expiry');
console.log('  PASS  expiry semantics, including the legacy approvedAt fallback and the unapproved case');

// ---------------------------------------------------------------------------
// 4. STATIC GUARDS — the gates must be wired where the browser runs them.
// ---------------------------------------------------------------------------
const listSrc = extractFn('renderOwnerTickets');
assert(
    /if \(ownerResolvedOnly\) \{\s*tickets = tickets\.filter\(\(t\) => isApprovedTicket\(t\)\);/.test(listSrc),
    'renderOwnerTickets() must filter the Area Manager list through isApprovedTicket()'
);
assert(
    /isOwnerTicketExpired\(t\)/.test(listSrc),
    'renderOwnerTickets() must compute the expiry per row so the badge can be rendered'
);
assert(
    /status-badge expired/.test(listSrc),
    'an expired approved row must carry the Access-closed badge — the row STAYS (badged), it is not hidden'
);
// The visible WORD changed to "Access closed" (the bare "Expired" read as the
// ticket being expired, not the viewing window closing), but the CLASS did not:
// `.status-badge.expired` is shared with the superadmin Approvals table in
// script.js, so renaming it here would be a breaking change for a page this
// file does not own. Word and class are now deliberately different things.
assert(
    /Access closed/.test(listSrc) && /status-badge expired/.test(listSrc),
    'the expired row must say "Access closed" while still using the shared .status-badge.expired class'
);

// ⚠️ STATUS AND ACCESS MUST BE SEPARATE CELLS. They answer different questions
// ("where is this in the pipeline" vs "can this person still open it") and were
// sharing one cell under one heading, which is what made the column read as
// cluttered. Asserted structurally so it cannot silently merge back.
assert(
    /<td data-label="Status">[\s\S]*?<\/td>\s*<td data-label="Access">/.test(listSrc),
    'the owner row must render Status and Access as two SEPARATE cells, in that order — ' +
    'one heading cannot honestly name two different facts'
);
assert(
    !/data-label="Status">\$\{statusCell\}[^<]*\$\{?accessBadge/.test(listSrc),
    'the access badge must not be concatenated back into the Status cell'
);

const modalSrc = ownerJs.slice(
    ownerJs.indexOf('window.openOwnerReport = function'),
    ownerJs.indexOf('function closeOwnerReportModalFn')
);
assert(
    /const html = expired \? `/.test(modalSrc),
    'openOwnerReport() must branch on expiry when building the modal — the check belongs at RENDER ' +
    'time, not only in the list, because a ticket can lapse while the page is open'
);
assert(
    /isOwnerTicketExpired\(rawData\)/.test(modalSrc),
    'openOwnerReport() must test the freshly-read document, not a cached list row'
);
// The expired branch must NOT interpolate the withheld fields. This is the
// assertion that catches a future edit that renders the evidence anyway.
const expiredStart = modalSrc.indexOf('const html = expired ? `');
const expiredEnd = modalSrc.indexOf('` : `', expiredStart);
assert(expiredStart > -1 && expiredEnd > expiredStart, 'could not isolate the expired branch');
const expiredBranch = modalSrc.slice(expiredStart, expiredEnd);
[
    ['data.description', 'the issue description'],
    ['resNotes', 'the operator findings'],
    ['requesterAttHtml', "the requester's attachments"],
    ['operatorAttHtml', "the operator's footage"],
    ['buildAttachmentRow', 'any attachment link']
].forEach(([token, what]) => {
    assert(
        expiredBranch.indexOf(token) === -1,
        `the EXPIRED branch must not render ${what} ("${token}") — that is the payload the ` +
        'viewing window exists to protect'
    );
});
assert(
    /data\.ticketNumber/.test(expiredBranch) && /data\.branchName/.test(expiredBranch),
    'the expired branch must still render the metadata (ticket number, branch) so the manager can ' +
    'see the ticket exists and chase it'
);
assert(/owner-access-expired/.test(expiredBranch),
    'the expired branch must show the expiry notice');
assert(/escapeHTML\(windowLabel\)/.test(modalSrc),
    'the expiry notice must use ownerAccessWindowLabel(), not a literal "2 days"');
console.log('  PASS  both gates are wired: the list filters, the modal withholds');

// ---------------------------------------------------------------------------
// 5. The orphaned Reports tab is gone. Its filter used to be the only place
//    `approvalStatus === 'approved'` appeared, rendering into elements the page
//    no longer has — dead code that hid this rule.
// ---------------------------------------------------------------------------
assert(/loadOwnerReports/.test(stripComments(ownerJs)) === false,
    'loadOwnerReports() is dead: the Reports tab was removed from ownerdashboard.html, so it ' +
    'returned early on a null element. Its approval filter now lives in renderOwnerTickets()');
assert(/ownerReportsBody/.test(ownerJs) === false,
    'the #ownerReportsBody element reference is dead with the tab');
assert(/id="tabReports"/.test(ownerHtml) === false,
    'ownerdashboard.html must not reintroduce a Reports tab — the Tickets tab is the approved list');
assert(/id="ownerWindowNote"/.test(ownerHtml),
    'ownerdashboard.html must carry the #ownerWindowNote element the window sentence is written into');
// Isolate the Tickets section's own heading paragraph, so the assertion below
// cannot be satisfied by the same words appearing anywhere else on the page.
const ticketsIntro = (() => {
    const at = ownerHtml.indexOf('id="tabTickets"');
    assert(at > -1, 'could not find the #tabTickets section');
    const h2 = ownerHtml.indexOf('<h2>Tickets</h2>', at);
    const p = ownerHtml.indexOf('<p>', h2);
    const end = ownerHtml.indexOf('</p>', p);
    return h2 > -1 && p > -1 && end > p ? ownerHtml.slice(p, end) : '';
})();
assert(/<p>Approved tickets/.test(ticketsIntro),
    'the Tickets tab must state that only superadmin-APPROVED tickets appear. Its heading copy was ' +
    'shortened (the old sentence pushed the h2 to three lines and crowded the toolbar), so this ' +
    'asserts the meaning, not the old wording. Found: ' + ticketsIntro);
assert(
    /renderOwnerWindowNote\(\);/.test(ownerJs.slice(
        ownerJs.indexOf('function setActiveUser('),
        ownerJs.indexOf('function switchOwnerTab(')
    )),
    'renderOwnerWindowNote() must be called from setActiveUser() so the sentence is filled on load'
);
console.log('  PASS  the dead Reports code is gone and the rule is documented in the UI');

// ---------------------------------------------------------------------------
// 6. The new styles must use THEME TOKENS. This page's inline <style> is the
//    one place in the app that shipped hardcoded light values, and
//    test/owner-dark-mode.test.js fails the build on exactly that.
// ---------------------------------------------------------------------------
const newStyles = ownerHtml.slice(
    ownerHtml.indexOf('EXPIRED APPROVED TICKET'),
    ownerHtml.indexOf('.owner-window-note')
);
assert(newStyles.length > 0, 'could not find the new expiry styles');
assert(/#[0-9a-f]{3,8}\b/i.test(newStyles) === false,
    'the new expiry styles must not hardcode a hex colour — use theme tokens so dark mode works');
assert(!/rgba\(\s*255\s*,\s*255\s*,\s*255/.test(newStyles),
    'the new expiry styles must not use a hardcoded white surface (the original dark-mode bug)');
['--color-danger', '--text-secondary', '--text-muted', '--bg-tertiary', '--border-color']
    .forEach((token) => {
        assert(newStyles.indexOf(token) > -1,
            `the new expiry styles should use ${token} so they follow the active theme`);
    });
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
assert(/\.status-badge\.expired\s*\{/.test(styleCss),
    '.status-badge.expired must exist in style.css (the Tickets list reuses the Approvals badge)');
console.log('  PASS  the new styles are token-based, not hardcoded light values');

// ---------------------------------------------------------------------------
// 8. THE TICKETS HEADER — LAYOUT, and the expired / not-expired split.
//
//    (a) POSITIONS. `.section-header` is a flex ROW (style.css), so the heading
//        and the whole control toolbar shared one line. The toolbar needs
//        ~1,250px and the content column only ~1,020-1,180px, so `flex-wrap`
//        broke the controls into an unpredictable 3-then-1 / 2-then-2 block with
//        the heading still vertically centred beside it.
//    (b) SEPARATION. The old #ownerTicketStatusFilter listed seven statuses but
//        was force-locked to "Resolved" and disabled for EVERY role that can
//        reach this page — ~170px of permanently dead control.
// ---------------------------------------------------------------------------
console.log('\n=== The tickets header: stacked layout + the access split ===');

const listFn = extractFn('renderOwnerTickets');
const ticketsBlock = ownerHtml.slice(
    ownerHtml.indexOf('id="tabTickets"'),
    ownerHtml.indexOf('id="tabViolations"')
);

// --- (a) LAYOUT ----------------------------------------------------------------
assert(
    /owner-section-header--stacked/.test(ticketsBlock),
    'the Tickets section header must carry .owner-section-header--stacked — the base .section-header ' +
    'is a flex ROW, and without the modifier the heading and the toolbar still fight for one line'
);
assert(
    /\.owner-section-header--stacked\s*\{[\s\S]{0,200}?flex-direction:\s*column/.test(ownerHtml),
    'the stacked modifier must set flex-direction: column — that IS the fix; a comment alone does nothing'
);
assert(
    /\.owner-section-header--stacked \.owner-toolbar\s*\{\s*width:\s*100%/.test(ownerHtml),
    'the stacked modifier must give the toolbar the full content width, so a wrap is deliberate ' +
    'rather than an accident of available space'
);
// ...and it must be a MODIFIER, not a rewrite of the shared base: Overview keeps
// its side-by-side layout because it only ever carries one filter.
assert(
    /\.owner-section-header--stacked\s*\{/.test(ownerHtml) &&
    /\.owner-section-header\s*\{\s*margin-bottom/.test(ownerHtml),
    'the stacking must be a MODIFIER on the Tickets section, not a rewrite of .owner-section-header — ' +
    'the Overview tab has a single filter and was never crowded'
);

// --- (b) SEPARATION -------------------------------------------------------------
assert(
    !/id="ownerTicketStatusFilter"/.test(ownerHtml),
    'the dead, force-locked #ownerTicketStatusFilter must be gone — it offered seven statuses and ' +
    'accepted none of them'
);
assert(
    !/const ownerTicketStatusFilter =/.test(ownerJs) &&
    !/ownerTicketStatusFilter\?\.addEventListener/.test(ownerJs),
    'every JS reference to the removed #ownerTicketStatusFilter must go with it'
);

const accessSelect = (ticketsBlock.match(/<select[^>]*id="ownerTicketAccessFilter"[\s\S]*?<\/select>/) || [])[0];
assert(accessSelect, 'ownerdashboard.html must contain the #ownerTicketAccessFilter select');
// Exactly the three buckets that were asked for.
['all', 'active', 'expired'].forEach((value) => {
    assert(new RegExp('<option value="' + value + '"').test(accessSelect),
        `the access filter must offer the "${value}" bucket`);
});
assert(
    (accessSelect.match(/<option/g) || []).length === 3,
    'the access filter must offer exactly three buckets (All / Not expired / Expired) — Found: ' +
    accessSelect.replace(/\s+/g, ' ').slice(0, 160)
);
assert(
    accessSelect.indexOf('<option value="all"') < accessSelect.indexOf('<option value="active"'),
    '"All" must be the first option, so the default view hides nothing on load'
);
assert(
    !/\(\d+\)/.test(accessSelect),
    'the access filter must use PLAIN labels — the per-bucket counts were explicitly declined'
);

// Each bucket filters on the RIGHT thing, via the SAME helper the row badges
// use, so the filter and the badge can never disagree about what is expired.
[
    ["if (selectedAccess === 'active') return !isOwnerTicketExpired(t);",
        'the "Not expired" bucket must exclude expired rows'],
    ["if (selectedAccess === 'expired') return isOwnerTicketExpired(t);",
        'the "Expired" bucket must include ONLY expired rows']
].forEach(([token, why]) => {
    assert(listFn.indexOf(token) > -1, `renderOwnerTickets() must implement ${why} — missing: ${token}`);
});
// ...and an unknown value must fall through to "show everything" rather than
// silently emptying the list.
assert(
    /if \(selectedAccess === 'expired'\) return isOwnerTicketExpired\(t\);\s*return true;/.test(listFn),
    'an unrecognised access value must fall through to showing everything — an <option> added to the ' +
    'markup before the JS is updated must not blank the list'
);

// The Resolved-only scope must SURVIVE the rework: js/chat.js's @ticket picker
// mirrors it, and test/chat-ticket-mentions.test.js asserts that exact line.
assert(
    /if \(ownerResolvedOnly\) selectedStatus = 'Resolved';/.test(listFn),
    'the Resolved-only scope must still be explicit — js/chat.js\'s @ticket picker mirrors it'
);

// Wired: resolved once, and re-rendering on change.
assert(
    /const ownerTicketAccessFilter = \$owner\('ownerTicketAccessFilter'\);/.test(ownerJs),
    'the access filter element must be resolved once at the top, with the other list controls'
);
assert(
    /ownerTicketAccessFilter\?\.addEventListener\('change', \(\) => renderOwnerTickets\(ownerAllTicketsCache\)\)/.test(ownerJs),
    'the access filter must re-render the list on change — nothing repaints without this'
);
console.log('  PASS  stacked header; dead dropdown gone; three plain-label buckets; same expiry predicate as the badges');

// ---------------------------------------------------------------------------
// 7. THE RE-ACCESS REQUEST ("Request to open this ticket again").
//
//    The whole superadmin half ALREADY EXISTS (the amber "Reopen requested"
//    chip, the desktop notification, the Approve Request & Resend button, the
//    "Access Approved" email). So these assertions are about the CONTRACT with
//    it: the Area Manager must write the same two fields with the same shapes,
//    or the request lands and the superadmin never sees it.
// ---------------------------------------------------------------------------
const reopenHelpers = ['ownerReopenState', 'ownerReopenPending', 'ownerReopenNotes']
    .map(extractFn).join('\n');

// Load the three pure readers into the same sandbox as the gate helpers.
vm.runInContext(reopenHelpers + '\nglobalThis.__reopen = {' +
    ' ownerReopenState: ownerReopenState, ownerReopenPending: ownerReopenPending,' +
    ' ownerReopenNotes: ownerReopenNotes };', sandbox);
const R = sandbox.__reopen;
assert(R, 'the re-access readers were not loaded into the sandbox');

assert.strictEqual(R.ownerReopenState({ accessReopenRequest: { status: 'pending' } }).status, 'pending',
    'ownerReopenState() must return the stored state');
assert.strictEqual(R.ownerReopenState({}), null, 'a ticket with no request must report null');
assert.strictEqual(R.ownerReopenState(null), null, 'null must report null');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: { status: 'pending' } }), true,
    'a pending request must be pending');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: { status: 'fulfilled' } }), false,
    'a fulfilled request is no longer pending');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: {} }), true,
    'a request with no status defaults to pending (same default the public page uses)');
assert.strictEqual(R.ownerReopenPending({}), false, 'no request at all is not pending');
// NB: the arrays come from inside the vm sandbox, so their prototype is the
// sandbox's Array — deepStrictEqual fails on the prototype even when the
// contents match. Compare joined values, as the other suites in this repo do.
const notesOf = (ticket) => R.ownerReopenNotes(ticket).map((c) => c.text).join('|');
assert.strictEqual(
    notesOf({ comments: [
        { type: 'footage_request', text: 'need the clip' },
        { type: 'access_reopen_request', text: 'audit' },
        { type: 'access_reopen_request', text: 'insurance' }
    ] }),
    'audit|insurance',
    'only access_reopen_request notes count — a footage request must not appear in the history'
);
assert.strictEqual(notesOf({}), '', 'a ticket with no comments has no history');
assert.strictEqual(notesOf({ comments: 'not-an-array' }), '',
    'a non-array comments field must not throw');
console.log('  PASS  the re-access state readers, including a non-array comments field');

// The WRITE contract. Both fields, with the exact `type` value the
// superadmin half filters on.
const requestSrc = extractFn('requestOwnerAccess');
[
    ["type: 'access_reopen_request'", "the note's `type` must be exactly 'access_reopen_request' — " +
        'countAccessReopenRequests() in js/notifications.js filters on that string, and a typo ' +
        'means the superadmin is never notified'],
    ['comments: firebase.firestore.FieldValue.arrayUnion(note)',
        'the request must APPEND a comments note via arrayUnion, so repeat asks accumulate'],
    ['accessReopenRequest: reopenState',
        'the request must set the top-level accessReopenRequest the Approvals chip reads'],
    ['requestCount: prevCount + 1',
        'requestCount must increment from the previous value, or the ×N chip is always ×1'],
    ["status: 'pending'",
        "a new request must be written with status 'pending' — the superadmin half switches on it"],
    ['requestedByEmail: requestedByEmail',
        'requestedByEmail must be the ACCOUNT email: resolveReopenRecipient() emails the ' +
        'requester first, and a manager is usually not the original reporter'],
    ['isOwnerTicketExpired(data)',
        'the request must RE-CHECK expiry on the freshly-read document — a ticket resent a ' +
        'second ago must not accept a stale request']
].forEach(([token, why]) => {
    assert(requestSrc.indexOf(token) > -1, `requestOwnerAccess() must include ${token} — ${why}`);
});
// The >=5 character rule, matching the public Track page exactly.
assert(/length < 5/.test(requestSrc),
    'the reason must be at least 5 characters — same rule as submit-ticket.html, so the two ' +
    'forms cannot disagree about what counts as a real request');
console.log('  PASS  the write contract matches the existing superadmin workflow');

// The three UI states, so a manager is never asked to re-request a pending one.
// These are declared immediately BEFORE `const html = expired ? ...`, so the
// slice runs from the first of them up to the template.
const expiredUi = modalSrc.slice(
    modalSrc.indexOf('const reopen = ownerReopenState(rawData)'),
    modalSrc.indexOf('const html = expired')
);
assert(expiredUi.length > 0, 'could not isolate the re-access UI block in openOwnerReport()');
[
    ['const reopenPending = ownerReopenPending(rawData)',
        'the modal must read the pending state off the document'],
    ['reopenFormHtml = reopenPending',
        'the form must be REPLACED by the pending message, not merely disabled — a greyed ' +
        'button invites a manager to click it twice and the chip then reads ×2 for one ask'],
    ['id="ownerReopenForm"', 'the form must be rendered when there is no pending request'],
    ['id="ownerReopenReason"', 'the reason textarea must exist'],
    ['id="ownerReopenSubmit"', 'the submit button must exist'],
    ['ownerReopenNotes(rawData)', 'the request history must be rendered from the notes'],
    ['fulfilled', 'the history must distinguish Fulfilled from Awaiting approval']
].forEach(([token, why]) => {
    assert(expiredUi.indexOf(token) > -1, `the expired modal must include ${token} — ${why}`);
});
// The form only ever appears inside the EXPIRED branch. Slice ONLY the
// non-expired TEMPLATE (up to the innerHTML assignment) — the delegated submit
// handler that follows legitimately mentions #ownerReopenForm, so scanning the
// rest of openOwnerReport() would report a false leak.
const nonExpiredTemplate = modalSrc.slice(
    modalSrc.indexOf('` : `'),
    modalSrc.indexOf('ownerReportModalBody.innerHTML = html;')
);
assert(nonExpiredTemplate.length > 0, 'could not isolate the non-expired template');
assert(nonExpiredTemplate.indexOf('ownerReopenForm') === -1,
    'the re-access form must NEVER render for a ticket whose access is still open');
assert(nonExpiredTemplate.indexOf('owner-access-expired') === -1,
    'the expiry notice must never render while access is still open');

// The list row swaps to the SAME amber chip the Approvals table uses, so both
// surfaces describe the same ticket identically.
assert(/access-reopen-badge/.test(listSrc),
    'a pending request must swap the red Expired badge for the shared .access-reopen-badge — ' +
    'the manager and the superadmin then read the same row');
assert(/reopenCount > 1/.test(listSrc),
    'the chip must carry the ×N count, exactly as script.js renders it in Approvals');
console.log('  PASS  the three request states, and the shared amber chip in the list');

// The submit must be DELEGATED and bound once — the modal body is re-rendered
// on every open, so a per-render listener would stack up and fire N times.
assert(/ownerReportModalBody\?\.addEventListener\('submit', handleOwnerReopenSubmit\)/.test(ownerJs),
    'the re-access submit must be DELEGATED from the modal body and bound once — the body is ' +
    're-rendered on every open, so binding inside the render fires one request per open');
assert(/event\.target/.test(extractFn('handleOwnerReopenSubmit')) &&
    /ownerReopenForm/.test(extractFn('handleOwnerReopenSubmit')),
    'the delegated handler must ignore submits from anything but #ownerReopenForm');
assert(/ownerReopenTicketId = reportId/.test(ownerJs) && /ownerReopenTicketId = ''/.test(ownerJs),
    'the open ticket id must be SET on open and CLEARED on close, so a stale id can never be ' +
    'written to after a different ticket is opened');

// The user's name is captured for requestedBy, with the email as a fallback.
assert(/ownerActiveUserName = String\(\(userData && userData\.name\)/.test(ownerJs),
    "the manager's name must be read from their users doc — the superadmin sees it in the " +
    'Approvals tooltip and the confirm dialog');
assert(/return String\(auth\.currentUser\.email\)/.test(extractFn('activeUserDisplayName')),
    'activeUserDisplayName() must fall back to the account email, never to a blank string');
console.log('  PASS  the submit is delegated once, and the requester is identified');

// ============================================================================
// 7. THE ?ticket= DEEP LINK FROM THE APPROVAL EMAIL
// ============================================================================
// THE BUG THIS LOCKS DOWN: the approval email now links
// `ownerdashboard.html?ticket=BNW-TIX007`. openOwnerReport() reads a ticket
// STRAIGHT FROM FIRESTORE by id and renders it — while the visible list is
// filtered to approved tickets in the manager's assigned branches. So calling
// it on an id taken from the URL would hand any signed-in user a way to read
// ANY ticket document by editing the URL: another branch's tickets, and
// unapproved work. The deep link must resolve through the SAME filtered list.
//
// These run the real function in a sandbox so the gate is verified
// behaviourally, not by grepping for a string that could be commented out.
const deepSandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    URLSearchParams,
    window: { location: { search: '?ticket=BNW-TIX007' } }
};
deepSandbox.window.location = deepSandbox.window.location;
deepSandbox.self = deepSandbox;
vm.createContext(deepSandbox);

// Minimal stand-ins for the surrounding page state, plus the two REAL
// predicates the gate must reuse.
vm.runInContext(`
  var activeUserRole = 'owner';
  var activeUserIsSuperAdmin = false;
  var ownerAllBranches = ['Banawe', 'Mabini'];
  var ownerAssignedBranches = ['Banawe'];
  var opened = [];
  var toasts = [];
  var tabs = [];

  function isApprovedTicket(t) {
    return !!(t && String(t.approvalStatus || '').trim().toLowerCase() === 'approved');
  }
  function normalizeTicketReport(doc) { return Object.assign({ id: doc.id }, doc); }
  function switchOwnerTab(t) { tabs.push(t); }
  function ownerToast(m) { toasts.push(m); }

  // ⚠️ applyOwnerDeepLink() calls \`window.openOwnerReport()\`, so the spy MUST
  // be on \`window\`. But the probe functions below are read off the SANDBOX
  // (the real global object), so they are published there. Assigning the probe
  // to \`window\` would attach it to the inner stub, where the test cannot see it.
  window.openOwnerReport = function (id) { opened.push(id); };
  __reset = function () { opened = []; toasts = []; tabs = []; };
  __probe = function () { return { opened: opened, toasts: toasts, tabs: tabs }; };
`, deepSandbox);

vm.runInContext(extractFn('readOwnerDeepLink'), deepSandbox);
vm.runInContext(extractFn('applyOwnerDeepLink'), deepSandbox);

// ⚠️ Use the SANDBOX, not sandbox.window. Inside the context `window` was
// reassigned to its own stub, so `deepSandbox.window` is a detached object
// with no `__reset`, no `opened` and no `applyOwnerDeepLink`. The sandbox IS
// the global object the vm script actually wrote to.
const deep = deepSandbox;

// 7a. A hostile ?ticket= must be dropped before it can reach Firestore as a
//     document id. `openOwnerReport()` interpolates it into a .doc() call.
[
    'https://evil.example.com',
    '../../tickets/other',
    'BNW-TIX007#frag',
    'a'.repeat(65)
].forEach(function (hostile) {
    const s = { console: { log() {}, warn() {}, error() {}, info() {} }, URLSearchParams,
        window: { location: { search: '?ticket=' + encodeURIComponent(hostile) } } };
    s.window.location = s.window.location;
    s.self = s;
    vm.createContext(s);
    // The module-scope state the function reads/writes. `var` (not `let`) on
    // purpose: a top-level `let` in a vm script is a lexical binding that never
    // lands on the context's global object, so the assertion below would read
    // `undefined` no matter what the function did.
    vm.runInContext("var ownerDeepLinkTicket = ''; var ownerDeepLinkDone = false;", s);
    vm.runInContext(extractFn('readOwnerDeepLink'), s);
    assert.strictEqual(s.ownerDeepLinkTicket, '',
        'a hostile ?ticket= must be dropped, not forwarded to Firestore: ' + hostile);
});
console.log('  PASS  a hostile ?ticket= cannot reach openOwnerReport()');

// 7b. The gate itself. Each row is what the manager's FILTERED list contains,
//     so "in the list" and "allowed to open" cannot drift apart.
const ROWS = [
    { id: 'BNW-TIX007', branch: 'Banawe', approvalStatus: 'approved' },   // mine, approved
    { id: 'MAB-TIX002', branch: 'Mabini', approvalStatus: 'approved' },   // NOT my branch
    { id: 'BNW-TIX009', branch: 'Banawe', approvalStatus: 'pending_approval' } // not approved
];

// ⚠️ Arrays built INSIDE the vm context have that context's Array prototype, so
// assert.deepStrictEqual() fails on them even when the contents match. Copying
// them into a host array first is what makes the comparison meaningful.
function hostArray(value) {
    return Array.from(value || []);
}

function tryOpen(ticketId, rows) {
    deep.__reset();
    deep.ownerDeepLinkTicket = ticketId;
    deep.applyOwnerDeepLink(rows);
    const seen = deep.__probe();
    return {
        opened: hostArray(seen.opened),
        toasts: hostArray(seen.toasts),
        tabs: hostArray(seen.tabs)
    };
}

let r = tryOpen('BNW-TIX007', ROWS);
assert.deepStrictEqual(r.opened, ['BNW-TIX007'],
    'an approved ticket in the manager\'s OWN branch must open');
assert.deepStrictEqual(r.tabs, ['tickets'],
    'the manager must land on the Tickets tab, not a popup over Overview');
assert.deepStrictEqual(r.toasts, [], 'a successful deep link must not warn');

r = tryOpen('MAB-TIX002', ROWS);
assert.deepStrictEqual(r.opened, [],
    '⚠️ SECURITY: a ticket from a branch the manager does NOT own must NOT open — ' +
    'the deep link must resolve through the same branch filter as the visible list');
assert.strictEqual(r.toasts.length, 1,
    'a refused deep link must say so, not fail silently');

r = tryOpen('BNW-TIX009', ROWS);
assert.deepStrictEqual(r.opened, [],
    '⚠️ SECURITY: an UNAPPROVED ticket must NOT open through the deep link — the ' +
    'whole point of the approval gate is that the manager cannot read it early');
console.log('  PASS  the deep link is gated by approval status AND branch (no bypass)');

// 7c. ONE-SHOT. The ticket listener fires on every snapshot, so a link left
//     pending would re-open the report modal over and over, trapping the
//     manager in a ticket they already closed.
r = tryOpen('BNW-TIX007', ROWS);
assert.deepStrictEqual(r.opened, ['BNW-TIX007'], 'the first call opens');
deep.applyOwnerDeepLink(ROWS);
assert.deepStrictEqual(hostArray(deep.__probe().opened), ['BNW-TIX007'],
    'a second snapshot must NOT re-open the modal — the link is one-shot');
console.log('  PASS  the deep link fires once and is consumed');

// 7d. It must be wired into BOTH data paths, or a manager is silently ignored
//     whenever the realtime listener is unavailable.
assert(/applyOwnerDeepLink\(allTickets\)/.test(extractFn('loadOwnerTickets')),
    'the non-listener fallback load must also apply the deep link');
const listenerSrc = ownerJs.slice(ownerJs.indexOf('function setupOwnerTicketListener'));
assert(/applyOwnerDeepLink\(allTickets\)/.test(listenerSrc),
    'the realtime listener must apply the deep link once real tickets arrive');
console.log('  PASS  both the listener and the fallback load apply the deep link');

console.log('\n✅ Area Manager approval + expiry tests passed (approved-only list; pending_approval/' +
    'rejected/legacy hidden; expiry delegated to firebase.js; expired rows stay listed but badged; the ' +
    'modal withholds description, findings and ALL attachments; dead Reports code removed; themed styles; ' +
    'and a re-access request that writes the SAME two fields the existing superadmin workflow reads).');
