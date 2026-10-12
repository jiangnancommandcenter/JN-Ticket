/**
 * ==============================================================
 *  HR COORDINATION REMARKS  (the "NOV status" shared note)
 *
 *  Several HR staff share the same transferred-violation and ticket
 *  queues, and each of them issues NOVs (Notices of Violation) to the
 *  violators. Nothing on the report says whether a colleague has already
 *  actioned one, so two people can issue the same NOV — or, worse, nobody
 *  does because each assumes someone else has.
 *
 *  This is a free-text "note to the other HR" attached to a single ticket
 *  or violation. Every note records WHO wrote it and WHEN, automatically,
 *  so the team can read the running history at a glance:
 *
 *      [Maria]  Oct 10, 3:42 PM   NOV issued to the store, receipt scanned.
 *      [Juan]   Oct 11, 9:05 AM   Follow-up call done, awaiting signature.
 *
 *  ⚠️ WHY A SEPARATE `remarks` COLLECTION, NOT A FIELD ON THE DOC.
 *  Violations are DELIBERATELY read-only for HR — firestore.rules gives the
 *  `hr` role no write on `violations` at all, and test/violation-hr-transfer.test.js
 *  hard-asserts js/hr-violations.js never calls a violation write. Storing
 *  the note on the report would break both. So the note lives in its own
 *  append-only log, keyed by `targetKey` ('tickets/<id>' | 'violations/<id>'),
 *  and the report document is never touched.
 *
 *  APPEND-ONLY: the rules allow create and read for HR/superadmin and allow
 *  NO update or delete, so the history is a trustworthy record rather than
 *  something a later note can quietly rewrite.
 *
 *  ⚠️ NO COMPOSITE INDEX. The read is `where('targetKey','==',key)` with the
 *  ordering done HERE in JS. Pairing that equality with an `orderBy` on a
 *  different field would need a composite index, which the free Firestore
 *  plan does not auto-create (the same trap test/chat-rules.test.js guards
 *  the conversation list against). A single equality filter needs only the
 *  automatic single-field index.
 * ==============================================================
 */
