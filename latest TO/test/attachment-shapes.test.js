// Functional test for ATTACHMENT RENDERING across both writers' shapes.
//
// THE BUG THIS LOCKS DOWN
// -----------------------
// A ticket uploaded through the Area Manager form rendered an attachment card
// with `href=""`, `data-public-id=""`, the fallback name "Attachment 1", and a
// real file size (1.22 MB) — and clicking it navigated the whole app to its own
// URL instead of opening the viewer.
//
// Two independent defects, both required:
//
//   1. SHAPE MISMATCH. js/owner-ticket-form.js writes
//        { url, publicId, fileName, mimeType, bytes }
//      while every renderer in script.js reads
//        { secure_url, public_id, name, resource_type, format, bytes }
//      The ONLY shared key is `bytes` — which is exactly why the size rendered
//      and the link did not. The data was never lost; the reader looked for keys
//      the writer never produced.
//
//   2. `href=""` IS A REAL LINK TO THE CURRENT PAGE. The click guard did
//      `if (!url) return;` BEFORE `e.preventDefault()`, so a dead attachment
//      navigated the page instead of being ignored.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const formSrc = fs.readFileSync(path.join(ROOT, 'js', 'owner-ticket-form.js'), 'utf8');

console.log('Testing attachment rendering (both writer shapes + no empty href)...');

/** Extract a named top-level function, brace-matched. */
function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert(start > -1, name + '() not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('could not find the end of ' + name + '()');
}

// ============================================================================
// 1. normalizeAttachment() must understand BOTH shapes
// ============================================================================
const sandbox = { console, URL, encodeURI, decodeURI };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext([
    extractFn(scriptSrc, 'normalizeFileUrl'),
    extractFn(scriptSrc, 'normalizeAttachment')
].join('\n'), sandbox);
const norm = sandbox.normalizeAttachment;

// The shape the Area Manager form writes — the one that produced the bug.
const fromForm = norm({
    url: 'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
    publicId: 'rcms/abc123',
    fileName: 'Incident clip.mp4',
    mimeType: 'video/mp4',
    bytes: 1220000
});
assert.strictEqual(fromForm.url, 'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
    "normalizeAttachment() must read the Area Manager form's `url` key");
assert.strictEqual(fromForm.publicId, 'rcms/abc123',
    'normalizeAttachment() must read `publicId`');
assert.strictEqual(fromForm.name, 'Incident clip.mp4', 'it must read `fileName`');
assert.strictEqual(fromForm.bytes, 1220000, 'the size must survive');
assert.strictEqual(fromForm.resourceType, 'video',
    'resource_type must be DERIVED from mimeType, or a video renders as a plain file icon');
assert.strictEqual(fromForm.format, 'mp4', 'the icon format must fall back to the extension');

// The original Cloudinary shape must keep working untouched.
const fromCloudinary = norm({
    secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    public_id: 'rcms/xyz789',
    name: 'photo.jpg',
    resource_type: 'image',
    format: 'jpg',
    bytes: 2048
});
assert.strictEqual(fromCloudinary.url, 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    'the Cloudinary shape must still be understood');
assert.strictEqual(fromCloudinary.publicId, 'rcms/xyz789', 'public_id must still be read');
assert.strictEqual(fromCloudinary.name, 'photo.jpg', 'name must still be read');
assert.strictEqual(fromCloudinary.resourceType, 'image', 'resource_type must still win over mimeType');
console.log('  PASS  both writer shapes normalise to one canonical attachment');

// ============================================================================
// 2. NO renderer may emit href=""
// ============================================================================
// Asserted on the SOURCE, because the renderers are template strings that need
// a full DOM to execute. The behavioural half is covered by #1: `isBroken` is
// derived from `!norm.url`, so an empty url takes the div branch, never the
// anchor branch.
['renderTicketAttachments', 'renderApprovalAttachments', 'renderRevisionAttachments']
    .forEach(function (fnName) {
        const body = extractFn(scriptSrc, fnName);
        assert(/isBroken/.test(body),
            fnName + '() must compute `isBroken` and render a div instead of an anchor when there is no URL');
        assert(!/att\.secure_url \|\| ''/.test(body),
            fnName + '() must read attachments through normalizeAttachment(), not the Cloudinary keys alone');
    });
console.log('  PASS  every ticket renderer gates its anchor on a real URL');

// ============================================================================
// 3. The click guard must preventDefault BEFORE bailing on an empty URL
// ============================================================================
const guardAt = scriptSrc.indexOf("a.attachment-preview, a.upload-file-preview");
assert(guardAt > -1, 'the attachment click handler was not found');
const guard = scriptSrc.slice(guardAt, guardAt + 1500);
// Search FORWARD from guardAt: the same selector string appears a second time
// further down (the querySelectorAll), and a bare indexOf could match either one.
const preventAt = scriptSrc.indexOf('e.preventDefault()', guardAt);
const bailAt = scriptSrc.indexOf("if (!url || url === '#') return;", guardAt);
assert(preventAt > -1, 'the click handler must call e.preventDefault()');
assert(bailAt > -1, 'the click handler must still guard on an empty URL');
assert(preventAt < bailAt,
    'e.preventDefault() MUST run BEFORE the `if (!url) return;` guard. An anchor with href="" '
    + 'is a real link to the current page, so bailing out first let a dead attachment navigate '
    + 'the app to its own URL instead of being ignored — the reported symptom.');
console.log('  PASS  preventDefault() runs before the empty-URL bail-out');

// ============================================================================
// 4. The writer must emit the canonical shape too
// ============================================================================
assert(/secure_url:\s*payload\.secure_url/.test(formSrc) && /public_id:\s*payload\.public_id/.test(formSrc),
    'js/owner-ticket-form.js must ALSO write secure_url/public_id — otherwise the very next '
    + 'upload reproduces the same mismatch, even though the reader now tolerates both shapes');
assert(/name:\s*file\.name/.test(formSrc), 'it must also write `name` so the filename is not "Attachment 1"');

console.log('\n✅ Attachment tests passed (both writer shapes normalise to one canonical record; a '
    + 'URL-less record renders an unclickable card instead of an empty anchor; the click guard '
    + 'cancels navigation before bailing; and the Area Manager form writes the canonical keys so '
    + 'the two writers can no longer drift apart).');


// A record with no URL at all must be reported as broken, never as a valid link.
const broken = norm({ bytes: 500, fileName: 'gone.png' });
assert.strictEqual(broken.url, '',
    'an attachment with no URL anywhere must normalise to url === "" — that is what makes '
    + 'the renderer emit a dead card instead of an anchor');
assert.strictEqual(norm(null), null, 'null must not throw');
assert.strictEqual(norm(undefined), null, 'undefined must not throw');
assert.strictEqual(norm('a string'), null, 'a non-object must not throw');
console.log('  PASS  a URL-less record is detected, and junk input is safe');
