# CCTV Command Center — Interface Guide

This document describes the shared UI system and where things live after the interface overhaul.

## Pages

| Page | Audience | Purpose |
|---|---|---|
| `login.html` | Staff | Login + registration (green brand theme, dark mode, show/hide password, forgot password) |
| `pending-approval.html` | New staff | Shown while a superadmin approves a new account ("Check Status" / "Logout") |
| `submit-ticket.html` | Public | Submit a ticket + track status |
| `main.html` | Operator / Superadmin | Command Center: Dashboard, Branch Monitor, Status History, Tickets, Violations, User Approvals, Ticket Reviews. Floating chat circle (superadmin only) |
| `ownerdashboard.html` | Owner | Read-only tickets for owned branches. Floating chat circle (owner + superadmin) |

## Theme system (dark mode)

* `theme.css` — loaded **after** `style.css`. Defines `[data-theme="dark"]` variable overrides, the white-logo treatment, and shared header components (theme toggle, nav section labels).
* `js/theme.js` — theme manager. Reads/writes `localStorage['rcms_theme']`, **defaults to `light`** (the OS/browser preference is deliberately ignored, so a user on a dark-mode machine still lands on the light UI — dark is opt-in via the toggle button), re-styles Chart.js instances on change, and exposes `window.ThemeManager`.
* Every page has a tiny **pre-paint script** in `<head>` that applies the saved theme before first paint (prevents the light flash).
* Toggle buttons carry the attribute `data-theme-toggle` — `theme.js` binds them automatically. The icon swaps moon/sun on its own.
* `theme.css` also sets `color-scheme: dark` inside the dark block, so **browser-drawn** controls (native `<select>` dropdowns, scrollbars, date pickers) follow the theme instead of rendering light-on-light.

### ⚠️ `ownerdashboard.html` dark mode — hardcoded light surfaces

The owner page's inline `<style>` blocks are the one place in the app that shipped **hardcoded light values**, and the tickets table was unreadable in dark mode because of it:

```css
#ownerTicketsTable tbody td { background: rgba(255, 255, 255, 0.7); }
```

A permanent 70%-opaque white on every cell. In dark mode the cell text is `--text-primary` (`#E2E8F0`) over a composited `~#B6BCC0` — roughly **1.3:1 contrast**, against the **4.5:1** WCAG AA minimum. Every column was unreadable, plus the empty state (it lives in a `<td>` too).

**Why the header looked fine:** `theme.css` already had a half-fix for the sticky header only (`html[data-theme="dark"] #ownerTicketsTable thead th { background: #16233B }`), which wins on specificity `(1,1,3)` over the inline rule's `(1,0,2)`. The body cells never got an equivalent, so the white wash stayed.

**The fix is page-local tokens, not dark overrides.** `ownerdashboard.html` defines eleven `--owner-*` custom properties in a `:root` block with a `html[data-theme="dark"]` counterpart for each. The consuming rules reference only the tokens. The **light values are the exact values that were hardcoded before**, so light mode is byte-identical and only the dark column differs. Crucially `--owner-ticket-row` resolves to `transparent` in *both* themes, which removes the white wash entirely and lets the already-themed `.data-table td` base in `style.css` paint the cell — one rule, both themes, no second copy to keep in sync.

