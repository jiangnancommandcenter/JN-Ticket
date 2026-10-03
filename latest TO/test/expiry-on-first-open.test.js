// ===========================================================================
//  THE VIEWING WINDOW STARTS WHEN THE MANAGER OPENS THE TICKET
//
//  THE RULE (as specified): a ticket must not expire if its modal was never
//  opened. The countdown begins the first time the Area Manager opens it, then
//  runs continuously — closing the modal stops nothing — and once lapsed the
//  manager can still request access again.
//
//  ⚠️ THE TRAP THIS TEST EXISTS FOR. Firestore cannot distinguish an ABSENT
//  field from a null one. So "approval simply stops writing `accessExpiresAt`"
//  produces a document shaped EXACTLY like a pre-feature ticket — and the
//  legacy `approvedAt + window` fallback then restarts the countdown at approval
//  anyway, silently, for every new ticket. `accessWindowStartsOnOpen` is the
//  discriminator that makes "approved, never opened" a distinguishable state.
//  Most assertions below exist to keep that flag load-bearing.
//
//  Run: npm test
// ===========================================================================
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

// The write helper touches db/auth/firebase, so they are stubbed and the
// WRITES ARE COUNTED. Asserting "it stamps on open" without also asserting
// "it does NOT stamp for HR" needs both a positive and a negative case.
let writes = [];
const sandbox = {
    window: {},
    console,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS', delete: () => 'DELETE' } } },
    db: { collection: () => ({ doc: () => ({ update: async (payload) => { writes.push(payload); } }) }) },
    auth: { currentUser: { email: 'manager@example.com' } }
};
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);

const w = sandbox.window;
const WIN = w.TRACKING_ACCESS_WINDOW_MS;
const TICKET_ID = 'bnw-tix001';

function ticket(fields) {
    return Object.assign({ id: TICKET_ID, approvalStatus: 'approved' }, fields);
}

console.log('Testing that the viewing window starts on first open...');

