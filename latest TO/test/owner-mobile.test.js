// ===========================================================================
//  AREA MANAGER DASHBOARD — PHONE LAYER
//
//  What is being pinned, and why each one is a real failure mode rather than a
//  style preference:
//
//  1. THE TABLES BECOME CARDS. Two 8-column tables do not fit a phone.
//     The layout works by hiding `thead` and turning each `tr` into a block,
//     with every `td` labelled from `attr(data-label)`.
//
//  2. ⚠️ EVERY CELL CARRIES A `data-label`, and the count matches the `<th>`
//     count. This is the one that actually breaks. `content: attr(data-label)`
//     on a cell with no attribute renders an EMPTY string — no error, no
//     warning, just a value with no label above it, which is worse to read than
//     the table it replaced. So the test counts the headers in the markup and
//     the labelled cells in each renderer and requires them to agree, with the
//     single documented exception of the Actions cell.
//
//  3. THE EMPTY STATE IS NOT TREATED AS AN ACTIONS CELL. It is the only cell in
//     its row, so it is also `:last-child`, and it would inherit the Actions
//     treatment unless its rules come later at equal specificity.
//
//  4. THE HEADER IS SCOPED, NOT GLOBAL. The overrides must beat the shared
//     main.html rules by specificity, not by being unscoped — an unscoped
//     `.header-left` here would silently reformat the command centre too.
//
// ===========================================================================
//  5. THE TICKET CARD IS COMPACT. The card conversion above was literal — all
//     EIGHT columns became label/value pairs, so one ticket was an eight-line
//     block. The card now shows two lines: the ticket number as the title, the
//     branch sharing a line with the self-labelling badges, and the incident
//     demoted to a single truncated line.
//
//  6. ⚠️ HIDING THE ACTIONS CELL MUST NOT HIDE THE EMPTY STATE. The empty-state
//     cell is also `:last-child`, so the obvious selector for the Actions cell
//     blanks "No tickets found for your branches." and leaves an empty bordered
//     card. Asserted on both halves of the fix.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const hrJs = fs.readFileSync(path.join(ROOT, 'js', 'hr-violations.js'), 'utf8');

/**
 * The phone layer, isolated.
 *
 * ⚠️ LOCATE IT IN THE RAW CSS, THEN STRIP COMMENTS — never the other way round.
 * The block's own header comment is what marks its start, so stripping first
 * deletes the marker and the slice silently becomes "from -1 to the end", which
 * is a large chunk of unrelated rules that happens to satisfy most assertions.
 * A test that passes for the wrong reason is worse than no test.
 */