Tokens: `--owner-elev-0..3` (elevation; dark borrows `theme.css`'s real `--shadow-*`, because a dark-navy shadow on a dark surface is invisible), `--owner-hover-border`, `--owner-focus-border` / `--owner-focus-ring` (keyboard focus was a 13%-alpha ring — invisible on dark; now brighter and wider), `--owner-ticket-link-hover`, and `--owner-ticket-head` / `--owner-ticket-row` / `--owner-ticket-row-hover`.

**`test/owner-dark-mode.test.js` guards this** (wired into `npm test`). It strips the token-definition blocks and then fails the build on any hardcoded `rgba(255,255,255,…)` background, near-white surface, dark-navy drop shadow, or low-alpha blue border/focus ring in a consuming rule — and separately asserts that **every light token has a dark counterpart**, since a light-only token is the next regression.

### ⚠️ Role badges — the same class of bug, in the SHARED stylesheet

The first guard only scanned `ownerdashboard.html`'s **inline** styles, so it could not see classes defined in the shared `style.css`. That is exactly where the next invisible-text bug was:

```css
.role-badge.hr { color: #0e7490; background: rgba(14,116,144,0.12); ... }   /* style.css */
```

`style.css` picks each role's colour as a **dark** tone for a light chip — HR teal `#0e7490`, Owner violet `#7c3aed`, Superadmin amber `#b45309`, Viewer blue `#2563eb`. All four are correct on white and unusable on a dark surface, and **none had a dark override anywhere**. The HR badge (the one on the dashboard header) composited to roughly `#10263A` behind `#0e7490` text — **2.4–2.9:1** against a 4.5:1 WCAG AA minimum.

Fixed in `theme.css`, where all dark overrides live. Each role keeps its **hue** but steps up to a 300/400-shade tint, and the chip fill/border alphas are raised so the badge still reads as a badge:

| Role | Dark text | Contrast |
| --- | --- | --- |
| Superadmin | `#fbbf24` | 6.98:1 |
| Owner | `#a78bfa` | 5.29:1 |
| HR | `#5eead4` | 8.58:1 |
| Viewer | `#93c5fd` | 6.97:1 |
| Editor | `var(--color-resolved)` | 7.14:1 |

**The guard now computes real WCAG contrast** rather than eyeballing it. The test recomputes relative luminance and the contrast ratio from the colours actually written in `theme.css`, composites each badge's translucent fill over the dark `--bg-card`, and fails below 4.5:1. It also fails if a role has no dark override at all, which is the original bug. Mutation-tested: reverting the HR badge to `#0e7490` fails with `2.37:1`.


### Dark palette (in `theme.css`)

`--bg-primary #0B1220 · --bg-secondary #0F172A · --bg-card #101B2E · --bg-input #15223A · --border-color #24334D · --text-primary #E2E8F0`

The brand green `#72bf6a` stays the primary color in both themes; blue `#2563eb` is reserved for "In Progress / info".

### Logo — black PNG rendered white in dark mode

All logo `<img>` tags use `class="brand-logo"` (app pages) or `class="login-logo"` (login-family pages). In dark mode `theme.css` applies `filter: brightness(0) invert(1)` which turns the black Jiangnan PNG pure white — no separate white asset needed. In light mode no filter is applied. A local fallback (`header.png`) loads via `onerror` if the CDN logo is unreachable. If you ever commission a true white logo, drop the filter rule.

## Shared header components

* **Sidebar section labels** — `.nav-section-label` groups the admin nav into OPERATIONS / INCIDENTS / ADMINISTRATION. The Administration label only appears for superadmins (`#adminNavLabel`, toggled from `script.js`).

## Admin nav (renamed)

* `Pending Approvals` → **User Approvals** (superadmin user management)
* `Ticket Approvals` → **Ticket Reviews** (superadmin ticket approval workflow)

Tab keys (`data-tab`), IDs (`usersNavItem`, `approvalsNavItem`), badges, and refresh-state persistence are unchanged.

## 2-Day Tracking Access (approved tickets)

> ⚠️ **CURRENTLY IN TIER-2 TEST MODE** — `window.TRACKING_ACCESS_WINDOW_MS` in `firebase.js` is temporarily **1 minute** so the approve → expire → resend flow can be watched live. **Revert it to `2 * 24 * 60 * 60 * 1000` before deploying.** `npm test` prints a `⚠️⚠️ TIME-COMPRESSION ACTIVE` warning while this is set; every "1 minute" label in the UI (Approved Report countdown, Resend button/tooltip/confirm/toast) comes from `formatTrackingAccessWindow()` and flips back to "2 days" automatically on revert.

* On approval, `script.js → approveResolution()` writes `accessExpiresAt = now + 2 days` on the ticket. Helpers live in `firebase.js` (`window.TRACKING_ACCESS_WINDOW_MS`, `window.getTrackingAccessExpiry()`, `window.isTrackingAccessExpired()`); tickets approved before the feature existed derive their window from `approvedAt + 2 days`.
* **Track page (`submit-ticket.html`)** — once the window lapses the manager/store only sees the "access expired" notice (`#trackExpired`, a single danger card with just the expiry line: *"Viewing access for this ticket expired on <date, time>…"*): the Approved Report, footage and *Request Additional* stay hidden. While active, the Approved Report header shows *"Viewing access until …"*.
* **Resend (superadmin only)** — `window.resendTrackingAccess(id)` restarts a fresh 2-day window and records `accessResentCount` / `accessLastResentAt` / `accessLastResentBy`. It is exposed as a row action in the Approvals tab, as the `Resend Access (2 Days)` footer button in the approval details modal, and the status filter gains an **Access Expired** option.
* **Re-access request (Option 1 — request, superadmin approves)** — the expired notice on the Track page now carries a *"Request to open this ticket again"* form (reason textbox, ≥5 chars, Ctrl/Cmd+Enter also submits). Submitting appends a `comments` note `{ type: 'access_reopen_request', text: <reason>, requestedBy, requestedByEmail, requestedByContact, requestedAt }` and sets the top-level `accessReopenRequest` `{ status: 'pending', reason, requestedBy/Email/Contact, requestedAt, requestCount }`. `currentTrackTicketId` stays `null` while expired, so *Request Additional* can never fire from the locked state, and a history list under the form shows *Awaiting approval — we will email you* / *Fulfilled — access resent on …*. The dashboard fires a desktop alert (`countAccessReopenRequests()` → `showAccessReopenRequestNotification()`), the Approvals **Access Expires** column swaps its red `Expired` badge for a single amber **✉ Reopen requested** chip (red dot kept, `×N` = times asked, tooltip = *Reopen requested ×N — Reason: … — <requester> · Access expired <date, time> · Press Resend to approve*), so those rows stay one line tall, and the details modal renders a **Manager Re-access Request** card (reason / requester / times / status). The footer button then reads **Approve Request & Resend (…)**, and pressing it opens the confirm dialog *Approve Re-access Request* which spells the message out and **highlights the manager's reason in its own amber block** (`reason` / `reasonLabel` / `reasonMeta` options of `showConfirmDialog()` → `#confirmModalReason`, requester & timestamp as the meta line) — pressing it grants the fresh window **and** flips `accessReopenRequest.status` → `fulfilled` (`resolvedAt`, `resolvedBy`) while keeping the whole reason history.
* **Re-access approval email** — approving a *pending* re-access request (the **Approve Request & Resend** button) also emails the store/manager, but with a different message and a different recipient rule than the approval mail:
  * `resolveReopenRecipient()` picks `accessReopenRequest.requestedByEmail` **first** (the store/manager who asked from the Track page — usually a *different* person from whoever reported the ticket), then falls back to `ticket.email` / `ticket.contact`.
  * `buildAccessApprovedEmail()` / `sendAccessApprovedEmail()` send *"Your request to view this ticket again has been approved."* with subject `Ticket Access Approved — <TICKET>`. It reuses the **same** bridge, secret and 45s timeout — no new deployment.
  * The fresh `accessExpiresAt` is passed **explicitly** rather than read off the ticket, because the in-memory copy still holds the old, already-expired date; a stale/past window is never promised to the manager.
  * A plain **Resend** (nobody requested it) sends **no** email, and the outcome is recorded on the ticket as `accessApprovedEmail` for the ✉ tooltip.
  * Deep link: the body links to `submit-ticket.html?track=<TICKET>`, which opens the Track modal and **prefills the Ticket Number** (`deepLinkedTicketNumber` in `submit-ticket.html`, once per page load). It **never auto-submits**, and the **contact/email is deliberately NOT put in the URL** — it would sit in the browser history and in any screenshot the manager shares, so the two-factor lookup is unchanged: they still type their email and press *Lookup Status*.
* The Approvals table has an **Access Expires** column (`Date · time`, or a red `Expired` badge — replaced by the single amber **✉ Reopen requested** chip while a re-access request is pending) — so its empty-state `colspan` is `9`.
* **Nothing is ever deleted**: expiry only gates viewing on the public track page. Operators, owners (`ownerdashboard.html`) and superadmins keep full access. Enforcement is client-side; see the `TODO (security)` note in `firestore.rules` if you later want a rules-level block.

## Approval Email Notification (requester notification)

When a **superadmin approves a resolution** (`script.js → approveResolution()`, Ticket Reviews tab) the requester is emailed automatically *after* the approval is safely in Firestore:

> **From:** Jiangnan Command Center ‹jiangnancommandcenter@gmail.com› · **Reply-To:** Ticket Requester ‹jiangnancommandcenter@gmail.com›
> **Subject:** `Ticket Request Completed — BNW-TIX007`
> *"Ticket request was done, please check your request to the portal with this Ticket number: BNW-TIX007"* + the `submit-ticket.html` link (Track Ticket Status) + the business signature.

* **`js/email-config.js`** — non-secret config only: `endpoint` (Apps Script `/exec` URL), `secret`, `senderName`/`senderEmail`/`replyTo`/`replyToName`, `portalUrl` (**required in production** — the public `https://` address of `submit-ticket.html`; empty auto-derives it from the superadmin's current page, which is fine on localhost but emails a dead link to requesters if that page is on an intranet host, a `file://` path or a LAN address), `toDisplayName`, `enabled`. Verify with `await verifyPortalLink()` in the console — it flags `file://`, localhost, private LAN addresses, internal-only names, and hosts with no public DNS record (the cause of `DNS_PROBE_FINISHED_NXDOMAIN` in a requester's inbox). **No mailbox credential ever lives in the site** — a browser cannot speak SMTP (no raw TCP/TLS sockets) and Gmail's HTTPS API is OAuth2-only, so an app password in client JS could never send *and* would expose the whole mailbox in View Source.
* **`js/email.js`** (`window.EmailService`) — `resolveRecipient()` (`ticket.email` → `contact` when it is an email → `accessReopenRequest.requestedByEmail`), `buildTicketApprovedEmail()`, `shouldMentionViewingWindow()` (the "viewing access until …" line is **omitted while Tier-2 time-compression runs** and for already-expired tickets), `shouldSkipApprovalEmail()` (idempotency), `sendTicketApprovedEmail()` (single `no-cors` fire-and-forget POST — never retried, because a retry would double-send), plus `window.sendTestTicketEmail('you@example.com')` for a console smoke test.
* **Sending is done by a Google Apps Script Web App** (`docs/apps-script/RCMS-Ticket-Notifier.gs`, deployed from the business Gmail account; ≈5 min, **no billing**, **no app password** — `docs/EMAIL-SETUP.md`). `GmailApp`/Gmail API make the message come from the real business mailbox and keep a copy in **Gmail ▸ Sent**. Because the `/exec` URL is public, the script verifies the caller's **Firebase ID token** and requires `users/<email>.role == 'superadmin'` before sending, then applies an 80/day cap and checks the recipient against the ticket document → anonymous callers and plain operators get `UNAUTHORIZED` and nothing is sent.
* **Best-effort by design:** the approval is never blocked, cancelled or rolled back by email trouble. Each attempt is recorded on the ticket as `approvalEmail { status: 'dispatched' | 'failed' | 'skipped_no_recipient', to, error, sentAt, sentBy, attempts }`, a toast reports the outcome, and the **✉ row action** (superadmin only, approved rows) retries — it shows the last delivery state in its tooltip and is the way to notify a legacy ticket approved before this feature existed.
* **Duplicate guard:** a repeated/replayed approve click on an already-approved ticket never emails twice; a rejection cycle (which resets `approvalStatus` to `pending_approval`) does notify again on the next approval. The ✉ action deliberately bypasses the guard.
* Covered by `test/ticket-email.test.js` (vm sandbox + stubbed `fetch`/`auth`, real access-window helpers from `firebase.js`) and by the syntax checks in `npm test`.


## Set Role — Owner vs HR (User Approvals)

> A superadmin assigns each user one of two roles from the **User Approvals** tab. **HR and Owner use the same dashboard** — the only differences are the label on their profile and **chat access**.

* **Two assignable roles only:** `ASSIGNABLE_ROLES = ['owner', 'hr']`. A **Role** dropdown sits at the top of the existing expandable detail panel (above Branch Access), pre-selected to the user's current role, with a live hint that explains the consequence of each choice. A **Role** column was added to the table so Owner/HR is visible without expanding a row.
* **`approveUser()` and `updateUserPermissions()` no longer hardcode `role: 'owner'`** — they write the selected role, so an existing user's role can be changed by simply saving them again. Toasts confirm the outcome ("User approved as HR.").
* **Chat access is the only functional difference:**
  * **HR → chat.** Uses the same `chats/{chatId}` thread, the same typing indicator, the same sound.
  * **Owner → no chat at all.** The floating circle never renders.
  * Everything else (branches, feature permissions, resolved-tickets-only scope, the "My Access Level" tile) is identical.
* **Three layers keep the chat gate honest**, all of which had to move together — `CHAT_ALLOWED_ROLES = ['hr','superadmin']` in `js/chat.js`, the `ChatService.init()` surface gate, and **`isHrOrSuperAdmin()` in `firestore.rules`** (renamed from `isOwnerOrSuperAdmin`, all 9 call sites updated). If the rules and the client ever disagree you get a chat button that fails on send, so `test/chat-rules.test.js` **parses both files and asserts they list the same roles**, and fails the build if the removed `isOwnerOrSuperAdmin` helper is ever referenced again.
* **Role values are clamped, not trusted.** `currentUserRoleLabel()` / `clampRoleSelection()` normalise case and whitespace and reject anything outside the allowlist, defaulting to `'owner'` (the safe, no-chat default). A hand-edited `<select>` therefore cannot write `superadmin` or `operator` into a user document. New accounts still self-register as `role: 'owner'` + `status: 'pending'`, so the default is unchanged.
* **HR is routed to the Owner Dashboard** (`js/auth.js`: `role === 'owner' || role === 'hr'` → `ownerdashboard.html`) and is deliberately *not* caught by the page's operator redirect. HR is also included in the `ownerResolvedOnly` check so it cannot gain a wider ticket scope than an owner by accident.
* **⚠️ Existing owners lose chat immediately** — their docs already say `role: 'owner'`, so the circle disappears on their dashboard as soon as this ships. Nothing else is affected; re-assign the ones that need chat to `hr` from the same screen.
* Covered by `test/set-role.test.js` (allowlist, normalisation, hint text, tamper-clamping), plus the inverted assertions in `test/chat-access.test.js` and `test/chat-rules.test.js`.

## Violations Sidebar Badge + Unseen Rows (per-report)

> The red count beside **Violations Report** means *"reports **you** have not opened yet"*. It clears **only** when you actually open an individual report — opening the tab does **not** clear it.

* **Why per-report, not per-tab.** Operators and superadmins **share** the Violations tab. A per-tab "seen" model is wrong there: someone could open the tab, glance at the list, walk away — and every report would be marked read for them. So acknowledgement is recorded in `markViolationSeen(id)` from `openViolationModal()` (the ticket link, the row, or the 👁 View button), which is the one action that means *"I have read this report"*.
* **`switchTab('violations')` deliberately does NOT clear the badge** (and `updateViolationsBadge()` no longer hides it while that tab is on screen). Being on the tab is not the same as having read anything.
* **What it looked like before** (all three were wrong):
  1. A **rolling 24-hour window** (`createdAt >= now - 24h`) — ignored what you had seen, so the badge could never clear and a stale count looked like a fresh alert.
  2. **Cleared on tab open** — wrong for a shared tab (the version just replaced).
  3. **Per-report, on actual open** — current.
* **Unread rows are highlighted.** A tab you share with another role gives you no way to tell *which* reports are unread, so unseen rows get `tr.violation-row-unseen` (brand-tinted background + a green left edge) and a small green dot next to the violation number. The row re-renders when a report is opened, so the highlight disappears immediately.
* **Persisted per user** in `localStorage['rcms_violations_seen_<email>']` as a **JSON array of violation document ids** (not a timestamp), so two accounts on one browser stay independent and the state survives a reload. All access is try/catch'd, and the list is **capped at 500 ids** so storage cannot grow without bound. A **legacy value** (an older build wrote a plain timestamp here) and **corrupt JSON** are both discarded, degrading to "everything unseen" rather than throwing.
* The sidebar count caps at **`99+`** so the label cannot blow out the nav layout.
* Wiring: `loadViolationsSeen()` runs in `setupViolationListener()` **before** the first snapshot, so already-reviewed reports do not re-raise the badge on load.
* Covered by `test/violations-badge.test.js` (11 assertions, vm sandbox — no browser needed) and by the `node --check script.js` syntax check in `npm test`.

## Violation → HR Transfer ("Transfer to HR")

> An operator files a CCTV violation → it lands on the **command center** → the **superadmin reviews it** → if it is worth an incident report they press **Transfer to HR** → it appears on the **HR dashboard, read-only**. If it is *not* worth one, the superadmin does nothing and the report stays on their side only.

* **The report is not moved or copied.** The same document gains `hrStatus: 'transferred'` (plus `transferredAt`, `transferredBy`, `transferredByName`). It stays in the superadmin's Violations list, now carrying a green **"Transferred to HR"** pill (`.violation-hr-pill`, themed via the `--color-resolved*` tokens so dark mode stays readable), and the **superadmin's** details modal shows an **HR Status** line with who transferred it and when. HR's own modal deliberately shows **no** transfer line and **no** "Reported By" line — both are redundant on a list HR only ever sees transferred reports on, and either would expose a colleague's identity (the transferring superadmin's email, and the reporting operator) to every HR who opens a report. The superadmin still sees the reporter in their own modal, in the table, and in the PDF. HR therefore reads the *same* record — the same attachments, the same Cloudinary evidence, the same report number.
* **Only a superadmin can transfer.** `refreshTransferButtonState()` hides the button for anyone else, and `toggleViolationTransfer()` independently refuses the call, so hiding the control is not the only thing standing between an operator and HR's desk.
* **It is reversible.** The same button becomes **"Revert Transfer"** once a report is transferred. `revertViolationTransfer()` **deletes** `hrStatus` (rather than setting another value) so the document returns to its original shape and immediately stops matching the HR rule. The revert is recorded in `revertedAt` / `revertedBy`.

### Why the rules are the real gate

```
allow read: if isOperatorOrSuperAdmin() || (isHr() && isTransferredToHr());
allow create: if isOperatorOrSuperAdmin();
```

* HR reads **only** transferred documents, and the `create` rule was deliberately split off the `read` rule so it cannot be widened by accident. **No update or delete rule mentions `isHr()`** — HR has no write access to `violations` at all, which is why the HR tab ships no edit/delete/transfer control in the first place.
* ⚠️ **The `where()` in `listenTransferredViolations()` is required, not an optimisation.** Because the rule inspects `resource.data`, Firestore will only run a query it can prove. An *unfiltered* query from HR is **denied by design** — that denial is the privacy guarantee working, not a bug. A single equality filter on one field needs no composite index, so it works on the free plan.
* ⚠️ **`isOperatorOrSuperAdmin()` must stay `[operator, superadmin]`.** Adding `'hr'` to it would hand HR write access to *every* report. `test/violation-hr-transfer.test.js` asserts the exact allowlist.
* The nav item ships with `style="display:none;"` and is revealed only once `js/hr-violations.js` confirms the role is `hr`/`superadmin` via `window.getOwnerRole()`. (That accessor exists because `activeUserRole` is a top-level `let` — a *script-scoped* binding, **not** a property on `window`, so it cannot be read from another file.) An owner is also actively de-activated off the section, since refresh-restore can otherwise land them on a tab they may not use.
* Reports filed **before** this feature have no `hrStatus` field, so they simply never match `isTransferredToHr()` and remain operator/superadmin-only — the correct default.

### One report layout, two pages

The "COMMAND CENTER REPORT" PDF builder was extracted out of `script.js` into **`js/violation-report.js`**, because the HR dashboard does not load `script.js` and therefore could not print the report it was being sent. Both pages now load the one module; `script.js` keeps thin delegating wrappers so its existing call sites are unchanged, and the duplicated ~170 lines plus the orphaned letterhead constants are gone. The module is an **IIFE** publishing only `window.ViolationReport` — two classic scripts may not both declare the same top-level `const`, which would throw *"already been declared"* and kill the page.

**HR downloads only.** The command center also re-uploads the regenerated PDF into the report's Cloudinary folder and rewrites `attachments`; HR must not, because that is a Firestore write the `hr` role is denied. So HR regenerates the identical PDF locally and saves it, leaving the stored copy untouched. If jsPDF is unavailable (offline / CDN blocked) both paths fall back to a print-friendly window rather than dead-ending.

* Covered by `test/violation-hr-transfer.test.js` (rules + wiring, static) and `test/violation-hr-view.test.js` (runs `js/hr-violations.js` against a stubbed DOM: role gate, transfer-only filter, search, store filter, empty state).
* ⚠️ **Deploy the rules** with `firebase deploy --only firestore:rules`, or HR will hit a permission error until you do.

## HR <-> Superadmin Chat

> A floating **chat circle** in the upper-right of the viewport; clicking it opens a **chat modal** with a **conversation list** on the left and the selected thread on the right. It is deliberately **not** in the sidebar, and it is deliberately **not** a nav item.

### ⚠️ ONE CONVERSATION PER PAIR (was: a single shared room)

The original implementation had **one** room document, `chats/owner-superadmin`, which every HR and every superadmin read and wrote. With more than one HR account that means everybody sees everybody's messages. Conversations are now **1:1**, one room per superadmin ↔ HR pair.

* **Room id** — `dmRoomIdFor(a, b)` = `dm_` + the two emails, URL-encoded, lowercased and **sorted**, joined by `__`. Sorting is what makes it symmetric: `hr@x.com` and `boss@y.com` derive the same id, so no lookup document is needed and neither side can end up in its own empty room. Exported on `ChatService` and unit-tested — a mismatch here is completely silent (messages simply never arrive).
* **Who may be messaged** — strictly 1:1 by role. An HR may only start a thread with a **superadmin**, and a superadmin only with an **HR**. Two HRs can therefore never share a room, which is exactly what keeps each conversation private to its pair.
* **✅ The conversation LIST is the only way to start a conversation — the ＋ button and its picker are gone.** They were removed on request, and nothing was lost: every person a thread may be started with is *already* a row in the sidebar, rendered as a **"Tap to start a conversation"** placeholder (the union of the people directory and, for a superadmin, the `users` account roster), and clicking that row opens the pair's room. The picker offered the same people in a floating panel above the list — a second entry point into one list, and the one most people never found. What went with it: the `.chat-sidebar-head` row (it held nothing but that one button and reserved ~48px of dead space, so `.chat-search` now carries its own top margin), the `.chat-icon-btn` and `.chat-newmenu*` CSS, and the empty-state line "No conversations yet. Use ＋ to start one" — replaced with "Nobody to message yet. New colleagues appear here as soon as their account is approved", because an empty list now genuinely means nobody to talk to rather than "you have not found the right control". Three guards keep it from creeping back: the modal must not contain `#chatNewBtn`/`#chatNewMenu` (`test/chat-conversations.test.js`), neither `js/chat.js` nor `chat.css` may mention them (`test/chat-rules.test.js`), and the two tests that used to drive the picker now click a list row instead — the guarantee (only role-eligible peers are offered, and the row opens that pair's room) is unchanged; only the way in is.
* **✅ The ALL HR GROUP CHAT — a channel everybody is in from the start.** The pinned **"All HR — group chat"** row is the legacy room `chats/owner-superadmin`, and it is *the right room for a group precisely because it has no member list*: access there is `isLegacyArchive` = `isHrOrSuperAdmin()`, i.e. gated on the **ROLE**. So a **brand-new HR or superadmin account is in the conversation the moment its role is set** — nothing to invite, nothing to add, and nothing that can go stale. That is not a nicety, it is the only design that works here: a membership list can only ever hold the people present when the room was created, and the deployed rules **refuse a room UPDATE**, so nobody could ever be added afterwards. Details:
  * **Always listed, always openable.** The row is pushed *unconditionally* (a new account is in the room before any summary has arrived) and pinned **last**, so a busy sidebar can never bury it. It contributes nothing to the unread badge: one pinned row, not a conversation that goes quiet.
  * **A live channel, not an archive.** The composer works, the thread subscribes (even before a summary exists, so it is never blank), and a message is written with **no room preview** — the row is pinned and needs none, so a write the rules would refuse is never even attempted.
  * **Nothing per-room is attempted there.** Typing presence, ✓✓ read receipts and reactions are all `isChatMember`-gated writes, i.e. per-room, so in a room with no member list the rules would refuse them. The client skips them outright (the typing bar is hidden, a reaction says "Reactions are only available in 1:1 conversations") because a permanent console warning is a worse outcome than a feature that never claims to exist.
  * **If the room does not exist yet** (a brand-new project), the thread shows "The group chat is empty — send the first message" and the composer still works; the first message creates the room with `type: 'group'` and `members` = **everyone this device knows** (`everyoneKnownForGroup()`), so even a membership-gated ruleset would let them all in. That list is a fallback, not the mechanism.
  * `firestore.rules` gained the matching `allow create` for messages in that room (gated on `isLegacyArchive` + `senderEmail == selfEmail()`), so a future deploy keeps the group chat working instead of leaving a pinned row that refuses every message. Room documents there are still frozen, and messages stay immutable. Covered by `test/chat-conversations.test.js` §6 (the group chat is openable, composable, actually saves, publishes no presence, and attempts no room preview, and the short payload is retried when both shapes are refused) and by `test/chat-rules.test.js` §14 + the messages block guards.
  * **⚠️ A group send refused with `Missing or insufficient permissions` while 1:1 sends fine is THAT clause missing from the *deployed* ruleset** — the message carries the identical payload a 1:1 send writes and every other write in the room is skipped by design, so the payload is not the difference. `sendMessage()` now says exactly that: a `console.warn` names the missing `allow create: if isLegacyArchive(chatId) && request.resource.data.senderEmail == selfEmail();` on `chats/owner-superadmin/messages` (which `firestore.rules` here already has) and the toast names the fix, `firebase deploy --only firestore:rules`. The **short-payload ladder also runs for a group message** — only the room-preview rung stays 1:1-specific — so a deployed `hasOnly()` that predates `mentions`/`replyTo` is retried in the group too instead of being the one message with no fallback.
* **The people directory** — reuses the **legacy room's `profiles` subcollection** (`chats/owner-superadmin/profiles/{emailKey}` = `{ email, role, displayName, title }`). It exists because `users` was unreadable by an HR member (`allow read: if isSuperAdmin() || isSelf()`) — an HR may now read only the *superadmin slice* of it, see the roster bullet below — so a conversation list built on `users` alone would have been empty for exactly the people who need it. It is deliberately **not** a new `chatProfiles` collection: a new collection would need a new rule, and until that rule is *deployed* the read is denied and the list is empty. Reusing `profiles` needs no new rule, so **the directory works with nothing deployed**. Each person publishes their own entry from the chat profile editor. It holds no permissions and no account data, so it cannot grant access to anything.
* **⚠️ The directory alone cannot list every account, so BOTH sides also read `users` — and now LIVE.** The directory is **self-published**: a person appears in it only after they have opened the chat and saved a profile, and the `role` in that entry is whatever was current at that moment. A brand-new HR who has never opened the chat is therefore missing from the superadmin's list entirely (\"the superadmin cannot see all the HR accounts\"), and an entry published before the role was known (`role: ''`) is filtered out by `isStartable()`. The authoritative role is **`users/{email}.role`** — the field the rules and the dashboard both authorise on — and a **superadmin** may read that collection *whole* (`allow read: if isSuperAdmin() || isSelf()`): `script.js`'s `loadSuperadminUsers()` already reads it exactly that way in production, so this needs **no rules deploy** and — because there is **no `where()` clause**, filtering happens client-side — **no index**, and a role stored as `'HR'` or `' hr '` still counts (an equality filter would silently miss it). The two sources are **unioned, never swapped**: the directory supplies `displayName`/`title` (what the person chose to show) while the roster supplies the `role`, so a stale profile can never hide an HR the roster knows about. An **HR reads it too — the other half of the feature.** "Any HR may message any superadmin" needs the same authoritative source in the other direction, and the directory cannot supply it (a brand-new superadmin has no profile entry either). So `firestore.rules` carries a SECOND read statement — `allow read: if isHrOrSuperAdmin() && resource.data.role == 'superadmin';` — which is per-document and therefore provable only for a query filtered the same way: the client asks with `users.where('role', '==', 'superadmin')`, so an **unfiltered** HR read of `users` stays denied and owner/operator accounts (with their statuses and permissions) stay out of reach. The equality cannot miss anybody, because chat access itself is granted by the case-sensitive `role in ['hr','superadmin']`. ⚠️ **This half needs `firebase deploy --only firestore:rules`** — until then the HR's roster listener reports `HR roster unavailable` and degrades to the directory exactly as described below, so nothing breaks while the ruleset is older than the client. A denied or failed roster read is caught and reported (`HR roster unavailable`) and degrades to the directory instead of breaking the chat, and it is re-read by `ChatService.refreshDirectory()` — which `script.js` already calls immediately after an account is approved or re-roled, so a newly promoted HR appears with no reload. The roster is a **live `onSnapshot` listener for BOTH roles** now: an account registered or approved on *another* device — or while this page is open — appears on every screen with no reload at all (a single one-shot `.get()` only ever answered for the device that asked), while `ChatService.refreshDirectory()` remains the immediate refresh for the machine that made the change. Covered by `test/chat-conversations.test.js` (never-messaged HR listed and startable; owners and self never offered; roster role beats a stale directory role; denied read degrades and recovers; an HR reads `users` through the role-scoped query and sees every superadmin — including one who has never opened the chat — while owners and other HRs are never offered; a new registrant appears LIVE in both directions with no refresh call) and by `test/chat-rules.test.js` (the two separate `users` read statements, the HR-only `where('role','==','superadmin')`, the `!canChat()` gate, the opposite-role filter, the single stored listener and its release on teardown, wired into mount + refresh) and by `test/chat-access.test.js` (a superadmin reads the collection whole, an HR reads the role-scoped slice).
* **⚠️ The conversation list survives a DENIED list query.** The list is normally **one** query (`chats where members array-contains me`) — no index, no paid plan. But a query is authorised as a **single rules evaluation over the whole collection**, and the membership rule resolves every room with `exists()`/`get()`, which cannot be proven that way, so the deployed ruleset can **refuse the query even though every room document is individually readable** (`[Chat] Conversation list denied…`). That is not cosmetic: `selectConversation()` opens a thread only when the room is in the summaries, so an empty list means **no conversation ever shows its history and no unread badge ever lights up**. A permission error on the query therefore sets `conversationListDenied` and `startPerRoomConversationListeners()` rebuilds the list from **one document listener per room** — one per known person (`myRoomIdWith`, i.e. the directory ∪ the account roster) plus the legacy archive, and **never another collection query**. Two details the rules force: a room that **does not exist** is *denied* (the membership rule starts with `exists()`), which is the **normal** state for somebody never messaged — it is remembered as missing, logged as nothing, and its row stays "Tap to start"; and because a dead listener can never report that the room later appeared, only those **denied** rooms are re-attempted every `DENIED_ROOM_RETRY_MS` (60s, `unref()`ed so a pending timer can never hold a Node process open). `applyRoomSummaryToList()` also closes the race where a room is **opened before** its document reports: the report itself attaches the thread, or a conversation with history would open blank until a reload. `stopConversationListListener()` releases the per-room listeners and the timer with the query, and the first message re-attaches the listener of the room it just created. Covered by `test/chat-conversations.test.js` §12 (a denied query still lists an existing room with its preview and unread badge, subscribes each known room exactly once, treats a missing room as "tap to start", and still opens a room that appears after the click) and by `test/chat-rules.test.js` §11 (static guards). Deploying the rules is an **optimisation, not a requirement** — it would restore the single query; until then, or if it never happens, the fallback carries the list and the chat is fully functional.
* **⚠️ …and a conversation must never VANISH because the query is gone.** The fallback can only enumerate the rooms of people it *knows* (directory ∪ account roster), so a conversation whose other side has left both — an account re-roled away from the chat, or a deleted profile — would disappear from the list and take its history with it, and a denied query is the only thing that could rediscover an unknown room. So **every room this device has seen is remembered** (`rcms_chat_known_<email>` in localStorage, capped at 200, the same store the unread stamps already use) and re-checked on every pass; the list is loaded per account in `init()`, so a remount or a reload recovers it. A room that is **refused while its peer is in neither source** — after the people sources have settled, which is what `peopleSettled` guarantees, so an early refusal can never lose a real conversation — is **forgotten outright, from the remembered list *and* from the retry set**, so it is not re-read every minute for the rest of the session. Covered by `test/chat-conversations.test.js` §13 (after a full re-init with the query denied, both conversations are found again purely from the remembered list even though their peers are in no roster at all; the one whose room still exists keeps its conversation, the one that is really gone is forgotten, and forgetting it does not disturb the conversation beside it) and by `test/chat-rules.test.js` §11 (static guards).
* **✅ The room read rule is now also PROVABLE for the list query** (`firestore.rules`, needs a deploy to take effect). It reads
  `allow read: if canReadChat(chatId) || (isHrOrSuperAdmin() && 'members' in resource.data && selfEmail() in resource.data.members);`
  — a query is authorised as a **single** rules evaluation over the whole collection, so `canReadChat()`, which resolves every room with `exists()`/`get()`, cannot be proven for it and the whole `chats where members array-contains me` query was **refused** even though every room document is individually readable. The added clause states the **same** membership test through `resource` (on a document read `resource` *is* the room), so it grants **nothing new** to a direct read — a room that does not list you is still refused by both clauses — while Firestore can prove it from the query's own `array-contains` filter. `'members' in resource.data` is required: without it the member-less legacy archive would raise an error inside the engine and evaluate the whole rule to DENIED. The privacy argument is untouched — the filter *is* the authorisation, and every subcollection (messages, presence, readReceipts, reactions) still resolves membership through the room. **This change is NOT required for the chat to work**: the client-side per-room fallback above carries the list today, so this rules edit only removes the need for that fallback (one query instead of one document read per room). Deploy it whenever it is convenient — or never; nothing in the app waits for it. Asserted by `test/chat-rules.test.js` §12.
* **✅ A message refused by the DEPLOYED rules is retried in three shapes — and a failed send NEVER greys out the chat.** A room write can succeed while the **message** write is refused, and that combination is the tell: a room and a message in one atomic batch fail **together**, so one passing and one failing means the refusal is specific to something in that batch. Two different things can be responsible, and they are tried in order, **once per session each**, with the first that works becoming the default from then on:
  1. **the full payload + the room preview** (the default) → refused because a deployed `hasOnly()` on messages predates `mentions`/`replyTo`;
  2. **the short payload** (`{ text, senderEmail, senderName, senderRole, sentAt }` — the schema this app has always documented, README data model) + the room preview → refused because of the payload;
  3. **the short payload alone** → the room *update* is what the rules refuse. A room can be *created* (the standalone write they plainly allow) while the update rule for anything but the legacy room says no — and the update rides in the same atomic batch, so it takes the message down with it and the report blames the message. The message then saves on its own and the preview is written separately, best-effort and silent (a stale sidebar line is not worth an error; the thread is already saved). Nothing is lost that cannot be derived: mentions are recomputed from the text and the role comes from the profile.
  **A send that fails for permissions now only reports it** — `disableChatWithReason()` is no longer called from that path: locking the launcher turned one refused write into "the whole feature is dead", where the user could no longer even read their own history and had nothing they could do. The draft stays in the composer, so a retry is one Enter away. Covered by `test/chat-conversations.test.js` §14 (the fake refuses any message carrying a key outside the allowlist, exactly as Firestore does, and rolls the whole batch back: the retry saves the message exactly once with the five fields, an unsendable message leaves the chat mounted and un-greyed) and §15 (the room *preview* is the thing being refused: the message still saves, the preview is re-written on its own, and the next message does not pay for the discovery again), plus `test/chat-rules.test.js` §13. *If all three shapes are refused, the deployed message rule does not accept per-pair rooms at all — the only client-only way past that is writing messages into the shared archive room, which would give every HR read access to every other HR's messages again. That is a decision, not a bug fix, so it is not being taken unilaterally.*
* **⚠️ …and the two consequences of a frozen room summary.** When the deployed rules refuse the room **update** (shape 3 above), the room document's `lastMessage` stops moving on the server — which would freeze every sidebar line for good, on the sender's device *and* the receiver's (the receiver relies on the sender having written it). Two things fix that client-side:
  * **The accepted write shape is remembered** (`rcms_chat_send_shape_<email>` in localStorage), so the discovery is paid **once per browser**: no refused writes and no console notice on later page loads, and later messages go straight out in the working shape. It is a hint, not a lock — the notice names the key to delete if the rules are ever updated, so the fuller shape is rediscovered.
  * **The sidebar line is derived from the message stream** (`syncSummaryFromMessage()`): the newest message a device has seen *is* the truth about that conversation, and it is already in hand — both when a message is sent and when one arrives. The guard is the important half: a message **older** than the line already shown is ignored, so a stale room document (or an out-of-order snapshot) can never rewind a conversation. The room document is still read and still used; it just can no longer be the only source. Covered by `test/chat-conversations.test.js` §16 and `test/chat-rules.test.js` §13.
* **✅ The modal no longer resizes itself.** With only a `max-height`, the chat window was **content-driven**: it grew and shrank as messages loaded, as the typing bar appeared and disappeared, and as the reply banner opened — the window visibly "breathed" and the thread jumped under the cursor. Two changes, both in `chat.css`: the container gets a **fixed** `height: min(720px, 82vh)` (still capped for short windows, `overflow: hidden` so the panes scroll internally), and `.chat-modal-body` loses its `min-height: 260px` floor — with a fixed height, a floor would win on a short window and push the modal off-screen.
* **✅ The typing bar no longer reserves its row.** It originally did — `display: flex` restated to beat the UA `[hidden]` rule, plus `visibility: hidden` — because with a content-driven modal, `display: none` there was the most visible part of the jitter. **That reason died with the fixed height above and the reservation outlived it**, leaving a permanent dead band between the last message and the composer: `.chat-thread` is `flex: 1 1 auto`, so those 32px came straight out of the message area. The rule is now a plain `display: none`, matching every other `[hidden]` element in the file (including the launcher typing pill). The composer shifts by one row when someone starts and stops typing — a contained, one-off movement on a real state change, not the old whole-thread resize.
  * ⚠️ **Do not "fix" a reappearing gap by re-reserving the row.** If the bar ever needs its space back it is because `.chat-modal-container` stopped being a fixed height, and that is the real regression — a cosmetic band would only hide it. `test/chat-rules.test.js` now asserts the *invariants* (fixed height + `overflow: hidden` on the container, `min-height: 0` on the log) rather than the old cosmetic rule, so the cause is protected instead of the symptom. Covered by the same test, which reads `chat.css` with the comments stripped first — the comments quote the old broken values, and a guard that matches prose is worse than no guard.
* **Unread is per conversation, and local** — derived from a per-device `localStorage` stamp (`rcms_chat_unread_<email>`), not a room field. A server-side `unreadCount` would be more robust, but writing a *new* field to the room doc means the deployed `hasOnly()` allowlist must be changed and re-deployed first — and the room write is what makes a conversation **exist**, so a denied room write means a new conversation can never be started at all (for an existing one the message, which rides in the same batch, would be dropped with it). The badge is therefore a "new" flag rather than an exact count, and it is **per device** (the same trade the old single-room chat made with `rcms_chat_last_seen_<email>`).

### ✅ No rules deploy and no paid plan required

This feature runs on the **free (Spark) plan** with **nothing deployed**. Three things were deliberately avoided, each of which would have broken it:

* **No composite index.** Firestore cannot serve an `array-contains` filter combined with an `orderBy` on a *different* field from its automatic single-field indexes, and **composite indexes are a paid (Blaze) feature**. The conversation list query is therefore `where members array-contains <me>` with **no `orderBy`**, and `collectConversationRows()` sorts client-side. There is deliberately **no `firestore.indexes.json`** and `firebase.json` declares no `indexes` key. Reintroducing the `orderBy` fails `test/chat-rules.test.js`.
* **No new collection and no new room field.** Both the directory and the room summary stick to the exact key sets the already-deployed rules allow. Because the room write is what makes a conversation **exist** (the message is only sent after it), adding even one key would deny that write and the pair could never be messaged at all. The payload is therefore defined once in `const roomSummary` and written twice, so the two copies cannot drift.
* **No `FieldValue.increment()`** on the room, for the same reason.

The list query itself uses a **single-field `array-contains`**, which every plan indexes automatically.

### ⚠️ The privacy rule: membership, not role — and when you deploy it

`firestore.rules` reads used to be `allow read: if isHrOrSuperAdmin()`. That was sufficient while there was one shared room. The moment there is one room per pair it is a **data leak**: any HR could read any other HR's private conversation. `firestore.rules` now decides access by the room's `members` array:

* `isChatMember(chatId)` — `isHrOrSuperAdmin() && selfEmail() in chatRoom(chatId).data.members`.
* `canReadChat(chatId)` — membership **or** the legacy archive.
* On a **subcollection** path `resource` is the sub-document, never the room, so `resource.data.members` is unavailable and the room is fetched explicitly with `get()` via `chatRoom(chatId)`. Every rule — `messages`, `presence`, `readReceipts`, `reactions` — is membership-scoped. `profiles` is the one deliberate exception: it is the people directory and must be readable **before** any room exists, or no first conversation could ever be started; it holds only presentation data.
* **`members` is frozen on update.** It is the one field that defines who may read a room; if either participant could change it, they could add a third person to a 1:1 thread. A room `create` requires a 2-element list containing the sender.
* **Deploy it when you can** (`firebase deploy --only firestore:rules`). Until then the app works exactly the same, but a determined user with devtools could open another pair's room by id. This is hardening, not a blocker — which is why nothing above depends on it.

### ⚠️ Switching conversations must release the old room

`selectConversation()` stops **every** per-room listener (messages, presence, read receipts, reactions, profiles) and clears every per-room cache (history pages, cursor, seen ids, unread divider, pending reply) before opening the next. Skipping any one of those means the previous thread's messages keep rendering in the new room, its typing indicator names the wrong person, or its reactions attach to the wrong messages. `roomRef()` returns **null** until a row is picked, and every per-room accessor goes through `roomSubcollection()`, so a background tick can never throw on a page where no conversation is open.

`init()` is an **authorisation re-check, not a navigation**: a permissions refresh for the same account keeps the open thread, but a **different** account never inherits it.

* **Access: HR and superadmins ONLY — owners and operators are fully excluded.** Enforced in three independent layers, so hiding the button is never the only thing standing between a non-member and the thread:
  1. `ChatService.canChat(role)` — a pure allowlist (`['hr', 'superadmin']`). Anything not on the list is rejected, so a brand-new/unknown role can never inherit chat by accident. Case- and whitespace-insensitive, and safely rejects the string `"false"` (a real edge case: `js/owner-dashboard.js` calls `setActiveUser(perms, false)` when the permissions fetch fails).
  2. `ChatService.init()` — called from `refreshPermissionUI()` on `main.html` and `setActiveUser()` on `ownerdashboard.html`. A disallowed role **tears the launcher and modal out of the DOM** rather than just hiding them, and the launcher only becomes visible *after* the role check, so an operator never sees a chat button flash on load.
  3. `firestore.rules` → `isHrOrSuperAdmin()` **plus** `isChatMember(chatId)` — the role gate decides who gets the *feature*; the room's `members` array decides who can read *each individual conversation*. Owners and operators are denied every read and write, so the thread is invisible to them at the data layer. The existing catch-all `match /{document=**} { allow read, write: if false; }` means anything not explicitly matched fails closed.
* **`js/chat.js`** (`window.ChatService`) — self-injects the launcher + modal, so the markup is **not** duplicated across pages. Realtime via `onSnapshot` on the v8 compat SDK (same pattern as `firebase.js` `listenTickets`/`listenViolations`). The modal reuses the app's existing `.modal-overlay` / `.modal-container` / `.modal-header` / `.modal-footer` classes, so it stacks correctly with the other modals (z-index 1000) and closes on backdrop click, the × button, or **Escape**. Enter sends, Shift+Enter adds a newline. It carries its **own** `escapeHTML` (scoped inside the module's IIFE) because `ownerdashboard.html` does not load `script.js`, which is where the app's other copy lives.
* **`chat.css`** — loaded after `theme.css` on both dashboards. Every colour is a shared CSS variable (`--bg-card`, `--text-primary`, `--border-color`, `--color-primary`…), so light and dark mode both work with **no** dark-specific rules. Own messages are brand-green and right-aligned; everyone else's are neutral cards, left-aligned. Responsive down to 640px.
* **Draggable launcher** — the chat circle can be dragged **anywhere** on the page and stays where it is left. Details that matter:
  * **Drag vs. click.** The circle is a `<button>` that opens the chat, so a drag must not trigger it. A press only becomes a drag after `DRAG_THRESHOLD_PX` (5px) of travel; below that it stays a normal click. When a drag *does* finish, the trailing `click` is swallowed via `suppressNextLauncherClick`, so releasing the button never opens the modal by accident.
  * **Pointer Events only** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) — one code path for mouse, touch and pen. `setPointerCapture` keeps the drag tracking when the pointer leaves the button, which is essential for touch. `touch-action: none` in CSS stops the page scrolling underneath a touch drag.
  * **Grab offset** is preserved from `pointerdown`, so the circle does not jump so that its centre sits under the cursor.
  * **CSS default vs. inline position.** The stylesheet's `top`/`right` is only the *initial* position. Once dragged, `chat.js` writes inline `left`/`top` (plus `right: auto`) and `applyLauncherPosition()` moves it. A never-dragged circle still uses pure CSS.
  * **Clamped to the viewport** (`LAUNCHER_EDGE_MARGIN` = 8px) so it can never be dropped somewhere unreachable, and re-clamped on `window.resize` in case the window shrinks. A restored position is re-clamped too, so a position saved on a large screen is still valid on a small one.
  * **Persisted** in `localStorage['rcms_chat_pos']` as `{x, y}`, matching the existing `rcms_chat_*` convention. All storage access is wrapped in try/catch so private browsing degrades to "position doesn't persist" rather than breaking the chat. Corrupt/NaN values are rejected and ignored. **Double-click the circle to reset** it to the default top-right spot.
  * **The typing pill follows the circle.** `.chat-launcher-typing` is a separate fixed element, so `positionTypingPill()` re-anchors it beside the launcher (preferring the left, flipping right when there is no room). Without this the pill would detach and float in the wrong place after a drag.
  * A `.chat-launcher-dragging` class disables the hover `transform`/`transition` while dragging, otherwise the circle's scale/translate would make it lag or jitter under the cursor. A `::before` pseudo-element extends the grab area by 6px so the small circle is easy to catch.
  * **Accessibility is unchanged:** dragging is a pointer-only convenience. The button keeps its `aria-label`, stays keyboard-focusable, and still opens with Enter/Space.
