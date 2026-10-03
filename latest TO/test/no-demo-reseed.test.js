// ===========================================================================
//  DELETED DATA MUST NOT COME BACK  (regression)
//
//  TWO AUTO-SEEDERS, ONE BUG. Both list renderers re-created the exact
//  documents you had just deleted, on every page load, the moment their
//  collection came back empty.
//
//  1. TICKETS. `loadTicketsDirect()` read:
//
//      const tickets = await firestoreService.getTickets();
//      if (tickets.length > 0) { allTickets = tickets; ... }
//      else { await seedSampleTickets(); }      // <-- writes two demo tickets
//
//      `seedSampleTickets()` created "Tip Pocketing" (Juan Dela Cruz) and
//      "Overcharge Discrepancy" (Maria Santos), both `status: 'Pending'`.
//      Delete the last ticket and the next page load re-created two PENDING
//      tickets. The write succeeded — the app was recreating it. Superadmins
//      could never clear the list, and a project reset could never look clean.
//
//      ⚠️ THE TICKET CATCH BRANCH DID IT TOO, on ANY read error — a dropped
//      connection wrote two tickets into production.
//
//  2. BRANCHES. `loadBranchData()` read:
//
//      if (branches.length === 0) { await seedDefaultBranches(); }
//
//      which wrote 21 hardcoded branches — Banawe, BF Homes, Eastwood …
//      Tagaytay, the full Branch Monitor table — AND fabricated ~20 status
//      logs: six branches forced Offline, five given invented offline/online
//      pairs dated 1-3 days ago.
//
//      ⚠️ THE BRANCH CASE WAS WORSE THAN TICKETS. It merely undid a deletion;
//      it also made the METRICS FICTION. Every uptime percentage (98.7%,
//      99.9%), every downtime figure (2m, 7m) and every "last updated" time in
//      that table was computed from the invented history. The table was
//      confidently reporting outages that never happened.
//
//  DEMO DATA BELONGS IN A SEED SCRIPT. `scripts/seed.js` still creates both
//  lists on demand (`npm run seed`); it must not also happen as a side effect
//  of rendering a page.
//
//  These are text assertions, because that is what a static check can honestly
//  claim. They cannot prove a Firestore write did not happen; they prove the
//  code that made it is gone and has not returned under another name.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

console.log('Testing that deleted tickets stay deleted...');

/**
 * Pull out a function's body by brace matching.
 *
 * ⚠️ Match the braces; do not slice to the next blank line. These functions
 * contain nested blocks, so any heuristic that stops at the first "}" or the
 * next blank line returns a fragment — and a fragment is exactly what makes a
 * test pass for the wrong reason.
 */
