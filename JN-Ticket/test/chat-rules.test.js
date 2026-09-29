// Guards against a class of Firestore-rules bug that silently breaks
// writes: on a `create`, `resource` does not exist yet, so `resource.data`
// is null. A rule that dereferences resource.data inside a CREATE (or
// lumps create and update together) evaluates to DENIED, so sending never
// works and retrying never helps.
//
// It also guards the ORDER of the two writes a first message needs. Room
// membership is resolved by READING the room (`get(chats/{chatId})`), so a
// message written in the same batch as the room it creates is evaluated while
// that room still does not exist and is denied. The room must be committed
// first, on its own, and section 9 asserts that it is.
//
// Also asserts that the RULES allowlist (isHrOrSuperAdmin) and the CLIENT
// allowlist (CHAT_ALLOWED_ROLES) list the same roles. If they ever drift,
// a user can see the chat button but be denied on send.
//
// Static check on firestore.rules + js/chat.js; no emulator needed.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

console.log('Testing chat Firestore rules...');

/** Return the body of the `match /chats/...` block (braces balanced). */
function chatsBlock() {
    const start = rules.indexOf('match /chats/');
    assert(start > -1, 'firestore.rules has no match /chats/ block');

    // Skip the path pattern's own braces, e.g. `/chats/{chatId}`, so we
    // start counting at the brace that opens the BLOCK body.
    const pathOpen = rules.indexOf('{', start);
    const pathClose = rules.indexOf('}', pathOpen);
    const open = rules.indexOf('{', pathClose);
    assert(open > -1, 'could not find the opening brace of the match /chats/ block');

    let depth = 0;
    for (let i = open; i < rules.length; i++) {
        if (rules[i] === '{') depth++;
        else if (rules[i] === '}') {
            depth--;
            if (depth === 0) return rules.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces in the match /chats/ block');
}

const block = chatsBlock();

// 1. The chats match block must exist and be the one we expect.
assert(block.indexOf('/messages/{messageId}') > -1, 'chats block should contain the messages subcollection');
assert(
    block.indexOf('/readReceipts/{userKey}') > -1,
    'chats block should contain the readReceipts subcollection (the \u2713 Sent / \u2713\u2713 Seen ticks)'
);

// 2. CRITICAL: `allow create` and `allow update` must be SEPARATE rules.
//    A combined `allow create, update:` cannot reference resource.data.
assert(
    !/allow\s+create\s*,\s*update\s*:/.test(block),
    'chats rules must NOT combine `allow create, update:` — on a create, ' +
    'resource.data is null and the whole rule is denied, which rolls back ' +
    'the whole atomic batch (the message never saves). Split them.'
);

// 3. No CREATE rule anywhere may dereference resource.data.
const createRules = block.match(/allow\s+create[^\n]*(?:\n\s*&&[^\n]*)*/g) || [];
assert(createRules.length > 0, 'expected at least one `allow create` in the chats block');
createRules.forEach((rule) => {
    // Match a bare `resource.data` only. `request.resource.data` is the
    // NEW document and is perfectly valid inside a create rule, so a
    // naive substring check would flag it as a false positive.
    const bareResourceData = /(?<!request\.)\bresource\.data/.test(rule);
    assert(
        !bareResourceData,
        'a `allow create` rule references resource.data, which is null on ' +
        'create and causes a silent denial:\n' + rule.trim()
    );
});

// 4. A create rule for the room must constrain the writable field set.
assert(
    /allow\s+create\s*:[\s\S]*?hasOnly\(/.test(block),
    'the room create rule should restrict the writable fields with hasOnly()'
);

// 5. Messages: create must be gated on the sender being the authenticated
//    account, and messages must be immutable afterwards.
assert(
    /allow\s+create\s*:[\s\S]*?senderEmail\s*==\s*selfEmail\(\)/.test(block),
    'message create must require senderEmail == selfEmail() so nobody can post as someone else'
);
assert(
    /allow\s+update,\s*delete\s*:\s*if\s+false/.test(block),
    'sent messages must be immutable (update/delete denied)'
);

// 6. Typing presence: everyone in the ROOM may READ presence, but may only
//    ever write or delete their OWN record. create must not touch
//    resource.data (the doc does not exist yet on the first write).
assert(
    /match\s+\/presence\/\{userKey\}/.test(block),
    'a match /presence/{userKey} block is required for typing indicators'
);
assert(
    /match\s+\/presence\/[\s\S]*?allow\s+read\s*:\s*if\s+canReadChat\(chatId\)/.test(block),
    'presence must be readable by the room (canReadChat), not by role alone'
);
const presenceCreate = (block.match(/match\s+\/presence\/[\s\S]*?allow\s+create\s*:[\s\S]*?;/g) || [])[0];
assert(presenceCreate, 'presence must have an `allow create` rule');
assert(
    /isChatMember\(chatId\)/.test(presenceCreate),
    'presence create must require room membership — otherwise any HR could broadcast typing into another HR\'s private thread'
);
assert(
    /request\.resource\.data\.email\s*==\s*selfEmail\(\)/.test(presenceCreate),
    'presence create must require email == selfEmail() so you can only broadcast YOUR OWN typing'
);
assert(
    !/(?<!request\.)\bresource\.data/.test(presenceCreate),
    'presence create must not reference resource.data — it is null on create'
);
assert(
    /allow\s+delete\s*:[\s\S]*?resource\.data\.email\s*==\s*selfEmail\(\)/.test(block),
    'presence delete must be limited to the owner of that presence record'
);

// 6b. ⚠️ THE 1:1 PRIVACY RULE — the reason this whole file changed.
//     Conversations are one room per PAIR now, so a bare
//     `isHrOrSuperAdmin()` on a read would let ANY HR read ANY OTHER HR's
//     private conversation. Read access must be MEMBERSHIP, and every
//     subcollection must resolve membership through the room document.
assert(
    /function\s+isChatMember\(chatId\)/.test(rules),
    'isChatMember() helper is missing from firestore.rules'
);
const memberHelper = rules.match(/function\s+isChatMember\(chatId\)\s*\{[\s\S]*?\n\s*\}/);
assert(memberHelper, 'could not read the isChatMember() helper body');
assert(
    /isHrOrSuperAdmin\(\)/.test(memberHelper[0]),
    'isChatMember() must still require the HR/superadmin role gate'
);
assert(
    /selfEmail\(\)\s+in\s+chatRoom\(chatId\)\.data\.members/.test(memberHelper[0]),
    'isChatMember() must test selfEmail() against the room\'s members array'
);
assert(
    /function\s+chatRoom\(chatId\)/.test(rules),
    'the chatRoom() accessor is required — resource.data is the SUBDOC on a nested path, never the room'
);
// The room doc itself.
// The room doc itself. Read access is MEMBERSHIP, not role. The rule also
// restates that same membership test through `resource` so the conversation
// LIST QUERY can be authorised (asserted in section 12) — the get()-based
// check alone cannot be proven for a query.
const roomRead = (block.match(/match \/chats\/\{chatId\}[\s\S]*?allow read:[\s\S]*?;/) || [''])[0];
assert(
    /allow read: if canReadChat\(chatId\)/.test(roomRead),
    'a room must be readable by its MEMBERS (canReadChat), not by role alone'
);
// Every subcollection must be membership-scoped, so a non-member cannot
// read messages, receipts, presence or reactions.
//
// ⚠️ `profiles` is the ONE deliberate exception: it doubles as the people
// directory for the conversation list, which has to be readable BEFORE any
// room exists (otherwise nobody could ever start a first conversation). It
// therefore stays on the role gate, and it holds only presentation data —
// a display name, a job title and a role. It cannot expose a conversation,
// because no message or room data lives there.
['messages', 'presence', 'readReceipts', 'reactions'].forEach((sub) => {
    const at = block.indexOf('match /' + sub + '/');
    assert(at > -1, 'the chats block must contain the ' + sub + ' subcollection');
    // The sub-block runs from THIS match to the NEXT one after it. Searching
    // from `at` would find the current match again and yield an empty body.
    const nextAt = block.indexOf('match /', at + 1);
    const body = nextAt > -1 ? block.slice(at, nextAt) : block.slice(at);
    assert(
        /isChatMember\(chatId\)|canReadChat\(chatId\)/.test(body),
        `${sub} must be scoped to room membership (isChatMember/canReadChat) — a role-only ` +
        'check would expose another person\'s private conversation'
    );
});
// ...and profiles must NOT be membership-scoped, or the list would be empty.
const profilesAt = block.indexOf('match /profiles/');
const profilesNext = block.indexOf('match /', profilesAt + 1);
const profilesSlice = profilesNext > -1 ? block.slice(profilesAt, profilesNext) : block.slice(profilesAt);
assert(
    /allow read: if isHrOrSuperAdmin\(\);/.test(profilesSlice),
    'profiles must stay on the role gate — it is the people directory, and must be readable ' +
    'before any conversation room exists, or no first conversation could ever be started'
);
// A message create is the strongest case: it needs membership AND self.
const msgsAt = block.indexOf('match /messages/');
const msgsNext = block.indexOf('match /', msgsAt + 1);
const msgsBody = msgsNext > -1 ? block.slice(msgsAt, msgsNext) : block.slice(msgsAt);
const msgCreate = (msgsBody.match(/allow create:[\s\S]*?;/g) || [])[0];
assert(
    /isChatMember\(chatId\)/.test(msgCreate || ''),
    'a message create must require room membership'
);
assert(
    /senderEmail\s*==\s*selfEmail\(\)/.test(msgCreate || ''),
    'a message create must still require senderEmail == selfEmail()'
);
// The ALL HR GROUP chat lives in the legacy room, which has no member list —
// so it needs a message write of its own, gated on the SAME "is an HR or a
// superadmin" test. Without it, deploying these rules would leave the pinned
// group row in place while refusing every message in it.
assert(
    /allow create: if isLegacyArchive\(chatId\)[\s\S]{0,120}?request\.resource\.data\.senderEmail == selfEmail\(\);/.test(msgsBody),
    'the messages block must allow a create in the legacy (group) room, gated on isLegacyArchive + ' +
    'senderEmail == selfEmail() — otherwise a deploy silently breaks the All HR group chat'
);
assert(
    /match \/messages\/\{messageId\}[\s\S]*?allow update, delete: if false;/.test(msgsBody),
    'messages stay immutable in the group room too — only a create is ever allowed there'
);

// 7. Every chats read/write must go through the HR/superadmin gate.
assert(
    /function\s+isHrOrSuperAdmin\(\)/.test(rules),
    'isHrOrSuperAdmin() helper is missing from firestore.rules'
);
const helper = rules.match(/function\s+isHrOrSuperAdmin\(\)\s*\{[\s\S]*?\n\s*\}/);
assert(helper, 'could not read the isHrOrSuperAdmin() helper body');
assert(
    /role\s+in\s*\[\s*'hr'\s*,\s*'superadmin'\s*\]/.test(helper[0]),
    "isHrOrSuperAdmin() must be an allowlist of exactly ['hr', 'superadmin']"
);
assert(!/operator/.test(helper[0]), 'isHrOrSuperAdmin() must never include the operator role');
assert(
    !/'owner'/.test(helper[0]),
    'isHrOrSuperAdmin() must never include the owner role — owners share the dashboard but not the chat'
);

// 7b. The RULES and CLIENT allowlists MUST agree, or a user sees the chat
//     button and is denied the moment they send.
const clientSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
const clientList = clientSrc.match(/CHAT_ALLOWED_ROLES\s*=\s*\[([^\]]+)\]/);
assert(clientList, 'could not find CHAT_ALLOWED_ROLES in js/chat.js');
const clean = (s) => s.split(',').map((r) => r.trim().replace(/^['"]|['"]$/g, '')).sort().join(',');
const clientRoles = clean(clientList[1]);
const rulesRoles = clean(helper[0].match(/role\s+in\s*\[([^\]]+)\]/)[1]);
assert.strictEqual(
    clientRoles,
    rulesRoles,
    'chat.js CHAT_ALLOWED_ROLES and firestore.rules isHrOrSuperAdmin() must list the ' +
    `SAME roles, or a user can see chat but be denied on send (client=${clientRoles}, ` +
    `rules=${rulesRoles})`
);

// 7c. No rule may still reference the removed isOwnerOrSuperAdmin() helper,
//     which would silently deny every chat read/write.
assert(
    !/isOwnerOrSuperAdmin/.test(rules),
    'firestore.rules still references isOwnerOrSuperAdmin(); chat is now gated by isHrOrSuperAdmin()'
);

// 7d. Messages must stay IMMUTABLE. The read receipts deliberately live in
//     their own subcollection precisely so this never has to be relaxed —
//     opening it would let anyone rewrite the text of a sent message.
const messagesBlock = block.slice(block.indexOf('match /messages/'));
assert(
    /match \/messages\/\{messageId\}[\s\S]*?allow update, delete: if false;/.test(messagesBlock),
    'messages must stay immutable (allow update, delete: if false) — read receipts ' +
    'live in chats/{id}/readReceipts precisely so sent text can never be edited'
);

// 7e. Receipts: readable by the chat, but writable ONLY by their owner.
//     Without the owner check anyone could mark everybody else's messages read.
const receiptsBlock = block.slice(block.indexOf('match /readReceipts/'));
assert(
    /match \/readReceipts\/\{userKey\}[\s\S]*?allow read: if canReadChat\(chatId\);/.test(receiptsBlock),
    'readReceipts must be readable by the room so ticks can turn blue'
);
assert(
    /allow create: if isChatMember\(chatId\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\);/.test(receiptsBlock),
    'a receipt create must require room membership AND email == selfEmail(), or anyone could forge one'
);
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(receiptsBlock),
    'a receipt update must be restricted to its owner (resource.data.email)'
);
assert(
    /allow update, delete: if true;/.test(receiptsBlock) === false,
    'readReceipts must never be world-writable'
);

// 7f. Profiles: readable by the thread, writable ONLY by their owner, and
//     restricted to presentation fields. A profile must never be able to
//     smuggle in a role/permission field, and one person must never be able
//     to rewrite another person's identity in the thread.
const profilesBlock = block.slice(block.indexOf('match /profiles/'));
assert(
    /match \/profiles\/\{userKey\}[\s\S]*?allow read: if isHrOrSuperAdmin\(\);/.test(profilesBlock),
    'profiles must be readable by the chat team — this subcollection is also the people ' +
    'directory, and it must resolve names before any conversation exists'
);
assert(
    /allow create: if isHrOrSuperAdmin\(\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\);/.test(profilesBlock),
    'a profile create must require email == selfEmail(), or anyone could forge a colleague'
);
assert(
    /allow update: if isHrOrSuperAdmin\(\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(profilesBlock),
    'a profile update must be restricted to its owner (resource.data.email)'
);
assert(
    /hasOnly\(\['email', 'role', 'displayName', 'title'\]\)/.test(profilesBlock),
    'a profile must be limited to the four already-deployed presentation fields — an extra ' +
    'key (e.g. an `active` flag) would be denied by hasOnly() and the write would fail'
);
assert(
    /allow (create|update)[^:]*:\s*if true/.test(profilesBlock) === false,
    'profiles must never be world-writable'
);

// 7g. Reactions: readable by the thread, writable only as yourself, and
//     carrying ONLY presentation fields. A reaction is one doc per
//     {messageId, person}, so "one reaction each" is structural; switching
//     emoji is an update of the `emoji` field alone, with `messageId` and
//     `email` frozen so a reaction can never be repointed.
const reactionsBlock = block.slice(block.indexOf('match /reactions/'));
assert(
    /match \/reactions\/\{reactionId\}[\s\S]*?allow read: if canReadChat\(chatId\);/.test(reactionsBlock),
    'reactions must be readable by the room so counts resolve'
);
assert(
    /allow create: if isChatMember\(chatId\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\)/.test(reactionsBlock),
    'a reaction create must require room membership AND email == selfEmail(), or anyone could react as a colleague'
);
assert(
    /allow delete: if isChatMember\(chatId\)\s*\r?\n\s*&& resource\.data\.email == selfEmail\(\);/.test(reactionsBlock),
    'a reaction delete must be restricted to its owner (resource.data.email)'
);
assert(
    /hasOnly\(\['messageId', 'emoji', 'email'\]\)/.test(reactionsBlock),
    'a reaction must carry only messageId/emoji/email — it must never be able to ' +
    'smuggle in a field something else might trust'
);
// Switching emoji is the ONLY permitted update: messageId and email are
// frozen, so a reaction cannot be moved to another message or handed to
// another person after the fact.
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?affectedKeys\(\)\.hasOnly\(\['emoji'\]\)/.test(reactionsBlock),
    'a reaction update must be restricted to the `emoji` field — messageId and email must be frozen'
);
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(reactionsBlock),
    'a reaction update must be restricted to its owner (resource.data.email)'
);
assert(
    /allow update: if true;/.test(reactionsBlock) === false,
    'reactions must never be world-writable'
);

// 7h. The legacy shared room must be READABLE (its mixed history is the
//     only copy of the old messages) but never WRITABLE — that is what stops
//     it quietly becoming a second shared room and leaking across people.
assert(
    /function\s+isLegacyArchive\(chatId\)/.test(rules),
    'isLegacyArchive() helper is missing from firestore.rules'
);
const legacyRoomCreate = (block.match(/allow create:[\s\S]*?;/g) || [])[0];
assert(
    /!isLegacyArchive\(chatId\)/.test(legacyRoomCreate || ''),
    'the legacy archive room must be excluded from create, or it can be re-created as a shared room'
);
const roomUpdateRule = (block.match(/allow update:[\s\S]*?hasOnly\([^)]*\);/g) || [])[0];
assert(
    /!isLegacyArchive\(chatId\)/.test(roomUpdateRule || ''),
    'the legacy archive room must be excluded from update — it is read-only'
);
assert(
    /canReadChat\(chatId\)/.test(rules.match(/function\s+canReadChat\(chatId\)[\s\S]*?\n\s*\}/)[0]),
    'canReadChat() must combine membership with the legacy archive'
);

