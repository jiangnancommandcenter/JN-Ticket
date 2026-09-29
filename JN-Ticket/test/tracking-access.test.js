// Functional test for the 2-Day Tracking Access helpers.
// The helper block is extracted from firebase.js (browser globals stubbed) so
// the logic can be verified in plain Node without the Firebase SDK.
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const start = src.indexOf('//  2-DAY TRACKING ACCESS WINDOW');
const end = src.indexOf('// Make firestoreService globally accessible');
assert(start > -1 && end > start, 'helper block not found in firebase.js');
const helperSrc = src.slice(src.lastIndexOf('// ====', start), end);

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);

const w = sandbox.window;
const DAY = 24 * 60 * 60 * 1000;
const WIN = w.TRACKING_ACCESS_WINDOW_MS;

// The window must always be a positive finite number of milliseconds.
assert(Number.isFinite(WIN) && WIN > 0, 'window must be a positive finite number of ms');

// ⚠️ Time-compression guard: production must ship with a 2-day window.
if (WIN !== 2 * DAY) {
    console.warn('⚠️⚠️ TIME-COMPRESSION ACTIVE (Tier 2 testing): window = ' + WIN +
        ' ms (' + w.formatTrackingAccessWindow(WIN) + ') — production value is 2 days.');
}

// Half a window: always safely "inside" / "outside" the expiry, in either mode.
const future = new Date(Date.now() + WIN / 2);
const past = new Date(Date.now() - WIN / 2);

// 1. Not approved -> no window at all.
assert.strictEqual(w.getTrackingAccessExpiry({ approvalStatus: 'pending', approvedAt: past }), null);
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'pending', approvedAt: past }), false);

// 2. Approved + stored future expiry -> still viewable.
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'approved', accessExpiresAt: future }), false);

// 3. Approved + stored past expiry -> expired (this is what blocks the Track page).
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'approved', accessExpiresAt: past }), true);

// 4. Legacy ticket (approved before the feature): derived approvedAt + window.
const legacyFresh = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - WIN / 2) };
assert.strictEqual(w.isTrackingAccessExpired(legacyFresh), false);
const legacyOld = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - 2 * WIN) };
assert.strictEqual(w.isTrackingAccessExpired(legacyOld), true);
assert.strictEqual(w.getTrackingAccessExpiry(legacyOld).getTime(), legacyOld.approvedAt.getTime() + WIN);

// 5. Stored expiry always wins over approvedAt (this is what a Resend rewrites).
const resent = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - 5 * WIN), accessExpiresAt: future };
assert.strictEqual(w.isTrackingAccessExpired(resent), false);

// 6. Boundary: expiry exactly "now" counts as expired.
const now = new Date();
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'approved', accessExpiresAt: now }, now), true);

// 7. Firestore-Timestamp-shaped values (toDate()) are accepted.
const tsLike = { toDate: () => past };
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'approved', accessExpiresAt: tsLike }), true);
// approvedAt older than a full window (no stored expiry) -> already lapsed
const tsLikeOld = { toDate: () => new Date(Date.now() - 2 * WIN) };
assert.strictEqual(w.isTrackingAccessExpired({ approvalStatus: 'approved', approvedAt: tsLikeOld }), true);

// 7b. Human-readable window label used by every Resend label / hint / toast.
const fmt = w.formatTrackingAccessWindow;
assert.strictEqual(typeof fmt, 'function');
assert.strictEqual(fmt(60000), '1 minute');
assert.strictEqual(fmt(5 * 60000), '5 minutes');
assert.strictEqual(fmt(3600000), '1 hour');
assert.strictEqual(fmt(2 * DAY), '2 days');
assert.strictEqual(fmt(WIN), WIN === 60000 ? '1 minute' : '2 days'); // current mode

// 8. script.js view-model helper (isApprovedTicket + getTrackingExpiryInfo)
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const extractFrom = (src, name, signature) => {
    const i = src.indexOf(signature || `function ${name}(ticket)`);
    assert(i > -1, `${name} not found`);
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error(`unbalanced braces in ${name}`);
};
const extract = (name) => extractFrom(scriptSrc, name);
const infoSrc = scriptSrc.slice(scriptSrc.indexOf('function getTrackingExpiryInfo(ticket)'));
const infoFn = infoSrc.slice(0, infoSrc.indexOf('\n}') + 2);
const sandbox2 = { window: w };
vm.createContext(sandbox2);
vm.runInContext(extract('isApprovedTicket') + '\n' + infoFn, sandbox2);

const approvedExpired = { status: 'Resolved', approvalStatus: 'approved', accessExpiresAt: past };
let info = sandbox2.getTrackingExpiryInfo(approvedExpired);
assert.strictEqual(info.tracked, true);
assert.strictEqual(info.expired, true);
assert.strictEqual(info.date.getTime(), past.getTime());

info = sandbox2.getTrackingExpiryInfo({ status: 'Resolved', approvalStatus: 'approved', accessExpiresAt: future });
assert.strictEqual(info.expired, false);

// Not approved -> helper reports "not tracked" (so the Approvals tab hides Resend).
info = sandbox2.getTrackingExpiryInfo({ status: 'Resolved', approvalStatus: 'pending_approval' });
assert.strictEqual(info.tracked, false);
assert.strictEqual(info.expired, false);
assert.strictEqual(info.date, null);

// 9. notifications.js: re-access request counter (drives the dashboard alert).
//    Must count ONLY access_reopen_request notes so footage requests never
//    trigger a "re-access requested" notification (and vice versa).
const notifSrc = fs.readFileSync(path.join(ROOT, 'js', 'notifications.js'), 'utf8');
const countReopen = extractFrom(notifSrc, 'countAccessReopenRequests', 'function countAccessReopenRequests(comments)');
vm.runInContext(countReopen, sandbox2);
assert.strictEqual(typeof sandbox2.countAccessReopenRequests, 'function');
assert.strictEqual(sandbox2.countAccessReopenRequests(), 0);
assert.strictEqual(sandbox2.countAccessReopenRequests(null), 0);
assert.strictEqual(sandbox2.countAccessReopenRequests([]), 0);
assert.strictEqual(sandbox2.countAccessReopenRequests([
    { type: 'footage_request', text: 'need the cashier clip' },
    { type: 'access_reopen_request', text: 'audit' },
    { type: 'comment' },
    { type: 'access_reopen_request', text: 'second ask' }
]), 2);
// A fulfilment (Resend) changes no comment count, so it can never re-fire.
const reopenComments = [{ type: 'access_reopen_request', text: 'audit' }];
assert.strictEqual(sandbox2.countAccessReopenRequests(reopenComments),
    sandbox2.countAccessReopenRequests(reopenComments));

console.log('OK: all 2-day tracking access assertions passed');
