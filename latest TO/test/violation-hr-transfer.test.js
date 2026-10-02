// Functional test for the HR handoff of violation reports ("Transfer to HR").
//
// The feature is a PRIVACY boundary, so most of these assertions are about what
// must NOT be possible:
//
//   1. firestore.rules lets HR read ONLY documents a superadmin transferred.
//   2. HR still has no create / update / delete on `violations` at all.
//   3. The HR page renders no edit / delete / transfer control at all.
//   4. The transfer is superadmin-only in the UI, and reversible.
//
// The rest covers the plumbing: the shared PDF builder is loaded by BOTH pages,
// the query carries the `where()` the rules require, and the transfer writes the
// fields the rules and the UI read back.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const rules = read('firestore.rules');
const scriptJs = read('script.js');
const firebaseJs = read('firebase.js');
const mainHtml = read('main.html');
const ownerHtml = read('ownerdashboard.html');
const ownerJs = read('js/owner-dashboard.js');
const hrJs = read('js/hr-violations.js');
const pdfJs = read('js/violation-report.js');
const css = read('style.css');

const violationsBlock = (() => {
    const start = rules.indexOf('match /violations/');
    assert(start > -1, 'firestore.rules must contain a `match /violations/` block');
    const end = rules.indexOf('match /', start + 10);
    return rules.slice(start, end > -1 ? end : undefined);
})();

console.log('Testing the violation -> HR transfer (privacy + wiring)...');

// ---------------------------------------------------------------
// 1. firestore.rules: HR reads transferred reports, and ONLY those
// ---------------------------------------------------------------
console.log('\n=== firestore.rules: HR is gated on the transfer flag ===');