// 7i. `members` must be FROZEN on update. Otherwise either participant could
//     add a third person to a 1:1 thread (or drop themselves) and take over
//     its history — the one field that defines who may read it.
const roomAffected = (roomUpdateRule || '').match(/hasOnly\(([^)]*)\)/);
assert(roomAffected, 'the room update rule must constrain the writable fields');
assert(
    roomAffected[1].indexOf("'members'") === -1,
    '`members` must NOT be updatable — it defines who can read the room, so freezing it ' +
    'is what stops a participant adding a third person to a 1:1 conversation'
);

// 7j. The people directory is the `profiles` subcollection of the legacy
//     room (asserted as readable above). It must stay owner-writable and
//     presentation-only, and must never become world-readable — it is a
//     list of internal staff. The CLIENT-side half of this (reusing the
//     deployed path rather than a new collection) is asserted in section 9.
const dirBlock = rules.slice(rules.indexOf('match /profiles/'));
assert(
    /hasOnly\(\['email', 'role', 'displayName', 'title'\]\)/.test(dirBlock),
    'a directory entry must be limited to presentation fields — no permissions, no account data'
);
assert(
    /request\.resource\.data\.email == selfEmail\(\)/.test(dirBlock),
    'a directory entry must be writable only by its owner'
);
assert(
    /allow read: if true;/.test(dirBlock) === false,
    'the directory must never be publicly readable — it is a list of internal staff'
);

