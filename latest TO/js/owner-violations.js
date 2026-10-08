// ==============================================================
//  AREA MANAGER DASHBOARD — TRANSFERRED VIOLATIONS (read-only)
// ==============================================================
//  An operator files a CCTV violation -> the superadmin reviews it on the
//  command center -> presses "Transfer to Area Manager", which stamps
//  `managerStatus: 'transferred'` on the SAME document -> the report appears
//  HERE, scoped to that manager's own branches.
//
//  INDEPENDENT OF THE HR HANDOFF. That stamps `hrStatus`; this stamps
//  `managerStatus`. One report can be on HR's list, the manager's list, or
//  both, and reverting one never touches the other.
//
//  READ-ONLY BY CONSTRUCTION, in two independent layers:
//    1. firestore.rules gives the `owner` role no create/update/delete access
//       to the `violations` collection at all — reads only, and only for
//       documents where `managerStatus == 'transferred'`.
//    2. There is no edit / delete / transfer control anywhere in this file or
//       in the tab markup. Even a hand-edited DOM cannot reach a write.
//  The manager's only actions are: view the details, open the evidence,
//  download the report PDF.
//
//  ⚠️⚠️ BRANCH SCOPING IS ENFORCED HERE, IN THE CLIENT — NOT IN THE RULES.
//  An Area Manager's branch list lives on their own user document, and a
//  Firestore query can only constrain fields on the collection it queries, so
//  the rules cannot prove "this report's store is one of mine". Enforcing it
//  server-side would need a second filter on `store`, i.e. a COMPOSITE INDEX,
//  which is a Blaze (paid) plan feature this project is not on. See the long
//  note above `allow read` in firestore.rules.
//
//  THE CONSEQUENCE, STATED PLAINLY: the LIST is correctly scoped, but a
//  determined Area Manager who ignores this UI and reads another branch's
//  transferred report directly WILL SUCCEED. That is the same gap the
//  `tickets` collection has, so it is consistent with the rest of the app —
//  but it is real, and it is why the two fail-closed guards below matter.
// ==============================================================
(function () {
    'use strict';

    const $ov = (id) => document.getElementById(id);

    // DOM — every one is optional so a partial page never throws on load.
    const navItem = $ov('ownerViolationsNavItem');
    const search = $ov('ownerViolationSearch');
    const storeFilter = $ov('ownerViolationStoreFilter');
    const tableBody = $ov('ownerViolationsBody');
    const pagination = $ov('ownerViolationPagination');
    const modal = $ov('ownerViolationModal');
    const modalTitle = $ov('ownerViolationModalTitle');
    const modalBody = $ov('ownerViolationModalBody');
    const attachmentsGrid = $ov('ownerViolationAttachmentsGrid');
    const btnDownload = $ov('btnOwnerViolationReport');
    const btnCloseModal = $ov('closeOwnerViolationModal');

    const PAGE_SIZE = 20;

    let allViolations = [];       // every report transferred to ANY manager
    let filtered = [];
    let page = 1;
    let currentId = null;
    let listenerStarted = false;
    let allowed = false;

    // ===== Helpers =====

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        else console.log(message);
    }

    function fmtDate(d) {
        if (!d) return '—';
        return d.toLocaleDateString();
    }

    function fmtTime(d) {
        if (!d) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function fmtDateTime(d) {
        if (!d) return '—';
        return fmtDate(d) + ' · ' + fmtTime(d);
    }

    /**
     * Normalise a branch name for COMPARISON ONLY.
     *
     * ⚠️ The SAME normalisation owner-dashboard.js uses in ownerBranchKey:
     * trim + lowercase. A user document holding 'banawe' against a branch named
     * 'Banawe' must still match — an exact, case-sensitive comparison silently
     * produces an EMPTY assigned list, which here would silently show NO
     * reports. The displayed name is never modified, only the comparison.
     */
    function branchKey(name) {
        return String(name === null || name === undefined ? '' : name).trim().toLowerCase();
    }

    function incidentDate(v) {
        const lib = window.ViolationReport;
        if (lib && lib.incidentDate) return lib.incidentDate(v);
        const raw = v && v.incidentDateTime;
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    function reportDate(v) {
        const lib = window.ViolationReport;
        if (lib && lib.reportDate) return lib.reportDate(v);
        const raw = v && (v.reportDateTime || v.createdAt);
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    // ===== BRANCH SCOPE =====
    /**
     * This manager's assigned branches, read live from owner-dashboard.js.
     *
     * ⚠️ RETURNED EMPTY UNTIL THE ROLE AND BRANCHES HAVE RESOLVED. Both are
     * fetched asynchronously on page load, so an empty result here is
     * indistinguishable from "this manager genuinely has no branches" — and
     * treating it as "no scope, show everything" would show EVERY transferred
     * report to a manager whose branch list simply has not loaded yet. That is
     * the failure mode this function exists to prevent, so scopeIn() below
     * fails CLOSED on an empty list rather than open.
     */
    function assignedBranches() {
        if (typeof window.getOwnerAssignedBranches !== 'function') return [];
        return window.getOwnerAssignedBranches() || [];
    }

    /**
     * Is this report inside the manager's branch scope?
     *
     * A report's `store` is populated from `branches[].branchName`
     * (populateViolationStoreSelect in script.js), so it IS a branch name and
     * the comparison is meaningful.
     *
     * ⚠️ A REPORT WITH NO STORE IS TREATED AS OUT OF SCOPE. There is nothing to
     * match it against, and "cannot prove it is mine" must mean "not mine" —
     * the opposite default would publish an unidentified report to every
     * manager.
     */
    function scopeIn(v, keys) {
        const storeKey = branchKey(v && v.store);
        if (!storeKey) return false;
        return keys.indexOf(storeKey) !== -1;
    }

    // ===== Store dropdown =====
    // Built from the ALREADY-SCOPED list, so a manager is never even offered a
    // store they are not allowed to see — offering one and returning nothing
    // for it would still leak that the store exists.
    function populateStoreFilter() {
        if (!storeFilter) return;
        const current = storeFilter.value;
        const stores = Array.from(new Set(filtered.map(v => v.store).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b));
        storeFilter.innerHTML = '<option value="all">All Stores</option>'
            + stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
        if (current && (current === 'all' || stores.includes(current))) storeFilter.value = current;
    }

    // ===== List =====
    function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase();
        const store = (storeFilter && storeFilter.value) || 'all';
        const keys = assignedBranches().map(branchKey).filter(Boolean);

        // Belt-and-braces on the transfer flag: the rules already hide
        // non-transferred reports, but never render one even if the query
        // changes.
        filtered = keys.length
            ? allViolations.filter(v => {
                if (v.managerStatus !== 'transferred') return false;
                if (!scopeIn(v, keys)) return false;
                if (store !== 'all' && (v.store || '') !== store) return false;
                if (!term) return true;
                const haystack = [
                    v.violationNumber, v.subject, v.store, v.location,
                    v.details, v.reportedByName, v.reportedBy
                ].filter(Boolean).join(' ').toLowerCase();
                return haystack.includes(term);
            })
            : [];

        page = 1;
        render(keys.length === 0);
        populateStoreFilter();
    }

    /**
     * @param {boolean} noBranches  true when the branch list is empty, which
     *   gets a DIFFERENT message from "nothing matched". "No reports have been
     *   transferred to you yet" is reassuring; "your branch access has not
     *   loaded" is a problem the manager needs to know about, and showing the
     *   first would hide it.
     */
    function render(noBranches) {
        if (!tableBody) return;

        if (!filtered.length) {
            const hasAny = allViolations.length > 0;
            const message = noBranches
                ? 'Your branch access has not loaded, so no reports can be shown.'
                : (hasAny
                    ? 'No transferred reports match your search.'
                    : 'No violation reports have been transferred to you yet.');
            tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">'
                + '<i class="fas fa-video"></i><p>' + esc(message) + '</p></td></tr>';
            if (pagination) pagination.innerHTML = '<span class="page-info">0 report(s)</span>';
            return;
        }

        const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
        if (page > totalPages) page = totalPages;
        if (page < 1) page = 1;
        const start = (page - 1) * PAGE_SIZE;
        const rows = filtered.slice(start, start + PAGE_SIZE);

        tableBody.innerHTML = rows.map(v => {
            const incident = incidentDate(v);
            const report = reportDate(v);
            const files = Array.isArray(v.attachments) ? v.attachments.length : 0;
            // Built once and used by BOTH the desktop Actions cell and the
            // card's footer — below 900px the desktop cells hide and only the
            // card shows (ROW CARD SWAP in style.css). The row-level
            // delegation above serves both copies, because the card cell sits
            // inside the same `tr[data-id]`.
            const actionsGroup = `
                        <div class="action-group">
                            <button class="action-btn view" type="button" title="View details"><i class="fas fa-eye"></i></button>
                            <button class="action-btn report" type="button" title="Download report"><i class="fas fa-file-pdf"></i></button>
                        </div>`;
            return `
                <tr class="owner-violation-row" data-id="${esc(v.id)}">
                    <td data-label="Report"><span class="ticket-link">${esc(v.violationNumber || v.id)}</span></td>
                    <td data-label="Reported">${esc(fmtDate(report))}</td>
                    <td data-label="Incident">${esc(incident ? fmtDate(incident) + ', ' + fmtTime(incident) : '—')}</td>
                    <td data-label="Store">${esc(v.store || '—')}</td>
                    <td data-label="Subject">${esc(v.subject || '—')}</td>
                    <td data-label="Reporter">${esc(v.reportedByName || v.reportedBy || '—')}</td>
                    <td data-label="Files">${files > 0 ? `<i class="fas fa-paperclip"></i> ${files}` : '—'}</td>
                    <td>${actionsGroup}</td>
                    <td class="approval-card-cell" data-label="Card">
                        <div class="approval-card">
                            <div class="approval-card-head">
                                <span class="approval-card-branch"><i class="fas fa-store"></i>${esc(v.store || '—')}</span>
                                <span class="approval-card-pill approval-card-pill--neutral">${esc(v.violationNumber || v.id)}</span>
                            </div>
                            <div class="approval-card-grid">
                                <div class="approval-card-field"><span class="approval-card-label">Report Date</span><span class="approval-card-value">${esc(fmtDate(report))}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Incident Date/Time</span><span class="approval-card-value">${esc(incident ? fmtDate(incident) + ', ' + fmtTime(incident) : '—')}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Subject</span><span class="approval-card-value">${esc(v.subject || '—')}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Reporter</span><span class="approval-card-value">${esc(v.reportedByName || v.reportedBy || '—')}</span></div>
                            </div>
                            <div class="approval-card-foot">
                                <div class="approval-card-expiry">
                                    <span class="approval-card-label">Evidence</span>
                                    <span class="approval-card-note">${files > 0 ? `<i class="fas fa-paperclip"></i> ${files} file${files === 1 ? '' : 's'}` : 'No attachments'}</span>
                                </div>
                                <div class="approval-card-actions">${actionsGroup}</div>
                            </div>
                        </div>
                    </td>
                </tr>`;
        }).join('');

        if (pagination) {
            const from = start + 1;
            const to = start + rows.length;
            const info = `<span class="page-info">Showing ${from}-${to} of ${filtered.length}</span>`;
            if (totalPages > 1) {
                pagination.innerHTML = info
                    + `<button ${page <= 1 ? 'disabled' : ''} data-ov-page="${page - 1}">‹ Prev</button>`
                    + `<span class="page-info">Page ${page} of ${totalPages}</span>`
                    + `<button ${page >= totalPages ? 'disabled' : ''} data-ov-page="${page + 1}">Next ›</button>`;
            } else {
                pagination.innerHTML = info;
            }
        }
    }

    // ===== Modal =====
    function renderAttachments(attachments) {
        if (!attachmentsGrid) return;
        const list = Array.isArray(attachments) ? attachments : [];
        const view = window.AttachmentViewer;
        if (!list.length || !view) {
            attachmentsGrid.innerHTML = '<p class="u-section-sub">No attachments on this report.</p>';
            return;
        }
        attachmentsGrid.innerHTML = list.map(function (att, i) {
            return view.buildAttachmentCard(att, { index: i });
        }).join('');
    }

    function detailsHtml(v) {
        const incident = incidentDate(v);
        const report = reportDate(v);
        // ⚠️ NO "transferred by whom / when" row, matching HR's dialog. The
        // manager already knows the report is theirs, and the transfer line
        // exposed the superadmin's own email address to every recipient — which
        // is how HR's view lost it.
        return `
            <div class="modal-field"><label>Report No.</label><p>${esc(v.violationNumber || v.id)}</p></div>
            <div class="modal-field"><label>Store</label><p>${esc(v.store || '—')}</p></div>
            <div class="modal-field"><label>Location</label><p>${esc(v.location || '—')}</p></div>
            <div class="modal-field"><label>Incident Date/Time</label><p>${esc(fmtDateTime(incident))}</p></div>
            <div class="modal-field"><label>Report Date/Time</label><p>${esc(fmtDateTime(report))}</p></div>
            <div class="modal-field" style="grid-column:1 / -1;"><label>Subject</label><p style="font-weight:600;">${esc(v.subject || '—')}</p></div>
            <div class="modal-field" style="grid-column:1 / -1;"><label>Details of Observation</label><p style="white-space:pre-wrap;line-height:1.6;">${esc(v.details || '—')}</p></div>
        `;
    }

    /**
     * Open a report in the modal. Returns TRUE only when it actually opened.
     *
     * ⚠️ SCOPED AGAIN HERE, NOT ONLY IN THE LIST. `allViolations` holds EVERY
     * manager-transferred report (the Firestore query cannot be branch-filtered
     * — see the header note), so this is the only place standing between the
     * UI and an out-of-scope report. Without this check a stale row id, a
     * bookmarked call or a hand-edited DOM would open another branch's CCTV.
     */
    function openModal(id) {
        const v = allViolations.find(x => x.id === id);
        if (!v) return false;
        const keys = assignedBranches().map(branchKey).filter(Boolean);
        if (!keys.length || !scopeIn(v, keys)) {
            toast('That report is not for one of your branches.', 'error');
            return false;
        }
        currentId = id;
        if (modalTitle) modalTitle.textContent = v.violationNumber || 'Violation Report';
        if (modalBody) modalBody.innerHTML = detailsHtml(v);
        renderAttachments(v.attachments);
        if (modal) {
            modal.classList.add('active');
            return true;
        }
        return false;
    }

    function closeModal() {
        if (modal) modal.classList.remove('active');
        currentId = null;
    }

    /**
     * Download the "COMMAND CENTER REPORT" for the open report.
     *
     * ⚠️ DOWNLOAD ONLY, never re-uploaded. The command center additionally
     * writes the PDF back into the report's Cloudinary folder, but that is a
     * Firestore write and the `owner` role is denied writes on `violations`
     * outright. So the identical PDF (the layout is the shared
     * js/violation-report.js) is regenerated locally and saved, and the copy
     * already in Cloudinary is left exactly as the superadmin wrote it.
     */
    async function downloadReportFor(id) {
        const v = allViolations.find(x => x.id === id);
        if (!v) return;
        const label = btnDownload ? btnDownload.querySelector('span') : null;
        const lib = window.ViolationReport;

        if (btnDownload) btnDownload.disabled = true;
        if (label) label.textContent = 'Preparing…';
        try {
            const name = (lib ? lib.fileName(v) : 'report') + '.pdf';
            const blob = lib ? await lib.buildPdf(v) : null;
            if (!blob) {
                if (lib) lib.print(v);
                else toast('The report builder is still loading. Please try again.', 'error');
                return;
            }
            if (lib) lib.download(blob, name);
            toast('Report downloaded.', 'success');
        } catch (error) {
            console.error('Failed to build the violation report:', error);
            toast('Could not generate the report: ' + ((error && error.message) || 'unknown error'), 'error');
        } finally {
            if (btnDownload) btnDownload.disabled = false;
            if (label) label.textContent = 'Download Report';
        }
    }

    // ===== Live data =====
    function startListener() {
        if (listenerStarted) return;
        listenerStarted = true;

        const service = window.firestoreService;
        if (!service || typeof service.listenTransferredViolationsForAreaManager !== 'function') {
            console.warn('listenTransferredViolationsForAreaManager is unavailable — Area Manager violations list is empty.');
            return;
        }

        service.listenTransferredViolationsForAreaManager(
            (violations) => {
                allViolations = violations || [];
                applyFilters();
                // A report reverted while its modal was open must not stay on
                // screen — close it rather than show stale data.
                if (currentId && !allViolations.some(v => v.id === currentId)) closeModal();
            },
            (error) => {
                console.error('Area Manager violations listener error:', error);
                if (tableBody) {
                    tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">'
                        + '<em>Unable to load transferred violations.</em></td></tr>';
                }
            }
        );
    }

    // ===== Role gate =====
    /**
     * Show the tab ONLY to an Area Manager (stored role 'owner').
     *
     * ⚠️ RM/SM ('rmsm') IS DELIBERATELY EXCLUDED. It shares this dashboard,
     * the branches and the ticket access, but must never see CCTV violation
     * data — its sidebar is Overview + Tickets only. readRole() still
     * RESOLVES 'rmsm' (see isRealRole) so this gate receives the real role
     * and hides deterministically, rather than the boot poll spinning on a
     * value it can never match.
     *
     * ⚠️ HR IS DELIBERATELY NOT INCLUDED, and superadmin is not either. Superadmin
     * works the command center's own Violations tab and HR has its own — giving
     * either of them a second copy here would show two lists of the same data
     * that can drift apart. `hr-violations.js` gates on exactly the inverse set
     * ('hr' | 'superadmin'), so the two modules can never both reveal a tab.
     *
     * The real authorisation is firestore.rules: the violations read clause
     * checks `isOwner()` (owner only, NOT isAreaManager() — that helper also
     * admits RM/SM for the chat roster) AND `managerStatus == 'transferred'`,
     * so even a forced-visible tab could not return anything else.
     */
    function applyRole(role) {
        allowed = String(role || '').toLowerCase() === 'owner';
        if (navItem) {
            navItem.style.display = allowed ? 'flex' : 'none';
            navItem.classList.toggle('u-hidden', !allowed);
        }
        if (!allowed) {
            // A manager-turned-someone-else, or HR, must not reach the section by
            // any route.
            const section = $ov('tabOwnerViolations');
            if (section) section.classList.remove('active');
            closeModal();
        }
        if (allowed) startListener();
    }

    /** Re-run the scope. Called when the branches arrive after the first paint. */
    function refresh() {
        if (!allowed) return;
        applyFilters();
    }

    // ===== Events =====
    function bindEvents() {
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { if (allowed) applyFilters(); }, 250);
            });
        }
        if (storeFilter) storeFilter.addEventListener('change', () => { if (allowed) applyFilters(); });
        if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        // The modal's button always prints whatever report is currently open.
        if (btnDownload) btnDownload.addEventListener('click', () => downloadReportFor(currentId));

        if (pagination) {
            pagination.addEventListener('click', e => {
                const btn = e.target.closest('[data-ov-page]');
                if (!btn || btn.disabled) return;
                page = parseInt(btn.getAttribute('data-ov-page'), 10) || 1;
                render(assignedBranches().length === 0);
            });
        }

        // One delegated listener covers rows re-rendered by every filter change
        // and every snapshot, so no handler is ever attached twice.
        if (tableBody) {
            tableBody.addEventListener('click', e => {
                const row = e.target.closest('tr[data-id]');
                if (!row) return;
                const id = row.getAttribute('data-id');
                // The row's PDF button prints straight from the list.
                if (e.target.closest('.report')) { downloadReportFor(id); return; }
                openModal(id);
            });
        }
    }

    // ===== Boot =====
    /**
     * Current role, however the page exposes it. owner-dashboard.js installs
     * `window.getOwnerRole()` in setActiveUser(); the header role badge is the
     * fallback and is always present in the DOM.
     *
     * ⚠️ 'Area Manager' is the LABEL owner-dashboard.js puts in the badge for the
     * stored role 'owner'. It must map back to 'owner', because applyRole() (and
     * the rules) authorise on the stored value, not the label. Without the
     * mapping the fallback yields '' and the poll below would keep retrying a
     * role it can never match.
     */
    function readRole() {
        if (typeof window.getOwnerRole === 'function') {
            const r = window.getOwnerRole();
            if (isRealRole(r)) return String(r).toLowerCase();
        }
        const badge = $ov('ownerUserRoleBadge');
        const text = badge ? String(badge.textContent || '').trim().toLowerCase() : '';
        if (isRealRole(text)) return text === 'area manager' ? 'owner'
            : (text === 'rm/sm' ? 'rmsm' : text);
        return '';
    }

    /**
     * Is this a ROLE WE CAN ACT ON, or the placeholder?
     *
     * ⚠️⚠️ THIS IS THE WHOLE REASON THE TAB NEVER APPEARED.
     * `owner-dashboard.js` declares `let activeUserRole = 'viewer'` and resolves
     * the real role ASYNCHRONOUSLY from Firestore. So at DOMContentLoaded —
     * when this module first asks — `getOwnerRole()` returns the TRUTHY string
     * 'viewer'. The obvious `if (r) return r` therefore "succeeded" on a
     * placeholder, applyRole() ran with a role that is not the user's, and the
     * nav item was hidden. Worse, because readRole() had returned truthy the
     * poll believed it was finished and STOPPED, so the real role arriving a
     * moment later was never picked up — the tab stayed hidden for the whole
     * session with no error anywhere.
     *
     * The fix is to treat the non-stored placeholders as "not known yet" and
     * keep polling. 'viewer'/'editor' are UI labels owner-dashboard.js uses for
     * accounts that have no stored role; they are not roles the rules or
     * applyRole() authorise on.
     */
    function isRealRole(role) {
        const r = String(role === null || role === undefined ? '' : role).trim().toLowerCase();
        // 'area manager' / 'am' are the LABELS owner-dashboard.js renders in the
        // role badge for the stored role 'owner', so they must be accepted here
        // too — otherwise the badge fallback can never resolve an Area Manager
        // and the tab stays hidden on exactly the role it was built for.
        // 'rm/sm' / 'rmsm' are accepted for the same reason: readRole() must
        // RESOLVE a real role so applyRole() can make the call. applyRole()
        // itself deliberately excludes 'rmsm' (Overview + Tickets only), so
        // resolving here is what lets the hide happen deterministically
        // instead of leaving this poll spinning 40 times on an unknown value.
        return r === 'owner' || r === 'hr' || r === 'superadmin'
            || r === 'area manager' || r === 'am'
            || r === 'rmsm' || r === 'rm/sm';
    }

    function init() {
        bindEvents();

        // owner-dashboard.js resolves the role asynchronously from Firestore, so
        // on first paint it may not be known yet. Poll briefly, then stop: an
        // unauthenticated or slow visit simply never shows the tab, which is the
        // safe direction to fail in.
        let tries = 0;
        const checkRole = () => {
            const role = readRole();
            if (role) { applyRole(role); return; }
            if (++tries < 40) setTimeout(checkRole, 250);
        };
        checkRole();

        // The BRANCH list resolves separately from the role, so it can still be
        // empty when the role lands. Re-check it a few times; without this the
        // first render would fail closed and — if no further snapshot arrived —
        // stay empty until the manager reloaded the page.
        let branchTries = 0;
        const checkBranches = () => {
            if (!allowed) return;
            if (assignedBranches().length) { refresh(); return; }
            if (++branchTries < 40) setTimeout(checkBranches, 250);
        };
        setTimeout(checkBranches, 300);
    }

    window.OwnerViolations = {
        applyRole: applyRole,
        applyFilters: applyFilters,
        openModal: openModal,
        closeModal: closeModal,
        readRole: readRole,
        refresh: refresh,
        scopeIn: scopeIn,
        branchKey: branchKey
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();