const phoneBlock = css.slice(
    css.indexOf('AREA MANAGER DASHBOARD'),
    css.indexOf('.perm-chip {', css.indexOf('AREA MANAGER DASHBOARD'))
).replace(/\/\*[\s\S]*?\*\//g, '');

console.log('Testing the Area Manager dashboard phone layer...');

// ===========================================================================
console.log('\n=== The tables become CARDS, and every cell is labelled ===');
// ===========================================================================
{
    assert(phoneBlock.length > 500, 'the owner phone-layer block must exist in style.css');

    // `thead` is what carries the column names. Once it is display:none, a cell
    // with no data-label is a value with nothing to name it. Asserted as the one
    // combined rule it actually is — matching each selector separately would
    // only ever match the FIRST one in a comma list, and would silently pass
    // while the second went unhiding.
    assert(/#ownerTicketsTable thead,\s*#hrViolationsTable thead\s*\{[^}]*display:\s*none/.test(phoneBlock),
        'both tables\' thead must be display:none in the phone layer. The column names live ' +
        'in the header row, so leaving it visible is the only thing telling a reader which ' +
        'value is which. It must be `display: none`, not `visibility: hidden` — a screen ' +
        'reader must not read a header that is not on screen.');
    assert(/#ownerTicketsTable tbody tr,\s*#hrViolationsTable tbody tr\s*\{[^}]*display:\s*block/.test(phoneBlock),
        'each row must become a block so it renders as its own card');

    // The labels are pulled out of the attribute, so the mechanism must be wired.
    assert(/content:\s*attr\(data-label\)/.test(phoneBlock),
        'the cells must be labelled via content: attr(data-label). Without it the card ' +
        'layout produces a stack of unlabelled values, which is worse to read than the ' +
        'table it replaced.');

    // -----------------------------------------------------------------------
    // 2. THE data-label COUNT MUST MATCH THE <th> COUNT.
    //
    // ⚠️ This was documented above and never actually written. It is the one
    // assertion that would have caught the Status/Access split going in wrong,
    // so it is implemented here rather than left as a comment.
    //
    // Both sides are read from the real files, never a hardcoded number: a
    // hardcoded count only says the number changed, not whether the change was
    // right. The headers come from the markup, the cells from the renderer, and
    // they must agree.
    // -----------------------------------------------------------------------
    const countTable = (label, theadSrc, rowSrc) => {
        const th = (theadSrc.match(/<th[\s>]/g) || []).length;
        const td = (rowSrc.match(/<td[\s>]/g) || []).length;
        const bare = (rowSrc.match(/<td(?![^>]*data-label)[^>]*>/g) || []).length;

        assert(td > 0, label + ': found no <td> in the row renderer — the slice markers have ' +
            'drifted, so this test would pass vacuously');
        assert.strictEqual(td, th,
            label + ': the renderer emits ' + td + ' cells but the <thead> declares ' + th +
            ' headers. On a phone thead is display:none, so an extra cell is a value with no ' +
            'label above it, and a missing header is a label with no value.');
        assert.strictEqual(bare, 1,
            label + ': exactly ONE cell may go unlabelled — the Actions cell, a button with ' +
            'nothing to name. Found ' + bare + ' unlabelled cells.');
        return { th, td, bare };
    };

    const sliceBetween = (src, start, end) => {
        const a = src.indexOf(start);
        const b = src.indexOf(end, a);
        assert(a > -1 && b > a, 'could not isolate the slice starting ' + start.slice(0, 40));
        return src.slice(a, b);
    };

    const ownerHead = sliceBetween(ownerHtml, 'id="ownerTicketsTable"', '</thead>');
    // Sliced to the map's own close so the empty-state rows — which carry a
    // colspan and no data-label — cannot contaminate the count.
    const ownerRow = sliceBetween(
        ownerJs, 'ownerTicketsBody.innerHTML = tickets.map((t) => {', '}).join(\'\');');
    const ownerCols = countTable('owner tickets', ownerHead, ownerRow);

    const hrHead = sliceBetween(ownerHtml, 'id="hrViolationsTable"', '</thead>');
    const hrRow = sliceBetween(hrJs, 'tableBody.innerHTML = rows.map(v => {', '}).join(\'\');');
    const hrCols = countTable('HR violations', hrHead, hrRow);

    // The one unlabelled cell must be the LAST one, i.e. Actions. If the
    // exception ever drifts onto a data column, this fails.
    const lastCell = (src) => {
        const at = src.lastIndexOf('<td');
        return src.slice(at, src.indexOf('>', at) + 1);
    };
    assert(!/data-label/.test(lastCell(ownerRow)),
        'the owner row\'s LAST cell must be the unlabelled Actions cell');
    assert(!/data-label/.test(lastCell(hrRow)),
        'the HR row\'s LAST cell must be the unlabelled Actions cell');

    console.log('  PASS  owner tickets: ' + ownerCols.th + ' headers / ' + ownerCols.td +
        ' cells, 1 unlabelled (Actions)');
    console.log('  PASS  HR violations: ' + hrCols.th + ' headers / ' + hrCols.td +
        ' cells, 1 unlabelled (Actions)');

    // -----------------------------------------------------------------------
    // 3. THE ACCESS COLUMN EXISTS, AND ITS DETAIL IS REAL TEXT.
    //
    // ⚠️ A `title` attribute is not a fallback. A phone has no hover, so a
    // manager reading this list on the device it is actually built for saw a
    // bare "Expired" and could not learn when it closed or why they asked to
    // reopen. These fail if the detail is ever moved back into a tooltip.
    // -----------------------------------------------------------------------
    assert(/<th>\s*Access\s*<\/th>/.test(ownerHead),
        'the tickets table needs its own Access header. Status (where is this in the ' +
        'pipeline) and Access (can this person still open it) are different questions.');
    assert(/<td data-label="Access">/.test(ownerRow),
        'the Access cell must carry data-label="Access", or it renders unlabelled on a phone');
    assert(/Access closed<\/span>/.test(ownerRow),
        'the closed state must be VISIBLE TEXT reading "Access closed" INSIDE the badge span, ' +
        'not a title attribute');
    assert(!/>Expired<\/span>/.test(ownerRow),
        'the bare word "Expired" is ambiguous — it reads as the TICKET being expired, not the ' +
        'viewing window closing. The visible text is "Access closed".');
    assert(/owner-access-note/.test(ownerRow),
        'the closure date and the reopen reason must render as real text (.owner-access-note) — ' +
        'they are unreachable on a touch device');
    assert(/escapeHTML\(reopen\.reason\)/.test(ownerRow) &&
        /escapeHTML\(formatDate\(expiresAt\)\)/.test(ownerRow),
        'the reopen reason and the expiry date carry user-influenced text and must be escaped');

    // Visible in the phone card, hidden in the desktop table.
    assert(/\.owner-access-note\s*\{[^}]*display:\s*none/.test(css),
        '.owner-access-note must be display:none by default — the desktop table has to stay one ' +
        'line per row');
    assert(/#ownerTicketsTable \.owner-access-note\s*\{[^}]*display:\s*block/.test(phoneBlock),
        '.owner-access-note must be display:block in the phone layer. Without this the detail is ' +
        'in the DOM but the manager never sees it, which is the bug this column exists to fix.');
    assert(/#ownerTicketsTable tbody td\[data-label="Access"\]\s*\{[^}]*flex-wrap:\s*wrap/.test(phoneBlock),
        'the Access cell must be allowed to wrap, so the note sits on its own line beneath the ' +
        'badge instead of being squeezed beside it');
    console.log('  PASS  Access is its own column; its detail is visible text, not a tooltip');
}

// ===========================================================================
console.log('\n=== The ticket card is COMPACT (not eight stacked label lines) ===');
// ===========================================================================
// THE BUG THIS LOCKS DOWN. The card conversion above was literal: it turned all
// EIGHT columns into label/value pairs, so one ticket became an eight-line
// block and a manager scrolled three or four tickets to reach the fourth. These
// fail if the card ever silently grows back to the full column list — which is
// exactly what happens if someone "tidies" the hiding rules away as redundant.
{
    // The three fields that were dropped, hidden BY SELECTOR (not deleted). The
    // cells stay in the DOM: the <th>/<td> counts are static and asserted above,
    // and the DESKTOP table still shows all eight columns.
    ['Created', 'Reporter'].forEach((label) => {
        // ⚠️ The gap allowance is generous because `phoneBlock` has comments
        // STRIPPED: these two selectors share one declaration block, so between
        // `...="Created"]` and `display:` sits the whole Reporter selector.
        // A tight bound here would pass vacuously rather than fail loudly.
        assert(
            new RegExp('#ownerTicketsTable tbody td\\[data-label="' + label + '"\\][\\s\\S]{0,160}?display:\\s*none')
                .test(phoneBlock),
            'the ' + label + ' cell must be hidden on a phone — it is either the manager\'s own ' +
            'data or one they can read in the modal, and it was making every card 8 lines tall'
        );
    });

    // The ticket number is the card's TITLE, so it must lose its label and stop
    // being a right-aligned label/value pair.
    assert(
        /#ownerTicketsTable tbody td\[data-label="Ticket"\][^{]*\{[^}]*display:\s*block/.test(phoneBlock),
        'the ticket number must become the card title (a block, not a label/value row)'
    );
    assert(
        /#ownerTicketsTable tbody td\[data-label="Ticket"\]::before\s*\{[^}]*content:\s*none/.test(phoneBlock),
        'the ticket number must lose its "TICKET" label — as the title it needs no prefix'
    );

    // The badges share one line with the branch, and drop their labels: the
    // badges are self-labelling, so a "STATUS:" prefix above "Resolved" is noise.
    assert(
        /#ownerTicketsTable tbody td\[data-label="Status"\][^{]*\{[^}]*margin-left:\s*auto/.test(phoneBlock),
        'Status must be pushed to the right of the shared badge line with margin-left:auto — ' +
        'without it the badges sit left under the branch and the row reads as one column'
    );
    assert(
        /#ownerTicketsTable tbody td\[data-label="Branch"\]::before[\s\S]{0,200}?content:\s*none/.test(phoneBlock),
        'Branch must keep its value but drop its label, to share the line with the badges'
    );
    // ⚠️ Branch must NOT be hidden. A manager may own several branches, so "which
    // branch is this ticket at" is real information — it was only the LABEL that
    // was costing a line.
    assert(
        !/#ownerTicketsTable tbody td\[data-label="Branch"\][^{]*\{[^}]*display:\s*none/.test(phoneBlock),
        'Branch must stay visible on a phone — a manager can own more than one branch, so which ' +
        'branch a ticket belongs to is real information, not filler'
    );

    // The incident is KEPT but demoted to one truncated line. It is the field
    // that tells you whether you are looking at the right ticket at a glance,
    // and it is the one that used to wrap to four lines.
    assert(
        /#ownerTicketsTable tbody td\[data-label="Incident"\][^{]*\{[^}]*text-overflow:\s*ellipsis/.test(phoneBlock),
        'the incident must be ONE truncated line (nowrap + ellipsis), not a wrapped paragraph — ' +
        'a long title wrapping is what made the old card four lines tall'
    );

    // ⚠️ THE EMPTY STATE MUST SURVIVE. This is the trap: the Actions cell is
    // hidden to save a line, and the obvious selector for it is `:last-child` —
    // but the empty-state row's single colspan cell is ALSO a last child, so
    // that rule blanks "No tickets found for your branches." and leaves an empty
    // bordered card. Asserted on both halves of the fix.
    assert(
        /#ownerTicketsTable tbody td:not\(\[data-label\]\):not\(\.empty-state\)/.test(phoneBlock),
        'the Actions cell must be hidden WITHOUT hiding the empty state: the empty-state cell is ' +
        'also :last-child, so a :last-child selector blanks "No tickets found for your branches." ' +
        'and leaves an empty bordered card'
    );
    assert(
        !/#ownerTicketsTable tbody td:last-child\s*\{[^}]*display:\s*none/.test(phoneBlock),
        'no rule may hide the tickets table\'s :last-child outright — that cell is the empty ' +
        'state as often as it is Actions'
    );
    console.log('  PASS  the ticket card is 2 lines: ticket + branch/badges, incident truncated');
    console.log('  PASS  hiding the Actions cell cannot hide the empty state');
}

// ===========================================================================
console.log('\n=== KPI row, branch list, and touch targets ===');
// ===========================================================================
{
    assert(/#ownerMainContent \.owner-summary-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(phoneBlock),
        'the four KPI cards must be TWO-up on a phone, not one per row — four full-width ' +
        'blocks before any real content. Note minmax(0, 1fr), not 1fr: a 1fr track is floored ' +
        'at min-content, so a long label like "Total Monthly Reports" refuses to shrink and ' +
        'blows the grid into unequal columns.');
    assert(/#ownerMainContent \.owner-summary-grid \.card\s*\{[^}]*flex-direction:\s*column/.test(phoneBlock),
        'the KPI icon must go ABOVE the text. Side-by-side, a 173px card has to fit a 34px ' +
        'icon, a 12px gap and 24px of padding, leaving ~100px for a two-word label — which ' +
        'wraps to three lines and gives the four cards four different heights.');
    assert(/#ownerMainContent \.owner-branch-list\s*\{[^}]*minmax\(150px,\s*1fr\)/.test(phoneBlock),
        'the branch list must fit two per row (150px floor, so "SM Fairview" does not truncate)');

    // 44px is the WCAG 2.5.5 / iOS HIG minimum touch target.
    const touch = phoneBlock.match(
        /#ownerMainContent \.header-actions \.btn,[\s\S]*?\{([^}]*)\}/);
    assert(touch, 'the header touch-target rule must exist');
    assert(/min-height:\s*44px/.test(touch[1]) && /min-width:\s*44px/.test(touch[1]),
        'the header buttons, the theme toggle and the hamburger must be at least 44x44. ' +
        'They were sized for a mouse. Found: ' + touch[1]);

    // Clickable rows gave no feedback at all — no cursor, and on touch no hover.
    assert(/#ownerTicketsTable tbody tr:active/.test(phoneBlock),
        'a tappable row needs :active feedback. These rows open the report on click and had ' +
        'no cursor:pointer anywhere, so on a phone a pressable row and a static one were ' +
        'indistinguishable.');
    console.log('  PASS  KPI cards are two-up with the icon above the text');
    console.log('  PASS  branch list fits two per row; header targets are >= 44x44');
    console.log('  PASS  clickable rows have :active feedback');
}

// ===========================================================================
console.log('\n=== The container stops inviting a swipe that does nothing ===');
// ===========================================================================
{
    assert(/#ownerMainContent \.table-container\s*\{[^}]*overflow-x:\s*visible/.test(phoneBlock),
        'once the rows are cards there is nothing left to scroll sideways, and the shared ' +
        '`overflow-x: auto` invites a swipe that goes nowhere — which reads as a broken ' +
        'page. The container border and fill go too, so a second box is not drawn.');

    // ⚠️ The comment-balance guard, carried over from the ticket form. A block
    // comment with no opener makes the parser swallow every rule up to the next
    // `{` — the rules still look right in the source and are silently never
    // applied. That is not hypothetical: it shipped once already.
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
        if (css[i] === '/' && css[i + 1] === '*') { depth++; i += 2; }
        else if (css[i] === '*' && css[i + 1] === '/') { depth--; i += 2; }
    }
    assert.strictEqual(depth, 0,
        'style.css has ' + depth + ' unterminated block comment(s). An unterminated comment ' +
        'makes the parser swallow every rule until the next `{` — the rules still look ' +
        'correct in the source but are silently never applied.');
    console.log('  PASS  the table container no longer invites a dead horizontal swipe');
    console.log('  PASS  every block comment in style.css is closed');
}

console.log('\n× Owner dashboard phone layer tests passed (both tables render as cards on ' +
    'a phone, with EVERY cell carrying a data-label and the counts checked against the real ' +
    'th count so an unlabelled cell cannot be added silently; the empty state is not ' +
    'mistaken for the Actions cell; the header is two rows and every selector in the block is ' +
    'scoped to #ownerMainContent so main.html cannot be affected; four KPI cards go two-up ' +
    'with minmax(0,1fr) so a long label cannot blow out the grid; header targets are 44x44 ' +
    'and clickable rows have active feedback; the ticket card is COMPACT — two lines, ' +
    'not eight stacked label/value pairs — and hiding its Actions cell cannot hide the empty ' +
    'state; and the CSS comment-balance guard is kept, ' +
    'because a missing comment opener once deleted a whole block of rules in silence).');