function extractFunction(src, name) {
    const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
    assert(start !== -1, `${name}() must exist in script.js`);
    let depth = 0, seen = false;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') { depth++; seen = true; }
        else if (src[i] === '}') {
            depth--;
            if (seen && depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}()`);
}

// ===========================================================================
console.log('\n=== the demo-ticket seeder is GONE ===');
// ===========================================================================
{
    assert(!/function\s+seedSampleTickets\s*\(/.test(script),
        'seedSampleTickets() is back. It writes two hardcoded demo tickets with ' +
        "status 'Pending' whenever the tickets collection comes back empty, which " +
        'is how deleted tickets started reappearing on every page load.');

    // Not just the definition — any call at all, from any path.
    assert(!/seedSampleTickets\s*\(/.test(script),
        'something still calls seedSampleTickets(). The definition being gone is not ' +
        'the requirement; the WRITE is. Check for a surviving call in the load path ' +
        'or in a catch handler.');

    assert(!/function\s+seedDefaultBranches\s*\(/.test(script),
        'seedDefaultBranches() is back. It writes 21 hardcoded branches AND fabricates ' +
        '~20 status logs whenever the branch list is empty — which both undid deletions ' +
        'and made the uptime/downtime figures describe outages that never happened.');

    assert(!/seedDefaultBranches\s*\(/.test(script),
        'something still calls seedDefaultBranches(). The definition being gone is not ' +
        'the requirement; the WRITE is.');

    assert(!/DEFAULT_BRANCH_NAMES/.test(script),
        'DEFAULT_BRANCH_NAMES is back in script.js. The full 21-branch demo list must ' +
        'live only in scripts/seed.js, which runs deliberately.');

    // ⚠️ DO NOT assert the absence of the branch NAMES. 'BF Homes', 'Tagaytay',
    // 'Ortigas Center' etc. are real places — getBranchGroup() groups any
    // branch whose name starts with 'tagaytay', and that logic is correct and
    // must survive. Asserting the literals are gone would forbid the app from
    // ever mentioning a real branch, and it failed here for exactly that
    // reason.
    //
    // What is pinned instead is the SHAPE: a hardcoded ARRAY of branch names,
    // which only ever existed to be written to Firestore. A name appearing in a
    // comparison is fine; a list of them sitting in the app is the seeder.
    const nameArrays = script.match(/\[[^\]]*'BF Homes'[^\]]*\]/g) || [];
    assert.strictEqual(nameArrays.length, 0,
        'a hardcoded ARRAY of demo branch names is back in script.js. Individual names ' +
        'are fine (grouping logic compares them); a list of them is the seeder, and it ' +
        'belongs in scripts/seed.js.');

    // The demo data itself, by its distinctive strings. These are the payloads
    // that actually reached production, so assert them individually — a renamed
    // function reusing the same literals would still be caught.
    ['Juan Dela Cruz', 'Tip Pocketing', 'Maria Santos', 'Overcharge Discrepancy']
        .forEach(s => {
            assert(!script.includes(s),
                `demo ticket literal ${JSON.stringify(s)} is back in script.js. ` +
                'Demo data belongs in scripts/seed.js, which is run deliberately.');
        });
}
// ===========================================================================
console.log('\n=== the load path WRITES nothing ===');
// ===========================================================================
{
    const body = extractFunction(script, 'loadTicketsDirect');

    assert(!/if\s*\(\s*tickets\.length\s*>\s*0\s*\)/.test(body),
        'loadTicketsDirect() still branches on `tickets.length > 0`. That branch ' +
        'existed solely to decide whether to seed: empty -> write demo tickets. An ' +
        'empty collection is a legitimate state and must render as-is.');

    // ⚠️ ALLOWLIST, NOT A DENYLIST. A denylist of mutators (`.set(`/`.add(`/
    // `.setTicket(`) is MISSED BY THE ACTUAL BUG: the old code's write was
    // buried inside the seeder, so nothing inside this function matched a
    // mutator name and the guard passed on the broken code. Assert the other
    // way round — every firestoreService call in a READ path must be a known
    // read — so a new write shows up as "unexpected method" whatever it is
    // named. Adding a read method here is a deliberate, reviewable act.
    const READ_ONLY = ['getTickets', 'getBranches', 'getAllLogs'];
    const calls = [...body.matchAll(/firestoreService\.(\w+)\s*\(/g)].map(m => m[1]);
    const unexpected = calls.filter(c => !READ_ONLY.includes(c));
    assert.strictEqual(unexpected.length, 0,
        `loadTicketsDirect() calls firestoreService.${unexpected.join('(), firestoreService.')}` +
        `() — not a known read. It is a READ path: it loads the ticket list and renders ` +
        `it. Any write here means loading the page can mutate the database, which is how a ` +
        `network error used to create tickets. If you added a legitimate read, add it to ` +
        `READ_ONLY in this test.`);

    // A failed read is NOT an empty database. The old catch handler treated it as
    // one and seeded, which is how two demo tickets reached production by a
    // dropped connection. NOT re-checked here: a function-local `catch … seed`
    // regex needs a precedence-safe group AND then trips over the word "seeder"
    // in this file's own comments — it failed on correct code, which is worse
    // than no check. The whole-file `seedSampleTickets\s*\(` assertion above already
    // covers this branch, because a call inside catch is still a call.

    // The old code could leave this `true` whenever the list came back empty,
    // which flipped `isInitialTicketLoad || allTickets.length === 0` above it
    // onto its other branch precisely when there was nothing to show.
    const flagWrites = (body.match(/isInitialTicketLoad\s*=\s*false/g) || []).length;
    assert.strictEqual(flagWrites, 1,
        `isInitialTicketLoad = false must be assigned exactly once, on the single ` +
        `unconditional path. Found ${flagWrites} assignment(s) — more than one means ` +
        `it is again nested inside a "did we find any tickets?" branch.`);

    assert(!/if\s*\([^)]*\)\s*\{[^}]*isInitialTicketLoad\s*=\s*false/.test(body),
        'isInitialTicketLoad = false must NOT sit inside a conditional. It used to ' +
        'be set only in the branches that found at least one ticket, so an empty ' +
        'collection left it true and the guard above it took the wrong branch.');
}

// ===========================================================================
console.log('\n=== the BRANCH load path cannot INVENT a branch or its history ===');
// ===========================================================================
{
    const body = extractFunction(script, 'loadBranchData');

    assert(!/if\s*\(\s*branches\.length\s*===\s*0\s*\)/.test(body),
        'loadBranchData() still branches on `branches.length === 0`. That branch existed ' +
        'solely to decide whether to seed: empty -> write 21 demo branches. An empty ' +
        'branch list is a legitimate state.');

    // ⚠️ THIS ONE HAS A GENUINE ALLOWLIST MEMBER, unlike the ticket path.
    // `loadBranchData()` DOES call `setBranch`: the reconciliation loop walks the
    // branches that already exist and syncs `currentStatus` /
    // `currentDowntimeStart` from each one's newest log. That write is
    // legitimate — it can only touch branches the read just returned, so it
    // cannot bring a deleted branch back. It is listed explicitly so that
    // anyone widening this list has to decide which kind of write they are
    // allowing: the RECONCILING kind, or the INVENTING kind that caused the bug.
    //
    // ⚠️ HONEST SCOPE: this does NOT catch the original bug. The old
    // addStatusLog() calls lived inside seedDefaultBranches(), not in
    // loadBranchData(), so this assertion passed on the broken code too. It is
    // kept as a FORWARD guard — nothing in a read path has any business
    // appending to the status log — not as a regression pin. The fabrication is
    // actually caught by the seeder-definition, the `branches.length === 0`
    // branch, the DEFAULT_BRANCH_NAMES array, and the seeder loop below.
    assert(!/addStatusLog\s*\(/.test(body),
        'loadBranchData() calls addStatusLog(). Appending status history from a read path ' +
        'is how the Branch Monitor grew ~20 invented outages and started reporting uptime ' +
        'percentages for events that never happened.');

    const calls = [...body.matchAll(/firestoreService\.(\w+)\s*\(/g)].map(m => m[1]);
    const allowed = ['getBranches', 'getAllLogs', 'getBranchLogs', 'setBranch'];
    const unexpected = calls.filter(c => !allowed.includes(c));
    assert.strictEqual(unexpected.length, 0,
        `loadBranchData() calls firestoreService.${unexpected.join('(), firestoreService.')}` +
        `() — not a known read or reconcile. It loads the branch list and renders it; a ` +
        `write here can fabricate a branch or its history.`);

    // The reconciliation must stay scoped to branches the read returned. The old
    // seeder looped over a hardcoded name list instead — which is exactly how
    // deleted branches came back.
    assert(!/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+DEFAULT/.test(body),
        'loadBranchData() iterates a hardcoded branch list. That is the seeder loop — it ' +
        're-created every branch the user had just deleted.');

    // An empty list must still RENDER. Dropping the seed makes "no branches" a
    // state the app reaches in normal use, so pin that the renderer exists
    // rather than assuming it does.
    assert(/function\s+renderBranchesTable\s*\(/.test(script),
        'renderBranchesTable() must still exist so an empty branch list renders.');

    // ⚠️ THE CONSEQUENCE OF THIS CHANGE, recorded so it is not undone by
    // someone tidying up the seeder. An empty `branches` read means every
    // Branch Access checkbox in User Approvals renders "No branches loaded.",
    // there is nothing to tick, and approveUser() would write `branches: []`
    // onto a real manager. The seeder used to paper over exactly that failed
    // read; with it gone, approveUser()'s refusal is the only guard left. So
    // assert that guard is still there.
    const approve = extractFunction(script, 'approveUser');
    assert(/branches\.length\s*===\s*0/.test(approve) && /return/.test(approve),
        'approveUser() must still refuse to approve an account with zero branches. Now ' +
        'that the auto-seed is gone, a failed branch read leaves nothing to tick in the ' +
        'Branch Access checkboxes — this refusal is the last thing preventing a real ' +
        "manager's access being silently stripped.");
}

// ===========================================================================
console.log('\n=== an empty list still renders properly ===');
// ===========================================================================
{
    // Removing the seeding means the empty state is now a state the app will
    // actually reach in normal use, so pin that it is handled rather than
    // assuming it still works.
    assert(/No tickets found/.test(script),
        'the "No tickets found." empty state must remain. With the auto-seed gone, ' +
        'an empty collection is expected on a fresh project or after a reset — the ' +
        'list must say so instead of rendering nothing.');
}

console.log('\n× Deletion-sticks tests passed (NEITHER auto-seeder survives: seedSampleTickets() ' +
    'and seedDefaultBranches() are both gone and called from nowhere; the demo ticket and ' +
    'demo branch literals are out of the app and live only in scripts/seed.js; the ticket ' +
    'load path makes only allowlisted READS; the branch load path allows setBranch for ' +
    'reconciliation of EXISTING branches but never addStatusLog and never loops over a ' +
    'hardcoded name list, so a page load can neither invent a branch nor fabricate its ' +
    'history; isInitialTicketLoad is cleared on a single unconditional path; both empty ' +
    'states still render; and approveUser() still refuses a zero-branch approval, which is ' +
    'the last guard against stripping a manager access now that nothing papers over a ' +
    'failed branch read).');