* **Unread badge** — counts only messages from *other* people that arrived after you last opened the chat. The "last seen" stamp is per-user in `localStorage` (`rcms_chat_last_seen_<email>`), so existing history is never re-counted as unread on a later visit. The badge clears as soon as the modal opens. If storage is unavailable the badge simply stays clear rather than mis-counting.
* **Live typing indicator (Messenger-style)** — shown while a member **has an unsent draft**, exactly like Messenger: it appears on the first character and stays up until the message is sent or the draft is cleared. Other members see animated dots plus *"X is typing…"*, *"X and Y are typing…"* or *"N people are typing…"*. It appears in **two places**:
  * **In the modal**, on a bar between the message log and the composer.
  * **On a floating pill next to the chat circle** (plus a soft green pulse on the circle) — because the chat is *closed* by default, so the in-modal bar alone would be invisible until you opened the chat. Opening the chat hands over to the in-modal bar; closing it restores the pill.
  * **⚠️ The signal is the DRAFT, not the keystrokes.** The presence write is driven by `setInterval` (`startDraftHeartbeat`) that runs for as long as unsent, non-blank text is in the composer — it does **not** depend on keypress events. A keypress-only model (the first implementation) dropped the indicator the moment the user paused to think, which is precisely the behaviour Messenger avoids. Regression-tested by firing the heartbeat with no input events at all.
  * **The draft heartbeat self-terminates.** If the composer is emptied the next tick calls `withdrawPresence()`, so we never keep writing presence for a message nobody is composing. Sending also clears the draft and withdraws presence immediately. `blur` deliberately does **not** withdraw — the draft survives losing focus, so the indicator should too.
  * **Staleness is measured from LOCAL receipt time, never from the document's `at`.** Comparing a server timestamp against the local clock breaks whenever the two clocks differ — a user whose PC is a few minutes off would either never see an indicator or never see it clear. Each entry is stamped with the local time it last *changed* (`presenceSeenAt`), so only this machine's clock is involved. A regression test feeds an entry whose `at` is ~11 days old and asserts it still shows.
  * **⚠️ Only CHANGED entries are re-stamped** (`lastPresenceByEmail`). Stamping every entry on every snapshot would revive someone who had stopped composing whenever *anybody else* typed, leaving their indicator stuck on forever. Someone is dropped when their entry stops changing, and anyone removed from the collection is dropped immediately.
  * **You never see yourself typing** — your own presence entry is filtered out.
  * The doc key is `encodeURIComponent(email)`, so an unusual address can never produce an invalid document path.
  * **⚠️ The NAME in "X is typing…" is the person's PUBLISHED name, not their address.** The label resolves through the same directory / `users` roster the conversation row and the thread header use (`typingNameFor()` → `personProfileFor().displayName`, falling back to the name on the presence doc, then to the email's local part), and the presence doc itself publishes that same name (`name: nameFor(self)`). It used to prefer `entry.name`, which `publishPresence()` wrote as the email's local part — so a person whose row, header and messages all said "Jiangnan Hotpot" was announced as **"hotpotjiangnan is typing…"**, i.e. one thread showing two names for one person. Someone with no published entry still falls back to the local part rather than showing no name at all. Guarded by `test/chat-access.test.js` §45b (label, launcher pill and the outgoing write) and `test/chat-rules.test.js` (both halves of the source), and reverting the fix makes both fail with `"super is typing…"`.
  * Rules: anyone who may chat may **read** presence, but may only `create`/`update`/`delete` **their own** record (`email == selfEmail()`). The `create` rule deliberately avoids `resource.data` for the same reason as the room doc.
  * Presence is a nicety: a failed broadcast never shows a toast, but it **is** logged loudly once as `[Chat] ⚠️ Typing indicators are DISABLED (<code>)` with the `firebase deploy --only firestore:rules` hint — a silently swallowed permission error is indistinguishable from a broken feature.