(async function run() {
    // ===========================================================================
    console.log('\n=== an approved but UNOPENED ticket never expires ===');
    // ===========================================================================
    {
        // The headline requirement, stated as the exact document shape approval
        // now writes: the marker, and NO expiresAt / NO openedAt.
        const unopened = ticket({
            accessWindowStartsOnOpen: true,
            approvedAt: new Date(Date.now() - 500 * WIN)
        });
        assert.strictEqual(w.getTrackingAccessExpiry(unopened), null,
            'an approved ticket nobody has opened must have NO expiry at all');
        assert.strictEqual(w.isTrackingAccessExpired(unopened), false,
            'an approved ticket nobody has opened must not be expired — not after a minute, ' +
            'not after a year. This is the whole point of the change.');

        // A real timestamp, not just absent, and one far enough in the past to
        // expire under the OLD rule. If the marker were ignored, approvedAt +
        // window would be long gone and this would read as expired.
        assert.strictEqual(w.isTrackingAccessExpired(unopened, new Date(Date.now() + 1000 * WIN)), false,
            'even evaluated a thousand windows from now, an unopened ticket does not expire');
    }

// ===========================================================================
    console.log('\n=== opening it starts the clock ===');
    // ===========================================================================
    {
        const unopened = ticket({ accessWindowStartsOnOpen: true });
        assert.strictEqual(w.getTrackingAccessOpenedAt(unopened), null,
            'nothing has been opened yet');

        const at = new Date();
        const written = await w.markTrackingAccessOpened(unopened, at);
        assert(written, 'opening an approved, unopened ticket must write a stamp');
        assert.strictEqual(writes.length, 1, 'exactly one write, not two');
        assert('accessOpenedAt' in writes[0], 'the stamp must be persisted');
        assert.strictEqual(writes[0].accessOpenedAt, 'SERVER_TS',
            'the stamp must be a SERVER timestamp, not the client clock — the manager can ' +
            'set their own device time');

        // The local copy is mirrored so the modal rendering right now sees its own
        // write. Without this the first open would compute an expiry from a missing
        // stamp and flash the withheld state at a manager whose access is open.
        assert(w.getTrackingAccessOpenedAt(unopened),
            'the ticket object passed in must be updated in place after the write');

        // Now the deadline exists, anchored to the OPEN, not the approval.
        const expiry = w.getTrackingAccessExpiry(unopened);
        assert(expiry, 'once opened, the ticket must have a deadline');
        assert.strictEqual(expiry.getTime(), at.getTime() + WIN,
            'the deadline must be firstOpen + window');
        assert.strictEqual(w.isTrackingAccessExpired(unopened), false, 'just opened, so not expired');
    }

    // ===========================================================================
    console.log('\n=== the clock KEEPS RUNNING after the modal closes ===');
    // ===========================================================================
    {
        const opened = ticket({ accessWindowStartsOnOpen: true });
        const at = new Date(Date.now() - 3 * WIN);
        await w.markTrackingAccessOpened(opened, at);

        // Closing does not clear the stamp. It is written ONCE — re-opening must
        // not slide the deadline along, or the window could be renewed forever.
        writes = [];
        const again = await w.markTrackingAccessOpened(opened, new Date());
        assert.strictEqual(again, null, 'a second open must NOT re-stamp the ticket');
        assert.strictEqual(writes.length, 0, 'a second open must not write at all');

        // Three windows after the first open, the ticket is lapsed. Nothing done
        // to the modal changes this.
        assert.strictEqual(w.isTrackingAccessExpired(opened, new Date(Date.now() + 3 * WIN)), true,
            'the window runs continuously from the first open, so an old open has expired');
        assert.strictEqual(w.getTrackingAccessExpiry(opened).getTime(), at.getTime() + WIN,
            'the deadline is still anchored to the FIRST open');
    }

// ===========================================================================
    console.log('\n=== only the AREA MANAGER stamps it ===');
    // ===========================================================================
    {
        // ⚠️ The role gate lives in the CALLER (openOwnerReport checks
        // expiryAppliesToViewer before calling this), so it is asserted on the
        // source rather than assumed. HR and superadmins read these tickets for a
        // living; stamping on their behalf would start — and burn — the manager's
        // window during someone else's review.
        const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
        const opener = ownerJs.slice(ownerJs.indexOf('window.openOwnerReport = function'));
        assert(opener.length > 0, 'openOwnerReport() must exist');
        assert(/expiryAppliesToViewer\(\)[\s\S]{0,140}markTrackingAccessOpened/.test(opener),
            'the stamp MUST be gated on expiryAppliesToViewer(). Ungated, an HR or superadmin ' +
            'reading an approved ticket would start the manager\'s countdown for them.');
    }

    // ===========================================================================
    console.log('\n=== unapproved and LEGACY tickets are untouched ===');
    // ===========================================================================
    {
        // Nothing to view yet, so no clock and no write.
        writes = [];
        const pending = { id: TICKET_ID, approvalStatus: 'pending_approval', accessWindowStartsOnOpen: true };
        assert.strictEqual(await w.markTrackingAccessOpened(pending, new Date()), null,
            'an unapproved ticket must never be stamped');
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(w.getTrackingAccessExpiry(pending), null);

        // LEGACY — approved before the feature, so it carries no marker. It must
        // keep the old approvedAt + window behaviour. If this regressed, every
        // ticket already in the database would silently become permanent.
        const legacyFresh = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - WIN / 2) };
        const legacyOld = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - 2 * WIN) };
        assert.strictEqual(w.getTrackingAccessExpiry(legacyFresh).getTime(),
            legacyFresh.approvedAt.getTime() + WIN,
            'a pre-feature ticket must still expire on approvedAt + window');
        assert.strictEqual(w.isTrackingAccessExpired(legacyOld), true,
            'a pre-feature ticket whose window has passed must still read as expired');
        writes = [];
        assert.strictEqual(await w.markTrackingAccessOpened(legacyOld, new Date()), null,
            'a legacy ticket must not be stamped — its deadline is already running');
        assert.strictEqual(writes.length, 0);

        // A stored accessExpiresAt still wins: the only value written by a clock
        // that was genuinely running.
        const stored = ticket({
            accessWindowStartsOnOpen: true,
            accessOpenedAt: new Date(Date.now() - 10 * WIN),
            accessExpiresAt: new Date(Date.now() + WIN / 2)
        });
        assert.strictEqual(w.isTrackingAccessExpired(stored), false,
            'a stored expiry must win over a stale accessOpenedAt');
    }

// ===========================================================================
    console.log('\n=== a failed write must not break the report ===');
    // ===========================================================================
    {
        const sandbox2 = {
            window: {},
            console: { warn: () => {} },
            firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } } },
            db: { collection: () => ({ doc: () => ({ update: async () => { throw new Error('offline'); } }) }) },
            auth: { currentUser: { email: 'm@e.com' } }
        };
        vm.createContext(sandbox2);
        vm.runInContext(helperSrc, sandbox2);
        const t = ticket({ accessWindowStartsOnOpen: true });
        assert.strictEqual(await sandbox2.window.markTrackingAccessOpened(t, new Date()), null,
            'a rejected write returns null rather than throwing — an offline manager must ' +
            'still be able to read the report they opened it from');
        assert.strictEqual(sandbox2.window.getTrackingAccessOpenedAt(t), null,
            'a failed write must not leave a local stamp behind — the ticket keeps its ' +
            'no-expiry state');
    }

    console.log('\n× First-open tests passed (an approved ticket with no first-open stamp has a ' +
        'NULL expiry and never expires, however far in the past it was approved; opening it ' +
        'writes ONE server-timestamped accessOpenedAt that is mirrored onto the local copy so ' +
        'the first render does not flash the withheld state; the deadline is anchored to the ' +
        'FIRST open and a second open neither rewrites the stamp nor writes anything, so closing ' +
        'the modal does not extend anything; the stamp is gated on expiryAppliesToViewer so an ' +
        'HR or superadmin reading the ticket cannot burn the manager\'s window; unapproved and ' +
        'pre-feature legacy tickets are neither stamped nor expired, so existing tickets keep the ' +
        'approvedAt + window rule they were created under; a stored expiry still wins over a ' +
        'stale stamp; and a failed write returns null instead of throwing, leaving the report ' +
        'readable).');
})();