console.log('✅ Chat rules tests passed (create/update split; HR+superadmin only; membership-scoped ' +
    'reads and writes; the room written BEFORE the message; legacy archive read-only; members frozen; ' +
    'messages immutable; receipts ' +
    'owner-only; directory reuses the DEPLOYED profiles path; reactions owner-only + immutable; ' +
    'both sides of the roster read from `users` (superadmin whole, HR role-scoped; the HR half needs a deploy); ' +
    'a denied list query rebuilt from per-room document reads; ' +
    'the room read rule also provable for the list query; ' +
    'the group chat is role-gated so new accounts join automatically; the modal has a fixed height; ' +
    'client/rules allowlists agree).');

// ---------------------------------------------------------------
// 8. NO COMPOSITE INDEX — THE APP MUST STAY ON THE FREE (SPARK) PLAN.
//
//    The conversation list is `chats` where members array-contains <me>.
//    Firestore CANNOT serve an array-contains filter combined with an
//    orderBy on a DIFFERENT field from its automatic single-field
//    indexes — that needs a composite index, and COMPOSITE INDEXES ARE A
//    PAID (BLAZE) PLAN FEATURE. On the free plan the query is rejected
//    with FAILED_PRECONDITION and the sidebar is permanently empty.
//
//    So the client must NOT orderBy, and no indexes file may be declared.
//    Sorting happens client-side instead.
// ---------------------------------------------------------------
assert(
    !fs.existsSync(path.join(ROOT, 'firestore.indexes.json')),
    'firestore.indexes.json must not exist — composite indexes are a PAID (Blaze) plan ' +
    'feature and this app runs on the free plan'
);
const fbConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
assert.strictEqual(
    fbConfig.firestore && fbConfig.firestore.indexes,
    undefined,
    'firebase.json must not declare an indexes file — the conversation list must run on ' +
    'automatic single-field indexes only, so the free plan keeps working'
);
assert.strictEqual(
    fbConfig.firestore && fbConfig.firestore.rules,
    'firestore.rules',
    'firebase.json must still declare the rules file'
);
assert(
    !/\.where\('members',\s*'array-contains',\s*currentUserEmail\)[\s\S]{0,200}?\.orderBy\(/.test(clientSrc),
    'the conversation-list query must NOT chain orderBy after the array-contains filter — ' +
    'that combination requires a paid composite index and breaks the sidebar on the free plan'
);

// 9. The client must send `members` as a LIST of exactly the two participants
//    — that array is the authorisation, so writing 1 or 3 entries breaks it.
//
//    ⚠️ The room doc must also write ONLY the keys the ALREADY-DEPLOYED
//    rules allow. An unknown key denies the room write, and since the first
//    message of a new conversation depends on that room existing, an extra
//    key means that conversation can never be started at all. Unread is
//    therefore localStorage, not a room field.
assert(
    /where\('members',\s*'array-contains',\s*currentUserEmail\)/.test(clientSrc),
    'chat.js must query the conversation list by `members array-contains`'
);
assert(
    /members: isGroupRoom\(\) \? everyoneKnownForGroup\(\) : \[me, them\],/.test(clientSrc),
    'a new 1:1 room must record exactly the two participants in `members` — that array is what the ' +
    'rules authorise. The group room is the single exception: it is gated on the ROLE, so its list is ' +
    'only a fallback for the case where it has to be created at all (see everyoneKnownForGroup).'
);
assert(
    !/FieldValue\.increment/.test(clientSrc),
    'no increment() on the room doc — an unreadCount field would need a rules deploy before ' +
    'messages could save at all, and unread is tracked in localStorage instead'
);

// The room payload must be defined ONCE (`const roomSummary = { ... }`) and
// contain exactly the keys the deployed rules allowlist. It is written TWICE
// — once on its own, to make the room EXIST, and once in the batch that
// carries the message — which is exactly why it is not an inline literal at
// each call site: two copies would drift, and a drifted key is a denied
// write, not a warning.
const roomSummaryBlock = (clientSrc.match(/\broomSummary\s*=\s*\{([\s\S]*?)\n\s*\};/) || [''])[1] || '';
assert(roomSummaryBlock, 'chat.js must define the room payload once (`roomSummary = { ... }`)');
assert.strictEqual(
    (clientSrc.match(/\broomSummary\s*=\s*\{/g) || []).length,
    1,
    'the room payload must be defined in exactly ONE place — the standalone room write and the message ' +
    'batch both use it, and two copies would drift (a drifted key is a denied write, not a warning)'
);
['type', 'members', 'lastMessage', 'lastMessageAt', 'lastSenderEmail'].forEach((key) => {
    assert(
        roomSummaryBlock.indexOf(key + ':') > -1,
        `the room payload must include \`${key}\` — the deployed rules allowlist it`
    );
});
const roomKeys = (roomSummaryBlock.match(/^\s+([a-zA-Z]+):/gm) || []).map((m) => m.trim().replace(':', ''));
const allowedRoomKeys = ['type', 'title', 'lastMessage', 'lastMessageAt', 'lastSenderEmail', 'members'];
const extraKeys = roomKeys.filter((k) => allowedRoomKeys.indexOf(k) === -1);
assert.strictEqual(
    extraKeys.length,
    0,
    'the room payload must contain ONLY keys the already-deployed rules allow (' +
    `found unexpected: ${extraKeys.join(', ')}). An unknown key denies the room write, and the ` +
    'first message of a new conversation cannot be sent without that room.'
);
assert.strictEqual(
    new Set(roomKeys).size,
    roomKeys.length,
    'the room payload must not repeat a key (' + roomKeys.join(', ') + ')'
);

// ⚠️ THE ROOM MUST BE COMMITTED *BEFORE* THE MESSAGE. Every rule on a
// subcollection resolves membership by READING THE ROOM
// (`isChatMember(chatId)` = `get(chats/{chatId}).data.members`), so a message
// written in the SAME batch as the room it belongs to is evaluated while that
// room still does not exist: the get() finds nothing and the write is DENIED.
// That is the "Chat cannot read or write this conversation" failure on the
// first message to a new contact — and it is invisible to every other test in
// this suite, so the ORDER is asserted here.
const preRoomWrite = clientSrc.indexOf('await roomRef().set(roomSummary');
// The message write is its own function now (writeMessageBatch), so the
// ordering that matters is: the standalone room write, THEN that call.
const messageWrite = clientSrc.search(/await writeMessageBatch\([\s\S]{0,240}?messageWritesMinimal,[\s\S]{0,120}?isGroupRoom\(\)/);
assert(
    preRoomWrite > -1,
    'the room must be written by its OWN awaited call — await roomRef().set(roomSummary, ...) — ' +
    'or a first message can never be sent'
);
assert(
    preRoomWrite > -1 && messageWrite > -1 && preRoomWrite < messageWrite,
    'the room write must come BEFORE the write that carries the message: the membership rule ' +
    'reads the room, so a message sent in the same batch as its room is denied'
);
assert(
    /if\s*\(!roomIsStarted\)\s*\{[\s\S]{0,240}?await roomRef\(\)\.set\(roomSummary/.test(clientSrc),
    'the standalone room write must be conditional on the conversation not being started yet, so an ' +
    'existing conversation keeps its message + summary in ONE atomic batch'
);
assert(
    /const\s+roomIsStarted\s*=\s*Boolean\(conversationSummaries\[activeRoomId\]\)/.test(clientSrc),
    'roomIsStarted must come from the conversation list — the only place that knows whether the ' +
    'room document exists on the server'
);
assert(
    /batch\.set\(roomRef\(\), roomSummary, \{ merge: true \}\)/.test(clientSrc),
    'the room summary must STILL ride in the batch with the message, so an existing conversation ' +
    'updates its preview atomically'
);

// The failure must name WHICH write was refused. "cannot create the
// conversation" and "cannot write into it" are different bugs with different
// fixes, and reporting the second one when the first one failed sends people
// looking in the wrong place.
assert(
    /stage\s*=\s*'message'/.test(clientSrc) && /stage === 'room'/.test(clientSrc),
    'sendMessage must track which write failed (room vs message) and report that one'
);
assert(
    /roomId === LEGACY_ROOM_ID/.test(clientSrc) && /isLegacyArchive/.test(rules),
    'the legacy shared room must be handled read-only on both sides'
);
// The people directory reuses the DEPLOYED profiles subcollection rather
// than a new collection that would need its own rule to be readable.
assert(
    /doc\(LEGACY_ROOM_ID\)\.collection\('profiles'\)/.test(clientSrc),
    'the people directory must read the legacy room\'s profiles subcollection, which the ' +
    'already-deployed rules already permit — a NEW collection would be denied until deployed'
);
assert(
    !/match \/chatProfiles\//.test(rules),
    'no chatProfiles collection: it would need a new rule before the conversation list could ' +
    'read it, and this app must work with nothing deployed'
);
assert(
    !/'active'/.test(clientSrc.slice(clientSrc.indexOf('function saveMyDirectoryEntry'), clientSrc.indexOf('function startDirectoryListener'))),
    'the directory write must not include an `active` flag — the deployed profile allowlist ' +
    'is (email, role, displayName, title) and an extra key is denied'
);

// ---------------------------------------------------------------
// 10. BOTH SIDES MUST SEE EVERY ACCOUNT THEY MAY MESSAGE — NOT ONLY THE
//     PEOPLE WHO HAVE PUBLISHED A PROFILE.
//
//     `chats/owner-superadmin/profiles` is the people directory, but it is
//     SELF-PUBLISHED: a person appears in it only after they have opened the
//     chat and saved a profile, and the `role` in it is whatever was current
//     at that moment. A brand-new HR is therefore invisible to a superadmin
//     ("the superadmin cannot see all the HR accounts"), and an entry
//     published with an empty or stale role is filtered out by isStartable().
//     The other direction is the same story: a SUPERADMIN who has never
//     opened the chat has no profile entry either, so an HR could not find
//     them — which is "an HR cannot message the new superadmin".
//
//     The authoritative role is `users/{email}.role` — the field the rules
//     and the dashboard both authorise on — so BOTH sides read `users`: a
//     superadmin WHOLE (`allow read: if isSuperAdmin() || isSelf()`, the
//     statement script.js already exercises through loadSuperadminUsers(), so
//     NO rules deploy needed for that direction), and an HR only the
//     superadmin docs, through the SECOND read statement the rules carry for
//     it — which DOES need `firebase deploy --only firestore:rules`, and
//     until that happens degrades to the directory instead of breaking chat.
// ---------------------------------------------------------------
assert(
    /match \/users\/\{userId\}[\s\S]*?allow read: if isSuperAdmin\(\) \|\| isSelf\(\);/.test(rules),
    'the account roster only works while the deployed users rule lets a superadmin read every user doc'
);
// ...and the SECOND half of that rule: an HR must be able to discover the
// SUPERADMIN accounts, which is exactly what the self-published directory
// cannot do on its own (a brand-new superadmin has no profile entry).
const usersBlock = rules.slice(rules.indexOf('match /users/'));
assert(
    /allow read: if isHrOrSuperAdmin\(\)\s*&&\s*resource\.data\.role == 'superadmin';/.test(usersBlock),
    'firestore.rules must let an HR read the SUPERADMIN accounts — without it "an HR can message every ' +
    'superadmin" is impossible — and it must stay scoped to role == superadmin so owner/operator ' +
    'accounts, their statuses and their permissions stay unreadable'
);
assert.strictEqual(
    (usersBlock.match(/allow read:/g) || []).length,
    2,
    'the two users read rules must be SEPARATE allow statements (they OR together): a superadmin keeps the ' +
    'whole-collection read the dashboard already relies on, an HR gets only the role-scoped slice — one ' +
    'combined statement would have to satisfy both at once'
);
const rosterFn = (clientSrc.match(/function\s+loadHrRoster\(\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(rosterFn, 'chat.js must define loadHrRoster() — the authoritative roster behind BOTH sides of the list');
// LIVE, not one-shot: a `.get()` only ever answered for the device that asked,
// at mount, so an account approved on somebody else's machine stayed invisible
// until a reload. The snapshot is what makes "a new registrant appears" true on
// every screen.
assert(
    /rosterUnsub = source\.onSnapshot\(apply, failed\);/.test(rosterFn),
    'the roster must be a LIVE onSnapshot listener — a one-shot .get() would show new accounts only on ' +
    'the device that happened to reload'
);
// The two sides read differently because the rules do.
assert(
    /if \(currentRole !== 'superadmin'\) \{\s*source = source\.where\('role', '==', 'superadmin'\);/.test(rosterFn),
    "the HR's read must carry `where('role','==','superadmin')` — that is the filter the users read rule " +
    'is provable from (an unfiltered HR read of `users` is denied), and it must live in the HR-only ' +
    'branch so a superadmin keeps the whole-collection read (no index, and it survives a role stored ' +
    "as 'HR ')"
);
assert(
    /if \(!canChat\(currentRole\)\) return;/.test(rosterFn),
    'only the two chat roles may read the roster: an owner or an operator has no chat at all, so asking ' +
    'would be a refused read that proves nothing'
);
assert(
    /const wanted = currentRole === 'superadmin' \? 'hr' : 'superadmin';/.test(rosterFn) &&
        /normalizeRole\(data\.role\) !== wanted/.test(rosterFn),
    'the roster must keep ONLY the opposite role — the one isStartable() would accept — so the pairing ' +
    'rule and the roster can never disagree about who may be messaged'
);
assert(
    /console\.warn\('\[Chat\] HR roster unavailable:', error && error\.message\)/.test(rosterFn) &&
        /catch \(error\)/.test(rosterFn),
    'a failed/denied roster read must be caught and reported — it is a convenience, not a permission, and ' +
    'it must never take the chat down (an HR on a ruleset without the clause simply falls back to the ' +
    'directory)'
);
// ONE listener at a time: this runs at mount AND from refreshDirectory().
assert(
    /if \(rosterUnsub\) \{[\s\S]{0,160}?rosterUnsub\(\);[\s\S]{0,80}?rosterUnsub = null;/.test(rosterFn),
    'the previous roster listener must be released before the next subscribe, or a permissions refresh ' +
    'would leave two listeners writing the same state'
);
assert(
    /stopConversationListListener\(\);[\s\S]{0,300}?if \(rosterUnsub\) \{[\s\S]{0,160}?rosterUnsub\(\);/.test(clientSrc),
    'teardown must release the roster listener too — it is live now, and a stale one would keep rebuilding ' +
    'the list for whoever signs in next'
);
// ...and it must be WIRED IN: at mount, and again whenever a role changes.
assert.strictEqual(
    (clientSrc.match(/^\s+loadHrRoster\(\);/gm) || []).length,
    2,
    'loadHrRoster() must be called exactly twice: at mount, and from ChatService.refreshDirectory(), which ' +
    'script.js calls after an account is approved or re-roled'
);
const refreshFn = (clientSrc.match(/ChatService\.refreshDirectory = function \(\) \{[\s\S]*?\n\s{4}\};/) || [''])[0];
assert(
    /loadHrRoster\(\)/.test(refreshFn),
    'refreshDirectory() must re-read the roster, or a newly approved HR stays invisible until a page reload'
);

// The two sources must be UNIONED, not swapped: a person only the roster
// knows about must be offered, and a directory entry whose stored role is
// stale or empty must not hide an HR the roster knows about.
assert(
    /function\s+personProfileFor\(email\)/.test(clientSrc),
    'personProfileFor() is the one place the directory and the roster are merged'
);
const mergeFn = (clientSrc.match(/function\s+personProfileFor\(email\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(mergeFn, 'could not read the personProfileFor() body');
assert(
    /Object\.assign\(\{\},\s*entry,\s*\{\s*email:[^}]*role:\s*roster\.role/.test(mergeFn),
    'the ROSTER role must override a stale directory role — `users` is what the rules authorise on, so a ' +
    "profile published with `role: ''` must not hide an HR"
);
assert(
    /const entry = directory\[key\]/.test(mergeFn) && /const roster = rosterEntries\[key\]/.test(mergeFn),
    'the merge must consult BOTH the directory and the roster'
);
assert(
    // ⚠️ The ＋ "new conversation" BUTTON and its floating picker are GONE. The
    // conversation list already offers every person a thread may be started
    // with as a "tap to start" row, so the picker was a SECOND control over the
    // same set of people — a duplicate entry point into one list, and the one
    // most people never found. Guard the removal, or a quiet edit can put two
    // controls back over the same list.
    !/chatNewBtn|chatNewMenu|newMenu|chat-newmenu|chat-icon-btn/.test(clientSrc),
    'js/chat.js must not resurrect the ＋ button or its picker — the list rows are how a conversation is started'
);
assert(
    /startableEmails\(\)\.forEach\(/.test(clientSrc),
    'the conversation list must list the UNION of the directory and the roster — it is the ONLY entry point now'
);
assert(
    /function\s+startableEmails\(\)\s*\{[\s\S]*?Object\.keys\(directory\)[\s\S]*?Object\.keys\(rosterEntries\)/.test(clientSrc),
    'startableEmails() must merge the directory keys with the roster keys'
);
assert(
    /directory = \{\};\s*\n\s*rosterEntries = \{\};/.test(clientSrc),
    'a teardown must clear BOTH the directory and the roster, or the next account would inherit them'
);

// ---------------------------------------------------------------
// 11. THE CONVERSATION LIST MUST SURVIVE A DENIED LIST QUERY.
//
//     The list is normally ONE query (`chats where members array-contains
//     me`), which needs no index and no paid plan. But a query is authorised
//     as a SINGLE rules evaluation over the whole collection, and the
//     membership rule resolves every room with exists()/get(), which cannot
//     be proven that way — so the deployed ruleset can refuse the query even
//     though every room DOCUMENT is individually readable.
//
//     That is not cosmetic. selectConversation() opens a thread only when the
//     room is in the summaries, so an empty list means no conversation ever
//     shows its history and no unread badge ever lights up. The client must
//     therefore rebuild the list from one document listener per room.
// ---------------------------------------------------------------
assert(
    /conversationListDenied = true;/.test(clientSrc),
    'a permission error on the list query must be recorded, or nothing knows to fall back'
);
assert(
    /conversationListDenied = true;[\s\S]{0,900}?startPerRoomConversationListeners\(\);/.test(clientSrc),
    'the permission-error branch of the list query must start the per-room fallback: a denied query ' +
    'otherwise empties the sidebar AND makes every conversation open blank, because ' +
    'selectConversation() only subscribes to a thread the summaries know about'
);
const perRoomFn = (clientSrc.match(/function startPerRoomConversationListeners\(\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(perRoomFn, 'chat.js must define startPerRoomConversationListeners() — the denied-query fallback');
assert(
    /if \(!conversationListDenied\) return;/.test(perRoomFn),
    'the fallback must only run when the query was actually denied — otherwise it would multiply the ' +
    'listeners for nothing on a working ruleset'
);
assert(
    /startableEmails\(\)\.forEach/.test(perRoomFn) && /myRoomIdWith\(email\)/.test(perRoomFn),
    'the fallback must derive one room per KNOWN person (myRoomIdWith), because the people it can enumerate ' +
    'are the directory plus the account roster — not the collection'
);
assert(
    /roomIds\[LEGACY_ROOM_ID\] = true;/.test(perRoomFn),
    'the legacy archive must be watched by the fallback too — isLegacyArchive() makes it readable by ' +
    'every HR and superadmin, so the archive row must survive a denied list query'
);
assert(
    perRoomFn.indexOf("collection('chats')") === -1 && perRoomFn.indexOf('.where(') === -1,
    'the fallback must never issue another collection QUERY — the query is exactly what gets denied'
);
const subRoomFn = (clientSrc.match(/function subscribeRoomForList\(roomId\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(subRoomFn, 'could not read the subscribeRoomForList() body');
assert(
    /collection\('chats'\)\.doc\(roomId\)\.onSnapshot/.test(subRoomFn),
    'each room must be watched as a DOCUMENT — that read is the one the membership rule can allow'
);
assert(
    /isPermissionError\(error\)/.test(subRoomFn) && /conversationRoomsDenied\[roomId\] = true;/.test(subRoomFn),
    'a room that does not exist yet is DENIED (isChatMember() starts with exists()), which is the normal ' +
    'state for somebody never messaged — it must be remembered as missing, never reported as an error'
);
assert(
    /function scheduleDeniedRoomRetry\(\)/.test(clientSrc),
    'the denied rooms must be re-attempted, or a conversation started by the OTHER person would stay ' +
    'invisible in the sidebar until a page reload'
);
assert(
    /if \(timer && typeof timer\.unref === 'function'\) timer\.unref\(\);/.test(clientSrc),
    'the retry timer must be unref()ed where that API exists, or a pending 60s timer keeps the test ' +
    'process alive; browsers return a plain number and have no unref'
);
assert(
    /Object\.keys\(conversationRoomUnsubs\)\.forEach/.test(clientSrc) &&
    /clearTimeout\(deniedRoomRetryTimer\)/.test(clientSrc),
    'stopConversationListListener() must release the per-room listeners AND the retry timer, or a re-init ' +
    'leaves a second set of listeners writing the same summaries'
);
assert(
    /if \(roomId === activeRoomId && !messagesUnsub\)/.test(clientSrc),
    'a room document that reports AFTER the conversation was opened must attach the thread — otherwise a ' +
    'conversation with history opens blank until a page reload'
);
assert(
    /rememberRoom\(activeRoomId\);[\s\S]{0,120}?subscribeRoomForList\(activeRoomId\);/.test(clientSrc),
    'after the first message creates the room, it must be remembered AND its listener (re)attached, or ' +
    'the sidebar keeps calling a live conversation "tap to start" and never hears about later messages'
);
assert(
    /syncSummaryFromMessage\(activeRoomId, \{[\s\S]{0,40}?text: text,/.test(clientSrc),
    'a sent message must refresh the sidebar line locally — the deployed rules may refuse the room ' +
    'preview, which would otherwise freeze it on the server'
);
assert(
    /Object\.keys\(knownRooms\)\.forEach/.test(clientSrc),
    'the fallback must re-check every room this device has seen — with the query denied, a conversation ' +
    'whose other side left the directory and the roster would otherwise disappear with its history'
);
assert(
    /function loadKnownRooms\(\)/.test(clientSrc) && /loadKnownRooms\(\);/.test(clientSrc),
    'remembered rooms are per account, so they must be (re)loaded when init() resolves the signed-in user'
);
assert(
    /KNOWN_ROOMS_MAX = 200/.test(clientSrc) && /forgetRoom\(roomId\);/.test(clientSrc),
    'the remembered list must be capped and must drop a room that can never be found again, or it would ' +
    'grow without bound and keep re-reading rooms that are permanently gone'
);
assert(
    /if \(peopleSettled && peer && startableEmails\(\)\.indexOf\(peer\) === -1\)/.test(clientSrc),
    'a room is only forgotten once the people sources have settled (peopleSettled) AND its peer is in ' +
    'neither source — forgetting on an early refusal would lose a real conversation'
);
assert(
    /conversationRoomsDenied\[roomId\] = true;/.test(clientSrc) &&
    /forgetRoom\(roomId\);[\s\S]{0,120}?\} else \{/.test(clientSrc),
    'a forgotten room must also leave the RETRY set, or it would be re-read every minute for the rest ' +
    'of the session — which is the leak the forget rule exists to prevent'
);

// ---------------------------------------------------------------
// 12. THE ROOM READ RULE MUST ALSO BE PROVABLE FOR THE LIST QUERY.
//
//     chat.js lists conversations with `chats where members array-contains
//     <me>`. A query is authorised as ONE rules evaluation over the whole
//     collection, so a rule that resolves every room with exists()/get()
//     cannot be proven for it and the entire query is denied — which empties
//     the sidebar AND stops every conversation from opening its history
//     (selectConversation() only subscribes to a room the list knows about).
//
//     So the read rule restates the SAME membership test through `resource`,
//     which Firestore can prove from the query's own filter. It must stay
//     exactly that: role-gated, membership-scoped, and never a blanket read.
// ---------------------------------------------------------------
assert(
    /allow read: if canReadChat\(chatId\)[\s\S]{0,200}?\|\| \(isHrOrSuperAdmin\(\) && 'members' in resource\.data[\s\S]{0,200}?selfEmail\(\) in resource\.data\.members\)/.test(block),
    "the room read rule must restate membership through resource.data ('members' in resource.data " +
    "&& selfEmail() in resource.data.members), or the conversation-list query is denied while every " +
    'room document is individually readable'
);
assert(
    /'members' in resource\.data/.test(block),
    "the restated clause must be guarded by 'members' in resource.data — a room with no member list " +
    '(the legacy archive) would otherwise raise an error inside the rules engine, which evaluates the ' +
    'whole rule to DENIED'
);
assert(
    /allow read: if canReadChat\(chatId\)\s*\|\|/.test(block),
    'the get()-based membership check must STAY: the query clause is an addition, not a replacement, and a ' +
    'direct read of a room is still authorised by the same test'
);
assert(
    /allow read: if (true|isSignedIn\(\)|isHrOrSuperAdmin\(\)|isSuperAdmin\(\))\s*;/.test(roomRead) === false,
    'the ROOM read must never be role-only or unconditional — that would expose every HR\'s private thread ' +
    'to every other HR. (The profiles subcollection IS role-readable on purpose: it is the people ' +
    'directory, asserted separately in 7f, and it carries presentation data only.)'
);
assert(
    /where\('members', 'array-contains', currentUserEmail\)/.test(clientSrc) &&
    /isChatMember\(chatId\)|canReadChat\(chatId\)/.test(block),
    'the client query and the membership-scoped rules must both stay: the `array-contains` filter is what ' +
    'authorises the query, and the rules are what authorise every subcollection read inside a room'
);

// ---------------------------------------------------------------
// 13. THE MESSAGE WRITE MUST SURVIVE A DEPLOYED RULE THAT IS OLDER
//     THAN THIS CLIENT, AND MUST NEVER LOCK THE USER OUT.
//
//     The room write can succeed while the MESSAGE write is refused — a room
//     and a message in one atomic batch fail TOGETHER, so one passing and one
//     failing means the refusal is specific to the message document. In the
//     field that is almost always a deployed `hasOnly()` allowlist from before
//     `mentions`/`replyTo` existed, or an address compared in the wrong case.
// ---------------------------------------------------------------
assert(
    /const nextEmail = String\(user\.email\)\.toLowerCase\(\);/.test(clientSrc) &&
    /senderEmail: (me|currentUserEmail),/.test(clientSrc),
    'the message payload must carry the address the module already stores LOWERCASED (init() does ' +
    '`String(user.email).toLowerCase()`), because the create rule compares it against ' +
    '`request.auth.token.email.lower()` — the two must be in the same case'
);
const payloadFn = (clientSrc.match(/function writeMessageBatch\(text, me, roomSummary, minimal, withPreview\)\s*\{[\s\S]*?\r?\n    \}/) || [''])[0];
assert(payloadFn, 'chat.js must define writeMessageBatch() — the message + room-preview batch');
['text', 'senderEmail', 'senderName', 'senderRole', 'sentAt'].forEach((key) => {
    assert(
        new RegExp(key + ':').test(payloadFn),
        `the message payload must always include \`${key}\` — it is one of the five fields this app has ` +
        'always documented, so it is what an OLD deployed allowlist will accept'
    );
});
assert(
    /if \(!minimal\)\s*\{[\s\S]*?payload\.mentions = extractMentions\(text\);[\s\S]*?payload\.replyTo = replyingToId \|\| null;/.test(payloadFn),
    'the fields that did NOT exist in the old schema (mentions, replyTo) must be the ONLY ones the short ' +
    'payload drops — a field the rules have never heard of is a refused write'
);
assert(
    /stage === 'message' && isPermissionError\(error\)[\s\S]{0,80}?\) \{[\s\S]{0,1200}?if \(!messageWritesMinimal\)[\s\S]{0,1200}?if \(!groupRoom && roomPreviewInBatch\)[\s\S]{0,1200}?for \(const step of ladder\)[\s\S]{0,900}?writeMessageBatch\(text, me, roomSummary, step\.minimal, step\.preview\)/.test(clientSrc),
    'a message refused for permissions must be retried in THREE shapes — the short payload, and then the ' +
    'message with NO room preview in the batch — or a deployed rule that refuses the room update (while ' +
    'accepting the room create) keeps every message from being saved'
);
assert(
    /roomPreviewInBatch = false;/.test(clientSrc) &&
    /if \(!roomPreviewInBatch && !isGroupRoom\(\)\) writeRoomPreviewQuietly\(roomSummary\);/.test(clientSrc),
    'once the room preview is known to be refused inside a batch it must stay OUT of the batch, and the ' +
    'preview must still be attempted on its own (except in the group chat, whose row is pinned and needs ' +
    'none) — otherwise the sidebar would freeze forever'
);
assert(
    /function writeRoomPreviewQuietly\(roomSummary\)/.test(clientSrc) &&
    /done\.catch\(function \(\) \{ \/\* the thread is fine without it \*\/ \}\)/.test(clientSrc),
    'the standalone preview write must swallow its own failure: the message is already saved, and a stale ' +
    'sidebar line is not worth an error dialog'
);
assert(
    /messageWritesMinimal = true;/.test(clientSrc),
    'once the short payload is known to work, later messages must use it straight away instead of failing ' +
    'and retrying on every single send'
);
// NOTE: js/chat.js has CRLF line endings, so every `\n` in a multi-line
// pattern has to tolerate a preceding `\r`.
const sendFn = (clientSrc.match(/async function sendMessage\(\)\s*\{[\s\S]*?\r?\n    \}\r?\n/) || [''])[0];
const sendCatch = (sendFn.match(/\} catch \(error\) \{[\s\S]*?\r?\n\s{8}\} finally \{/) || [''])[0];
assert(sendCatch, 'could not read the catch block of sendMessage()');
assert(
    /disableChatWithReason/.test(sendCatch) === false,
    'a failed SEND must never grey the chat out: one refused write would lock the user out of reading ' +
    'their own history, with nothing they can do about it'
);
// The discovery is a cost, so it must be paid ONCE: remembered per account, so
// a reload does not re-run two refused writes and the same console warning.
assert(
    /function saveSendShape\(\)/.test(clientSrc) && /function loadSendShape\(\)/.test(clientSrc) &&
    /saveSendShape\(\);/.test(sendCatch),
    'the write shape the deployed rules accept must be REMEMBERED per account — otherwise every page ' +
    'load pays two refused writes and another console warning to rediscover it'
);
// ...and because the room-summary write is refused, the server-side `lastMessage`
// is frozen: the sidebar line has to come from the message stream instead.
assert(
    /function syncSummaryFromMessage\(roomId, msg\)/.test(clientSrc) &&
    /if \(current && Number\(current\.lastMessageAtMs \|\| 0\) >= at\) return;/.test(clientSrc),
    'the sidebar line must be derived from the newest message the device has seen, and an OLDER message ' +
    'must never overwrite a newer line — the deployed rules freeze the server-side room summary'
);
assert(
    /syncSummaryFromMessage\(activeRoomId, newest\);/.test(clientSrc) &&
    /syncSummaryFromMessage\(activeRoomId, \{[\s\S]{0,40}?text: text,/.test(clientSrc),
    'both directions must repaint the row: an incoming message (the message stream) and one just sent'
);

// ---------------------------------------------------------------
// 14. THE ALL HR GROUP CHAT.
//
//     `chats/owner-superadmin` is gated on the ROLE (`isLegacyArchive` =
//     `isHrOrSuperAdmin() && chatId == 'owner-superadmin'`), NOT on a members
//     array. That is what makes "a group chat that new accounts join
//     automatically" possible at all: a membership list can only ever hold the
//     people present when it was created, and the deployed rules refuse a room
//     UPDATE, so nobody could ever be added afterwards.
// ---------------------------------------------------------------
assert(
    /var GROUP_ROOM_NAME = 'All HR — group chat';/.test(clientSrc) &&
    /function isGroupRoom\(roomId\)/.test(clientSrc),
    'the group chat must be named for what it is, and isGroupRoom() must be the ONE place that ' +
    'recognises it — a feature scattered over `activeRoomId === LEGACY_ROOM_ID` checks drifts'
);
assert(
    /const group = conversationSummaries\[LEGACY_ROOM_ID\];\s*rows\.push\(\{[\s\S]{0,400}?name: GROUP_ROOM_NAME/.test(clientSrc),
    'the group row must be pushed UNCONDITIONALLY, straight after reading the (possibly absent) ' +
    'summary: a new account is in the conversation before any summary has arrived, so the row ' +
    'cannot depend on one'
);
assert(
    /if \(isGroupRoom\(\)\) \{[\s\S]{0,700}?setComposerEnabled\(true\);/.test(clientSrc),
    'the group chat must have a WORKING composer — it is a live channel, not an archive'
);
assert(
    /!activePeerEmail && !isGroupRoom\(\)/.test(clientSrc),
    'only the group chat may be opened with no peer: every other conversation is with one person'
);
assert(
    /function writeReceipt\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) return;/.test(clientSrc) &&
    /function publishPresence\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) return;/.test(clientSrc),
    'read receipts and typing presence are PER-ROOM membership writes: the rules would refuse them ' +
    'in a room with no member list, and a permanent console warning is worse than grey ticks'
);
assert(
    /function startTypingListener\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) \{[\s\S]{0,200}?els\.typingBar\.hidden = true;/.test(clientSrc),
    'the typing bar must be hidden (and never subscribed) in the group chat — nobody can publish there'
);
// The NAME in "X is typing…" has to be resolved the way every other name in
// the chat is resolved: the published directory/roster name first. It used to
// prefer `entry.name`, which publishPresence() wrote as the email's LOCAL
// PART, so a person whose row and messages said "Jiangnan Hotpot" was
// announced as "hotpotjiangnan is typing…" — one thread, two names for one
// person. Both halves (the write and the label) are guarded.
assert(
    /function publishPresence\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) return;[\s\S]*?name:\s*nameFor\(currentUserEmail\)/.test(clientSrc),
    'publishPresence() must publish the DIRECTORY name, not the email local part'
);
assert(
    /function typingNameFor\(entry\)[\s\S]{0,400}?personProfileFor\(key\)\.displayName/.test(clientSrc) &&
    /\)\.map\(typingNameFor\);/.test(clientSrc),
    'renderTypingIndicator() must resolve the typist through typingNameFor() — the directory name ' +
    'first, so the label matches the row, the header and the messages'
);
assert(
    /function toggleReaction\([\s\S]{0,700}?if \(isGroupRoom\(\)\) \{[\s\S]{0,300}?only available in 1:1/.test(clientSrc),
    'a reaction is a per-room membership write too: it must be refused in the client with a plain ' +
    'explanation, not by letting the rules reject it'
);
assert(
    /roomPreviewInBatch && !isGroupRoom\(\)/.test(clientSrc),
    'the group send must not attempt a room-preview write (the row is pinned and the update would be ' +
    'refused)'
);
// ⚠️ THE MESSAGE-SHAPE RUNG IS NOT 1:1-SPECIFIC. The payload written in the
// group room is the same one a 1:1 send writes, so a deployed `hasOnly()` that
// predates mentions/replyTo refuses a GROUP message exactly as it refuses a 1:1
// one — while the ladder was guarded with `&& !isGroupRoom()`, the first message
// on a fresh browser (which is very often the group one) was the one message in
// the app with no fallback at all. Only the ROOM-PREVIEW rung belongs to 1:1.
assert(
    /if \(stage === 'message' && isPermissionError\(error\)\) \{/.test(clientSrc) &&
    !/isPermissionError\(error\) && !isGroupRoom\(\)/.test(clientSrc) &&
    /const groupRoom = isGroupRoom\(\);/.test(clientSrc) &&
    /preview: !groupRoom && roomPreviewInBatch,/.test(clientSrc),
    'the short-payload retry must run for the GROUP chat too — the payload rung varies the message, ' +
    'and only the room-preview rung (which the group never attempts) is 1:1-specific'
);
// The one thing a group message needs that a 1:1 one does not is its own
// `allow create` clause, and when a group send is refused the console and the
// toast must say THAT instead of leaving a bare "Missing or insufficient
// permissions" to diagnose. (`firebase deploy --only firestore:rules` is the
// fix; `firestore.rules` in this repo already carries the clause — asserted in
// test/chat-rules.test.js §1 above.)
assert(
    /if \(isGroupRoom\(\)\) \{\s*console\.warn\('\[Chat\] The GROUP chat \(chats\/owner-superadmin\) needs its own /.test(clientSrc) &&
    /allow create: if isLegacyArchive\(chatId\) && request\.resource\.data\.senderEmail /.test(clientSrc) &&
    /firebase deploy --only firestore:rules'\);/.test(clientSrc) &&
    /'Fix: run firebase deploy --only firestore:rules\.'/.test(clientSrc),
    'a refused GROUP send must name the missing rules clause and the deploy command, in the console and ' +
    'on screen — the payload is not the difference between the group and a working 1:1 thread'
);
assert(
    /The group chat is empty — send the first message\./.test(clientSrc),
    'a group room that does not exist yet must show an empty thread, NOT grey out the whole chat'
);

// ---------------------------------------------------------------
// 15. THE MODAL MUST NOT RESIZE ITSELF (chat.css).
//
//     With only a `max-height`, the modal was CONTENT-DRIVEN: it grew and
//     shrank as messages loaded, as the typing bar came and went, and as the
//     reply banner opened — the window visibly "breathed" and the thread
//     jumped under the cursor. A fixed height plus panes that scroll
//     internally is the fix, and both halves of it can silently regress.
// ---------------------------------------------------------------
const cssRaw = fs.readFileSync(path.join(ROOT, 'chat.css'), 'utf8');
// Comments are stripped before any assertion: they EXPLAIN the rules (and
// quote the old broken values), so matching against them would make a guard
// pass or fail on prose instead of on behaviour.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declaration block of a top-level selector (brace-balanced). */
function cssBlock(selector) {
    const at = css.indexOf(selector);
    assert(at > -1, 'chat.css has no ' + selector);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    throw new Error('unbalanced braces in ' + selector);
}
const modalBlock = cssBlock('.chat-modal-container {');
assert(
    /height:\s*min\(720px,\s*82vh\);/.test(modalBlock),
    'the chat modal must have a FIXED height, not only a max-height — otherwise its size follows ' +
    'the content and the window resizes as messages load and the typing bar appears'
);
assert(
    /max-height:\s*82vh;/.test(modalBlock) && /overflow:\s*hidden;/.test(modalBlock),
    'the fixed height must still be capped for short windows, and the container must clip so the ' +
    'panes scroll internally instead of stretching it'
);
assert(
    /min-height:\s*0;/.test(cssBlock('.chat-modal-body {')),
    '.chat-modal-body must have min-height: 0 — a floor would beat the fixed height on a short ' +
    'window and push the modal off-screen'
);
// ⚠️ THE HIDDEN TYPING BAR MUST TAKE NO SPACE.
//
// It used to RESERVE its row (`display: flex; visibility: hidden`) because,
// back when the modal was content-driven, `display: none` made the bar
// appearing and vanishing resize the composer and shift the thread. That
// reason is gone: the modal now has a FIXED height and the panes scroll
// internally, so nothing can resize. The reservation survived as a permanent
// dead band above the composer — `.chat-thread` is `flex: 1 1 auto`, so the
// reserved 32px came out of the message area.
const typingHidden = cssBlock('.chat-typing-bar[hidden]');
assert(
    /display:\s*none/.test(typingHidden),
    'the hidden typing bar must take no space (display: none) — reserving the row left a ' +
    'permanent dead band between the last message and the composer'
);
// ⚠️ AND THE REAL PROTECTION IS ASSERTED HERE, not restored as a band. If the
// bar ever needs its space back, it is because the modal stopped being a fixed
// height — so that is the thing a test must hold, rather than the cosmetic
// reservation that was masking it.
assert(
    /height:\s*min\(720px,\s*82vh\)/.test(cssBlock('.chat-modal-container {')) &&
    /overflow:\s*hidden/.test(cssBlock('.chat-modal-container {')),
    '.chat-modal-container must keep a FIXED height with overflow hidden — that, not a ' +
    'reserved typing row, is what stops the thread jumping when the bar shows and hides'
);
assert(
    /min-height:\s*0/.test(cssBlock('.chat-log {')),
    '.chat-log must keep min-height: 0 or it stops being the scroll container and every ' +
    'els.log.scrollTop write in chat.js becomes a silent no-op'
);
const mobile = css.slice(css.indexOf('@media (max-width: 640px)'));
assert(
    /height:\s*min\(720px,\s*88vh\);/.test(mobile),
    'the phone breakpoint must keep the same FIXED height, or the modal resizes on mobile only'
);

// ⚠️ The ＋ "new conversation" button is GONE (see the js/chat.js guard
// above), so its styles must be gone too. `.chat-icon-btn` is the button,
// `.chat-newmenu*` the floating picker, `.chat-sidebar-head` the row that
// existed only to hold that one button — all three would otherwise sit in the
// stylesheet styling nothing, and the head would read as an intentional gap
// above the search box if it ever came back alone.
assert(
    !/chat-icon-btn|chat-newmenu|chat-sidebar-head/.test(css),
    'chat.css must not keep rules for the removed ＋ button, its picker, or the header row that held it'
);
assert(
    /margin:\s*12px 12px 10px;/.test(cssBlock('.chat-search {')),
    'with the header row gone the search box is the first thing in the sidebar and needs its own top margin'
);