* **Incoming message sound** — a new message **from somebody else** plays the app's existing notification sound, via `playNotificationSound()` from `js/notifications.js`, so it matches the ticket-alert tone and reuses the same preloaded `Audio`.
  * ⚠️ **THE SOUND IS ANNOUNCED FROM THE MESSAGES, NOT THE SUMMARIES.** This is the part that actually makes it work. The conversation-list listener carries `lastMessageAt` on each ROOM DOCUMENT, and that field is only as fresh as the sender's room-preview write — which rides in the same batch as the message and is **refused whenever the deployed rules are older than this client** (see the three-shape ladder in `sendMessage()`), after which `writeRoomPreviewQuietly()` is a best-effort fallback whose errors are swallowed. When that happens `lastMessageAt` never advances, so the summary correctly reports "no change" and stays silent, forever. **The group chat never writes a preview at all** (the room update would be refused anyway), so its summary is permanently `0` and could never announce either.
    * So the authoritative signal is a **per-room watcher on the newest message**: `chats/{roomId}/messages` with `orderBy('sentAt','desc').limit(1)` — one doc, not a thread load. `firestore.rules` already grants `allow read: if canReadChat(chatId)` there, so this needs **no rules deploy**. One listener and one doc read per conversation; fine for the 1:1 HR↔superadmin shape, worth revisiting if anyone accumulates dozens.
    * Tracked by **document id, not timestamp**: two messages can share a `sentAt` (the server timestamps them in the same batch) and a timestamp comparison would miss the second entirely. The baseline is `rcms_chat_announced_ids_<email>`.
    * The **summary path is kept as a fallback** — it costs nothing, and it covers the case where the per-room message read is ever denied. While a message watcher is alive for a room the summary **stands down**, so one message never sounds twice from the two paths.
  * Watchers are synced from **both** list paths — the `chats` query *and* the per-room fallback that runs when that query is denied — because a denied query is a live configuration, and without the fallback wiring it would silently cost every alert. They are released in `stopConversationListListener()` and in `teardown()`: a watcher that outlives teardown keeps reading Firestore and could still sound for a user who may no longer be allowed to chat.
  * The per-device baseline is `rcms_chat_announced_<email>` (a `roomId → lastMessageAtMs` map), mirroring the unread state. It is **not** the read receipt, and cannot be: a receipt means "this person looked at it" and is deliberately written only while the chat is visible, whereas a sound is about a message **arriving** — you want to hear about it precisely while you are *not* looking at it.
  * Deliberate guards: **your own messages are silent** (but still advance the baseline, so the other side's next message is not swallowed), the **open** conversation is left to the thread listener (so one message never sounds twice), the **legacy archive** is excluded, and a burst is **not throttled** — one sound per arriving message, because a throttled alert is exactly the "it never warned me" failure this fixes.
  * ⚠️ **The FIRST snapshot must be silent, but must still record the baseline.** With no recorded baseline every existing room looks brand new, so merely opening the app would machine-gun the sound for the user's entire history. Returning early *before* the write would then swallow the next real message too.
  * ⚠️ **A snapshot for a room you have since left is dropped.** The `onSnapshot` callback closed over the global `activeRoomId`, and unsubscribing does not cancel an already-dispatched callback — so a stale payload replayed the old thread as new (and fired the sound for every message in it), stamped the wrong ids as seen, and wrote a read receipt for the wrong conversation. `startListener()` now captures `subscribedRoomId` and each message is stamped with its `roomId`.
  * **A mention plays the mention sound ONLY.** It used to play the plain incoming chime *and then* the mention sound on top, so every mention made two noises and the second cut the first off. A mention is the more insistent of the two, so it plays alone.
  * ⚠️ **`js/notifications.js` MUST keep exporting `playNotificationSound`.** `chat.js` guards on `typeof window.playNotificationSound === 'function'`; before the export was added that check was **always false**, so the "reuse the shared, preloaded sound" path was dead code and the chat silently used a private `Audio`. That private fallback has now been deleted, so the delegation is the only path and the export is load-bearing. `test/chat-access.test.js` asserts both the export and that `chat.js` keeps exactly one `Audio` (the mention sound).
  * Audio failures (e.g. autoplay blocked before the first gesture) are swallowed; a sound must never break the chat. When the notification module is absent entirely the chat stays silent rather than building a new `Audio` per message.
  * **Known limit:** a message from somebody you have **never** messaged has no room document yet, so there is no summary to announce. That first message cannot alert until the room exists — a room-visibility/rules matter, not a sound one.
* **Data model** — `chats/owner-superadmin` (a fixed room id, so both dashboards land on the same thread without a lookup step) holds a denormalised `lastMessage` / `lastMessageAt` summary; `chats/owner-superadmin/messages/{id}` holds `{ text, senderEmail, senderName, senderRole, sentAt }`. Per-pair **1:1** threads can be added later as extra `chats` documents (`type: 'direct'`) — the rules already key off `{chatId}`.
* **Message integrity** — message text is HTML-escaped before rendering, so a message can never inject markup. Firestore rules additionally require `request.resource.data.senderEmail == selfEmail()`, so nobody can post as somebody else, and messages are immutable once written (`update`/`delete` are `false`).
* **⚠️ THE ROOM MUST BE COMMITTED BEFORE THE MESSAGE.** Membership is resolved by **reading the room** — `isChatMember(chatId)` is `get(chats/{chatId}).data.members has selfEmail()`, and the message rule inherits that check. So writing the room *and* the message in one atomic batch is **not enough** on a conversation that has never been messaged: the rules see the state the write arrived in, the `get()` finds no room (and the deployed rule dereferences `.data.members` without an `exists()` guard, which raises), and the message is **denied** with *"Chat cannot read or write this conversation"*. The room is therefore committed **first**, as its own awaited write (`if (!roomIsStarted) await roomRef().set(roomSummary, { merge: true })`), and only then is the message sent. The summary still rides in the batch with the message, so an *existing* conversation keeps updating atomically, and the write is idempotent (`{ merge: true }`) — which matters because the client cannot always know whether the room exists: the conversation list may not have arrived yet. `test/chat-conversations.test.js` asserts the write ORDER (`room → message → summary → commit`), and the two failure stages are reported separately (see below). *The same reasoning applies to the **typing indicator**: `publishPresence()` stays silent until the room exists, because `chats/{chatId}/presence/{me}` sits UNDER that room and its create rule resolves membership the same way — a "typing…" for a thread that does not exist yet is a guaranteed denial, and it made the console cry about the rules on every first contact.*
* **⚠️ `create` and `update` MUST be separate rules.** On a `create` the document does not exist yet, so `resource` is `null` and `resource.data` is `null` — dereferencing it inside `diff()` makes the rule evaluate to **denied**. A combined `allow create, update: ... diff(resource.data) ...` therefore blocks the very first message forever, and because the room summary and the message ride in **one batch**, that rejection takes the message down with it. The room never gets created, so **retrying never helps**. The room `create` rule uses `request.resource.data.keys().hasOnly([...])`; only `update` may use `resource.data`. `test/chat-rules.test.js` fails the build if these are ever recombined.
* **⚠️ A rules mismatch must DISABLE chat, never DELETE it.** The Firestore listener used to call `teardown()` on `permission-denied`, which **removed the launcher from the DOM**. The symptom was the chat circle appearing on load and then silently vanishing about half a second later, when the first snapshot came back denied — leaving the user with no chat and no clue why. The usual trigger is simply not having redeployed the rules after the Owner/HR role split (`isHrOrSuperAdmin` did not exist in the deployed rules yet). Now `disableChatWithReason()` keeps the circle on screen, **greyed out with `cursor: not-allowed` and `aria-disabled="true"`**, sets its tooltip to the reason, and shows a toast naming the fix (`firebase deploy --only firestore:rules`). Clicking it re-explains instead of silently doing nothing. `reenableChat()` runs automatically as soon as a snapshot arrives again (e.g. after a redeploy + reload), so recovery needs no code change. A failed **send** takes the same path, so a stale-rules user is not left clicking a button that fails every time. Regression-tested in `test/chat-access.test.js`.
* **Error reporting is specific on purpose.** A failed send distinguishes a **rules mismatch** (`permission-denied` → disable in place and name the deploy command), a **network** problem (`unavailable`/`deadline-exceeded` → "message not sent, try again") and anything else (raw Firestore error code). The full error is always logged to the console — `[Chat] Could not create the room doc <roomId>:` when the ROOM write failed, `[Chat] Failed to send message:` when the MESSAGE write failed — and the on-screen reason names which of the two it was. Do not collapse this into a single generic message — a generic toast makes a rules bug indistinguishable from a network blip, which is very hard to diagnose in the field, and naming the wrong write sends people looking in the wrong place.
* **Deploy the rules or nothing works.** The app UI gates on the client, but the real authorisation lives in `firestore.rules` — run `firebase deploy --only firestore:rules` after changing them. `.firebaserc` pins the project (`jn-data-f29ae`, the id in `firestore.rules`'s header), so the command needs no `firebase use` first; the alternative is pasting the file into the Firebase console's **Firestore → Rules** tab. Note that only the rules change: nothing above needs a redeploy of the hosting files.
* Covered by `test/chat-access.test.js` (vm sandbox + fake DOM + fake Firestore) and `test/chat-rules.test.js` (static checks on the rules, no emulator needed), plus the `node --check js/chat.js` syntax check in `npm test`.

### Replies

Hovering a message reveals a ↩ button next to the react one. Clicking it shows a **banner above the composer** previewing who you're replying to and a snippet of their text, with a cancel (×) or `Escape`. The sent message renders with a **quoted block** above its bubble — sender name plus a truncated preview of the parent.

* **A reply is NOT a nested subcollection.** Firestore has no native threading, and nesting replies under their parent would need a `collectionGroup` query plus a composite index — and would mean the live listener could no longer deliver replies in thread order. Instead a message simply carries `replyTo: <parentMessageId>`, so replies arrive in the same stream as everything else and render inline, in order.
* **No rules change was needed** — the message `create` rule has no field allowlist.
* **The banner clears after sending.** Otherwise the next message would silently inherit the same reply target, and everything you typed afterwards would be a reply to something it had nothing to do with. `replyingToId` is also reset in `teardown()` so a role change mid-compose cannot leave a dangling target.
* **Replies never chain.** Replying to a reply targets the message you actually clicked, so a thread cannot nest arbitrarily deep.
* The quoted preview resolves from the messages **already loaded**, so no extra read is needed. If the parent has been paged out of the window the quote degrades to a neutral *"Earlier message — this message is no longer in the loaded history"* rather than an empty or broken box.
* ⚠️ The quoted parent text is `escapeHTML()`-ed. A parent message is user input and must never become an XSS vector through the quote block — regression-tested.
* The ↩ and 🙂 buttons sit **inline at the end of the message meta row**, beside the timestamp — not absolutely positioned over the message's top corner. They are wrapped in a `.chat-msg-actions` group that fades in on `:hover` (and on `:focus-within`, so keyboard users can reach them), and is always visible where there is no hover. Both are hidden in a *grouped* burst's collapsed row along with the name and title, so a multi-message block does not sprout a row of duplicate icons.
* The avatar sits beside the message in its own column (`.chat-msg-row` = the flex container holding the avatar + `.chat-msg-content`; the content stacks the name/time header, reply preview, bubble, and reaction chips). It used to sit in a header *above* the message, which spent a whole extra line of vertical space per message on nothing.
* **Vertical alignment is `flex-end`, not `center`.** An earlier revision used `align-self: center` on the avatar, which stranded it halfway down a tall multi-line bubble so it read as detached from the text. Both `.chat-msg-row { align-items: flex-end }` and `.chat-avatar { align-self: flex-end }` put its bottom edge against the bottom of the message.
* Outgoing messages use `flex-direction: row-reverse` + `justify-content: flex-end`, so the whole group — bubble, avatar, reply preview, and reaction chips — is pinned to the right edge as one unit. Incoming keeps the avatar on the left, `flex-start`.
* `.chat-msg-content` carries `flex: 1 1 auto` + `min-width: 0` so the bubble grows to the available width but still shrinks, and a long unbroken word wraps rather than pushing the row (and the avatar) off the edge.
* Grouped follow-ups hide the name/time/actions header but **keep the avatar** — the avatar is what tells you the whole burst came from one person.
* Covered by `test/chat-access.test.js` (quote block renders, `replyTo` stored, banner clears after send, next message is top-level, no chaining, graceful fallback for an unloaded parent, quoted text escaped, cancel works, the header carries no action buttons and the dead styles are gone, avatar is a column beside the message and not in the header, own messages reverse the row, avatar and row are bottom-aligned not centred, outgoing pins the group right, no duplicated declarations). Mutation-tested: removing the post-send `cancelReply()` fails the suite.

### Message context menu (reply + reactions)

**Move the mouse over any message and a toolbar pops up — no click.** It is one unified menu, `[ ↩ Reply ] │ [ Like  Love  Haha  Wow  Sad  Angry ]`:

```
┌──────────────────────────────────────────────┐
│  ↩   │   👍   ❤️   😄   😮   😢   😠         │
└──────────────────────────────────────────────┘
```

#### The reaction set, and why it is not emoji

The six are **Like, Love, Haha, Wow, Sad, Angry** — the Messenger set. The old set was 👍❤️👀🎉❗, a grab-bag of pictographs where a reaction meant something different to every reader.

Each reaction is drawn as an **inline SVG**, not a Unicode character. That is the whole point: a Unicode 😂 is a dead picture, but an SVG's mouth can open and its eyes can squeeze shut. All six share one flat geometric style (24×24, solid fills, no gradients) so the set looks like a family rather than six pieces of clip art.

| Reaction | Motion |
| --- | --- |
| Like | A small satisfied lift |
| Love | A heartbeat — the two-beat pulse, not a plain pulse |
| **Haha** | The face bobs and rocks; **the eyes squint shut and the mouth opens and closes** — the one that has to actually look like laughing |
| Wow | A startled pop, with the mouth gasping wider |
| Sad | A slow slump, with a tear that keeps falling |
| Angry | A short sharp jitter, brows pulling down |

Two deliberate constraints:

* **Animation is CSS-only.** The log's `innerHTML` is rebuilt on every Firestore snapshot, so anything driven from JS would restart on each update and strobe. A test asserts there is no `setInterval`/`requestAnimationFrame` in the glyph path.
* **Motion is opt-out-able.** `prefers-reduced-motion: reduce` freezes every glyph — they are still drawn, just still.

The picker options animate continuously; the small chips only animate on hover or focus, so a thread full of reactions is not a field of moving faces all at once.

* **Reply leads**, because it is the action people reach for most, and a **divider** separates it from the reaction row so the toolbar does not read as "seven emoji".
* **There are no per-message action buttons any more.** Reply and react used to sit inline in the message header; both moved here, so a message header is pure metadata (name, title, time, receipt). The orphaned `.chat-msg-actions` / `.chat-msg-reply` / `.chat-msg-react` styles were removed rather than left behind.
* **Touch:** with the per-message button gone and no hover available, a **400ms press-and-hold** opens the menu. It is cancelled by moving the finger (that is a scroll) or lifting before the timer fires, so an ordinary tap is left alone. Guarded by `canHover()` so a desktop mouse long-press never fires a surprise menu.
* ⚠️ **Keyboard:** the menu opens on hover, and its buttons are focusable once open, but there is no longer a focusable trigger *in* the message. A keyboard user cannot open the menu without a pointer. Worth addressing if this chat is expected to be fully operable by keyboard.

#### ⚠️ Legacy emoji keys are remapped

Reactions already in Firestore store `thumbsup`, `heart`, `eyes`, `tada`, `alarm`. Chips are rendered by looking the stored key up in the set, so **without a remap every existing reaction would have silently vanished** the moment the set changed. `LEGACY_REACTION_KEYS` maps them onto the new keys and the snapshot runs every stored key through `normaliseReactionKey()`. Only the **display** key is remapped — the stored document is untouched, and rewrites itself the next time that person changes their reaction. Covered by a test that feeds a stored `thumbsup` and asserts a Like chip appears.

**One reaction per person per message.** The document id is `{messageId}__{email}`, so there is no second slot to stack into; switching emoji is a single-field update. The rules freeze `messageId` and `email` (`affectedKeys().hasOnly(['emoji'])`), so a reaction can never be repointed at another message or person.

**⚠️ Legacy reaction documents are migrated lazily.** Reactions were originally keyed `{messageId}__{emoji}`. If the id is recomputed from scratch, an old reaction is addressed at a document that does not exist — and a `delete()` of a *missing* document is **denied** by the rules, because there is no `resource` to check `resource.data.email` against. That surfaced to users as a misleading "ask a superadmin to deploy the rules" toast even when the rules were correct. The client therefore records the **real** doc id of the user's own reaction from the snapshot (`myReactionDocs`) and writes against that:

| Action | Result |
| --- | --- |
| Toggle off | Deletes the real doc id (legacy or canonical) |
| Switch emoji, canonical id | Single `update({ emoji })` |
| Switch emoji, legacy id | `delete()` the old doc **then** `set()` the canonical one — ordered, so a mid-failure can never leave two of the same person's reactions on one message |

This cleans up old documents as users interact with them; no batch migration is required.

* **Hover, delegated on `mouseover` of the log** (not per-element `mouseenter`), because `els.log.innerHTML` is reassigned wholesale on every render, so per-element handlers would not survive a repaint.
* **The row survives the pointer leaving the message.** There is a real gap between a message and the popup above it, so dismissing on `mouseout` would make the emoji unreachable mid-move. Instead it closes on a 220ms delay, and `mouseover` on the picker cancels the pending close. It re-anchors only when the target message *changes*, so crossing child elements does not make it jitter.
* The 🙂 button is kept only for **touch** (`@media (hover: none)`) and **keyboard focus**; on a desktop it is `pointer-events: none` because hovering the message is now enough. It is deliberately not `display:none` so it stays focusable.
* ⚠️ **ONE reaction per person per message** — picking a second emoji REPLACES the first, it does not stack. This is *structural*, not a UI convention: the document id is `{messageId}__{emailKey}` (keyed by **person**, not by emoji), so there is literally only one slot a person's reaction to a message can occupy and a second one cannot be added. An earlier version keyed the doc by `{messageId}__{emojiKey}`, which let one person stack all five emoji on a single message.
* Switching emoji is therefore a single-document `update` of the `emoji` field — not a delete + create. The rules **freeze `messageId` and `email`** (`affectedKeys().hasOnly(['emoji'])`), so a reaction can never afterwards be repointed at a different message or handed to a different person. This is the one place reactions are not fully immutable, and the reason is sound: the *message* stays immutable, which is what the record depends on, while a reaction is a live acknowledgement rather than a statement.
* The emoji you already picked is highlighted in the picker (`.is-current`), so "one reaction" is visible and re-picking it reads as a toggle-off.
* The collection is a SIBLING of `messages`, not nested under it. One `onSnapshot` over a single collection then covers the whole thread. A subcollection of a query is not directly subscribable in Firestore, so nesting would have forced a `collectionGroup` query and a composite index for no benefit. One listener, not one per message.
* The emoji **character is stored in the field, not baked into the doc path** — so the rendered emoji can be changed later without migrating any documents.
* **The popup animates in**, and the detail that matters is that it stays *fast*: `chatPickerIn` is 140ms with a slight overshoot (`cubic-bezier(0.2, 0.9, 0.3, 1.2)`), scaling from 0.88 and fading up. A hover-triggered popup that takes 300ms to arrive feels laggy, so the duration is deliberately short. The five emoji cascade in behind it with an 18ms stagger (`animation-delay` per `nth-child`) — enough to read as "assembling", not enough to feel choreographed. Picking one gives a quick `:active` press scale.
* ⚠️ `prefers-reduced-motion: reduce` disables all of it. Motion that nobody can opt out of is a regression, not a feature — the popup still works, it just appears.
* The animation is triggered by `display:none → flex` (toggling `hidden`), so it never plays on page load.
* Emoji and email are `escapeHTML()`-ed on render, and the chip's `title` lists who reacted.
* ⚠️ **The chip is applied OPTIMISTICALLY** (`applyReactionLocally()`) and rolled back if the write is rejected. This matters more than it sounds: without it the UI waits for the snapshot round trip, so a *denied* write — the common case until the rules are deployed — looks like the picker doing nothing at all. A `permission-denied` now also raises a **visible toast naming the deploy command**, not just a `console.warn`.
* **Needs a rules deploy** (`chats/{chatId}/reactions` is a new subcollection). Until then reactions fail with the toast above — the chat itself is unaffected.

### Scroll position — the log is the scroll container

**⚠️ `.chat-log` must be the scrollable element, and `.chat-modal-body` must not be.** This was a real bug and it is easy to reintroduce, because the failure is completely silent.

`.chat-modal-body` used to carry `overflow-y: auto` while `.chat-log` had no overflow rule. The body scrolled and the log did not. But **all** the scrolling JavaScript writes to the log — `scrollLogToBottom()` (`els.log.scrollTop = els.log.scrollHeight`), the near-bottom check, and the pagination scroll anchor. A non-scrolling element *silently ignores* `scrollTop`, so every one of those lines was a no-op:

* Opening the chat left the thread parked wherever it was — **showing older messages instead of the latest**.
* `wasNearBottom` always read `0`, so it was always "true" and new messages always yanked the view.
* The auto-page-on-scroll handler never fired at all.
* The pagination scroll anchor restored nothing, so prepending a page jumped the reader.

The fix moves the scroll onto `.chat-log` (`overflow-y: auto; flex: 1 1 auto; min-height: 0`) and makes the body `overflow: hidden` + flex. `min-height: 0` is **required**: a flex child will not shrink below its content height without it, so the log would refuse to scroll and the browser would scroll an ancestor again — the same bug, one layer up. A side benefit: the "Load earlier messages" control now stays parked at the top instead of scrolling away with the thread.

Because that handler now actually fires for the first time, it is guarded by a `programmaticScroll` flag. Reassigning `innerHTML` resets `scrollTop` to 0, which is indistinguishable from the user reaching the top of history — without the guard, every re-render would start paging on its own. Both `scrollLogToBottom()` and the pagination anchor set the flag.

Covered by `test/chat-access.test.js` (log is the scroller, body is not, `min-height: 0` present, opening jumps to the latest, programmatic scrolls are ignored by the pager). Mutation-tested: deleting the `overflow-y: auto` from `.chat-log` fails the suite.

### Paginated chat history

The live listener subscribes to only the **last 300 messages** (`limitToLast`). Older messages are fetched on demand by `loadOlderMessages()` — a **one-shot `get()`**, deliberately separate from the live `onSnapshot` so paging back never restarts the subscription or re-downloads the tail. A "Load earlier messages" button sits above the log (and fires automatically when you scroll to the very top); once every page is loaded it reads "Beginning of history" and the button disappears.

* **⚠️ The query is DESCENDING — this is the whole trick.** The page must be the messages *older* than what is already held. In ascending order `startAfter` walks **forward**, so the first click would return the **oldest 60 messages in the thread** instead of the 60 just above the tail. `orderBy('sentAt', 'desc')` makes "after the cursor" mean "older than the cursor"; the page is then reversed back into display order. (This also avoids `endBefore()`, which is not in the pinned Firestore 8.10.1 SDK.)
* **⚠️ The cursor is a `DocumentSnapshot`, not a timestamp.** `sentAt` is a `serverTimestamp()`, so two messages sent in the same millisecond tie and ordering by `sentAt` alone is non-deterministic across pages — duplicating or skipping messages at a boundary. Firestore cursors carry an implicit `__name__` tiebreaker, so passing the snapshot is exact and needs no composite index. The **first** page pages back from `oldestTailDoc`, the oldest doc of the live tail, captured from the listener — so paging starts exactly where the visible window ended instead of guessing.
* **⚠️ With the descending query, `snap.docs[0]` is the NEWEST doc of the page.** Advancing the cursor to it makes the next `startAfter()` walk back over the page just fetched and **render every message twice**. The cursor must be `snap.docs[snap.docs.length - 1]`. This was a real bug caught by the tests.
* **⚠️ `renderMessages()` must PREPEND, never re-slice.** It previously did `messages.slice(-MAX_MESSAGES_RENDERED)`, which would have trimmed off exactly the page the user just asked for. It now concatenates `olderMessages + tail` and caps the *combined* list at `MAX_RENDERED` (600) as a memory guard. `lastRenderedMessages` tracks the **tail only** — if it accumulated history, each page would be prepended twice.
* **⚠️ Scroll position must be anchored.** `innerHTML` is reassigned wholesale and prepending grows `scrollHeight`, so the browser would keep the old `scrollTop` and appear to jump into the middle of the thread. The growth is measured before/after and added to `scrollTop`. `isHistory: true` also suppresses the auto-scroll-to-bottom for the same reason.
* Paging never recomputes the unread badge (`isHistory`), so old messages cannot appear as unread, and preloaded ids are pushed into `seenMessageIds` as insurance in case a future refactor routes history through `announceNewMessages()`.
* No `firestore.rules` change — older messages use the same `allow read: if isHrOrSuperAdmin()`. **No redeploy needed for this feature.**
* Covered by `test/chat-access.test.js` (prepends and orders correctly, starts where the window ended, cursor advances with no duplicates, no chime, no false unread, scroll preserved, terminates at "Beginning of history"). Mutation-tested: removing the scroll anchor or reverting the cursor to `docs[0]` both fail the suite.

### Profiles — telling HR and superadmin apart in the thread

Every message carries an identity block instead of a bare email prefix: a **role-tinted avatar** (initials), the **name**, and an optional **job title**.

| | Avatar colour |
|---|---|
| **HR** | green |
| **Superadmin** | blue |
| unknown / legacy | grey |

**There is deliberately NO visible role badge.** An earlier version rendered a `HR` / `SUPERADMIN` chip on every message; it was removed as too noisy — a chip repeating on every line trains people to stop reading it. The role is still conveyed by the **avatar colour**, and is still discoverable on hover (the avatar's `title` tooltip carries the role, plus the job title when set). `test/chat-access.test.js` asserts no `.chat-role-badge` is ever rendered, so it cannot silently come back.

**The avatar works on existing history immediately.** It is derived from `senderRole`, which `sendMessage()` has always written onto every message — so no migration or backfill is needed. A pre-feature message with no `senderRole` renders a neutral grey avatar rather than guessing or crashing.

**Role colours are fixed per role, not `--color-primary`.** Both roles would otherwise inherit the same green and be indistinguishable — which defeats the entire point. `--chat-role-superadmin` / `--chat-role-hr` / `--chat-avatar-unknown` are declared in both `style.css` and `theme.css`; dark mode lightens the avatar fills' text contrast while keeping them saturated so the white initials stay legible.

**Display name + job title** are optional and self-published. The header's ✎ button opens a small editor; `saveMyProfile()` writes to `chats/{chatId}/profiles/{emailKey}`, and a listener repaints live names as they arrive — so you can go from "maria" to "**Maria** · HR Manager" and see it in the thread immediately. Names and titles are **escaped** before rendering; a profile is user input and must never become an XSS vector.

* **⚠️ The editor collapses after a save on BOTH outcomes.** It originally only collapsed on success, so a rejected write (stale rules — the common case, since `profiles` is a new subcollection) left the form sitting open with the user's text in it and the chat looking frozen. The error toast already names the fix, so the editor now closes either way and the chat returns to normal. `Enter` in either field also saves, matching the composer's habit. Covered by `test/chat-access.test.js` (opens, writes the signed-in user's profile only, collapses after save — success **and** failure, Save button always re-enabled).

**Message grouping.** Consecutive messages from the same person within `GROUP_WINDOW_MS` (2 min) drop the repeated name/role text and keep the avatar, so a burst reads as one block. A change of speaker always starts a new block. This is what stops a long HR thread turning into a wall of repeated labels.

* **Why profiles are not the `users` collection.** `firestore.rules` allows `read` on `users/{email}` only to `isSuperAdmin()` or the profile owner, so an HR member would be **denied** reading a colleague's profile and every name would silently fall back to the email prefix. The chat keeps its own roster instead. The rules restrict a profile to `hasOnly(['email','role','displayName','title'])` — presentation fields only, owner-only writes, never world-writable — so a profile can never carry anything that grants access.
* Covered by `test/chat-access.test.js` (role badges per role, legacy message with no role, live display name/title, grouping, escaping) and `test/chat-rules.test.js` (profiles owner-only, presentation-fields-only).

### Mentions (`@name`)

Typing `@` in the chat composer opens a picker of the other people in the thread. Picking one (click, `Enter`, `Tab`, or arrow keys + `Enter`) inserts `@name ` into the message, and the sent document carries a `mentions` array of emails. A mentioned person gets a **distinct sound**, a toast naming the sender, and a green-tinted bubble border.

**How the roster is built — and why not from `users`.** `mentionCandidates()` derives people from the senders already present in the loaded thread history, plus the signed-in user. It deliberately does **not** query the `users` collection: `firestore.rules` only allows `read` on `users/{email}` to `isSuperAdmin()` or the profile owner, so an HR member would be denied and the picker would silently be empty for exactly the people who most need it. The thread is the authoritative list of who is actually in the chat, and it needs no extra query or rule. **Consequence:** somebody who has never posted in the thread cannot be mentioned until they have.

**No rules change was needed.** The message `create` rule only checks `request.resource.data.senderEmail == selfEmail()` — there is no field allowlist — so adding `mentions` needed no edit to `firestore.rules` and no redeploy for this feature.

- `extractMentions(text)` resolves `@token`s against the roster case-insensitively, so a **hand-typed** mention works even if the picker was never used; unknown names are ignored and repeats collapse to one entry.
- The picker only opens at a **word boundary**, so an email address in the text (`a@b.com`) does not trigger it, and it closes on a space, `Escape`, or blur.
- ⚠️ **Escaping happens BEFORE highlighting.** `renderMessageBody()` calls `escapeHTML()` first and only then wraps `@name` in a span, so a mention can add a highlight but never arbitrary markup. A mention must never become an XSS vector — regression-tested, and removing the escape call makes the suite fail.
- A mention is deliberately **not** auto-read. It raises the ordinary unread badge, and — consistent with read receipts — it is acknowledged only by opening the chat. It is never announced for historical messages, only genuinely new ones, so opening the chat does not replay every past `@` as an alert.
- `.chat-composer` was given `position: relative` so the popup anchors to the composer rather than the whole modal.
- **The mention is BLUE, not the green brand primary** — a direct `@` call-out has to read differently from ordinary text and from the send button. The colour comes from a new shared variable `--chat-accent-blue` / `--chat-accent-blue-soft`, declared in **both** `style.css` (`#1A6FD4`, 4.6:1 on white — AA for body text) and `theme.css` (`#7CB8FF`, lightened because the light-theme blue is unreadable on a dark bubble). This follows the convention at the top of `chat.css` — *"every colour comes from the shared CSS variables … no dark-mode rules are needed here"* — so the mention themes automatically. Do **not** hardcode a hex in `chat.css`; a literal colour would stay stubbornly blue in dark mode. The "Seen" tick was switched to the same variable so mentions and read receipts read as one notification system. `test/chat-access.test.js` fails if the mention is restyled to the green primary, hardcoded, or if either theme stops declaring the variable.

* Covered by `test/chat-access.test.js` (picker opens/filters/closes/inserts, stored `mentions` array, highlight span, `chat-msg-mentions-me` only for mentions of *me*, XSS safety).

### Ticket mentions (`ticket BNW-TIX007` — clickable)

> Either side can point the other at a ticket by typing the word **ticket** and the reference. It renders as a chip, and clicking it opens that ticket's modal — so **superadmin → HR** and **HR → superadmin** both work, each seeing exactly the modal their own page would show.

**⚠️ THE REFERENCE LIVES IN THE MESSAGE TEXT, NOT IN A FIELD.** A `ticketRefs: [...]` array on the message doc was the obvious design and was deliberately rejected. The `match /messages` create rule has **no `hasOnly()` allowlist** (unlike rooms, reactions and receipts, which each pin an exact key list), so a new field *would* be permitted — but `sendMessage()` is written defensively against **deployed** rules older than this client and already falls back to a reduced payload when a write is refused. Keeping the reference inside `text` means **no schema change and nothing to deploy**, and — the real win — **a message sent before this feature existed still renders a working link**, because the words are already in the text. The chip is built at *render* time only; nothing about a ticket reference is ever persisted.

* **Both entry points work.** Typing `@ticket` opens a picker of the **50 most recent RESOLVED tickets** (one cached read, newest first, searchable by number, branch or title); picking one inserts `@ticket BNW-TIX007 ` — the chip absorbs the `@` — with the same click / `Enter` / `Tab` / arrow-key handling as the `@` picker, which it **shares** (`#chatMentionMenu`, all its key handling, and `pickerMode`). A **hand-typed** reference works too, so the picker is a convenience, never a requirement. All of `@ticket X`, `ticket X`, `Ticket: X`, `TICKET X` and `ticket #X` resolve, case-insensitively. See the `@ticket` / `@violation` section below for why the bare word no longer *triggers* the picker.
* ⚠️ **ONLY RESOLVED TICKETS CAN BE MENTIONED.** `isMentionableTicket(t)` is a single shared predicate (`status` trimmed + lowercased === `'resolved'`), and it is applied in **four** places, not just the picker:
  1. `ensureTicketIndex()` drops unresolved tickets **before** the 50-cap — filtering after the slice would let a burst of open tickets push every Resolved one out of the picker, leaving it mysteriously empty on a busy day;
  2. `indexTicket()` refuses to *cache* one, so the resolver's fast path is gated for free;
  3. the direct `tickets/<id>` read re-checks it;
  4. the `ticketNumber` scan re-checks it.

  Steps 3 and 4 are the ones that matter: without them a **hand-typed** reference to a still-open ticket would sail past the empty picker and hand HR the exact thing the rule exists to withhold. **This mirrors a real permission, not a display preference** — `renderOwnerTickets()` already force-locks `selectedStatus = 'Resolved'` for the owner, HR and superadmin roles (`js/owner-dashboard.js`), so mentioning an open ticket would have shown HR work they cannot see yet. `test/chat-ticket-mentions.test.js` asserts both that HR's scope is still Resolved-only and that the gate is applied in all four places.
* **The failure toast names the real reason.** A reference that cannot be resolved produces either *"Ticket X was not found"* (a typo — `error`) or *"Ticket X is not resolved yet — it can be mentioned once it is"* (`info`), via `lastRefWasUnresolved`. Telling someone a valid ticket number "was not found" would send them hunting for a typo that does not exist; this way they know to come back when it is resolved.
* **Prose is never linkified.** A token is only linked when it contains a digit or a separator, so *"that ticket looks wrong"* and *"the tickets are late"* stay plain text. The picker also needs the word `ticket` at a **word boundary followed by a space**, so `multiticket BNW-TIX001` is not a reference.
* **Resolution order — cheapest and most exact first:** (1) the cached index, by document id then by `ticketNumber`; (2) a direct read of `tickets/<lowercased-ref>`, because that *is* the document id for a real ticket; (3) one collection read matched on `ticketNumber`, for a reference whose casing or prefix does not line up with the id. A reference that resolves to nothing raises a **toast** — never a dead click.
* **It opens the modal THIS page has**, not a new one: `window.openTicketModal(id)` on the command center, `window.openOwnerReport(id)` on the HR dashboard. Same fields, same attachments as clicking the row on that page's own table, and **no new read access** — the `tickets` read rule already admits any signed-in user.
* ⚠️ **Escaping happens BEFORE linkifying**, exactly as for `@name`, so a reference can only ever add a `<button>` built from already-escaped text. The id travels in an **escaped `data-ticket-ref` attribute**, never inline JS. The test asserts a `<img onerror>` payload comes out as inert escaped text and creates no new element.
* The chip is a **real `<button>`**, so it is keyboard-reachable and keeps a visible `:focus-visible` ring. It is styled with the same `--chat-accent-blue` tokens as the mention (no hardcoded hex, so it themes automatically) and its transition is disabled under `prefers-reduced-motion`.
* The ticket click and the reaction click are **separate listeners on the same log element**, each bailing out on its own condition — a chip carries no `data-reaction-msg` and a reaction chip no `data-ticket-ref`, so one click can never open both. Neither relies on `stopPropagation()`.
* The regex is built by a **factory** (`ticketRefPattern()`), not a shared `/g` literal: a module-level global regex carries `lastIndex` between calls and silently skips matches.
* Covered by `test/chat-ticket-mentions.test.js` (no schema change, prose not linkified, escaped-button chip, XSS payload inert, resolution order, Resolved-only enforced in all four places, both failure toasts, both page modals, the 50-cap, themed styling, reduced motion).

### `@ticket` / `@violation` — the ONLY picker triggers

> Typing **`@ticket`** or **`@violation`** opens that list. The **bare-word forms (`ticket `, `violation `) are NO LONGER triggers** — they fired on the keyword plus a space *anywhere* in the message, so ordinary prose opened the picker mid-sentence (`"that ticket looks wrong"`, `"that violation is serious"`). The `@` makes it an unambiguous, deliberate request, and it matches the `@` people picker already sitting in the same box.

**The bare form still LINKIFIES.** `ticket BNW-TIX007` and `violation VIO-0007` in a *sent message* still render as a working chip, so every message written before this change keeps its links. Only the **autocomplete** is gated behind the `@`.

Three pickers share the one `#chatMentionMenu` — people (`@name`), tickets and violations — and **only one is ever open**. The keydown handler asks **`pickerMode`** (`'people' | 'ticket' | 'violation'`) which picker it is driving.

* ⚠️ **The old inference was removed, not extended.** The handler used to decide "this is a ticket list" by asking `mentionMatches.length === 0`, reasoning that the people picker is the only one leaving that array populated. That was already inferring state from a side effect, and it **cannot tell a ticket list from a violation list** — both leave the array empty, so <kbd>Enter</kbd> would have driven whichever rows were showing through the *wrong* apply function (pressing Enter on a violation row could have applied a ticket id). `pickerMode` is now set explicitly by whichever `update*Menu()` rendered and cleared by `closeMentionMenu()`.
* **`syncRefPicker()` is the dispatcher**, called from the input/click/keyup handlers. ⚠️ **Order is specific-wins-over-general**: an explicit `@ticket`/`@violation` first, then a bare `@` for people. A bare `@` must not win over a ref token, or the people list would open on top of the list that was actually asked for. There is **no bare-word branch** — `activeTicketQuery()` and `activeViolationQuery()` were deleted, and `activeTicketRefDescriptor()` / `activeViolationRefDescriptor()` now return `null` unless the `@` form is present.
* ⚠️ **THE INSERTED TEXT CARRIES THE "@"** — `@ticket BNW-TIX007 ` / `@violation VIO-0007 ` — and the chip **swallows** it, so the rendered message shows one clean chip with no dangling `@` left in the text. This reverses an earlier decision to insert the bare form, and it is why the linkifier patterns capture the `@` as **group 1**.
* ⚠️ **BECAUSE OF THAT, `REF_TRIGGER_WORDS` IN `extractMentions()` IS LOAD-BEARING.** `extractMentions()` scans `/@[\w.\-]+/g`, so without the skip list every picked reference would write *"violation"* onto the message as a mentioned **person**, firing a mention toast and sound at whoever it resolved to. The list holds `@ticket`, `@tickets`, `@violation`, `@violations`. Removing it must fail the test suite.
* ⚠️ **A SINGLE ENGLISH WORD AFTER THE TRIGGER IS PROSE, NOT A QUERY.** `"check @violation now"` matches the trigger and leaves `"now"` as the query — one word, no space — so the multi-word guard cannot catch it. Left alone the picker would open mid-sentence, and **picking a row would overwrite the user's actual words** with a reference. The query must therefore be empty, or start with a digit, or already carry a separator (`VIO-0`, `BNW-`). This is the right filter here because every mentionable reference *is* a numbered record.
* The `@` must not be preceded by a word character, so an address like `a@ticket.com` is not a trigger.
* Updated in `test/chat-ticket-mentions.test.js`: its freeze-regression assertion now guards `activeTicketRefDescriptor()` and asserts the dispatcher does **not** consult the removed bare-word triggers — so the picker cannot silently stop opening, and the old bug cannot return. Its behavioural freeze test drives the real picker with a **delayed** index and now types `@ticket `, proving the read still settles and both Resolved tickets are offered.
* Covered in `test/chat-violation-mentions.test.js` by actually **running** `activeAtRefQuery()` over both the firing inputs and a list of bare-keyword sentences that must stay inert.

### Violation mentions (`violation VIO-0007` — clickable)

> The mirror of ticket mentions, for CCTV reports. **superadmin → HR** and **HR → superadmin** both work, each opening the report modal their own page already has.

**⚠️ WHY THIS IS NOT A COPY OF THE TICKET CODE.** Tickets are readable by any signed-in user, so the ticket index is one unfiltered read. Violations are **not** (`firestore.rules`, `match /violations`):

```
allow read: if isOperatorOrSuperAdmin() || (isHr() && isTransferredToHr());
```

An **unfiltered query is DENIED for HR by design** — the privacy guarantee, not a bug. Two consequences, both load-bearing:

1. **Every read is filtered on `hrStatus == 'transferred'`**, which *both* roles may run (HR via `isTransferredToHr()`, superadmin via `isOperatorOrSuperAdmin()`). One query shape serves both — no role branching, and no permission-denied path. A superadmin *could* read everything, but querying the same transferred set on purpose is what guarantees the picker can never offer a chip the recipient is unable to open.
2. **There is no direct-document read in the resolver.** `resolveTicketRef()` can read `tickets/<ref>` because a ticket's document id *is* its lowercased number. Violations are created with `.add()` (`firebase.js` `addViolation`), so their ids are Firestore auto-ids and the number lives in a separate `violationNumber` field — `violations/vio-0007` could never exist. Matching the number therefore means a **query**.

* ⚠️ **ONLY TRANSFERRED REPORTS CAN BE MENTIONED.** `isMentionableViolation(v)` (`hrStatus` trimmed + lowercased `=== 'transferred'`) is applied in the same **four** places as the ticket gate: dropped in `ensureViolationIndex()` **before** the 50-cap (filtering after the slice would let a burst of untransferred reports push every mentionable one out of the picker), refused by `indexViolation()` so the resolver's fast path is gated for free, and re-checked on the resolver's query path. Reports filed before the transfer feature existed have **no** `hrStatus` at all, so they simply do not match — exactly as the rules treat them.
  * **Stated consequence:** a superadmin can only link reports they have **already transferred**. That is the point — the chip says *"look at THIS one"*, and it is useless if the other side cannot open it. Transfer first, then mention.
* **The one deliberate unfiltered read** is the *last* step of a failed resolve, and only to tell **"not transferred yet"** from **"not found"** via `lastViolationWasUntransferred`. Only a superadmin may run it; for HR it is denied, which is correct — *"not found"* is the right answer when they cannot see the record. Its error is swallowed, and the test asserts it sits **after** the filtered lookup.
* **The failure toast names the real reason**, as tickets do: *"Report X was not found"* (a typo — `error`) vs *"Report X has not been transferred to HR yet — transfer it before mentioning it"* (`info`).
* ⚠️ **Prose is never linkified — and this matters MORE here**, because *violation* is a common English word. The token must contain a digit or a separator, so *"a policy violation was found"*, *"that violation is serious"* and *"violations are up this month"* all stay plain text, and `multiviolation VIO-0007` is not a reference. The test asserts each of these.
* **Resolution order:** the cached index, by document id then by `violationNumber`; then one filtered collection read matched on `violationNumber`. The picker offers the **50 most recent transferred** reports (newest transfer first), searchable by number, id, store, subject, location or reporter — the same cap and reasoning as the ticket picker.
* **It opens the modal THIS page has**, not a new one: `window.openViolationModal(id)` on the command center, `window.HrViolations.openModal(id)` on the HR dashboard. The chat is **suspended, not closed** (unsent draft, active room and scroll position all survive), and the modal's close is *waited for* via the same `waitForTicketModalOpen()` / `MutationObserver` machinery tickets use — the comment on `openTicketFromChat()` records exactly what happens when an async opener is assumed to have worked when it has not.
* ⚠️ **`HrViolations.openModal()` NOW RETURNS A BOOLEAN.** It looks the report up in its listener's in-memory array, so a report whose snapshot has not arrived returns `false`; it used to `return` `undefined` on *both* the success and the failure path, so chat could not tell *"opened"* from *"not found"* and a click looked like a dead chip. `script.js`'s `openViolationModal()` still returns nothing on success, so chat tests `!== false` — only an **explicit** `false` counts as failure.
* ⚠️ **Escaping happens BEFORE linkifying**, exactly as for `@name` and tickets. The chip is a real `<button>` carrying an **escaped `data-violation-ref`** attribute (never inline JS), keeps a `:focus-visible` ring, honours `prefers-reduced-motion`, and is styled with the same `--chat-accent-blue` tokens (no hardcoded hex, so it themes automatically).
* The chip click is a **separate delegated listener** from the ticket and reaction clicks, and each bails out on its own condition — a violation chip carries no `data-ticket-ref`/`data-reaction-msg` and vice versa, so one click can never open two things. Neither relies on `stopPropagation()`.
* Like a ticket reference, **nothing about a violation reference is persisted** — no `violationRefs` field, so no schema change and nothing to deploy, and a message sent before this feature existed still renders a working chip.
* Covered by `test/chat-violation-mentions.test.js` (no schema change, prose not linkified, escaped-button chip, XSS payload inert, transferred-only enforced everywhere, the read rule itself quoted so widening it fails here first, no direct-doc read attempted, both failure toasts, both page modals, the `@` never inserted, the freeze regression, themed styling).


### Chat read receipts (✓ Sent / ✓✓ Seen)

Your own messages carry a tick next to the timestamp: a single grey **✓** once Firestore has stored it, turning blue **✓✓** once everyone else has read past it. Received messages carry no tick — the label describes *your* delivery, not theirs.

**Where the state lives.** Messages are deliberately immutable in `firestore.rules` (`allow update, delete: if false` on `chats/{id}/messages/{messageId}`), so "seen" is **not** stored on the message. Stamping a per-message `seen` flag would force that rule open and let anyone rewrite the text of something already sent. Instead each person owns exactly one doc at `chats/{id}/readReceipts/{emailKey}` holding `lastReadAt`, and a message of mine counts as Seen when every *other* participant's `lastReadAt` is at or past my `sentAt`.

This also makes it cheap: a 200-message thread costs two receipts, not 400 message updates.

- `markThreadRead()` runs when the chat opens and whenever a snapshot arrives while it is open, throttled to one write per 5s (the listener fires per snapshot, and the sender's own client is also open, so an unthrottled write would burn quota for no change).
- Your own receipt is excluded from the calculation, otherwise you would "see" your own message immediately.
- A separate listener repaints the ticks as receipts arrive, so they turn blue without a refresh.
- Receipts are `set` with `{ merge: true }` so a create/update race cannot clobber the doc.

**Rules.** `match /readReceipts/{userKey}` — readable by the whole chat (that is what turns a tick blue), but `create` requires `request.resource.data.email == selfEmail()` and `update` requires `resource.data.email == selfEmail()`. Without that owner check, anyone could mark everybody else's messages as read.

* **⚠️ "Seen" must mean the reader actually opened the chat — delivery is NOT reading.** An earlier version advanced the read receipt on *any* snapshot whose newest message was from somebody else, including while the modal was closed. That made the sender's tick go blue for a conversation the reader never looked at, which defeats the entire purpose of a read receipt. A receipt is now written only when `isChatActuallyVisible()` is true: the modal carries `.active` **and** `document.hidden` is not `true` (a background tab must not count as reading either). `openModal()` uses the same guard, and a `visibilitychange` listener re-acknowledges when the tab is brought back with the chat already open. Regression-tested in `test/chat-access.test.js` — a message pushed to a **closed** chat must write no receipt, and mutating the guard back to `if (true)` makes the suite fail on exactly that.
* **⚠️ A throttled receipt write must be DEFERRED, never dropped.** The bug behind "I have to refresh the page to see the seen indicator": `markThreadRead()` is throttled, and the original `if (tooSoon) return;` silently *discarded* the request. If a message arrived inside the throttle window there was no pending write and — because no further snapshot follows — nothing to retry, so `lastReadAt` never advanced past that message and the sender's tick stayed grey until a reload happened to re-run the write. Now a throttled call sets `receiptWritePending` and a `receiptFlushTimer` writes as soon as the window closes, so the state always converges. Opening the chat passes `force: true` to bypass the throttle entirely. Covered by `test/chat-access.test.js` (a mutation that restores the `return;` makes the suite fail on *"receipt was never flushed"*).
* **⚠️ Until the rules are redeployed the ticks stay permanently grey.** A denied receipt is caught and downgraded to a `console.warn` — the chat keeps working, it just never shows blue. That is the correct failure mode, but it looks identical to "nobody has read it yet", so check the console if the ticks never turn blue.
* Covered by `test/chat-access.test.js` (receipt snapshots drive the ticks: single tick on send, blue on read, own receipt excluded, older receipt does not count) and `test/chat-rules.test.js` (messages still immutable; receipts owner-only; never world-writable).

## Automatic Error Reporting (console only)

Crashes and unhandled promise rejections are captured automatically and written to the **browser console**, so a failure is visible while developing instead of vanishing when the tab closes.

**⚠️ THIS USED TO BE A DATABASE FEATURE, AND WAS REMOVED DELIBERATELY.** There was an `app_errors` Firestore collection, a superadmin **Error Log** tab, and a rules block — all gone. The reason was **quota**: the app runs on the free (Spark) plan, and the reporter was spending it on ordinary activity. It cost more than one write per error:

- **1 write** per reported error (`.add()`)
- **a full collection READ** per report — `pruneCollection()` re-queried the entire log on *every* report just to check the size cap
- **N deletes** when over the cap
- **a toast on every report**, shown to every user, not just superadmins

And the 200-entry cap could not prevent any of that — it only trimmed *afterwards*. The dedupe window was in-memory, so a page reload reset it, which is the likely reason writes crept up. Removing the feature eliminated all of it; the hook itself stayed, because losing crash visibility entirely was not worth the saving.

**What is captured — deliberately narrow.** `js/error-reporter.js` hooks only `window.onerror` and `unhandledrejection`. It does **not** hook `console.warn`/`console.error`/`console.log`, so the ~115 existing warning call sites stay out and every line is worth reading. `<script>`/`<img>`/`<link>` resource load failures are ignored too, since each page already handles those itself.

**The line it writes.** One `console.error('[RCMS]', { … })` with a structured object, so devtools can expand and filter it:

| Field | Purpose |
|---|---|
| `message` | the error text, truncated |
| `source` | reduced to `file.js:line:col` |
| `kind` | `error` or `unhandledrejection` |
| `page` | which page it happened on |
| `user` / `role` | who hit it (lower-cased email; `signed-out` when anonymous) |
| `userAgent` | browser context |
| `at` | ISO timestamp |
| `count` | repeat count (always present, so the shape never changes) |

**Safety — this code sits in the failure path, so it must not be able to make things worse:**
- **Never throws.** Every path is wrapped in `try/catch`; a failed report is swallowed silently. Guarded by a re-entrancy flag so a crash inside the reporter cannot report itself and loop, and a `console.error` that itself throws is caught too.
- **De-duplicated.** The same message within `DEDUPE_MS` (5 min) logs **one** line instead of another, so a broken `setInterval` cannot scroll the console away.
- **Truncated.** Message and source are cut to `MAX_MESSAGE_LENGTH` (500).
- **Transmits nothing.** No network, no storage, no writes of any kind. The worst it can cost is log noise.
- ⚠️ **The dedupe window is in-memory, so it resets on reload** — the same limitation the Firestore version had, and acceptable only because a repeat now costs a console line rather than a write. A page that throws on every reload will log once per reload; a `localStorage` window would close that at the cost of persistence this does not need.

**Where it loads.** Immediately after `firebase.js` on **both** `main.html` and `ownerdashboard.html`, so it is listening before any other script runs and can catch their failures — a script that fails to load never gets to register a handler of its own.

* **⚠️ Two manual steps remain, or the quota saving is only half-done.** Deleting the rules block stops *access*; it does not delete stored documents.
  1. **Delete the `app_errors` collection** in the Firebase console (or via a one-off script). Otherwise you keep paying for its storage and reads.
  2. **Run `firebase deploy --only firestore:rules`**, or the old `app_errors` block stays live in production.
* Covered by `test/error-reporter.test.js` (20 checks: vm sandbox asserting `db`/`firebase` are **never touched** — they are traps that throw on access — plus the dedupe, re-entrancy, truncation and hook guarantees, and static checks that the Error Log UI and the rules block are gone). The "never touches Firestore" check is mutation-tested: re-adding a `.add()` call makes the suite fail.

## App icon + installable manifest

> Before this, the app had **no favicon at all** — every browser tab and bookmark showed the default globe. It is also now installable as a standalone app.

* **`favicon.svg`** — a camera glyph in the brand green `#72bf6a` on the dark navy `#0F172A`, with a red recording dot reusing `--color-danger`. It is an **SVG**, not a PNG, so it stays sharp at every size and needs no multi-resolution `icon-*.png` set. The existing `header.png` fallback logo is left alone.
* **`manifest.json`** — `display: standalone`, `short_name: "CCTV Center"`, and a single `any`-size SVG icon.
* **⚠️ `theme_color` cannot be a static value here.** A manifest normally uses `prefers-color-scheme` to pick light vs dark chrome, but **this app's dark mode is opt-in** (see the theme system above — the OS preference is deliberately ignored and dark is a toggle stored in `localStorage`). A `prefers-color-scheme`-driven chrome colour would therefore disagree with the page it is framing. Instead `theme.js` keeps `<meta name="theme-color">` in sync with the live theme (`THEME_COLOR = { light: '#72bf6a', dark: '#0B1220' }`), so the mobile address bar always matches what the user actually chose.
* All **five** pages carry `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<link rel="manifest">` and the `theme-color` meta.
* `js/theme.js` gained `updateThemeColorMeta()`, called from both `applyTheme()` and `init()` so the very first paint is already correct.

## Downtime & uptime panels — offline branches must never read 100%

> "Gil Fernando is offline but the dashboard shows it as healthy." All four downtime panels were **deriving downtime from `status_logs` alone**, and a branch that is offline *right now* is exactly the case the logs cannot describe.

### Two sources, two jobs

* **`status_logs`** — the historical record of status *changes*.
* **The `branches` doc** — the **authoritative current state**: `currentStatus`, `currentDowntimeStart`, `lastUpdated`.

A still-open outage has no closing `"Online"` log, so logs alone cannot close it out. Worse, an outage that began *before* the reporting window has its opening `"Offline"` log **filtered out** by the in-window scan. In both cases the branch fell through to the default `{ uptimePct: 100, offlineMinutes: 0, incidents: 0 }` and rendered as a **green 100% row while it was actually down**.

### The two helpers

* **`resolveOngoingOutageStart(branchName, logOpenStart, windowStart)`** — reconciles the two sources for an outage that is still open. It takes the **earliest** valid start (`currentDowntimeStart`, else the log-derived start, else `lastUpdated` as a fallback for legacy docs) so one outage evidenced by both sources is **counted once, not twice**, then clamps it to the window start.
* **`resolveCarryInOutageStart(branchName, windowStart)`** — the other half of the bug, found by the test suite: an outage that began *before* the window and **closed inside** it. Its opening log is filtered out, so the window would start mid-outage and attribute **none** of the downtime. This returns the window start when the most recent pre-window log says `Offline` and nothing restored it in between. Without it, a 2-hour outage was reported as **0 minutes**.

### Every panel now goes through them

* `computeBranchUptime()` iterates **all known branches**, not only those with in-window logs, and folds the open outage in.
* `calculateDowntimeFromLogs(logs, branchName, windowStart)` lost its `length < 2` early return — **a single `"Offline"` log is a real ongoing outage**, not zero downtime. It is now backwards-compatible: with no `branchName` it behaves exactly as before.
* `calculateTotalMonthlyDowntime()` and `renderTrendChart()` both add the currently-offline branches that have no in-range log.
* `distributeDowntimeFrom()` no longer `break`s on `idx < 0`, which silently discarded all pre-range downtime; the start is clamped forward instead.
* `renderDowntimeLeaders()` already reconciled offline-now branches (the "Holy Spirit 850h 50m" case) — it now also passes the branch name through, and the other three panels match it.

### Making the state unmissable

* Offline branches **sort to the top** of the Branch Uptime panel, so a down branch is never buried under healthy history.
* Each offline row gets a **`● Offline` badge** plus a red `.uptime-row-offline` tint and inset bar, reusing the existing `--color-danger*` tokens (already defined for dark mode in `theme.css`). The row is forced to the `bad` colour regardless of its monthly %, which can still read high early in the month.
* The "Network avg" pill appends **`· N offline`** and takes `.dash-chart-pill.danger`.

### Trade-off worth knowing

A branch that has been down since last month will now legitimately read a **very low** uptime %, because downtime is divided by a **partial-month** window. That is correct, not a regression — the same is true of the ongoing-outage branch that was already being counted before this change.

### Test

`test/uptime-offline.test.js` (11 cases, run by `npm test`) locks this down: the reported Gil Fernando scenario, whole-window outage, online regression guard, **no double counting** when both sources match, a closed outage, the boundary-crossing carry-in, a fully pre-window outage not leaking in, the single-`Offline`-log case, and a no-logs offline branch.

## The login gate (`main.html` / `ownerdashboard.html`)

> Typing `main.html` in the address bar used to load the dashboard with **no session at all**. The redirect existed but its body was commented out — `// Comment out to allow public access to index` — so the `if` block did nothing at all.

### What it does now

* **`PROTECTED_PAGES = ['main.html', 'ownerdashboard.html']`**, matched against the **last path segment** via `currentPageName()`. The old check was `pathname.includes('main.html') || pathname.endsWith('/Implement/')`, which was wrong twice: it hardcoded a **local folder name** (so it broke on deploy to a subdirectory) and `includes()` also matches decoys like `main.html.bak`.
* **`redirectToLogin()` uses `location.replace()`, not `href`**, so the **BACK button cannot walk from the login page straight back into the dashboard**.
* The destination rides along as `?next=`, and `resolveLoginDestination()` honours it so a bounced user lands where they were headed.

### ⚠️ The public pages must STAY public

This is the half of the change that can lock real users out, so it is asserted explicitly:

* **`submit-ticket.html`** — the public complaint form. Gating it locks out your customers.
* **`pending-approval.html`** — where a not-yet-approved signup is sent. Gating it traps them in a **redirect loop**.
* `login.html` — obviously.

An already-signed-in visitor who lands on `login.html` is forwarded on via `resolveLoginDestination()`, so owners/HR still reach `ownerdashboard.html` rather than briefly loading the wrong dashboard.

### This is a UX gate, NOT a security boundary

Anyone determined can delete a JS redirect. The authoritative gate is `firestore.rules`, and there the sensitive collections are already closed to anonymous users:

| Collection | Anonymous access |
|---|---|
| `status_logs` | blocked — `isSignedIn()` |
| `violations` | blocked — `isOperatorOrSuperAdmin()` |
| `users` | blocked — `isSuperAdmin() \|\| isSelf()` |
| `tickets` | create open **by design**; reads limited to `approvalStatus == 'approved'` |
| **`branches`** | ⚠️ **`allow read: if true`** — still open |
| **`counters`** | ⚠️ **`allow read, write: if true`** — still open |

**The one real remaining leak is `branches`**: anyone can enumerate every branch and its live online/offline status. Closing it needs `allow read: if isSignedIn()` plus a `firebase deploy --only firestore:rules`, and `submit-ticket.html` would then have to use its existing hardcoded `fallback` branch list (it already has one at `submit-ticket.html:1459`, currently only used on error). Left alone deliberately — it changes behaviour for a flow that runs without a login.

### Test

`test/auth-guard.test.js` (run by `npm test`) asserts the gate exists, the two dashboards are protected, the three public pages are **not**, the decoy-path substring trap is closed, `?next=` is validated against the allowlist (an unvalidated value would be an **open redirect** — a phishing link wearing your login page), and that the old "allow public access" opt-out has not been reintroduced.

## Owner Dashboard dark mode — the background that would not go dark

> "When I change into dark mode it doesn't go to dark mode but all other components go to dark mode." Every **card** on the Owner Dashboard themed correctly. The **page behind them** did not.

### The actual cause: an empty rule is not an override

`ownerdashboard.html` carries its own tokenised `<style>` block that is supposed to make the page area neutral. It shipped like this:

```css
#ownerMainContent {
    /* no custom background — inherits main.html's standard #mainContent bg */
}
```

It **looks** like an override and does **nothing** — a rule with no declarations cannot beat a declaration. Meanwhile `style.css` had:

```css
#ownerMainContent {
    background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);  /* hardcoded light */
}
```

An **ID selector** beats `.main-content`, so the hardcoded gradient won. In dark mode the entire content area stayed `#f8fafc → #f1f5f9` while the cards sitting on top of it went dark — exactly the reported symptom. Both sides now use `var(--bg-primary)`.

### Four more light-only surfaces in the same block

| Rule | Was | Now |
|---|---|---|
| `.owner-panel` | `rgba(255,255,255,0.85)` + navy shadow | `var(--bg-card)` + `var(--shadow-sm)` |
| `.owner-filter-wrap` | `rgba(255,255,255,0.8)` | `var(--bg-card)` |
| `#ownerReportsTable thead th` | `#f8fafc` | `var(--bg-tertiary)` |
| `#ownerReportsTable tbody td` | `rgba(255,255,255,0.65)` | `var(--bg-card)` |
| row hover | `rgba(37,99,235,0.02)` (invisible) | `var(--bg-hover)` |

The reports-table cells were the **same unreadable-text bug** the ticket table had — light text on a near-white wash, ~1.3:1 against a 4.5:1 WCAG AA minimum — so that one is a readability fix, not a cosmetic one.

### ⚠️ Why the existing guard missed all of it

`test/owner-dark-mode.test.js` scanned only the **inline `<style>` blocks** of the page. It read `style.css` for token *definitions* only — **never for hardcoded colours in consuming rules**. The owner-dashboard block in `style.css` was unguarded, so the page's own rules could be perfect while this stale duplicate copy drifted light-only.

That duplicate is the real lesson: **`ownerdashboard.html` overrides `style.css` for the same selectors.** Two copies of `.owner-panel` existed with identical specificity, and the one that had been fixed was not the one that would have failed the build.

The test now also scans the `style.css` owner block for hardcoded white / near-white backgrounds and navy shadows, and names each previously-broken surface individually so a failure points at the thing a user would actually see. Two subtleties worth keeping if you extend it:

* **Strip `/* … */` before scanning** — a comment that *names* the value it replaced (`"was #f8fafc"`) is not the bug, and a guard that flags its own documentation gets disabled.
* **Anchor the slice on the rule, not the first textual mention** — the explanatory comment above `#ownerMainContent` also contains that string, so anchoring there starts the slice mid-comment.

## Skeleton loaders (replacing the "Loading…" spinners)

> The dashboard's three secondary panels showed a spinning glyph and the word "Loading…". The panel then **collapsed and re-expanded** when data landed, so the page visibly jumped. A skeleton holds the panel's shape instead.

* **`.skeleton` + `-line` / `-block` / `-avatar` / `-stack`** in `style.css`. The sheen is a `background-position` sweep rather than a `transform`, so it never resizes anything or triggers layout.
* Replaces the spinners in `activityFeed`, `uptimePanelList` and `downtimeLeaders`. The markup is static HTML in `main.html`, so **no JS change was needed** — the first Firestore snapshot overwrites it.
* **Skeletons are for CONTENT, spinners are for ACTIONS.** The button spinner on a submitting form stays: a skeleton there reads as "the page is broken" rather than "this is working".
* **Dark mode needs a different sheen.** The light `--skeleton-sheen` is a translucent grey, which is nearly invisible against a dark card — a dark-mode skeleton with the light token looks *frozen*. `theme.css` overrides both `--skeleton-base` and `--skeleton-sheen` inside the dark block, following the same page-local-token lesson as the owner dashboard's `--owner-*` tokens.
* Each skeleton carries `aria-busy="true"` and an `aria-label`, so assistive tech is told it is loading rather than reading empty bars.

## Global reduced-motion coverage

> `style.css` defines `--transition: all 0.25s ease` in `:root` and applies it to nearly every interactive element, and `.tab-content` animates in with `fadeIn` on every tab change — but until now **only the violation browser honoured `prefers-reduced-motion`** (one block). A user asking for less motion still got page transitions, card hover lifts and shimmer.

* One consolidated `@media (prefers-reduced-motion: reduce)` block at the **end** of `style.css` (it has to win over everything above it) that:
  * sets `--transition` / `--transition-slow` to `none` **at the token**, which kills the majority of transitions without listing selectors;
  * turns off `html { scroll-behavior: smooth }` so programmatic scrolling does not glide;
  * removes the `.tab-content` entrance and the remaining `fadeIn` entrances (`.violation-period-note`, `.rejection-reason-box`, plus `.track-result` on the public page);
  * neutralises the card hover-lift and stops the skeleton shimmer — the placeholder still renders, it just stops moving.
* Targeted by **selector**, not by redefining `@keyframes` inside a media query. That is valid CSS but far less obvious to the next reader, and the selectors involved are few and stable.

## Command Palette + Keyboard Shortcuts

> `Ctrl`/`Cmd`+`K` opens a searchable command list. Plus `1`–`8` to jump tabs, `/` to focus search, and `?` for the shortcut sheet.

* **`js/command-palette.js`**, loaded on `main.html` and `ownerdashboard.html` (and deliberately **not** on `login.html` / `submit-ticket.html` / `pending-approval.html` — a command palette over a sign-in form is not a feature).
* **It reuses `.modal-overlay` / `.modal-container`**, the same trick the chat modal uses, so it inherits the light/dark theme for free rather than re-coding a palette that can drift out of sync with the rest of the app.
* **It only offers commands the signed-in role can actually run.** The list is built from **visible** `.nav-item[data-tab]` elements, and the admin nav items ship `display:none` until `script.js` reveals them for a superadmin. An operator is never shown "Ticket Reviews" and then refused when they pick it. Same rule for **Report a Violation** and **Sign out**.
* ⚠️ **THERE IS NO BARE-LETTER SHORTCUT FOR THE THEME.** There used to be one — pressing `t` anywhere toggled light/dark — and it was **removed**. It looked safe because of the typing-target guard below, but that guard only recognises `input` / `textarea` / `select` / `[contenteditable]`. Click a table row (or any non-input element) and focus sits on *that* element, so the guard passed, the key was not being typed into anything, and the next `t` silently flipped the whole app's appearance. A modifierless letter is never worth that much blast radius.
  * **The theme is still one keystroke away, and explicitly so:** `Ctrl`/`Cmd`+`K` → "theme" (the `toggle-theme` command), or the moon button in the header. Nothing happens by accident.
  * **Do not reintroduce a bare letter here.** `/` and `1`–`8` survive precisely because they cannot be part of a word and cannot fire while someone is mid-keystroke.
  * `test/command-palette.test.js` asserts the sheet no longer lists `T`, the handler no longer contains the branch, that `t`/`T` toggle nothing **anywhere** (including the page body), and that the palette command still toggles — so removing the shortcut cannot silently remove the feature.
* **Shortcuts stand down when they must.** The handler bails if the target is an `input` / `textarea` / `select` / `[contenteditable]`, if a `.modal-overlay.active` is open behind it, or while the palette itself owns the keyboard. Without the first guard, typing "total" into a search box would jump tabs on the rest.
* **`Ctrl`+`digit` and `Alt` are never claimed** — those are browser tab-switching and back/forward. Only plain digits `1`–`8` are ours, and they index **visible** tabs, so the number always matches what is in the sidebar.
* **The handler runs in the capture phase** so it can claim `Escape` ahead of the per-feature document-level handlers in `chat.js` / `script.js`, but only while the palette is actually open.
* **Accessibility:** `role="dialog"` + `aria-modal`, and the search field is a **combobox** whose selection is published with `aria-activedescendant` — so arrow keys move the highlight without moving DOM focus out of the text field. Focus is captured on open and **restored on close**, so a keyboard user is not dumped at the top of the document every time. `Tab` is trapped.
* **Every interpolated string is escaped** (`esc()` → the page's `escapeHTML()`, with a `textContent`-based fallback). Labels carry user data, and the HTML is built by concatenation.
* Matching is an **ordered-subsequence** test, so `tkt` finds "Tickets". Out-of-order characters deliberately do *not* match, or every query would match everything.
* An empty result renders an explicit "No matching commands" message — a blank list reads as a broken palette.
* A search box is only offered for the **visible** tab, because focusing a hidden input silently does nothing.
* `?` opens a shortcut sheet whose rows live in `SHORTCUT_ROWS`; the test asserts the documented list and the implemented branches agree in **both** directions, so a shortcut cannot quietly stop working or quietly go undocumented.
* Covered by `test/command-palette.test.js` (vm sandbox with a small fake DOM) and the `node --check` in `npm test`.

## Animated counters (dashboard KPIs)

> The KPI tiles snapped from `0` straight to their final value, which reads as a page that loaded stale data. `animateValue()` eases the number up instead.

* `animateValue(el, target, { duration, format, suffix })` in `script.js` uses `requestAnimationFrame` with an `easeOutCubic` curve (linear reads as a machine). Wired into `renderSummaryCards()` and `updateTicketDashboard()`.
* **Three deliberate constraints:**
  1. **Never in the chat log.** That log's `innerHTML` is rebuilt on every Firestore snapshot, so a JS animation there restarts each update and strobes — the same reason the reaction glyphs are CSS-only.
  2. **Skipped under `prefers-reduced-motion`**, writing the final value synchronously so a number is never left mid-count.
  3. **Restarted, not queued.** An in-flight animation for the same element is cancelled and resumed from the value currently on screen (tracked in a `WeakMap`), so a burst of Firestore updates cannot leave dozens of timers fighting over one tile. The final frame writes the **exact** target, never a rounded intermediate.
* Readiness shows `—` rather than counting to a fake `0%` when there are no branches at all.

## Toasts — themed, plus a drawn checkmark

> `showToast()` used to write every visual property through `toast.style.cssText`, which means the `.toast-notification` rules in `style.css` had **never applied**, and the colours were hardcoded `#dc2626` / `#15803d` / `#1e293b`. That is the same class of bug as the `ownerdashboard.html` regression documented above: a fixed light-only colour that cannot follow the theme.

* Styling moved into real CSS classes (`.toast-notification--info/--success/--error`) that consume theme variables, so a toast is legible in **both** themes. The **surface** is now neutral with a coloured 3px left edge carrying the type signal, rather than a wall of saturated colour.
* **Success toasts get a checkmark that draws itself** — an SVG ring then tick, animated with `stroke-dashoffset` (pure CSS, no library). Deliberately restrained: this is an operations console, and confetti in a CCTV tool would read as unserious.
* Entry/exit are now `is-visible` / `is-leaving` **class** transitions rather than the old keyframes, which are removed. `is-leaving` is deliberately distinct so a re-trigger mid-exit cannot snap the toast back into view.
* **A double-dismiss guard** was added: the close button and the auto-dismiss timeout can both fire, and removing an already-detached node throws.
* The message is still `escapeHTML()`-ed (it carries branch names, ticket subjects and reporter emails), and the toast now carries `role="status"` / `role="alert"`.

## Utility classes (inline-style extraction)

> `main.html` carried **135** `style="..."` attributes, many repeated verbatim. The worst offenders: 25 × `display:none`, 12 × `color:var(--color-danger)`, and one full input style block copied 10 times.

* A `UTILITY CLASSES` block at the end of `style.css` — `.u-hidden`, `.u-section-sub`, `.u-icon-*`, `.u-bar-empty`, `.u-input`, `.u-table-bare`, and a few spacing resets. **135 → 76.**
* **Deliberately not a utility framework.** Only patterns duplicated three or more times were extracted. A utility invented for a single use is just an inline style with a longer name.
* **⚠️ `.u-hidden` must NOT have `!important` — this is a live regression, not a style preference.** The elements it replaced are revealed by `script.js` writing `el.style.display = 'flex'` / `'inline'` (the logout button, the admin nav items, the sidebar badges). An `!important` class **beats an inline style**, so tidying it up would make those elements impossible to show again and the admin nav would stay permanently invisible for a superadmin — with no error anywhere, it would simply stop appearing. Low specificity is the feature. `test/command-palette.test.js` fails the build if `!important` ever reappears there.
* Two related traps found while doing this, both now guarded: replacing `style="width:0%"` with `class="u-bar-empty"` on an element that **already had a `class` attribute** produces two `class` attributes, and browsers silently honour only the first — so the bar styling would vanish. The same happened for the 25 `display:none` cases. The test asserts **zero** duplicate `class` attributes in `main.html`.
* `test/error-reporter.test.js` asserted the Error Log nav item was hidden by the literal string `display:none`. It now accepts either mechanism, because the assertion's **intent** ("hidden until the role check reveals it") is what matters, not the mechanism.
* The remaining ~76 inline styles are genuine one-offs (per-element widths, layout tweaks) and were left alone. **Tier 3 was sequenced last** for this reason: `style.css` is ~5,600 lines and `ownerdashboard.html` already has a documented dark-mode regression from hardcoded values.

## First-run onboarding tour

> A short, dismissible 3-step tour for operators and superadmins, shown once.

* **`js/onboarding.js`**, loaded on `main.html` only. That means it is **not** on the owner dashboard, the login page or the public ticket page — the copy describes the operator/superadmin layout, so on any other page it could only ever be wrong.
* It bails unless **both** `.sidebar-nav` and an active `.tab-content` exist, which is what scopes it to the command center without hardcoding a role check.
* **Persist-once** via `localStorage['rcms_tour_seen']` (the existing `rcms_*` convention, every access try/catch'd). Dismissed counts as seen — **including via Escape** — because re-showing on every reload is the annoying failure mode. Private browsing degrades to "it shows again next time", which is harmless.
* **Always escapable:** a visible **Skip** button, `Escape`, or clicking outside. A tour that blocks a control-room operator mid-shift is worse than no tour. `←`/`→` step through, and the last step relabels its button to **Got it**.
* Steps point at **real selectors** and are resolved at render time. A step whose element is gone is **skipped**, and if the last one is gone the tour **closes** rather than hanging on a step that can never draw. `test/onboarding.test.js` asserts every selector still matches something in `main.html`, so a renamed class shows up as a failing test rather than as a quietly shorter tour.
* The previous step's spotlight is cleared before the next is applied, otherwise highlights accumulate.
* Focus moves into the tour on open; the copy is escaped; it reuses the shared modal classes and hardcodes **no** hex colours (asserted by the test, same rule as the owner dark-mode guard). Under `prefers-reduced-motion` the glow becomes a plain outline, so the target is still identifiable.
* Because it is once-only, dismissing is otherwise permanent — so the command palette exposes **Replay the quick tour**.
* Covered by `test/onboarding.test.js` and the `node --check` in `npm test`.

## Dashboard KPI depth

* The four `.dash-kpi` tiles gained a faint brand-tinted gradient wash (reusing the existing `--color-*-bg` tokens, so each tile still carries its own status colour) and a 1px top highlight via `::after`.
* **The highlight needs a dark-mode override.** A near-white hairline that reads as a subtle edge on a white card becomes a hard bright seam on a dark one, so `theme.css` sets `--card-highlight` to `rgba(226, 232, 240, 0.10)` in the dark block. Every value stays token-driven; no new hardcoded colour was introduced.
* `::after` is `position: absolute` against the card's own `position: relative`, and `overflow: hidden` on `.card` clips it, so the highlight cannot escape the rounded corner or shift layout.

## Conventions

* One theme: green primary everywhere; `login.css` variables (`--l-*`) map onto the same brand color.
* Charts must read colors from CSS variables so `theme.js` can restyle them — use `--text-secondary` for tick text and `--border-color` for grid lines.
* The Violations "REPORTS DATABASE" panel starts collapsed (`violation-tree-panel collapsed`); `script.js` still owns toggling.
* `printableReport` always prints on white regardless of theme (`@media print` override in `theme.css`).
* **New components reuse `.modal-overlay` / `.modal-container`** rather than inventing their own dialog chrome — that is what makes them theme for free. The same rule is why the command palette and the tour carry no hex colours.
* **Every new motion is wrapped in `prefers-reduced-motion: reduce`.** Motion that nobody can opt out of is a regression, not a feature.
* **Never put `!important` on a class that replaces an inline style JS writes to** (`display` being the obvious one). Inline styles must stay able to win — see `.u-hidden`.
* **Do not extract a single-use inline style into a utility class**; that is an inline style with a longer name. Three or more duplicates is the threshold used here.
* New features ship with a test wired into `npm test` and a section in this document, in the same format as the ones above.