assert(
    /function isHr\(\)\s*\{[\s\S]*?\.data\.role == 'hr'/.test(rules),
    'firestore.rules must define isHr() matching exactly the hr role'
);
assert(
    /function isTransferredToHr\(\)\s*\{[\s\S]*?resource\.data\.hrStatus == 'transferred'/.test(rules),
    'isTransferredToHr() must require resource.data.hrStatus == "transferred"'
);
assert(
    /allow read: if isOperatorOrSuperAdmin\(\) \|\| \(isHr\(\) && isTransferredToHr\(\)\);/.test(violationsBlock),
    'the violations read rule must be: operator/superadmin, OR hr AND transferred. ' +
    'Got: ' + violationsBlock
);

// HR must NOT be folded into the write-side helper: that would let HR edit.
assert(
    /function isOperatorOrSuperAdmin\(\)\s*\{[\s\S]*?role in \['operator', 'superadmin'\]/.test(rules),
    'isOperatorOrSuperAdmin() must stay exactly [operator, superadmin] — adding "hr" ' +
    'here would hand HR write access to every report'
);

// The create permission was split off the read rule on purpose. Guard both.
assert(
    /allow create: if isOperatorOrSuperAdmin\(\);/.test(violationsBlock),
    'creating a violation report must remain operator/superadmin-only'
);
assert(
    !/allow read, create: if isOperatorOrSuperAdmin\(\);/.test(violationsBlock),
    'the read and create rules must stay SEPARATE — combining them would let an ' +
    'operator create freely but also re-open the door for HR'
);

// ---------------------------------------------------------------
// 2. HR must never be able to write
// ---------------------------------------------------------------
console.log('\n=== firestore.rules: HR still cannot write ===');

const updateRules = violationsBlock.match(/allow update[^\n]*/g) || [];
const deleteRules = violationsBlock.match(/allow [^\n]*delete[^\n]*/g) || [];
assert(updateRules.length > 0, 'the violations block must still declare its update rules');
assert(deleteRules.length > 0, 'the violations block must still declare its delete rules');
[...updateRules, ...deleteRules].forEach((rule) => {
    assert(
        !/\bisHr\(/.test(rule),
        'no update/delete rule may mention isHr() — HR is read-only. Got: ' + rule
    );
});

// ---------------------------------------------------------------
// 3. The HR page must carry no write controls
// ---------------------------------------------------------------
console.log('\n=== The HR tab is view-only ===');

const hrTab = (() => {
    const start = ownerHtml.indexOf('<section class="tab-content" id="tabViolations">');
    assert(start > -1, 'ownerdashboard.html must contain the #tabViolations section');
    const end = ownerHtml.indexOf('</section>', start);
    return ownerHtml.slice(start, end);
})();

const hrModal = (() => {
    const start = ownerHtml.indexOf('id="hrViolationModal"');
    assert(start > -1, 'ownerdashboard.html must contain the #hrViolationModal');
    const end = ownerHtml.indexOf('id="closeHrViolationModal"', start);
    return ownerHtml.slice(start, end);
})();

assert(
    !/btnDeleteViolation|btnEditViolation|btnTransferViolation/.test(hrTab + hrModal),
    'the HR tab and modal must contain NO delete / edit / transfer control'
);
// The only write-capable service calls are the read-only ones.
assert(
    !/\.(addViolation|updateViolation|deleteViolation|transferViolationToHr|revertViolationTransfer)\s*\(/.test(hrJs),
    'js/hr-violations.js must never call a write method on a violation report'
);
assert(
    /hrStatus !== 'transferred'/.test(hrJs),
    'the HR list must defensively drop any report that is not flagged transferred'
);

// ---------------------------------------------------------------
// 4. The nav item is HR-only and hidden by default
// ---------------------------------------------------------------
console.log('\n=== The nav item is HR-only and hidden by default ===');

assert(
    /id="hrViolationsNavItem"[^>]*style="display:none;"/.test(ownerHtml),
    '#hrViolationsNavItem must ship hidden — an owner must never see it before the role is known'
);
assert(
    /const allowed = role === 'hr' \|\| role === 'superadmin';/.test(hrJs),
    'applyRole() must allow only hr and superadmin'
);
assert(
    /navItem\.style\.display = allowed \? 'flex' : 'none';/.test(hrJs),
    'applyRole() must hide the nav item for every other role'
);
// Owners must be bounced off the section even if the tab was restored.
assert(
    /section\.classList\.remove\('active'\)/.test(hrJs),
    'applyRole() must deactivate #tabViolations for a disallowed role'
);

// The role must be read through the accessor, not the script-scoped `let`.
assert(
    /window\.getOwnerRole/.test(ownerJs) && /window\.getOwnerRole/.test(hrJs),
    'both pages must use window.getOwnerRole() to share the role — `activeUserRole` ' +
    'is a top-level `let`, so it is NOT a property of window and cannot be read directly'
);
// Comments legitimately DISCUSS window.activeUserRole (to explain why it must
// not be used), so strip them before asserting on what the code actually reads.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

assert(
    !/window\.activeUserRole/.test(stripComments(hrJs)),
    'js/hr-violations.js must not read window.activeUserRole in CODE — it is a ' +
    'script-scoped `let`, so that read is always undefined'
);

// The tab must be restorable on both the flash-free and the post-auth path.
assert(
    /\['overview', 'tickets', 'violations'\]\.includes\(tabId\)/.test(ownerJs),
    'the flash-free restore must accept the violations tab'
);
assert(
    /OWNER_VALID_TABS = \['overview', 'tickets', 'violations'\]/.test(ownerJs),
    'the post-auth restore must accept the violations tab too'
);


// ---------------------------------------------------------------
// 5. The query the rules require
// ---------------------------------------------------------------
console.log('\n=== The transferred-only query ===');

assert(
    /\.where\('hrStatus', '==', 'transferred'\)/.test(firebaseJs),
    'listenTransferredViolations() must filter on where("hrStatus", "==", "transferred") — ' +
    'an unfiltered HR query is denied by the rules by design'
);
assert(
    /listenTransferredViolations/.test(hrJs),
    'the HR page must subscribe through listenTransferredViolations()'
);
// The listener must live in the violations service, not inline in the page.
assert(
    /listenTransferredViolations\(callback, onError = null\)/.test(firebaseJs),
    'the query belongs in firebase.js so both the rules and the client agree on it'
);

// ---------------------------------------------------------------
// 6. Transfer / revert write the fields the UI reads back
// ---------------------------------------------------------------
console.log('\n=== Transfer and revert ===');

const transferFn = firebaseJs.slice(firebaseJs.indexOf('async transferViolationToHr'));
const revertFn = firebaseJs.slice(firebaseJs.indexOf('async revertViolationTransfer'));

assert(
    /hrStatus: 'transferred'/.test(transferFn),
    'transferViolationToHr() must set hrStatus: "transferred"'
);
assert(
    /transferredAt: firebase\.firestore\.FieldValue\.serverTimestamp\(\)/.test(transferFn),
    'the transfer must be timestamped'
);
assert(
    /hrStatus: firebase\.firestore\.FieldValue\.delete\(\)/.test(revertFn),
    'revertViolationTransfer() must DELETE hrStatus (not set another value), so the ' +
    'document returns to its original shape and stops matching the HR rule'
);
assert(
    /transferredAt: firebase\.firestore\.FieldValue\.delete\(\)/.test(revertFn),
    'revert must also clear transferredAt, or a stale date stays on the record'
);

// The command centre mirrors the same predicate the rules use.
assert(
    /function isViolationTransferred\(v\)\s*\{\s*return !!v && v\.hrStatus === 'transferred';/.test(scriptJs),
    'script.js must test hrStatus === "transferred" — the exact value the rules match'
);

// The transfer action is superadmin-only, in the UI as well as the rules.
assert(
    /if \(!currentUserIsSuperAdmin\(\)\) \{\s*btnTransferViolation\.style\.display = 'none';/.test(scriptJs),
    'refreshTransferButtonState() must hide the transfer button from non-superadmins'
);
assert(
    /function toggleViolationTransfer\(id\)[\s\S]*?if \(!currentUserIsSuperAdmin\(\)\)/.test(scriptJs),
    'toggleViolationTransfer() must refuse any non-superadmin, not merely hide the button'
);
// The same button does both directions, so a transfer is always reversible.
assert(
    /btnTransferViolationLabel\.textContent = transferred \? 'Revert Transfer' : 'Transfer to HR';/.test(scriptJs),
    'the button label must swap to "Revert Transfer" once a report is transferred'
);
assert(
    /id="btnTransferViolation"/.test(mainHtml),
    'main.html must contain the #btnTransferViolation button'
);
assert(
    /toggleViolationTransfer\(currentViolationId\)/.test(scriptJs),
    'the transfer button must be wired to toggleViolationTransfer()'
);

// The report stays in the superadmin list either way.
assert(
    /violationTransferBadgeHtml\(v\)/.test(scriptJs),
    'the violations table must show the transfer state — the report is NOT removed ' +
    'from the superadmin list, it only gains a pill'
);

// ---------------------------------------------------------------
// 7. The shared PDF builder
// ---------------------------------------------------------------
console.log('\n=== The shared report builder is loaded by both pages ===');

// The export goes through the IIFE's `global` parameter, which is `window` —
// the point of the IIFE is that nothing leaks to the global scope except this.
assert(
    /global\.ViolationReport = \{/.test(pdfJs),
    'js/violation-report.js must publish global.ViolationReport (global === window)'
);
assert(
    /<script src="js\/violation-report\.js"><\/script>/.test(mainHtml),
    'main.html must load js/violation-report.js'
);
assert(
    /<script src="js\/violation-report\.js"><\/script>/.test(ownerHtml),
    'ownerdashboard.html must load js/violation-report.js so HR can print the report'
);
assert(
    /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/.test(ownerHtml),
    'ownerdashboard.html must load jsPDF, or the Download button can only fall back to print'
);
assert(
    /JsPDF = global\.jspdf && global\.jspdf\.jsPDF;/.test(pdfJs),
    'buildPdf() must degrade to null when jsPDF is absent rather than throwing'
);

// script.js must delegate rather than keep a second copy of the layout.
assert(
    /function violationReportLib\(\) \{\s*return window\.ViolationReport \|\| null;/.test(scriptJs),
    'script.js must reach the builder through violationReportLib()'
);
assert(
    /const blob = await buildViolationReportPdf\(v\);/.test(scriptJs),
    'the existing generate/auto-save call sites must still work through the wrapper'
);
// The old inline copy must be gone, or there are two layouts to keep in sync.
assert(
    !/function violationReportPrintHtml\(v\)/.test(scriptJs),
    'script.js must no longer define its own print HTML — that is the duplication this ' +
    'extraction was meant to remove'
);
assert(
    !/const VIOLATION_REPORT_HEADER_URL =/.test(scriptJs),
    'the letterhead constant moved into js/violation-report.js; leaving a second copy ' +
    'risks the two drifting apart'
);

// The module must be an IIFE: two classic scripts may not both declare the same
// top-level const, which throws "already been declared" and kills the page.
assert(
    /^\(function \(global\) \{/m.test(pdfJs.trim()) && /\}\)\(window\);\s*$/.test(pdfJs.trim()),
    'js/violation-report.js must be an IIFE publishing only window.ViolationReport'
);

// HR downloads only; it must not re-upload the PDF, because that is a write the
// hr role is denied.
assert(
    /lib\.download\(blob, name\)/.test(hrJs),
    'HR must download the generated PDF locally'
);
assert(
    !/violationCloudinaryUpload|asset_folder|upload_preset/.test(hrJs),
    'HR must not upload anything to Cloudinary — that would mutate the report'
);

// ---------------------------------------------------------------
// 8. Styling
// ---------------------------------------------------------------
console.log('\n=== The transfer pill is styled ===');

assert(/\.violation-hr-pill\s*\{/.test(css), 'the .violation-hr-pill class must be defined in style.css');
// It must theme rather than hardcode a colour, so dark mode stays readable.
const pillRule = (css.match(/\.violation-hr-pill\s*\{[^}]*\}/) || [''])[0];
assert(
    /var\(--color-resolved/.test(pillRule),
    'the pill must use the --color-resolved tokens so it follows the active theme'
);

console.log('\nOK: violation -> HR transfer tests passed (rules gate HR to transferred reports only; HR cannot write; no write controls in the HR UI; transfer is superadmin-only and reversible; one shared PDF layout for both pages).');