(function () {
    'use strict';

    var els = {};
    var unsub = null;      // the live listener for the open target
    var currentKey = '';   // 'tickets/<id>' | 'violations/<id>'

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
    }

    function fieldValue() {
        var fs = window.firebase && window.firebase.firestore;
        return fs && fs.FieldValue ? fs.FieldValue.serverTimestamp() : new Date();
    }

    /** The signed-in address, lowercased — the same normalisation the rules use. */
    function selfEmail() {
        var user = window.auth && window.auth.currentUser;
        var email = user && user.email ? String(user.email) : '';
        if (window.normalizeUserEmail) return window.normalizeUserEmail(email);
        return email.trim().toLowerCase();
    }

    function fmtWhen(value) {
        if (!value) return '';
        var d = (value && typeof value.toDate === 'function') ? value.toDate() : new Date(value);
        if (isNaN(d.getTime())) return '';
        try {
            return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return d.toISOString();
        }
    }

    /** Build the modal once and cache its nodes. Reuses the shared modal CSS. */
    function build() {
        if (els.overlay) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'remarksModal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'remarksModalTitle');
        overlay.innerHTML =
            '<div class="modal-container">' +
              '<div class="modal-header">' +
                '<h2 id="remarksModalTitle"><i class="fas fa-sticky-note"></i> <span id="remarksTitleLabel">Remarks</span></h2>' +
                '<button type="button" class="modal-close" id="remarksModalClose" aria-label="Close">&times;</button>' +
              '</div>' +
              '<div class="modal-body">' +
                '<p class="u-section-sub" id="remarksSubject" style="margin-top:0;"></p>' +
                '<div id="remarksList" class="remarks-list" aria-live="polite">' +
                  '<p class="u-section-sub">Loading&hellip;</p>' +
                '</div>' +
                '<div class="remarks-compose">' +
                  '<label for="remarksInput">Add a remark for the other HR staff</label>' +
                  '<textarea id="remarksInput" rows="3" maxlength="2000" ' +
                    'placeholder="e.g. NOV issued to the store on Oct 10, receipt scanned&hellip;"></textarea>' +
                  '<div class="remarks-compose-actions">' +
                    '<span class="remarks-hint">Your name and the date are recorded automatically. Ctrl+Enter to save.</span>' +
                    '<button type="button" class="btn btn-primary btn-sm" id="remarksSaveBtn">' +
                      '<i class="fas fa-plus"></i> Add remark</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.titleLabel = overlay.querySelector('#remarksTitleLabel');
        els.subject = overlay.querySelector('#remarksSubject');
        els.list = overlay.querySelector('#remarksList');
        els.input = overlay.querySelector('#remarksInput');
        els.save = overlay.querySelector('#remarksSaveBtn');

        overlay.querySelector('#remarksModalClose').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        els.save.addEventListener('click', submit);
        els.input.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        // Esc closes, only while this modal is the open one.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && els.overlay && els.overlay.classList.contains('active')) close();
        });
    }

    function renderList(rows) {
        if (!els.list) return;
        if (!rows.length) {
            els.list.innerHTML = '<p class="u-section-sub">No remarks yet. Add the first note so the team knows this one is being handled.</p>';
            return;
        }
        els.list.innerHTML = rows.map(function (r) {
            var who = esc(r.byName || r.byEmail || 'Unknown');
            var when = esc(fmtWhen(r.createdAt));
            return '<div class="remark-item">' +
                '<div class="remark-meta">' +
                    '<span class="remark-author">' + who + '</span>' +
                    '<span class="remark-time">' + when + '</span>' +
                '</div>' +
                '<div class="remark-text">' + esc(r.text) + '</div>' +
            '</div>';
        }).join('');
    }


    function stop() {
        if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* ignore */ } }
        unsub = null;
    }

    function listen() {
        stop();
        if (!window.db || typeof window.db.collection !== 'function') {
            if (els.list) els.list.innerHTML = '<p class="u-section-sub">Remarks are unavailable right now.</p>';
            return;
        }
        try {
            unsub = window.db.collection('remarks')
                .where('targetKey', '==', currentKey)
                .onSnapshot(function (snap) {
                    var rows = [];
                    snap.forEach(function (doc) {
                        var data = doc.data() || {};
                        data.id = doc.id;
                        rows.push(data);
                    });
                    // Ordered here, not in the query — see the no-composite-index
                    // note at the top of the file.
                    rows.sort(function (a, b) {
                        var ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
                        var tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
                        return ta - tb;
                    });
                    renderList(rows);
                }, function (err) {
                    console.error('Remarks listener error:', err);
                    if (els.list) els.list.innerHTML = '<p class="u-section-sub">Could not load remarks.</p>';
                });
        } catch (e) {
            console.error('Remarks listen failed:', e);
        }
    }

    async function submit() {
        var text = (els.input.value || '').trim();
        if (!text) { toast('Type a remark first.', 'error'); return; }
        var email = selfEmail();
        if (!email) { toast('You must be signed in to add a remark.', 'error'); return; }
        if (!window.db || typeof window.db.collection !== 'function') {
            toast('Remarks are unavailable right now.', 'error'); return;
        }

        els.save.disabled = true;
        try {
            // byName comes from the writer's own profile so a note reads as a
            // person, not an address; byEmail is what the rules pin to self.
            var name = email;
            try {
                var profile = await window.getUserProfile(email);
                if (profile && profile.name) name = String(profile.name).trim();
            } catch (e) { /* fall back to the email */ }

            await window.db.collection('remarks').add({
                targetKey: currentKey,
                text: text.slice(0, 2000),
                byEmail: email,
                byName: name,
                createdAt: fieldValue()
            });
            els.input.value = '';
            toast('Remark added.', 'success');
        } catch (e) {
            console.error('Failed to save remark:', e);
            toast('Could not save the remark. ' + (e && e.message ? e.message : ''), 'error');
        } finally {
            els.save.disabled = false;
        }
    }

    function open(targetKey, label) {
        build();
        currentKey = String(targetKey || '');
        if (els.titleLabel) els.titleLabel.textContent = 'Remarks — ' + (label || currentKey);
        if (els.subject) els.subject.textContent = label ? ('Shared notes for ' + label) : '';
        if (els.input) els.input.value = '';
        if (els.list) els.list.innerHTML = '<p class="u-section-sub">Loading&hellip;</p>';
        els.overlay.classList.add('active');
        listen();
    }

    function close() {
        stop();
        if (els.overlay) els.overlay.classList.remove('active');
        currentKey = '';
    }

    // Public surface. openFromButton reads the key/label off data-* attributes,
    // which keeps the value out of any inline JS string (only the attribute is
    // escaped) and lets one handler serve tickets and violations alike.
    window.Remarks = {
        open: open,
        close: close,
        openFromButton: function (btn) {
            if (!btn) return;
            open(btn.getAttribute('data-remarks-key'), btn.getAttribute('data-remarks-label'));
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();

