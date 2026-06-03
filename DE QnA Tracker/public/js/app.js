// ---- extracted script block 1 ----
// ══════════════════════════════════════
// CONFIG — loaded from config.js
// ══════════════════════════════════════
if (!window.APP_CONFIG) {
  throw new Error('Missing config.js: window.APP_CONFIG is not loaded. Confirm config.js is in the same folder as index.html when using Live Server, and deployed at /config.js on Netlify.');
}
const SUPABASE_URL    = window.APP_CONFIG.SUPABASE_URL;
const SUPABASE_KEY    = window.APP_CONFIG.SUPABASE_ANON_KEY;
const REVIEWER_EMAIL  = window.APP_CONFIG.PRIMARY_ADMIN_EMAIL;

// ══════════════════════════════════════
// INIT
// ══════════════════════════════════════
const sb = AppAPI.createSupabaseClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let allQuestions = [];
let faqQuestions = [];
let faqFilter = '';
let currentQ = null;

// COMMENTS — client-side cache/state added for follow-up counts, expanded threads, and modal/card refreshes.
const COMMENT_MIN = 5;
const COMMENT_MAX = 2000;
let commentStatsByQuestion = {};
let commentCache = {};
let commentThreadExpanded = {};

// keep-alive ping every 5 days to prevent Supabase free tier pause
setInterval(async () => {
  await sb.from('questions').select('id').limit(1);
}, 5 * 24 * 60 * 60 * 1000);

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════

let allowedReviewers = [];

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/' }
  });
  if (error) toast('Sign in failed: ' + error.message, 'error');
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
  showLogin();
}

function showLogin() {
  document.getElementById('main-nav').style.display = 'none';
  document.body.classList.remove('app-authenticated');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-login').classList.add('active');
}

// ══════════════════════════════════════
// NAV
// ══════════════════════════════════════
const ROUTE_STORAGE_KEY = 'dataEntryQnaCurrentRouteV4';
const ROUTE_ALIASES = { answered: 'faq', answers: 'faq', all: 'allq', questions: 'allq', team: 'collab', chat: 'collab' };
function normalizeRouteId(id) {
  const raw = String(id || '').replace(/^#/, '').replace(/^page-/, '').trim().toLowerCase();
  return ROUTE_ALIASES[raw] || raw || defaultRouteForUser();
}
function defaultRouteForUser() {
  if (isAdmin()) return 'admin';
  if (isReviewer()) return 'review';
  return 'submit';
}
function routeExists(id) { return !!document.getElementById('page-' + id); }
// Issue 4C: until permissions have finished loading, do not silently redirect
// a user away from a privileged route. canAccessRoute is "optimistic" before
// the reviewersLoaded flag flips true; showPage handles the post-load denial
// case by rendering an Access Denied panel inside the page.
window.reviewersLoaded = window.reviewersLoaded || false;
function canAccessRoute(id) {
  if (!routeExists(id)) return false;
  if (id === 'admin') {
    if (isAdmin()) return true;
    // Admin requires a deterministic email check; if not admin, deny.
    return false;
  }
  if (id === 'review') {
    if (isAdmin()) return true;
    if (!window.reviewersLoaded) return true; // optimistic — wait for permissions to load
    return isReviewer();
  }
  return ['submit','allq','faq','privacy','collab'].includes(id);
}
function persistRoute(id) {
  if (!id || id === 'login') return;
  try { localStorage.setItem(ROUTE_STORAGE_KEY, id); } catch (_err) {}
  const hash = '#' + id;
  if (window.location.hash !== hash) {
    try { history.replaceState(null, '', hash); } catch (_err) {}
  }
}
function getPersistedRouteForUser() {
  const fromHash = normalizeRouteId(window.location.hash);
  const fromStorage = normalizeRouteId(localStorage.getItem(ROUTE_STORAGE_KEY));
  if (canAccessRoute(fromHash)) return fromHash;
  if (canAccessRoute(fromStorage)) return fromStorage;
  return defaultRouteForUser();
}
window.addEventListener('hashchange', () => {
  if (!currentUser) return;
  const target = normalizeRouteId(window.location.hash);
  if (canAccessRoute(target)) showPage(target);
});

// ══════════════════════════════════════
// SUBMIT
// ══════════════════════════════════════
let submitMode = 'single';

function setSubmitMode(mode) {
  submitMode = mode;
  document.getElementById('mode-single').classList.toggle('active', mode === 'single');
  document.getElementById('mode-bulk').classList.toggle('active', mode === 'bulk');
  document.getElementById('single-mode-wrap').style.display = mode === 'single' ? 'block' : 'none';
  document.getElementById('bulk-mode-wrap').style.display = mode === 'bulk' ? 'block' : 'none';
  // BULK UX — render the full five-row form as soon as Bulk Submit is opened.
  if (mode === 'bulk') {
    ensureBulkRows();
    updateBulkReadyCount();
  }
}

function updateCharCount(fieldId, counterId) {
  const el = document.getElementById(fieldId);
  const counter = document.getElementById(counterId);
  if (!el || !counter) return;
  const len = el.value.length;
  counter.textContent = `${len} / 500 characters`;
  counter.className = 'char-counter';
  if (len < 10 && len > 0) { counter.classList.add('error'); counter.textContent += ' — minimum 10 characters'; }
  else if (len > 450) counter.classList.add('warn');
}

// BULK
const BULK_MAX_ROWS = 5;
let bulkRowCount = BULK_MAX_ROWS;

function getBulkNameEmail() {
  return {
    name: currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
    email: currentUser.email
  };
}

function ensureBulkRows() {
  const wrap = document.getElementById('bulk-rows-wrap');
  if (!wrap) return;
  if (wrap.children.length !== BULK_MAX_ROWS) renderBulkRows();
}

function getBulkRowValues(n) {
  return {
    n,
    taskId: (document.getElementById(`br-task-${n}`)?.value || '').trim(),
    question: (document.getElementById(`br-q-${n}`)?.value || '').trim(),
    priority: document.getElementById(`br-priority-${n}`)?.value || 'Vendor'
  };
}

function getBulkRowValidation(row) {
  const hasAny = Boolean(row.taskId || row.question);
  const errors = [];

  // Empty rows are allowed and skipped on submit.
  if (!hasAny) return { state: 'empty', errors };

  if (!row.taskId) errors.push('Bill ID is required.');
  if (!row.question) errors.push('Question is required.');
  else if (row.question.length < 10) errors.push('Question must be at least 10 characters.');
  else if (row.question.length > 500) errors.push('Question must be 500 characters or less.');

  return {
    state: errors.length ? 'invalid' : 'ready',
    errors
  };
}

function updateBulkReadyCount() {
  let ready = 0;
  let invalid = 0;

  for (let n = 1; n <= BULK_MAX_ROWS; n++) {
    const rowEl = document.getElementById(`bulk-row-${n}`);
    const errEl = document.getElementById(`br-error-${n}`);
    if (!rowEl) continue;

    const row = getBulkRowValues(n);
    const validation = getBulkRowValidation(row);

    rowEl.classList.remove('ready', 'partial', 'invalid');
    if (validation.state === 'ready') {
      ready++;
      rowEl.classList.add('ready');
    } else if (validation.state === 'invalid') {
      invalid++;
      rowEl.classList.add(row.taskId || row.question ? 'partial' : 'invalid');
    }

    if (errEl) {
      errEl.textContent = validation.errors.length ? `Row ${n}: ${validation.errors.join(' ')}` : '';
      rowEl.classList.toggle('invalid', validation.errors.length > 0 && (row.taskId || row.question));
    }
  }

  const summary = document.getElementById('bulk-ready-summary');
  if (summary) {
    summary.className = 'bulk-ready-summary';
    if (invalid > 0) {
      summary.classList.add('warn');
      summary.textContent = `${ready} of ${BULK_MAX_ROWS} ready · ${invalid} row${invalid !== 1 ? 's' : ''} need attention`;
    } else if (ready > 0) {
      summary.classList.add('ready');
      summary.textContent = `${ready} of ${BULK_MAX_ROWS} question${ready !== 1 ? 's' : ''} ready to submit`;
    } else {
      summary.textContent = `0 of ${BULK_MAX_ROWS} questions ready to submit`;
    }
  }

  const validationSummary = document.getElementById('bulk-validation-summary');
  if (validationSummary && invalid === 0) {
    validationSummary.style.display = 'none';
    validationSummary.textContent = '';
  }

  const btnText = document.getElementById('bulk-btn-text');
  if (btnText) {
    btnText.textContent = ready > 0
      ? `Submit ${ready} Question${ready !== 1 ? 's' : ''}`
      : 'Submit Questions';
  }
}

// Kept as a safe compatibility wrapper in case an older button/link still calls it.
function addBulkRow() {
  ensureBulkRows();
  toast('Bulk Submit already shows all 5 available rows. Fill only the rows you need.', '');
}

// Kept as a safe compatibility wrapper; permanent rows are cleared instead of removed.
function removeBulkRow(n) {
  clearBulkRow(n);
}

function clearBulkForm() {
  renderBulkRows();
  const validationSummary = document.getElementById('bulk-validation-summary');
  if (validationSummary) {
    validationSummary.style.display = 'none';
    validationSummary.textContent = '';
  }
  const btn = document.getElementById('btn-bulk-submit');
  if (btn) btn.disabled = false;
  updateBulkReadyCount();
}

function resetSubmitForm() {
  clearForm();
  clearBulkForm();
  document.getElementById('submit-form-wrap').style.display = 'block';
  document.getElementById('submit-success').style.display = 'none';
  document.getElementById('btn-submit').disabled = false;
  document.getElementById('submit-btn-text').textContent = 'Submit Question';
  setSubmitMode('single');
}

// ══════════════════════════════════════
// REVIEW
// ══════════════════════════════════════

function filterOpenOnly() {
  document.getElementById('r-filter-status').value = 'Open';
  renderReviewTable();
  document.getElementById('reviewer-alert').classList.add('hidden');
}

// ══════════════════════════════════════
// MODAL
// ══════════════════════════════════════

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  currentQ = null;
}

function closeModalOnBg(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ══════════════════════════════════════
// FAQ
// ══════════════════════════════════════

async function toggleFaqCard(card, event) {
  // COMMENTS — keep form clicks, edit/reply buttons, and copy button from collapsing the card.
  if (event && event.target.closest('.comments-section, button, textarea, input, select, a')) return;

  const preview = card.querySelector('.faq-answer-preview');
  const isOpen = preview.classList.toggle('open');
  const arrow = card.querySelector('.faq-footer span:last-child');
  if (arrow) arrow.textContent = isOpen ? 'Click to collapse ▴' : 'Click to expand ▾';

  const questionId = card.dataset.questionId;
  const commentsSection = document.getElementById(faqCommentsSectionId(questionId));
  if (commentsSection) {
    commentsSection.style.display = isOpen ? 'block' : 'none';
    if (isOpen) await loadFaqComments(questionId);
  }
}

// Email notifications removed — staff check app daily

// ══════════════════════════════════════
// DELETE & SELECT
// ══════════════════════════════════════
function getSelectedIds() {
  return [...document.querySelectorAll('.question-cb:checked')].map(cb => cb.dataset.id);
}

function updateSelectBar() {
  const selected = getSelectedIds();
  const bar = document.getElementById('select-bar');
  const countEl = document.getElementById('select-count');
  if (selected.length > 0) {
    bar.classList.add('visible');
    countEl.textContent = selected.length + ' question' + (selected.length > 1 ? 's' : '') + ' selected';
  } else {
    bar.classList.remove('visible');
  }
}

function toggleAll(cb) {
  document.querySelectorAll('.question-cb').forEach(el => el.checked = cb.checked);
  updateSelectBar();
}

function clearSelection() {
  document.querySelectorAll('.question-cb').forEach(el => el.checked = false);
  const cbAll = document.getElementById('cb-all');
  if (cbAll) cbAll.checked = false;
  document.getElementById('select-bar').classList.remove('visible');
}

// ══════════════════════════════════════
// ANSWERED SEARCH CLEAR BUTTON
// Keeps the clear (×) button visible whenever the answered search field has a value,
// whether the value was typed by the user or inserted by code after navigation.
// ══════════════════════════════════════
function updateFaqSearchClearButton() {
  const input = document.getElementById('faq-search');
  const wrap = document.getElementById('faq-search-wrap');

  if (!input || !wrap) return;

  wrap.classList.toggle('has-value', input.value.trim().length > 0);
}

function handleFaqSearchInput() {
  updateFaqSearchClearButton();
  renderFaq();
}

function clearFaqSearch() {
  const input = document.getElementById('faq-search');

  if (!input) return;

  input.value = '';
  updateFaqSearchClearButton();
  renderFaq();
  input.focus();
}

// ══════════════════════════════════════
// ALL QUESTIONS (read-only for all staff)
// ══════════════════════════════════════
let allQData = [];

function allQRowClick(taskId, status) {
  if (status === 'Answered') {
    showPage('faq');
    setTimeout(() => {
      const search = document.getElementById('faq-search');
      if (search) { search.value = taskId; updateFaqSearchClearButton(); renderFaq(); }
    }, 400);
  } else {
    toast(`This question (Bill ID: ${taskId}) hasn't been answered yet.`, '');
  }
}

// ══════════════════════════════════════
// COPY ANSWER
// ══════════════════════════════════════
function copyAnswer(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Copied!';
    btn.style.borderColor = 'var(--success)';
    btn.style.color = 'var(--success)';
    setTimeout(() => {
      btn.innerHTML = '📋 Copy Answer';
      btn.style.borderColor = '';
      btn.style.color = '';
    }, 2000);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.innerHTML = '📋 Copy Answer'; }, 2000);
  });
}

// ══════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════
async function loadAllowedReviewers() {
  const emails = new Set(['hillstribeco@gmail.com']);
  const roleEmails = new Set();
  try {
    let roleQuery = sb.from('app_user_roles').select('email,role').in('role', ['reviewer', 'admin', 'primary_admin']).order('email');
    if (currentUser && currentUser.email !== V2_ADMIN_EMAIL) roleQuery = sb.from('app_user_roles').select('email,role').eq('email', currentUser.email).limit(1);
    const { data, error } = await roleQuery;
    if (!error) (data || []).forEach(r => { if (['reviewer','admin','primary_admin'].includes(r.role)) roleEmails.add(AppAuth.normalizeEmail(r.email)); });
  } catch (err) { console.warn('Role lookup skipped:', err?.message || err); }

  try {
    const { data, error } = await sb.from('reviewers').select('email').order('email');
    if (!error) (data || []).forEach(r => emails.add(AppAuth.normalizeEmail(r.email)));
  } catch (err) { console.warn('Legacy reviewer lookup skipped:', err?.message || err); }

  roleEmails.forEach(email => emails.add(email));
  allowedReviewers = [...emails].filter(Boolean);
  window.reviewersLoaded = true;
}

// ══════════════════════════════════════
// COMMENTS SYSTEM — full follow-up system added
// ══════════════════════════════════════
function emptyCommentStats() {
  return { total: 0, unresolved: 0, reviewerReplies: 0, staffFollowUps: 0, latestAt: null };
}

function computeCommentStats(comments) {
  const stats = emptyCommentStats();
  (comments || []).forEach(c => {
    stats.total++;
    if (c.is_reviewer_reply) stats.reviewerReplies++;
    else stats.staffFollowUps++;
    if (!c.is_reviewer_reply && !c.is_resolved) stats.unresolved++;
    if (!stats.latestAt || new Date(c.created_at) > new Date(stats.latestAt)) stats.latestAt = c.created_at;
  });
  return stats;
}

function setQuestionCommentStats(questionId, comments) {
  commentStatsByQuestion[questionId] = computeCommentStats(comments || []);
}

function getCommentStats(questionId) {
  return commentStatsByQuestion[questionId] || emptyCommentStats();
}

function getTotalUnresolvedFollowUps() {
  return Object.values(commentStatsByQuestion).reduce((sum, s) => sum + (s.unresolved || 0), 0);
}

function updateReviewNavBadge() {
  const badge = document.getElementById('nav-review-badge');
  if (!badge) return;
  const count = getTotalUnresolvedFollowUps();
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
}

function followUpBadgeText(questionId) {
  const stats = getCommentStats(questionId);
  const label = stats.total === 1 ? 'follow-up' : 'follow-ups';
  return `📝 ${stats.total} ${label}${stats.unresolved ? ` (${stats.unresolved} unresolved)` : ''}`;
}

function followUpBadgeClass(questionId) {
  const stats = getCommentStats(questionId);
  return 'follow-up-badge' + (stats.unresolved ? ' has-unresolved' : stats.total ? ' has-comments' : '');
}

function renderFollowUpBadge(questionId) {
  return `<span class="${followUpBadgeClass(questionId)}" data-followup-badge-id="${questionId}">${followUpBadgeText(questionId)}</span>`;
}

function updateFollowUpBadges(questionId) {
  document.querySelectorAll(`[data-followup-badge-id="${questionId}"]`).forEach(el => {
    el.className = followUpBadgeClass(questionId);
    el.textContent = followUpBadgeText(questionId);
  });
  const modalBadge = document.getElementById('modal-followup-badge');
  if (modalBadge && currentQ && currentQ.id === questionId) {
    modalBadge.className = followUpBadgeClass(questionId);
    modalBadge.textContent = followUpBadgeText(questionId);
  }
}

async function loadCommentStatsForQuestions(questionIds = []) {
  const uniqueIds = [...new Set((questionIds || []).filter(Boolean))];
  commentStatsByQuestion = {};
  uniqueIds.forEach(id => { commentStatsByQuestion[id] = emptyCommentStats(); });
  if (uniqueIds.length === 0) { updateReviewNavBadge(); return; }

  // COMMENTS — fetch only lightweight fields for badges; full thread text is loaded on demand.
  const chunkSize = 200;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const { data, error } = await sb
      .from('question_comments')
      .select('id,question_id,is_reviewer_reply,is_resolved,created_at')
      .in('question_id', chunk);

    if (error) {
      console.warn('Could not load follow-up counts:', error.message);
      continue;
    }
    (data || []).forEach(c => {
      if (!commentStatsByQuestion[c.question_id]) commentStatsByQuestion[c.question_id] = emptyCommentStats();
      const stats = commentStatsByQuestion[c.question_id];
      stats.total++;
      if (c.is_reviewer_reply) stats.reviewerReplies++;
      else stats.staffFollowUps++;
      if (!c.is_reviewer_reply && !c.is_resolved) stats.unresolved++;
      if (!stats.latestAt || new Date(c.created_at) > new Date(stats.latestAt)) stats.latestAt = c.created_at;
    });
  }
  updateReviewNavBadge();
}

function faqCommentsSectionId(questionId) {
  return `faq-comments-${domKey(questionId)}`;
}

async function loadComments(questionId) {
  const { data, error } = await sb.from('question_comments')
    .select('id,question_id,parent_comment_id,user_email,user_name,text,is_reviewer_reply,is_resolved,created_at,updated_at')
    .eq('question_id', questionId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error loading comments:', error);
    toast('Error loading follow-ups: ' + error.message, 'error');
    return [];
  }
  return data || [];
}

async function loadFaqComments(questionId, force = false) {
  const section = document.getElementById(faqCommentsSectionId(questionId));
  if (!section) return;

  if (!force && section.dataset.loaded === 'true' && commentCache[questionId]) {
    renderFaqComments(questionId);
    return;
  }

  section.innerHTML = '<div class="comment-loading"><div class="spinner" style="width:14px;height:14px"></div> Loading follow-ups...</div>';
  const comments = await loadComments(questionId);
  commentCache[questionId] = comments;
  setQuestionCommentStats(questionId, comments);
  section.dataset.loaded = 'true';
  renderFaqComments(questionId);
  updateFollowUpBadges(questionId);
  updateReviewNavBadge();
}

async function loadModalComments(questionId) {
  const wrap = document.getElementById('modal-comments-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="comment-loading"><div class="spinner" style="width:14px;height:14px"></div> Loading follow-ups...</div>';
  const comments = await loadComments(questionId);
  commentCache[questionId] = comments;
  setQuestionCommentStats(questionId, comments);
  renderModalComments(questionId);
  updateFollowUpBadges(questionId);
  updateReviewNavBadge();
}

function renderFaqComments(questionId) {
  const section = document.getElementById(faqCommentsSectionId(questionId));
  if (!section) return;
  const comments = commentCache[questionId] || [];
  const expanded = !!commentThreadExpanded[questionId];
  const listHtml = comments.length === 0
    ? ''
    : expanded
      ? renderCommentThread(comments, { questionId, context: 'faq' })
      : renderRecentComments(comments, questionId, 'faq');
  const toggleBtn = comments.length > 3
    ? `<button class="show-all-btn" onclick="toggleFaqComments('${questionId}')">${expanded ? 'Show last 3 comments' : `Show all ${comments.length} comments`}</button>`
    : '';

  section.innerHTML = `
    <div class="comments-header-row">
      <div>
        <div class="comments-header">Follow-ups</div>
        
      </div>
      ${renderFollowUpBadge(questionId)}
    </div>
    ${listHtml}
    ${toggleBtn}
    ${renderCommentForm(questionId, null, 'faq')}`;
  section.dataset.loaded = 'true';
}

function renderModalComments(questionId) {
  const wrap = document.getElementById('modal-comments-content');
  if (!wrap) return;
  const comments = commentCache[questionId] || [];
  wrap.innerHTML = `
    ${comments.length ? renderCommentThread(comments, { questionId, context: 'modal' }) : '<div class="comment-empty">No follow-ups yet. Add a reply below.</div>'}
    ${renderCommentForm(questionId, null, 'modal')}`;
}

function toggleFaqComments(questionId) {
  commentThreadExpanded[questionId] = !commentThreadExpanded[questionId];
  renderFaqComments(questionId);
}

function sortCommentsAscending(comments) {
  return [...(comments || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function getCommentDepthMap(comments) {
  const byId = {};
  (comments || []).forEach(c => { byId[c.id] = c; });
  const memo = {};

  function depthOf(comment, seen = new Set()) {
    if (!comment || !comment.parent_comment_id || !byId[comment.parent_comment_id] || seen.has(comment.id)) return 0;
    if (memo[comment.id] !== undefined) return memo[comment.id];
    seen.add(comment.id);
    memo[comment.id] = 1 + depthOf(byId[comment.parent_comment_id], seen);
    return memo[comment.id];
  }

  Object.values(byId).forEach(c => { memo[c.id] = depthOf(c); });
  return memo;
}

function renderRecentComments(comments, questionId, context) {
  const sorted = sortCommentsAscending(comments);
  const depthMap = getCommentDepthMap(sorted);
  const recent = sorted.slice(-3);
  return `<div class="comment-thread comment-thread-preview">${recent.map(c => renderCommentItem({ ...c, replies: [] }, questionId, context, Math.min(depthMap[c.id] || 0, 5), true)).join('')}</div>`;
}

function renderCommentThread(comments, options = {}) {
  if (!comments || comments.length === 0) return '';
  const questionId = options.questionId || comments[0]?.question_id || '';
  const context = options.context || 'faq';
  const sorted = sortCommentsAscending(comments);

  // COMMENTS — build a recursive tree so replies nest under parent_comment_id with no hard depth limit.
  const commentMap = {};
  const roots = [];
  sorted.forEach(c => { commentMap[c.id] = { ...c, replies: [] }; });
  sorted.forEach(c => {
    const node = commentMap[c.id];
    if (c.parent_comment_id && commentMap[c.parent_comment_id]) commentMap[c.parent_comment_id].replies.push(node);
    else roots.push(node);
  });

  return `<div class="comment-thread">${roots.map(node => renderCommentItem(node, questionId, context)).join('')}</div>`;
}

function renderCommentItem(node, questionId, context, previewDepth = 0, isPreview = false) {
  const nodeKey = domKey(context, node.id);
  const isOwn = currentUser && currentUser.email === node.user_email;
  const isStaff = !node.is_reviewer_reply;
  const roleClass = isStaff ? 'comment-staff' : 'comment-reviewer';
  const roleLabel = isStaff ? 'Staff' : 'Reviewer';
  const edited = isCommentEdited(node) ? `<span class="comment-edited">Edited ${fmtDateFull(node.updated_at)}</span>` : '';
  const resolvedBadge = isStaff && node.is_resolved ? '<span class="resolved-badge">✓ Resolved</span>' : '';
  const previewStyle = isPreview && previewDepth > 0 ? ` style="margin-left:${previewDepth * 14}px"` : '';

  return `
    <div class="comment-node" data-comment-id="${node.id}" data-question-id="${questionId}"${previewStyle}>
      <div class="comment-item ${roleClass}">
        <div class="comment-meta">
          <span class="author">${escHtml(node.user_name)}</span>
          <span class="comment-role">${roleLabel}</span>
          <span>· ${fmtDateFull(node.created_at)}</span>
          ${edited}
          ${resolvedBadge}
        </div>
        <div class="comment-text" id="comment-text-${nodeKey}">${escHtml(node.text)}</div>
        <div class="comment-edit-slot" id="comment-edit-slot-${nodeKey}"></div>
        <div class="comment-actions" id="comment-actions-${nodeKey}">
          ${isOwn ? `<button class="comment-btn" onclick="event.stopPropagation();editCommentStart('${node.id}','${questionId}','${context}')">Edit</button>` : ''}
          <button class="comment-btn" onclick="event.stopPropagation();replyCommentStart('${node.id}','${questionId}','${context}')">Reply</button>
          ${isOwn && isStaff ? `<button class="comment-btn" onclick="toggleResolved('${node.id}',${!node.is_resolved},'${questionId}','${context}')">Mark ${node.is_resolved ? 'unresolved' : 'resolved'}</button>` : ''}
        </div>
        <div class="comment-reply-slot" id="comment-reply-slot-${nodeKey}"></div>
      </div>
      ${node.replies && node.replies.length ? `<div class="comment-children">${node.replies.map(child => renderCommentItem(child, questionId, context)).join('')}</div>` : ''}
    </div>`;
}

function isCommentEdited(comment) {
  if (!comment.updated_at || !comment.created_at) return false;
  return Math.abs(new Date(comment.updated_at) - new Date(comment.created_at)) > 2000;
}

function getCachedComment(questionId, commentId) {
  return (commentCache[questionId] || []).find(c => c.id === commentId) || null;
}

function findQuestionIdForComment(commentId) {
  for (const [qid, comments] of Object.entries(commentCache)) {
    if ((comments || []).some(c => c.id === commentId)) return qid;
  }
  return null;
}

function domKey(...parts) {
  return parts.map(p => String(p || 'root').replace(/[^A-Za-z0-9_-]/g, '_')).join('__');
}

function commentFormKey(questionId, parentId, context) {
  return domKey('comment', context, questionId, parentId || 'root');
}

function renderCommentForm(questionId, parentId = null, context = 'faq') {
  const key = commentFormKey(questionId, parentId, context);
  const parentArg = parentId || '';
  const isReply = !!parentId;
  const placeholder = isReply
    ? 'Write a reply (5-500 characters)...'
    : isReviewer()
      ? 'Write a reviewer reply or clarification (5-500 characters)...'
      : 'Add a follow-up question or clarification (5-500 characters)...';
  const submitLabel = isReviewer() ? 'Reply' : (isReply ? 'Reply' : 'Post follow-up');

  return `
    <div class="comment-form ${isReply ? 'comment-reply-form' : ''}" id="comment-form-${key}">
      <textarea class="comment-textarea" id="comment-textarea-${key}" maxlength="${COMMENT_MAX}" placeholder="${placeholder}" oninput="updateCommentCounter('${key}')"></textarea>
      <div class="comment-form-meta">
        <span class="comment-hint">Comments must be ${COMMENT_MIN}-${COMMENT_MAX} characters.</span>
        <span class="comment-char-count" id="comment-counter-${key}">0 / ${COMMENT_MAX}</span>
      </div>
      <div class="comment-actions-form">
        <button class="btn-comment-submit" id="comment-submit-${key}" onclick="event.stopPropagation();submitCommentForm('${questionId}','${parentArg}','${context}')" disabled>${submitLabel}</button>
        ${isReply
          ? `<button class="btn-comment-cancel" onclick="event.stopPropagation();cancelReply('${parentId}','${questionId}','${context}')">Cancel</button>`
          : `<button class="btn-comment-cancel" onclick="event.stopPropagation();clearCommentForm('${key}')">Clear</button>`}
      </div>
    </div>`;
}

function updateCommentCounter(key) {
  const textarea = document.getElementById(`comment-textarea-${key}`);
  const counter = document.getElementById(`comment-counter-${key}`);
  const submit = document.getElementById(`comment-submit-${key}`);
  if (!textarea || !counter) return;
  const len = textarea.value.length;
  const trimmedLen = textarea.value.trim().length;
  counter.textContent = `${len} / ${COMMENT_MAX}`;
  counter.className = 'comment-char-count';
  if ((len > 0 && trimmedLen < COMMENT_MIN) || len > COMMENT_MAX) counter.classList.add('error');
  else if (len > COMMENT_MAX - 50) counter.classList.add('warn');
  if (submit) submit.disabled = trimmedLen < COMMENT_MIN || len > COMMENT_MAX;
}

function clearCommentForm(key) {
  const textarea = document.getElementById(`comment-textarea-${key}`);
  if (!textarea) return;
  textarea.value = '';
  updateCommentCounter(key);
  textarea.focus();
}

async function submitCommentForm(questionId, parentId = '', context = 'faq') {
  const realParentId = parentId || null;
  const key = commentFormKey(questionId, realParentId, context);
  const textarea = document.getElementById(`comment-textarea-${key}`);
  const submit = document.getElementById(`comment-submit-${key}`);
  if (!textarea) return;

  const text = textarea.value.trim();
  if (submit) submit.disabled = true;
  const inserted = await addComment(questionId, text, realParentId);
  if (!inserted) {
    updateCommentCounter(key);
    return;
  }

  textarea.value = '';
  updateCommentCounter(key);
  if (realParentId) cancelReply(realParentId, questionId, context);
  await refreshComments(questionId);
}

async function autoMarkQuestionAnsweredOnReviewerReply(questionId) {
  if (!questionId || !isReviewer()) return;
  try {
    const { data: existing, error: fetchError } = await sb
      .from('questions')
      .select('id,status,answered_date,question_id,task_id')
      .eq('id', questionId)
      .single();
    if (fetchError || !existing) return;
    const now = new Date().toISOString();
    const updates = {
      status: 'Answered',
      answered_by: currentUser?.user_metadata?.full_name || currentUser?.email || null,
      answered_date: existing.answered_date || now
    };
    const { data, error } = await sb.from('questions').update(updates).eq('id', questionId).select().single();
    if (error) return;
    const idx = allQuestions.findIndex(q => q.id === questionId);
    if (idx > -1) allQuestions[idx] = { ...allQuestions[idx], ...updates, ...data };
    const adminIdx = adminQuestions.findIndex(q => q.id === questionId);
    if (adminIdx > -1) adminQuestions[adminIdx] = { ...adminQuestions[adminIdx], ...updates, ...data };
    if (currentQ && currentQ.id === questionId) currentQ = { ...currentQ, ...updates, ...data };
    if (existing.status !== 'Answered') await logActivity('STATUS_CHANGED', 'questions', questionId, existing.question_id || existing.task_id, { from: existing.status, to: 'Answered', reason: 'reviewer_reply' });
    if (document.getElementById('page-review')?.classList.contains('active')) renderReviewTable();
  } catch (err) {
    console.warn('Could not auto-mark question answered after reviewer reply:', err?.message || err);
  }
}

function editCommentStart(commentId, questionId, context = 'faq') {
  const comment = getCachedComment(questionId, commentId);
  if (!comment) return;
  if (!currentUser || currentUser.email !== comment.user_email) {
    toast('You can edit only your own comments', 'error');
    return;
  }

  const nodeKey = domKey(context, commentId);
  const textEl = document.getElementById(`comment-text-${nodeKey}`);
  const actionsEl = document.getElementById(`comment-actions-${nodeKey}`);
  const slot = document.getElementById(`comment-edit-slot-${nodeKey}`);
  if (!textEl || !actionsEl || !slot) return;

  const editKey = domKey('edit', context, commentId);
  textEl.style.display = 'none';
  actionsEl.style.display = 'none';
  slot.innerHTML = `
    <textarea class="comment-textarea" id="comment-textarea-${editKey}" maxlength="${COMMENT_MAX}" oninput="updateCommentCounter('${editKey}')">${escHtml(comment.text)}</textarea>
    <div class="comment-form-meta">
      <span class="comment-hint">Editing your own comment only.</span>
      <span class="comment-char-count" id="comment-counter-${editKey}">0 / ${COMMENT_MAX}</span>
    </div>
    <div class="comment-actions-form">
      <button class="btn-comment-submit" id="comment-submit-${editKey}" onclick="editCommentSubmit('${commentId}','${questionId}','${context}')">Save edit</button>
      <button class="btn-comment-cancel" onclick="cancelEditComment('${commentId}','${context}')">Cancel</button>
    </div>`;

  const textarea = document.getElementById(`comment-textarea-${editKey}`);
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
  updateCommentCounter(editKey);
}

function cancelEditComment(commentId, context = 'faq') {
  const nodeKey = domKey(context, commentId);
  const textEl = document.getElementById(`comment-text-${nodeKey}`);
  const actionsEl = document.getElementById(`comment-actions-${nodeKey}`);
  const slot = document.getElementById(`comment-edit-slot-${nodeKey}`);
  if (textEl) textEl.style.display = '';
  if (actionsEl) actionsEl.style.display = '';
  if (slot) slot.innerHTML = '';
}

async function editCommentSubmit(commentId, questionId, context = 'faq') {
  const editKey = domKey('edit', context, commentId);
  const textarea = document.getElementById(`comment-textarea-${editKey}`);
  if (!textarea) return;
  const updated = await editComment(commentId, textarea.value);
  if (updated) await refreshComments(questionId);
  else updateCommentCounter(editKey);
}

function replyCommentStart(parentId, questionId, context = 'faq') {
  const nodeKey = domKey(context, parentId);
  const slot = document.getElementById(`comment-reply-slot-${nodeKey}`);
  if (!slot) return;
  slot.innerHTML = renderCommentForm(questionId, parentId, context);
  const key = commentFormKey(questionId, parentId, context);
  const textarea = document.getElementById(`comment-textarea-${key}`);
  if (textarea) textarea.focus();
}

function cancelReply(parentId, questionId, context = 'faq') {
  const nodeKey = domKey(context, parentId);
  const slot = document.getElementById(`comment-reply-slot-${nodeKey}`);
  if (slot) slot.innerHTML = '';
}

async function refreshComments(questionId) {
  const comments = await loadComments(questionId);
  commentCache[questionId] = comments;
  setQuestionCommentStats(questionId, comments);
  updateFollowUpBadges(questionId);
  updateReviewNavBadge();

  const faqSection = document.getElementById(faqCommentsSectionId(questionId));
  if (faqSection && faqSection.dataset.loaded === 'true') renderFaqComments(questionId);
  if (currentQ && currentQ.id === questionId && document.getElementById('modal-comments-content')) renderModalComments(questionId);
  updateStatsIfReviewLoaded();
}

function updateStatsIfReviewLoaded() {
  if (document.getElementById('page-review')?.classList.contains('active') && Array.isArray(allQuestions)) {
    updateStats();
  }
}

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function fmtDateFull(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' t-' + type : '');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// START
// init() is called after Admin Dashboard v2 overrides are loaded.

// ---- extracted script block 2 ----
// ══════════════════════════════════════
// ADMIN DASHBOARD V2 OVERRIDES
// ══════════════════════════════════════
const V2_ADMIN_EMAIL = (window.APP_CONFIG && window.APP_CONFIG.PRIMARY_ADMIN_EMAIL) || (typeof REVIEWER_EMAIL !== 'undefined' ? REVIEWER_EMAIL : 'hillstribeco@gmail.com');
const FALLBACK_ISSUE_FIELDS = [
  { name: 'Expense Type', description: 'Questions about choosing the correct expense type.', color_class: 'info', sort_order: 10, is_active: true },
  { name: 'Vendor', description: 'Vendor matching, naming, and correction questions.', color_class: 'purple', sort_order: 20, is_active: true },
  { name: 'Expense', description: 'Expense coding, details, or policy questions.', color_class: 'pink', sort_order: 30, is_active: true },
  { name: 'Payment', description: 'Payment status, timing, or reconciliation questions.', color_class: 'green', sort_order: 40, is_active: true }
];
let issueFields = [];
let slaSettings = { response_days: 2, exclude_weekends: true, timezone: 'Asia/Kathmandu' };
let adminQuestions = [];
let archivedQuestions = [];
let activityLogRows = [];
let lastReviewFiltered = [];
let activeQueueFilter = '';

function safeText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function safeValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;');
}

function normalizeIssueName(value) {
  return String(value || '').trim() || 'General';
}

function isArchived(q) {
  return Boolean(q && (q.is_archived || q.archived_at));
}

function getIssueField(q) {
  return normalizeIssueName(q?.issue_field || q?.priority || 'General');
}

function getActiveIssueFields() {
  const fields = (issueFields && issueFields.length ? issueFields : FALLBACK_ISSUE_FIELDS)
    .filter(f => f.is_active !== false)
    .sort((a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0)) || String(a.name || '').localeCompare(String(b.name || '')));
  return fields.length ? fields : FALLBACK_ISSUE_FIELDS;
}

function getIssueMeta(name) {
  const fieldName = normalizeIssueName(name);
  return (issueFields || []).find(f => String(f.name).toLowerCase() === fieldName.toLowerCase())
    || FALLBACK_ISSUE_FIELDS.find(f => String(f.name).toLowerCase() === fieldName.toLowerCase())
    || { name: fieldName, color_class: 'muted', is_active: true, sort_order: 999 };
}

function issueFieldOptionsHtml(selected = '', includeAll = false) {
  const active = getActiveIssueFields();
  const current = normalizeIssueName(selected || active[0]?.name || 'Vendor');
  const options = active.map(f => `<option value="${escHtml(f.name)}" ${f.name === current ? 'selected' : ''}>${escHtml(f.name)}</option>`).join('');
  return (includeAll ? '<option value="">All issue fields</option>' : '') + options;
}

function issueBadge(name) {
  const fieldName = normalizeIssueName(name);
  const meta = getIssueMeta(fieldName);
  return `<span class="priority issue-color-${escHtml(meta.color_class || 'muted')}">${escHtml(fieldName)}</span>`;
}

function populateIssueSelect(id, includeAll = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const old = el.value;
  el.innerHTML = issueFieldOptionsHtml(old, includeAll);
  if (includeAll && old === '') el.value = '';
  else if (old && [...el.options].some(o => o.value === old)) el.value = old;
}

function updateIssueFieldControls() {
  populateIssueSelect('f-priority');
  populateIssueSelect('r-filter-priority', true);
  populateIssueSelect('aq-filter-priority', true);

  for (let n = 1; n <= BULK_MAX_ROWS; n++) {
    const el = document.getElementById(`br-priority-${n}`);
    if (!el) continue;
    const old = el.value;
    el.innerHTML = issueFieldOptionsHtml(old);
    if (old && [...el.options].some(o => o.value === old)) el.value = old;
  }

  const chips = document.getElementById('faq-filter-chips');
  if (chips) {
    const fieldButtons = getActiveIssueFields().map(f =>
      `<button class="filter-chip ${faqFilter === f.name ? 'active' : ''}" data-filter="${escHtml(f.name)}" onclick="setFaqFilter(this)">${escHtml(f.name)}</button>`
    ).join('');
    chips.innerHTML = `<button class="filter-chip ${!faqFilter ? 'active' : ''}" data-filter="" onclick="setFaqFilter(this)">All</button>${fieldButtons}<span class="result-count" id="faq-count"></span>`;
  }
}

async function loadIssueFields() {
  const { data, error } = await sb.from('issue_fields').select('id,name,description,color,sort_order,is_active,created_at').order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error || !data || data.length === 0) {
    if (error) console.warn('Issue fields table not available yet:', error.message);
    issueFields = [...FALLBACK_ISSUE_FIELDS];
  } else {
    issueFields = data;
  }
  updateIssueFieldControls();
}

async function loadSlaSettings() {
  const { data, error } = await sb.from('sla_settings').select('id,response_days,exclude_weekends,timezone,updated_at,updated_by').eq('id', 1).maybeSingle();
  if (!error && data) {
    slaSettings = {
      response_days: Number(data.response_days || 2),
      exclude_weekends: data.exclude_weekends !== false,
      timezone: data.timezone || 'Asia/Kathmandu'
    };
  } else if (error) {
    console.warn('SLA settings table not available yet:', error.message);
  }
}

async function init() {
  await Promise.all([loadAllowedReviewers(), loadIssueFields(), loadSlaSettings()]);
  const { data: { session } } = await sb.auth.getSession();
  if (session) setUser(session.user);
  else showLogin();

  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session) {
      currentUser = session.user;
      await Promise.all([loadAllowedReviewers(), loadIssueFields(), loadSlaSettings()]);
      setUser(session.user);
    } else {
      showLogin();
    }
  });
}

function setUser(user) {
  currentUser = user;
  const name = user.user_metadata?.full_name || user.email.split('@')[0];
  const email = user.email;
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);

  safeText('nav-avatar', initials || '?');
  // Issue 2C: do not flash the Google full name. Leave nav-name empty until
  // refreshCurrentIdentityUI() resolves the user's custom_username/display_name
  // from collab_profiles. The avatar (initials) is enough visual feedback.
  const navNameEl = document.getElementById('nav-name');
  if (navNameEl) { navNameEl.textContent = ''; }
  safeText('form-name-display', name);
  safeText('form-email-display', email);
  safeText('bulk-name-display', name);
  safeText('bulk-email-display', email);
  safeText('admin-current-user', `${name} · ${email}`);

  const nav = document.getElementById('main-nav');
  if (nav) nav.style.display = 'flex';
  document.body.classList.add('app-authenticated');
  const footer = document.getElementById('main-footer');
  if (footer) footer.style.display = 'block';

  buildNav();
  updateIssueFieldControls();
  // Issue 1B: restore any silently saved draft for this user (Bill ID, question, issue field).
  try { restoreDraft(); } catch (_e) {}
  try { initDraftAutosave(); } catch (_e) {}
  const requestedPage = getPersistedRouteForUser();
  showPage(requestedPage);
  // Issue 3A/4A: signal that auth + initial queries are settled; All Questions
  // and Review pages can now safely fire their data loads on first nav.
  window.initSettled = true;
  window._sessionReady = true;
}

function isAdmin() {
  return currentUser && currentUser.email === V2_ADMIN_EMAIL;
}

function isReviewer() {
  if (!currentUser) return false;
  return isAdmin() || allowedReviewers.includes(currentUser.email);
}

function buildNav() {
  const wrap = document.getElementById('nav-links');
  if (!wrap) return;
  const pages = isAdmin()
    ? [['submit','Submit Question'],['allq','All Questions'],['review','Review'],['faq','Answered'],['admin','Admin'],['privacy','Privacy']]
    : isReviewer()
    ? [['submit','Submit Question'],['allq','All Questions'],['review','Review'],['faq','Answered'],['privacy','Privacy']]
    : [['submit','Submit Question'],['allq','All Questions'],['faq','Answered'],['privacy','Privacy']];

  wrap.innerHTML = pages.map(([id,label]) => {
    const badge = id === 'review' ? '<span class="nav-badge hidden" id="nav-review-badge">0</span>' : '';
    return `<button class="nav-btn" id="nav-${id}" onclick="showPage('${id}')">${label}${badge}</button>`;
  }).join('');
  updateReviewNavBadge();
}

function showPage(id) {
  id = normalizeRouteId(id);
  if (!canAccessRoute(id)) id = defaultRouteForUser();
  persistRoute(id);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + id);
  if (page) page.classList.add('active');
  const nb = document.getElementById('nav-' + id);
  if (nb) nb.classList.add('active');

  if (id === 'review' && isReviewer()) loadReviewData();
  if (id === 'faq') loadFaqData();
  if (id === 'allq') loadAllQData();
  if (id === 'admin' && isAdmin()) loadAdminPanel();
}

function getSlaDays() {
  return Math.max(1, Number(slaSettings.response_days || 2));
}

function addWorkingDays(dateInput, days) {
  const date = new Date(dateInput || new Date());
  if (Number.isNaN(date.getTime())) return new Date();
  let added = 0;
  const due = new Date(date);
  while (added < Number(days || 2)) {
    due.setDate(due.getDate() + 1);
    const day = due.getDay();
    if (!slaSettings.exclude_weekends || (day !== 0 && day !== 6)) added++;
  }
  return due;
}

function sameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getQuestionDueAt(q) {
  if (q?.due_at) return new Date(q.due_at);
  return addWorkingDays(q?.submitted_at || new Date(), getSlaDays());
}

function getSlaInfo(q) {
  if (!q) return { key: 'on-track', label: 'On track', className: 'sla-on-track', rank: 4 };
  if (isArchived(q)) return { key: 'archived', label: 'Archived', className: 'sla-archived', rank: 9 };
  const due = getQuestionDueAt(q);
  const status = q.status || 'Open';
  if (status === 'Answered' && q.answered_date) {
    const answered = new Date(q.answered_date);
    if (answered <= due) return { key: 'answered-on-time', label: 'Answered on time', className: 'sla-answered-on-time', rank: 5 };
    return { key: 'answered-late', label: 'Answered late', className: 'sla-answered-late', rank: 2 };
  }
  const now = new Date();
  if (now > due) return { key: 'overdue', label: 'Overdue', className: 'sla-overdue', rank: 0 };
  if (sameLocalDate(now, due)) return { key: 'due-today', label: 'Due today', className: 'sla-due-today', rank: 1 };
  return { key: 'on-track', label: 'On track', className: 'sla-on-track', rank: 3 };
}

function renderSlaBadge(q) {
  const info = getSlaInfo(q);
  return `<span class="sla-badge ${info.className}">${info.label}</span>`;
}

function normalizeQuestionStatus(status) {
  return status === 'Closed' ? 'Answered' : (status || 'Open');
}

function normalizeQuestionRecord(q) {
  return q ? { ...q, status: normalizeQuestionStatus(q.status) } : q;
}

function makeQuestionInsertPayload(row) {
  const issueField = normalizeIssueName(row.issue_field || row.priority || 'Vendor');
  const payload = {
    submitter_name: row.submitter_name,
    submitter_email: row.submitter_email,
    task_id: row.task_id,
    question: row.question,
    issue_field: issueField,
    priority: issueField,
    status: normalizeQuestionStatus(row.status),
    due_at: row.due_at || addWorkingDays(new Date(), getSlaDays()).toISOString(),
    is_archived: false
  };
  // Issue 1F: attach the dedicated attachments JSONB column when provided.
  if (Array.isArray(row.attachments) && row.attachments.length) {
    payload.attachments = row.attachments;
  }
  return payload;
}

async function logActivity(action, targetTable = 'questions', targetId = null, targetLabel = '', details = {}) {
  if (!currentUser) return;
  const payload = {
    actor_email: currentUser.email,
    actor_name: currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
    action,
    target_table: targetTable,
    target_id: targetId || null,
    target_label: targetLabel || null,
    details: details || {}
  };
  const { error } = await sb.from('activity_log').insert(payload);
  if (error) console.warn('Activity log skipped:', error.message);
}

async function checkDuplicate(billId, warnId) {
  const warn = document.getElementById(warnId);
  if (!billId || !warn || !currentUser) return;
  warn.style.display = 'none';
  const { data } = await sb.from('questions')
    .select('question_id,status,archived_at,is_archived')
    .eq('task_id', billId)
    .eq('submitter_email', currentUser.email)
    .order('submitted_at', { ascending: false })
    .limit(3);
  const q = (data || []).find(item => !isArchived(item));
  if (!q) return;
  if (q.status === 'Answered') {
    warn.className = 'duplicate-warning dup-answered';
    warn.textContent = `ℹ️ Bill ID ${billId} already has an answered question (${q.question_id}). Check the Answered tab before submitting a new one.`;
  } else {
    warn.className = 'duplicate-warning dup-open';
    warn.textContent = `⚠️ You already have an active question for Bill ID ${billId} (${q.question_id}). Check All Questions for the status.`;
  }
  warn.style.display = 'block';
}

async function submitQuestion() {
  const taskId = document.getElementById('f-task-id').value.trim();
  const question = document.getElementById('f-question').value.trim();
  const issueField = document.getElementById('f-priority').value;
  if (!taskId) { toast('Please enter a Bill ID', 'error'); return; }
  if (!question) { toast('Please enter your question', 'error'); return; }
  if (question.length < 10) { toast('Question must be at least 10 characters', 'error'); return; }

  const btn = document.getElementById('btn-submit');
  const btnText = document.getElementById('submit-btn-text');
  btn.disabled = true;
  btnText.textContent = 'Submitting...';

  const name = currentUser.user_metadata?.full_name || currentUser.email.split('@')[0];
  const email = currentUser.email;
  const { data, error } = await sb.from('questions').insert(makeQuestionInsertPayload({
    submitter_name: name,
    submitter_email: email,
    task_id: taskId,
    question,
    issue_field: issueField,
    status: 'Open'
  })).select().single();

  if (error) {
    toast('Failed to submit: ' + error.message, 'error');
    btn.disabled = false;
    btnText.textContent = 'Submit Question';
    return;
  }

  await logActivity('QUESTION_CREATED', 'questions', data.id, data.question_id || taskId, { bill_id: taskId, issue_field: issueField });
  document.getElementById('success-title').textContent = 'Question submitted!';
  document.getElementById('success-qid').textContent = `Your Question ID: ${data.question_id}\nSLA due date: ${fmtDateFull(data.due_at || getQuestionDueAt(data))}`;
  document.getElementById('submit-form-wrap').style.display = 'none';
  document.getElementById('submit-success').style.display = 'block';
}

function renderBulkRows() {
  const wrap = document.getElementById('bulk-rows-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let n = 1; n <= BULK_MAX_ROWS; n++) {
    const div = document.createElement('div');
    div.className = 'bulk-row';
    div.id = `bulk-row-${n}`;
    div.innerHTML = `
      <div><span class="bulk-row-num">${n}</span></div>
      <div>
        <input type="text" class="form-input" id="br-task-${n}" placeholder="Bill ID" style="font-size:13px;padding:8px 10px" oninput="updateBulkReadyCount()" onblur="checkDuplicate(this.value.trim(),'br-dup-${n}')">
        <div class="duplicate-warning" id="br-dup-${n}"></div>
      </div>
      <select class="form-select" id="br-priority-${n}" style="font-size:13px;padding:8px 10px" onchange="updateBulkReadyCount()">${issueFieldOptionsHtml('Vendor')}</select>
      <div>
        <textarea class="form-textarea" id="br-q-${n}" maxlength="500" placeholder="Your question (min 10 chars)" style="min-height:70px;font-size:13px;padding:8px 10px" oninput="updateCharCount('br-q-${n}','br-counter-${n}'); updateBulkReadyCount()"></textarea>
        <div class="char-counter" id="br-counter-${n}">0 / 500 characters</div>
      </div>
      <div class="bulk-row-actions">
        <button type="button" class="btn-clear-row" onclick="clearBulkRow(${n})" title="Clear this row">Clear</button>
      </div>
      <div class="bulk-row-error" id="br-error-${n}"></div>`;
    wrap.appendChild(div);
  }
  bulkRowCount = BULK_MAX_ROWS;
  updateBulkReadyCount();
}

async function submitBulk() {
  ensureBulkRows();
  const { name, email } = getBulkNameEmail();
  const rows = [];
  const errors = [];
  // Issue 1F: side-channel of per-row attachments collected by the bulk wrapper.
  const bulkAtt = (window.__pendingBulkAttachments && typeof window.__pendingBulkAttachments === 'object')
    ? window.__pendingBulkAttachments : {};
  window.__pendingBulkAttachments = null;
  for (let n = 1; n <= BULK_MAX_ROWS; n++) {
    const row = getBulkRowValues(n);
    const validation = getBulkRowValidation(row);
    if (validation.state === 'empty') continue;
    if (validation.state === 'invalid') {
      errors.push(`Row ${n}: ${validation.errors.join(' ')}`);
      continue;
    }
    rows.push(makeQuestionInsertPayload({
      submitter_name: name,
      submitter_email: email,
      task_id: row.taskId,
      question: row.question,
      issue_field: row.priority,
      status: 'Open',
      attachments: Array.isArray(bulkAtt[String(n)]) ? bulkAtt[String(n)] : []
    }));
  }

  updateBulkReadyCount();
  const validationSummary = document.getElementById('bulk-validation-summary');
  if (errors.length > 0) {
    if (validationSummary) {
      validationSummary.innerHTML = errors.map(escHtml).join('<br>');
      validationSummary.style.display = 'block';
    }
    toast(errors[0], 'error');
    return;
  }
  if (rows.length === 0) {
    if (validationSummary) {
      validationSummary.textContent = 'Please complete at least one row. Empty rows are allowed, but at least one question is needed to submit.';
      validationSummary.style.display = 'block';
    }
    toast('Please complete at least one question', 'error');
    return;
  }

  const btn = document.getElementById('btn-bulk-submit');
  const btnText = document.getElementById('bulk-btn-text');
  btn.disabled = true;
  btnText.textContent = `Submitting ${rows.length} question${rows.length !== 1 ? 's' : ''}...`;
  let result = await sb.from('questions').insert(rows).select();
  // Issue 1F: gracefully retry without attachments if column not yet present.
  if (result.error && /attachments|column/i.test(result.error.message || '')) {
    const stripped = rows.map(r => { const c = { ...r }; delete c.attachments; return c; });
    result = await sb.from('questions').insert(stripped).select();
  }
  const { data, error } = result;
  if (error) {
    toast('Failed to submit: ' + error.message, 'error');
    btn.disabled = false;
    updateBulkReadyCount();
    return;
  }

  for (const q of (data || [])) await logActivity('QUESTION_CREATED', 'questions', q.id, q.question_id || q.task_id, { bill_id: q.task_id, issue_field: getIssueField(q), bulk: true });
  const ids = (data || []).map(d => `${d.question_id} · due ${fmtDate(d.due_at || getQuestionDueAt(d))}`).join('\n');
  document.getElementById('success-title').textContent = `${rows.length} Question${rows.length !== 1 ? 's' : ''} submitted!`;
  document.getElementById('success-qid').textContent = `Question IDs:\n${ids}`;
  document.getElementById('submit-form-wrap').style.display = 'none';
  document.getElementById('submit-success').style.display = 'block';
}

function clearForm() {
  document.getElementById('f-task-id').value = '';
  document.getElementById('f-question').value = '';
  const first = getActiveIssueFields()[0]?.name || 'Vendor';
  const select = document.getElementById('f-priority');
  if (select) select.value = first;
  const dup = document.getElementById('dup-warn');
  if (dup) dup.style.display = 'none';
  const counter = document.getElementById('q-counter');
  if (counter) {
    counter.textContent = '0 / 500 characters';
    counter.className = 'char-counter';
  }
  // Issue 1B: Clear button is the canonical way to wipe saved draft data.
  try { clearSavedDraft(); } catch (_e) {}
}

function clearBulkRow(n) {
  const task = document.getElementById(`br-task-${n}`);
  const question = document.getElementById(`br-q-${n}`);
  const priority = document.getElementById(`br-priority-${n}`);
  const dup = document.getElementById(`br-dup-${n}`);
  if (task) task.value = '';
  if (question) question.value = '';
  if (priority) priority.value = getActiveIssueFields()[0]?.name || 'Vendor';
  if (dup) dup.style.display = 'none';
  updateCharCount(`br-q-${n}`, `br-counter-${n}`);
  updateBulkReadyCount();
}

// Issue 4A: in-flight guard + initSettled wait + timeout safety for Review page.
// Issue 4C: render an Access Denied panel inside the page once permissions
// confirm the user is not a reviewer, instead of silently redirecting away.
window.__reviewLoading = window.__reviewLoading || false;
async function loadReviewData() {
  const wrap = document.getElementById('review-table-wrap');
  if (!wrap) return;
  if (window.__reviewLoading) return;
  if (!window.initSettled) {
    wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Connecting...</div>';
    if (!window.__reviewConnectingSince) window.__reviewConnectingSince = Date.now();
    if (Date.now() - window.__reviewConnectingSince < 3000) {
      setTimeout(loadReviewData, 200);
      return;
    }
  }
  window.__reviewConnectingSince = null;
  // Once permissions are loaded, confirm the user is allowed here.
  if (window.reviewersLoaded && !isReviewer()) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">🔒</div><h3>Access Denied</h3><p>You are not authorized to view the Review page. If you believe this is a mistake, please contact an administrator.</p></div>';
    return;
  }
  window.__reviewLoading = true;
  wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading questions...</div>';
  try {
    const queryPromise = sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at', { ascending: false }).limit(AppAPI.PAGE_SIZE);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), 15000));
    const result = await Promise.race([queryPromise, timeoutPromise]);
    if (result && result.__timeout) {
      wrap.innerHTML = '<div class="empty"><div class="empty-icon">⏱️</div><h3>Loading is taking longer than expected</h3><p>Check your connection and try again.</p><button class="btn btn-primary" onclick="loadReviewData()" style="margin-top:12px">↻ Retry</button></div>';
      return;
    }
    const { data, error } = result;
    if (error) {
      wrap.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Error loading data</h3><p>${escHtml(error.message)}</p><button class="btn btn-primary" onclick="loadReviewData()" style="margin-top:12px">↻ Retry</button></div>`;
      return;
    }
    allQuestions = (data || []).map(normalizeQuestionRecord).filter(q => !isArchived(q));
    await loadCommentStatsForQuestions(allQuestions.map(q => q.id));
    updateStats();
    renderReviewQueueTabs();
    renderReviewTable();
  } finally {
    window.__reviewLoading = false;
  }
}

function updateStats() {
  const active = (allQuestions || []).filter(q => !isArchived(q));
  const dueToday = active.filter(q => getSlaInfo(q).key === 'due-today').length;
  const overdue = active.filter(q => getSlaInfo(q).key === 'overdue').length;
  const answeredOnTime = active.filter(q => getSlaInfo(q).key === 'answered-on-time').length;
  const openCount = active.filter(q => q.status === 'Open').length;
  const unresolvedFollowUps = getTotalUnresolvedFollowUps();
  safeText('stat-total', active.length);
  safeText('stat-open', openCount);
  safeText('stat-due-today', dueToday);
  safeText('stat-overdue', overdue);
  safeText('stat-answered', active.filter(q => q.status === 'Answered').length);
  safeText('stat-answered-on-time', answeredOnTime);
  safeText('stat-high', unresolvedFollowUps);

  const alert = document.getElementById('reviewer-alert');
  const alertText = document.getElementById('reviewer-alert-text');
  const alertBtn = alert ? alert.querySelector('button') : null;
  if (unresolvedFollowUps > 0) {
    alertText.textContent = `📝 ${unresolvedFollowUps} unresolved follow-up${unresolvedFollowUps !== 1 ? 's' : ''} need reviewer attention.`;
    if (alertBtn) {
      alertBtn.textContent = 'View follow-ups';
      alertBtn.onclick = () => { activeQueueFilter = 'followups'; renderReviewQueueTabs(); renderReviewTable(); alert.classList.add('hidden'); };
    }
    alert.classList.remove('hidden');
  } else if (overdue > 0) {
    alertText.textContent = `🚨 ${overdue} question${overdue !== 1 ? 's are' : ' is'} overdue.`;
    if (alertBtn) {
      alertBtn.textContent = 'View overdue';
      alertBtn.onclick = () => { activeQueueFilter = 'overdue'; renderReviewQueueTabs(); renderReviewTable(); alert.classList.add('hidden'); };
    }
    alert.classList.remove('hidden');
  } else if (openCount >= 10) {
    alertText.textContent = `⚠️ ${openCount} questions are waiting for an answer.`;
    if (alertBtn) {
      alertBtn.textContent = 'View open questions';
      alertBtn.onclick = filterOpenOnly;
    }
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }
  updateReviewNavBadge();
}

function renderReviewQueueTabs() {
  const filtersRow = document.querySelector('#page-review .filters-row');
  if (!filtersRow) return;
  let tabs = document.getElementById('review-queue-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'review-queue-tabs';
    tabs.className = 'work-queue-tabs';
    filtersRow.parentNode.insertBefore(tabs, filtersRow);
  }
  const queueItems = [
    ['', 'All active'],
    ['needs-answer', 'Needs answer'],
    ['due-today', 'Due today'],
    ['overdue', 'Overdue'],
    ['followups', 'Follow-ups'],
    ['answered', 'Answered']
  ];
  tabs.innerHTML = queueItems.map(([key, label]) =>
    `<button class="queue-tab ${activeQueueFilter === key ? 'active' : ''}" onclick="setReviewQueueFilter('${key}')">${label}</button>`
  ).join('');
}

function setReviewQueueFilter(key) {
  activeQueueFilter = key;
  renderReviewQueueTabs();
  renderReviewTable();
}

function getFilteredReviewQuestions() {
  const status = document.getElementById('r-filter-status')?.value || '';
  const issueField = document.getElementById('r-filter-priority')?.value || '';
  const sla = document.getElementById('r-filter-sla')?.value || '';
  const search = (document.getElementById('r-search')?.value || '').toLowerCase();
  let filtered = (allQuestions || []).filter(q => !isArchived(q));

  filtered = filtered.filter(q => {
    const field = getIssueField(q);
    const slaInfo = getSlaInfo(q);
    if (status && q.status !== status) return false;
    if (issueField && field !== issueField) return false;
    if (sla && slaInfo.key !== sla) return false;
    if (activeQueueFilter === 'needs-answer' && !['Open','In Review'].includes(q.status)) return false;
    if (activeQueueFilter === 'due-today' && slaInfo.key !== 'due-today') return false;
    if (activeQueueFilter === 'overdue' && slaInfo.key !== 'overdue') return false;
    if (activeQueueFilter === 'followups' && getCommentStats(q.id).unresolved < 1) return false;
    if (activeQueueFilter === 'answered' && q.status !== 'Answered') return false;
    if (search &&
        !(q.task_id || '').toLowerCase().includes(search) &&
        !(q.question || '').toLowerCase().includes(search) &&
        !(q.submitter_name || '').toLowerCase().includes(search) &&
        !(q.submitter_email || '').toLowerCase().includes(search) &&
        !field.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const ar = getSlaInfo(a).rank;
    const br = getSlaInfo(b).rank;
    if (ar !== br) return ar - br;
    return new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0);
  });
  return filtered;
}

function renderReviewTable() {
  const filtered = getFilteredReviewQuestions();
  lastReviewFiltered = filtered;
  safeText('r-count', `${filtered.length} question${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('review-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">📭</div><h3>No matching questions</h3><p>Try clearing filters or searching by Bill ID, staff name, issue field, or status.</p></div>';
    return;
  }
  const rows = filtered.map(q => `
    <tr onclick="openModal('${q.id}')" style="cursor:pointer">
      <td class="cb-wrap" onclick="event.stopPropagation()"><input type="checkbox" class="row-cb question-cb" data-id="${q.id}" onchange="updateSelectBar()"></td>
      <td class="td-id">${escHtml(q.question_id || '—')}</td>
      <td class="td-task">${escHtml(q.task_id)}</td>
      <td class="td-q">${escHtml(q.question)}${getCommentStats(q.id).total > 0 ? `<div style="margin-top:6px">${renderFollowUpBadge(q.id)}</div>` : ''}</td>
      <td class="td-name">${escHtml(q.submitter_name || '')}</td>
      <td>${issueBadge(getIssueField(q))}</td>
      <td>${renderSlaBadge(q)}</td>
      <td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td>
      <td class="td-date">${fmtDate(q.submitted_at)}</td>
      <td class="td-date">${fmtDate(getQuestionDueAt(q))}</td>
      <td class="td-date">${q.answered_date ? fmtDate(q.answered_date) : '—'}</td>
    </tr>`).join('');
  document.getElementById('review-table-wrap').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:40px"><input type="checkbox" class="row-cb" id="cb-all" onclick="toggleAll(this)" title="Select all"></th>
          <th>ID</th><th>Bill ID</th><th>Question</th><th>From</th><th>Issue Field</th><th>SLA</th><th>Status</th><th>Submitted</th><th>Due</th><th>Answered</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function openModal(id) {
  currentQ = allQuestions.find(q => q.id === id) || adminQuestions.find(q => q.id === id) || archivedQuestions.find(q => q.id === id);
  if (!currentQ) return;
  const q = currentQ;
  document.getElementById('modal-title').textContent = `${q.question_id || 'Question'} — ${q.task_id}`;
  document.getElementById('modal-meta').innerHTML = `${issueBadge(getIssueField(q))}${renderSlaBadge(q)}<span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span>`;
  document.getElementById('modal-body').innerHTML = `
    <div class="detail-meta">
      <span class="pill-muted">Submitted ${fmtDateFull(q.submitted_at)}</span>
      <span class="pill-muted">Due ${fmtDateFull(getQuestionDueAt(q))}</span>
      ${q.answered_date ? `<span class="pill-muted">Answered ${fmtDateFull(q.answered_date)}</span>` : ''}
    </div>
    <div class="detail-block"><div class="detail-label">From</div><div class="detail-value">${escHtml(q.submitter_name || '')} &nbsp;·&nbsp; <span style="color:var(--text3)">${escHtml(q.submitter_email || '')}</span></div></div>
    <div class="detail-block"><div class="detail-label">Question</div><div class="detail-box">${escHtml(q.question)}</div></div>
    ${renderQuestionAttachmentsBlock(q)}
    ${q.links ? `<div class="detail-block"><div class="detail-label">Links</div><div class="detail-value"><a href="${escHtml(q.links)}" target="_blank" style="color:var(--accent2)">${escHtml(q.links)}</a></div></div>` : ''}
    <div class="section-divider"></div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="m-status">
          <option ${q.status==='Open'?'selected':''}>Open</option>
          <option ${q.status==='In Review'?'selected':''}>In Review</option>
          <option ${q.status==='Answered'?'selected':''}>Answered</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Issue Field</label>
        <select class="form-select" id="m-issue-field">${issueFieldOptionsHtml(getIssueField(q))}</select>
      </div>
    </div>
    <div class="form-group answer-editor-group"><label class="form-label">Answer</label><textarea class="form-textarea" id="m-answer" placeholder="Type your answer here..." oninput="autoSetAnsweredFromReply()">${escHtml(q.answer || '')}</textarea><div class="answer-inline-actions"><button type="button" class="btn btn-success btn-sm answer-inline-save" onclick="saveAnswer()">Answer</button><span class="form-hint">Saves this reply the same way as the Save answer button below.</span></div></div>
    <div class="form-group"><label class="form-label">Internal remarks <span style="color:var(--text3);font-weight:400">(not sent to submitter)</span></label><textarea class="form-textarea" id="m-remarks" style="min-height:80px" placeholder="Internal notes...">${escHtml(q.remarks || '')}</textarea></div>
    <div class="comments-section modal-comments-section" onclick="event.stopPropagation()">
      <div class="comments-header-row"><div><div class="comments-header">Follow-up thread</div><div class="comments-subtitle">Reply to staff follow-ups or add clarifications. Replies stay threaded below the parent comment.</div></div><span id="modal-followup-badge" class="${followUpBadgeClass(q.id)}">${followUpBadgeText(q.id)}</span></div>
      <div id="modal-comments-content"><div class="comment-loading"><div class="spinner" style="width:14px;height:14px"></div> Loading follow-ups...</div></div>
    </div>`;
  const archiveBtn = isAdmin() && !isArchived(q) ? `<button class="btn btn-outline" onclick="archiveOne('${q.id}')">Archive</button>` : '';
  document.getElementById('modal-footer').innerHTML = `${archiveBtn}<button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-success" onclick="saveAnswer()">Save answer</button>`;
  document.getElementById('modal-overlay').classList.add('open');
  loadModalComments(q.id);
}

function autoSetAnsweredFromReply() {
  const answerEl = document.getElementById('m-answer');
  const statusEl = document.getElementById('m-status');
  if (answerEl && statusEl && answerEl.value.trim().length > 0 && statusEl.value !== 'Answered') {
    statusEl.value = 'Answered';
  }
}

async function saveAnswer() {
  const status = document.getElementById('m-status').value;
  const answer = document.getElementById('m-answer').value.trim();
  const remarks = document.getElementById('m-remarks').value.trim();
  const issueField = document.getElementById('m-issue-field').value;
  if (status === 'Answered' && !answer) { toast('Please add an answer before marking as Answered', 'error'); return; }
  const oldStatus = currentQ.status;
  const oldAnswer = currentQ.answer || '';
  const updates = {
    status,
    issue_field: issueField,
    priority: issueField,
    answer: answer || null,
    remarks: remarks || null,
    answered_by: currentUser.user_metadata?.full_name || currentUser.email,
    answered_date: status === 'Answered' ? (currentQ.answered_date || new Date().toISOString()) : null
  };
  const { data, error } = await sb.from('questions').update(updates).eq('id', currentQ.id).select().single();
  if (error) { toast('Error saving: ' + error.message, 'error'); return; }

  const idx = allQuestions.findIndex(q => q.id === currentQ.id);
  if (idx > -1) allQuestions[idx] = { ...allQuestions[idx], ...updates, ...data };
  const adminIdx = adminQuestions.findIndex(q => q.id === currentQ.id);
  if (adminIdx > -1) adminQuestions[adminIdx] = { ...adminQuestions[adminIdx], ...updates, ...data };

  if (oldStatus !== status) await logActivity('STATUS_CHANGED', 'questions', currentQ.id, currentQ.question_id || currentQ.task_id, { from: oldStatus, to: status });
  if (answer && answer !== oldAnswer) await logActivity(oldAnswer ? 'ANSWER_EDITED' : 'ANSWER_ADDED', 'questions', currentQ.id, currentQ.question_id || currentQ.task_id, { status, issue_field: issueField });
  await logActivity('QUESTION_UPDATED', 'questions', currentQ.id, currentQ.question_id || currentQ.task_id, { status, issue_field: issueField });

  updateStats();
  renderReviewTable();
  closeModal();
  toast(status === 'Answered' ? '✓ Answer saved and visible in the Answered tab' : '✓ Question updated', 'success');
}

async function archiveSelected() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  const reason = prompt(`Archive ${ids.length} question${ids.length > 1 ? 's' : ''}?\n\nArchived questions are hidden from active views but can be restored from Admin Dashboard.\n\nReason:`, 'Resolved / no longer needed') || '';
  const confirmed = confirm(`Archive ${ids.length} question${ids.length > 1 ? 's' : ''}? This will not permanently delete data.`);
  if (!confirmed) return;
  const updates = { is_archived: true, archived_at: new Date().toISOString(), archived_by: currentUser.email, archive_reason: reason };
  const { error } = await sb.from('questions').update(updates).in('id', ids);
  if (error) { toast('Archive failed: ' + error.message, 'error'); return; }
  for (const id of ids) {
    const q = allQuestions.find(item => item.id === id);
    await logActivity('QUESTION_ARCHIVED', 'questions', id, q?.question_id || q?.task_id || id, { reason });
  }
  allQuestions = allQuestions.filter(q => !ids.includes(q.id));
  updateStats();
  renderReviewTable();
  clearSelection();
  toast(`✓ ${ids.length} question${ids.length > 1 ? 's' : ''} archived safely`, 'success');
}

async function archiveOne(id) {
  const q = (allQuestions || []).find(item => item.id === id) || (adminQuestions || []).find(item => item.id === id);
  if (!q) return;
  const reason = prompt(`Archive ${q.question_id || q.task_id}?\n\nArchived questions are hidden from active views but can be restored from Admin Dashboard.\n\nReason:`, 'Resolved / no longer needed') || '';
  if (!confirm(`Archive ${q.question_id || q.task_id}? This will not permanently delete data.`)) return;
  const updates = { is_archived: true, archived_at: new Date().toISOString(), archived_by: currentUser.email, archive_reason: reason };
  const { error } = await sb.from('questions').update(updates).eq('id', id);
  if (error) { toast('Archive failed: ' + error.message, 'error'); return; }
  await logActivity('QUESTION_ARCHIVED', 'questions', id, q.question_id || q.task_id, { reason });
  allQuestions = allQuestions.filter(item => item.id !== id);
  adminQuestions = adminQuestions.map(item => item.id === id ? { ...item, ...updates } : item);
  updateStats();
  renderReviewTable();
  closeModal();
  toast('✓ Question archived safely', 'success');
}

async function deleteSelected() {
  await archiveSelected();
}

async function loadFaqData() {
  document.getElementById('faq-list').innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
  const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).eq('status', 'Answered').order('answered_date', { ascending: false }).limit(AppAPI.PAGE_SIZE);
  if (error) {
    document.getElementById('faq-list').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Error</h3><p>${escHtml(error.message)}</p></div>`;
    return;
  }
  faqQuestions = (data || []).map(normalizeQuestionRecord).filter(q => !isArchived(q));
  await loadCommentStatsForQuestions(faqQuestions.map(q => q.id));
  updateIssueFieldControls();
  renderFaq();
}

function setFaqFilter(el) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  faqFilter = el.dataset.filter;
  renderFaq();
}

function renderFaq() {
  const search = (document.getElementById('faq-search').value || '').toLowerCase();
  const sortVal = document.getElementById('faq-sort') ? document.getElementById('faq-sort').value : 'newest';
  let filtered = (faqQuestions || []).filter(q => {
    const field = getIssueField(q);
    if (faqFilter && field !== faqFilter) return false;
    if (search &&
        !(q.task_id || '').toLowerCase().includes(search) &&
        !(q.question_id || '').toLowerCase().includes(search) &&
        !(q.question || '').toLowerCase().includes(search) &&
        !(q.answer || '').toLowerCase().includes(search) &&
        !(q.submitter_name || '').toLowerCase().includes(search) &&
        !field.toLowerCase().includes(search)) return false;
    return true;
  });
  filtered.sort((a,b) => {
    if (sortVal === 'oldest') return new Date(a.answered_date || 0) - new Date(b.answered_date || 0);
    if (sortVal === 'billid') return (a.task_id || '').localeCompare(b.task_id || '');
    if (sortVal === 'issue') return getIssueField(a).localeCompare(getIssueField(b));
    return new Date(b.answered_date || 0) - new Date(a.answered_date || 0);
  });
  safeText('faq-count', `${filtered.length} answer${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('faq-list').innerHTML = `<div class="faq-count">${faqQuestions.length} total answered questions</div><div class="empty"><div class="empty-icon">🔍</div><h3>No results found</h3><p>Try different keywords or clear the search.</p></div>`;
    return;
  }
  const html = filtered.map(q => {
    const answerEncoded = encodeURIComponent(q.answer || '');
    return `
    <div class="faq-card" data-question-id="${q.id}" onclick="toggleFaqCard(this,event)">
      <div class="faq-card-top"><div class="faq-meta"><span style="font-size:12px;color:var(--text3);font-weight:500">Bill ID:</span><span class="faq-task">${escHtml(q.task_id)}</span><span style="font-size:12px;color:var(--text3);font-weight:500;margin-left:8px">Issue:</span>${issueBadge(getIssueField(q))}${renderFollowUpBadge(q.id)}${renderSlaBadge(q)}</div><span style="color:var(--text3); font-size:13px; flex-shrink:0; font-weight:500">Ref: ${escHtml(q.question_id || '')}</span></div>
      <div style="margin-bottom:6px"><span style="font-size:12px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.4px">Question</span><div class="faq-question" style="margin-top:4px">${escHtml(q.question)}</div></div>
      <div style="border-top:1px dashed var(--border);margin:10px 0"></div>
      <div><span style="font-size:12px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:0.4px">Answer</span><div class="faq-answer-preview" style="margin-top:4px;font-weight:600;color:var(--text)">${escHtml(q.answer || '')}</div></div>
      <button class="copy-answer-btn" onclick="event.stopPropagation();copyAnswer(this, decodeURIComponent('${answerEncoded}'))">📋 Copy Answer</button>
      <div class="faq-footer"><span><span style="color:var(--text3)">Submitted by:</span> ${escHtml(q.submitter_name || '')} &nbsp;·&nbsp; <span style="color:var(--text3)">Answered by:</span> ${escHtml(q.answered_by || 'Reviewer')} &nbsp;·&nbsp; <span style="color:var(--text3)">Answered on:</span> ${fmtDate(q.answered_date)}</span><span style="color:var(--accent2); font-size:12px">Click to expand ▾</span></div>
      <div class="comments-section faq-comments-section" id="${faqCommentsSectionId(q.id)}" data-question-id="${q.id}" data-loaded="false" onclick="event.stopPropagation()" style="display:none"><div class="comments-header-row"><div><div class="comments-header">Follow-ups</div></div>${renderFollowUpBadge(q.id)}</div><div class="comment-loading">Expand this answer to load follow-ups.</div></div>
    </div>`;
  }).join('');
  document.getElementById('faq-list').innerHTML = `<div class="faq-count">${faqQuestions.length} total answered questions</div>` + html;
}

// Issue 3A: in-flight guard + initSettled wait + timeout safety for All Questions.
window.__allQLoading = window.__allQLoading || false;
async function loadAllQData() {
  if (window.__allQLoading) return;
  const wrap = document.getElementById('allq-table-wrap');
  if (!wrap) return;
  // If init is still settling, show "Connecting..." and retry after a short delay
  // (up to ~3 seconds total). This prevents the concurrent-query connection-pool race.
  if (!window.initSettled) {
    wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Connecting...</div>';
    if (!window.__allQConnectingSince) window.__allQConnectingSince = Date.now();
    if (Date.now() - window.__allQConnectingSince < 3000) {
      setTimeout(loadAllQData, 200);
      return;
    }
    // Beyond 3 seconds, proceed anyway with a clear status.
  }
  window.__allQConnectingSince = null;
  window.__allQLoading = true;
  wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading questions...</div>';
  try {
    const queryPromise = sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at', { ascending: false }).limit(AppAPI.PAGE_SIZE);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), 15000));
    const result = await Promise.race([queryPromise, timeoutPromise]);
    if (result && result.__timeout) {
      wrap.innerHTML = '<div class="empty"><div class="empty-icon">⏱️</div><h3>Loading is taking longer than expected</h3><p>Check your connection and try again.</p><button class="btn btn-primary" onclick="loadAllQData()" style="margin-top:12px">↻ Retry</button></div>';
      return;
    }
    const { data, error } = result;
    if (error) {
      wrap.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Error</h3><p>${escHtml(error.message)}</p><button class="btn btn-primary" onclick="loadAllQData()" style="margin-top:12px">↻ Retry</button></div>`;
      return;
    }
    allQData = (data || []).map(normalizeQuestionRecord).filter(q => !isArchived(q));
    await loadCommentStatsForQuestions(allQData.map(q => q.id));
    renderAllQ();
  } finally {
    window.__allQLoading = false;
  }
}

function renderAllQ() {
  const status = document.getElementById('aq-filter-status')?.value || '';
  const issueField = document.getElementById('aq-filter-priority')?.value || '';
  const sla = document.getElementById('aq-filter-sla')?.value || '';
  const search = (document.getElementById('aq-search')?.value || '').toLowerCase();
  let filtered = (allQData || []).filter(q => {
    const field = getIssueField(q);
    const slaInfo = getSlaInfo(q);
    if (status && q.status !== status) return false;
    if (issueField && field !== issueField) return false;
    if (sla && slaInfo.key !== sla) return false;
    if (search &&
        !(q.task_id || '').toLowerCase().includes(search) &&
        !(q.question || '').toLowerCase().includes(search) &&
        !(q.submitter_name || '').toLowerCase().includes(search) &&
        !field.toLowerCase().includes(search)) return false;
    return true;
  });
  filtered.sort((a,b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
  safeText('aq-count', `${filtered.length} question${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('allq-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">📭</div><h3>No matching questions</h3><p>Try clearing filters or searching by Bill ID, staff name, issue field, or SLA status.</p></div>';
    return;
  }
  const rows = filtered.map(q => `
    <tr data-task-id="${escAttr(q.task_id)}" data-status="${escAttr(q.status)}" onclick="allQRowClick(this.dataset.taskId,this.dataset.status)" style="cursor:pointer" title="${q.status === 'Answered' ? 'View answer' : 'Not yet answered'}">
      <td class="td-id">${escHtml(q.question_id || '—')}</td><td class="td-task" style="color:var(--accent2);font-weight:600">${escHtml(q.task_id)}</td><td class="td-q">${escHtml(q.question)}${getCommentStats(q.id).total > 0 ? `<div style="margin-top:6px">${renderFollowUpBadge(q.id)}</div>` : ''}</td><td class="td-name">${escHtml(q.submitter_name || '')}</td><td>${issueBadge(getIssueField(q))}</td><td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td><td class="td-date">${fmtDate(q.submitted_at)}</td>
    </tr>`).join('');
  document.getElementById('allq-table-wrap').innerHTML = `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Bill ID</th><th>Question</th><th>From</th><th>Issue Field</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadAdminPanel() {
  if (!isAdmin()) return;
  safeText('admin-current-user', `${currentUser.user_metadata?.full_name || currentUser.email.split('@')[0]} · ${currentUser.email}`);
  safeValue('admin-sla-days', getSlaDays());
  safeValue('admin-sla-timezone', slaSettings.timezone || 'Asia/Kathmandu');
  renderReviewersList();
  renderIssueFieldsList();
  await Promise.all([loadAdminOverview(), loadArchiveData(), loadActivityLog()]);
}

async function loadAdminOverview() {
  const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at', { ascending: false }).limit(AppAPI.PAGE_SIZE);
  if (error) { toast('Admin dashboard could not load questions: ' + error.message, 'error'); return; }
  adminQuestions = (data || []).map(normalizeQuestionRecord);
  const active = adminQuestions.filter(q => !isArchived(q));
  const archive = adminQuestions.filter(q => isArchived(q));
  await loadCommentStatsForQuestions(active.map(q => q.id));
  safeText('admin-stat-total', active.length);
  safeText('admin-stat-due', active.filter(q => getSlaInfo(q).key === 'due-today').length);
  safeText('admin-stat-overdue', active.filter(q => getSlaInfo(q).key === 'overdue').length);
  safeText('admin-stat-ontime', active.filter(q => getSlaInfo(q).key === 'answered-on-time').length);
  safeText('admin-stat-open', active.filter(q => q.status === 'Open').length);
  safeText('admin-stat-review', active.filter(q => q.status === 'In Review').length);
  safeText('admin-stat-followups', getTotalUnresolvedFollowUps());
  safeText('admin-stat-archived', archive.length);
}

async function saveSlaSettings() {
  const responseDays = Math.max(1, Number(document.getElementById('admin-sla-days')?.value || 2));
  const timezone = (document.getElementById('admin-sla-timezone')?.value || 'Asia/Kathmandu').trim();
  const payload = { id: 1, response_days: responseDays, exclude_weekends: true, timezone, updated_at: new Date().toISOString(), updated_by: currentUser.email };
  const { error } = await sb.from('sla_settings').upsert(payload, { onConflict: 'id' });
  if (error) { toast('Could not save SLA settings: ' + error.message, 'error'); return; }
  slaSettings = { response_days: responseDays, exclude_weekends: true, timezone };
  await logActivity('SLA_SETTINGS_UPDATED', 'sla_settings', null, 'SLA Settings', payload);
  toast('✓ SLA settings updated', 'success');
  await loadAdminOverview();
}

async function addReviewer() {
  const email = document.getElementById('admin-email-input').value.trim().toLowerCase();
  if (!email) { toast('Please enter an email', 'error'); return; }
  if (!email.includes('@')) { toast('Invalid email format', 'error'); return; }
  if (allowedReviewers.includes(email)) { toast('This email is already a reviewer', 'error'); return; }
  const { error } = await sb.from('reviewers').insert({ email, created_by: currentUser.email });
  if (error) { toast('Error adding reviewer: ' + error.message, 'error'); return; }
  await logActivity('REVIEWER_ADDED', 'reviewers', null, email, { email });
  await loadAllowedReviewers();
  renderReviewersList();
  document.getElementById('admin-email-input').value = '';
  toast('✓ Reviewer access updated', 'success');
}

async function removeReviewer(email) {
  if (!confirm(`Remove ${email} as reviewer?`)) return;
  const { error } = await sb.from('reviewers').delete().eq('email', email);
  if (error) { toast('Error removing reviewer: ' + error.message, 'error'); return; }
  await logActivity('REVIEWER_REMOVED', 'reviewers', null, email, { email });
  await loadAllowedReviewers();
  renderReviewersList();
  toast('✓ Reviewer removed', 'success');
}

function renderReviewersList() {
  const list = document.getElementById('reviewers-list');
  if (!list) return;
  const unique = [...new Set([...(allowedReviewers || []), V2_ADMIN_EMAIL])].sort();
  if (unique.length === 0) {
    list.innerHTML = '<li style="justify-content:center;color:var(--text3)">No reviewers added yet</li>';
    return;
  }
  list.innerHTML = unique.map(email => `
    <li><div><div style="font-weight:700">${escHtml(email)}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${email === V2_ADMIN_EMAIL ? 'Administrator · always active' : 'Reviewer'}</div></div>${email === V2_ADMIN_EMAIL ? '<span class="pill-muted">Admin</span>' : `<button class="btn-remove-reviewer" onclick="removeReviewer('${escHtml(email)}')">Remove</button>`}</li>`).join('');
}

async function addIssueField() {
  const name = normalizeIssueName(document.getElementById('issue-name-input')?.value);
  const description = (document.getElementById('issue-description-input')?.value || '').trim();
  const color = document.getElementById('issue-color-input')?.value || 'info';
  if (!name || name === 'General') { toast('Please enter a clear issue field name', 'error'); return; }
  const nextSort = Math.max(0, ...issueFields.map(f => Number(f.sort_order || 0))) + 10;
  const payload = { name, description, color_class: color, sort_order: nextSort, is_active: true, created_by: currentUser.email, updated_at: new Date().toISOString() };
  const { error } = await sb.from('issue_fields').insert(payload);
  if (error) { toast('Could not add issue field: ' + error.message, 'error'); return; }
  await logActivity('ISSUE_FIELD_CREATED', 'issue_fields', null, name, payload);
  document.getElementById('issue-name-input').value = '';
  document.getElementById('issue-description-input').value = '';
  await loadIssueFields();
  renderIssueFieldsList();
  toast('✓ Issue field created', 'success');
}

async function editIssueField(id) {
  const field = issueFields.find(f => f.id === id);
  if (!field) return;
  const name = normalizeIssueName(prompt('Issue field name:', field.name) || field.name);
  const description = prompt('Description:', field.description || '') || '';
  const sortRaw = prompt('Sort order:', String(field.sort_order || 0));
  const sortOrder = Number(sortRaw || field.sort_order || 0);
  const { error } = await sb.from('issue_fields').update({ name, description, sort_order: sortOrder, updated_at: new Date().toISOString(), updated_by: currentUser.email }).eq('id', id);
  if (error) { toast('Could not update issue field: ' + error.message, 'error'); return; }
  await logActivity('ISSUE_FIELD_UPDATED', 'issue_fields', id, name, { old_name: field.name, name, description, sort_order: sortOrder });
  await loadIssueFields();
  renderIssueFieldsList();
  toast('✓ Issue field updated', 'success');
}

async function toggleIssueField(id, active) {
  const field = issueFields.find(f => f.id === id);
  if (!field) return;
  const verb = active ? 'restore' : 'disable';
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${field.name}?`)) return;
  const { error } = await sb.from('issue_fields').update({ is_active: active, updated_at: new Date().toISOString(), updated_by: currentUser.email }).eq('id', id);
  if (error) { toast('Could not update issue field: ' + error.message, 'error'); return; }
  await logActivity(active ? 'ISSUE_FIELD_RESTORED' : 'ISSUE_FIELD_DISABLED', 'issue_fields', id, field.name, { active });
  await loadIssueFields();
  renderIssueFieldsList();
  toast(active ? '✓ Issue field restored' : '✓ Issue field disabled', 'success');
}

function renderIssueFieldsList() {
  const list = document.getElementById('issue-fields-list');
  if (!list) return;
  const fields = issueFields.length ? issueFields : FALLBACK_ISSUE_FIELDS;
  list.innerHTML = fields.map(f => `
    <li style="opacity:${f.is_active === false ? 0.58 : 1}">
      <div style="display:flex;gap:10px;align-items:flex-start"><span class="issue-dot issue-color-${escHtml(f.color_class || 'info')}" style="margin-top:5px"></span><div><div style="font-weight:700">${escHtml(f.name)} ${f.is_active === false ? '<span class="pill-muted">Disabled</span>' : ''}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${escHtml(f.description || 'No description')} · sort ${escHtml(f.sort_order || 0)}</div></div></div>
      <div class="table-actions">${f.id ? `<button class="btn btn-outline btn-sm" onclick="editIssueField('${f.id}')">Edit</button><button class="btn btn-outline btn-sm" onclick="toggleIssueField('${f.id}', ${f.is_active === false})">${f.is_active === false ? 'Restore' : 'Disable'}</button>` : '<span class="pill-muted">Fallback</span>'}</div>
    </li>`).join('');
}

async function loadArchiveData() {
  const wrap = document.getElementById('archive-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading archive...</div>';
  const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('archived_at', { ascending: false, nullsFirst: false }).limit(AppAPI.PAGE_SIZE);
  if (error) {
    if (wrap) wrap.innerHTML = `<div class="empty-premium"><strong>Archive could not load</strong>${escHtml(error.message)}</div>`;
    return;
  }
  archivedQuestions = (data || []).map(normalizeQuestionRecord).filter(q => isArchived(q));
  renderArchiveTable();
}

function renderArchiveTable() {
  const wrap = document.getElementById('archive-table-wrap');
  if (!wrap) return;
  if (archivedQuestions.length === 0) {
    wrap.innerHTML = '<div class="empty-premium"><strong>No archived questions</strong>Archived questions will appear here and can be restored by an admin.</div>';
    return;
  }
  const rows = archivedQuestions.map(q => `
    <tr>
      <td class="td-id">${escHtml(q.question_id || '—')}</td><td class="td-task">${escHtml(q.task_id)}</td><td class="td-q">${escHtml(q.question)}</td><td>${issueBadge(getIssueField(q))}</td><td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td><td class="td-date">${fmtDate(q.archived_at)}</td><td class="td-name">${escHtml(q.archived_by || '')}</td><td><div class="archive-reason">${escHtml(q.archive_reason || 'No reason provided')}</div></td><td><button class="btn btn-outline btn-sm" onclick="restoreQuestion('${q.id}')">Restore</button></td>
    </tr>`).join('');
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Bill ID</th><th>Question</th><th>Issue</th><th>Status</th><th>Archived</th><th>By</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function restoreQuestion(id) {
  const q = archivedQuestions.find(item => item.id === id);
  if (!q) return;
  if (!confirm(`Restore ${q.question_id || q.task_id} to active dashboards?`)) return;
  const { error } = await sb.from('questions').update({ is_archived: false, archived_at: null, archived_by: null, archive_reason: null }).eq('id', id);
  if (error) { toast('Restore failed: ' + error.message, 'error'); return; }
  await logActivity('QUESTION_RESTORED', 'questions', id, q.question_id || q.task_id, {});
  await Promise.all([loadArchiveData(), loadAdminOverview()]);
  toast('✓ Question restored', 'success');
}

async function loadActivityLog() {
  const wrap = document.getElementById('activity-log-wrap');
  if (wrap) wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading activity...</div>';
  const { data, error } = await sb.from('activity_log').select('id,actor_email,actor_name,action,target_table,target_id,target_label,details,created_at').order('created_at', { ascending: false }).limit(80);
  if (error) {
    if (wrap) wrap.innerHTML = `<div class="empty-premium"><strong>No activity log available yet</strong>${escHtml(error.message)}</div>`;
    return;
  }
  activityLogRows = data || [];
  renderActivityLog();
}

function humanizeAction(action) {
  return String(action || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function renderActivityLog() {
  const wrap = document.getElementById('activity-log-wrap');
  if (!wrap) return;
  if (!activityLogRows.length) {
    wrap.innerHTML = '<div class="empty-premium"><strong>No activity yet</strong>Important actions such as reviewer changes, exports, answer updates, and archives will appear here.</div>';
    return;
  }
  wrap.innerHTML = activityLogRows.map(row => {
    const detailText = row.details ? Object.entries(row.details).map(([k,v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
    return `<div class="admin-log-item"><div class="admin-log-top"><span class="admin-log-action">${escHtml(humanizeAction(row.action))}</span><span class="admin-log-time">${fmtDateFull(row.created_at)}</span></div><div class="admin-log-body"><strong>${escHtml(row.actor_name || row.actor_email || 'System')}</strong> ${row.target_label ? `updated <strong>${escHtml(row.target_label)}</strong>` : 'performed an action'}${detailText ? `<br>${escHtml(detailText)}` : ''}</div></div>`;
  }).join('');
}

function questionToExportRow(q) {
  const sla = getSlaInfo(q);
  const stats = getCommentStats(q.id);
  return {
    question_id: q.question_id || '',
    bill_id: q.task_id || '',
    submitter_name: q.submitter_name || '',
    submitter_email: q.submitter_email || '',
    issue_field: getIssueField(q),
    status: q.status || '',
    sla_status: sla.label,
    submitted_at: q.submitted_at || '',
    due_at: getQuestionDueAt(q).toISOString(),
    answered_date: q.answered_date || '',
    answered_by: q.answered_by || '',
    question: q.question || '',
    answer: q.answer || '',
    remarks: q.remarks || '',
    follow_up_count: stats.total || 0,
    unresolved_follow_up_count: stats.unresolved || 0,
    archived_at: q.archived_at || '',
    archived_by: q.archived_by || '',
    archive_reason: q.archive_reason || ''
  };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, rows) {
  if (!rows.length) { toast('Nothing to export for this view', 'error'); return; }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function todayStamp() {
  return new Date().toISOString().slice(0,10);
}

async function exportQuestionsCsv(scope = 'current') {
  let source = [];
  if (scope === 'current') {
    if (!allQuestions.length) {
      const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at', { ascending: false }).limit(AppAPI.PAGE_SIZE);
      if (error) { toast('Export failed: ' + error.message, 'error'); return; }
      allQuestions = (data || []).map(normalizeQuestionRecord).filter(q => !isArchived(q));
    }
    source = lastReviewFiltered.length ? lastReviewFiltered : getFilteredReviewQuestions();
    if (!source.length && allQuestions.length) source = allQuestions;
  } else if (scope === 'archive') {
    if (!archivedQuestions.length) await loadArchiveData();
    source = archivedQuestions;
  } else {
    const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at', { ascending: false }).limit(AppAPI.PAGE_SIZE);
    if (error) { toast('Export failed: ' + error.message, 'error'); return; }
    const rows = data || [];
    source = scope === 'answered'
      ? rows.filter(q => !isArchived(q) && q.status === 'Answered')
      : rows.filter(q => !isArchived(q));
  }
  await loadCommentStatsForQuestions(source.map(q => q.id));
  const rows = source.map(questionToExportRow);
  downloadCsv(`data-entry-qna-${scope}-${todayStamp()}.csv`, rows);
  await logActivity('CSV_EXPORTED', 'export', null, `questions:${scope}`, { scope, rows: rows.length });
  toast('✓ CSV export prepared', 'success');
}

async function exportActivityCsv() {
  if (!activityLogRows.length) await loadActivityLog();
  const rows = activityLogRows.map(row => ({
    created_at: row.created_at || '',
    actor_name: row.actor_name || '',
    actor_email: row.actor_email || '',
    action: row.action || '',
    target_table: row.target_table || '',
    target_label: row.target_label || '',
    details: row.details ? JSON.stringify(row.details) : ''
  }));
  downloadCsv(`data-entry-qna-activity-log-${todayStamp()}.csv`, rows);
  await logActivity('CSV_EXPORTED', 'export', null, 'activity_log', { rows: rows.length });
  toast('✓ Activity log export prepared', 'success');
}

async function addComment(questionId, text, parentId = null) {
  const cleanText = (text || '').trim();
  if (!currentUser) { toast('Please sign in before adding a follow-up', 'error'); return null; }
  if (cleanText.length < COMMENT_MIN) { toast(`Comment must be at least ${COMMENT_MIN} characters`, 'error'); return null; }
  if (cleanText.length > COMMENT_MAX) { toast(`Comment must be ${COMMENT_MAX} characters or fewer`, 'error'); return null; }
  const now = new Date().toISOString();
  const { data, error } = await sb.from('question_comments').insert({
    question_id: questionId,
    user_email: currentUser.email,
    user_name: currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
    text: cleanText,
    parent_comment_id: parentId,
    is_reviewer_reply: isReviewer(),
    is_resolved: false,
    created_at: now,
    updated_at: now
  }).select().single();
  if (error) { toast('Error adding follow-up: ' + error.message, 'error'); return null; }
  await logActivity(parentId ? 'COMMENT_REPLIED' : 'COMMENT_ADDED', 'question_comments', data.id, questionId, { question_id: questionId, reviewer_reply: isReviewer() });
  toast(parentId ? '✓ Reply added' : '✓ Follow-up added', 'success');
  return data;
}

async function editComment(commentId, newText) {
  const cleanText = (newText || '').trim();
  if (!currentUser) { toast('Please sign in before editing', 'error'); return null; }
  if (cleanText.length < COMMENT_MIN) { toast(`Comment must be at least ${COMMENT_MIN} characters`, 'error'); return null; }
  if (cleanText.length > COMMENT_MAX) { toast(`Comment must be ${COMMENT_MAX} characters or fewer`, 'error'); return null; }
  const { data, error } = await sb.from('question_comments').update({ text: cleanText, updated_at: new Date().toISOString() }).eq('id', commentId).eq('user_email', currentUser.email).select().single();
  if (error) { toast('Error editing follow-up: ' + error.message, 'error'); return null; }
  await logActivity('COMMENT_EDITED', 'question_comments', commentId, commentId, {});
  toast('✓ Follow-up updated', 'success');
  return data;
}

async function toggleResolved(commentId, resolved, questionId = null, context = 'faq') {
  const qid = questionId || findQuestionIdForComment(commentId);
  if (!currentUser) { toast('Please sign in first', 'error'); return; }
  const { error } = await sb.from('question_comments').update({ is_resolved: resolved }).eq('id', commentId).eq('user_email', currentUser.email);
  if (error) { toast('Error updating follow-up: ' + error.message, 'error'); return; }
  await logActivity(resolved ? 'COMMENT_RESOLVED' : 'COMMENT_REOPENED', 'question_comments', commentId, qid || commentId, {});
  toast(resolved ? '✓ Marked resolved' : '✓ Marked unresolved', 'success');
  if (qid) await refreshComments(qid);
}

// ══════════════════════════════════════
// PHASE 3 PREMIUM FEATURES
// ══════════════════════════════════════
const P3 = {theme:localStorage.getItem('theme')||'light', searchCache:null, searchAt:0, searchIndex:0, searchResults:[], charts:{}, adminTab:localStorage.getItem('adminTab')||'overview', analyticsPeriod:'daily', analyticsSubmitter:'', exportDateFormat:'iso', includeHeaders:true, exportColumns:null, searchTimer:null};
const EXPORT_COLUMNS=['question_id','bill_id','submitter_name','submitter_email','issue_field','status','sla_status','submitted_at','due_at','answered_date','answered_by','question','answer','remarks','follow_up_count','unresolved_follow_up_count','archived_at','archived_by','archive_reason'];
function applyTheme(){document.body.classList.toggle('dark',P3.theme==='dark');const b=document.getElementById('theme-toggle-btn');if(b)b.textContent=P3.theme==='dark'?'☀️':'🌙'}
function toggleTheme(){P3.theme=P3.theme==='dark'?'light':'dark';localStorage.setItem('theme',P3.theme);applyTheme();redrawAnalyticsCharts()}
function ensureNavTools(){const u=document.querySelector('.nav-user');if(!u||document.getElementById('theme-toggle-btn'))return;u.insertAdjacentHTML('afterbegin','<button class="nav-tool" onclick="openGlobalSearch()" title="Search everywhere (Ctrl+K)">🔍</button><button class="nav-tool" id="theme-toggle-btn" onclick="toggleTheme()" title="Toggle dark mode">🌙</button>');applyTheme()}
const _p3BuildNav=buildNav;buildNav=function(){_p3BuildNav();ensureNavTools()};
const _p3ShowPage=showPage;showPage=function(id){_p3ShowPage(id);if(id==='admin'&&isAdmin())setTimeout(()=>{setupAdminTabs();if(P3.adminTab==='analytics')loadAnalyticsDashboard()},0)};
window.addEventListener('keydown',e=>{const isK=(e.key||'').toLowerCase()==='k';if((e.ctrlKey||e.metaKey)&&isK){e.preventDefault();openGlobalSearch()}if(document.getElementById('global-search-overlay')?.classList.contains('open'))handleSearchKeys(e)});
window.addEventListener('DOMContentLoaded',()=>{applyTheme()});

function searchRowText(q){return [q.question_id,q.task_id,q.question,q.answer,q.submitter_name,q.submitter_email,q.answered_by,getIssueField(q),q.status].filter(Boolean).join(' ').toLowerCase()}
async function loadSearchCache(force=false){if(!force&&P3.searchCache&&Date.now()-P3.searchAt<90000)return P3.searchCache;const [q,c,r,f]=await Promise.all([sb.from('questions').select(AppAPI.QUESTION_FIELDS).order('submitted_at',{ascending:false}).limit(600),sb.from('question_comments').select('id,question_id,parent_comment_id,user_email,user_name,text,is_reviewer_reply,is_resolved,created_at,updated_at').order('created_at',{ascending:false}).limit(400),sb.from('reviewers').select('email'),sb.from('issue_fields').select('id,name,description,color,sort_order,is_active,created_at')]);P3.searchCache={questions:q.data||[],comments:c.data||[],reviewers:r.data||[],fields:f.data||issueFields||[]};P3.searchAt=Date.now();return P3.searchCache}
function openGlobalSearch(){const o=document.getElementById('global-search-overlay');if(!o)return;o.classList.add('open');document.body.style.overflow='hidden';setTimeout(()=>document.getElementById('global-search-input')?.focus(),30);renderSearchPrompt();loadSearchCache().then(()=>{const inp=document.getElementById('global-search-input');if(inp&&inp.value.trim())runGlobalSearch(inp.value)})}
function closeGlobalSearch(){const o=document.getElementById('global-search-overlay');if(o)o.classList.remove('open');document.body.style.overflow=''}
function closeGlobalSearchOnBg(e){if(e.target?.id==='global-search-overlay')closeGlobalSearch()}
function renderSearchPrompt(){const box=document.getElementById('global-search-results');if(box)box.innerHTML='<div class="empty"><div class="empty-icon">⌘K</div><h3>Start typing to search</h3><p>Search IDs, Bill IDs, questions, answers, comments, people, and issue fields.</p></div>'}
document.addEventListener('input',e=>{if(e.target?.id==='global-search-input'){clearTimeout(P3.searchTimer);const v=e.target.value;const box=document.getElementById('global-search-results');if(box)box.innerHTML='<div style="padding:16px"><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:55%;margin-top:10px"></div></div>';P3.searchTimer=setTimeout(()=>runGlobalSearch(v),300)}});
async function runGlobalSearch(term){const t=(term||'').trim().toLowerCase();if(!t){P3.searchResults=[];renderSearchPrompt();return}const data=await loadSearchCache();const qs=data.questions||[], cs=data.comments||[], fields=data.fields||[];const peopleMap={};qs.forEach(q=>{const key=(q.submitter_email||q.submitter_name||'').toLowerCase();if(!key)return;peopleMap[key]=peopleMap[key]||{name:q.submitter_name||q.submitter_email,email:q.submitter_email,count:0,answered:0};peopleMap[key].count++;if(q.status==='Answered')peopleMap[key].answered++});qs.forEach(q=>{if(q.answered_by){const key=String(q.answered_by).toLowerCase();peopleMap[key]=peopleMap[key]||{name:q.answered_by,email:'',count:0,answered:0,role:'Reviewer'};peopleMap[key].answered++}});const res=[];qs.filter(q=>searchRowText(q).includes(t)).slice(0,5).forEach(q=>res.push({group:'Questions',icon:'📝',title:`${q.question_id||'Question'}: ${q.task_id||''}`,sub:q.question,type:'question',id:q.id,query:q.task_id||q.question_id}));qs.filter(q=>(q.answer||'').toLowerCase().includes(t)).slice(0,5).forEach(q=>res.push({group:'Answers',icon:'✅',title:`Answer in ${q.question_id||q.task_id}`,sub:q.answer,type:'answer',id:q.id,query:q.task_id||q.question_id}));cs.filter(c=>[c.text,c.user_name,c.user_email].filter(Boolean).join(' ').toLowerCase().includes(t)).slice(0,3).forEach(c=>res.push({group:'Comments',icon:'💬',title:`Comment by ${c.user_name||'User'}`,sub:c.text,type:'comment',id:c.question_id,query:c.text}));Object.values(peopleMap).filter(p=>[p.name,p.email].join(' ').toLowerCase().includes(t)).slice(0,3).forEach(p=>res.push({group:'People',icon:'👥',title:p.name||p.email,sub:`${p.role||'Submitter'} · ${p.count} asked · ${p.answered} answered`,type:'person',query:p.name||p.email}));fields.filter(f=>[f.name,f.description].filter(Boolean).join(' ').toLowerCase().includes(t)).slice(0,5).forEach(f=>res.push({group:'Tags',icon:'🏷️',title:f.name,sub:f.description||'Issue field',type:'tag',query:f.name}));P3.searchResults=res;P3.searchIndex=0;renderSearchResults(t)}
function renderSearchResults(term){const box=document.getElementById('global-search-results');if(!box)return;if(!P3.searchResults.length){box.innerHTML=`<div class="empty"><div class="empty-icon">🔎</div><h3>No results for ${escHtml(term)}</h3><p>Try a different Bill ID, name, answer phrase, or issue field.</p></div>`;return}let html='',g='';P3.searchResults.forEach((r,i)=>{if(r.group!==g){g=r.group;html+=`<div class="search-group-title">${escHtml(g)}</div>`}html+=`<div class="search-item ${i===P3.searchIndex?'active':''}" onclick="selectSearchResult(${i})"><div class="search-ico">${r.icon}</div><div><div class="search-title">${escHtml(r.title)}</div><div class="search-sub">${escHtml(String(r.sub||'').slice(0,150))}</div></div></div>`});box.innerHTML=html}
function handleSearchKeys(e){if(e.key==='Escape'){closeGlobalSearch();return}if(!P3.searchResults.length)return;if(e.key==='ArrowDown'){e.preventDefault();P3.searchIndex=(P3.searchIndex+1)%P3.searchResults.length;renderSearchResults(document.getElementById('global-search-input')?.value||'')}if(e.key==='ArrowUp'){e.preventDefault();P3.searchIndex=(P3.searchIndex-1+P3.searchResults.length)%P3.searchResults.length;renderSearchResults(document.getElementById('global-search-input')?.value||'')}if(e.key==='Enter'){e.preventDefault();selectSearchResult(P3.searchIndex)}}
function selectSearchResult(i){const r=P3.searchResults[i];if(!r)return;closeGlobalSearch();if(r.type==='question'||r.type==='answer'||r.type==='comment'){if(isReviewer()){showPage('review');loadReviewData().then(()=>{const s=document.getElementById('r-search');if(s){s.value=r.query||'';renderReviewTable()}if(r.id)openModal(r.id)})}else{showPage('allq');setTimeout(()=>{const s=document.getElementById('aq-search');if(s){s.value=r.query||'';renderAllQ()}},500)}}else if(r.type==='person'){showPage(isReviewer()?'review':'allq');setTimeout(()=>{const s=document.getElementById(isReviewer()?'r-search':'aq-search');if(s){s.value=r.query;isReviewer()?renderReviewTable():renderAllQ()}},400)}else if(r.type==='tag'){showPage('faq');setTimeout(()=>{faqFilter=r.query;renderFaq();document.querySelectorAll('.filter-chip').forEach(c=>c.classList.toggle('active',c.dataset.filter===r.query))},500)}}

function draftKey(){return 'qnaDraft:'+((currentUser&&currentUser.email)||'anon')}
// ─── Issue 1B: Silent auto-persist for Submit Question form ───────────────────
// No UI, no banners, no toolbars. Saves Bill ID + question text + issue field
// to localStorage so the form survives page refresh, accidental tab close, and
// upload failures. 7-day expiry; cleared on successful submit and on Clear.
function readDraft(){
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return {};
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return {};
    // 7-day expiry
    if (d.ts && (Date.now() - d.ts) > 7 * 24 * 60 * 60 * 1000) {
      try { localStorage.removeItem(draftKey()); } catch (_e) {}
      return {};
    }
    return d;
  } catch (_e) { return {}; }
}
function saveDraft(){
  try {
    if (!currentUser) return;
    const taskEl = document.getElementById('f-task-id');
    const qEl = document.getElementById('f-question');
    const issEl = document.getElementById('f-priority');
    if (!taskEl && !qEl && !issEl) return;
    const taskId = (taskEl && taskEl.value) || '';
    const question = (qEl && qEl.value) || '';
    const issueField = (issEl && issEl.value) || '';
    // If everything is empty, drop the saved record so a fresh form stays fresh.
    if (!taskId.trim() && !question.trim()) {
      try { localStorage.removeItem(draftKey()); } catch (_e) {}
      return;
    }
    localStorage.setItem(draftKey(), JSON.stringify({
      taskId, question, issueField, ts: Date.now()
    }));
  } catch (_e) {}
}
function clearSavedDraft(){try{localStorage.removeItem(draftKey())}catch(e){} updateDraftBar()}
function hasDraft(){
  const d = readDraft();
  return !!((d.taskId && d.taskId.trim()) || (d.question && d.question.trim()));
}
function restoreDraft(){
  // Silent restore — no toast, no banner.
  try {
    const d = readDraft();
    if (!d || (!d.taskId && !d.question && !d.issueField)) return;
    const taskEl = document.getElementById('f-task-id');
    const qEl = document.getElementById('f-question');
    const issEl = document.getElementById('f-priority');
    if (taskEl && d.taskId && !taskEl.value) taskEl.value = d.taskId;
    if (qEl && d.question && !qEl.value) {
      qEl.value = d.question;
      try { updateCharCount('f-question','q-counter'); } catch (_e) {}
    }
    if (issEl && d.issueField) {
      // Only set if the option exists; otherwise leave the default selection.
      const opt = [...issEl.options].some(o => o.value === d.issueField);
      if (opt) issEl.value = d.issueField;
    }
  } catch (_e) {}
}
function updateDraftBar(){const bar=document.getElementById('draft-autosave-bar');if(bar)bar.remove()}
function initDraftAutosave(){
  updateDraftBar();
  // Wire silent save listeners exactly once.
  if (window.__draftAutosaveWired) return;
  window.__draftAutosaveWired = true;
  const wire = () => {
    const taskEl = document.getElementById('f-task-id');
    const qEl = document.getElementById('f-question');
    const issEl = document.getElementById('f-priority');
    if (taskEl && !taskEl.__draftWired) { taskEl.addEventListener('input', saveDraft); taskEl.__draftWired = true; }
    if (qEl && !qEl.__draftWired) { qEl.addEventListener('input', saveDraft); qEl.__draftWired = true; }
    if (issEl && !issEl.__draftWired) { issEl.addEventListener('change', saveDraft); issEl.__draftWired = true; }
  };
  wire();
  document.addEventListener('DOMContentLoaded', wire);
}
const _p3SubmitQuestion=submitQuestion;submitQuestion=async function(){await _p3SubmitQuestion();if(document.getElementById('submit-success')?.style.display==='block')clearSavedDraft()};const _p3SubmitBulk=submitBulk;submitBulk=async function(){await _p3SubmitBulk();if(document.getElementById('submit-success')?.style.display==='block')clearSavedDraft()};

function setupAdminTabs(){const dash=document.querySelector('#page-admin .admin-dashboard');if(!dash||document.getElementById('admin-tabbar'))return;const tabbar=document.createElement('div');tabbar.id='admin-tabbar';tabbar.className='admin-tabbar';tabbar.innerHTML=['overview:Overview','settings:Settings','data:Data & Exports','analytics:Analytics','system:System Status'].map(x=>{const [k,l]=x.split(':');return `<button class="admin-tab" data-tab="${k}" onclick="switchAdminTab('${k}')">${l}</button>`}).join('');dash.insertBefore(tabbar,dash.firstChild);const panes={};['overview','settings','data','analytics','system'].forEach(k=>{panes[k]=document.createElement('div');panes[k].className='admin-pane';panes[k].id='admin-pane-'+k;dash.appendChild(panes[k])});[...dash.children].forEach(ch=>{if(ch.id==='admin-tabbar'||ch.classList.contains('admin-pane'))return;if(ch.classList.contains('admin-mini-grid'))panes.overview.appendChild(ch)});const grid=document.querySelector('#page-admin .admin-grid');if(grid){[...grid.children].forEach(sec=>{const h=(sec.textContent||'').toLowerCase();if(h.includes('workflow health'))panes.overview.appendChild(sec);else if(h.includes('reviewer access')||h.includes('issue fields')||h.includes('sla settings'))panes.settings.appendChild(sec);else if(h.includes('data export')||h.includes('activity log')||h.includes('archive'))panes.data.appendChild(sec);else panes.system.appendChild(sec)});grid.remove()}panes.analytics.innerHTML=analyticsHtml();enhanceSlaSettingsUI();enhanceExportUI();enhanceActivityFilters();switchAdminTab(P3.adminTab)}
function switchAdminTab(k){P3.adminTab=k;localStorage.setItem('adminTab',k);document.querySelectorAll('.admin-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===k));document.querySelectorAll('.admin-pane').forEach(p=>p.classList.toggle('active',p.id==='admin-pane-'+k));if(k==='analytics')loadAnalyticsDashboard();if(k==='data'){loadActivityLog();loadArchiveData()}}
const _p3LoadAdminPanel=loadAdminPanel;loadAdminPanel=async function(){setupAdminTabs();await _p3LoadAdminPanel();const wk=document.getElementById('admin-sla-weekends');if(wk)wk.checked=slaSettings.exclude_weekends!==false;updateSlaPreview();updateExportColumnsUI();if(P3.adminTab==='analytics')loadAnalyticsDashboard()};
function enhanceSlaSettingsUI(){const days=document.getElementById('admin-sla-days');const tz=document.getElementById('admin-sla-timezone');if(!days||document.getElementById('sla-live-preview'))return;days.max=30;days.insertAdjacentHTML('afterend','<input type="range" min="1" max="30" id="admin-sla-days-slider" oninput="document.getElementById(\'admin-sla-days\').value=this.value;updateSlaPreview()" style="width:100%;margin-top:10px">');tz.outerHTML='<select class="form-select" id="admin-sla-timezone" onchange="updateSlaPreview()"><option>Asia/Kathmandu</option><option>Europe/Copenhagen</option><option>UTC</option><option>Asia/Kolkata</option><option>America/New_York</option></select>';document.getElementById('admin-sla-days')?.addEventListener('input',()=>{const s=document.getElementById('admin-sla-days-slider');if(s)s.value=document.getElementById('admin-sla-days').value;updateSlaPreview()});const card=days.closest('.admin-card');card?.insertAdjacentHTML('beforeend','<label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text2);margin-top:8px"><input type="checkbox" id="admin-sla-weekends" checked onchange="updateSlaPreview()"> Exclude weekends</label><div class="sla-preview" id="sla-live-preview">Due date preview will appear here.</div>')}
function updateSlaPreview(){const d=Math.max(1,Number(document.getElementById('admin-sla-days')?.value||2));const sl=document.getElementById('admin-sla-days-slider');if(sl)sl.value=d;const tz=document.getElementById('admin-sla-timezone');const wk=document.getElementById('admin-sla-weekends');const pv=document.getElementById('sla-live-preview');if(!pv)return;const old={...slaSettings};slaSettings={response_days:d,exclude_weekends:wk?wk.checked:true,timezone:tz?tz.value:old.timezone};pv.textContent=`Preview: a question submitted now will be due ${fmtDateFull(addWorkingDays(new Date(),d))} (${slaSettings.timezone}).`;slaSettings=old}
const _p3SaveSla=saveSlaSettings;saveSlaSettings=async function(){const days=Math.max(1,Math.min(30,Number(document.getElementById('admin-sla-days')?.value||2)));const timezone=document.getElementById('admin-sla-timezone')?.value||'Asia/Kathmandu';const exclude=document.getElementById('admin-sla-weekends')?.checked!==false;const payload={id:1,response_days:days,exclude_weekends:exclude,timezone,updated_at:new Date().toISOString(),updated_by:currentUser.email};const {error}=await sb.from('sla_settings').upsert(payload,{onConflict:'id'});if(error){toast('Could not save SLA settings: '+error.message,'error');return}slaSettings={response_days:days,exclude_weekends:exclude,timezone};await logActivity('SLA_SETTINGS_UPDATED','sla_settings',null,'SLA Settings',payload);toast('✓ SLA settings updated','success');updateSlaPreview();await loadAdminOverview()};
function enhanceActivityFilters(){const wrap=document.getElementById('activity-log-wrap');if(!wrap||document.getElementById('activity-filter-row'))return;wrap.insertAdjacentHTML('beforebegin','<div class="activity-filters" id="activity-filter-row"><input type="date" id="activity-date-from" onchange="renderActivityLog()"><input type="date" id="activity-date-to" onchange="renderActivityLog()"><select id="activity-action-filter" onchange="renderActivityLog()"><option value="">All actions</option></select><input type="text" id="activity-actor-filter" placeholder="Filter actor" oninput="renderActivityLog()"></div>')}
const _p3LoadActivityLog=loadActivityLog;loadActivityLog=async function(){enhanceActivityFilters();await _p3LoadActivityLog();populateActionFilter()};function populateActionFilter(){const s=document.getElementById('activity-action-filter');if(!s)return;const old=s.value;const acts=[...new Set((activityLogRows||[]).map(r=>r.action).filter(Boolean))].sort();s.innerHTML='<option value="">All actions</option>'+acts.map(a=>`<option value="${escAttr(a)}">${escHtml(humanizeAction(a))}</option>`).join('');s.value=old}
function activitySentence(row){const actor=row.actor_name||row.actor_email||'System', target=row.target_label?` ${row.target_label}`:'';const map={QUESTION_CREATED:'created question',QUESTION_UPDATED:'updated question',STATUS_CHANGED:'changed status for',ANSWER_ADDED:'added an answer to',ANSWER_EDITED:'edited an answer for',COMMENT_ADDED:'added a follow-up to',COMMENT_REPLIED:'replied to a follow-up on',COMMENT_EDITED:'edited a follow-up on',COMMENT_RESOLVED:'resolved a follow-up on',REVIEWER_ADDED:'added reviewer',REVIEWER_REMOVED:'removed reviewer',ISSUE_FIELD_CREATED:'created issue field',ISSUE_FIELD_UPDATED:'updated issue field',ISSUE_FIELD_DISABLED:'disabled issue field',ISSUE_FIELD_RESTORED:'restored issue field',QUESTION_ARCHIVED:'archived question',QUESTION_RESTORED:'restored question',CSV_EXPORTED:'exported CSV for',SLA_SETTINGS_UPDATED:'updated SLA settings'};return `${fmtDateFull(row.created_at)} · ${actor} ${map[row.action]||humanizeAction(row.action).toLowerCase()}${target}`}
renderActivityLog=function(){const wrap=document.getElementById('activity-log-wrap');if(!wrap)return;let rows=[...(activityLogRows||[])];const f=document.getElementById('activity-date-from')?.value,t=document.getElementById('activity-date-to')?.value,a=document.getElementById('activity-action-filter')?.value,actor=(document.getElementById('activity-actor-filter')?.value||'').toLowerCase();rows=rows.filter(r=>(!f||new Date(r.created_at)>=new Date(f+'T00:00:00'))&&(!t||new Date(r.created_at)<=new Date(t+'T23:59:59'))&&(!a||r.action===a)&&(!actor||[r.actor_name,r.actor_email].filter(Boolean).join(' ').toLowerCase().includes(actor))).sort((x,y)=>new Date(y.created_at)-new Date(x.created_at));if(!rows.length){wrap.innerHTML='<div class="empty-premium"><strong>No matching activity</strong>Try clearing filters or changing the date range.</div>';return}const day=86400000;wrap.innerHTML=rows.map(r=>`<div class="admin-log-item ${Date.now()-new Date(r.created_at)<day?'recent-activity':''}"><div class="admin-log-top"><span class="admin-log-action">${escHtml(humanizeAction(r.action))}</span><span class="admin-log-time">${fmtDateFull(r.created_at)}</span></div><div class="admin-log-body">${escHtml(activitySentence(r))}${r.details?`<br><span style="color:var(--text3)">${escHtml(JSON.stringify(r.details).slice(0,180))}</span>`:''}</div></div>`).join('')};
function enhanceExportUI(){const cards=[...document.querySelectorAll('.admin-card')];const card=cards.find(c=>(c.textContent||'').includes('Data Export'));if(!card||document.getElementById('export-options'))return;card.insertAdjacentHTML('beforeend',`<div class="export-options" id="export-options"><select id="export-date-format" onchange="P3.exportDateFormat=this.value"><option value="iso">ISO dates</option><option value="readable">Readable dates</option><option value="us">US dates</option><option value="eu">EU dates</option></select><label style="font-size:13px;color:var(--text2);display:flex;gap:8px;align-items:center"><input type="checkbox" id="export-headers" checked onchange="P3.includeHeaders=this.checked"> Include headers</label></div><div class="export-columns" id="export-columns"></div>`);P3.exportColumns=new Set(EXPORT_COLUMNS);updateExportColumnsUI()}
function updateExportColumnsUI(){const box=document.getElementById('export-columns');if(!box)return;if(!P3.exportColumns)P3.exportColumns=new Set(EXPORT_COLUMNS);box.innerHTML=EXPORT_COLUMNS.map(c=>`<label><input type="checkbox" checked value="${c}" onchange="toggleExportColumn(this)"> ${c.replace(/_/g,' ')}</label>`).join('')}
function toggleExportColumn(cb){if(!P3.exportColumns)P3.exportColumns=new Set(EXPORT_COLUMNS);cb.checked?P3.exportColumns.add(cb.value):P3.exportColumns.delete(cb.value)}
function formatExportDate(v){if(!v||!/\d{4}-\d{2}-\d{2}/.test(String(v)))return v;const d=new Date(v);if(Number.isNaN(d))return v;if(P3.exportDateFormat==='readable')return fmtDateFull(d);if(P3.exportDateFormat==='us')return d.toLocaleString('en-US');if(P3.exportDateFormat==='eu')return d.toLocaleString('en-GB');return v}
downloadCsv=function(filename,rows){if(!rows.length){toast('Nothing to export for this view','error');return}const selected=P3.exportColumns?[...P3.exportColumns]:Object.keys(rows[0]);const headers=selected.filter(h=>h in rows[0]);const lines=[];if(P3.includeHeaders!==false)lines.push(headers.join(','));rows.forEach(r=>lines.push(headers.map(h=>csvEscape(formatExportDate(r[h]))).join(',')));const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)};

function analyticsHtml(){return `<section class="admin-card admin-grid-full"><div class="admin-section-title"><div><h3>📈 Analytics Dashboard</h3><p class="admin-card-subtitle">Understand who asks questions, how volume changes over time, and how quickly answers are delivered.</p></div><button class="btn btn-outline btn-sm" onclick="exportAnalyticsCsv()">Export Analytics CSV</button></div><div class="analytics-controls"><select id="analytics-period" onchange="P3.analyticsPeriod=this.value;loadAnalyticsDashboard()"><option value="daily">Daily · last 7 days</option><option value="weekly">Weekly · last 12 weeks</option><option value="monthly">Monthly · last 12 months</option><option value="yearly">Yearly · all time</option><option value="custom">Custom range</option></select><input type="date" id="analytics-from" onchange="loadAnalyticsDashboard()"><input type="date" id="analytics-to" onchange="loadAnalyticsDashboard()"><input class="filter-search" id="analytics-submitter" placeholder="Filter by submitter" oninput="debouncedAnalytics()"><button class="btn btn-outline btn-sm" onclick="clearAnalyticsFilter()">Clear</button></div><div class="admin-mini-grid" style="margin-bottom:18px"><div class="admin-metric"><div class="admin-metric-value" id="an-total">—</div><div class="admin-metric-label">Total Questions</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-submitters">—</div><div class="admin-metric-label">Submitters</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-avg">—</div><div class="admin-metric-label">Avg / Person</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-peak">—</div><div class="admin-metric-label">Peak Period</div></div></div><div class="analytics-grid"><div class="analytics-card"><h3>Questions by Submitter</h3><div class="chart-box"><canvas id="chart-submitters"></canvas></div></div><div class="analytics-card"><h3>Questions Over Time</h3><div class="chart-box"><canvas id="chart-time"></canvas></div></div><div class="analytics-card"><h3>Cumulative Questions</h3><div class="chart-box"><canvas id="chart-cumulative"></canvas></div></div><div class="analytics-card"><h3>Response Time Distribution</h3><div class="chart-box"><canvas id="chart-response"></canvas></div></div><div class="analytics-card full"><h3>Submitter Detail</h3><div id="analytics-table"><div class="loading"><div class="spinner"></div> Loading analytics...</div></div></div></div></section>`}
let analyticsDebounce=null;function debouncedAnalytics(){clearTimeout(analyticsDebounce);analyticsDebounce=setTimeout(loadAnalyticsDashboard,300)}function clearAnalyticsFilter(){safeValue('analytics-submitter','');loadAnalyticsDashboard()}
function periodKey(d,period){const x=new Date(d);if(period==='yearly')return String(x.getFullYear());if(period==='monthly')return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}`;if(period==='weekly'){const a=new Date(x);a.setDate(a.getDate()-a.getDay()+1);return a.toISOString().slice(0,10)}return x.toISOString().slice(0,10)}
function analyticsRange(period){const now=new Date(),from=new Date(now);if(period==='daily')from.setDate(now.getDate()-6);else if(period==='weekly')from.setDate(now.getDate()-84);else if(period==='monthly')from.setMonth(now.getMonth()-11);else from.setFullYear(2000);if(period==='custom'){return {from:document.getElementById('analytics-from')?.value?new Date(document.getElementById('analytics-from').value+'T00:00:00'):from,to:document.getElementById('analytics-to')?.value?new Date(document.getElementById('analytics-to').value+'T23:59:59'):now}}return {from,to:now}}
async function loadAnalyticsDashboard(){if(!isAdmin()||!document.getElementById('chart-submitters'))return;try{await AppAPI.ensureChart()}catch(err){toast('Analytics chart library failed to load. '+(err?.message||''),'error');return}document.getElementById('analytics-table').innerHTML='<div style="padding:20px"><div class="skeleton"></div><div class="skeleton" style="margin-top:12px;width:75%"></div></div>';const period=document.getElementById('analytics-period')?.value||P3.analyticsPeriod||'daily';P3.analyticsPeriod=period;const range=analyticsRange(period);const {data,error}=await sb.from('questions').select(AppAPI.QUESTION_FIELDS).gte('submitted_at',range.from.toISOString()).lte('submitted_at',range.to.toISOString()).order('submitted_at',{ascending:true});if(error){document.getElementById('analytics-table').innerHTML=`<div class="empty-premium"><strong>Analytics unavailable</strong>${escHtml(error.message)}</div>`;return}let rows=(data||[]).filter(q=>!isArchived(q));const sub=(document.getElementById('analytics-submitter')?.value||'').toLowerCase();if(sub)rows=rows.filter(q=>[q.submitter_name,q.submitter_email].filter(Boolean).join(' ').toLowerCase().includes(sub));renderAnalytics(rows,period)}
function hoursToAnswer(q){if(!q.answered_date||!q.submitted_at)return null;return Math.max(0,(new Date(q.answered_date)-new Date(q.submitted_at))/36e5)}
function renderAnalytics(rows,period){const bySub={},over={},cum=[];rows.forEach(q=>{const n=q.submitter_name||q.submitter_email||'Unknown';bySub[n]=bySub[n]||{name:n,email:q.submitter_email||'',questions:0,answered:0,totalHours:0,last:null};bySub[n].questions++;if(q.status==='Answered')bySub[n].answered++;const h=hoursToAnswer(q);if(h!=null)bySub[n].totalHours+=h;if(!bySub[n].last||new Date(q.submitted_at)>new Date(bySub[n].last))bySub[n].last=q.submitted_at;const k=periodKey(q.submitted_at,period);over[k]=(over[k]||0)+1});const submitters=Object.values(bySub).sort((a,b)=>b.questions-a.questions);const timeLabels=Object.keys(over).sort();let run=0;timeLabels.forEach(k=>{run+=over[k];cum.push(run)});safeText('an-total',rows.length);safeText('an-submitters',submitters.length);safeText('an-avg',submitters.length?(rows.length/submitters.length).toFixed(1):'0');safeText('an-peak',timeLabels.length?`${timeLabels.reduce((a,b)=>over[a]>over[b]?a:b)} (${Math.max(...Object.values(over))})`:'—');const top=submitters.slice(0,15);drawChart('submitters','bar',top.map(s=>s.name),top.map(s=>s.questions),'Questions by Submitter',e=>{const i=e[0]?.index;if(i!=null){safeValue('analytics-submitter',top[i].name);loadAnalyticsDashboard()}});drawChart('time','line',timeLabels,timeLabels.map(k=>over[k]),'Questions Over Time');drawChart('cumulative','line',timeLabels,cum,'Cumulative Questions');const buckets={'0-2h':0,'2-6h':0,'6-24h':0,'24-48h':0,'48h+':0};rows.forEach(q=>{const h=hoursToAnswer(q);if(h==null)return;if(h<=2)buckets['0-2h']++;else if(h<=6)buckets['2-6h']++;else if(h<=24)buckets['6-24h']++;else if(h<=48)buckets['24-48h']++;else buckets['48h+']++});drawChart('response','bar',Object.keys(buckets),Object.values(buckets),'Response Time Distribution');renderAnalyticsTable(submitters)}
function chartColor(){return getComputedStyle(document.body).getPropertyValue('--accent').trim()||'#e63946'}function chartText(){return getComputedStyle(document.body).getPropertyValue('--text2').trim()||'#6c757d'}
function drawChart(id,type,labels,data,label,onClick){const ctx=document.getElementById('chart-'+id);if(!ctx)return;if(P3.charts[id])P3.charts[id].destroy();P3.charts[id]=new Chart(ctx,{type,data:{labels,datasets:[{label,data,borderColor:chartColor(),backgroundColor:type==='line'?'rgba(230,57,70,.16)':'rgba(230,57,70,.72)',fill:type==='line',tension:.35,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:550},plugins:{legend:{labels:{color:chartText()}}},scales:{x:{ticks:{color:chartText()},grid:{color:'rgba(128,128,128,.12)'}},y:{beginAtZero:true,ticks:{precision:0,color:chartText()},grid:{color:'rgba(128,128,128,.12)'}}},onClick:(evt,e)=>onClick&&onClick(e)}})}
function redrawAnalyticsCharts(){if(P3.adminTab==='analytics')setTimeout(loadAnalyticsDashboard,50)}
function renderAnalyticsTable(rows){const box=document.getElementById('analytics-table');if(!box)return;if(!rows.length){box.innerHTML='<div class="empty"><div class="empty-icon">📊</div><h3>No analytics yet</h3><p>Create questions to see trends.</p></div>';return}box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Submitter</th><th>Questions</th><th>Answered</th><th>Avg Response</th><th>Last Asked</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${escHtml(s.name)}<div class="td-date">${escHtml(s.email)}</div></td><td>${s.questions}</td><td>${s.answered}</td><td>${s.answered?Math.round(s.totalHours/Math.max(1,s.answered))+'h':'—'}</td><td>${fmtDate(s.last)}</td></tr>`).join('')}</tbody></table></div>`}
function exportAnalyticsCsv(){const rows=[...document.querySelectorAll('#analytics-table tbody tr')].map(tr=>{const t=[...tr.children].map(td=>td.innerText.replace(/\n/g,' · '));return {submitter:t[0]||'',questions:t[1]||'',answered:t[2]||'',avg_response:t[3]||'',last_asked:t[4]||''}});downloadCsv(`data-entry-qna-analytics-${todayStamp()}.csv`,rows);logActivity('CSV_EXPORTED','export',null,'analytics',{rows:rows.length})}

// ══════════════════════════════════════
// PHASE 4 FEATURES — sticky review table, submitter detail tab, answer views
// ══════════════════════════════════════
let questionViewsByQuestion = {};
let questionViewDetailsByQuestion = {};
let submitterDetailRows = [];
let submitterDetailSort = { key: 'questions', dir: 'desc' };
let submitterDetailVisible = 20;
const VIEW_SESSION_KEY = (() => {
  try {
    let key = sessionStorage.getItem('answerViewSessionKey');
    if (!key) {
      key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('answerViewSessionKey', key);
    }
    return key;
  } catch (_err) {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

async function loadQuestionViewCounts(questionIds = []) {
  const ids = [...new Set((questionIds || []).filter(Boolean))];
  questionViewsByQuestion = {};
  questionViewDetailsByQuestion = {};
  ids.forEach(id => { questionViewsByQuestion[id] = 0; questionViewDetailsByQuestion[id] = []; });
  if (!ids.length) return;
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await sb
      .from('question_views')
      .select('question_id,viewer_name,viewer_email,viewed_at')
      .in('question_id', chunk)
      .order('viewed_at', { ascending: false });
    if (error) {
      console.warn('View counts unavailable:', error.message);
      return;
    }
    (data || []).forEach(v => {
      if (!questionViewDetailsByQuestion[v.question_id]) questionViewDetailsByQuestion[v.question_id] = [];
      questionViewDetailsByQuestion[v.question_id].push(v);
    });
  }
  Object.keys(questionViewDetailsByQuestion).forEach(qid => {
    const uniqueEmails = new Set((questionViewDetailsByQuestion[qid] || []).map(v => (v.viewer_email || '').toLowerCase()).filter(Boolean));
    questionViewsByQuestion[qid] = uniqueEmails.size;
  });
}

function renderSeenBadge(questionId) {
  const count = questionViewsByQuestion[questionId] || 0;
  const label = `👁 Seen by ${count}`;
  if (isAdmin()) {
    return `<button type="button" class="seen-badge" data-seen-badge-id="${escAttr(questionId)}" onclick="openSeenByModal('${escAttr(questionId)}', event)">${label}</button>`;
  }
  return `<span class="seen-badge" data-seen-badge-id="${escAttr(questionId)}">${label}</span>`;
}

function updateSeenBadges(questionId) {
  document.querySelectorAll(`[data-seen-badge-id="${questionId}"]`).forEach(el => {
    el.textContent = `👁 Seen by ${questionViewsByQuestion[questionId] || 0}`;
  });
}

async function recordQuestionView(questionId) {
  if (!currentUser || !questionId) return;
  const q = (faqQuestions || []).find(item => item.id === questionId);
  if (!q || q.status !== 'Answered') return;
  const payload = {
    question_id: questionId,
    viewer_name: currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
    viewer_email: currentUser.email,
    session_key: VIEW_SESSION_KEY,
    viewed_at: new Date().toISOString()
  };
  const { error } = await sb
    .from('question_views')
    .upsert(payload, { onConflict: 'question_id,viewer_email,session_key' });
  if (error) {
    console.warn('Answer view was not recorded:', error.message);
    return;
  }
  await loadQuestionViewCounts((faqQuestions || []).map(item => item.id));
  updateSeenBadges(questionId);
}

async function openSeenByModal(questionId, event) {
  if (event) event.stopPropagation();
  if (!isAdmin()) return;
  const q = (faqQuestions || allQuestions || adminQuestions || []).find(item => item.id === questionId) || {};
  document.getElementById('modal-title').textContent = `Answer views — ${q.question_id || q.task_id || 'Question'}`;
  document.getElementById('modal-meta').innerHTML = q.task_id ? `<span class="pill-muted">Bill ID ${escHtml(q.task_id)}</span>${renderSeenBadge(questionId)}` : renderSeenBadge(questionId);
  document.getElementById('modal-body').innerHTML = '<div class="loading"><div class="spinner"></div> Loading viewers...</div>';
  document.getElementById('modal-footer').innerHTML = '<button class="btn btn-outline" onclick="closeModal()">Close</button>';
  document.getElementById('modal-overlay').classList.add('open');

  const { data, error } = await sb
    .from('question_views')
    .select('viewer_name,viewer_email,viewed_at')
    .eq('question_id', questionId)
    .order('viewed_at', { ascending: false });
  if (error) {
    document.getElementById('modal-body').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Could not load viewers</h3><p>${escHtml(error.message)}</p></div>`;
    return;
  }
  const byEmail = {};
  (data || []).forEach(v => {
    const key = (v.viewer_email || '').toLowerCase();
    if (!key) return;
    if (!byEmail[key] || new Date(v.viewed_at) > new Date(byEmail[key].viewed_at)) byEmail[key] = v;
  });
  const viewers = Object.values(byEmail);
  if (!viewers.length) {
    document.getElementById('modal-body').innerHTML = '<div class="empty"><div class="empty-icon">👁</div><h3>No views yet</h3><p>No staff member has opened this answered question yet.</p></div>';
    return;
  }
  document.getElementById('modal-body').innerHTML = `<div class="viewer-list">${viewers.map(v => `<div class="viewer-item"><div class="viewer-name">${escHtml(v.viewer_name || v.viewer_email)}</div><div class="viewer-meta">${escHtml(v.viewer_email || '')} · Viewed ${fmtDateFull(v.viewed_at)}</div></div>`).join('')}</div>`;
}

const _phase4LoadFaqData = loadFaqData;
loadFaqData = async function() {
  document.getElementById('faq-list').innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
  const { data, error } = await sb.from('questions').select(AppAPI.QUESTION_FIELDS).eq('status', 'Answered').order('answered_date', { ascending: false }).limit(AppAPI.PAGE_SIZE);
  if (error) {
    document.getElementById('faq-list').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Error</h3><p>${escHtml(error.message)}</p></div>`;
    return;
  }
  faqQuestions = (data || []).map(normalizeQuestionRecord).filter(q => !isArchived(q));
  await Promise.all([
    loadCommentStatsForQuestions(faqQuestions.map(q => q.id)),
    loadQuestionViewCounts(faqQuestions.map(q => q.id))
  ]);
  updateIssueFieldControls();
  renderFaq();
};

renderFaq = function() {
  const search = (document.getElementById('faq-search').value || '').toLowerCase();
  const sortVal = document.getElementById('faq-sort') ? document.getElementById('faq-sort').value : 'newest';
  let filtered = (faqQuestions || []).filter(q => {
    const field = getIssueField(q);
    if (faqFilter && field !== faqFilter) return false;
    if (search &&
        !(q.task_id || '').toLowerCase().includes(search) &&
        !(q.question_id || '').toLowerCase().includes(search) &&
        !(q.question || '').toLowerCase().includes(search) &&
        !(q.answer || '').toLowerCase().includes(search) &&
        !(q.submitter_name || '').toLowerCase().includes(search) &&
        !field.toLowerCase().includes(search)) return false;
    return true;
  });
  filtered.sort((a,b) => {
    if (sortVal === 'oldest') return new Date(a.answered_date || 0) - new Date(b.answered_date || 0);
    if (sortVal === 'billid') return (a.task_id || '').localeCompare(b.task_id || '');
    if (sortVal === 'issue') return getIssueField(a).localeCompare(getIssueField(b));
    return new Date(b.answered_date || 0) - new Date(a.answered_date || 0);
  });
  safeText('faq-count', `${filtered.length} answer${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('faq-list').innerHTML = `<div class="faq-count">${faqQuestions.length} total answered questions</div><div class="empty"><div class="empty-icon">🔍</div><h3>No results found</h3><p>Try different keywords or clear the search.</p></div>`;
    return;
  }
  const html = filtered.map(q => {
    const answerEncoded = encodeURIComponent(q.answer || '');
    return `
    <div class="faq-card" data-question-id="${escAttr(q.id)}" onclick="toggleFaqCard(this,event)">
      <div class="faq-card-top"><div class="faq-meta"><span style="font-size:12px;color:var(--text3);font-weight:500">Bill ID:</span><span class="faq-task">${escHtml(q.task_id)}</span><span style="font-size:12px;color:var(--text3);font-weight:500;margin-left:8px">Issue:</span>${issueBadge(getIssueField(q))}${renderFollowUpBadge(q.id)}${renderSlaBadge(q)}${renderSeenBadge(q.id)}</div><span style="color:var(--text3); font-size:13px; flex-shrink:0; font-weight:500">Ref: ${escHtml(q.question_id || '')}</span></div>
      <div style="margin-bottom:6px"><span style="font-size:12px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.4px">Question</span><div class="faq-question" style="margin-top:4px">${escHtml(q.question)}</div></div>
      <div style="border-top:1px dashed var(--border);margin:10px 0"></div>
      <div><span style="font-size:12px;color:var(--accent2);font-weight:700;text-transform:uppercase;letter-spacing:0.4px">Answer</span><div class="faq-answer-preview" style="margin-top:4px;font-weight:600;color:var(--text)">${escHtml(q.answer || '')}</div></div>
      <button class="copy-answer-btn" onclick="event.stopPropagation();copyAnswer(this, decodeURIComponent('${answerEncoded}'))">📋 Copy Answer</button>
      <div class="faq-footer"><span><span style="color:var(--text3)">Submitted by:</span> ${escHtml(q.submitter_name || '')} &nbsp;·&nbsp; <span style="color:var(--text3)">Answered by:</span> ${escHtml(q.answered_by || 'Reviewer')} &nbsp;·&nbsp; <span style="color:var(--text3)">Answered on:</span> ${fmtDate(q.answered_date)}</span><span style="color:var(--accent2); font-size:12px">Click to expand ▾</span></div>
      <div class="comments-section faq-comments-section" id="${faqCommentsSectionId(q.id)}" data-question-id="${escAttr(q.id)}" data-loaded="false" onclick="event.stopPropagation()" style="display:none"><div class="comments-header-row"><div><div class="comments-header">Follow-ups</div></div>${renderFollowUpBadge(q.id)}</div><div class="comment-loading">Expand this answer to load follow-ups.</div></div>
    </div>`;
  }).join('');
  document.getElementById('faq-list').innerHTML = `<div class="faq-count">${faqQuestions.length} total answered questions</div>` + html;
};

const _phase4ToggleFaqCard = toggleFaqCard;
toggleFaqCard = async function(card, event) {
  // ANSWERED PAGE — keep form clicks, edit/reply buttons, copy button, images, and links from collapsing the card.
  // Only allow expand/collapse from the footer area (Submitted by, Answered by, Click to expand/collapse)
  if (event && event.target.closest('.comments-section, button, textarea, input, select, a, .bugfix-attachment-image, .bugfix-attachment-image-wrap, .faq-question, .faq-answer-preview')) return;
  await _phase4ToggleFaqCard(card, event);
  const preview = card.querySelector('.faq-answer-preview');
  if (preview && preview.classList.contains('open')) await recordQuestionView(card.dataset.questionId);
};

renderReviewTable = function() {
  const filtered = getFilteredReviewQuestions();
  lastReviewFiltered = filtered;
  safeText('r-count', `${filtered.length} question${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('review-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">📭</div><h3>No matching questions</h3><p>Try clearing filters or searching by Bill ID, staff name, issue field, or status.</p></div>';
    return;
  }
  const rows = filtered.map(q => `
    <tr onclick="openModal('${q.id}')" style="cursor:pointer">
      <td class="cb-wrap" onclick="event.stopPropagation()"><input type="checkbox" class="row-cb question-cb" data-id="${q.id}" onchange="updateSelectBar()"></td>
      <td class="td-id">${escHtml(q.question_id || '—')}</td>
      <td class="td-task">${escHtml(q.task_id)}</td>
      <td class="td-q">${escHtml(q.question)}${getCommentStats(q.id).total > 0 ? `<div style="margin-top:6px">${renderFollowUpBadge(q.id)}</div>` : ''}</td>
      <td class="td-name">${escHtml(q.submitter_name || '')}</td>
      <td>${issueBadge(getIssueField(q))}</td>
      <td>${renderSlaBadge(q)}</td>
      <td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td>
      <td class="td-date">${fmtDate(q.submitted_at)}</td>
      <td class="td-date">${fmtDate(getQuestionDueAt(q))}</td>
      <td class="td-date">${q.answered_date ? fmtDate(q.answered_date) : '—'}</td>
    </tr>`).join('');
  document.getElementById('review-table-wrap').innerHTML = `
    <div class="table-wrap review-table-wrap">
      <div class="review-table-scroll">
        <table>
          <thead><tr>
            <th style="width:40px"><input type="checkbox" class="row-cb" id="cb-all" onclick="toggleAll(this)" title="Select all"></th>
            <th>ID</th><th>Bill ID</th><th>Question</th><th>From</th><th>Issue Field</th><th>SLA</th><th>Status</th><th>Submitted</th><th>Due</th><th>Answered</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
};

setupAdminTabs = function() {
  const dash = document.querySelector('#page-admin .admin-dashboard');
  if (!dash) return;
  if (document.getElementById('admin-tabbar')) {
    if (!document.querySelector('[data-tab="submitters"]')) {
      document.getElementById('admin-tabbar').insertAdjacentHTML('beforeend', '<button class="admin-tab" data-tab="submitters" onclick="switchAdminTab(\'submitters\')">Submitter Detail</button>');
      const pane = document.createElement('div');
      pane.className = 'admin-pane';
      pane.id = 'admin-pane-submitters';
      pane.innerHTML = submitterDetailHtml();
      dash.appendChild(pane);
    }
    switchAdminTab(P3.adminTab || 'overview');
    return;
  }
  const tabbar = document.createElement('div');
  tabbar.id = 'admin-tabbar';
  tabbar.className = 'admin-tabbar';
  tabbar.innerHTML = ['overview:Overview','settings:Settings','data:Data & Exports','analytics:Analytics','submitters:Submitter Detail','system:System Status'].map(x => {
    const [k,l] = x.split(':');
    return `<button class="admin-tab" data-tab="${k}" onclick="switchAdminTab('${k}')">${l}</button>`;
  }).join('');
  dash.insertBefore(tabbar, dash.firstChild);
  const panes = {};
  ['overview','settings','data','analytics','submitters','system'].forEach(k => {
    panes[k] = document.createElement('div');
    panes[k].className = 'admin-pane';
    panes[k].id = 'admin-pane-' + k;
    dash.appendChild(panes[k]);
  });
  [...dash.children].forEach(ch => {
    if (ch.id === 'admin-tabbar' || ch.classList.contains('admin-pane')) return;
    if (ch.classList.contains('admin-mini-grid')) panes.overview.appendChild(ch);
  });
  const grid = document.querySelector('#page-admin .admin-grid');
  if (grid) {
    [...grid.children].forEach(sec => {
      const h = (sec.textContent || '').toLowerCase();
      if (h.includes('workflow health')) panes.overview.appendChild(sec);
      else if (h.includes('reviewer access') || h.includes('issue fields') || h.includes('sla settings')) panes.settings.appendChild(sec);
      else if (h.includes('data export') || h.includes('activity log') || h.includes('archive')) panes.data.appendChild(sec);
      else panes.system.appendChild(sec);
    });
    grid.remove();
  }
  panes.analytics.innerHTML = analyticsHtml();
  panes.submitters.innerHTML = submitterDetailHtml();
  enhanceSlaSettingsUI();
  enhanceExportUI();
  enhanceActivityFilters();
  switchAdminTab(P3.adminTab || 'overview');
};

switchAdminTab = function(k) {
  P3.adminTab = k;
  localStorage.setItem('adminTab', k);
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === k));
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.toggle('active', p.id === 'admin-pane-' + k));
  if (k === 'analytics') loadAnalyticsDashboard();
  if (k === 'submitters') loadSubmitterDetail();
  if (k === 'data') { loadActivityLog(); loadArchiveData(); }
};

function submitterDetailHtml() {
  return `<section class="admin-card admin-grid-full"><div class="admin-section-title"><div><h3>👥 Submitter Detail</h3><p class="admin-card-subtitle">Sortable staff-level question volume. Built from existing question history, with search and 20-row pagination for larger teams.</p></div><button class="btn btn-outline btn-sm" onclick="loadSubmitterDetail()">↻ Refresh</button></div><div class="submitter-detail-controls"><input class="filter-search" id="submitter-detail-search" placeholder="Search submitter name or email..." oninput="renderSubmitterDetail()"><span class="result-count" id="submitter-detail-count"></span></div><div id="submitter-detail-table"><div class="loading"><div class="spinner"></div> Loading submitters...</div></div></section>`;
}

async function loadSubmitterDetail() {
  const box = document.getElementById('submitter-detail-table');
  if (!box) return;
  box.innerHTML = '<div class="loading"><div class="spinner"></div> Loading submitters...</div>';
  const { data, error } = await sb.from('questions').select('id,submitter_name,submitter_email,submitted_at,status,is_archived,archived_at').order('submitted_at', { ascending: false });
  if (error) {
    box.innerHTML = `<div class="empty-premium"><strong>Submitter detail unavailable</strong>${escHtml(error.message)}</div>`;
    return;
  }
  const grouped = {};
  (data || []).filter(q => !isArchived(q)).forEach(q => {
    const email = (q.submitter_email || '').toLowerCase();
    const key = email || q.submitter_name || 'Unknown';
    grouped[key] = grouped[key] || { name: q.submitter_name || q.submitter_email || 'Unknown', email: q.submitter_email || '', questions: 0, last: null, activeOpen: 0 };
    grouped[key].questions += 1;
    if (['Open','In Review'].includes(q.status)) grouped[key].activeOpen += 1;
    if (!grouped[key].last || new Date(q.submitted_at) > new Date(grouped[key].last)) grouped[key].last = q.submitted_at;
  });
  submitterDetailRows = Object.values(grouped);
  submitterDetailVisible = 20;
  renderSubmitterDetail();
}

function sortSubmitterDetail(key) {
  if (submitterDetailSort.key === key) submitterDetailSort.dir = submitterDetailSort.dir === 'asc' ? 'desc' : 'asc';
  else submitterDetailSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
  renderSubmitterDetail();
}

function renderSubmitterDetail() {
  const box = document.getElementById('submitter-detail-table');
  if (!box) return;
  const term = (document.getElementById('submitter-detail-search')?.value || '').toLowerCase();
  let rows = (submitterDetailRows || []).filter(s => !term || [s.name, s.email].filter(Boolean).join(' ').toLowerCase().includes(term));
  const { key, dir } = submitterDetailSort;
  rows.sort((a,b) => {
    let av = a[key], bv = b[key];
    if (key === 'last') { av = av ? new Date(av).getTime() : 0; bv = bv ? new Date(bv).getTime() : 0; }
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv || '') : (bv || '').localeCompare(av);
    return dir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
  });
  safeText('submitter-detail-count', `${rows.length} submitter${rows.length !== 1 ? 's' : ''}`);
  const shown = rows.slice(0, submitterDetailVisible);
  if (!shown.length) {
    box.innerHTML = '<div class="empty-premium"><strong>No submitters found</strong>Try clearing the search filter.</div>';
    return;
  }
  const arrow = col => submitterDetailSort.key === col ? (submitterDetailSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  box.innerHTML = `<div class="table-wrap"><div class="submitter-detail-scroll"><table><thead><tr><th class="submitter-sort-th" onclick="sortSubmitterDetail('name')">Submitter Name${arrow('name')}</th><th class="submitter-sort-th" onclick="sortSubmitterDetail('questions')">Questions Asked${arrow('questions')}</th><th class="submitter-sort-th" onclick="sortSubmitterDetail('last')">Last Asked${arrow('last')}</th><th>Status</th></tr></thead><tbody>${shown.map(s => `<tr><td>${escHtml(s.name)}<div class="td-date">${escHtml(s.email)}</div></td><td>${s.questions}</td><td class="td-date">${fmtDate(s.last)}</td><td><span class="status-badge ${s.activeOpen ? 's-Open' : 's-Answered'}">${s.activeOpen ? 'Active' : 'Inactive'}</span></td></tr>`).join('')}</tbody></table></div></div>${rows.length > submitterDetailVisible ? `<div style="margin-top:14px;text-align:center"><button class="btn btn-outline" onclick="submitterDetailVisible+=20;renderSubmitterDetail()">Load 20 more</button></div>` : ''}`;
}

analyticsHtml = function() {
  return `<section class="admin-card admin-grid-full"><div class="admin-section-title"><div><h3>📈 Analytics Dashboard</h3><p class="admin-card-subtitle">Understand who asks questions, how volume changes over time, how quickly answers are delivered, and which answers are being viewed.</p></div><button class="btn btn-outline btn-sm" onclick="exportAnalyticsCsv()">Export Analytics CSV</button></div><div class="analytics-controls"><select id="analytics-period" onchange="P3.analyticsPeriod=this.value;loadAnalyticsDashboard()"><option value="daily">Daily · last 7 days</option><option value="weekly">Weekly · last 12 weeks</option><option value="monthly">Monthly · last 12 months</option><option value="yearly">Yearly · all time</option><option value="custom">Custom range</option></select><input type="date" id="analytics-from" onchange="loadAnalyticsDashboard()"><input type="date" id="analytics-to" onchange="loadAnalyticsDashboard()"><input class="filter-search" id="analytics-submitter" placeholder="Filter by submitter" oninput="debouncedAnalytics()"><button class="btn btn-outline btn-sm" onclick="clearAnalyticsFilter()">Clear</button></div><div class="admin-mini-grid" style="margin-bottom:18px"><div class="admin-metric"><div class="admin-metric-value" id="an-total">—</div><div class="admin-metric-label">Total Questions</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-submitters">—</div><div class="admin-metric-label">Submitters</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-avg">—</div><div class="admin-metric-label">Avg / Person</div></div><div class="admin-metric"><div class="admin-metric-value" id="an-peak">—</div><div class="admin-metric-label">Peak Period</div></div></div><div class="analytics-grid"><div class="analytics-card"><h3>Questions by Submitter</h3><div class="chart-box"><canvas id="chart-submitters"></canvas></div></div><div class="analytics-card"><h3>Questions Over Time</h3><div class="chart-box"><canvas id="chart-time"></canvas></div></div><div class="analytics-card"><h3>Cumulative Questions</h3><div class="chart-box"><canvas id="chart-cumulative"></canvas></div></div><div class="analytics-card"><h3>Response Time Distribution</h3><div class="chart-box"><canvas id="chart-response"></canvas></div></div><div class="analytics-card full"><h3>Most Viewed Questions</h3><div id="most-viewed-questions"><div class="loading"><div class="spinner"></div> Loading views...</div></div></div></div></section>`;
};

const _phase4RenderAnalytics = renderAnalytics;
renderAnalytics = function(rows, period) {
  _phase4RenderAnalytics(rows, period);
  renderMostViewedQuestions();
};

async function renderMostViewedQuestions() {
  const box = document.getElementById('most-viewed-questions');
  if (!box) return;
  const answered = (faqQuestions && faqQuestions.length ? faqQuestions : []).filter(q => q.status === 'Answered');
  let source = answered;
  if (!source.length) {
    const { data } = await sb.from('questions').select('id,question_id,task_id,question,status').eq('status', 'Answered').limit(200);
    source = (data || []).filter(q => !isArchived(q));
  }
  await loadQuestionViewCounts(source.map(q => q.id));
  const rows = source.map(q => ({ ...q, views: questionViewsByQuestion[q.id] || 0 })).sort((a,b) => b.views - a.views).slice(0, 10);
  if (!rows.length) {
    box.innerHTML = '<div class="empty-premium"><strong>No answered questions yet</strong>Most viewed questions will appear here after answers are viewed.</div>';
    return;
  }
  box.innerHTML = `<div class="most-viewed-list">${rows.map(q => `<div class="most-viewed-item"><div><strong>${escHtml(q.question_id || q.task_id || 'Question')}</strong><div class="td-date">Bill ID ${escHtml(q.task_id || '—')}</div><div style="font-size:12px;color:var(--text2);margin-top:4px">${escHtml(String(q.question || '').slice(0, 120))}</div></div><span class="seen-badge">👁 Seen by ${q.views}</span></div>`).join('')}</div>`;
}

const _phase4ShowPage = showPage;
showPage = function(id) {
  _phase4ShowPage(id);
  if (id === 'admin' && isAdmin()) {
    setTimeout(() => {
      setupAdminTabs();
      if (P3.adminTab === 'analytics') loadAnalyticsDashboard();
      if (P3.adminTab === 'submitters') loadSubmitterDetail();
    }, 0);
  }
};

// ══════════════════════════════════════
// FINAL FIX: Admin Analytics + sortable/interactable All Questions/Review headers
// ══════════════════════════════════════
var allQTableSort = window.allQTableSort || { key: 'submitted', dir: 'desc' };
var reviewTableSort = window.reviewTableSort || { key: 'submitted', dir: 'desc' };
window.allQTableSort = allQTableSort;
window.reviewTableSort = reviewTableSort;

function sortArrow(sortState, key) {
  return sortState && sortState.key === key ? (sortState.dir === 'asc' ? ' ↑' : ' ↓') : '';
}

function sortableHeader(label, key, sortState, fnName) {
  const arrow = sortArrow(sortState, key);
  return `<th class="submitter-sort-th table-sort-th" role="button" tabindex="0" title="Sort by ${escAttr(label)}" onclick="${fnName}('${escAttr(key)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${fnName}('${escAttr(key)}')}">${escHtml(label)}${arrow}</th>`;
}

function questionSortValue(q, key) {
  if (!q) return '';
  switch (key) {
    case 'id': {
      const raw = q.question_id || '';
      const numeric = parseInt(String(raw).replace(/\D/g, ''), 10);
      return Number.isNaN(numeric) ? String(raw).toLowerCase() : numeric;
    }
    case 'billId': return String(q.task_id || '').toLowerCase();
    case 'question': return String(q.question || '').toLowerCase();
    case 'from': return String(q.submitter_name || q.submitter_email || '').toLowerCase();
    case 'issue': return String(getIssueField(q) || '').toLowerCase();
    case 'sla': return getSlaInfo(q).rank;
    case 'status': return String(q.status || '').toLowerCase();
    case 'submitted': return q.submitted_at ? new Date(q.submitted_at).getTime() : 0;
    default: return String(q[key] || '').toLowerCase();
  }
}

function sortQuestionRows(rows, sortState) {
  const state = sortState || { key: 'submitted', dir: 'desc' };
  const dir = state.dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = questionSortValue(a, state.key);
    const bv = questionSortValue(b, state.key);
    if (typeof av === 'number' || typeof bv === 'number') return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function sortAllQTable(key) {
  if (allQTableSort.key === key) allQTableSort.dir = allQTableSort.dir === 'asc' ? 'desc' : 'asc';
  else allQTableSort = window.allQTableSort = { key, dir: key === 'submitted' || key === 'id' ? 'desc' : 'asc' };
  renderAllQ();
}

function sortReviewTable(key) {
  if (reviewTableSort.key === key) reviewTableSort.dir = reviewTableSort.dir === 'asc' ? 'desc' : 'asc';
  else reviewTableSort = window.reviewTableSort = { key, dir: key === 'submitted' || key === 'id' || key === 'sla' ? 'desc' : 'asc' };
  renderReviewTable();
}

renderAllQ = function() {
  const status = document.getElementById('aq-filter-status')?.value || '';
  const issueField = document.getElementById('aq-filter-priority')?.value || '';
  const sla = document.getElementById('aq-filter-sla')?.value || '';
  const search = (document.getElementById('aq-search')?.value || '').toLowerCase();
  let filtered = (allQData || []).filter(q => {
    const field = getIssueField(q);
    const slaInfo = getSlaInfo(q);
    if (status && q.status !== status) return false;
    if (issueField && field !== issueField) return false;
    if (sla && slaInfo.key !== sla) return false;
    if (search &&
        !(q.question_id || '').toLowerCase().includes(search) &&
        !(q.task_id || '').toLowerCase().includes(search) &&
        !(q.question || '').toLowerCase().includes(search) &&
        !(q.submitter_name || '').toLowerCase().includes(search) &&
        !(q.status || '').toLowerCase().includes(search) &&
        !field.toLowerCase().includes(search)) return false;
    return true;
  });
  filtered = sortQuestionRows(filtered, allQTableSort);
  safeText('aq-count', `${filtered.length} question${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('allq-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">📭</div><h3>No matching questions</h3><p>Try clearing filters or searching by Bill ID, staff name, issue field, status, or SLA state.</p></div>';
    return;
  }
  const rows = filtered.map(q => `
    <tr data-task-id="${escAttr(q.task_id)}" data-status="${escAttr(q.status)}" onclick="allQRowClick(this.dataset.taskId,this.dataset.status)" style="cursor:pointer" title="${q.status === 'Answered' ? 'View answer' : 'Not yet answered'}">
      <td class="td-id">${escHtml(q.question_id || '—')}</td>
      <td class="td-task" style="color:var(--accent2);font-weight:600">${escHtml(q.task_id)}</td>
      <td class="td-q">${escHtml(q.question)}${getCommentStats(q.id).total > 0 ? `<div style="margin-top:6px">${renderFollowUpBadge(q.id)}</div>` : ''}</td>
      <td class="td-name">${escHtml(q.submitter_name || '')}</td>
      <td>${issueBadge(getIssueField(q))}</td>
      <td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td>
      <td class="td-date">${fmtDate(q.submitted_at)}</td>
    </tr>`).join('');
  document.getElementById('allq-table-wrap').innerHTML = `<div class="table-wrap"><table><thead><tr>${sortableHeader('ID','id',allQTableSort,'sortAllQTable')}${sortableHeader('Bill ID','billId',allQTableSort,'sortAllQTable')}${sortableHeader('Question','question',allQTableSort,'sortAllQTable')}${sortableHeader('From','from',allQTableSort,'sortAllQTable')}${sortableHeader('Issue Field','issue',allQTableSort,'sortAllQTable')}${sortableHeader('Status','status',allQTableSort,'sortAllQTable')}${sortableHeader('Submitted','submitted',allQTableSort,'sortAllQTable')}</tr></thead><tbody>${rows}</tbody></table></div>`;
};

renderReviewTable = function() {
  const filtered = sortQuestionRows(getFilteredReviewQuestions(), reviewTableSort);
  lastReviewFiltered = filtered;
  safeText('r-count', `${filtered.length} question${filtered.length !== 1 ? 's' : ''}`);
  if (filtered.length === 0) {
    document.getElementById('review-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">📭</div><h3>No matching questions</h3><p>Try clearing filters or searching by Bill ID, staff name, issue field, or status.</p></div>';
    return;
  }
  const rows = filtered.map(q => `
    <tr onclick="openModal('${q.id}')" style="cursor:pointer">
      <td class="cb-wrap" onclick="event.stopPropagation()"><input type="checkbox" class="row-cb question-cb" data-id="${q.id}" onchange="updateSelectBar()"></td>
      <td class="td-id">${escHtml(q.question_id || '—')}</td>
      <td class="td-task">${escHtml(q.task_id)}</td>
      <td class="td-q">${escHtml(q.question)}${getCommentStats(q.id).total > 0 ? `<div style="margin-top:6px">${renderFollowUpBadge(q.id)}</div>` : ''}</td>
      <td class="td-name">${escHtml(q.submitter_name || '')}</td>
      <td>${issueBadge(getIssueField(q))}</td>
      <td>${renderSlaBadge(q)}</td>
      <td><span class="status-badge s-${(q.status || 'Open').replace(' ','-')}">${escHtml(q.status || 'Open')}</span></td>
      <td class="td-date">${fmtDate(q.submitted_at)}</td>
      <td class="td-date">${fmtDate(getQuestionDueAt(q))}</td>
      <td class="td-date">${q.answered_date ? fmtDate(q.answered_date) : '—'}</td>
    </tr>`).join('');
  document.getElementById('review-table-wrap').innerHTML = `
    <div class="table-wrap review-table-wrap">
      <div class="review-table-scroll">
        <table>
          <thead><tr>
            <th style="width:40px"><input type="checkbox" class="row-cb" id="cb-all" onclick="toggleAll(this)" title="Select all"></th>
            ${sortableHeader('ID','id',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('Bill ID','billId',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('Question','question',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('From','from',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('Issue Field','issue',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('SLA','sla',reviewTableSort,'sortReviewTable')}
            ${sortableHeader('Status','status',reviewTableSort,'sortReviewTable')}
            <th>Submitted</th><th>Due</th><th>Answered</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
};

loadAnalyticsDashboard = async function() {
  if (!isAdmin()) return;
  const chartRoot = document.getElementById('chart-submitters');
  if (!chartRoot) return;
  try { await AppAPI.ensureChart(); } catch (err) { toast('Analytics chart library failed to load. ' + (err?.message || ''), 'error'); return; }
  const mostViewedBox = document.getElementById('most-viewed-questions');
  if (mostViewedBox) mostViewedBox.innerHTML = '<div class="loading"><div class="spinner"></div> Loading views...</div>';
  const legacyTable = document.getElementById('analytics-table');
  if (legacyTable) legacyTable.innerHTML = '<div style="padding:20px"><div class="skeleton"></div><div class="skeleton" style="margin-top:12px;width:75%"></div></div>';
  const period = document.getElementById('analytics-period')?.value || P3.analyticsPeriod || 'daily';
  P3.analyticsPeriod = period;
  const range = analyticsRange(period);
  const { data, error } = await sb
    .from('questions')
    .select(AppAPI.QUESTION_FIELDS)
    .gte('submitted_at', range.from.toISOString())
    .lte('submitted_at', range.to.toISOString())
    .order('submitted_at', { ascending: true }).limit(AppAPI.PAGE_SIZE);
  if (error) {
    if (mostViewedBox) mostViewedBox.innerHTML = `<div class="empty-premium"><strong>Analytics unavailable</strong>${escHtml(error.message)}</div>`;
    toast('Analytics unavailable: ' + error.message, 'error');
    return;
  }
  let rows = (data || []).filter(q => !isArchived(q));
  const sub = (document.getElementById('analytics-submitter')?.value || '').toLowerCase();
  if (sub) rows = rows.filter(q => [q.submitter_name, q.submitter_email].filter(Boolean).join(' ').toLowerCase().includes(sub));
  renderAnalytics(rows, period);
};

// ══════════════════════════════════════
// FINAL UPDATE: Most Viewed click-through, Seen by modal, smart capitalization + English-only spellcheck
// ══════════════════════════════════════
function answerSearchToken(q) {
  if (!q) return '';
  return q.question_id || q.task_id || '';
}

function jumpToAnsweredQuestion(questionId, refId, billId) {
  P3.pendingAnsweredJump = {
    id: questionId || '',
    ref: refId || '',
    bill: billId || '',
    searched: false,
    startedAt: Date.now()
  };
  showPage('faq');
  setTimeout(applyPendingAnsweredJump, 250);
  setTimeout(applyPendingAnsweredJump, 800);
}

function findFaqCardForJump(jump) {
  if (!jump) return null;
  if (jump.id) {
    const escapedId = (window.CSS && CSS.escape) ? CSS.escape(jump.id) : String(jump.id).replace(/\"/g, '\\"');
    const byId = document.querySelector(`.faq-card[data-question-id="${escapedId}"]`);
    if (byId) return byId;
  }
  const cards = [...document.querySelectorAll('.faq-card')];
  const ref = String(jump.ref || '').toLowerCase();
  const bill = String(jump.bill || '').toLowerCase();
  return cards.find(card => {
    const txt = (card.innerText || '').toLowerCase();
    return (ref && txt.includes(ref)) || (bill && txt.includes(bill));
  }) || null;
}

function applyPendingAnsweredJump() {
  const jump = P3.pendingAnsweredJump;
  if (!jump) return;
  const search = document.getElementById('faq-search');
  const token = jump.ref || jump.bill || '';
  let card = findFaqCardForJump(jump);
  if (!card && search && token && !jump.searched) {
    jump.searched = true;
    search.value = token;
    updateFaqSearchClearButton();
    const originalJump = P3.pendingAnsweredJump;
    const saved = P3.pendingAnsweredJump;
    P3.pendingAnsweredJump = null;
    renderFaq();
    P3.pendingAnsweredJump = saved || originalJump;
    card = findFaqCardForJump(jump);
  }
  if (!card) {
    if (Date.now() - jump.startedAt < 5000) setTimeout(applyPendingAnsweredJump, 400);
    return;
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('search-item', 'active');
  setTimeout(() => card.classList.remove('search-item', 'active'), 1800);
  const preview = card.querySelector('.faq-answer-preview');
  if (preview && !preview.classList.contains('open')) {
    toggleFaqCard(card, { target: card });
  }
  P3.pendingAnsweredJump = null;
}

const _finalRenderFaqForJump = renderFaq;
renderFaq = function() {
  _finalRenderFaqForJump();
  setTimeout(applyPendingAnsweredJump, 0);
};

renderSeenBadge = function(questionId) {
  const count = questionViewsByQuestion[questionId] || 0;
  const label = `👁 Seen by ${count}`;
  const title = count ? 'Click to see who viewed this answer' : 'Click to see answer view details';
  if (isAdmin()) {
    return `<button type="button" class="seen-badge" data-seen-badge-id="${escAttr(questionId)}" title="${escAttr(title)}" onclick="openSeenByModal('${escAttr(questionId)}', event)">${label}</button>`;
  }
  return `<span class="seen-badge" data-seen-badge-id="${escAttr(questionId)}" title="Answer view count">${label}</span>`;
};

async function renderMostViewedQuestions() {
  const box = document.getElementById('most-viewed-questions');
  if (!box) return;
  let source = (faqQuestions && faqQuestions.length ? faqQuestions : []).filter(q => q.status === 'Answered');
  if (!source.length) {
    const { data, error } = await sb.from('questions').select('id,question_id,task_id,question,status,answered_date,is_archived,archived_at').eq('status', 'Answered').limit(300);
    if (error) {
      box.innerHTML = `<div class="empty-premium"><strong>Most viewed questions unavailable</strong>${escHtml(error.message)}</div>`;
      return;
    }
    source = (data || []).filter(q => !isArchived(q));
  }
  await loadQuestionViewCounts(source.map(q => q.id));
  const rows = source
    .map(q => ({ ...q, views: questionViewsByQuestion[q.id] || 0 }))
    .sort((a,b) => (b.views - a.views) || new Date(b.answered_date || 0) - new Date(a.answered_date || 0))
    .slice(0, 10);
  if (!rows.length) {
    box.innerHTML = '<div class="empty-premium"><strong>No answered questions yet</strong>Most viewed questions will appear here after answers are viewed.</div>';
    return;
  }
  box.innerHTML = `<div class="most-viewed-list">${rows.map(q => `
    <div class="most-viewed-item clickable" role="button" tabindex="0"
      title="Open this answer in the Answered page"
      onclick="jumpToAnsweredQuestion('${escAttr(q.id)}','${escAttr(q.question_id || '')}','${escAttr(q.task_id || '')}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();jumpToAnsweredQuestion('${escAttr(q.id)}','${escAttr(q.question_id || '')}','${escAttr(q.task_id || '')}')}">
      <div class="most-viewed-main"><strong>${escHtml(q.question_id || q.task_id || 'Question')}</strong><div class="td-date">Bill ID ${escHtml(q.task_id || '—')}</div><div style="font-size:12px;color:var(--text2);margin-top:4px">${escHtml(String(q.question || '').slice(0, 140))}</div></div>
      ${renderSeenBadge(q.id)}
    </div>`).join('')}</div>`;
}

// Smart sentence capitalization and conservative English-only spellcheck.
const SMART_ENGLISH_WORDS = new Set('a about above after again against all am an and any are as ask at be because been before being below between both but by can cannot could did do does doing down during each few for from further get had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves answer question bill vendor expense payment status submitted reviewed'.split(' '));
const ROMANIZED_NEPALI_WORDS = new Set('ma chha cha xa ho haina chaina bhayo bhaye bhako nabhako garne gareko garnu kasari kina k ho ko lai le ra pani mero timro tapai hajur yesto testo tyo yo ani bhane bhanera huncha hunchha parcha parchha milcha milena aayena aayeko bhitra bahira sanga haru nai ta chai ramro naramro bhanda bhanchha re garnus garnu hos'.split(' '));
const DANISH_WORDS = new Set('og i det er en et som på de med han hun for ikke der var mig sig men den har om vi min havde ham hun eller hvad skal selv her alle vil blev kunne ind når være dog noget ville jo deres efter ned skulle denne end dette mit også under have dig anden hende mine sit sine vores jeres'.split(' '));

function shouldSmartWriteField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const tag = (el.tagName || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const cls = (el.className || '').toString().toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  if (type && !['text','search'].includes(type)) return false;
  if (cls.includes('filter-search') || id.includes('search') || id.includes('email') || id.includes('task') || id.includes('bill') || id.includes('url') || id.includes('link') || id.includes('timezone')) return false;
  if (placeholder.includes('bill id') || placeholder.includes('search') || placeholder.includes('email') || placeholder.includes('timezone')) return false;
  return true;
}

function capitalizeSentenceText(value) {
  // Forced capitalization was intentionally disabled. It corrupted URLs/domains
  // and could mutate partially edited words (for example http -> Http, google.com -> Google.Com).
  return String(value || '');
}

function applySentenceCapitalization(el) {
  // Keep the hook as a no-op so existing event listeners continue to work while
  // preserving exactly what the user typed in answers, follow-ups, Team Chat,
  // URLs, and pasted content.
  return;
}

function textTokens(text) {
  return String(text || '').toLowerCase().match(/[a-zæøå]+/g) || [];
}

function isLikelyNonEnglishText(text) {
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return false;
  if (/[\u0900-\u097F]/.test(raw)) return true;
  const tokens = textTokens(raw);
  if (!tokens.length) return false;
  const nepaliHits = tokens.filter(w => ROMANIZED_NEPALI_WORDS.has(w)).length;
  const danishHits = tokens.filter(w => DANISH_WORDS.has(w)).length;
  if (/[æøå]/i.test(raw) || danishHits >= Math.max(2, Math.ceil(tokens.length * 0.25))) return true;
  if (nepaliHits >= Math.max(2, Math.ceil(tokens.length * 0.22))) return true;
  // Mixed short phrases such as "bill ma vendor chha" should not be spellchecked as English.
  if (nepaliHits >= 1 && tokens.length <= 7) return true;
  return false;
}

function isLikelyEnglishText(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (isLikelyNonEnglishText(raw)) return false;
  const tokens = textTokens(raw).filter(w => w.length > 1);
  if (!tokens.length) return false;
  const englishHits = tokens.filter(w => SMART_ENGLISH_WORDS.has(w)).length;
  const asciiRatio = (raw.match(/[\x00-\x7F]/g) || []).length / Math.max(1, raw.length);
  if (asciiRatio < 0.94) return false;
  if (tokens.length <= 3) return englishHits >= 1;
  return englishHits >= 2 || englishHits / tokens.length >= 0.28;
}

function applySmartSpellcheck(el) {
  if (!shouldSmartWriteField(el)) return;
  const enabled = isLikelyEnglishText(el.value);
  el.spellcheck = enabled;
  el.setAttribute('spellcheck', enabled ? 'true' : 'false');
  el.setAttribute('lang', enabled ? 'en' : '');
  el.classList.toggle('smart-writing-enabled', enabled);
  el.classList.toggle('smart-spell-off', !enabled);
  if (enabled) {
    el.setAttribute('data-grammar', 'native-browser');
    el.title = el.title || 'English spellcheck/grammar suggestions are enabled for English text.';
  }
}

function enhanceSmartWriting(root = document) {
  const fields = root.querySelectorAll('textarea, input[type="text"], input:not([type])');
  fields.forEach(el => {
    if (!shouldSmartWriteField(el)) return;
    applySmartSpellcheck(el);
    el.setAttribute('autocapitalize', 'none');
  });
}

document.addEventListener('input', event => {
  const el = event.target;
  if (!shouldSmartWriteField(el)) return;
  applySentenceCapitalization(el);
  applySmartSpellcheck(el);
}, true);

document.addEventListener('focusin', event => {
  const el = event.target;
  if (!shouldSmartWriteField(el)) return;
  applySmartSpellcheck(el);
}, true);

const smartWritingObserver = new MutationObserver(mutations => {
  mutations.forEach(m => m.addedNodes && m.addedNodes.forEach(node => {
    if (node.nodeType === 1) enhanceSmartWriting(node);
  }));
});

window.addEventListener('DOMContentLoaded', () => {
  enhanceSmartWriting(document);
  try { smartWritingObserver.observe(document.body, { childList: true, subtree: true }); } catch (_err) {}
});

// ══════════════════════════════════════
// ADMIN CUSTOMIZATION SYSTEM
// Database-backed settings, no-code admin editing, live preview, and safe fallback.
// Tables needed: app_settings, admin_customization_activity; questions.custom_fields optional.
// ══════════════════════════════════════
const CUSTOMIZATION_SETTING_KEY = 'admin_customization_v1';
const CUSTOMIZATION_LOCAL_KEY = 'admin_customization_cache_v1';
const CUSTOMIZATION_DRAFT_KEY = 'admin_customization_draft_v1';
const CUSTOMIZATION_VERSION = 'Customizer v1.0';

const CUSTOM_DEFAULTS = {
  text: {
    submit_title: 'Submit a Question',
    submit_subtitle: 'Ask about your current task. We respond within 2 working days.',
    submit_tab_single: 'Single Question',
    submit_tab_bulk: 'Bulk Submit',
    submit_button: 'Submit Question',
    submit_clear: 'Clear',
    bill_label: 'Bill ID',
    bill_placeholder: 'Enter Bill ID',
    issue_label: 'Issue Field',
    question_label: 'Your question',
    question_placeholder: 'Describe your question clearly. Include what you have already tried if relevant.',
    allq_title: 'All Questions',
    allq_subtitle: 'View all questions submitted by the team — read only.',
    review_title: 'Reviewer Dashboard',
    review_subtitle: 'Review incoming questions, add answers, and update statuses.',
    answered_title: 'Data Entry Answered Questions',
    answered_subtitle: 'Browse all answered questions from the team',
    footer_text: '© 2026 HillsTribe Tech Solutions, Nepal · Privacy Policy · Data Entry Q&A Tracker'
  },
  theme: {
    font_family: 'DM Sans',
    font_size: '15',
    primary_color: '#1a1a2e',
    secondary_color: '#457b9d',
    accent_color: '#e63946',
    surface_color: '#ffffff',
    background_color: '#f8f9fa',
    card_radius: '12',
    sidebar_width: '240',
    table_density: 'comfortable',
    mode: 'system'
  },
  layout: {
    reviewStats: true,
    reviewerAlert: true,
    adminMetrics: true,
    adminWorkflow: true,
    answeredHero: true,
    dashboardCards: ['total','open','due','overdue','answered','ontime','followups']
  },
  form: {
    extraFields: []
  },
  notices: {
    submitNoticeEnabled: false,
    submitNoticeHtml: '<strong>Need help?</strong> Add the Bill ID and describe what you checked already.',
    adminNoticeHtml: '<strong>Admin Customization</strong> lets you change text, theme, layout, and forms without redeploying.'
  },
  features: {
    nativeSpellcheck: true,
    smartCapitalization: true,
    viewTracking: true
  }
};

let adminCustomization = deepClone(CUSTOM_DEFAULTS);
let adminCustomizationLoaded = false;
let adminCustomizationSource = 'defaults';
let customizationUndoStack = [];
let customizationDirtyTimer = null;
let customizationActivity = [];

function deepClone(obj) { return JSON.parse(JSON.stringify(obj || {})); }
function deepMerge(base, override) {
  const out = deepClone(base);
  Object.keys(override || {}).forEach(k => {
    if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], override[k]);
    else out[k] = override[k];
  });
  return out;
}
function getByPath(obj, path) { return String(path || '').split('.').reduce((acc,k) => acc && acc[k] != null ? acc[k] : undefined, obj); }
function setByPath(obj, path, val) {
  const parts = String(path || '').split('.');
  let cursor = obj;
  parts.slice(0,-1).forEach(k => { cursor[k] = cursor[k] || {}; cursor = cursor[k]; });
  cursor[parts[parts.length-1]] = val;
}

async function loadAdminCustomizationSettings(force = false) {
  if (adminCustomizationLoaded && !force) return adminCustomization;
  let loaded = null;
  let source = 'defaults';
  try {
    const { data, error } = await sb.from('app_settings').select('value,updated_at,updated_by').eq('key', CUSTOMIZATION_SETTING_KEY).maybeSingle();
    if (!error && data && data.value) { loaded = data.value; source = 'supabase'; }
  } catch (_err) {}
  if (!loaded) {
    try {
      const local = localStorage.getItem(CUSTOMIZATION_LOCAL_KEY);
      if (local) { loaded = JSON.parse(local); source = 'local cache'; }
    } catch (_err) {}
  }
  adminCustomization = deepMerge(CUSTOM_DEFAULTS, loaded || {});
  adminCustomizationSource = source;
  adminCustomizationLoaded = true;
  applyAdminCustomization();
  return adminCustomization;
}

async function saveAdminCustomizationSettings(reason = 'manual save') {
  if (!isAdmin()) { toast('Only admins can save customization changes.', 'error'); return; }
  const snapshot = deepClone(adminCustomization);
  localStorage.setItem(CUSTOMIZATION_LOCAL_KEY, JSON.stringify(snapshot));
  localStorage.removeItem(CUSTOMIZATION_DRAFT_KEY);
  adminCustomizationSource = 'local cache';
  try {
    const { error } = await sb.from('app_settings').upsert({
      key: CUSTOMIZATION_SETTING_KEY,
      value: snapshot,
      updated_by: currentUser?.email || 'admin',
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) throw error;
    adminCustomizationSource = 'supabase';
    await logCustomizationActivity('CUSTOMIZATION_SAVED', reason, snapshot);
    toast('Customization saved and applied.', 'success');
  } catch (err) {
    toast('Saved locally only. Run the customization SQL if Supabase says table missing: ' + (err.message || err), 'error');
  }
  renderCustomizationStatus();
  renderSystemStatusPane();
}

async function logCustomizationActivity(action, reason, snapshot) {
  const entry = { time: new Date().toISOString(), action, reason, by: currentUser?.email || 'unknown' };
  customizationActivity.unshift(entry);
  customizationActivity = customizationActivity.slice(0, 20);
  try { localStorage.setItem('admin_customization_activity_cache', JSON.stringify(customizationActivity)); } catch (_err) {}
  try {
    await sb.from('admin_customization_activity').insert({
      actor_email: currentUser?.email || null,
      actor_name: currentUser?.user_metadata?.full_name || currentUser?.email || null,
      action,
      reason,
      settings_snapshot: snapshot || adminCustomization
    });
  } catch (_err) {}
}

function scheduleCustomizationDraft() {
  clearTimeout(customizationDirtyTimer);
  customizationDirtyTimer = setTimeout(() => {
    try { localStorage.setItem(CUSTOMIZATION_DRAFT_KEY, JSON.stringify(adminCustomization)); } catch (_err) {}
    renderCustomizationStatus('Draft autosaved locally');
  }, 350);
}

function applyAdminCustomization() {
  const c = adminCustomization || CUSTOM_DEFAULTS;
  const root = document.documentElement;
  const body = document.body;
  const t = c.theme || {};
  if (t.primary_color) { root.style.setProperty('--brand', t.primary_color); body.style.setProperty('--brand', t.primary_color); }
  if (t.secondary_color) { root.style.setProperty('--accent2', t.secondary_color); body.style.setProperty('--accent2', t.secondary_color); }
  if (t.accent_color) { root.style.setProperty('--accent', t.accent_color); body.style.setProperty('--accent', t.accent_color); }
  if (t.surface_color && !body.classList.contains('dark')) root.style.setProperty('--surface', t.surface_color);
  if (t.background_color && !body.classList.contains('dark')) root.style.setProperty('--surface2', t.background_color);
  if (t.card_radius) root.style.setProperty('--radius', `${parseInt(t.card_radius,10) || 12}px`);
  if (t.card_radius) root.style.setProperty('--radius-sm', `${Math.max(6, (parseInt(t.card_radius,10) || 12) - 4)}px`);
  if (t.font_size) body.style.fontSize = `${parseInt(t.font_size,10) || 15}px`;
  if (t.font_family) body.style.fontFamily = `'${t.font_family}', sans-serif`;
  body.classList.toggle('table-density-compact', t.table_density === 'compact');
  body.classList.toggle('table-density-spacious', t.table_density === 'spacious');
  body.classList.toggle('table-density-comfortable', !t.table_density || t.table_density === 'comfortable');

  applyCustomTextBindings();
  applyCustomLayoutToggles();
  renderCustomSubmitFields();
  renderSubmitNotice();
  renderCustomizerPreview();
}

function applyCustomTextBindings() {
  const text = (adminCustomization && adminCustomization.text) || CUSTOM_DEFAULTS.text;
  const setText = (sel, val) => { const el = document.querySelector(sel); if (el && val != null) el.textContent = val; };
  const setPlaceholder = (sel, val) => { document.querySelectorAll(sel).forEach(el => { if (val != null) el.placeholder = val; }); };
  setText('#page-submit .page-header h1', text.submit_title);
  setText('#page-submit .page-header p', text.submit_subtitle);
  setText('#mode-single', text.submit_tab_single);
  setText('#mode-bulk', text.submit_tab_bulk);
  setText('#submit-btn-text', text.submit_button);
  const clearBtn = document.querySelector('#single-mode-wrap .btn-outline[onclick="clearForm()"]'); if (clearBtn) clearBtn.textContent = text.submit_clear;
  const labels = [...document.querySelectorAll('#single-mode-wrap .form-label, #bulk-mode-wrap .form-label')];
  labels.forEach(l => {
    const raw = l.textContent || '';
    if (raw.includes('Bill ID')) l.innerHTML = `${escHtml(text.bill_label || 'Bill ID')} <span class="req">*</span>`;
    if (raw.includes('Issue Field')) l.innerHTML = `${escHtml(text.issue_label || 'Issue Field')} <span class="req">*</span>`;
    if (raw.includes('Your question')) l.innerHTML = `${escHtml(text.question_label || 'Your question')} <span class="req">*</span>`;
  });
  setPlaceholder('#f-task-id', text.bill_placeholder);
  setPlaceholder('#f-question', text.question_placeholder);
  setText('#page-allq .allq-hero h1', text.allq_title);
  setText('#page-allq .allq-hero p', text.allq_subtitle);
  setText('#page-review .page-header h1', text.review_title);
  setText('#page-review .page-header p', text.review_subtitle);
  const faqTitle = document.querySelector('#page-faq .faq-hero h1'); if (faqTitle && text.answered_title) faqTitle.textContent = text.answered_title;
  setText('#page-faq .faq-hero p', text.answered_subtitle);
  const footer = document.getElementById('main-footer'); if (footer && text.footer_text) footer.innerHTML = escHtml(text.footer_text).replace(/ · /g, ' &nbsp;·&nbsp; ');
}

function applyCustomLayoutToggles() {
  const l = (adminCustomization && adminCustomization.layout) || CUSTOM_DEFAULTS.layout;
  const toggle = (sel, show) => document.querySelectorAll(sel).forEach(el => el.classList.toggle('hidden-by-admin-customizer', show === false));
  toggle('#page-review #stats-grid', l.reviewStats);
  toggle('#page-review #reviewer-alert', l.reviewerAlert);
  toggle('#page-admin .admin-mini-grid', l.adminMetrics);
}

function renderSubmitNotice() {
  const singleCard = document.querySelector('#single-mode-wrap .card');
  if (!singleCard) return;
  let notice = document.getElementById('custom-submit-notice');
  const n = adminCustomization.notices || CUSTOM_DEFAULTS.notices;
  if (!n.submitNoticeEnabled) { if (notice) notice.remove(); return; }
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'custom-submit-notice';
    notice.className = 'alert alert-info';
    notice.style.marginBottom = '20px';
    singleCard.insertBefore(notice, singleCard.firstChild);
  }
  notice.innerHTML = n.submitNoticeHtml || '';
}

function customFieldInputHtml(field) {
  const required = field.required ? ' required' : '';
  const label = `<label class="form-label">${escHtml(field.label || 'Custom field')}${field.required ? ' <span class="req">*</span>' : ''}</label>`;
  const cls = field.full ? 'form-group full' : 'form-group';
  const id = `custom-field-${escAttr(field.id)}`;
  if (field.type === 'textarea') return `<div class="${cls}" data-custom-form-field="${escAttr(field.id)}">${label}<textarea class="form-textarea" id="${id}" placeholder="${escAttr(field.placeholder || '')}"${required}></textarea></div>`;
  if (field.type === 'select') {
    const opts = String(field.options || '').split('\n').map(x => x.trim()).filter(Boolean);
    return `<div class="${cls}" data-custom-form-field="${escAttr(field.id)}">${label}<select class="form-select" id="${id}"${required}>${opts.map(o => `<option>${escHtml(o)}</option>`).join('')}</select></div>`;
  }
  if (field.type === 'checkbox') return `<div class="${cls}" data-custom-form-field="${escAttr(field.id)}"><label class="form-label" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="${id}"${required}> ${escHtml(field.label || 'Custom checkbox')}</label></div>`;
  return `<div class="${cls}" data-custom-form-field="${escAttr(field.id)}">${label}<input type="text" class="form-input" id="${id}" placeholder="${escAttr(field.placeholder || '')}"${required}></div>`;
}

function renderCustomSubmitFields() {
  document.querySelectorAll('[data-custom-form-field]').forEach(el => el.remove());
  const fields = ((adminCustomization.form || {}).extraFields || []).filter(f => f.enabled !== false);
  if (!fields.length) return;
  const qGroup = document.querySelector('#single-mode-wrap #f-question')?.closest('.form-group');
  if (!qGroup) return;
  const html = fields.map(customFieldInputHtml).join('');
  qGroup.insertAdjacentHTML('beforebegin', html);
  enhanceSmartWriting(document);
}

function collectCustomFormValues() {
  const values = {};
  const fields = ((adminCustomization.form || {}).extraFields || []).filter(f => f.enabled !== false);
  for (const f of fields) {
    const el = document.getElementById(`custom-field-${f.id}`);
    if (!el) continue;
    const value = f.type === 'checkbox' ? el.checked : String(el.value || '').trim();
    if (f.required && (value === '' || value === false)) throw new Error(`${f.label || 'Custom field'} is required`);
    values[f.id] = { label: f.label || f.id, value, type: f.type || 'text' };
  }
  return values;
}

function getCustomizationHtml() {
  return `<section class="admin-custom-card admin-grid-full">
    <div class="admin-section-title"><div><h3>🎛️ Admin Customization</h3><p class="admin-custom-muted">Manage app text, theme, layout, form fields, and notices without editing source code or redeploying. Settings are cached locally and stored in Supabase when the SQL tables are available.</p></div><div class="admin-actions-row"><button class="btn btn-outline btn-sm" onclick="loadAdminCustomizationSettings(true); populateCustomizationUI(); toast('Customization reloaded','success')">↻ Reload</button><button class="btn btn-success btn-sm" onclick="saveAdminCustomizationSettings('saved from Admin Customization page')">Save changes</button></div></div>
    <div id="customization-status" class="alert alert-info" style="margin-bottom:14px">Loading customization settings...</div>
    <div class="customizer-tabs">
      ${['text:Text','theme:Theme','layout:Layout','forms:Forms','notices:Rich Text','preview:Live Preview','safety:Safety'].map(x => { const [k,l]=x.split(':'); return `<button class="customizer-tab" data-custom-pane="${k}" onclick="switchCustomizerPane('${k}')">${l}</button>`; }).join('')}
    </div>
    <div class="customizer-columns"><div>
      <div class="customizer-pane" id="custom-pane-text">${customTextPaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-theme">${customThemePaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-layout">${customLayoutPaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-forms">${customFormsPaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-notices">${customNoticesPaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-preview">${customPreviewPaneHtml()}</div>
      <div class="customizer-pane" id="custom-pane-safety">${customSafetyPaneHtml()}</div>
    </div><aside class="customizer-live"><div class="customizer-preview"><div class="customizer-pill">Live preview</div><div id="customizer-live-preview"></div></div></aside></div>
  </section>`;
}

function customInput(path, label, type = 'text') { return `<div class="customizer-field"><label>${label}</label><input data-custom-path="${path}" type="${type}" oninput="customizerInputChanged(this)"></div>`; }
function customTextarea(path, label) { return `<div class="customizer-field"><label>${label}</label><textarea data-custom-path="${path}" oninput="customizerInputChanged(this)"></textarea></div>`; }
function customTextPaneHtml(){ return `<div class="customizer-grid">${customInput('text.submit_title','Submit page title')}${customInput('text.submit_subtitle','Submit subtitle')}${customInput('text.submit_tab_single','Single tab text')}${customInput('text.submit_tab_bulk','Bulk tab text')}${customInput('text.submit_button','Submit button text')}${customInput('text.submit_clear','Clear button text')}${customInput('text.bill_label','Bill label')}${customInput('text.bill_placeholder','Bill placeholder')}${customInput('text.issue_label','Issue label')}${customInput('text.question_label','Question label')}${customTextarea('text.question_placeholder','Question placeholder')}${customInput('text.allq_title','All Questions title')}${customInput('text.allq_subtitle','All Questions subtitle')}${customInput('text.review_title','Review title')}${customInput('text.review_subtitle','Review subtitle')}${customInput('text.answered_title','Answered title')}${customInput('text.answered_subtitle','Answered subtitle')}${customInput('text.footer_text','Footer text')}</div>`; }
function customThemePaneHtml(){ return `<div class="customizer-grid three">${customInput('theme.font_family','Font family')}${customInput('theme.font_size','Base font size','number')}${customInput('theme.primary_color','Primary color','color')}${customInput('theme.secondary_color','Secondary color','color')}${customInput('theme.accent_color','Accent color','color')}${customInput('theme.surface_color','Card/surface color','color')}${customInput('theme.background_color','Page background','color')}${customInput('theme.card_radius','Card radius','number')}<div class="customizer-field"><label>Table density</label><select data-custom-path="theme.table_density" onchange="customizerInputChanged(this)"><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></div><div class="customizer-field"><label>Mode preference</label><select data-custom-path="theme.mode" onchange="customizerInputChanged(this)"><option value="system">System / user toggle</option><option value="light">Light default</option><option value="dark">Dark default</option></select></div></div>`; }
function customLayoutPaneHtml(){ return `<div class="customizer-grid"><label class="customizer-drag-item"><span>Show Review dashboard stats</span><input data-custom-path="layout.reviewStats" type="checkbox" onchange="customizerInputChanged(this)"></label><label class="customizer-drag-item"><span>Show reviewer alert</span><input data-custom-path="layout.reviewerAlert" type="checkbox" onchange="customizerInputChanged(this)"></label><label class="customizer-drag-item"><span>Show Admin top metrics</span><input data-custom-path="layout.adminMetrics" type="checkbox" onchange="customizerInputChanged(this)"></label></div><div class="admin-custom-muted" style="margin-top:12px">Dashboard card reordering uses native browser drag-and-drop to keep the app free and lightweight.</div><div id="custom-dashboard-card-list" class="customizer-drag-list"></div>`; }
function customFormsPaneHtml(){ return `<div class="admin-custom-muted">Add optional fields to the Submit Question form. Values are saved to <code>questions.custom_fields</code> when the SQL update has been run; otherwise the app safely falls back to normal submission.</div><div class="customizer-toolbar"><button class="btn btn-primary btn-sm" onclick="addCustomFormField()">+ Add field</button><button class="btn btn-outline btn-sm" onclick="renderCustomFormBuilder()">Refresh preview</button></div><div id="custom-form-builder-list" class="customizer-drag-list"></div>`; }
function customNoticesPaneHtml(){ return `<div class="customizer-field"><label style="display:flex;gap:8px;align-items:center"><input data-custom-path="notices.submitNoticeEnabled" type="checkbox" onchange="customizerInputChanged(this)"> Show notice on Submit page</label></div><label class="form-label">Submit page notice / help text</label>${richEditorHtml('notices.submitNoticeHtml')}<div style="height:14px"></div><label class="form-label">Admin notice / documentation text</label>${richEditorHtml('notices.adminNoticeHtml')}`; }
function customPreviewPaneHtml(){ return `<div class="admin-custom-muted">Preview shows the current draft before saving. Text, theme, notices, and form fields update instantly.</div><div class="customizer-preview"><div id="custom-preview-full"></div></div>`; }
function customSafetyPaneHtml(){ return `<div class="customizer-toolbar"><button class="btn btn-success" onclick="saveAdminCustomizationSettings('manual safety save')">Save to Supabase</button><button class="btn btn-outline" onclick="undoCustomizationChange()">Undo last change</button><button class="btn btn-danger" onclick="resetAdminCustomization()">Reset to defaults</button><button class="btn btn-outline" onclick="downloadCustomizationJson()">Export JSON backup</button></div><div class="alert alert-warn">Use Reset only when you want to restore defaults. A local draft is autosaved while editing. Keep a JSON backup before major changes.</div><div id="customization-activity-list" class="admin-log-list"></div>`; }
function richEditorHtml(path){ const id = 'rich-' + path.replace(/\W+/g,'-'); return `<div class="rich-editor" data-rich-path="${path}"><div class="rich-editor-toolbar"><button type="button" onclick="richCmd('${id}','bold')"><b>B</b></button><button type="button" onclick="richCmd('${id}','italic')"><i>I</i></button><button type="button" onclick="richCmd('${id}','underline')"><u>U</u></button><button type="button" onclick="richCmd('${id}','insertUnorderedList')">• List</button><button type="button" onclick="richLink('${id}')">Link</button><input type="color" title="Text color" onchange="richCmd('${id}','foreColor',this.value)"><select onchange="richFontSize('${id}',this.value)"><option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option></select></div><div id="${id}" class="rich-editor-body" contenteditable="true" spellcheck="true" lang="en" oninput="richEditorChanged('${id}','${path}')"></div></div>`; }

function switchCustomizerPane(k) { document.querySelectorAll('.customizer-tab').forEach(b => b.classList.toggle('active', b.dataset.customPane === k)); document.querySelectorAll('.customizer-pane').forEach(p => p.classList.toggle('active', p.id === 'custom-pane-' + k)); if (k === 'forms') renderCustomFormBuilder(); if (k === 'layout') renderDashboardCardList(); if (k === 'safety') renderCustomizationActivity(); renderCustomizerPreview(); }
function customizerInputChanged(el) { customizationUndoStack.push(deepClone(adminCustomization)); if (customizationUndoStack.length > 20) customizationUndoStack.shift(); const path = el.dataset.customPath; const val = el.type === 'checkbox' ? el.checked : el.value; setByPath(adminCustomization, path, val); applyAdminCustomization(); scheduleCustomizationDraft(); renderCustomizerPreview(); }
function populateCustomizationUI() { const root = document.getElementById('admin-pane-customization'); if (!root) return; root.querySelectorAll('[data-custom-path]').forEach(el => { const val = getByPath(adminCustomization, el.dataset.customPath); if (el.type === 'checkbox') el.checked = Boolean(val); else el.value = val ?? ''; }); root.querySelectorAll('.rich-editor').forEach(w => { const path = w.dataset.richPath; const ed = w.querySelector('.rich-editor-body'); if (ed) ed.innerHTML = getByPath(adminCustomization, path) || ''; }); renderCustomFormBuilder(); renderDashboardCardList(); renderCustomizerPreview(); renderCustomizationStatus(); const active = root.querySelector('.customizer-tab.active')?.dataset.customPane || 'text'; switchCustomizerPane(active); }
function renderCustomizationStatus(note) { const el = document.getElementById('customization-status'); if (!el) return; el.className = 'alert alert-info'; el.innerHTML = `<strong>${escHtml(CUSTOMIZATION_VERSION)}</strong> · Source: ${escHtml(adminCustomizationSource)} · ${escHtml(note || 'Changes apply live. Save to make them permanent.')}`; }
function renderCustomizerPreview() { const text = adminCustomization.text || {}; const fields = ((adminCustomization.form || {}).extraFields || []).filter(f => f.enabled !== false); const html = `<div class="customizer-preview-card"><div class="customizer-preview-title">${escHtml(text.submit_title || '')}</div><p class="admin-custom-muted">${escHtml(text.submit_subtitle || '')}</p><div class="submit-mode-toggle" style="margin-top:12px"><button class="mode-btn active">${escHtml(text.submit_tab_single || '')}</button><button class="mode-btn">${escHtml(text.submit_tab_bulk || '')}</button></div><div style="margin-top:14px"><label class="form-label">${escHtml(text.bill_label || 'Bill ID')} <span class="req">*</span></label><input class="form-input" placeholder="${escAttr(text.bill_placeholder || '')}"></div><div style="margin-top:12px"><label class="form-label">${escHtml(text.question_label || 'Question')} <span class="req">*</span></label><textarea class="form-textarea" placeholder="${escAttr(text.question_placeholder || '')}"></textarea></div>${fields.length ? `<div class="admin-custom-muted" style="margin-top:10px">${fields.length} custom form field${fields.length!==1?'s':''} enabled</div>` : ''}<button class="btn btn-primary" style="margin-top:14px">${escHtml(text.submit_button || 'Submit')}</button></div>`; const a = document.getElementById('customizer-live-preview'); if (a) a.innerHTML = html; const b = document.getElementById('custom-preview-full'); if (b) b.innerHTML = html + `<div style="margin-top:14px" class="customizer-preview-card"><strong>Notice preview</strong><div style="margin-top:8px">${adminCustomization.notices?.submitNoticeHtml || ''}</div></div>`; }
function richCmd(id, cmd, value = null) { const ed = document.getElementById(id); if (ed) ed.focus(); document.execCommand(cmd, false, value); const path = ed?.closest('.rich-editor')?.dataset.richPath; if (path) richEditorChanged(id, path); }
function richLink(id) { const url = prompt('Enter link URL'); if (url) richCmd(id, 'createLink', url); }
function richFontSize(id, size) { if (size) richCmd(id, 'fontSize', size); }
function richEditorChanged(id, path) { customizationUndoStack.push(deepClone(adminCustomization)); const ed = document.getElementById(id); setByPath(adminCustomization, path, ed ? ed.innerHTML : ''); applyAdminCustomization(); scheduleCustomizationDraft(); }

function addCustomFormField() { const id = 'field_' + Date.now().toString(36); adminCustomization.form.extraFields.push({ id, label:'New field', type:'text', placeholder:'', required:false, enabled:true, options:'' }); renderCustomFormBuilder(); applyAdminCustomization(); scheduleCustomizationDraft(); }
function updateCustomFormField(id, key, value) { const f = adminCustomization.form.extraFields.find(x => x.id === id); if (!f) return; f[key] = value; renderCustomSubmitFields(); scheduleCustomizationDraft(); renderCustomizerPreview(); }
function removeCustomFormField(id) { if (!confirm('Remove this custom field?')) return; adminCustomization.form.extraFields = adminCustomization.form.extraFields.filter(f => f.id !== id); renderCustomFormBuilder(); applyAdminCustomization(); scheduleCustomizationDraft(); }
function moveCustomFormField(id, dir) { const arr = adminCustomization.form.extraFields; const i = arr.findIndex(f => f.id === id); const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; renderCustomFormBuilder(); applyAdminCustomization(); scheduleCustomizationDraft(); }
function renderCustomFormBuilder() { const box = document.getElementById('custom-form-builder-list'); if (!box) return; const fields = adminCustomization.form.extraFields || []; if (!fields.length) { box.innerHTML = '<div class="empty-premium"><strong>No custom fields yet</strong>Add a field to extend the Submit Question form without editing code.</div>'; return; } box.innerHTML = fields.map(f => `<div class="customizer-drag-item"><div style="flex:1"><div class="customizer-grid three"><div class="customizer-field"><label>Label</label><input value="${escAttr(f.label||'')}" oninput="updateCustomFormField('${escAttr(f.id)}','label',this.value)"></div><div class="customizer-field"><label>Type</label><select onchange="updateCustomFormField('${escAttr(f.id)}','type',this.value)"><option value="text" ${f.type==='text'?'selected':''}>Text</option><option value="textarea" ${f.type==='textarea'?'selected':''}>Textarea</option><option value="select" ${f.type==='select'?'selected':''}>Dropdown</option><option value="checkbox" ${f.type==='checkbox'?'selected':''}>Checkbox</option></select></div><div class="customizer-field"><label>Placeholder</label><input value="${escAttr(f.placeholder||'')}" oninput="updateCustomFormField('${escAttr(f.id)}','placeholder',this.value)"></div></div><div class="customizer-field"><label>Dropdown options, one per line</label><textarea oninput="updateCustomFormField('${escAttr(f.id)}','options',this.value)">${escHtml(f.options||'')}</textarea></div></div><div class="customizer-item-actions"><label class="customizer-pill"><input type="checkbox" ${f.required?'checked':''} onchange="updateCustomFormField('${escAttr(f.id)}','required',this.checked)"> Required</label><label class="customizer-pill"><input type="checkbox" ${f.enabled!==false?'checked':''} onchange="updateCustomFormField('${escAttr(f.id)}','enabled',this.checked)"> Enabled</label><button class="btn btn-outline btn-sm" onclick="moveCustomFormField('${escAttr(f.id)}',-1)">↑</button><button class="btn btn-outline btn-sm" onclick="moveCustomFormField('${escAttr(f.id)}',1)">↓</button><button class="btn btn-danger btn-sm" onclick="removeCustomFormField('${escAttr(f.id)}')">Remove</button></div></div>`).join(''); }

function renderDashboardCardList() { const box = document.getElementById('custom-dashboard-card-list'); if (!box) return; const labels = { total:'Active questions', open:'Open', due:'Due today', overdue:'Overdue', answered:'Answered', ontime:'Answered on time', followups:'Unresolved follow-ups' }; const arr = adminCustomization.layout.dashboardCards || CUSTOM_DEFAULTS.layout.dashboardCards; box.innerHTML = arr.map((key,i) => `<div class="customizer-drag-item" draggable="true" data-card-key="${key}" ondragstart="this.classList.add('dragging');event.dataTransfer.setData('text/plain','${key}')" ondragend="this.classList.remove('dragging')" ondragover="event.preventDefault()" ondrop="dropDashboardCard(event,'${key}')"><span>↕ ${escHtml(labels[key] || key)}</span><span class="customizer-item-actions"><button class="btn btn-outline btn-sm" onclick="moveDashboardCard(${i},-1)">↑</button><button class="btn btn-outline btn-sm" onclick="moveDashboardCard(${i},1)">↓</button></span></div>`).join(''); }
function moveDashboardCard(i, dir) { const arr = adminCustomization.layout.dashboardCards || []; const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; renderDashboardCardList(); scheduleCustomizationDraft(); }
function dropDashboardCard(event, targetKey) { event.preventDefault(); const fromKey = event.dataTransfer.getData('text/plain'); const arr = adminCustomization.layout.dashboardCards || []; const i = arr.indexOf(fromKey), j = arr.indexOf(targetKey); if (i < 0 || j < 0 || i === j) return; arr.splice(j,0,arr.splice(i,1)[0]); renderDashboardCardList(); scheduleCustomizationDraft(); }
function undoCustomizationChange() { const last = customizationUndoStack.pop(); if (!last) { toast('Nothing to undo.', ''); return; } adminCustomization = last; applyAdminCustomization(); populateCustomizationUI(); toast('Last customization change undone.', 'success'); }
async function resetAdminCustomization() { if (!confirm('Reset all customization settings to defaults?')) return; customizationUndoStack.push(deepClone(adminCustomization)); adminCustomization = deepClone(CUSTOM_DEFAULTS); applyAdminCustomization(); populateCustomizationUI(); await saveAdminCustomizationSettings('reset to defaults'); }
function downloadCustomizationJson() { const blob = new Blob([JSON.stringify(adminCustomization, null, 2)], { type:'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `admin-customization-${todayStamp ? todayStamp() : Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href); }
function renderCustomizationActivity() { const box = document.getElementById('customization-activity-list'); if (!box) return; let rows = customizationActivity; try { rows = rows.length ? rows : JSON.parse(localStorage.getItem('admin_customization_activity_cache') || '[]'); } catch (_err) {} box.innerHTML = rows.length ? rows.map(r => `<div class="admin-log-item"><div class="admin-log-top"><span class="admin-log-action">${escHtml(r.action)}</span><span class="admin-log-time">${fmtDateFull(r.time)}</span></div><div class="admin-log-body">${escHtml(r.reason || '')} · ${escHtml(r.by || '')}</div></div>`).join('') : '<div class="empty-premium"><strong>No customization activity yet</strong>Saved changes will appear here.</div>'; }

async function renderSystemStatusPane() {
  const pane = document.getElementById('admin-pane-system');
  if (!pane) return;
  const isDark = document.body.classList.contains('dark');
  const settingsSource = adminCustomizationSource || 'defaults';
  const user = currentUser?.email || 'Not signed in';
  const admin = isAdmin() ? 'Admin' : 'Non-admin';
  const reviewer = isReviewer() ? 'Reviewer access' : 'No reviewer access';
  let qCount = (allQuestions && allQuestions.length) || (allQData && allQData.length) || 0;
  let settingsHealth = 'Not checked';
  try {
    const { error } = await sb.from('app_settings').select('key').limit(1);
    settingsHealth = error ? 'SQL table missing / RLS blocked' : 'Connected';
  } catch (_err) { settingsHealth = 'Unavailable'; }
  pane.innerHTML = `<section class="admin-card admin-grid-full"><div class="admin-section-title"><div><h3>⚙️ System Status</h3><p class="admin-card-subtitle">Operational health for the Data Entry Q&A app, customization engine, database settings, and current user access.</p></div><button class="btn btn-outline btn-sm" onclick="renderSystemStatusPane()">↻ Refresh status</button></div><div class="admin-status-grid"><div class="admin-status-item"><div class="admin-status-value admin-status-ok">Online</div><div class="admin-status-label">Frontend app</div></div><div class="admin-status-item"><div class="admin-status-value ${settingsHealth==='Connected'?'admin-status-ok':'admin-status-warn'}">${escHtml(settingsHealth)}</div><div class="admin-status-label">Customization settings table</div></div><div class="admin-status-item"><div class="admin-status-value">${escHtml(settingsSource)}</div><div class="admin-status-label">Settings source</div></div><div class="admin-status-item"><div class="admin-status-value">${escHtml(admin)}</div><div class="admin-status-label">Current role</div></div><div class="admin-status-item"><div class="admin-status-value">${escHtml(reviewer)}</div><div class="admin-status-label">Reviewer permission</div></div><div class="admin-status-item"><div class="admin-status-value">${qCount}</div><div class="admin-status-label">Questions loaded in memory</div></div><div class="admin-status-item"><div class="admin-status-value">${isDark ? 'Dark' : 'Light'}</div><div class="admin-status-label">Current appearance</div></div><div class="admin-status-item"><div class="admin-status-value">${escHtml(CUSTOMIZATION_VERSION)}</div><div class="admin-status-label">Customization system</div></div><div class="admin-status-item"><div class="admin-status-value">${escHtml(user)}</div><div class="admin-status-label">Signed-in user</div></div></div><div class="alert alert-info" style="margin-top:16px"><strong>Maintenance notes:</strong> settings are loaded from Supabase when available, cached in localStorage for resilience, and applied through CSS variables plus dynamic text bindings. Heavy editors are avoided; rich text uses a lightweight native contenteditable editor.</div></section>`;
}

function ensureAdminCustomizationTab() {
  const dash = document.querySelector('#page-admin .admin-dashboard');
  const tabbar = document.getElementById('admin-tabbar');
  if (!dash || !tabbar) return;
  if (!document.querySelector('[data-tab="customization"]')) {
    const btn = document.createElement('button');
    btn.className = 'admin-tab';
    btn.dataset.tab = 'customization';
    btn.textContent = 'Customization';
    btn.onclick = () => switchAdminTab('customization');
    const systemBtn = document.querySelector('[data-tab="system"]');
    tabbar.insertBefore(btn, systemBtn || null);
  }
  let pane = document.getElementById('admin-pane-customization');
  if (!pane) {
    pane = document.createElement('div');
    pane.className = 'admin-pane';
    pane.id = 'admin-pane-customization';
    pane.innerHTML = getCustomizationHtml();
    dash.appendChild(pane);
  } else if (!pane.innerHTML.trim()) pane.innerHTML = getCustomizationHtml();
  if (document.getElementById('admin-pane-system')) renderSystemStatusPane();
}

const _customizerSetupAdminTabs = setupAdminTabs;
setupAdminTabs = function() {
  _customizerSetupAdminTabs();
  ensureAdminCustomizationTab();
  if (P3.adminTab === 'customization') switchAdminTab('customization');
};

const _customizerSwitchAdminTab = switchAdminTab;
switchAdminTab = function(k) {
  if (k === 'customization') ensureAdminCustomizationTab();
  _customizerSwitchAdminTab(k);
  if (k === 'customization') { loadAdminCustomizationSettings().then(() => populateCustomizationUI()); }
  if (k === 'system') renderSystemStatusPane();
};

const _customizerLoadAdminPanel = loadAdminPanel;
loadAdminPanel = async function() {
  await loadAdminCustomizationSettings();
  await _customizerLoadAdminPanel();
  ensureAdminCustomizationTab();
  applyAdminCustomization();
  if (P3.adminTab === 'system') renderSystemStatusPane();
};

const _customizerShowPage = showPage;
showPage = function(id) {
  _customizerShowPage(id);
  setTimeout(() => { loadAdminCustomizationSettings().then(applyAdminCustomization); }, 80);
};

// Override single-submit to collect custom dynamic fields and safely retry if the DB column has not been added yet.
submitQuestion = async function() {
  const taskId = document.getElementById('f-task-id').value.trim();
  const question = document.getElementById('f-question').value.trim();
  const issueField = document.getElementById('f-priority').value;
  let customFields = {};
  try { customFields = collectCustomFormValues(); } catch (err) { toast(err.message, 'error'); return; }
  if (!taskId) { toast('Please enter a Bill ID', 'error'); return; }
  if (!question) { toast('Please enter your question', 'error'); return; }
  if (question.length < 10) { toast('Question must be at least 10 characters', 'error'); return; }
  const btn = document.getElementById('btn-submit');
  const btnText = document.getElementById('submit-btn-text');
  btn.disabled = true;
  btnText.textContent = 'Submitting...';
  const name = currentUser.user_metadata?.full_name || currentUser.email.split('@')[0];
  const email = currentUser.email;
  // Issue 1F: pick up attachments that the outer wrapper collected from the
  // attachment side-channel (rather than from the textarea value).
  const attachments = Array.isArray(window.__pendingSubmitAttachments) ? window.__pendingSubmitAttachments : [];
  window.__pendingSubmitAttachments = null;
  let payload = makeQuestionInsertPayload({ submitter_name:name, submitter_email:email, task_id:taskId, question, issue_field:issueField, status:'Open', attachments });
  if (Object.keys(customFields).length) payload.custom_fields = customFields;
  let result = await sb.from('questions').insert(payload).select().single();
  // Gracefully retry if the attachments or custom_fields column hasn't been added yet.
  if (result.error && /attachments|column/i.test(result.error.message || '')) {
    const fallback = { ...payload };
    delete fallback.attachments;
    result = await sb.from('questions').insert(fallback).select().single();
  }
  if (result.error && /custom_fields|column/i.test(result.error.message || '')) {
    delete payload.custom_fields;
    delete payload.attachments;
    result = await sb.from('questions').insert(payload).select().single();
  }
  const { data, error } = result;
  if (error) { toast('Failed to submit: ' + error.message, 'error'); btn.disabled = false; btnText.textContent = (adminCustomization.text?.submit_button || 'Submit Question'); return; }
  await logActivity('QUESTION_CREATED', 'questions', data.id, data.question_id || taskId, { bill_id: taskId, issue_field: issueField, custom_fields: Object.keys(customFields).length, attachments: attachments.length });
  document.getElementById('success-title').textContent = 'Question submitted!';
  document.getElementById('success-qid').textContent = `Your Question ID: ${data.question_id}\nSLA due date: ${fmtDateFull(data.due_at || getQuestionDueAt(data))}`;
  document.getElementById('submit-form-wrap').style.display = 'none';
  document.getElementById('submit-success').style.display = 'block';
};

// Load settings early; failures fall back to defaults/local cache without blocking app startup.
loadAdminCustomizationSettings();

// ══════════════════════════════════════
// LIGHTWEIGHT COLLABORATION SYSTEM
// Supabase tables are created by collaboration_system_update.sql.
// Modules: notifications, mentions, channels, realtime chat, activity hooks.
// ══════════════════════════════════════
const COLLAB = {
  initialized:false,
  users:[],
  usersByUsername:{},
  usersByEmail:{},
  channels:[],
  currentChannelId:localStorage.getItem('collabCurrentChannelId') || null,
  messages:[],
  reactions:{},
  reads:{},
  typing:{},
  notifications:[],
  unread:0,
  subs:{messages:null, notifications:null, typing:null, reads:null, reactions:null},
  typingTimer:null,
  mentionTarget:null,
  mentionIndex:0,
  lastPresenceAt:0
};

function collabHtml(v) { return String(v ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function collabAttr(v) { return collabHtml(v).replace(/'/g, '&#39;'); }
function collabInitials(nameOrEmail) {
  const s = String(nameOrEmail || '?').trim();
  if (!s) return '?';
  const parts = s.includes('@') ? [s[0]] : s.split(/\s+/).slice(0,2).map(p => p[0]);
  return parts.join('').toUpperCase().slice(0,2);
}
function collabUsernameFromEmail(email) {
  return String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0,32) || 'user';
}
function collabCurrentName() { return currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'User'; }
function collabCurrentRole() { return isAdmin() ? 'admin' : isReviewer() ? 'reviewer' : 'staff'; }
function collabVisibleRole(role) { return role === 'admin' ? 'Admin' : role === 'reviewer' ? 'Reviewer' : 'Staff'; }
function collabCanManageChannel(ch) { return isAdmin() || (isReviewer() && (!ch || ch.created_by === currentUser?.email)); }
function collabOpenError(label, error) { if (error) console.warn(label, error.message || error); }

function ensureCollaborationPage() {
  if (document.getElementById('page-collab')) return;
  const page = document.createElement('div');
  page.id = 'page-collab';
  page.className = 'page';
  page.innerHTML = `
    <div class="collab-hero">
      <div class="collab-hero-inner">
        <h1>Team Chat</h1>
        <p>Slack-style channels, @mentions, realtime notifications, and lightweight workflow chat powered by Supabase Realtime.</p>
      </div>
    </div>
    <div class="collab-shell">
      <aside class="collab-sidebar">
        <div class="collab-sidebar-head">
          <div><div class="collab-sidebar-title">Channels</div><div class="collab-sidebar-sub">Public/private spaces for workflow updates.</div></div>
          <button class="btn btn-outline btn-sm" id="collab-toggle-create" onclick="toggleCreateChannelBox()" style="display:none">＋</button>
        </div>
        <div class="collab-channel-list" id="collab-channel-list"><div class="loading"><div class="spinner"></div> Loading channels...</div></div>
        <div class="collab-create-box" id="collab-create-box">
          <div class="form-group" style="margin-bottom:10px"><label class="form-label">Channel name</label><input class="form-input" id="collab-new-channel-name" placeholder="e.g. reviewer-updates"></div>
          <div class="form-group" style="margin-bottom:10px"><label class="form-label">Description</label><input class="form-input" id="collab-new-channel-desc" placeholder="What is this channel for?"></div>
          <div class="form-group" style="margin-bottom:10px"><label class="form-label">Visibility</label><select class="form-select" id="collab-new-channel-visibility"><option value="public">Public</option><option value="private">Private</option></select></div>
          <button class="btn btn-primary btn-sm" onclick="createCollabChannel()">Create channel</button>
        </div>
      </aside>
      <main class="collab-main">
        <div class="collab-chat-head">
          <div><div class="collab-channel-name" id="collab-channel-name">Select a channel</div><div class="collab-channel-sub" id="collab-channel-sub">Choose a channel to start collaborating.</div></div>
          <div class="collab-chat-head-actions">
            <button class="btn btn-outline btn-sm" id="collab-edit-channel-btn" onclick="openEditCollabChannelModal()" style="display:none">Edit channel</button>
            <button class="btn btn-outline btn-sm collab-channel-danger" id="collab-delete-channel-btn" onclick="deleteCollabChannel()" style="display:none">Delete chat</button>
            <button class="btn btn-outline btn-sm" onclick="openChannelMembersModal()">Members</button>
            <button class="btn btn-outline btn-sm" onclick="loadCollabMessages(true)">↻ Refresh</button>
          </div>
        </div>
        <div class="collab-messages" id="collab-messages"><div class="collab-empty">No channel selected yet.</div></div>
        <div class="collab-typing" id="collab-typing"></div>
        <div class="collab-composer">
          <div class="collab-compose-row">
            <textarea id="collab-message-input" placeholder="Message this channel. Use @username to tag a teammate." spellcheck="true" lang="en" oninput="handleCollabComposerInput(event)" onkeydown="handleMentionKeydown(event)"></textarea>
            <button class="btn btn-primary" onclick="sendCollabMessage()">Send</button>
          </div>
          <div class="form-hint">Mentions notify teammates instantly. Native English spellcheck is enabled; multilingual text is left alone by your browser.</div>
          <div class="collab-admin-tools" id="collab-announcement-tools" style="display:none">
            <h4>Admin announcement</h4>
            <div class="collab-compose-row"><textarea id="collab-announcement-text" placeholder="Send an announcement notification to everyone..." spellcheck="true" lang="en"></textarea><button class="btn btn-outline" onclick="sendAdminAnnouncement()">Notify all</button></div>
          </div>
        </div>
      </main>
    </div>`;
  const privacy = document.getElementById('page-privacy');
  if (privacy) privacy.parentNode.insertBefore(page, privacy);
  else document.body.appendChild(page);
}

function ensureNotificationBell() {
  const navUser = document.querySelector('#main-nav .nav-user');
  if (!navUser || document.getElementById('notification-bell')) return;
  const btn = document.createElement('button');
  btn.id = 'notification-bell';
  btn.className = 'nav-notify';
  btn.title = 'Notifications';
  btn.innerHTML = '🔔<span class="nav-notify-badge" id="notification-badge">0</span>';
  btn.onclick = toggleNotificationPanel;
  const signout = navUser.querySelector('.btn-signout');
  navUser.insertBefore(btn, signout || null);
  const panel = document.createElement('div');
  panel.id = 'notification-panel';
  panel.className = 'notification-panel';
  panel.innerHTML = `<div class="notification-head"><strong>Notifications</strong><button class="btn btn-outline btn-sm" onclick="markAllNotificationsRead()">Mark all read</button></div><div class="notification-list" id="notification-list"><div class="empty"><div class="empty-icon">🔔</div><h3>No notifications yet</h3></div></div>`;
  document.body.appendChild(panel);
}

const _collabBuildNav = buildNav;
buildNav = function() {
  _collabBuildNav();
  ensureCollaborationPage();
  const wrap = document.getElementById('nav-links');
  if (wrap && currentUser && !document.getElementById('nav-collab')) {
    const adminBtn = document.getElementById('nav-admin');
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.id = 'nav-collab';
    btn.onclick = () => showPage('collab');
    btn.textContent = 'Team Chat';
    wrap.insertBefore(btn, adminBtn || document.getElementById('nav-privacy') || null);
  }
  ensureNotificationBell();
  initCollaborationSystem();
};

const _collabShowPage = showPage;
showPage = function(id) {
  _collabShowPage(id);
  if (id === 'collab') loadCollaborationDashboard();
};

async function initCollaborationSystem() {
  if (!currentUser || COLLAB.initialized) return;
  COLLAB.initialized = true;
  ensureCollaborationPage();
  ensureNotificationBell();
  await upsertCollabProfile();
  await loadCollabUsers();
  // Issue 2C: now that COLLAB.usersByEmail is populated, swap the nav from the
  // placeholder set by setUser() to the user's custom_username + profile photo.
  if (typeof refreshCurrentIdentityUI === 'function') {
    try { refreshCurrentIdentityUI(); } catch (_e) {}
  }
  await loadNotifications();
  subscribeNotifications();
  window.addEventListener('click', evt => {
    const panel = document.getElementById('notification-panel');
    const bell = document.getElementById('notification-bell');
    if (panel && bell && panel.classList.contains('open') && !panel.contains(evt.target) && !bell.contains(evt.target)) panel.classList.remove('open');
  });
}

async function upsertCollabProfile() {
  if (!currentUser) return;
  // Issue 2D: pre-fetch existing row so we only seed custom_username when it's null.
  // The user's chosen custom_username is never overwritten by a later login.
  let existing = null;
  try {
    const { data } = await sb.from('collab_profiles').select('custom_username, profile_picture_url').eq('email', currentUser.email).maybeSingle();
    existing = data || null;
  } catch (_e) {}
  const fullName = collabCurrentName();
  // Fallback chain for the seed: full_name → email prefix → 'User'
  const seedUsername = (existing && existing.custom_username && String(existing.custom_username).trim())
    ? existing.custom_username
    : (fullName || (currentUser.email ? currentUser.email.split('@')[0] : 'User'));
  const profile = {
    email: currentUser.email,
    username: collabUsernameFromEmail(currentUser.email),
    display_name: fullName,
    custom_username: seedUsername,
    role: collabCurrentRole(),
    avatar_url: currentUser.user_metadata?.avatar_url || null,
    last_seen_at: new Date().toISOString()
  };
  try {
    const { error } = await sb.from('collab_profiles').upsert(profile, { onConflict:'email' });
    collabOpenError('profile upsert', error);
  } catch (err) { collabOpenError('profile upsert', err); }
}

async function loadCollabUsers(force=false) {
  if (!force && COLLAB.users.length) return COLLAB.users;
  const map = {};
  try {
    const { data, error } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').order('display_name', { ascending:true });
    if (!error) (data || []).forEach(p => { map[p.email] = p; });
  } catch (err) { collabOpenError('load profiles', err); }
  try {
    const { data } = await sb.from('questions').select('submitter_email,submitter_name,answered_by').limit(1000);
    (data || []).forEach(q => {
      if (q.submitter_email && !map[q.submitter_email]) map[q.submitter_email] = { email:q.submitter_email, username:collabUsernameFromEmail(q.submitter_email), display_name:q.submitter_name || q.submitter_email, role:'staff' };
      if (q.answered_by && String(q.answered_by).includes('@') && !map[q.answered_by]) map[q.answered_by] = { email:q.answered_by, username:collabUsernameFromEmail(q.answered_by), display_name:q.answered_by, role:'reviewer' };
    });
  } catch (_err) {}
  try {
    const { data } = await sb.from('reviewers').select('email').limit(200);
    (data || []).forEach(r => { if (r.email) map[r.email] = { ...(map[r.email] || {}), email:r.email, username:collabUsernameFromEmail(r.email), display_name:map[r.email]?.display_name || r.email.split('@')[0], role:'reviewer' }; });
  } catch (_err) {}
  if (currentUser) map[currentUser.email] = { ...(map[currentUser.email] || {}), email:currentUser.email, username:collabUsernameFromEmail(currentUser.email), display_name:collabCurrentName(), role:collabCurrentRole() };
  COLLAB.users = Object.values(map).sort((a,b) => (a.display_name || a.email || '').localeCompare(b.display_name || b.email || ''));
  COLLAB.usersByUsername = {};
  COLLAB.usersByEmail = {};
  COLLAB.users.forEach(u => { COLLAB.usersByUsername[String(u.username || collabUsernameFromEmail(u.email)).toLowerCase()] = u; COLLAB.usersByEmail[String(u.email || '').toLowerCase()] = u; });
  return COLLAB.users;
}

function toggleNotificationPanel() {
  const panel = document.getElementById('notification-panel');
  if (!panel) return;
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) loadNotifications();
}

async function loadNotifications() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb.from('collab_notifications').select('id,recipient_email,actor_email,actor_name,type,title,body,link,read_at,created_at').eq('recipient_email', currentUser.email).order('created_at', { ascending:false }).limit(80);
    if (error) throw error;
    COLLAB.notifications = data || [];
  } catch (err) { collabOpenError('load notifications', err); COLLAB.notifications = []; }
  renderNotifications();
}

function renderNotifications() {
  COLLAB.unread = COLLAB.notifications.filter(n => !n.is_read).length;
  const badge = document.getElementById('notification-badge');
  if (badge) { badge.textContent = COLLAB.unread > 99 ? '99+' : String(COLLAB.unread); badge.classList.toggle('visible', COLLAB.unread > 0); }
  const list = document.getElementById('notification-list');
  if (!list) return;
  if (!COLLAB.notifications.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🔔</div><h3>No notifications yet</h3><p>Mentions, answers, comments, and admin announcements will appear here.</p></div>';
    return;
  }
  list.innerHTML = COLLAB.notifications.map(n => `
    <div class="notification-item ${n.is_read ? '' : 'unread'}" onclick="openNotification('${collabAttr(n.id)}')">
      <div class="notification-title">${collabHtml(n.title || notificationTitle(n.type))}</div>
      <div class="notification-body">${collabHtml(n.body || '')}</div>
      <div class="notification-time">${fmtDateFull(n.created_at)}</div>
    </div>`).join('');
}

function notificationTitle(type) {
  const titles = { QUESTION_ANSWERED:'Question answered', USER_TAGGED:'You were mentioned', REVIEW_ASSIGNED:'Review assigned', STATUS_UPDATED:'Status updated', COMMENT_ADDED:'New comment', COMMENT_REPLIED:'New reply', ADMIN_ANNOUNCEMENT:'Admin announcement' };
  return titles[type] || 'Notification';
}

async function openNotification(id) {
  const n = COLLAB.notifications.find(x => x.id === id);
  if (!n) return;
  await markNotificationRead(id);
  document.getElementById('notification-panel')?.classList.remove('open');
  const meta = n.metadata || {};
  if (n.link_type === 'channel' && n.link_ref) { showPage('collab'); COLLAB.currentChannelId = n.link_ref; localStorage.setItem('collabCurrentChannelId', n.link_ref); await loadCollaborationDashboard(); return; }
  if (n.link_type === 'question' && n.link_ref) {
    if (n.type === 'QUESTION_ANSWERED') { showPage('faq'); setTimeout(() => openAnsweredByRef(meta.bill_id || meta.question_id || n.link_ref), 600); }
    else { showPage(isReviewer() ? 'review' : 'allq'); }
  }
}

async function markNotificationRead(id) {
  if (!currentUser) return;
  try { await sb.from('collab_notifications').update({ is_read:true, read_at:new Date().toISOString() }).eq('id', id).eq('recipient_email', currentUser.email); } catch (_err) {}
  const n = COLLAB.notifications.find(x => x.id === id); if (n) n.is_read = true;
  renderNotifications();
}

async function markAllNotificationsRead() {
  if (!currentUser) return;
  try { await sb.from('collab_notifications').update({ is_read:true, read_at:new Date().toISOString() }).eq('recipient_email', currentUser.email).eq('is_read', false); } catch (_err) {}
  COLLAB.notifications.forEach(n => n.is_read = true);
  renderNotifications();
}

function subscribeNotifications() {
  if (!currentUser || COLLAB.subs.notifications) return;
  try {
    COLLAB.subs.notifications = sb.channel('collab_notifications_' + currentUser.email)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'collab_notifications', filter:`recipient_email=eq.${currentUser.email}` }, payload => {
        COLLAB.notifications.unshift(payload.new);
        renderNotifications();
        toast(payload.new.title || notificationTitle(payload.new.type), 'success');
      })
      .subscribe();
  } catch (err) { collabOpenError('notification subscribe', err); }
}

async function createNotifications(rows) {
  const clean = (rows || []).filter(r => r && r.recipient_email && (!currentUser || r.recipient_email !== currentUser.email));
  if (!clean.length) return;
  try { await sb.from('collab_notifications').insert(clean); } catch (err) { collabOpenError('create notifications', err); }
}

async function notifyMentionedUsers(text, base) {
  await loadCollabUsers();
  const mentioned = getMentionedUsers(text);
  if (!mentioned.length) return;
  await createNotifications(mentioned.map(u => ({
    recipient_email:u.email,
    actor_email:currentUser?.email || null,
    actor_name:collabCurrentName(),
    type:'USER_TAGGED',
    title:'You were mentioned',
    body:base?.body || `${collabCurrentName()} mentioned you`,
    link_type:base?.link_type || null,
    link_ref:base?.link_ref || null,
    metadata:{ ...(base?.metadata || {}), mention_text:text.slice(0,240) }
  })));
}

function getMentionedUsers(text) {
  const names = new Set();
  String(text || '').replace(/@([a-zA-Z0-9._-]{2,32})/g, (_, name) => { names.add(name.toLowerCase()); return ''; });
  return [...names].map(n => COLLAB.usersByUsername[n]).filter(Boolean);
}

function renderMentionedText(text) {
  const raw = collabHtml(text || '');
  return raw.replace(/@([a-zA-Z0-9._-]{2,32})/g, (m, name) => `<span class="mention-token" onclick="event.stopPropagation();openUserProfileByUsername('${collabAttr(name.toLowerCase())}')">@${collabHtml(name)}</span>`);
}

function setupMentionAutocomplete(textarea) {
  if (!textarea || textarea.dataset.mentionsReady === 'true') return;
  textarea.dataset.mentionsReady = 'true';
  textarea.addEventListener('input', evt => handleMentionInput(evt));
  textarea.addEventListener('keydown', evt => handleMentionKeydown(evt));
}

async function handleMentionInput(evt) {
  const textarea = evt.target;
  if (!textarea || !textarea.value) return closeMentionPopover();
  await loadCollabUsers();
  const info = currentMentionQuery(textarea);
  if (!info) return closeMentionPopover();
  const users = COLLAB.users.filter(u => {
    const q = info.query.toLowerCase();
    return (u.username || '').toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
  }).slice(0,8);
  if (!users.length) return closeMentionPopover();
  COLLAB.mentionTarget = { textarea, start:info.start, end:info.end, users };
  COLLAB.mentionIndex = 0;
  renderMentionPopover(users, textarea);
}

function currentMentionQuery(textarea) {
  const pos = textarea.selectionStart || 0;
  const before = textarea.value.slice(0, pos);
  const match = before.match(/(^|\s)@([a-zA-Z0-9._-]{0,32})$/);
  if (!match) return null;
  return { query:match[2] || '', start:pos - match[2].length - 1, end:pos };
}

function renderMentionPopover(users, textarea) {
  let pop = document.getElementById('mention-popover');
  if (!pop) { pop = document.createElement('div'); pop.id = 'mention-popover'; pop.className = 'mention-popover'; document.body.appendChild(pop); }
  pop.innerHTML = users.map((u,i) => `<div class="mention-option ${i===COLLAB.mentionIndex?'active':''}" onclick="insertMention(${i})"><div class="mention-option-avatar">${collabHtml(collabInitials(u.display_name || u.email))}</div><div><div class="mention-option-name">${collabHtml(u.display_name || u.email)}</div><div class="mention-option-sub">@${collabHtml(u.username || collabUsernameFromEmail(u.email))} · ${collabHtml(collabVisibleRole(u.role))}</div></div></div>`).join('');
  const rect = textarea.getBoundingClientRect();
  pop.style.left = Math.min(rect.left + 12, window.innerWidth - 290) + 'px';
  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 280) + 'px';
  pop.classList.add('open');
}

function closeMentionPopover() { document.getElementById('mention-popover')?.classList.remove('open'); COLLAB.mentionTarget = null; }

function handleMentionKeydown(evt) {
  const pop = document.getElementById('mention-popover');
  if (!pop || !pop.classList.contains('open') || !COLLAB.mentionTarget) return;
  if (evt.key === 'ArrowDown') { evt.preventDefault(); COLLAB.mentionIndex = (COLLAB.mentionIndex + 1) % COLLAB.mentionTarget.users.length; renderMentionPopover(COLLAB.mentionTarget.users, COLLAB.mentionTarget.textarea); }
  else if (evt.key === 'ArrowUp') { evt.preventDefault(); COLLAB.mentionIndex = (COLLAB.mentionIndex - 1 + COLLAB.mentionTarget.users.length) % COLLAB.mentionTarget.users.length; renderMentionPopover(COLLAB.mentionTarget.users, COLLAB.mentionTarget.textarea); }
  else if (evt.key === 'Enter' || evt.key === 'Tab') { evt.preventDefault(); insertMention(COLLAB.mentionIndex); }
  else if (evt.key === 'Escape') closeMentionPopover();
}

function insertMention(index) {
  const target = COLLAB.mentionTarget;
  if (!target) return;
  const user = target.users[index] || target.users[0];
  const username = user.username || collabUsernameFromEmail(user.email);
  const ta = target.textarea;
  ta.value = ta.value.slice(0, target.start) + '@' + username + ' ' + ta.value.slice(target.end);
  const pos = target.start + username.length + 2;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  closeMentionPopover();
  ta.dispatchEvent(new Event('input', { bubbles:true }));
}

async function loadCollaborationDashboard() {
  ensureCollaborationPage();
  if (!currentUser) return;
  await initCollaborationSystem();
  document.getElementById('collab-toggle-create')?.style.setProperty('display', isReviewer() ? 'inline-flex' : 'none');
  document.getElementById('collab-announcement-tools')?.style.setProperty('display', isAdmin() ? 'block' : 'none');
  await loadCollabChannels();
  const composer = document.getElementById('collab-message-input');
  if (composer) setupMentionAutocomplete(composer);
}

function toggleCreateChannelBox() { document.getElementById('collab-create-box')?.classList.toggle('visible'); }

async function loadCollabChannels() {
  try {
    const { data, error } = await sb.from('collab_channels').select('id,name,slug,description,visibility,is_archived,created_by,created_at,updated_at').eq('is_archived', false).order('created_at', { ascending:true });
    if (error) throw error;
    COLLAB.channels = data || [];
  } catch (err) { collabOpenError('load channels', err); COLLAB.channels = []; }
  if (!COLLAB.channels.length && isReviewer()) await ensureDefaultChannels();
  renderCollabChannels();
  if (!COLLAB.currentChannelId && COLLAB.channels.length) COLLAB.currentChannelId = COLLAB.channels[0].id;
  if (COLLAB.currentChannelId) await selectCollabChannel(COLLAB.currentChannelId);
}

async function ensureDefaultChannels() {
  // Issue 5B-3: ensure the two required default channels exist.
  // admin-announcement is read-only for non-admins (enforced by RLS in migration 0003).
  const defaults = [
    { name:'admin-announcement', slug:'admin-announcement', description:'Admin announcements. Read-only — only admins can post.', visibility:'public', created_by:currentUser.email },
    { name:'general', slug:'general', description:'Team-wide chat and workflow updates.', visibility:'public', created_by:currentUser.email }
  ];
  try { await sb.from('collab_channels').insert(defaults); } catch (err) { collabOpenError('default channels', err); }
  try { const { data } = await sb.from('collab_channels').select('id,name,slug,description,visibility,is_archived,created_by,created_at,updated_at').eq('is_archived', false).order('created_at', { ascending:true }); COLLAB.channels = data || []; } catch (_err) {}
}

function renderCollabChannels() {
  const wrap = document.getElementById('collab-channel-list');
  if (!wrap) return;
  if (!COLLAB.channels.length) { wrap.innerHTML = '<div class="empty-premium"><strong>No channels yet</strong><span>Admin/reviewers can create the first channel.</span></div>'; return; }
  wrap.innerHTML = COLLAB.channels.map(ch => `<button class="collab-channel-btn ${ch.id===COLLAB.currentChannelId?'active':''}" onclick="selectCollabChannel('${collabAttr(ch.id)}')"><span>${ch.visibility === 'private' ? '🔒' : '#'} ${collabHtml(ch.name)}</span><span class="collab-channel-pill">${collabHtml(ch.visibility)}</span></button>`).join('');
}

async function createCollabChannel() {
  if (!isReviewer()) { toast('Only Admin or Reviewers can create channels', 'error'); return; }
  const name = document.getElementById('collab-new-channel-name')?.value.trim();
  const description = document.getElementById('collab-new-channel-desc')?.value.trim();
  const visibility = document.getElementById('collab-new-channel-visibility')?.value || 'public';
  if (!name) { toast('Please enter a channel name', 'error'); return; }
  const slug = collabSlugFromName(name);
  try {
    const { data, error } = await sb.from('collab_channels').insert({ name, slug, description, visibility, created_by:currentUser.email }).select().single();
    if (error) throw error;
    await sb.from('collab_channel_members').insert({ channel_id:data.id, user_email:currentUser.email, role:'owner' });
    COLLAB.currentChannelId = data.id;
    localStorage.setItem('collabCurrentChannelId', data.id);
    toast('✓ Channel created', 'success');
    document.getElementById('collab-create-box')?.classList.remove('visible');
    await loadCollabChannels();
  } catch (err) { toast('Channel creation failed: ' + (err.message || err), 'error'); }
}

async function selectCollabChannel(id) {
  COLLAB.currentChannelId = id;
  localStorage.setItem('collabCurrentChannelId', id);
  renderCollabChannels();
  const ch = COLLAB.channels.find(c => c.id === id);
  document.getElementById('collab-channel-name').textContent = ch ? `${ch.visibility === 'private' ? '🔒' : '#'} ${ch.name}` : 'Channel';
  document.getElementById('collab-channel-sub').textContent = ch?.description || 'Live team messages, mentions, reactions, and read status.';
  renderCollabChannelManagementActions(ch);
  await loadCollabMessages(true);
  subscribeChannelRealtime(id);
}

async function loadCollabMessages(scrollToBottom=false) {
  const wrap = document.getElementById('collab-messages');
  if (!wrap || !COLLAB.currentChannelId) return;
  wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading messages...</div>';
  try {
    const [messagesRes, reactionsRes, readsRes] = await Promise.all([
      sb.from('collab_messages').select('id,channel_id,body,author_email,author_name,mentions,created_at,updated_at,attachments').eq('channel_id', COLLAB.currentChannelId).order('created_at', { ascending:true }).limit(200),
      sb.from('collab_message_reactions').select('id,message_id,channel_id,user_email,emoji,created_at').eq('channel_id', COLLAB.currentChannelId),
      sb.from('collab_message_reads').select('id,message_id,channel_id,user_email,read_at').eq('channel_id', COLLAB.currentChannelId)
    ]);
    if (messagesRes.error) throw messagesRes.error;
    COLLAB.messages = messagesRes.data || [];
    COLLAB.reactions = groupByMessage(reactionsRes.data || []);
    COLLAB.reads = groupByMessage(readsRes.data || []);
  } catch (err) { collabOpenError('load messages', err); COLLAB.messages = []; }
  renderCollabMessages();
  await markChannelMessagesSeen();
  if (scrollToBottom) setTimeout(() => { wrap.scrollTop = wrap.scrollHeight; }, 60);
}

function groupByMessage(rows) { const out = {}; (rows || []).forEach(r => { const id = r.message_id; out[id] = out[id] || []; out[id].push(r); }); return out; }

function renderCollabMessages() {
  const wrap = document.getElementById('collab-messages');
  if (!wrap) return;
  if (!COLLAB.messages.length) { wrap.innerHTML = '<div class="collab-empty">No messages yet. Start the conversation with a quick update or @mention.</div>'; return; }
  const tree = collabBuildThreadTree();
  wrap.innerHTML = tree.roots.map(msg => renderCollabMessage(msg, tree.childrenByParent, 0)).join('');
}

function collabCurrentChannel() {
  return COLLAB.channels.find(c => c.id === COLLAB.currentChannelId) || null;
}

function collabIsGeneralChannel(ch = collabCurrentChannel()) {
  const name = String(ch?.name || '').toLowerCase();
  const slug = String(ch?.slug || '').toLowerCase();
  return name === 'general' || slug === 'general';
}

function collabIsDefaultChannel(ch = collabCurrentChannel()) {
  const name = String(ch?.name || '').toLowerCase();
  const slug = String(ch?.slug || '').toLowerCase();
  return name === 'general' || slug === 'general'
      || name === 'admin-announcement' || slug === 'admin-announcement'
      || name === 'review-updates' || slug === 'review-updates';
}

function collabIsAnnouncementChannel(ch = collabCurrentChannel()) {
  // Issue 5B-3: admin-announcement is a read-only broadcast channel for non-admins.
  const name = String(ch?.name || '').toLowerCase();
  const slug = String(ch?.slug || '').toLowerCase();
  return name === 'admin-announcement' || slug === 'admin-announcement';
}

function collabSlugFromName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'channel';
}

function renderCollabChannelManagementActions(ch = collabCurrentChannel()) {
  const canManageCustom = !!(ch && collabCanManageChannel(ch) && !collabIsDefaultChannel(ch));
  const editBtn = document.getElementById('collab-edit-channel-btn');
  const deleteBtn = document.getElementById('collab-delete-channel-btn');
  if (editBtn) editBtn.style.display = canManageCustom ? 'inline-flex' : 'none';
  if (deleteBtn) deleteBtn.style.display = canManageCustom ? 'inline-flex' : 'none';
}

function collabCanEditDeleteMessage(msg) {
  return !!(currentUser && msg && !msg.deleted_at && msg.author_email === currentUser.email && collabIsGeneralChannel(COLLAB.channels.find(c => c.id === msg.channel_id) || collabCurrentChannel()));
}

function collabMessageDomKey(messageId) {
  return String(messageId || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function collabMessageEdited(msg) {
  if (!msg || msg.deleted_at || !msg.updated_at || !msg.created_at) return false;
  return Math.abs(new Date(msg.updated_at) - new Date(msg.created_at)) > 2000;
}

const COLLAB_REPLY_MARKER = '[team-chat-reply:';

function collabReplyMeta(msgOrBody) {
  const raw = typeof msgOrBody === 'string' ? msgOrBody : String(msgOrBody?.body || '');
  const match = raw.match(/^\[team-chat-reply:([^\]]+)\]\s*\n?/);
  const parentId = match ? match[1] : null;
  return { parentId, body: parentId ? raw.slice(match[0].length) : raw };
}

function collabBuildReplyBody(parentMessageId, body) {
  return `${COLLAB_REPLY_MARKER}${parentMessageId}]\n${String(body || '').trim()}`;
}

function collabStoredBodyForEdit(msg, visibleBody) {
  const meta = collabReplyMeta(msg);
  return meta.parentId ? collabBuildReplyBody(meta.parentId, visibleBody) : String(visibleBody || '').trim();
}

function collabBuildThreadTree() {
  const byId = {};
  const childrenByParent = {};
  const roots = [];
  COLLAB.messages.forEach(msg => {
    const meta = collabReplyMeta(msg);
    msg._collabParentId = meta.parentId;
    msg._collabVisibleBody = meta.body;
    byId[msg.id] = msg;
  });
  COLLAB.messages.forEach(msg => {
    const parentId = msg._collabParentId;
    if (parentId && byId[parentId]) {
      childrenByParent[parentId] = childrenByParent[parentId] || [];
      childrenByParent[parentId].push(msg);
    } else {
      roots.push(msg);
    }
  });
  const byCreated = (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0);
  roots.sort(byCreated);
  Object.values(childrenByParent).forEach(list => list.sort(byCreated));
  return { roots, childrenByParent };
}

function renderCollabMessage(msg, childrenByParent = {}, depth = 0) {
  const reactions = COLLAB.reactions[msg.id] || [];
  const reads = COLLAB.reads[msg.id] || [];
  const grouped = {};
  reactions.forEach(r => { grouped[r.emoji] = grouped[r.emoji] || { count:0, mine:false }; grouped[r.emoji].count++; if (r.user_email === currentUser?.email) grouped[r.emoji].mine = true; });
  const reactionHtml = Object.entries(grouped).map(([emoji, data]) => `<button class="collab-reaction ${data.mine?'mine':''}" onclick="toggleMessageReaction('${collabAttr(msg.id)}','${collabAttr(emoji)}')">${collabHtml(emoji)} ${data.count}</button>`).join('');
  const seenCount = new Set(reads.map(r => r.user_email).filter(e => e !== msg.author_email)).size;
  const key = collabMessageDomKey(msg.id);
  const isDeleted = !!msg.deleted_at;
  const meta = collabReplyMeta(msg);
  const visibleBody = msg._collabVisibleBody !== undefined ? msg._collabVisibleBody : meta.body;
  const children = childrenByParent[msg.id] || [];
  const childHtml = children.map(child => renderCollabMessage(child, childrenByParent, depth + 1)).join('');
  const statusLabel = isDeleted
    ? '<span class="collab-state-label">deleted</span>'
    : (collabMessageEdited(msg) ? '<span class="collab-state-label">edited</span>' : '');
  const replyBadge = children.length ? `<span class="collab-thread-pill">${children.length} ${children.length === 1 ? 'reply' : 'replies'}</span>` : '';
  const bodyHtml = isDeleted ? '<span class="collab-deleted-text">This message was deleted.</span>' : renderMentionedText(visibleBody || '');
  const ownerControls = collabCanEditDeleteMessage(msg)
    ? `<button class="collab-mini-btn" onclick="editCollabMessageStart('${collabAttr(msg.id)}')">Edit</button><button class="collab-mini-btn" onclick="deleteCollabMessage('${collabAttr(msg.id)}')">Delete</button>`
    : '';
  const replyControl = isDeleted ? '' : `<button class="collab-mini-btn" onclick="startCollabThreadReply('${collabAttr(msg.id)}')">Reply</button>`;
  const reactionControls = isDeleted ? '' : `<button class="collab-mini-btn" onclick="toggleMessageReaction('${collabAttr(msg.id)}','👍')">👍</button><button class="collab-mini-btn" onclick="toggleMessageReaction('${collabAttr(msg.id)}','✅')">✅</button><button class="collab-mini-btn" onclick="toggleMessageReaction('${collabAttr(msg.id)}','👀')">👀</button>`;
  return `<div class="collab-message ${depth ? 'thread-child' : ''}" data-message-id="${collabAttr(msg.id)}" data-thread-depth="${depth}"><div class="collab-avatar">${collabHtml(collabInitials(msg.author_name || msg.author_email))}</div><div class="collab-bubble"><div class="collab-msg-meta"><span class="collab-msg-author" onclick="openUserProfileByEmail('${collabAttr(msg.author_email)}')" style="cursor:pointer">${collabHtml(msg.author_name || msg.author_email)}</span><span class="collab-msg-time">${fmtDateFull(msg.created_at)}</span>${statusLabel}${replyBadge}</div><div class="collab-msg-body" id="collab-msg-body-${key}">${bodyHtml}</div><div class="collab-message-edit-slot" id="collab-edit-slot-${key}"></div>${!isDeleted && reactionHtml ? `<div class="collab-reactions">${reactionHtml}</div>` : ''}<div class="collab-message-actions" id="collab-msg-actions-${key}">${reactionControls}${replyControl}${ownerControls}<span class="collab-read">Seen by ${seenCount}</span></div><div class="collab-thread-reply-slot" id="collab-reply-slot-${key}"></div>${childHtml ? `<div class="collab-thread-children">${childHtml}</div>` : ''}</div></div>`;
}

function editCollabMessageStart(messageId) {
  const msg = COLLAB.messages.find(m => m.id === messageId);
  if (!collabCanEditDeleteMessage(msg)) { toast('Only your own #general messages can be edited', 'error'); return; }
  const key = collabMessageDomKey(messageId);
  const bodyEl = document.getElementById(`collab-msg-body-${key}`);
  const actionsEl = document.getElementById(`collab-msg-actions-${key}`);
  const slot = document.getElementById(`collab-edit-slot-${key}`);
  if (!bodyEl || !slot) return;
  cancelCollabThreadReply(messageId);
  bodyEl.style.display = 'none';
  if (actionsEl) actionsEl.style.display = 'none';
  const visibleBody = collabReplyMeta(msg).body;
  slot.innerHTML = `<textarea class="collab-edit-area" id="collab-edit-textarea-${key}" maxlength="2000">${collabHtml(visibleBody || '')}</textarea><div class="comment-actions-form"><button class="btn-comment-submit" onclick="saveCollabMessageEdit('${collabAttr(messageId)}')">Save edit</button><button class="btn-comment-cancel" onclick="cancelCollabMessageEdit('${collabAttr(messageId)}')">Cancel</button></div>`;
  const textarea = document.getElementById(`collab-edit-textarea-${key}`);
  if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
}

function cancelCollabMessageEdit(messageId) {
  const key = collabMessageDomKey(messageId);
  const bodyEl = document.getElementById(`collab-msg-body-${key}`);
  const actionsEl = document.getElementById(`collab-msg-actions-${key}`);
  const slot = document.getElementById(`collab-edit-slot-${key}`);
  if (bodyEl) bodyEl.style.display = '';
  if (actionsEl) actionsEl.style.display = '';
  if (slot) slot.innerHTML = '';
}

async function saveCollabMessageEdit(messageId) {
  const msg = COLLAB.messages.find(m => m.id === messageId);
  if (!collabCanEditDeleteMessage(msg)) { toast('Only your own #general messages can be edited', 'error'); return; }
  const key = collabMessageDomKey(messageId);
  const textarea = document.getElementById(`collab-edit-textarea-${key}`);
  const visibleBody = (textarea?.value || '').trim();
  if (!visibleBody) { toast('Message cannot be empty', 'error'); return; }
  const body = collabStoredBodyForEdit(msg, visibleBody);
  try {
    const { error } = await sb.from('collab_messages')
      .update({ body, updated_at:new Date().toISOString() })
      .eq('id', messageId)
      .eq('author_email', currentUser.email);
    if (error) throw error;
    toast('✓ Message edited', 'success');
    await loadCollabMessages(false);
  } catch (err) { toast('Could not edit message: ' + (err.message || err), 'error'); }
}

async function deleteCollabMessage(messageId) {
  const msg = COLLAB.messages.find(m => m.id === messageId);
  if (!collabCanEditDeleteMessage(msg)) { toast('Only your own #general messages can be deleted', 'error'); return; }
  if (!confirm('Delete this message? It will remain visible with a deleted label.')) return;
  try {
    const { error } = await sb.from('collab_messages')
      .update({ deleted_at:new Date().toISOString(), updated_at:new Date().toISOString() })
      .eq('id', messageId)
      .eq('author_email', currentUser.email);
    if (error) throw error;
    toast('✓ Message deleted', 'success');
    await loadCollabMessages(false);
  } catch (err) { toast('Could not delete message: ' + (err.message || err), 'error'); }
}

function startCollabThreadReply(messageId) {
  const msg = COLLAB.messages.find(m => m.id === messageId);
  if (!msg || msg.deleted_at) return;
  const key = collabMessageDomKey(messageId);
  const slot = document.getElementById(`collab-reply-slot-${key}`);
  if (!slot) return;
  cancelCollabMessageEdit(messageId);
  document.querySelectorAll('.collab-thread-reply-slot').forEach(el => { if (el !== slot) el.innerHTML = ''; });
  const author = collabHtml(msg.author_name || msg.author_email || 'this message');
  slot.innerHTML = `<div class="collab-reply-form"><div class="collab-reply-context">Replying to <strong>${author}</strong></div><textarea class="comment-textarea" id="collab-reply-textarea-${key}" maxlength="2000" placeholder="Write a reply... Use @username to tag someone." spellcheck="true" lang="en"></textarea><div class="comment-actions-form"><button class="btn-comment-submit" onclick="sendCollabThreadReply('${collabAttr(messageId)}')">Reply</button><button class="btn-comment-cancel" onclick="cancelCollabThreadReply('${collabAttr(messageId)}')">Cancel</button></div></div>`;
  const textarea = document.getElementById(`collab-reply-textarea-${key}`);
  if (textarea) { setupMentionAutocomplete(textarea); textarea.focus(); }
}

function cancelCollabThreadReply(messageId) {
  const key = collabMessageDomKey(messageId);
  const slot = document.getElementById(`collab-reply-slot-${key}`);
  if (slot) slot.innerHTML = '';
  closeMentionPopover();
}

async function sendCollabThreadReply(parentMessageId) {
  const parent = COLLAB.messages.find(m => m.id === parentMessageId);
  if (!parent || parent.deleted_at) { toast('This thread is no longer available', 'error'); return; }
  if (!COLLAB.currentChannelId) { toast('Select a channel first', 'error'); return; }
  const key = collabMessageDomKey(parentMessageId);
  const input = document.getElementById(`collab-reply-textarea-${key}`);
  const visibleBody = (input?.value || '').trim();
  if (!visibleBody) { toast('Write a reply first', 'error'); return; }
  const body = collabBuildReplyBody(parentMessageId, visibleBody);
  const mentions = getMentionedUsers(visibleBody).map(u => u.email);
  try {
    const { data, error } = await sb.from('collab_messages').insert({ channel_id:COLLAB.currentChannelId, body, author_email:currentUser.email, author_name:collabCurrentName(), mentions }).select().single();
    if (error) throw error;
    closeMentionPopover();
    await notifyCollabThreadReply(parent, visibleBody, data?.id);
    await loadCollabMessages(false);
  } catch (err) { toast('Reply failed: ' + (err.message || err), 'error'); }
}

async function notifyCollabThreadReply(parent, replyBody, replyMessageId) {
  await loadCollabUsers();
  const recipients = new Set();
  if (parent?.author_email && parent.author_email !== currentUser?.email) recipients.add(parent.author_email);
  getMentionedUsers(replyBody).forEach(u => { if (u.email) recipients.add(u.email); });
  if (!recipients.size) return;
  const channel = collabCurrentChannel();
  await createNotifications([...recipients].map(email => ({
    recipient_email:email,
    actor_email:currentUser?.email || null,
    actor_name:collabCurrentName(),
    type:'TEAM_CHAT_REPLY',
    title:'New Team Chat reply',
    body:`${collabCurrentName()} replied in ${channel?.name ? '#' + channel.name : 'Team Chat'}: ${replyBody.slice(0,140)}`,
    link_type:'channel',
    link_ref:COLLAB.currentChannelId,
    metadata:{ parent_message_id:parent?.id || null, message_id:replyMessageId || null, channel_id:COLLAB.currentChannelId, reply_text:replyBody.slice(0,240) }
  })));
}

function handleCollabComposerInput(evt) {
  handleMentionInput(evt);
  updateCollabTyping();
}

async function sendCollabMessage() {
  const input = document.getElementById('collab-message-input');
  const body = input?.value.trim();
  if (!body) { toast('Write a message first', 'error'); return; }
  if (!COLLAB.currentChannelId) { toast('Select a channel first', 'error'); return; }
  const mentions = getMentionedUsers(body).map(u => u.email);
  try {
    const { data, error } = await sb.from('collab_messages').insert({ channel_id:COLLAB.currentChannelId, body, author_email:currentUser.email, author_name:collabCurrentName(), mentions }).select().single();
    if (error) throw error;
    input.value = '';
    closeMentionPopover();
    await notifyMentionedUsers(body, { body:`${collabCurrentName()} mentioned you in a channel`, link_type:'channel', link_ref:COLLAB.currentChannelId, metadata:{ message_id:data.id, channel_id:COLLAB.currentChannelId } });
    await loadCollabMessages(true);
  } catch (err) { toast('Message failed: ' + (err.message || err), 'error'); }
}

async function updateCollabTyping() {
  if (!currentUser || !COLLAB.currentChannelId) return;
  const now = Date.now();
  if (now - COLLAB.lastPresenceAt < 1800) return;
  COLLAB.lastPresenceAt = now;
  try { await sb.from('collab_typing').upsert({ channel_id:COLLAB.currentChannelId, user_email:currentUser.email, user_name:collabCurrentName(), expires_at:new Date(Date.now()+5000).toISOString() }, { onConflict:'channel_id,user_email' }); } catch (_err) {}
}

async function markChannelMessagesSeen() {
  if (!currentUser || !COLLAB.currentChannelId || !COLLAB.messages.length) return;
  const rows = COLLAB.messages.filter(m => m.author_email !== currentUser.email).slice(-100).map(m => ({ channel_id:COLLAB.currentChannelId, message_id:m.id, user_email:currentUser.email, seen_at:new Date().toISOString() }));
  if (!rows.length) return;
  try { await sb.from('collab_message_reads').upsert(rows, { onConflict:'message_id,user_email' }); } catch (_err) {}
}

async function toggleMessageReaction(messageId, emoji) {
  if (!currentUser) return;
  const existing = (COLLAB.reactions[messageId] || []).find(r => r.user_email === currentUser.email && r.emoji === emoji);
  try {
    if (existing) await sb.from('collab_message_reactions').delete().eq('message_id', messageId).eq('user_email', currentUser.email).eq('emoji', emoji);
    else await sb.from('collab_message_reactions').insert({ channel_id:COLLAB.currentChannelId, message_id:messageId, user_email:currentUser.email, emoji });
    await loadCollabMessages(false);
  } catch (err) { collabOpenError('reaction', err); }
}

function subscribeChannelRealtime(channelId) {
  ['messages','typing','reads','reactions'].forEach(k => { if (COLLAB.subs[k]) { try { sb.removeChannel(COLLAB.subs[k]); } catch (_err) {} COLLAB.subs[k] = null; } });
  if (!channelId) return;
  try {
    COLLAB.subs.messages = sb.channel('collab_messages_' + channelId).on('postgres_changes', { event:'*', schema:'public', table:'collab_messages', filter:`channel_id=eq.${channelId}` }, () => loadCollabMessages(true)).subscribe();
    COLLAB.subs.reactions = sb.channel('collab_reactions_' + channelId).on('postgres_changes', { event:'*', schema:'public', table:'collab_message_reactions', filter:`channel_id=eq.${channelId}` }, () => loadCollabMessages(false)).subscribe();
    COLLAB.subs.reads = sb.channel('collab_reads_' + channelId).on('postgres_changes', { event:'*', schema:'public', table:'collab_message_reads', filter:`channel_id=eq.${channelId}` }, () => loadCollabMessages(false)).subscribe();
    COLLAB.subs.typing = sb.channel('collab_typing_' + channelId).on('postgres_changes', { event:'*', schema:'public', table:'collab_typing', filter:`channel_id=eq.${channelId}` }, () => renderTypingIndicator()).subscribe();
  } catch (err) { collabOpenError('channel realtime', err); }
}

async function renderTypingIndicator() {
  const el = document.getElementById('collab-typing');
  if (!el || !COLLAB.currentChannelId) return;
  try {
    const { data } = await sb.from('collab_typing').select('channel_id,user_email,user_name,expires_at').eq('channel_id', COLLAB.currentChannelId).gt('expires_at', new Date().toISOString()).neq('user_email', currentUser.email);
    const names = [...new Set((data || []).map(t => t.user_name || t.user_email))];
    el.textContent = names.length ? `${names.slice(0,3).join(', ')} ${names.length === 1 ? 'is' : 'are'} typing...` : '';
  } catch (_err) {}
}

function openEditCollabChannelModal() {
  const ch = collabCurrentChannel();
  if (!ch) { toast('Select a channel first', 'error'); return; }
  if (!collabCanManageChannel(ch)) { toast('Only Admins or the channel creator can edit this channel', 'error'); return; }
  if (collabIsDefaultChannel(ch)) { toast('Default channels cannot be renamed or deleted', 'error'); return; }
  document.getElementById('modal-title').textContent = 'Edit Team Chat channel';
  document.getElementById('modal-meta').innerHTML = `<span class="pill-muted">${collabHtml(ch.visibility || 'public')}</span>`;
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid">
      <div class="form-group full">
        <label class="form-label">Channel name <span class="req">*</span></label>
        <input type="text" class="form-input" id="collab-edit-channel-name" value="${collabAttr(ch.name || '')}" maxlength="80">
        <p class="form-hint">This changes the display name in Team Chat.</p>
      </div>
      <div class="form-group full">
        <label class="form-label">Description</label>
        <input type="text" class="form-input" id="collab-edit-channel-desc" value="${collabAttr(ch.description || '')}" maxlength="180">
      </div>
      <div class="form-group">
        <label class="form-label">Visibility</label>
        <select class="form-select" id="collab-edit-channel-visibility">
          <option value="public" ${ch.visibility === 'public' ? 'selected' : ''}>Public</option>
          <option value="private" ${ch.visibility === 'private' ? 'selected' : ''}>Private</option>
        </select>
      </div>
    </div>`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-primary" onclick="saveCollabChannelEdit()">Save changes</button><button class="btn btn-outline" onclick="closeModal()">Cancel</button>`;
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('collab-edit-channel-name')?.focus(), 0);
}

async function saveCollabChannelEdit() {
  const ch = collabCurrentChannel();
  if (!ch) { toast('Select a channel first', 'error'); return; }
  if (!collabCanManageChannel(ch) || collabIsDefaultChannel(ch)) { toast('You cannot edit this channel', 'error'); return; }
  const name = document.getElementById('collab-edit-channel-name')?.value.trim();
  const description = document.getElementById('collab-edit-channel-desc')?.value.trim() || '';
  const visibility = document.getElementById('collab-edit-channel-visibility')?.value || 'public';
  if (!name) { toast('Please enter a channel name', 'error'); return; }
  const slug = collabSlugFromName(name);
  try {
    const { error } = await sb.from('collab_channels')
      .update({ name, slug, description, visibility })
      .eq('id', ch.id);
    if (error) throw error;
    toast('✓ Channel updated', 'success');
    closeModal();
    await loadCollabChannels();
    await selectCollabChannel(ch.id);
  } catch (err) { toast('Could not update channel: ' + (err.message || err), 'error'); }
}

async function deleteCollabChannel() {
  const ch = collabCurrentChannel();
  if (!ch) { toast('Select a channel first', 'error'); return; }
  if (!collabCanManageChannel(ch)) { toast('Only Admins or the channel creator can delete this chat', 'error'); return; }
  if (collabIsDefaultChannel(ch)) { toast('Default channels cannot be deleted', 'error'); return; }
  const messageCount = (COLLAB.messages || []).filter(m => m.channel_id === ch.id).length;
  const warning = messageCount ? `\n\nThis will hide the channel and its ${messageCount} loaded message${messageCount === 1 ? '' : 's'} from Team Chat. The data is archived, not permanently erased.` : '\n\nThe channel will be archived, not permanently erased.';
  if (!confirm(`Delete chat channel "${ch.name}"?${warning}`)) return;
  try {
    const { error } = await sb.from('collab_channels')
      .update({ is_archived:true })
      .eq('id', ch.id);
    if (error) throw error;
    toast('✓ Chat deleted', 'success');
    COLLAB.currentChannelId = null;
    localStorage.removeItem('collabCurrentChannelId');
    COLLAB.messages = [];
    await loadCollabChannels();
    if (!COLLAB.channels.length) {
      document.getElementById('collab-channel-name').textContent = 'Select a channel';
      document.getElementById('collab-channel-sub').textContent = 'Choose a channel to start collaborating.';
      document.getElementById('collab-messages').innerHTML = '<div class="collab-empty">No channel selected yet.</div>';
      renderCollabChannelManagementActions(null);
    }
  } catch (err) { toast('Could not delete chat: ' + (err.message || err), 'error'); }
}

async function openChannelMembersModal() {
  if (!COLLAB.currentChannelId) { toast('Select a channel first', 'error'); return; }
  const ch = COLLAB.channels.find(c => c.id === COLLAB.currentChannelId);
  await loadCollabUsers(true);
  let members = [];
  try { const { data } = await sb.from('collab_channel_members').select('channel_id,user_email,role,created_at').eq('channel_id', COLLAB.currentChannelId); members = data || []; } catch (_err) {}
  const memberEmails = new Set(members.map(m => m.user_email));
  const canManage = collabCanManageChannel(ch);
  const list = members.map(m => {
    const u = COLLAB.usersByEmail[String(m.user_email).toLowerCase()] || { email:m.user_email, display_name:m.user_email };
    return `<div class="collab-member-row"><div><strong>${collabHtml(u.display_name || u.email)}</strong><div class="form-hint">${collabHtml(u.email)} · ${collabHtml(m.role || 'member')}</div></div>${canManage && m.user_email !== currentUser.email ? `<button class="btn btn-outline btn-sm" onclick="removeChannelMember('${collabAttr(m.user_email)}')">Remove</button>` : ''}</div>`;
  }).join('') || '<div class="empty">No explicit members yet. Public channels are visible to everyone.</div>';
  const addOptions = COLLAB.users.filter(u => !memberEmails.has(u.email)).map(u => `<option value="${collabAttr(u.email)}">${collabHtml(u.display_name || u.email)} · ${collabHtml(u.email)}</option>`).join('');
  document.getElementById('modal-title').textContent = `Members — ${ch?.name || 'Channel'}`;
  document.getElementById('modal-meta').innerHTML = `<span class="pill-muted">${collabHtml(ch?.visibility || '')}</span>`;
  document.getElementById('modal-body').innerHTML = `<div class="collab-member-list">${list}</div>${canManage ? `<div class="section-divider"></div><div class="inline-form-row"><div class="form-group"><label class="form-label">Add member</label><select class="form-select" id="collab-add-member-select">${addOptions}</select></div><button class="btn btn-primary" onclick="addChannelMember()">Add</button></div>` : '<div class="alert alert-info" style="margin-top:14px">Only Admins or the channel creator can manage members.</div>'}`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function addChannelMember() {
  const email = document.getElementById('collab-add-member-select')?.value;
  if (!email) return;
  try { await sb.from('collab_channel_members').insert({ channel_id:COLLAB.currentChannelId, user_email:email, role:'member' }); toast('✓ Member added', 'success'); await openChannelMembersModal(); } catch (err) { toast('Could not add member: ' + (err.message || err), 'error'); }
}
async function removeChannelMember(email) {
  if (!confirm('Remove this member from the channel?')) return;
  try { await sb.from('collab_channel_members').delete().eq('channel_id', COLLAB.currentChannelId).eq('user_email', email); toast('✓ Member removed', 'success'); await openChannelMembersModal(); } catch (err) { toast('Could not remove member: ' + (err.message || err), 'error'); }
}

async function sendAdminAnnouncement() {
  if (!isAdmin()) return;
  const input = document.getElementById('collab-announcement-text');
  const body = input?.value.trim();
  if (!body) { toast('Write an announcement first', 'error'); return; }

  // Issue 5B-3: ensure channels are loaded so we can find the admin-announcement channel UUID.
  if (!COLLAB.channels || !COLLAB.channels.length) {
    try { await loadCollabChannels(); } catch (_e) {}
  }
  let annCh = (COLLAB.channels || []).find(c => String(c.slug || '').toLowerCase() === 'admin-announcement');
  if (!annCh) {
    // Try to create it on the fly (admins are allowed to insert channels).
    try {
      const { data: created } = await sb.from('collab_channels')
        .insert({ name:'admin-announcement', slug:'admin-announcement', description:'Admin announcements. Read-only — only admins can post.', visibility:'public', created_by:currentUser.email })
        .select().single();
      if (created) {
        annCh = created;
        COLLAB.channels = [...(COLLAB.channels || []), created];
      }
    } catch (_e) {
      // Re-load in case another admin created it between our check and insert.
      try { await loadCollabChannels(); } catch (_e2) {}
      annCh = (COLLAB.channels || []).find(c => String(c.slug || '').toLowerCase() === 'admin-announcement');
    }
  }
  if (!annCh) {
    toast('Could not find or create #admin-announcement channel. Please refresh and try again.', 'error');
    return;
  }

  // Issue 5B-2: post the announcement text as a real message in the channel.
  let messageId = null;
  try {
    const { data: msg, error: msgErr } = await sb.from('collab_messages').insert({
      channel_id: annCh.id,
      author_email: currentUser.email,
      author_name: collabCurrentName(),
      body
    }).select().single();
    if (msgErr) throw msgErr;
    messageId = msg?.id || null;
  } catch (err) {
    toast('Could not post announcement to channel: ' + (err.message || err), 'error');
    return;
  }

  // Issue 5B-1: notify every user with the correct link_type/link_ref so the
  // notification click handler deep-links into the admin-announcement channel.
  await loadCollabUsers(true);
  await createNotifications(COLLAB.users.map(u => ({
    recipient_email: u.email,
    actor_email: currentUser.email,
    actor_name: collabCurrentName(),
    type: 'ADMIN_ANNOUNCEMENT',
    title: 'Admin announcement',
    body,
    link_type: 'channel',
    link_ref: annCh.id,
    metadata: { channel_id: annCh.id, channel_slug: 'admin-announcement', message_id: messageId }
  })));
  if (input) input.value = '';
  toast('✓ Announcement posted to #admin-announcement and notifications sent', 'success');
}

function openUserProfileByUsername(username) { const u = COLLAB.usersByUsername[String(username || '').toLowerCase()]; if (u) openUserProfile(u); }
function openUserProfileByEmail(email) { const u = COLLAB.usersByEmail[String(email || '').toLowerCase()] || { email, display_name:email, username:collabUsernameFromEmail(email), role:'staff' }; openUserProfile(u); }
function openUserProfile(user) {
  document.getElementById('modal-title').textContent = user.display_name || user.email || 'User profile';
  document.getElementById('modal-meta').innerHTML = `<span class="pill-muted">@${collabHtml(user.username || collabUsernameFromEmail(user.email))}</span><span class="pill-muted">${collabHtml(collabVisibleRole(user.role))}</span>`;
  document.getElementById('modal-body').innerHTML = `<div class="collab-profile-card"><div class="collab-profile-avatar">${collabHtml(collabInitials(user.display_name || user.email))}</div><div><div class="detail-label">Name</div><div class="detail-value">${collabHtml(user.display_name || '')}</div><div class="detail-label" style="margin-top:12px">Email</div><div class="detail-value">${collabHtml(user.email || '')}</div><div class="detail-label" style="margin-top:12px">Username</div><div class="detail-value">@${collabHtml(user.username || collabUsernameFromEmail(user.email))}</div><div class="detail-label" style="margin-top:12px">Last seen</div><div class="detail-value">${user.last_seen_at ? fmtDateFull(user.last_seen_at) : 'Not available'}</div></div></div>`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
  document.getElementById('modal-overlay').classList.add('open');
}

// Mention rendering + autocomplete for existing question follow-up comments.
const _collabRenderCommentItem = renderCommentItem;
renderCommentItem = function(node, questionId, context, previewDepth = 0, isPreview = false) {
  const html = _collabRenderCommentItem(node, questionId, context, previewDepth, isPreview);
  const nodeKey = domKey(context, node.id);
  return html.replace(`<div class="comment-text" id="comment-text-${nodeKey}">${escHtml(node.text)}</div>`, `<div class="comment-text" id="comment-text-${nodeKey}">${renderMentionedText(node.text)}</div>`);
};

const _collabRenderCommentForm = renderCommentForm;
renderCommentForm = function(questionId, parentId = null, context = 'faq') {
  const html = _collabRenderCommentForm(questionId, parentId, context);
  setTimeout(() => {
    const key = commentFormKey(questionId, parentId, context);
    const ta = document.getElementById(`comment-textarea-${key}`);
    if (ta) { setupMentionAutocomplete(ta); ta.setAttribute('spellcheck','true'); ta.setAttribute('lang','en'); }
  }, 0);
  return html;
};

const _collabAddComment = addComment;
addComment = async function(questionId, text, parentId = null) {
  const data = await _collabAddComment(questionId, text, parentId);
  if (!data) return data;
  let q = null;
  try { const res = await sb.from('questions').select('id,question_id,task_id,submitter_email,submitter_name,status').eq('id', questionId).single(); q = res.data; } catch (_err) {}
  const baseBody = `${collabCurrentName()} ${parentId ? 'replied to' : 'commented on'} ${q?.question_id || q?.task_id || 'a question'}`;
  const recipients = new Set();
  if (q?.submitter_email && q.submitter_email !== currentUser.email) recipients.add(q.submitter_email);
  if (parentId) {
    try { const res = await sb.from('question_comments').select('user_email').eq('id', parentId).single(); if (res.data?.user_email && res.data.user_email !== currentUser.email) recipients.add(res.data.user_email); } catch (_err) {}
  }
  await createNotifications([...recipients].map(email => ({ recipient_email:email, actor_email:currentUser.email, actor_name:collabCurrentName(), type:parentId ? 'COMMENT_REPLIED' : 'COMMENT_ADDED', title:parentId ? 'New reply' : 'New comment', body:baseBody, link_type:'question', link_ref:questionId, metadata:{ question_id:q?.question_id, bill_id:q?.task_id, comment_id:data.id } })));
  await notifyMentionedUsers(text, { body:baseBody, link_type:'question', link_ref:questionId, metadata:{ question_id:q?.question_id, bill_id:q?.task_id, comment_id:data.id } });
  return data;
};

// Notify submitters when answers/status are updated from the review modal.
const _collabSaveAnswer = saveAnswer;
saveAnswer = async function() {
  const before = currentQ ? { ...currentQ } : null;
  await _collabSaveAnswer();
  if (!before || !before.submitter_email || before.submitter_email === currentUser?.email) return;
  const after = (allQuestions || []).find(q => q.id === before.id) || before;
  const rows = [];
  if (after.status === 'Answered' && before.status !== 'Answered') rows.push({ type:'QUESTION_ANSWERED', title:'Question answered', body:`Your question ${before.question_id || before.task_id} has been answered.` });
  else if (after.status !== before.status) rows.push({ type:'STATUS_UPDATED', title:'Status updated', body:`${before.question_id || before.task_id} changed to ${after.status}.` });
  if (rows.length) await createNotifications(rows.map(r => ({ recipient_email:before.submitter_email, actor_email:currentUser.email, actor_name:collabCurrentName(), type:r.type, title:r.title, body:r.body, link_type:'question', link_ref:before.id, metadata:{ question_id:before.question_id, bill_id:before.task_id, status:after.status } })));
};

function openAnsweredByRef(ref) {
  const value = String(ref || '').trim().toLowerCase();
  if (!value) return;
  const search = document.getElementById('faq-search');
  if (search) { search.value = value; updateFaqSearchClearButton(); renderFaq(); }
  setTimeout(() => {
    const cards = [...document.querySelectorAll('.faq-card')];
    const card = cards.find(c => (c.textContent || '').toLowerCase().includes(value));
    if (card) { card.scrollIntoView({ behavior:'smooth', block:'center' }); if (!card.querySelector('.faq-answer-preview.open')) card.click(); card.style.outline = '3px solid var(--accent2)'; setTimeout(() => card.style.outline = '', 2200); }
  }, 150);
}

// Keep mention autocomplete alive in dynamically injected textareas.
document.addEventListener('focusin', evt => {
  if (evt.target && (evt.target.classList?.contains('comment-textarea') || evt.target.id === 'collab-message-input')) setupMentionAutocomplete(evt.target);
});

// ══════════════════════════════════════
// USER INFO + RBAC + FULL-NAME MENTION ENHANCEMENTS
// Uses the deployed Supabase SQL: collab_profiles.user_id/custom_username + app_user_roles.
// ══════════════════════════════════════
const USER_INFO = {
  rolesByEmail: {},
  roleRows: [],
  users: [],
  filtered: [],
  page: 1,
  pageSize: 25,
  search: '',
  roleFilter: '',
  sortKey: 'name',
  sortDir: 'asc',
  pendingImportRows: [],
  currentIsAdminRpc: false,
  roleOptions: ['user','reviewer','admin','primary_admin','reviewer_admin']
};

function uiEmail(email) { return String(email || '').trim().toLowerCase(); }
function uiRoleDisplay(role) {
  const map = { staff:'User', user:'User', reviewer:'Reviewer', admin:'Admin', primary_admin:'Primary Admin', reviewer_admin:'Reviewer Admin' };
  return map[String(role || 'user').toLowerCase()] || 'User';
}
function uiNormalizeRole(role) {
  const value = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = { staff:'user', user:'user', member:'user', reviewer:'reviewer', review:'reviewer', admin:'admin', administrator:'admin', primary:'primary_admin', primary_admin:'primary_admin', owner:'primary_admin', reviewer_admin:'reviewer_admin', revieweradmin:'reviewer_admin' };
  return map[value] || (USER_INFO.roleOptions.includes(value) ? value : 'user');
}
function uiIsAdminRole(role) { return ['admin','primary_admin','reviewer_admin'].includes(uiNormalizeRole(role)); }
function uiIsReviewerRole(role) { return ['reviewer','admin','primary_admin','reviewer_admin'].includes(uiNormalizeRole(role)); }
function uiRoleRank(role) {
  const r = uiNormalizeRole(role);
  return r === 'primary_admin' ? 5 : r === 'reviewer_admin' ? 4 : r === 'admin' ? 3 : r === 'reviewer' ? 2 : 1;
}
function uiDisplayName(userOrEmail) {
  const u = typeof userOrEmail === 'string' ? (COLLAB?.usersByEmail?.[uiEmail(userOrEmail)] || { email:userOrEmail }) : (userOrEmail || {});
  return String(u.display_name || u.full_name || u.name || (u.email ? String(u.email).split('@')[0] : 'User')).trim();
}
function uiMentionLabel(user) { return uiDisplayName(user); }
function uiUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim()); }
function uiDateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0,10);
  if (typeof value === 'number') {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
  }
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}
function uiNumberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%','').trim());
  return Number.isFinite(n) ? n : null;
}
function uiProfileRole(email, profileRole) {
  const e = uiEmail(email);
  const roleRow = USER_INFO.rolesByEmail[e]?.role;
  if (roleRow) return uiNormalizeRole(roleRow);
  if (e === uiEmail(V2_ADMIN_EMAIL)) return 'primary_admin';
  if (allowedReviewers.includes(e)) return 'reviewer';
  return uiNormalizeRole(profileRole || 'user');
}

async function loadAppRoles() {
  USER_INFO.roleRows = [];
  USER_INFO.rolesByEmail = {};
  USER_INFO.currentIsAdminRpc = false;
  try {
    const rpc = await sb.rpc('is_app_admin');
    USER_INFO.currentIsAdminRpc = rpc.data === true;
  } catch (_err) {}
  try {
    const { data, error } = await sb.from('app_user_roles').select('email,role,created_at,updated_at').order('role', { ascending:false });
    if (!error) USER_INFO.roleRows = data || [];
  } catch (_err) {}
  USER_INFO.roleRows.forEach(r => { if (r.email) USER_INFO.rolesByEmail[uiEmail(r.email)] = r; });
  if (!USER_INFO.rolesByEmail[uiEmail(V2_ADMIN_EMAIL)]) {
    USER_INFO.rolesByEmail[uiEmail(V2_ADMIN_EMAIL)] = { email:V2_ADMIN_EMAIL, role:'primary_admin' };
  }
}

loadAllowedReviewers = async function() {
  let reviewerRows = [];
  try {
    const { data } = await sb.from('reviewers').select('email').order('email');
    reviewerRows = data || [];
  } catch (_err) {}
  await loadAppRoles();
  const emails = new Set(reviewerRows.map(r => uiEmail(r.email)).filter(Boolean));
  Object.values(USER_INFO.rolesByEmail).forEach(r => { if (uiIsReviewerRole(r.role)) emails.add(uiEmail(r.email)); });
  emails.add(uiEmail(V2_ADMIN_EMAIL));
  allowedReviewers = [...emails].filter(Boolean);
  window.reviewersLoaded = true; // Issue 4C
};

isAdmin = function() {
  if (!currentUser) return false;
  const email = uiEmail(currentUser.email);
  if (email === uiEmail(V2_ADMIN_EMAIL)) return true;
  if (USER_INFO.currentIsAdminRpc) return true;
  return uiIsAdminRole(USER_INFO.rolesByEmail[email]?.role);
};

isReviewer = function() {
  if (!currentUser) return false;
  const email = uiEmail(currentUser.email);
  return isAdmin() || allowedReviewers.includes(email) || uiIsReviewerRole(USER_INFO.rolesByEmail[email]?.role);
};

function updateUserInfoHero() {
  const hero = document.querySelector('#page-admin .hero-premium');
  if (!hero) return;
  const kicker = hero.querySelector('.hero-kicker');
  const h1 = hero.querySelector('h1');
  const p = hero.querySelector('p');
  if (kicker) kicker.textContent = 'Admin Only';
  if (h1) h1.innerHTML = '<span>User</span> Info';
  if (p) p.textContent = 'Central hub for user management, roles, system health, analytics, channels, logs, and admin-level operational controls.';
}

function ensureProfileNavButton() {
  // Issue 2B: standalone "Profile" button removed; clicking the user name opens profile settings.
  const userWrap = document.querySelector('#main-nav .nav-user');
  if (!userWrap) return;
  // Defensively remove any previously-rendered Profile button (e.g. from a prior buildNav pass).
  const existing = document.getElementById('nav-profile-settings');
  if (existing) existing.remove();
  const name = document.getElementById('nav-name');
  if (name) {
    name.title = 'Open profile settings';
    name.style.cursor = 'pointer';
    name.onclick = openProfileSettings;
  }
  const avatar = document.getElementById('nav-avatar');
  if (avatar) {
    avatar.title = 'Open profile settings';
    avatar.style.cursor = 'pointer';
    avatar.onclick = openProfileSettings;
  }
}

const _uiBuildNav = buildNav;
buildNav = function() {
  _uiBuildNav();
  const adminBtn = document.getElementById('nav-admin');
  if (adminBtn) adminBtn.childNodes[0].nodeValue = 'User Info';
  ensureProfileNavButton();
};

const _uiShowPage = showPage;
showPage = function(id) {
  if (id === 'admin' && !isAdmin()) {
    toast('Admin access is protected by role-based access control.', 'error');
    return _uiShowPage(isReviewer() ? 'review' : 'submit');
  }
  _uiShowPage(id);
  if (id === 'admin' && isAdmin()) setTimeout(() => { updateUserInfoHero(); ensureUserInfoTab(); }, 0);
};

const _uiLoadAdminPanel = loadAdminPanel;
loadAdminPanel = async function() {
  if (!isAdmin()) return;
  updateUserInfoHero();
  ensureUserInfoTab();
  await _uiLoadAdminPanel();
  if (P3?.adminTab === 'user-info') await loadUserInfoDashboard();
};

function ensureUserInfoTab() {
  if (!isAdmin()) return;
  const tabbar = document.getElementById('admin-tabbar');
  if (!tabbar) return;
  if (!document.querySelector('.admin-tab[data-tab="user-info"]')) {
    const btn = document.createElement('button');
    btn.className = 'admin-tab';
    btn.dataset.tab = 'user-info';
    btn.textContent = 'User Info';
    btn.onclick = () => switchAdminTab('user-info');
    tabbar.insertBefore(btn, tabbar.firstChild);
  }
  if (!document.getElementById('admin-pane-user-info')) {
    const pane = document.createElement('div');
    pane.className = 'admin-pane';
    pane.id = 'admin-pane-user-info';
    pane.innerHTML = userInfoHtml();
    const dash = document.querySelector('#page-admin .admin-dashboard');
    if (dash) dash.appendChild(pane);
    setupUserInfoDropzone();
  }
}

const _uiSetupAdminTabs = setupAdminTabs;
setupAdminTabs = function() {
  _uiSetupAdminTabs();
  ensureUserInfoTab();
};

const _uiSwitchAdminTab = switchAdminTab;
switchAdminTab = function(k) {
  ensureUserInfoTab();
  _uiSwitchAdminTab(k);
  if (k === 'user-info') loadUserInfoDashboard();
};

function userInfoHtml() {
  return `
    <section class="admin-card admin-grid-full">
      <div class="admin-section-title">
        <div>
          <h3>👤 User Info</h3>
          <p class="admin-card-subtitle">Admin-only control center for human-readable identities, user metadata, role assignments, and operational shortcuts.</p>
        </div>
        <div class="user-info-actions">
          <button class="btn btn-outline btn-sm" onclick="loadUserInfoDashboard(true)">↻ Refresh users</button>
          <button class="btn btn-outline btn-sm" onclick="downloadUserTemplate()">Download Excel template</button>
        </div>
      </div>
      <div class="user-info-grid">
        <div class="user-info-card"><div class="user-info-value" id="ui-total-users">—</div><div class="user-info-label">Total users</div></div>
        <div class="user-info-card"><div class="user-info-value" id="ui-admin-users">—</div><div class="user-info-label">Admin-level accounts</div></div>
        <div class="user-info-card"><div class="user-info-value" id="ui-reviewer-users">—</div><div class="user-info-label">Reviewers</div></div>
        <div class="user-info-card"><div class="user-info-value" id="ui-health-state">—</div><div class="user-info-label">RBAC health</div></div>
      </div>
      <div class="quick-access-grid">
        <button class="quick-access-card" onclick="showPage('review')"><strong>Reviews</strong><div class="user-info-muted">Open reviewer queue</div></button>
        <button class="quick-access-card" onclick="switchAdminTab('analytics')"><strong>Analytics</strong><div class="user-info-muted">Question trends and performance</div></button>
        <button class="quick-access-card" onclick="showPage('collab')"><strong>Channels</strong><div class="user-info-muted">Slack-like team chat</div></button>
        <button class="quick-access-card" onclick="switchAdminTab('data')"><strong>Logs</strong><div class="user-info-muted">Activity and archive controls</div></button>
      </div>
      <div class="user-info-dropzone" id="user-info-dropzone">
        <strong>Drag and drop an Excel file to bulk update users</strong>
        <div class="user-info-muted">Admins can upload .xlsx, .xls, or .csv files. The app previews the detected rows before applying changes to profiles and roles.</div>
        <input type="file" id="user-info-file-input" accept=".xlsx,.xls,.csv" style="display:none" onchange="handleUserInfoFile(this.files?.[0])">
        <button class="btn btn-outline btn-sm" style="margin-top:12px" onclick="document.getElementById('user-info-file-input').click()">Choose file</button>
        <div id="user-info-import-preview"></div>
      </div>
      <div class="user-info-toolbar">
        <input class="filter-search" id="user-info-search" placeholder="Search by full name, email, user ID..." oninput="USER_INFO.search=this.value;USER_INFO.page=1;renderUserInfoTable()">
        <select id="user-info-role-filter" class="form-select" style="max-width:190px" onchange="USER_INFO.roleFilter=this.value;USER_INFO.page=1;renderUserInfoTable()">
          <option value="">All roles</option><option value="user">User</option><option value="reviewer">Reviewer</option><option value="admin">Admin</option><option value="primary_admin">Primary Admin</option><option value="reviewer_admin">Reviewer Admin</option>
        </select>
        <span class="result-count" id="user-info-count"></span>
      </div>
      <div class="user-info-table-shell">
        <div class="user-info-table-wrap" id="user-info-table-wrap"><div class="loading"><div class="spinner"></div> Loading users...</div></div>
        <div class="user-info-table-footer">
          <span class="user-info-muted" id="user-info-page-label">—</span>
          <div class="user-info-actions"><button class="btn btn-outline btn-sm" onclick="userInfoPrevPage()">Previous</button><button class="btn btn-outline btn-sm" onclick="userInfoNextPage()">Next</button></div>
        </div>
      </div>
    </section>`;
}

async function loadUserInfoDashboard(force=false) {
  if (!isAdmin()) return;
  ensureUserInfoTab();
  const wrap = document.getElementById('user-info-table-wrap');
  if (wrap && (force || !USER_INFO.users.length)) wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading users...</div>';
  await loadAllowedReviewers();
  const byEmail = {};
  try {
    const { data, error } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').order('display_name', { ascending:true }).limit(5000);
    if (error) throw error;
    (data || []).forEach(p => {
      const email = uiEmail(p.email);
      if (!email) return;
      byEmail[email] = { ...byEmail[email], ...p, email };
    });
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="empty-premium"><strong>User profiles unavailable</strong>${escHtml(err.message || err)}</div>`;
  }
  try {
    const { data } = await sb.from('questions').select('submitter_email,submitter_name,answered_by').limit(5000);
    (data || []).forEach(q => {
      if (q.submitter_email) {
        const email = uiEmail(q.submitter_email);
        byEmail[email] = { ...byEmail[email], email, display_name: byEmail[email]?.display_name || q.submitter_name || email.split('@')[0] };
      }
      if (q.answered_by && String(q.answered_by).includes('@')) {
        const email = uiEmail(q.answered_by);
        byEmail[email] = { ...byEmail[email], email, display_name: byEmail[email]?.display_name || email.split('@')[0], role: 'reviewer' };
      }
    });
  } catch (_err) {}
  allowedReviewers.forEach(email => {
    const e = uiEmail(email);
    byEmail[e] = { ...byEmail[e], email:e, display_name: byEmail[e]?.display_name || e.split('@')[0], role: uiProfileRole(e, byEmail[e]?.role) };
  });
  Object.values(USER_INFO.rolesByEmail).forEach(r => {
    const e = uiEmail(r.email);
    byEmail[e] = { ...byEmail[e], email:e, display_name: byEmail[e]?.display_name || e.split('@')[0], role: uiNormalizeRole(r.role) };
  });
  USER_INFO.users = Object.values(byEmail).map(u => ({ ...u, role: uiProfileRole(u.email, u.role) })).sort((a,b) => uiRoleRank(b.role) - uiRoleRank(a.role) || uiDisplayName(a).localeCompare(uiDisplayName(b)));
  safeText('ui-total-users', USER_INFO.users.length);
  safeText('ui-admin-users', USER_INFO.users.filter(u => uiIsAdminRole(u.role)).length);
  safeText('ui-reviewer-users', USER_INFO.users.filter(u => uiNormalizeRole(u.role) === 'reviewer').length);
  safeText('ui-health-state', USER_INFO.currentIsAdminRpc ? 'Protected' : 'Local');
  renderUserInfoTable();
}

function renderUserInfoTable() {
  const wrap = document.getElementById('user-info-table-wrap');
  if (!wrap) return;
  const search = String(USER_INFO.search || '').toLowerCase();
  const roleFilter = uiNormalizeRole(USER_INFO.roleFilter || '');
  USER_INFO.filtered = (USER_INFO.users || []).filter(u => {
    const role = uiNormalizeRole(u.role);
    if (USER_INFO.roleFilter && role !== roleFilter) return false;
    if (search) {
      const hay = [u.display_name, u.email, u.user_id, u.employee_id, u.department, role, uiRoleDisplay(role), u.employee_join_date, u.performance_score].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).sort(userInfoSortCompare);
  const total = USER_INFO.filtered.length;
  const pages = Math.max(1, Math.ceil(total / USER_INFO.pageSize));
  USER_INFO.page = Math.min(Math.max(1, USER_INFO.page), pages);
  const start = (USER_INFO.page - 1) * USER_INFO.pageSize;
  const rows = USER_INFO.filtered.slice(start, start + USER_INFO.pageSize);
  safeText('user-info-count', `${total} user${total !== 1 ? 's' : ''}`);
  safeText('user-info-page-label', total ? `Page ${USER_INFO.page} of ${pages} · showing ${start + 1}-${Math.min(start + USER_INFO.pageSize, total)} of ${total}` : 'No users');
  if (!rows.length) { wrap.innerHTML = '<div class="empty"><div class="empty-icon">👤</div><h3>No matching users</h3><p>Try clearing the search or role filter.</p></div>'; return; }
  wrap.innerHTML = `<table><thead><tr>${userInfoHeaderHtml('name','Full Name')}${userInfoHeaderHtml('email','Email Address')}${userInfoHeaderHtml('user_id','User ID')}${userInfoHeaderHtml('join_date','Employee Join Date')}${userInfoHeaderHtml('score','Performance Score')}${userInfoHeaderHtml('role','Role')}<th>Actions</th></tr></thead><tbody>${rows.map(u => userInfoRowHtml(u)).join('')}</tbody></table>`;
}

function userInfoHeaderHtml(key, label) {
  const active = USER_INFO.sortKey === key;
  const icon = active ? (USER_INFO.sortDir === 'asc' ? '▲' : '▼') : '↕';
  return `<th class="user-info-sort-th ${active ? 'active' : ''}" role="button" tabindex="0" onclick="sortUserInfo('${escAttr(key)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();sortUserInfo('${escAttr(key)}')}">${escHtml(label)}<span class="user-info-sort-icon">${icon}</span></th>`;
}

function sortUserInfo(key) {
  const allowed = ['name','email','user_id','join_date','score','role'];
  if (!allowed.includes(key)) return;
  if (USER_INFO.sortKey === key) {
    USER_INFO.sortDir = USER_INFO.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    USER_INFO.sortKey = key;
    USER_INFO.sortDir = 'asc';
  }
  USER_INFO.page = 1;
  renderUserInfoTable();
}

function userInfoSortValue(u, key) {
  if (key === 'name') return uiDisplayName(u).toLowerCase();
  if (key === 'email') return uiEmail(u.email);
  if (key === 'user_id') return String(u.user_id || '').toLowerCase();
  if (key === 'join_date') return u.employee_join_date ? new Date(u.employee_join_date).getTime() : null;
  if (key === 'score') return uiNumberValue(u.performance_score);
  if (key === 'role') return uiRoleDisplay(uiNormalizeRole(u.role)).toLowerCase();
  return '';
}

function userInfoSortCompare(a, b) {
  const key = USER_INFO.sortKey || 'role';
  const dir = USER_INFO.sortDir === 'desc' ? -1 : 1;
  const av = userInfoSortValue(a, key);
  const bv = userInfoSortValue(b, key);
  const aBlank = av === null || av === undefined || av === '' || Number.isNaN(av);
  const bBlank = bv === null || bv === undefined || bv === '' || Number.isNaN(bv);
  if (aBlank && bBlank) return uiDisplayName(a).localeCompare(uiDisplayName(b)) || uiEmail(a.email).localeCompare(uiEmail(b.email));
  if (aBlank) return 1;
  if (bBlank) return -1;
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir || uiDisplayName(a).localeCompare(uiDisplayName(b));
  return String(av).localeCompare(String(bv), undefined, { numeric:true, sensitivity:'base' }) * dir || uiDisplayName(a).localeCompare(uiDisplayName(b)) || uiEmail(a.email).localeCompare(uiEmail(b.email));
}

function userInfoRowHtml(u) {
  const email = uiEmail(u.email);
  const role = uiNormalizeRole(u.role);
  const name = uiDisplayName(u);
  const userId = u.user_id || 'Pending profile sync';
  const join = u.employee_join_date || '';
  const score = u.performance_score ?? '';
  const roleOptions = USER_INFO.roleOptions.map(r => `<option value="${r}" ${role === r ? 'selected' : ''}>${uiRoleDisplay(r)}</option>`).join('');
  return `<tr data-user-email="${escAttr(email)}">
    <td><strong>${escHtml(name)}</strong><div class="user-info-muted">${escHtml(u.department || '')}</div></td>
    <td>${escHtml(email)}</td>
    <td class="td-id">${escHtml(userId)}</td>
    <td><input type="date" class="user-info-edit-input" id="ui-join-${escAttr(email)}" value="${escAttr(join)}"></td>
    <td><input type="number" step="0.01" class="user-info-edit-input" id="ui-score-${escAttr(email)}" value="${escAttr(score)}" placeholder="Manual/system"></td>
    <td><select class="user-info-edit-select" id="ui-role-${escAttr(email)}">${roleOptions}</select><div style="margin-top:5px"><span class="user-info-role-pill">${escHtml(uiRoleDisplay(role))}</span></div></td>
    <td><div class="table-actions"><button class="btn btn-outline btn-sm" onclick="openUserProfileByEmail('${escAttr(email)}')">Profile</button><button class="btn btn-primary btn-sm" onclick="saveUserInfoRow('${escAttr(email)}')">Save</button></div></td>
  </tr>`;
}
function userInfoPrevPage(){ USER_INFO.page = Math.max(1, USER_INFO.page - 1); renderUserInfoTable(); }
function userInfoNextPage(){ USER_INFO.page += 1; renderUserInfoTable(); }

async function saveUserInfoRow(email) {
  if (!isAdmin()) return;
  const e = uiEmail(email);
  const existing = USER_INFO.users.find(u => uiEmail(u.email) === e) || { email:e };
  const role = uiNormalizeRole(document.getElementById(`ui-role-${e}`)?.value || existing.role || 'user');
  const join = document.getElementById(`ui-join-${e}`)?.value || null;
  const score = uiNumberValue(document.getElementById(`ui-score-${e}`)?.value);
  const profilePayload = { email:e, display_name: uiDisplayName(existing), role, employee_join_date: join || null, performance_score: score, updated_at: new Date().toISOString() };
  try {
    const { error } = await sb.from('collab_profiles').upsert(profilePayload, { onConflict:'email' });
    if (error) throw error;
    const { error: roleErr } = await sb.from('app_user_roles').upsert({ email:e, role, assigned_by: currentUser.email, updated_at:new Date().toISOString() }, { onConflict:'email' });
    if (roleErr) throw roleErr;
    await logUserInfoActivity('USER_ROLE_UPDATED', e, { role, employee_join_date: join || null, performance_score: score });
    toast('✓ User info updated', 'success');
    await loadUserInfoDashboard(true);
  } catch (err) { toast('Could not update user: ' + (err.message || err), 'error'); }
}

async function logUserInfoActivity(action, entityId, metadata={}) {
  try {
    const { error } = await sb.from('admin_activity_log').insert({ actor_email: currentUser?.email || null, action, entity_type:'user', entity_id:entityId, metadata });
    if (error) throw error;
  } catch (_err) {
    try { await logActivity(action, 'user', null, entityId, metadata); } catch (__err) {}
  }
}

function setupUserInfoDropzone() {
  const zone = document.getElementById('user-info-dropzone');
  if (!zone || zone.dataset.ready === 'true') return;
  zone.dataset.ready = 'true';
  ['dragenter','dragover'].forEach(evtName => zone.addEventListener(evtName, evt => { evt.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(evtName => zone.addEventListener(evtName, evt => { evt.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', evt => handleUserInfoFile(evt.dataTransfer?.files?.[0]));
}

async function handleUserInfoFile(file) {
  if (!file) return;
  try { await AppAPI.ensureXLSX(); } catch (err) { toast('Excel parser failed to load. ' + (err?.message || ''), 'error'); return; }
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type:'array', cellDates:true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval:'' });
    USER_INFO.pendingImportRows = raw.map(normalizeUserImportRow).filter(r => r.email);
    renderUserImportPreview(file.name);
  } catch (err) { toast('Could not read Excel file: ' + (err.message || err), 'error'); }
}

function normalizeUserImportRow(row) {
  const normalized = {};
  Object.entries(row || {}).forEach(([key,value]) => { normalized[String(key).toLowerCase().replace(/[^a-z0-9]/g,'')] = value; });
  const email = uiEmail(normalized.emailaddress || normalized.email || normalized.useremail || normalized.mail);
  const name = String(normalized.fullname || normalized.name || normalized.displayname || '').trim();
  const role = uiNormalizeRole(normalized.role || normalized.userrole);
  const userId = String(normalized.userid || normalized.id || '').trim();
  return {
    email,
    display_name: name || (email ? email.split('@')[0] : ''),
    user_id: uiUuid(userId) ? userId : null,
    employee_join_date: uiDateValue(normalized.employeejoindate || normalized.joindate || normalized.startdate),
    performance_score: uiNumberValue(normalized.performancescore || normalized.score || normalized.performance),
    role
  };
}

function renderUserImportPreview(filename) {
  const box = document.getElementById('user-info-import-preview');
  if (!box) return;
  const rows = USER_INFO.pendingImportRows || [];
  if (!rows.length) { box.innerHTML = '<div class="alert alert-warn" style="margin-top:12px">No valid rows found. Include at least Email Address and Full Name columns.</div>'; return; }
  box.innerHTML = `<div class="alert alert-info" style="margin-top:12px"><strong>${escHtml(filename)}</strong> parsed successfully. ${rows.length} user row${rows.length !== 1 ? 's' : ''} ready for review.</div><div class="user-info-preview"><table><thead><tr><th>Full Name</th><th>Email</th><th>Join Date</th><th>Score</th><th>Role</th></tr></thead><tbody>${rows.slice(0,20).map(r => `<tr><td>${escHtml(r.display_name)}</td><td>${escHtml(r.email)}</td><td>${escHtml(r.employee_join_date || '—')}</td><td>${escHtml(r.performance_score ?? '—')}</td><td>${escHtml(uiRoleDisplay(r.role))}</td></tr>`).join('')}</tbody></table></div><div class="user-info-actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="applyUserInfoImport()">Apply updates</button><button class="btn btn-outline btn-sm" onclick="clearUserInfoImport()">Cancel</button></div>`;
}
function clearUserInfoImport(){ USER_INFO.pendingImportRows = []; safeText('user-info-import-preview',''); }

async function applyUserInfoImport() {
  if (!isAdmin()) return;
  const rows = USER_INFO.pendingImportRows || [];
  if (!rows.length) return;
  const profiles = rows.map(r => {
    const payload = { email:r.email, display_name:r.display_name, role:r.role, employee_join_date:r.employee_join_date, performance_score:r.performance_score, updated_at:new Date().toISOString() };
    if (r.user_id) payload.user_id = r.user_id;
    return payload;
  });
  const roles = rows.map(r => ({ email:r.email, role:r.role, assigned_by:currentUser.email, updated_at:new Date().toISOString() }));
  try {
    const { error } = await sb.from('collab_profiles').upsert(profiles, { onConflict:'email' });
    if (error) throw error;
    const { error: roleErr } = await sb.from('app_user_roles').upsert(roles, { onConflict:'email' });
    if (roleErr) throw roleErr;
    await logUserInfoActivity('USER_EXCEL_IMPORT_APPLIED', 'bulk', { rows: rows.length });
    toast(`✓ ${rows.length} user row${rows.length !== 1 ? 's' : ''} updated`, 'success');
    clearUserInfoImport();
    await loadUserInfoDashboard(true);
    await loadCollabUsers(true);
  } catch (err) { toast('Import failed: ' + (err.message || err), 'error'); }
}

async function downloadUserTemplate() {
  const rows = [{ 'Full Name':'Manoj Pandey', 'Email Address':'manoj@example.com', 'User ID':'', 'Employee Join Date':'2026-05-01', 'Performance Score':'95', 'Role':'Reviewer' }];
  try { await AppAPI.ensureXLSX(); } catch (err) { downloadCsv('user-info-template.csv', rows); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Users');
  XLSX.writeFile(wb, `user-info-template-${todayStamp ? todayStamp() : new Date().toISOString().slice(0,10)}.xlsx`);
}

addReviewer = async function() {
  const email = uiEmail(document.getElementById('admin-email-input')?.value);
  if (!email) { toast('Please enter an email', 'error'); return; }
  if (!email.includes('@')) { toast('Invalid email format', 'error'); return; }
  try {
    await sb.from('reviewers').upsert({ email, created_by: currentUser.email }, { onConflict:'email' });
    const { error } = await sb.from('app_user_roles').upsert({ email, role:'reviewer', assigned_by:currentUser.email, updated_at:new Date().toISOString() }, { onConflict:'email' });
    if (error) throw error;
    await logUserInfoActivity('REVIEWER_ADDED', email, { role:'reviewer' });
    await loadAllowedReviewers();
    renderReviewersList();
    const input = document.getElementById('admin-email-input'); if (input) input.value = '';
    toast('✓ Reviewer access updated', 'success');
    if (P3?.adminTab === 'user-info') loadUserInfoDashboard(true);
  } catch (err) { toast('Error adding reviewer: ' + (err.message || err), 'error'); }
};

removeReviewer = async function(email) {
  const e = uiEmail(email);
  if (!confirm(`Remove ${e} as reviewer?`)) return;
  try {
    await sb.from('reviewers').delete().eq('email', e);
    if (e !== uiEmail(V2_ADMIN_EMAIL)) await sb.from('app_user_roles').upsert({ email:e, role:'user', assigned_by:currentUser.email, updated_at:new Date().toISOString() }, { onConflict:'email' });
    await logUserInfoActivity('REVIEWER_REMOVED', e, { role:'user' });
    await loadAllowedReviewers();
    renderReviewersList();
    toast('✓ Reviewer removed', 'success');
    if (P3?.adminTab === 'user-info') loadUserInfoDashboard(true);
  } catch (err) { toast('Error removing reviewer: ' + (err.message || err), 'error'); }
};

renderReviewersList = function() {
  const list = document.getElementById('reviewers-list');
  if (!list) return;
  const unique = [...new Set([...(allowedReviewers || []), uiEmail(V2_ADMIN_EMAIL)])].sort();
  if (!unique.length) { list.innerHTML = '<li style="justify-content:center;color:var(--text3)">No reviewers added yet</li>'; return; }
  list.innerHTML = unique.map(email => {
    const role = uiProfileRole(email, USER_INFO.rolesByEmail[email]?.role);
    const locked = uiIsAdminRole(role) || email === uiEmail(V2_ADMIN_EMAIL);
    return `<li><div><div style="font-weight:700">${escHtml(email)}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${escHtml(uiRoleDisplay(role))}</div></div>${locked ? '<span class="pill-muted">Admin</span>' : `<button class="btn-remove-reviewer" onclick="removeReviewer('${escAttr(email)}')">Remove</button>`}</li>`;
  }).join('');
};

// Full-name profile identity. Internal username remains for legacy lookup; UI defaults to full name.
const _uiUpsertCollabProfile = upsertCollabProfile;
upsertCollabProfile = async function() {
  if (!currentUser) return;
  let existing = null;
  try {
    const { data } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').eq('email', currentUser.email).maybeSingle();
    existing = data || null;
  } catch (_err) {}
  const profile = {
    email: currentUser.email,
    username: existing?.username || collabUsernameFromEmail(currentUser.email),
    display_name: existing?.display_name || currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
    role: uiProfileRole(currentUser.email, existing?.role || collabCurrentRole()),
    avatar_url: currentUser.user_metadata?.avatar_url || existing?.avatar_url || null,
    last_seen_at: new Date().toISOString()
  };
  try {
    const { error } = await sb.from('collab_profiles').upsert(profile, { onConflict:'email' });
    collabOpenError('profile upsert', error);
  } catch (err) { collabOpenError('profile upsert', err); }
  await loadCollabUsers(true);
  refreshCurrentIdentityUI();
};

loadCollabUsers = async function(force=false) {
  if (!force && COLLAB.users.length) return COLLAB.users;
  const map = {};
  try {
    const { data, error } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').order('display_name', { ascending:true }).limit(5000);
    if (!error) (data || []).forEach(p => { if (p.email) map[uiEmail(p.email)] = { ...p, email:uiEmail(p.email) }; });
  } catch (err) { collabOpenError('load profiles', err); }
  try {
    const { data } = await sb.from('questions').select('submitter_email,submitter_name,answered_by').limit(5000);
    (data || []).forEach(q => {
      if (q.submitter_email) {
        const e = uiEmail(q.submitter_email);
        map[e] = { ...(map[e] || {}), email:e, username:map[e]?.username || collabUsernameFromEmail(e), display_name:map[e]?.display_name || q.submitter_name || e.split('@')[0], role:map[e]?.role || 'user' };
      }
      if (q.answered_by && String(q.answered_by).includes('@')) {
        const e = uiEmail(q.answered_by);
        map[e] = { ...(map[e] || {}), email:e, username:map[e]?.username || collabUsernameFromEmail(e), display_name:map[e]?.display_name || e.split('@')[0], role:map[e]?.role || 'reviewer' };
      }
    });
  } catch (_err) {}
  try {
    const { data } = await sb.from('reviewers').select('email').limit(5000);
    (data || []).forEach(r => { const e = uiEmail(r.email); if (e) map[e] = { ...(map[e] || {}), email:e, username:map[e]?.username || collabUsernameFromEmail(e), display_name:map[e]?.display_name || e.split('@')[0], role:uiProfileRole(e, 'reviewer') }; });
  } catch (_err) {}
  Object.values(USER_INFO.rolesByEmail || {}).forEach(r => {
    const e = uiEmail(r.email);
    if (e) map[e] = { ...(map[e] || {}), email:e, username:map[e]?.username || collabUsernameFromEmail(e), display_name:map[e]?.display_name || e.split('@')[0], role:uiNormalizeRole(r.role) };
  });
  if (currentUser) {
    const e = uiEmail(currentUser.email);
    map[e] = { ...(map[e] || {}), email:e, username:map[e]?.username || collabUsernameFromEmail(e), display_name:map[e]?.display_name || currentUser.user_metadata?.full_name || e.split('@')[0], role:uiProfileRole(e, map[e]?.role || collabCurrentRole()) };
  }
  COLLAB.users = Object.values(map).map(u => ({ ...u, role:uiProfileRole(u.email, u.role), display_name:uiDisplayName(u), username:u.username || collabUsernameFromEmail(u.email) })).sort((a,b) => uiDisplayName(a).localeCompare(uiDisplayName(b)));
  COLLAB.usersByUsername = {};
  COLLAB.usersByEmail = {};
  COLLAB.usersByMentionKey = {};
  COLLAB.users.forEach(u => {
    const email = uiEmail(u.email);
    COLLAB.usersByEmail[email] = u;
    [u.username, u.custom_username, collabUsernameFromEmail(email)].filter(Boolean).forEach(k => { COLLAB.usersByUsername[String(k).toLowerCase()] = u; });
    COLLAB.usersByMentionKey[uiMentionLabel(u).toLowerCase()] = u;
  });
  return COLLAB.users;
};

collabCurrentName = function() {
  const email = uiEmail(currentUser?.email);
  return COLLAB?.usersByEmail?.[email]?.display_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'User';
};
collabCurrentRole = function() { return currentUser ? uiProfileRole(currentUser.email, USER_INFO.rolesByEmail[uiEmail(currentUser.email)]?.role) : 'user'; };
collabVisibleRole = function(role) { return uiRoleDisplay(role); };

function refreshCurrentIdentityUI() {
  if (!currentUser) return;
  // Issue 2C: prefer custom_username from collab_profiles for the nav display.
  // Falls back to display_name, then Google full_name, then email prefix.
  const myProfile = (COLLAB.usersByEmail && COLLAB.usersByEmail[String(currentUser.email).toLowerCase()]) || null;
  const fullName = collabCurrentName();
  const username =
    (myProfile && myProfile.custom_username && String(myProfile.custom_username).trim())
    || (myProfile && myProfile.display_name && String(myProfile.display_name).trim())
    || fullName
    || (currentUser.email ? currentUser.email.split('@')[0] : 'User');
  const initials = collabInitials(fullName || username);
  // Issue 2E: render profile picture in nav avatar when available.
  const picUrl = (myProfile && myProfile.profile_picture_url) || null;
  const navAvatar = document.getElementById('nav-avatar');
  if (navAvatar) {
    if (picUrl) {
      navAvatar.innerHTML = `<img src="${escAttr(picUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
      navAvatar.classList.add('has-photo');
    } else {
      navAvatar.textContent = initials || '?';
      navAvatar.classList.remove('has-photo');
    }
  }
  safeText('nav-name', username);
  safeText('form-name-display', fullName);
  safeText('bulk-name-display', fullName);
  safeText('admin-current-user', `${fullName} · ${currentUser.email}`);
  // Re-wire click handler in case the avatar/name were re-rendered.
  if (typeof ensureProfileNavButton === 'function') { try { ensureProfileNavButton(); } catch (_e) {} }
}

function mentionBoundary(text, end) { return end >= text.length || /[\s.,!?;:;\)\]\}\n\r]/.test(text[end]); }
function matchMentionAt(text, index, users) {
  if (text[index] !== '@') return null;
  const lower = text.toLowerCase();
  const sorted = [...(users || [])].sort((a,b) => uiMentionLabel(b).length - uiMentionLabel(a).length);
  for (const u of sorted) {
    const label = uiMentionLabel(u);
    if (!label) continue;
    const token = '@' + label;
    if (lower.slice(index, index + token.length) === token.toLowerCase() && mentionBoundary(text, index + token.length)) return { user:u, len:token.length };
  }
  const legacy = text.slice(index).match(/^@([a-zA-Z0-9._-]{2,32})/);
  if (legacy) {
    const u = COLLAB.usersByUsername?.[legacy[1].toLowerCase()];
    if (u) return { user:u, len:legacy[0].length };
  }
  return null;
}

getMentionedUsers = function(text) {
  const found = new Map();
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '@') continue;
    const match = matchMentionAt(source, i, COLLAB.users || []);
    if (match?.user?.email) { found.set(uiEmail(match.user.email), match.user); i += match.len - 1; }
  }
  return [...found.values()];
};

renderMentionedText = function(text) {
  const source = String(text || '');
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '@') {
      const match = matchMentionAt(source, i, COLLAB.users || []);
      if (match?.user) {
        out += `<span class="mention-token" role="link" tabindex="0" onclick="event.stopPropagation();openUserProfileByEmail('${collabAttr(match.user.email)}')">@${collabHtml(uiMentionLabel(match.user))}</span>`;
        i += match.len - 1;
        continue;
      }
    }
    out += collabHtml(source[i]);
  }
  return out;
};

currentMentionQuery = function(textarea) {
  const pos = textarea.selectionStart || 0;
  const before = textarea.value.slice(0, pos);
  const match = before.match(/(^|\s)@([^@\n\r]{0,48})$/);
  if (!match) return null;
  return { query:match[2] || '', start:pos - match[2].length - 1, end:pos };
};

handleMentionInput = async function(evt) {
  const textarea = evt.target;
  if (!textarea || !textarea.value) return closeMentionPopover();
  await loadCollabUsers();
  const info = currentMentionQuery(textarea);
  if (!info) return closeMentionPopover();
  const q = info.query.toLowerCase().trim();
  const users = COLLAB.users.filter(u => {
    return !q || uiMentionLabel(u).toLowerCase().includes(q) || String(u.custom_username || '').toLowerCase().includes(q) || String(u.email || '').toLowerCase().includes(q);
  }).slice(0,8);
  if (!users.length) return closeMentionPopover();
  COLLAB.mentionTarget = { textarea, start:info.start, end:info.end, users };
  COLLAB.mentionIndex = 0;
  renderMentionPopover(users, textarea);
};

renderMentionPopover = function(users, textarea) {
  let pop = document.getElementById('mention-popover');
  if (!pop) { pop = document.createElement('div'); pop.id = 'mention-popover'; pop.className = 'mention-popover'; document.body.appendChild(pop); }
  pop.innerHTML = users.map((u,i) => `<div class="mention-option ${i===COLLAB.mentionIndex?'active':''}" onclick="insertMention(${i})"><div class="mention-option-avatar">${collabHtml(collabInitials(uiMentionLabel(u)))}</div><div><div class="mention-option-name">@${collabHtml(uiMentionLabel(u))}</div><div class="mention-option-sub">${collabHtml(uiRoleDisplay(u.role))}${u.department ? ' · ' + collabHtml(u.department) : ''}</div></div></div>`).join('');
  const rect = textarea.getBoundingClientRect();
  pop.style.left = Math.min(rect.left + 12, window.innerWidth - 290) + 'px';
  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 280) + 'px';
  pop.classList.add('open');
};

insertMention = function(index) {
  const target = COLLAB.mentionTarget;
  if (!target) return;
  const user = target.users[index] || target.users[0];
  const label = uiMentionLabel(user);
  const ta = target.textarea;
  ta.value = ta.value.slice(0, target.start) + '@' + label + ' ' + ta.value.slice(target.end);
  const pos = target.start + label.length + 2;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  closeMentionPopover();
  ta.dispatchEvent(new Event('input', { bubbles:true }));
};

openUserProfileByUsername = function(username) {
  const key = String(username || '').toLowerCase();
  const u = COLLAB.usersByUsername?.[key] || COLLAB.usersByMentionKey?.[key];
  if (u) openUserProfile(u);
};
openUserProfileByEmail = function(email) {
  const e = uiEmail(email);
  const u = COLLAB.usersByEmail?.[e] || USER_INFO.users.find(x => uiEmail(x.email) === e) || { email:e, display_name:e.split('@')[0], role:'user' };
  openUserProfile(u);
};
openUserProfile = function(user) {
  const role = uiProfileRole(user.email, user.role);
  document.getElementById('modal-title').textContent = uiDisplayName(user);
  document.getElementById('modal-meta').innerHTML = `<span class="pill-muted">${collabHtml(uiRoleDisplay(role))}</span>${user.department ? `<span class="pill-muted">${collabHtml(user.department)}</span>` : ''}`;
  document.getElementById('modal-body').innerHTML = `<div class="collab-profile-card"><div class="collab-profile-avatar">${collabHtml(collabInitials(uiDisplayName(user)))}</div><div><div class="detail-label">Full Name</div><div class="detail-value">${collabHtml(uiDisplayName(user))}</div><div class="detail-label" style="margin-top:12px">Email</div><div class="detail-value">${collabHtml(user.email || '')}</div><div class="detail-label" style="margin-top:12px">User ID</div><div class="detail-value td-id">${collabHtml(user.user_id || 'Pending profile sync')}</div>${user.employee_join_date ? `<div class="detail-label" style="margin-top:12px">Employee Join Date</div><div class="detail-value">${fmtDate(user.employee_join_date)}</div>` : ''}${user.performance_score !== undefined && user.performance_score !== null ? `<div class="detail-label" style="margin-top:12px">Performance Score</div><div class="detail-value">${collabHtml(user.performance_score)}</div>` : ''}<div class="detail-label" style="margin-top:12px">Last seen</div><div class="detail-value">${user.last_seen_at ? fmtDateFull(user.last_seen_at) : 'Not available'}</div></div></div>`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
  document.getElementById('modal-overlay').classList.add('open');
};

async function openProfileSettings() {
  if (!currentUser) return;
  await loadCollabUsers(true);
  const me = COLLAB.usersByEmail[uiEmail(currentUser.email)] || { email:currentUser.email, display_name:collabCurrentName(), custom_username:'' };
  document.getElementById('modal-title').textContent = 'Profile settings';
  document.getElementById('modal-meta').innerHTML = '<span class="pill-muted">Full name is the default display</span>';
  document.getElementById('modal-body').innerHTML = `<div class="profile-settings-grid"><div class="form-group full"><label class="form-label">Full Name</label><input class="form-input" id="profile-display-name" value="${escAttr(uiDisplayName(me))}" placeholder="Your full name"><p class="form-hint">This is shown in navigation, comments, chat, and @mentions.</p></div><div class="form-group full"><label class="form-label">Email</label><div class="auto-field"><span class="auto-badge">Auto</span><span>${escHtml(currentUser.email)}</span></div></div><div class="form-group full"><label class="form-label">Custom username (optional)</label><input class="form-input" id="profile-custom-username" value="${escAttr(me.custom_username || '')}" placeholder="Optional custom username"><p class="form-hint">Kept for internal lookup and future settings. Full Name remains the default UI display.</p></div></div>`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveProfileSettings()">Save profile</button>`;
  document.getElementById('modal-overlay').classList.add('open');
}

async function saveProfileSettings() {
  if (!currentUser) return;
  const displayName = (document.getElementById('profile-display-name')?.value || '').trim() || collabCurrentName();
  const customUsernameRaw = (document.getElementById('profile-custom-username')?.value || '').trim();
  const customUsername = customUsernameRaw ? customUsernameRaw.replace(/^@/,'').replace(/[^a-zA-Z0-9._-]/g,'').slice(0,32) : null;
  try {
    const { error } = await sb.from('collab_profiles').upsert({ email:currentUser.email, username:collabUsernameFromEmail(currentUser.email), display_name:displayName, custom_username:customUsername, role:collabCurrentRole(), last_seen_at:new Date().toISOString() }, { onConflict:'email' });
    if (error) throw error;
    await loadCollabUsers(true);
    refreshCurrentIdentityUI();
    closeModal();
    toast('✓ Profile updated', 'success');
  } catch (err) { toast('Could not update profile: ' + (err.message || err), 'error'); }
}

// ============================================================================
// PRODUCTION STABILIZATION PATCH
// - Admin nav label and RBAC guard
// - Multi-page customization preview and bindings
// - Safe profile username updates without collab_profiles role constraint errors
// - Mention dropdown close behavior and full-name identity standard
// ============================================================================
(function productionStabilizationPatch(){
  const CUSTOM_PAGE_OPTIONS = [
    { id:'submit', label:'Submit Question' },
    { id:'allq', label:'All Questions' },
    { id:'review', label:'Review' },
    { id:'faq', label:'Answered' },
    { id:'collab', label:'Team Chat' },
    { id:'admin', label:'Admin pages' },
    { id:'privacy', label:'Privacy' }
  ];
  const CUSTOM_PREVIEW_STATE = { page: localStorage.getItem('customPreviewPage') || 'submit' };

  function prodAssignCustomizerDefaults() {
    if (!CUSTOM_DEFAULTS || !CUSTOM_DEFAULTS.text) return;
    Object.assign(CUSTOM_DEFAULTS.text, {
      collab_title: (!CUSTOM_DEFAULTS.text.collab_title || CUSTOM_DEFAULTS.text.collab_title === 'Collaboration') ? 'Team Chat' : CUSTOM_DEFAULTS.text.collab_title,
      collab_subtitle: CUSTOM_DEFAULTS.text.collab_subtitle || 'Slack-style channels, @mentions, realtime notifications, and lightweight workflow chat powered by Supabase Realtime.',
      collab_channels_title: CUSTOM_DEFAULTS.text.collab_channels_title || 'Channels',
      collab_channels_subtitle: CUSTOM_DEFAULTS.text.collab_channels_subtitle || 'Public/private spaces for workflow updates.',
      collab_placeholder: CUSTOM_DEFAULTS.text.collab_placeholder || 'Message this channel. Use @Full Name to tag a teammate.',
      admin_kicker: CUSTOM_DEFAULTS.text.admin_kicker || 'Admin Only',
      admin_title_accent: CUSTOM_DEFAULTS.text.admin_title_accent || 'Admin',
      admin_title: CUSTOM_DEFAULTS.text.admin_title || 'Control Center',
      admin_subtitle: CUSTOM_DEFAULTS.text.admin_subtitle || 'Central hub for user management, roles, system health, analytics, channels, logs, and admin-level operational controls.',
      admin_user_info_title: CUSTOM_DEFAULTS.text.admin_user_info_title || 'User Info',
      admin_user_info_subtitle: CUSTOM_DEFAULTS.text.admin_user_info_subtitle || 'Admin-only control center for human-readable identities, user metadata, role assignments, and operational shortcuts.',
      privacy_title: CUSTOM_DEFAULTS.text.privacy_title || 'Privacy Policy',
      privacy_subtitle: CUSTOM_DEFAULTS.text.privacy_subtitle || 'How we collect, use, and protect your information',
      notifications_title: CUSTOM_DEFAULTS.text.notifications_title || 'Notifications'
    });
  }
  function prodNormalizeCustomizerSchema() {
    prodAssignCustomizerDefaults();
    try { adminCustomization = deepMerge(CUSTOM_DEFAULTS, adminCustomization || {}); } catch (_err) {}
  }
  prodAssignCustomizerDefaults();

  function forceAdminNavLabel() {
    const adminBtn = document.getElementById('nav-admin');
    if (adminBtn) {
      const badge = adminBtn.querySelector('.nav-badge');
      adminBtn.textContent = 'Admin';
      if (badge) adminBtn.appendChild(badge);
      adminBtn.style.display = isAdmin() ? '' : 'none';
      adminBtn.setAttribute('aria-label', 'Admin');
    }
  }

  updateUserInfoHero = function() {
    const hero = document.querySelector('#page-admin .hero-premium');
    if (!hero) return;
    prodNormalizeCustomizerSchema();
    const text = adminCustomization?.text || CUSTOM_DEFAULTS.text;
    const kicker = hero.querySelector('.hero-kicker');
    const h1 = hero.querySelector('h1');
    const p = hero.querySelector('p');
    if (kicker) kicker.textContent = text.admin_kicker || 'Admin Only';
    if (h1) h1.innerHTML = `<span>${escHtml(text.admin_title_accent || 'Admin')}</span> ${escHtml(text.admin_title || 'Control Center')}`;
    if (p) p.textContent = text.admin_subtitle || CUSTOM_DEFAULTS.text.admin_subtitle;
  };

  const _prodBuildNav = buildNav;
  buildNav = function() {
    _prodBuildNav();
    forceAdminNavLabel();
    const collabBtn = document.getElementById('nav-collab');
    if (collabBtn) collabBtn.textContent = 'Team Chat';
  };

  const _prodShowPage = showPage;
  showPage = function(id) {
    if (id === 'admin' && !isAdmin()) {
      toast('Admin access is protected by role-based access control.', 'error');
      return _prodShowPage(isReviewer() ? 'review' : 'submit');
    }
    _prodShowPage(id);
    forceAdminNavLabel();
    if (id === 'admin' && isAdmin()) setTimeout(updateUserInfoHero, 0);
  };

  const _prodSwitchAdminTab = switchAdminTab;
  switchAdminTab = function(k) {
    if (!isAdmin()) { toast('Admin access is protected by role-based access control.', 'error'); return; }
    _prodSwitchAdminTab(k);
    forceAdminNavLabel();
  };

  const _prodApplyCustomTextBindings = applyCustomTextBindings;
  applyCustomTextBindings = function() {
    prodNormalizeCustomizerSchema();
    _prodApplyCustomTextBindings();
    const text = adminCustomization?.text || CUSTOM_DEFAULTS.text;
    if (text && text.collab_title === 'Collaboration') text.collab_title = 'Team Chat';
    forceAdminNavLabel();
    const setText = (sel, val) => { document.querySelectorAll(sel).forEach(el => { if (el && val != null) el.textContent = val; }); };
    setText('#page-collab .collab-hero h1', text.collab_title);
    setText('#page-collab .collab-hero p', text.collab_subtitle);
    setText('#page-collab .collab-sidebar-title', text.collab_channels_title);
    setText('#page-collab .collab-sidebar-sub', text.collab_channels_subtitle);
    document.querySelectorAll('#collab-message-input').forEach(el => { el.placeholder = text.collab_placeholder || 'Message this channel. Use @Full Name to tag a teammate.'; });
    const panelTitle = document.querySelector('#notification-panel .notification-head strong');
    if (panelTitle) panelTitle.textContent = text.notifications_title || 'Notifications';
    updateUserInfoHero();
    const userInfoHeading = document.querySelector('#admin-pane-user-info h3');
    if (userInfoHeading) userInfoHeading.textContent = text.admin_user_info_title || 'User Info';
    const userInfoSub = document.querySelector('#admin-pane-user-info .admin-card-subtitle');
    if (userInfoSub) userInfoSub.textContent = text.admin_user_info_subtitle || CUSTOM_DEFAULTS.text.admin_user_info_subtitle;
    const privacyTitle = document.querySelector('#page-privacy h1');
    if (privacyTitle) privacyTitle.textContent = text.privacy_title || 'Privacy Policy';
    const privacySub = document.querySelector('#page-privacy h1 + p');
    if (privacySub) privacySub.textContent = text.privacy_subtitle || CUSTOM_DEFAULTS.text.privacy_subtitle;
  };

  customTextPaneHtml = function(){
    return `<div class="alert alert-info"><strong>Multi-page text editor:</strong> These fields are reflected in the live page selector and applied across the app when saved.</div><div class="customizer-grid">${customInput('text.submit_title','Submit page title')}${customInput('text.submit_subtitle','Submit subtitle')}${customInput('text.submit_tab_single','Single tab text')}${customInput('text.submit_tab_bulk','Bulk tab text')}${customInput('text.submit_button','Submit button text')}${customInput('text.submit_clear','Clear button text')}${customInput('text.bill_label','Bill label')}${customInput('text.bill_placeholder','Bill placeholder')}${customInput('text.issue_label','Issue label')}${customInput('text.question_label','Question label')}${customTextarea('text.question_placeholder','Question placeholder')}${customInput('text.allq_title','All Questions title')}${customInput('text.allq_subtitle','All Questions subtitle')}${customInput('text.review_title','Review title')}${customInput('text.review_subtitle','Review subtitle')}${customInput('text.answered_title','Answered title')}${customInput('text.answered_subtitle','Answered subtitle')}${customInput('text.collab_title','Team Chat title')}${customTextarea('text.collab_subtitle','Team Chat subtitle')}${customInput('text.collab_channels_title','Channels sidebar title')}${customInput('text.collab_channels_subtitle','Channels sidebar subtitle')}${customInput('text.collab_placeholder','Chat input placeholder')}${customInput('text.admin_kicker','Admin hero kicker')}${customInput('text.admin_title_accent','Admin hero accent word')}${customInput('text.admin_title','Admin hero title')}${customTextarea('text.admin_subtitle','Admin hero subtitle')}${customInput('text.admin_user_info_title','Admin user table title')}${customTextarea('text.admin_user_info_subtitle','Admin user table subtitle')}${customInput('text.privacy_title','Privacy title')}${customInput('text.privacy_subtitle','Privacy subtitle')}${customInput('text.notifications_title','Notifications panel title')}${customInput('text.footer_text','Footer text')}</div>`;
  };

  customPreviewPaneHtml = function(){
    return `<div class="admin-custom-muted">Select any application page to preview the current draft. The preview reflects text, theme variables, layout toggles, and submit form changes before saving.</div><div class="custom-preview-control-row"><label class="form-label" style="margin:0">Preview page</label><select id="custom-preview-page-select" onchange="customPreviewSelectChanged(this.value)">${CUSTOM_PAGE_OPTIONS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}</select><button class="btn btn-outline btn-sm" onclick="renderCustomizerPreview()">Refresh preview</button></div><div class="customizer-preview"><div id="custom-preview-full"></div></div>`;
  };

  function previewNavHtml(active) {
    const links = ['Submit','All Questions','Review','Answered','Team Chat','Admin','Privacy'];
    return `<div class="custom-preview-nav"><div class="mini-logo"><span>Data Entry</span> Q&A</div><div class="mini-links">${links.map(x => `<span ${x.toLowerCase().startsWith(active) ? 'style="background:rgba(255,255,255,.24)"' : ''}>${escHtml(x)}</span>`).join('')}</div></div>`;
  }
  function previewDevice(inner, active) { return `<div class="custom-preview-device">${previewNavHtml(active)}<div class="custom-preview-page">${inner}</div></div>`; }
  function previewHero(title, subtitle) { return `<div class="custom-preview-hero"><h2>${escHtml(title || '')}</h2><p>${escHtml(subtitle || '')}</p></div>`; }
  function previewTable(rows) { return `<div class="custom-preview-table"><div class="row head"><div>Name / Bill</div><div>Status</div><div>Role</div></div>${rows.map(r => `<div class="row"><div>${r[0]}</div><div>${r[1]}</div><div>${r[2]}</div></div>`).join('')}</div>`; }
  function previewSubmit(text, fields) {
    const extra = fields.map(f => `<div class="${f.full ? 'full' : ''}"><label class="form-label">${escHtml(f.label || 'Custom field')}${f.required ? ' <span class="req">*</span>' : ''}</label>${f.type === 'textarea' ? `<textarea class="form-textarea" placeholder="${escAttr(f.placeholder || '')}"></textarea>` : f.type === 'select' ? `<select class="form-select"><option>${escHtml(String(f.options || '').split('\n').find(Boolean) || 'Option')}</option></select>` : `<input class="form-input" placeholder="${escAttr(f.placeholder || '')}">`}</div>`).join('');
    return previewDevice(`<div class="customizer-preview-card"><div class="customizer-preview-title">${escHtml(text.submit_title || '')}</div><p class="admin-custom-muted">${escHtml(text.submit_subtitle || '')}</p><div class="submit-mode-toggle"><button class="mode-btn active">${escHtml(text.submit_tab_single || '')}</button><button class="mode-btn">${escHtml(text.submit_tab_bulk || '')}</button></div><div class="custom-preview-form-grid" style="margin-top:14px"><div><label class="form-label">Your name</label><div class="auto-field"><span class="auto-badge">Auto</span><span>Manoj Pandey</span></div></div><div><label class="form-label">Your email</label><div class="auto-field"><span class="auto-badge">Auto</span><span>manoj@example.com</span></div></div><div><label class="form-label">${escHtml(text.bill_label || 'Bill ID')} <span class="req">*</span></label><input class="form-input" placeholder="${escAttr(text.bill_placeholder || '')}"></div><div><label class="form-label">${escHtml(text.issue_label || 'Issue Field')} <span class="req">*</span></label><select class="form-select"><option>Vendor</option></select></div>${extra}<div class="full"><label class="form-label">${escHtml(text.question_label || 'Question')} <span class="req">*</span></label><textarea class="form-textarea" placeholder="${escAttr(text.question_placeholder || '')}"></textarea></div></div><button class="btn btn-primary" style="margin-top:14px">${escHtml(text.submit_button || 'Submit')}</button></div>`, 'submit');
  }
  function previewAllQuestions(text) {
    return previewDevice(`${previewHero(text.allq_title, text.allq_subtitle)}<div class="filters-row"><input class="filter-search" placeholder="Search Bill ID, name, question..."><select><option>All statuses</option></select><span class="result-count">42 questions</span></div>${previewTable([['Bill-1042 / Manoj Pandey','Open','User'],['Bill-1043 / Asha Rana','Answered','Reviewer'],['Bill-1044 / Reviewer Admin','In Review','Admin']])}`, 'all');
  }
  function previewReview(text, layout) {
    const stats = layout.reviewStats === false ? '' : `<div class="custom-preview-card-grid"><div class="custom-preview-mini-card"><strong>18</strong><span>Active questions</span></div><div class="custom-preview-mini-card"><strong>5</strong><span>Due today</span></div><div class="custom-preview-mini-card"><strong>2</strong><span>Overdue</span></div></div>`;
    const alert = layout.reviewerAlert === false ? '' : '<div class="alert alert-warn">Questions are waiting for your answer.</div>';
    return previewDevice(`<div class="customizer-preview-title">${escHtml(text.review_title || '')}</div><p class="admin-custom-muted">${escHtml(text.review_subtitle || '')}</p>${alert}${stats}${previewTable([['Bill-2201 / @Manoj Pandey','Open','Reviewer'],['Bill-2202 / @Asha Rana','Answered','Reviewer']])}`, 'review');
  }
  function previewAnswered(text) { return previewDevice(`${previewHero(text.answered_title, text.answered_subtitle)}<div class="faq-search-wrap"><input class="faq-search" placeholder="Search answered questions..."></div><div class="faq-card"><div class="faq-question">How should Vendor mismatch be handled?</div><div class="faq-answer-preview open">Use the latest verified vendor record and mention <span class="mention-token">@Manoj Pandey</span> for review if unclear.</div></div>`, 'answered'); }
  function previewCollab(text) { return previewDevice(`${previewHero(text.collab_title, text.collab_subtitle)}<div class="custom-preview-chat"><div class="custom-preview-sidebar"><strong>${escHtml(text.collab_channels_title || 'Channels')}</strong><p class="admin-custom-muted">${escHtml(text.collab_channels_subtitle || '')}</p><div class="custom-preview-channel active"># reviewer-updates</div><div class="custom-preview-channel"># vendor-questions</div></div><div class="custom-preview-chat-main"><div class="collab-channel-name">reviewer-updates</div><div class="custom-preview-bubble"><strong>Manoj Pandey</strong><br>Can <span class="mention-token">@Asha Rana</span> review this bill?</div><textarea class="form-textarea" placeholder="${escAttr(text.collab_placeholder || '')}"></textarea></div></div>`, 'collaboration'); }
  function previewAdmin(text, layout) {
    const metrics = layout.adminMetrics === false ? '' : `<div class="custom-preview-card-grid"><div class="custom-preview-mini-card"><strong>124</strong><span>Total users</span></div><div class="custom-preview-mini-card"><strong>3</strong><span>Admin accounts</span></div><div class="custom-preview-mini-card"><strong>8</strong><span>Reviewers</span></div></div>`;
    return previewDevice(`${previewHero((text.admin_title_accent || 'Admin') + ' ' + (text.admin_title || 'Control Center'), text.admin_subtitle)}${metrics}<div class="customizer-preview-card"><h3>${escHtml(text.admin_user_info_title || 'User Info')}</h3><p class="admin-custom-muted">${escHtml(text.admin_user_info_subtitle || '')}</p>${previewTable([['Manoj Pandey','manoj@example.com','Primary Admin'],['Asha Rana','asha@example.com','Reviewer'],['Sam Lee','sam@example.com','User']])}</div>`, 'admin');
  }
  function previewPrivacy(text) { return previewDevice(`${previewHero(text.privacy_title, text.privacy_subtitle)}<div class="customizer-preview-card"><h3>1. Introduction</h3><p class="admin-custom-muted">This internal tool stores profile, question, answer, team chat, and role information securely.</p></div>`, 'privacy'); }

  window.customPreviewSelectChanged = function(page) {
    CUSTOM_PREVIEW_STATE.page = page || 'submit';
    localStorage.setItem('customPreviewPage', CUSTOM_PREVIEW_STATE.page);
    renderCustomizerPreview();
  };

  renderCustomizerPreview = function() {
    prodNormalizeCustomizerSchema();
    const text = adminCustomization.text || CUSTOM_DEFAULTS.text;
    const layout = adminCustomization.layout || CUSTOM_DEFAULTS.layout;
    const fields = ((adminCustomization.form || {}).extraFields || []).filter(f => f.enabled !== false);
    const page = CUSTOM_PREVIEW_STATE.page || 'submit';
    const previewMap = {
      submit: () => previewSubmit(text, fields),
      allq: () => previewAllQuestions(text),
      review: () => previewReview(text, layout),
      faq: () => previewAnswered(text),
      collab: () => previewCollab(text),
      admin: () => previewAdmin(text, layout),
      privacy: () => previewPrivacy(text)
    };
    const html = (previewMap[page] || previewMap.submit)();
    const side = document.getElementById('customizer-live-preview');
    if (side) side.innerHTML = html;
    const full = document.getElementById('custom-preview-full');
    if (full) full.innerHTML = html;
    const select = document.getElementById('custom-preview-page-select');
    if (select) select.value = page;
  };

  const _prodLoadCustomization = loadAdminCustomizationSettings;
  loadAdminCustomizationSettings = async function(force = false) {
    const result = await _prodLoadCustomization(force);
    prodNormalizeCustomizerSchema();
    return result;
  };

  const _prodPopulateCustomizationUI = populateCustomizationUI;
  populateCustomizationUI = function() {
    prodNormalizeCustomizerSchema();
    _prodPopulateCustomizationUI();
    const select = document.getElementById('custom-preview-page-select');
    if (select) select.value = CUSTOM_PREVIEW_STATE.page || 'submit';
    renderCustomizerPreview();
  };

  function safeProfileRoleForConstraint(role) {
    const r = uiNormalizeRole(role);
    if (uiIsAdminRole(r)) return 'admin';
    if (uiIsReviewerRole(r)) return 'reviewer';
    return 'staff';
  }

  upsertCollabProfile = async function() {
    if (!currentUser) return;
    let existing = null;
    try {
      const { data } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').eq('email', currentUser.email).maybeSingle();
      existing = data || null;
    } catch (_err) {}
    const appRole = uiProfileRole(currentUser.email, existing?.role || collabCurrentRole());
    const profile = {
      email: currentUser.email,
      username: existing?.username || collabUsernameFromEmail(currentUser.email),
      display_name: existing?.display_name || currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
      role: safeProfileRoleForConstraint(appRole),
      avatar_url: currentUser.user_metadata?.avatar_url || existing?.avatar_url || null,
      last_seen_at: new Date().toISOString()
    };
    try {
      const { error } = await sb.from('collab_profiles').upsert(profile, { onConflict:'email' });
      collabOpenError('profile upsert', error);
    } catch (err) { collabOpenError('profile upsert', err); }
    await loadCollabUsers(true);
    refreshCurrentIdentityUI();
  };

  saveProfileSettings = async function() {
    if (!currentUser) return;
    const displayName = (document.getElementById('profile-display-name')?.value || '').trim() || collabCurrentName();
    const customUsernameRaw = (document.getElementById('profile-custom-username')?.value || '').trim();
    const customUsername = customUsernameRaw ? customUsernameRaw.replace(/^@/,'').replace(/[^a-zA-Z0-9._-]/g,'').slice(0,32) : null;
    const email = currentUser.email;
    try {
      const { data: existing } = await sb.from('collab_profiles').select('email,role,username').eq('email', email).maybeSingle();
      const payload = {
        email,
        username: existing?.username || collabUsernameFromEmail(email),
        display_name: displayName,
        custom_username: customUsername,
        last_seen_at: new Date().toISOString()
      };
      if (!existing) payload.role = 'staff';
      const { error } = await sb.from('collab_profiles').upsert(payload, { onConflict:'email' });
      if (error) throw error;
      await loadCollabUsers(true);
      refreshCurrentIdentityUI();
      closeModal();
      toast('Profile updated.', 'success');
    } catch (err) { toast('Could not update profile: ' + (err.message || err), 'error'); }
  };

  saveUserInfoRow = async function(email) {
    if (!isAdmin()) return;
    const e = uiEmail(email);
    const existing = USER_INFO.users.find(u => uiEmail(u.email) === e) || { email:e };
    const role = uiNormalizeRole(document.getElementById(`ui-role-${e}`)?.value || existing.role || 'user');
    const join = document.getElementById(`ui-join-${e}`)?.value || null;
    const score = uiNumberValue(document.getElementById(`ui-score-${e}`)?.value);
    const profilePayload = {
      email:e,
      display_name: uiDisplayName(existing),
      role: safeProfileRoleForConstraint(role),
      employee_join_date: join || null,
      performance_score: score,
      updated_at: new Date().toISOString()
    };
    try {
      const { error } = await sb.from('collab_profiles').upsert(profilePayload, { onConflict:'email' });
      if (error) throw error;
      const { error: roleErr } = await sb.from('app_user_roles').upsert({ email:e, role, assigned_by: currentUser.email, updated_at:new Date().toISOString() }, { onConflict:'email' });
      if (roleErr) throw roleErr;
      await logUserInfoActivity('USER_ROLE_UPDATED', e, { role, employee_join_date: join || null, performance_score: score });
      toast('User info updated.', 'success');
      await loadUserInfoDashboard(true);
      await loadCollabUsers(true);
    } catch (err) { toast('Could not update user: ' + (err.message || err), 'error'); }
  };

  applyUserInfoImport = async function() {
    if (!isAdmin()) return;
    const rows = USER_INFO.pendingImportRows || [];
    if (!rows.length) return;
    const profiles = rows.map(r => {
      const payload = { email:r.email, display_name:r.display_name, role:safeProfileRoleForConstraint(r.role), employee_join_date:r.employee_join_date, performance_score:r.performance_score, updated_at:new Date().toISOString() };
      if (r.user_id) payload.user_id = r.user_id;
      return payload;
    });
    const roles = rows.map(r => ({ email:r.email, role:uiNormalizeRole(r.role), assigned_by:currentUser.email, updated_at:new Date().toISOString() }));
    try {
      const { error } = await sb.from('collab_profiles').upsert(profiles, { onConflict:'email' });
      if (error) throw error;
      const { error: roleErr } = await sb.from('app_user_roles').upsert(roles, { onConflict:'email' });
      if (roleErr) throw roleErr;
      await logUserInfoActivity('USER_EXCEL_IMPORT_APPLIED', 'bulk', { rows: rows.length });
      toast(`${rows.length} user row${rows.length !== 1 ? 's' : ''} updated.`, 'success');
      clearUserInfoImport();
      await loadUserInfoDashboard(true);
      await loadCollabUsers(true);
    } catch (err) { toast('Import failed: ' + (err.message || err), 'error'); }
  };

  function hardCloseMentionPopover() {
    const pop = document.getElementById('mention-popover');
    if (pop) {
      pop.classList.remove('open');
      pop.style.display = 'none';
      pop.style.left = '-9999px';
      pop.style.top = '-9999px';
      pop.innerHTML = '';
    }
    if (typeof COLLAB !== 'undefined') COLLAB.mentionTarget = null;
  }
  closeMentionPopover = function() { hardCloseMentionPopover(); };

  const _prodRenderMentionPopover = renderMentionPopover;
  renderMentionPopover = function(users, textarea) {
    const pop = document.getElementById('mention-popover');
    if (pop) pop.style.display = '';
    _prodRenderMentionPopover(users, textarea);
  };

  const _prodHandleMentionInput = handleMentionInput;
  handleMentionInput = async function(evt) {
    if (COLLAB.mentionSuppressUntil && Date.now() < COLLAB.mentionSuppressUntil) { hardCloseMentionPopover(); return; }
    await _prodHandleMentionInput(evt);
  };

  insertMention = function(index) {
    const target = COLLAB.mentionTarget;
    if (!target) return;
    const user = target.users[index] || target.users[0];
    const label = uiMentionLabel(user);
    const ta = target.textarea;
    COLLAB.mentionSuppressUntil = Date.now() + 300;
    ta.value = ta.value.slice(0, target.start) + '@' + label + ' ' + ta.value.slice(target.end);
    const pos = target.start + label.length + 2;
    hardCloseMentionPopover();
    ta.focus();
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles:true }));
    setTimeout(hardCloseMentionPopover, 0);
    setTimeout(hardCloseMentionPopover, 120);
  };

  const _prodHandleMentionKeydown = handleMentionKeydown;
  handleMentionKeydown = function(evt) {
    if (evt.key === 'Escape') { hardCloseMentionPopover(); return; }
    _prodHandleMentionKeydown(evt);
  };

  document.addEventListener('mousedown', event => {
    const pop = document.getElementById('mention-popover');
    if (!pop || !pop.classList.contains('open')) return;
    const target = event.target;
    if (pop.contains(target)) return;
    if (target && (target.id === 'collab-message-input' || target.classList?.contains('comment-textarea'))) return;
    hardCloseMentionPopover();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hardCloseMentionPopover(); }, true);
  window.addEventListener('scroll', hardCloseMentionPopover, true);
  window.addEventListener('resize', hardCloseMentionPopover);

  async function upsertCollabProfileSafe(payload) {
    const base = { ...(payload || {}) };
    const roles = [];
    if (base.role) roles.push(base.role);
    const normalized = uiNormalizeRole(base.role || 'user');
    if (uiIsAdminRole(normalized)) roles.push('admin');
    else if (uiIsReviewerRole(normalized)) roles.push('reviewer');
    roles.push('staff', 'user');
    const candidates = [];
    [...new Set(roles.filter(Boolean))].forEach(role => candidates.push({ ...base, role }));
    const withoutRole = { ...base };
    delete withoutRole.role;
    candidates.push(withoutRole);
    let lastError = null;
    for (const candidate of candidates) {
      const { error } = await sb.from('collab_profiles').upsert(candidate, { onConflict:'email' });
      if (!error) return candidate;
      lastError = error;
    }
    throw lastError || new Error('Profile update failed');
  }

  upsertCollabProfile = async function() {
    if (!currentUser) return;
    let existing = null;
    try {
      const { data } = await sb.from('collab_profiles').select('email,display_name,custom_username,username,profile_picture_url,role,status,created_at,updated_at').eq('email', currentUser.email).maybeSingle();
      existing = data || null;
    } catch (_err) {}
    const appRole = uiProfileRole(currentUser.email, existing?.role || collabCurrentRole());
    const profile = {
      email: currentUser.email,
      username: existing?.username || collabUsernameFromEmail(currentUser.email),
      display_name: existing?.display_name || currentUser.user_metadata?.full_name || currentUser.email.split('@')[0],
      role: safeProfileRoleForConstraint(appRole),
      avatar_url: currentUser.user_metadata?.avatar_url || existing?.avatar_url || null,
      last_seen_at: new Date().toISOString()
    };
    try { await upsertCollabProfileSafe(profile); }
    catch (err) { collabOpenError('profile upsert', err); }
    await loadCollabUsers(true);
    refreshCurrentIdentityUI();
  };

  saveProfileSettings = async function() {
    if (!currentUser) return;
    const displayName = (document.getElementById('profile-display-name')?.value || '').trim() || collabCurrentName();
    const customUsernameRaw = (document.getElementById('profile-custom-username')?.value || '').trim();
    const customUsername = customUsernameRaw ? customUsernameRaw.replace(/^@/,'').replace(/[^a-zA-Z0-9._-]/g,'').slice(0,32) : null;
    const email = currentUser.email;
    try {
      const { data: existing } = await sb.from('collab_profiles').select('email,role,username').eq('email', email).maybeSingle();
      const payload = {
        email,
        username: existing?.username || collabUsernameFromEmail(email),
        display_name: displayName,
        custom_username: customUsername,
        last_seen_at: new Date().toISOString()
      };
      if (!existing) payload.role = 'staff';
      await upsertCollabProfileSafe(payload);
      await loadCollabUsers(true);
      refreshCurrentIdentityUI();
      closeModal();
      toast('Profile updated.', 'success');
    } catch (err) { toast('Could not update profile: ' + (err.message || err), 'error'); }
  };

  saveUserInfoRow = async function(email) {
    if (!isAdmin()) return;
    const e = uiEmail(email);
    const existing = USER_INFO.users.find(u => uiEmail(u.email) === e) || { email:e };
    const role = uiNormalizeRole(document.getElementById(`ui-role-${e}`)?.value || existing.role || 'user');
    const join = document.getElementById(`ui-join-${e}`)?.value || null;
    const score = uiNumberValue(document.getElementById(`ui-score-${e}`)?.value);
    const profilePayload = {
      email:e,
      display_name: uiDisplayName(existing),
      role: safeProfileRoleForConstraint(role),
      employee_join_date: join || null,
      performance_score: score,
      updated_at: new Date().toISOString()
    };
    try {
      await upsertCollabProfileSafe(profilePayload);
      const { error: roleErr } = await sb.from('app_user_roles').upsert({ email:e, role, assigned_by: currentUser.email, updated_at:new Date().toISOString() }, { onConflict:'email' });
      if (roleErr) throw roleErr;
      await logUserInfoActivity('USER_ROLE_UPDATED', e, { role, employee_join_date: join || null, performance_score: score });
      toast('User info updated.', 'success');
      await loadUserInfoDashboard(true);
      await loadCollabUsers(true);
    } catch (err) { toast('Could not update user: ' + (err.message || err), 'error'); }
  };

  applyUserInfoImport = async function() {
    if (!isAdmin()) return;
    const rows = USER_INFO.pendingImportRows || [];
    if (!rows.length) return;
    const roles = rows.map(r => ({ email:r.email, role:uiNormalizeRole(r.role), assigned_by:currentUser.email, updated_at:new Date().toISOString() }));
    try {
      for (const r of rows) {
        const payload = { email:r.email, display_name:r.display_name, role:safeProfileRoleForConstraint(r.role), employee_join_date:r.employee_join_date, performance_score:r.performance_score, updated_at:new Date().toISOString() };
        if (r.user_id) payload.user_id = r.user_id;
        await upsertCollabProfileSafe(payload);
      }
      const { error: roleErr } = await sb.from('app_user_roles').upsert(roles, { onConflict:'email' });
      if (roleErr) throw roleErr;
      await logUserInfoActivity('USER_EXCEL_IMPORT_APPLIED', 'bulk', { rows: rows.length });
      toast(`${rows.length} user row${rows.length !== 1 ? 's' : ''} updated.`, 'success');
      clearUserInfoImport();
      await loadUserInfoDashboard(true);
      await loadCollabUsers(true);
    } catch (err) { toast('Import failed: ' + (err.message || err), 'error'); }
  };

  // Keep the final identity standard visible after dynamic renders.
  const _prodOpenUserProfile = openUserProfile;
  openUserProfile = function(user) {
    const fixed = { ...(user || {}), display_name: uiDisplayName(user), role: uiProfileRole(user?.email, user?.role) };
    _prodOpenUserProfile(fixed);
    const meta = document.getElementById('modal-meta');
    if (meta && fixed.email) meta.innerHTML = `<span class="pill-muted">${collabHtml(uiRoleDisplay(fixed.role))}</span>`;
  };

  // Apply full-name mention rendering to answered FAQ cards and reviewer text areas.
  const _prodRenderFaq = renderFaq;
  renderFaq = function() {
    _prodRenderFaq();
    try {
      document.querySelectorAll('.faq-card[data-question-id]').forEach(card => {
        const q = (faqQuestions || []).find(item => String(item.id) === String(card.dataset.questionId));
        if (!q) return;
        const answer = card.querySelector('.faq-answer-preview');
        if (answer) answer.innerHTML = renderMentionedText(q.answer || '');
        const question = card.querySelector('.faq-question');
        if (question) question.innerHTML = renderMentionedText(q.question || '');
      });
    } catch (_err) {}
  };

  document.addEventListener('focusin', event => {
    const el = event.target;
    if (!el || el.tagName !== 'TEXTAREA') return;
    if (el.id === 'm-answer' || el.id === 'm-remarks' || el.classList?.contains('comment-textarea') || el.id === 'collab-message-input') setupMentionAutocomplete(el);
  }, true);

  forceAdminNavLabel();
})();

// ADMIN ACCESS PATCH: explicit UI to add/remove additional admins from Admin > User Info.
(function() {
  function adminAccessPrimaryEmail() {
    return typeof V2_ADMIN_EMAIL !== 'undefined' ? uiEmail(V2_ADMIN_EMAIL) : 'hillstribeco@gmail.com';
  }

  function adminAccessHtml() {
    return `
      <div class="admin-custom-card" id="admin-access-card">
        <div class="admin-section-title">
          <div>
            <h3>🔐 Admin Access</h3>
            <p class="admin-custom-muted">Add one or two additional Admin accounts. Admins can open this Admin area, manage users/reviewers, and use Team Chat admin tools.</p>
          </div>
          <button class="btn btn-outline btn-sm" onclick="renderAdminAccessList()">↻ Refresh admins</button>
        </div>
        <div class="inline-form-row" style="margin-bottom:14px">
          <div class="form-group">
            <label class="form-label">Admin email 1</label>
            <input type="email" class="form-input" id="admin-add-email-1" placeholder="admin1@domain.com">
          </div>
          <div class="form-group">
            <label class="form-label">Admin email 2</label>
            <input type="email" class="form-input" id="admin-add-email-2" placeholder="admin2@domain.com">
          </div>
          <button class="btn btn-primary" onclick="addAdditionalAdmins()">Add Admin(s)</button>
        </div>
        <ul class="admin-list-v2" id="admin-access-list">
          <li style="justify-content:center;color:var(--text3)">Loading admins...</li>
        </ul>
      </div>`;
  }

  const _adminAccessUserInfoHtml = userInfoHtml;
  userInfoHtml = function() {
    const html = _adminAccessUserInfoHtml();
    if (html.includes('id="admin-access-card"')) return html;
    if (html.includes('<div class="user-info-dropzone"')) {
      return html.replace('<div class="user-info-dropzone"', adminAccessHtml() + '\n      <div class="user-info-dropzone"');
    }
    return html.replace('</section>', adminAccessHtml() + '\n    </section>');
  };

  function getAdminRoleRows() {
    const rows = Object.values((USER_INFO && USER_INFO.rolesByEmail) || {})
      .filter(row => row && row.email && uiIsAdminRole(row.role))
      .map(row => ({ email: uiEmail(row.email), role: uiNormalizeRole(row.role) }));
    const primary = adminAccessPrimaryEmail();
    if (!rows.some(row => row.email === primary)) rows.push({ email: primary, role: 'primary_admin' });
    return rows.sort((a, b) => uiRoleRank(b.role) - uiRoleRank(a.role) || a.email.localeCompare(b.email));
  }

  window.renderAdminAccessList = function() {
    const list = document.getElementById('admin-access-list');
    if (!list) return;
    const primary = adminAccessPrimaryEmail();
    const rows = getAdminRoleRows();
    if (!rows.length) {
      list.innerHTML = '<li style="justify-content:center;color:var(--text3)">No admins found</li>';
      return;
    }
    list.innerHTML = rows.map(row => {
      const email = uiEmail(row.email);
      const locked = email === primary || uiNormalizeRole(row.role) === 'primary_admin';
      const action = locked
        ? '<span class="pill-muted">Primary Admin</span>'
        : `<button class="btn-remove-reviewer" onclick="removeAdditionalAdmin('${escAttr(email)}')">Remove Admin</button>`;
      return `<li><div><div style="font-weight:700">${escHtml(email)}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${escHtml(uiRoleDisplay(row.role))}</div></div>${action}</li>`;
    }).join('');
  };

  async function upsertAdminProfile(email) {
    const e = uiEmail(email);
    const payload = {
      email: e,
      username: typeof collabUsernameFromEmail === 'function' ? collabUsernameFromEmail(e) : e.split('@')[0],
      display_name: e.split('@')[0],
      role: 'admin',
      updated_at: new Date().toISOString()
    };
    try {
      const { data } = await sb.from('collab_profiles').select('display_name,username,email').eq('email', e).maybeSingle();
      if (data) {
        payload.display_name = data.display_name || payload.display_name;
        payload.username = data.username || payload.username;
      }
    } catch (_err) {}
    try { await sb.from('collab_profiles').upsert(payload, { onConflict: 'email' }); } catch (_err) {}
  }

  window.addAdditionalAdmins = async function() {
    if (!isAdmin()) return;
    const inputs = ['admin-add-email-1', 'admin-add-email-2']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    const emails = [...new Set(inputs.map(input => uiEmail(input.value)).filter(Boolean))];
    if (!emails.length) { toast('Enter at least one admin email.', 'error'); return; }
    const invalid = emails.find(email => !email.includes('@'));
    if (invalid) { toast('Invalid email format: ' + invalid, 'error'); return; }

    try {
      const rows = emails.map(email => ({ email, role: 'admin', assigned_by: currentUser.email, updated_at: new Date().toISOString() }));
      const { error } = await sb.from('app_user_roles').upsert(rows, { onConflict: 'email' });
      if (error) throw error;
      for (const email of emails) await upsertAdminProfile(email);
      await logUserInfoActivity('ADMINS_ADDED', emails.join(','), { role: 'admin', emails });
      inputs.forEach(input => { input.value = ''; });
      await loadAllowedReviewers();
      await loadUserInfoDashboard(true);
      renderAdminAccessList();
      if (typeof loadCollabUsers === 'function') await loadCollabUsers(true);
      toast(`✓ ${emails.length} Admin${emails.length !== 1 ? 's' : ''} added`, 'success');
    } catch (err) {
      toast('Could not add admin access: ' + (err.message || err), 'error');
    }
  };

  window.removeAdditionalAdmin = async function(email) {
    if (!isAdmin()) return;
    const e = uiEmail(email);
    const primary = adminAccessPrimaryEmail();
    if (!e || e === primary) { toast('Primary Admin cannot be removed here.', 'error'); return; }
    if (!confirm(`Remove Admin access for ${e}?`)) return;
    try {
      const { error } = await sb.from('app_user_roles').upsert({ email: e, role: 'user', assigned_by: currentUser.email, updated_at: new Date().toISOString() }, { onConflict: 'email' });
      if (error) throw error;
      try { await sb.from('collab_profiles').update({ role: 'staff', updated_at: new Date().toISOString() }).eq('email', e); } catch (_err) {}
      await logUserInfoActivity('ADMIN_REMOVED', e, { role: 'user' });
      await loadAllowedReviewers();
      await loadUserInfoDashboard(true);
      renderAdminAccessList();
      if (typeof loadCollabUsers === 'function') await loadCollabUsers(true);
      toast('✓ Admin access removed', 'success');
    } catch (err) {
      toast('Could not remove admin access: ' + (err.message || err), 'error');
    }
  };

  const _adminAccessLoadUserInfoDashboard = loadUserInfoDashboard;
  loadUserInfoDashboard = async function(force = false) {
    await _adminAccessLoadUserInfoDashboard(force);
    renderAdminAccessList();
  };

  const _adminAccessSwitchAdminTab = switchAdminTab;
  switchAdminTab = function(k) {
    _adminAccessSwitchAdminTab(k);
    if (k === 'user-info') setTimeout(renderAdminAccessList, 0);
  };
})();

// ══════════════════════════════════════
// STICKY NAV, STABLE TEAM CHAT REFRESH, ATTACHMENTS + RICH REACTIONS
// Added as a late override so it patches the existing single-file app without creating a preview app.
// ══════════════════════════════════════
(function(){
  const ATTACHMENT_BUCKET = 'qna-attachments';
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const RICH_REACTION_EMOJIS = ['👍','✅','🎉','❤️','🙏','🙌','👏','🔥','💯','⭐','🚀','👀','🤔','😄','😂','😮','😢','😡','⚠️','❗','📌','📝','💡','🧠','🏆','✨','🔍','📎','📄','🖼️','🎯','⏳'];
  const DEFAULT_REACTIONS = ['👍','✅','👀'];
  const LS_REACTIONS_KEY = 'dataEntryQnaLocalReactionsV2';
  const ATTACHMENT_STATE = new Map();
  let activeEmojiPickerSource = null;

  function safeJsonParse(v, fallback) { try { return JSON.parse(v || ''); } catch (_err) { return fallback; } }
  function currentReactionUser() { return (currentUser && currentUser.email) || 'local-user'; }
  function reactionStore() { return safeJsonParse(localStorage.getItem(LS_REACTIONS_KEY), {}); }
  function saveReactionStore(store) { localStorage.setItem(LS_REACTIONS_KEY, JSON.stringify(store || {})); }
  function reactionKey(targetType, targetId) { return `${targetType}:${targetId}`; }
  function cleanAttachmentName(name) { return String(name || 'attachment').replace(/[\[\]\(\)\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'attachment'; }
  function activePageId() { return document.querySelector('.page.active')?.id || ''; }
  function isCommunicationTextarea(textarea) {
    if (!textarea || textarea.tagName !== 'TEXTAREA') return false;
    const id = textarea.id || '';
    return id === 'f-question'
      || id === 'm-answer'
      || id === 'collab-message-input'
      || id === 'collab-announcement-text'
      || id.startsWith('br-q-')
      || textarea.classList?.contains('comment-textarea')
      || textarea.classList?.contains('collab-edit-area');
  }
  function closestTextareaFromEventTarget(target) {
    if (!target) return null;
    if (target.tagName === 'TEXTAREA' && isCommunicationTextarea(target)) return target;
    const comment = target.closest?.('.comment-form,.collab-reply-form');
    if (comment) {
      const ta = comment.querySelector('textarea');
      if (isCommunicationTextarea(ta)) return ta;
    }
    if (target.closest?.('#page-collab')) return document.getElementById('collab-message-input');
    if (target.closest?.('#modal-overlay')) return document.getElementById('m-answer') || [...document.querySelectorAll('#modal-body textarea')].find(isCommunicationTextarea) || null;
    if (target.closest?.('#page-submit')) {
      const active = document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement : null;
      return isCommunicationTextarea(active) ? active : document.getElementById('f-question');
    }
    const active = document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement : null;
    return isCommunicationTextarea(active) ? active : null;
  }
  function targetTextarea(targetId) {
    const textarea = targetId && typeof targetId === 'string' ? document.getElementById(targetId) : (document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement : null);
    return isCommunicationTextarea(textarea) ? textarea : null;
  }
  function insertIntoTextarea(textarea, text) {
    if (!textarea || !text) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const prefix = textarea.value && start > 0 && !textarea.value.slice(0,start).endsWith('\n') ? '\n' : '';
    const suffix = textarea.value.slice(end).startsWith('\n') ? '' : '\n';
    textarea.value = textarea.value.slice(0,start) + prefix + text + suffix + textarea.value.slice(end);
    const pos = start + prefix.length + text.length + suffix.length;
    textarea.focus();
    try { textarea.setSelectionRange(pos, pos); } catch (_err) {}
    textarea.dispatchEvent(new Event('input', { bubbles:true }));
  }
  function safeStorageFileName(name) {
    const cleaned = String(name || 'attachment')
      .normalize('NFKD')
      .replace(/[\/]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100);
    return cleaned || 'attachment';
  }
  function attachmentOwnerFolder() {
    if (!currentUser?.id) throw new Error('Please sign in again before uploading attachments.');
    return String(currentUser.id).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  }
  async function uploadAttachmentFile(file) {
    if (!sb?.storage?.from) throw new Error('Supabase Storage is not available.');
    const owner = attachmentOwnerFolder();
    const dateFolder = new Date().toISOString().slice(0, 10);
    const randomId = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
    const path = `${owner}/${dateFolder}/${randomId}-${safeStorageFileName(file.name)}`;
    const bucket = sb.storage.from(ATTACHMENT_BUCKET);
    const { error } = await bucket.upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false
    });
    if (error) throw error;
    const { data } = bucket.getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('No public URL returned for the uploaded file.');
    return { path, url: data.publicUrl };
  }
  function ensureAttachmentId(textarea) {
    if (!textarea) return '';
    if (!textarea.id) textarea.id = `comm-textarea-${Math.random().toString(36).slice(2)}`;
    return textarea.id;
  }
  function fileKind(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(name)) return 'image';
    if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
    if (/\.(doc|docx|rtf|odt)$/.test(name)) return 'doc';
    if (/\.(xls|xlsx|csv)$/.test(name)) return 'sheet';
    if (/\.(zip|rar|7z)$/.test(name)) return 'archive';
    return 'file';
  }
  function fileIcon(kind) {
    return kind === 'image' ? '🖼️' : kind === 'pdf' ? '📄' : kind === 'doc' ? '📝' : kind === 'sheet' ? '📊' : kind === 'archive' ? '🗜️' : '📎';
  }
  function ensureAttachmentPreview(textarea) {
    if (!textarea) return null;
    const id = ensureAttachmentId(textarea);
    let strip = document.getElementById(`attachment-preview-${id}`);
    if (!strip) {
      strip = document.createElement('div');
      strip.id = `attachment-preview-${id}`;
      strip.className = 'attachment-preview-strip';
      const toolbar = textarea.nextElementSibling?.classList?.contains('communication-toolbar') ? textarea.nextElementSibling : null;
      (toolbar || textarea).insertAdjacentElement(toolbar ? 'afterend' : 'afterend', strip);
    }
    return strip;
  }
  function renderAttachmentPreview(textarea) {
    const id = ensureAttachmentId(textarea);
    const strip = ensureAttachmentPreview(textarea);
    if (!strip) return;
    const items = ATTACHMENT_STATE.get(id) || [];
    strip.classList.toggle('has-items', items.length > 0);
    strip.innerHTML = items.map(item => {
      const thumb = item.kind === 'image'
        ? `<img alt="${collabAttr(item.name)} preview" src="${item.url}">`
        : `<span aria-hidden="true">${fileIcon(item.kind)}</span>`;
      return `<div class="attachment-preview-card" title="${collabAttr(item.name)}"><div class="attachment-preview-thumb">${thumb}</div><button type="button" class="attachment-remove-btn" aria-label="Remove ${collabAttr(item.name)}" onclick="removePendingAttachment('${collabAttr(id)}','${collabAttr(item.id)}')">×</button><div class="attachment-preview-name">${collabHtml(item.name)}</div></div>`;
    }).join('');
  }
  function clearPendingAttachments(textarea) {
    if (!textarea) return;
    const id = ensureAttachmentId(textarea);
    ATTACHMENT_STATE.set(id, []);
    renderAttachmentPreview(textarea);
    updateAttachmentSubmitState(textarea);
  }
  function updateAttachmentSubmitState(textarea) {
    if (!textarea) return;
    const id = ensureAttachmentId(textarea);
    const hasPending = (ATTACHMENT_STATE.get(id) || []).length > 0;
    if (id.startsWith('comment-textarea-')) {
      const key = id.replace(/^comment-textarea-/, '');
      const submit = document.getElementById(`comment-submit-${key}`);
      if (submit) {
        const len = textarea.value.length;
        const trimmedLen = textarea.value.trim().length;
        submit.disabled = hasPending ? false : (trimmedLen < COMMENT_MIN || len > COMMENT_MAX);
      }
    }
    if (id.startsWith('br-q-') && typeof updateBulkReadyCount === 'function') {
      try { updateBulkReadyCount(); } catch (_err) {}
    }
  }
  window.removePendingAttachment = function(textareaId, attachmentId) {
    const rows = (ATTACHMENT_STATE.get(textareaId) || []).filter(item => item.id !== attachmentId);
    ATTACHMENT_STATE.set(textareaId, rows);
    const textarea = document.getElementById(textareaId);
    renderAttachmentPreview(textarea);
    updateAttachmentSubmitState(textarea);
  };
  function flushAttachmentsToTextarea(textarea) {
    if (!textarea) return;
    const id = ensureAttachmentId(textarea);
    const rows = ATTACHMENT_STATE.get(id) || [];
    if (!rows.length) return;
    const markdown = rows.map(item => `[Attachment: ${cleanAttachmentName(item.name)}](${item.url})`).join('\n');
    insertIntoTextarea(textarea, markdown);
    ATTACHMENT_STATE.set(id, []);
    renderAttachmentPreview(textarea);
    updateAttachmentSubmitState(textarea);
  }
  // Issue 1F: Collect attachments for a textarea WITHOUT writing them into the
  // textarea value. Returns the attachment rows and clears the pending state.
  // Used by the Submit Question and Bulk Submit paths so attachments go to the
  // dedicated DB column (questions.attachments) instead of being embedded as
  // markdown tokens inside the question text.
  function takeAttachmentsForTextarea(textarea) {
    if (!textarea) return [];
    const id = ensureAttachmentId(textarea);
    const rows = (ATTACHMENT_STATE.get(id) || []).slice();
    if (!rows.length) return [];
    ATTACHMENT_STATE.set(id, []);
    renderAttachmentPreview(textarea);
    updateAttachmentSubmitState(textarea);
    return rows.map(item => ({
      name: cleanAttachmentName(item.name),
      url: item.url,
      type: item.type || null,
      size: item.size || null
    }));
  }
  window.takeAttachmentsForTextarea = takeAttachmentsForTextarea;
  function flushAllPendingAttachments() {
    document.querySelectorAll('textarea').forEach(ta => flushAttachmentsToTextarea(ta));
  }
  async function processAttachmentFiles(files, targetIdOrTextarea) {
    const textarea = typeof targetIdOrTextarea === 'string' ? targetTextarea(targetIdOrTextarea) : targetIdOrTextarea;
    if (!textarea) { toast('Click inside a message, reply, answer, or question box first.', 'error'); return; }
    const id = ensureAttachmentId(textarea);
    const list = Array.from(files || []).filter(Boolean).slice(0, 8);
    if (!list.length) return;
    const existing = ATTACHMENT_STATE.get(id) || [];
    let uploadedCount = 0;
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast(`${file.name} is too large. Maximum attachment size is 10 MB.`, 'error');
        continue;
      }
      try {
        const uploaded = await uploadAttachmentFile(file);
        existing.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: cleanAttachmentName(file.name),
          url: uploaded.url,
          path: uploaded.path,
          kind: fileKind(file),
          size: file.size,
          type: file.type || ''
        });
        uploadedCount += 1;
      } catch (err) {
        const message = err?.message || String(err || 'Upload failed');
        toast('Could not upload ' + file.name + ': ' + message, 'error');
      }
    }
    ATTACHMENT_STATE.set(id, existing.slice(-12));
    renderAttachmentPreview(textarea);
    updateAttachmentSubmitState(textarea);
    if (uploadedCount) toast(`✓ ${uploadedCount} attachment${uploadedCount !== 1 ? 's' : ''} uploaded and ready to send`, 'success');
  }
  window.openAttachmentPicker = function(targetId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.gif,.webp,.png,.jpg,.jpeg,.heic,.zip';
    input.onchange = () => processAttachmentFiles(input.files, targetId);
    input.click();
  };
  window.addLinkAttachment = function(targetId) {
    const textarea = targetTextarea(targetId);
    if (!textarea) { toast('Click inside a message, reply, answer, or question box first.', 'error'); return; }
    const url = prompt('Paste a link to attach:');
    if (!url) return;
    const cleanUrl = url.trim();
    let href = cleanUrl;
    if (!/^(https?:\/\/|mailto:)/i.test(href)) {
      if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*)?$/i.test(href)) href = `https://${href}`;
      else { toast('Please use a valid web link or mailto link.', 'error'); return; }
    }
    const label = prompt('Optional link label:', cleanUrl) || cleanUrl;
    insertIntoTextarea(textarea, `[Link: ${cleanAttachmentName(label)}](${href})`);
  };
  function isRichSafeUrl(url) {
    const u = String(url || '').trim();
    return /^(https?:\/\/|mailto:|data:image\/|blob:)/i.test(u);
  }
  function isImageAttachment(name, url) {
    const u = String(url || '').trim().toLowerCase();
    const n = String(name || '').trim().toLowerCase();
    if (u.startsWith('data:image/') || u.startsWith('blob:')) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg|heic)(\?|#|$)/i.test(u) || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(n);
  }
  function splitTrailingPunctuation(value) {
    let clean = String(value || '');
    let tail = '';
    while (clean.length > 0 && /[.,;:!?\)\]]$/.test(clean)) {
      tail = clean.slice(-1) + tail;
      clean = clean.slice(0, -1);
    }
    return { clean, tail };
  }
  function renderSafeRichLink(url, label, icon = '🔗') {
    if (!isRichSafeUrl(url)) return collabHtml(label || url || 'link');
    const href = String(url || '').trim();
    const text = String(label || href).replace(/^https?:\/\//i, '').replace(/^mailto:/i, '');
    return `<a class="rich-link-preview" href="${collabAttr(href)}" target="_blank" rel="noopener noreferrer">${icon} ${collabHtml(text)}</a>`;
  }
  function renderAttachmentToken(kind, name, url) {
    const cleanName = cleanAttachmentName(name || 'attachment');
    const cleanUrl = String(url || '').trim();
    if (!isRichSafeUrl(cleanUrl)) return collabHtml(`[${kind}: ${cleanName}](${cleanUrl})`);
    if (isImageAttachment(cleanName, cleanUrl)) {
      return `<a class="rich-image-attachment" href="${collabAttr(cleanUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${collabAttr(cleanName)}"><img src="${collabAttr(cleanUrl)}" alt="${collabAttr(cleanName)}" loading="lazy"><span class="rich-attachment-caption">${collabHtml(cleanName)}</span></a>`;
    }
    return `<a class="rich-attachment-link" href="${collabAttr(cleanUrl)}" target="_blank" rel="noopener noreferrer">${kind === 'Link' ? '🔗' : '📎'} ${collabHtml(cleanName)}</a>`;
  }
  function looksLikePlainFileName(token) {
    // Prevent bare file names such as "Screenshot 2025-08-31 110438.png" from
    // being treated as web domains. Real uploads are rendered from the
    // [Attachment: name](url) token that includes a Storage URL.
    const clean = String(token || '').split(/[?#]/)[0].toLowerCase();
    const ext = clean.includes('.') ? clean.split('.').pop() : '';
    return ['png','jpg','jpeg','gif','webp','bmp','svg','heic','pdf','doc','docx','xls','xlsx','csv','txt','zip','rar','7z','mp4','mov','webm','mp3','wav'].includes(ext);
  }
  function renderPlainRichTextSegment(segment) {
    const text = String(segment || '');
    const tokenRe = /(data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+|blob:[^\s<>"']+|https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?|@([a-zA-Z0-9._-]{2,32}))/gi;
    let out = '';
    let last = 0;
    let match;
    tokenRe.lastIndex = 0;
    while ((match = tokenRe.exec(text)) !== null) {
      out += collabHtml(text.slice(last, match.index));
      const token = match[0];
      const before = text[match.index - 1] || '';
      if (token.startsWith('@')) {
        const name = token.slice(1);
        out += `<span class="mention-token" onclick="event.stopPropagation();openUserProfileByUsername('${collabAttr(name.toLowerCase())}')">@${collabHtml(name)}</span>`;
      } else if (/^(data:image\/|blob:)/i.test(token)) {
        out += renderAttachmentToken('Attachment', 'Image attachment', token);
      } else if (before === '@' && !/^https?:\/\/|^mailto:/i.test(token)) {
        out += collabHtml(token);
      } else {
        const parts = splitTrailingPunctuation(token);
        if (!/^(https?:\/\/|mailto:)/i.test(parts.clean) && looksLikePlainFileName(parts.clean)) {
          out += collabHtml(parts.clean + parts.tail);
        } else {
          const href = /^(https?:\/\/|mailto:)/i.test(parts.clean) ? parts.clean : `https://${parts.clean}`;
          out += renderSafeRichLink(href, parts.clean);
          out += collabHtml(parts.tail);
        }
      }
      last = match.index + token.length;
    }
    out += collabHtml(text.slice(last));
    return out;
  }
  window.renderMentionedText = function(text) {
    const raw = String(text || '');
    const tokenRe = /\[(Attachment|Link):\s*([^\]]+)\]\(([^)]+)\)/g;
    let out = '';
    let last = 0;
    let match;
    tokenRe.lastIndex = 0;
    while ((match = tokenRe.exec(raw)) !== null) {
      out += renderPlainRichTextSegment(raw.slice(last, match.index));
      out += renderAttachmentToken(match[1], match[2], match[3]);
      last = match.index + match[0].length;
    }
    out += renderPlainRichTextSegment(raw.slice(last));
    return out;
  };

  function closeEmojiPicker() {
    const picker = document.getElementById('rich-emoji-picker');
    if (picker) picker.classList.remove('open');
    activeEmojiPickerSource = null;
  }
  function showEmojiPickerAt(event, title, onPick) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    let picker = document.getElementById('rich-emoji-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'rich-emoji-picker';
      picker.className = 'emoji-picker-popover';
      document.body.appendChild(picker);
      document.addEventListener('pointerdown', e => {
        if (!picker.classList.contains('open')) return;
        const trigger = e.target.closest?.('.emoji-more-btn,.communication-tool-btn');
        if (!picker.contains(e.target) && trigger !== activeEmojiPickerSource) closeEmojiPicker();
      }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEmojiPicker(); });
    }
    const source = event?.currentTarget || null;
    if (picker.classList.contains('open') && source && activeEmojiPickerSource === source) { closeEmojiPicker(); return; }
    activeEmojiPickerSource = source;
    picker.innerHTML = `<div class="emoji-picker-title">${collabHtml(title || 'Choose emoji')}</div><div class="emoji-grid">${RICH_REACTION_EMOJIS.map(e => `<button type="button" class="emoji-option" data-emoji="${collabAttr(e)}">${collabHtml(e)}</button>`).join('')}</div>`;
    picker.querySelectorAll('.emoji-option').forEach(btn => btn.onclick = ev => { ev.stopPropagation(); closeEmojiPicker(); onPick(btn.dataset.emoji); });
    const rect = source?.getBoundingClientRect?.() || { left: 20, bottom: 80 };
    const width = Math.min(360, window.innerWidth - 28);
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    picker.style.left = Math.max(12, left) + 'px';
    picker.style.top = Math.min(rect.bottom + 8, window.innerHeight - 340) + 'px';
    picker.classList.add('open');
  }
  window.showEmojiInsertPicker = function(event, targetId) {
    const textarea = targetTextarea(targetId);
    if (!textarea) { toast('Click inside a text box first.', 'error'); return; }
    showEmojiPickerAt(event, 'Insert emoji', emoji => insertIntoTextarea(textarea, emoji));
  };
  window.showAppReactionPicker = function(event, targetType, targetId) {
    showEmojiPickerAt(event, 'React with emoji', emoji => toggleAppReaction(targetType, targetId, emoji));
  };
  window.showTeamChatReactionPicker = function(event, messageId) {
    showEmojiPickerAt(event, 'React in Team Chat', emoji => toggleMessageReaction(messageId, emoji));
  };

  function groupedAppReactions(targetType, targetId) {
    const store = reactionStore();
    const rows = store[reactionKey(targetType, targetId)] || [];
    const grouped = {};
    rows.forEach(r => {
      grouped[r.emoji] = grouped[r.emoji] || { count: 0, mine: false };
      grouped[r.emoji].count++;
      if (r.user_email === currentReactionUser()) grouped[r.emoji].mine = true;
    });
    return grouped;
  }
  window.renderAppReactionBar = function(targetType, targetId) {
    const grouped = groupedAppReactions(targetType, targetId);
    const entries = Object.entries(grouped);
    const quick = entries.length ? entries : DEFAULT_REACTIONS.map(e => [e, { count: 0, mine: false }]);
    return `<div class="app-reaction-bar" data-reaction-type="${collabAttr(targetType)}" data-reaction-id="${collabAttr(targetId)}">${quick.map(([emoji, data]) => `<button type="button" class="app-reaction-btn ${data.mine ? 'mine' : ''}" onclick="event.stopPropagation();toggleAppReaction('${collabAttr(targetType)}','${collabAttr(targetId)}','${collabAttr(emoji)}')">${collabHtml(emoji)}${data.count ? ' ' + data.count : ''}</button>`).join('')}<button type="button" class="emoji-more-btn" onclick="showAppReactionPicker(event,'${collabAttr(targetType)}','${collabAttr(targetId)}')">＋</button></div>`;
  };
  window.toggleAppReaction = async function(targetType, targetId, emoji) {
    if (!targetType || !targetId || !emoji) return;
    const key = reactionKey(targetType, targetId);
    const store = reactionStore();
    const user = currentReactionUser();
    const rows = store[key] || [];
    const existingIndex = rows.findIndex(r => r.user_email === user && r.emoji === emoji);
    if (existingIndex >= 0) rows.splice(existingIndex, 1);
    else rows.push({ user_email: user, user_name: collabCurrentName ? collabCurrentName() : user, emoji, created_at: new Date().toISOString() });
    store[key] = rows;
    saveReactionStore(store);
    refreshAppReactionBars(targetType, targetId);
    // Optional shared persistence if an app_reactions table exists. The UI remains usable without a migration.
    try {
      if (existingIndex >= 0) await sb.from('app_reactions').delete().eq('target_type', targetType).eq('target_id', String(targetId)).eq('emoji', emoji).eq('user_email', user);
      else await sb.from('app_reactions').insert({ target_type: targetType, target_id: String(targetId), emoji, user_email: user, user_name: collabCurrentName ? collabCurrentName() : user, created_at: new Date().toISOString() });
    } catch (_err) {}
  };
  function refreshAppReactionBars(targetType, targetId) {
    document.querySelectorAll(`.app-reaction-bar[data-reaction-type="${CSS.escape(targetType)}"][data-reaction-id="${CSS.escape(String(targetId))}"]`).forEach(bar => {
      const holder = document.createElement('div');
      holder.innerHTML = renderAppReactionBar(targetType, targetId);
      bar.replaceWith(holder.firstElementChild);
    });
  }
  function addToolbarForTextarea(textarea, label='Add') {
    if (!textarea || textarea.dataset.commToolbarReady === 'true') return;
    textarea.dataset.commToolbarReady = 'true';
    const id = textarea.id || `comm-textarea-${Math.random().toString(36).slice(2)}`;
    textarea.id = id;
    const toolbar = document.createElement('div');
    toolbar.className = 'communication-toolbar';
    toolbar.innerHTML = `<button type="button" class="communication-tool-btn" onclick="openAttachmentPicker('${collabAttr(id)}')">＋ Upload</button><button type="button" class="communication-tool-btn" onclick="addLinkAttachment('${collabAttr(id)}')">🔗 Link</button><button type="button" class="communication-tool-btn" onclick="showEmojiInsertPicker(event,'${collabAttr(id)}')">😊 Emoji</button><span class="attachment-hint-line">Drag and drop files here too</span>`;
    textarea.insertAdjacentElement('afterend', toolbar);
    ensureAttachmentPreview(textarea);
    renderAttachmentPreview(textarea);
  }
  function enhanceCommunicationToolbars() {
    ['f-question','m-answer','collab-message-input','collab-announcement-text'].forEach(id => addToolbarForTextarea(document.getElementById(id)));
    document.querySelectorAll('.comment-textarea, .collab-edit-area, textarea[id^="br-q-"]').forEach(ta => addToolbarForTextarea(ta));
    document.querySelectorAll('textarea, input[type="text"], input[type="search"]').forEach(el => {
      el.setAttribute('autocapitalize', 'none');
      el.setAttribute('autocomplete', el.getAttribute('autocomplete') || 'off');
    });
  }
  function enhanceRichTextDisplays() {
    document.querySelectorAll('.faq-question, .faq-answer-preview, .detail-box, .comment-text, .collab-msg-body, .notification-body').forEach(el => {
      // BUGFIX: if rich content already rendered (e.g. by renderCollabMessage, renderCommentItem
      // wrapper, or the renderFaq wrapper), skip entirely. The previous guard only skipped when
      // *both* hasRenderedRichContent AND rawTextForRichRender were set, meaning the very first
      // pass after rendering would still read el.textContent (which is the image caption/alt,
      // not the original markdown) and call renderMentionedText on it — destroying the image.
      const hasRenderedRichContent = !!el.querySelector?.('.rich-image-attachment,.rich-attachment-link,.rich-link-preview');
      if (hasRenderedRichContent) return;
      const currentText = el.textContent || '';
      if (!el.dataset.rawTextForRichRender || el.dataset.rawTextForRichRender !== currentText) {
        el.dataset.rawTextForRichRender = currentText;
      }
      el.innerHTML = renderMentionedText(el.dataset.rawTextForRichRender);
    });
  }
  function enhanceQuestionAnswerReactions() {
    document.querySelectorAll('.faq-card[data-question-id]').forEach(card => {
      const qid = card.dataset.questionId;
      const qEl = card.querySelector('.faq-question');
      if (qEl && !qEl.nextElementSibling?.classList?.contains('app-reaction-bar')) qEl.insertAdjacentHTML('afterend', renderAppReactionBar('question', qid));
      const aEl = card.querySelector('.faq-answer-preview');
      if (aEl && !aEl.nextElementSibling?.classList?.contains('app-reaction-bar')) aEl.insertAdjacentHTML('afterend', renderAppReactionBar('answer', qid));
    });
  }
  function enhanceReviewModalReactions() {
    if (!currentQ || !document.getElementById('modal-overlay')?.classList.contains('open')) return;
    const boxes = document.querySelectorAll('#modal-body .detail-box');
    if (boxes[0] && !boxes[0].nextElementSibling?.classList?.contains('app-reaction-bar')) boxes[0].insertAdjacentHTML('afterend', renderAppReactionBar('question', currentQ.id));
    const answer = document.getElementById('m-answer');
    if (answer && !answer.parentElement.querySelector('.app-reaction-bar[data-reaction-type="answer"]')) answer.insertAdjacentHTML('afterend', renderAppReactionBar('answer', currentQ.id));
  }
  function enhanceTeamChatReactionButtons() {
    document.querySelectorAll('.collab-message[data-message-id]').forEach(node => {
      const actions = node.querySelector(':scope > .collab-bubble > .collab-message-actions');
      if (!actions || actions.querySelector('.emoji-more-btn')) return;
      const messageId = node.dataset.messageId;
      actions.insertAdjacentHTML('afterbegin', `<button type="button" class="emoji-more-btn" onclick="showTeamChatReactionPicker(event,'${collabAttr(messageId)}')">😊 More</button>`);
    });
  }

  // Wrap dynamic renderers after all previous patches have been installed.
  if (typeof renderCommentItem === 'function') {
    const prevRenderCommentItem = renderCommentItem;
    window.renderCommentItem = function(node, questionId, context, previewDepth = 0, isPreview = false) {
      let html = prevRenderCommentItem(node, questionId, context, previewDepth, isPreview);
      if (html.includes('app-reaction-bar')) return html;
      return html.replace(`<div class="comment-edit-slot" id="comment-edit-slot-${domKey(context, node.id)}"></div>`, `${renderAppReactionBar('comment', node.id)}<div class="comment-edit-slot" id="comment-edit-slot-${domKey(context, node.id)}"></div>`);
    };
  }
  if (typeof renderCommentForm === 'function') {
    const prevRenderCommentForm = renderCommentForm;
    window.renderCommentForm = function(questionId, parentId = null, context = 'faq') {
      const html = prevRenderCommentForm(questionId, parentId, context);
      setTimeout(enhanceCommunicationToolbars, 0);
      return html;
    };
  }
  if (typeof renderFaq === 'function') {
    const prevRenderFaq = renderFaq;
    window.renderFaq = function() {
      prevRenderFaq();
      enhanceQuestionAnswerReactions();
      enhanceRichTextDisplays();
      enhanceCommunicationToolbars();
    };
  }
  if (typeof openModal === 'function') {
    const prevOpenModalForRichTools = openModal;
    window.openModal = function(qid) {
      const result = prevOpenModalForRichTools(qid);
      setTimeout(() => { enhanceReviewModalReactions(); enhanceRichTextDisplays(); enhanceCommunicationToolbars(); }, 0);
      return result;
    };
  }
  if (typeof renderCollabMessages === 'function') {
    const prevRenderCollabMessages = renderCollabMessages;
    window.renderCollabMessages = function() {
      prevRenderCollabMessages();
      enhanceTeamChatReactionButtons();
      enhanceRichTextDisplays();
      enhanceCommunicationToolbars();
    };
  }
  ['renderFaqComments','renderModalComments','refreshComments','loadFaqComments','loadModalComments','loadCollabMessages'].forEach(fnName => {
    const fn = window[fnName];
    if (typeof fn !== 'function' || fn.__richTextEnhanced) return;
    const wrapped = async function() {
      const result = await fn.apply(this, arguments);
      setTimeout(() => { enhanceRichTextDisplays(); enhanceCommunicationToolbars(); }, 0);
      return result;
    };
    wrapped.__richTextEnhanced = true;
    window[fnName] = wrapped;
  });

  // Stable Team Chat refresh: prevent read-status realtime from causing reload loops and avoid showing loaders during silent refreshes.
  let collabMessageLoadInFlight = false;
  let collabMessageLoadQueued = null;
  let lastSeenMarkAtByChannel = {};
  let lastMessageLoadAtByChannel = {};
  window.markChannelMessagesSeen = async function(force = false) {
    if (!currentUser || !COLLAB.currentChannelId || !COLLAB.messages.length) return;
    const now = Date.now();
    if (!force && now - (lastSeenMarkAtByChannel[COLLAB.currentChannelId] || 0) < 20000) return;
    lastSeenMarkAtByChannel[COLLAB.currentChannelId] = now;
    const alreadySeen = new Set();
    Object.values(COLLAB.reads || {}).flat().forEach(r => { if (r.user_email === currentUser.email) alreadySeen.add(r.message_id); });
    const rows = COLLAB.messages
      .filter(m => m.author_email !== currentUser.email && !alreadySeen.has(m.id))
      .slice(-80)
      .map(m => ({ channel_id: COLLAB.currentChannelId, message_id: m.id, user_email: currentUser.email, seen_at: new Date().toISOString() }));
    if (!rows.length) return;
    try { await sb.from('collab_message_reads').upsert(rows, { onConflict:'message_id,user_email' }); } catch (_err) {}
  };
  window.loadCollabMessages = async function(scrollToBottom = false, options = {}) {
    const wrap = document.getElementById('collab-messages');
    if (!wrap || !COLLAB.currentChannelId) return;
    const channelId = COLLAB.currentChannelId;
    const now = Date.now();
    if (collabMessageLoadInFlight) { collabMessageLoadQueued = { scrollToBottom, options }; return; }
    if (options.reason !== 'manual' && !scrollToBottom && now - (lastMessageLoadAtByChannel[channelId] || 0) < 700) return;
    collabMessageLoadInFlight = true;
    lastMessageLoadAtByChannel[channelId] = now;
    const shouldShowLoader = options.showLoader === true || (!COLLAB.messages.length && options.silent !== true);
    if (shouldShowLoader) wrap.innerHTML = '<div class="loading"><div class="spinner"></div> Loading messages...</div>';
    try {
      const [messagesRes, reactionsRes, readsRes] = await Promise.all([
        sb.from('collab_messages').select('id,channel_id,body,author_email,author_name,mentions,created_at,updated_at,attachments').eq('channel_id', channelId).order('created_at', { ascending:true }).limit(200),
        sb.from('collab_message_reactions').select('id,message_id,channel_id,user_email,emoji,created_at').eq('channel_id', channelId),
        sb.from('collab_message_reads').select('id,message_id,channel_id,user_email,read_at').eq('channel_id', channelId)
      ]);
      if (messagesRes.error) throw messagesRes.error;
      COLLAB.messages = messagesRes.data || [];
      COLLAB.reactions = groupByMessage(reactionsRes.data || []);
      COLLAB.reads = groupByMessage(readsRes.data || []);
    } catch (err) { collabOpenError('load messages', err); }
    renderCollabMessages();
    if (!options.skipSeen) await markChannelMessagesSeen(false);
    if (scrollToBottom) setTimeout(() => { const fresh = document.getElementById('collab-messages'); if (fresh) fresh.scrollTop = fresh.scrollHeight; }, 60);
    collabMessageLoadInFlight = false;
    if (collabMessageLoadQueued) {
      const queued = collabMessageLoadQueued;
      collabMessageLoadQueued = null;
      setTimeout(() => loadCollabMessages(queued.scrollToBottom, { ...(queued.options || {}), silent:true }), 250);
    }
  };
  window.subscribeChannelRealtime = function(channelId) {
    ['messages','typing','reads','reactions'].forEach(k => { if (COLLAB.subs[k]) { try { sb.removeChannel(COLLAB.subs[k]); } catch (_err) {} COLLAB.subs[k] = null; } });
    if (!channelId) return;
    try {
      COLLAB.subs.messages = sb.channel('collab_messages_' + channelId)
        .on('postgres_changes', { event:'*', schema:'public', table:'collab_messages', filter:`channel_id=eq.${channelId}` }, () => loadCollabMessages(true, { silent:true }))
        .subscribe();
      COLLAB.subs.reactions = sb.channel('collab_reactions_' + channelId)
        .on('postgres_changes', { event:'*', schema:'public', table:'collab_message_reactions', filter:`channel_id=eq.${channelId}` }, () => loadCollabMessages(false, { silent:true, skipSeen:true }))
        .subscribe();
      COLLAB.subs.typing = sb.channel('collab_typing_' + channelId)
        .on('postgres_changes', { event:'*', schema:'public', table:'collab_typing', filter:`channel_id=eq.${channelId}` }, () => renderTypingIndicator())
        .subscribe();
      // Intentionally no reads subscription: read receipts are refreshed during message/reaction/manual loads to prevent a loop.
    } catch (err) { collabOpenError('channel realtime', err); }
  };
  if (typeof selectCollabChannel === 'function') {
    const prevSelectCollabChannel = selectCollabChannel;
    window.selectCollabChannel = async function(id) {
      COLLAB.currentChannelId = id;
      localStorage.setItem('collabCurrentChannelId', id);
      renderCollabChannels();
      const ch = COLLAB.channels.find(c => c.id === id);
      document.getElementById('collab-channel-name').textContent = ch ? `${ch.visibility === 'private' ? '🔒' : '#'} ${ch.name}` : 'Channel';
      document.getElementById('collab-channel-sub').textContent = ch?.description || 'Live team messages, mentions, reactions, attachments, and read status.';
      renderCollabChannelManagementActions(ch);
      await loadCollabMessages(true, { showLoader: true, reason: 'manual' });
      subscribeChannelRealtime(id);
      enhanceCommunicationToolbars();
    };
  }
  if (typeof sendCollabMessage === 'function') {
    const prevSendCollabMessage = sendCollabMessage;
    window.sendCollabMessage = async function() {
      flushAttachmentsToTextarea(document.getElementById('collab-message-input'));
      await prevSendCollabMessage();
      setTimeout(enhanceCommunicationToolbars, 0);
    };
  }
  if (typeof submitCommentForm === 'function') {
    const prevSubmitCommentForm = submitCommentForm;
    window.submitCommentForm = async function(questionId, parentId = '', context = 'faq') {
      const key = commentFormKey(questionId, parentId || null, context);
      flushAttachmentsToTextarea(document.getElementById(`comment-textarea-${key}`));
      return prevSubmitCommentForm(questionId, parentId, context);
    };
  }
  if (typeof submitQuestion === 'function') {
    const prevSubmitQuestion = submitQuestion;
    window.submitQuestion = async function() {
      // Issue 1F: collect attachments OUT of the textarea, into a side-channel
      // that submitQuestion picks up via window.__pendingSubmitAttachments and
      // attaches to the DB payload's `attachments` column. The textarea value
      // stays clean — users never see raw Supabase URLs in the question box.
      try {
        window.__pendingSubmitAttachments = takeAttachmentsForTextarea(document.getElementById('f-question'));
      } catch (_e) { window.__pendingSubmitAttachments = []; }
      return prevSubmitQuestion();
    };
  }
  if (typeof submitBulk === 'function') {
    const prevSubmitBulkForAttachments = submitBulk;
    window.submitBulk = async function() {
      // Issue 1F: collect per-row attachments into a side-channel for submitBulk.
      const map = {};
      document.querySelectorAll('textarea[id^="br-q-"]').forEach(ta => {
        const m = ta.id.match(/^br-q-(\d+)$/);
        if (!m) return;
        try { map[m[1]] = takeAttachmentsForTextarea(ta); } catch (_e) { map[m[1]] = []; }
      });
      window.__pendingBulkAttachments = map;
      return prevSubmitBulkForAttachments();
    };
  }
  if (typeof sendAdminAnnouncement === 'function') {
    const prevSendAdminAnnouncementForAttachments = sendAdminAnnouncement;
    window.sendAdminAnnouncement = async function() {
      // Announcements DO embed inline (the body field accepts markdown rendering).
      flushAttachmentsToTextarea(document.getElementById('collab-announcement-text'));
      return prevSendAdminAnnouncementForAttachments();
    };
  }
  if (typeof updateCommentCounter === 'function') {
    const prevUpdateCommentCounterForAttachments = updateCommentCounter;
    window.updateCommentCounter = function(key) {
      prevUpdateCommentCounterForAttachments(key);
      updateAttachmentSubmitState(document.getElementById(`comment-textarea-${key}`));
    };
  }
  if (typeof saveAnswer === 'function') {
    const prevSaveAnswerForAttachments = saveAnswer;
    window.saveAnswer = async function() {
      flushAttachmentsToTextarea(document.getElementById('m-answer'));
      return prevSaveAnswerForAttachments();
    };
  }
  if (typeof sendCollabThreadReply === 'function') {
    const prevSendCollabThreadReply = sendCollabThreadReply;
    window.sendCollabThreadReply = async function(parentMessageId) {
      const key = collabMessageDomKey(parentMessageId);
      flushAttachmentsToTextarea(document.getElementById(`collab-reply-textarea-${key}`));
      return prevSendCollabThreadReply(parentMessageId);
    };
  }
  if (typeof editCommentSubmit === 'function') {
    const prevEditCommentSubmit = editCommentSubmit;
    window.editCommentSubmit = async function(commentId, questionId, context = 'faq') {
      const editKey = domKey('edit', context, commentId);
      flushAttachmentsToTextarea(document.getElementById(`comment-textarea-${editKey}`));
      return prevEditCommentSubmit(commentId, questionId, context);
    };
  }
  if (typeof saveCollabMessageEdit === 'function') {
    const prevSaveCollabMessageEdit = saveCollabMessageEdit;
    window.saveCollabMessageEdit = async function(messageId) {
      const key = collabMessageDomKey(messageId);
      flushAttachmentsToTextarea(document.getElementById(`collab-edit-textarea-${key}`));
      return prevSaveCollabMessageEdit(messageId);
    };
  }
  if (typeof startCollabThreadReply === 'function') {
    const prevStartCollabThreadReply = startCollabThreadReply;
    window.startCollabThreadReply = function(messageId) {
      const result = prevStartCollabThreadReply(messageId);
      setTimeout(enhanceCommunicationToolbars, 0);
      return result;
    };
  }
  if (typeof editCollabMessageStart === 'function') {
    const prevEditCollabMessageStart = editCollabMessageStart;
    window.editCollabMessageStart = function(messageId) {
      const result = prevEditCollabMessageStart(messageId);
      setTimeout(enhanceCommunicationToolbars, 0);
      return result;
    };
  }
  if (typeof clearForm === 'function') {
    const prevClearFormForAttachments = clearForm;
    window.clearForm = function() {
      clearPendingAttachments(document.getElementById('f-question'));
      return prevClearFormForAttachments();
    };
  }
  if (typeof clearBulkRow === 'function') {
    const prevClearBulkRowForAttachments = clearBulkRow;
    window.clearBulkRow = function(n) {
      clearPendingAttachments(document.getElementById(`br-q-${n}`));
      return prevClearBulkRowForAttachments(n);
    };
  }
  if (typeof clearBulkForm === 'function') {
    const prevClearBulkFormForAttachments = clearBulkForm;
    window.clearBulkForm = function() {
      document.querySelectorAll('textarea[id^="br-q-"]').forEach(clearPendingAttachments);
      return prevClearBulkFormForAttachments();
    };
  }
  if (typeof clearCommentForm === 'function') {
    const prevClearCommentFormForAttachments = clearCommentForm;
    window.clearCommentForm = function(key) {
      clearPendingAttachments(document.getElementById(`comment-textarea-${key}`));
      return prevClearCommentFormForAttachments(key);
    };
  }
  if (typeof cancelReply === 'function') {
    const prevCancelReplyForAttachments = cancelReply;
    window.cancelReply = function(parentId, questionId, context = 'faq') {
      const key = commentFormKey(questionId, parentId || null, context);
      clearPendingAttachments(document.getElementById(`comment-textarea-${key}`));
      return prevCancelReplyForAttachments(parentId, questionId, context);
    };
  }
  if (typeof cancelCollabThreadReply === 'function') {
    const prevCancelCollabThreadReplyForAttachments = cancelCollabThreadReply;
    window.cancelCollabThreadReply = function(messageId) {
      const key = collabMessageDomKey(messageId);
      clearPendingAttachments(document.getElementById(`collab-reply-textarea-${key}`));
      return prevCancelCollabThreadReplyForAttachments(messageId);
    };
  }
  if (typeof cancelCollabMessageEdit === 'function') {
    const prevCancelCollabMessageEditForAttachments = cancelCollabMessageEdit;
    window.cancelCollabMessageEdit = function(messageId) {
      const key = collabMessageDomKey(messageId);
      clearPendingAttachments(document.getElementById(`collab-edit-textarea-${key}`));
      return prevCancelCollabMessageEditForAttachments(messageId);
    };
  }
  if (typeof closeModal === 'function') {
    const prevCloseModalForAttachments = closeModal;
    window.closeModal = function() {
      clearPendingAttachments(document.getElementById('m-answer'));
      return prevCloseModalForAttachments();
    };
  }
  if (typeof toggleMessageReaction === 'function') {
    const prevToggleMessageReaction = toggleMessageReaction;
    window.toggleMessageReaction = async function(messageId, emoji) {
      await prevToggleMessageReaction(messageId, emoji);
      setTimeout(enhanceTeamChatReactionButtons, 0);
    };
  }

  // Add upload/emoji tools after page switches and dynamic renders.
  if (typeof showPage === 'function') {
    const prevShowPage = showPage;
    window.showPage = function(id) {
      prevShowPage(id);
      setTimeout(() => { enhanceCommunicationToolbars(); enhanceRichTextDisplays(); enhanceQuestionAnswerReactions(); enhanceTeamChatReactionButtons(); }, 80);
    };
  }

  document.addEventListener('dragover', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      document.body.classList.add('attachment-drop-active');
    }
  });
  document.addEventListener('dragleave', e => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) document.body.classList.remove('attachment-drop-active');
  });
  document.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    const textarea = closestTextareaFromEventTarget(e.target) || (activePageId() === 'page-collab' ? document.getElementById('collab-message-input') : null);
    if (!textarea) return;
    e.preventDefault();
    document.body.classList.remove('attachment-drop-active');
    processAttachmentFiles(e.dataTransfer.files, textarea);
  });
  document.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files || []).filter(file => file && file.size);
    if (!files.length) return;
    const textarea = closestTextareaFromEventTarget(e.target) || (activePageId() === 'page-collab' ? document.getElementById('collab-message-input') : null);
    if (!textarea) return;
    e.preventDefault();
    processAttachmentFiles(files, textarea);
  }, true);
  // BUGFIX 2026-05-26: The capture-phase click listener that was here previously
  // called e.stopPropagation() on every click inside .comments-section buttons
  // and .attachment-preview-strip. That blocked the inline onclick handlers on
  // those buttons (× remove, Reply, Clear, + Upload, 🔗 Link, 😊 Emoji) because
  // stopPropagation() during capture phase prevents the event from reaching the
  // target's own listeners. Removed entirely. The FAQ card's toggleFaqCard()
  // function already checks for clicks inside the comments section and returns
  // early, so the original "prevent card collapse" intent is preserved.
  document.addEventListener('focusin', e => {
    if (isCommunicationTextarea(e.target)) addToolbarForTextarea(e.target);
  });
  window.addEventListener('DOMContentLoaded', () => setTimeout(() => { enhanceCommunicationToolbars(); enhanceRichTextDisplays(); }, 120));
})();

// Start app after v2 overrides are ready.
init();

window.addEventListener('DOMContentLoaded', () => {
  if (currentUser) {
    const footer = document.getElementById('main-footer');
    if (footer) footer.style.display = 'block';
    updateIssueFieldControls();
  }
});
// Keep the FAQ clear button state correct if the input is already populated on page load.
document.addEventListener('DOMContentLoaded', updateFaqSearchClearButton);

// ---- extracted script block 3 ----
(function attachmentRenderingFix() {
  // Match [Attachment: name](url) where url can contain almost anything except
  // a closing paren. The url is captured as group 2.
  const ATTACHMENT_RE = /\[Attachment:\s*([^\]]+)\]\(([^)]+)\)/g;

  // Limit which URL schemes we accept, to avoid rendering javascript: URLs etc.
  function isSafeUrl(url) {
    const u = String(url).trim().toLowerCase();
    return u.startsWith('http://') ||
           u.startsWith('https://') ||
           u.startsWith('data:image/') ||
           u.startsWith('blob:');
  }

  function isImageUrl(url) {
    const u = String(url).trim().toLowerCase();
    if (u.startsWith('data:image/')) return true;
    if (u.startsWith('blob:'))       return true;  // blob URLs from File objects
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(u);
  }

  // HTML-escape for use in attribute values
  function attr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // HTML-escape for use in text content
  function htmlEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Convert raw text into HTML that:
  //  - preserves line breaks
  //  - turns [Attachment: name](url) into <img> or <a>
  //  - HTML-escapes everything else
  window.renderAttachmentMarkdown = function(text) {
    if (!text) return '';
    let result = '';
    let lastIndex = 0;
    let match;
    ATTACHMENT_RE.lastIndex = 0;
    while ((match = ATTACHMENT_RE.exec(text)) !== null) {
      // Escape the plain text before this match
      result += htmlEsc(text.slice(lastIndex, match.index)).replace(/\n/g, '<br>');
      const name = match[1].trim();
      const url  = match[2].trim();
      if (isSafeUrl(url)) {
        if (isImageUrl(url)) {
          result += '<div class="bugfix-attachment-image-wrap">' +
                      '<img class="bugfix-attachment-image" src="' + attr(url) + '" alt="' + attr(name) + '" loading="lazy">' +
                      '<div class="bugfix-attachment-caption">' + htmlEsc(name) + '</div>' +
                    '</div>';
        } else {
          result += '<a class="bugfix-attachment-link" href="' + attr(url) + '" target="_blank" rel="noopener noreferrer" download="' + attr(name) + '">' +
                      '📎 ' + htmlEsc(name) +
                    '</a>';
        }
      } else {
        // Unknown/unsafe scheme — show as plain escaped text rather than a clickable link
        result += htmlEsc(match[0]);
      }
      lastIndex = match.index + match[0].length;
    }
    // Tail
    result += htmlEsc(text.slice(lastIndex)).replace(/\n/g, '<br>');
    return result;
  };

  // Enhance one element: render its raw text content as attachment markdown.
  // Uses a data flag so it's idempotent (won't double-process).
  function enhance(el) {
    if (!el) return;
    const alreadyRendered = el.querySelector?.('.rich-image-attachment,.rich-attachment-link,.rich-link-preview,.bugfix-attachment-image,.bugfix-attachment-link');
    if (alreadyRendered) {
      el.dataset.bugfixAttachmentsRendered = 'true';
      return;
    }
    const raw = el.textContent || '';
    if (el.dataset.bugfixAttachmentsRendered === 'true' && el.dataset.bugfixAttachmentRaw === raw) return;
    if (typeof window.renderMentionedText === 'function' && (/\[Attachment:|\[Link:|https?:\/\/|mailto:|data:image\/|blob:|\b[a-z0-9-]+\.[a-z]{2,}/i.test(raw))) {
      el.innerHTML = window.renderMentionedText(raw);
    } else if (raw.includes('[Attachment:')) {
      el.innerHTML = window.renderAttachmentMarkdown(raw);
    }
    el.dataset.bugfixAttachmentRaw = raw;
    el.dataset.bugfixAttachmentsRendered = 'true';
  }

  function enhanceAll() {
    // Issues 3B + 4B: scope enhancement to the currently active page only.
    // Previously this scanned `document` which caused stale .td-q cells in
    // inactive pages to render their attachment images briefly during a page
    // transition, before loadAllQData/loadReviewData replaced the table wrap
    // with the loading spinner.
    const activePage = document.querySelector('.page.active') || document;
    activePage
      .querySelectorAll('.comment-text, .faq-question, .faq-answer-preview, .detail-box, .collab-msg-body, .faq-card-top, .faq-footer, .modal-content, .td-q')
      .forEach(enhance);
    // The notification panel lives outside .page containers — enhance it too.
    document.querySelectorAll('#notification-panel .notification-body').forEach(enhance);
  }

  // Run after each render cycle. The MutationObserver below catches most cases
  // but we also wrap refreshComments() and loadFaqComments() for promptness.
  function wrapIfPresent(fnName) {
    const fn = window[fnName];
    if (typeof fn !== 'function') return;
    window[fnName] = async function() {
      const result = await fn.apply(this, arguments);
      setTimeout(enhanceAll, 50);
      return result;
    };
  }

  // Watch the document for newly added comment/answer text elements
  const observer = new MutationObserver(() => {
    // Debounce — multiple mutations from a single render shouldn't re-run many times
    if (observer._scheduled) return;
    observer._scheduled = true;
    setTimeout(() => {
      observer._scheduled = false;
      enhanceAll();
    }, 30);
  });

  function start() {
    enhanceAll();
    observer.observe(document.body, { childList: true, subtree: true });
    // Wrap key render functions so enhancement is immediate, not just observed
    ['refreshComments', 'loadFaqComments', 'loadModalComments', 'renderFaq',
     'renderReviewTable', 'renderAllQ', 'loadCollabMessages']
      .forEach(wrapIfPresent);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

// ---- extracted script block 4 ----
// Click image to open full-size in a new tab
document.addEventListener('click', function(e) {
  const img = e.target.closest && e.target.closest('.bugfix-attachment-image');
  if (!img) return;
  const url = img.getAttribute('src');
  if (!url) return;
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_err) {}
});

// ---- extracted script block 5 ----
// Production compatibility patch generated during project audit.
// Keeps frontend role names aligned with the database constraints.
(function productionCompatibilityPatch(){
  function normalizeDbRole(role) {
    const value = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const map = {
      staff: 'staff', user: 'staff', member: 'staff', employee: 'staff',
      reviewer: 'reviewer', review: 'reviewer',
      admin: 'admin', administrator: 'admin', reviewer_admin: 'admin', revieweradmin: 'admin',
      primary: 'primary_admin', primary_admin: 'primary_admin', owner: 'primary_admin'
    };
    return map[value] || 'staff';
  }
  function roleDisplay(role) {
    const r = normalizeDbRole(role);
    return r === 'primary_admin' ? 'Primary Admin' : r === 'admin' ? 'Admin' : r === 'reviewer' ? 'Reviewer' : 'User';
  }
  try {
    if (window.USER_INFO) window.USER_INFO.roleOptions = ['staff','reviewer','admin','primary_admin'];
    window.uiNormalizeRole = normalizeDbRole;
    window.uiRoleDisplay = roleDisplay;
    window.uiIsAdminRole = function(role){ return ['admin','primary_admin'].includes(normalizeDbRole(role)); };
    window.uiIsReviewerRole = function(role){ return ['reviewer','admin','primary_admin'].includes(normalizeDbRole(role)); };
  } catch (_err) {}
})();

// ---- extracted script block 6 ----
(function(){
  var SKIP = '.collab-msg-body, #page-submit';
  function wrap(el){
    if(el.dataset.icWrapped || el.closest(SKIP)) return;
    el.dataset.icWrapped = '1';
    var name = (el.querySelector('.rich-attachment-caption, .bugfix-attachment-caption') || {}).textContent
               || (el.querySelector('img') || {}).alt || 'Image';
    var d = document.createElement('details');
    d.className = 'img-collapse';
    var s = document.createElement('summary');
    s.innerHTML = '<span class="ic">&#9654;</span>&#128247; ' + name.replace(/[<>&"]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});
    var b = document.createElement('div');
    b.className = 'img-collapse-body';
    el.parentNode.insertBefore(d, el);
    b.appendChild(el);
    d.appendChild(s);
    d.appendChild(b);
  }
  function run(){
    document.querySelectorAll('.rich-image-attachment, .bugfix-attachment-image-wrap').forEach(wrap);
  }
  var t; new MutationObserver(function(){clearTimeout(t);t=setTimeout(run,80);})
    .observe(document.body,{childList:true,subtree:true});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',run):run();
})();

// ---- extracted script block 7 ----
(function bugfixPatch20260527() {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // FIX #1 + #2 — Stop image-attachment clicks from bubbling to the
  // parent <tr> (All Questions, Review) or .faq-card (Answered).
  //
  // Why a per-element listener and not a document-level one:
  // Per the 2026-05-26 BUGFIXES note in /docs, a previous attempt used a
  // document-level capture-phase listener calling stopPropagation(). That
  // broke inline onclick handlers on every button inside comment forms,
  // because capture-phase ancestors stop the event before it reaches the
  // target. We deliberately use BUBBLE-phase listeners on specific
  // elements so the buttons elsewhere are unaffected.
  // ─────────────────────────────────────────────────────────────────

  // Marker so we never double-bind on the same element.
  var WIRED = '__bfx20260527Wired';

  function stopProp(e) {
    // Don't stop the default action (the <summary> default action
    // toggles the <details>; that's the behavior we want to preserve).
    // We only stop the click from bubbling to ancestor onclick handlers.
    e.stopPropagation();
  }

  // Image: also opens in a new tab (replaces the old document-level
  // listener at the bottom of the file, which still exists but is now
  // redundant — it only fires if our local listener somehow misses).
  function onImageClick(e) {
    var img = e.currentTarget;
    var url = img.getAttribute('src');
    if (url) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_err) {}
    }
    e.stopPropagation();
    e.preventDefault();   // don't let the browser try to navigate the <img> itself
  }

  function wireIfNeeded(el, handler) {
    if (!el || el[WIRED]) return;
    el[WIRED] = true;
    el.addEventListener('click', handler);
  }

  function sweep(root) {
    var scope = root && root.querySelectorAll ? root : document;

    // (a) The <details class="img-collapse"> wrappers added by the
    //     existing image-collapse script. One listener on the details
    //     element catches the summary toggle, the image clicks, and any
    //     captions / future children — all in a single hook point.
    scope.querySelectorAll('.img-collapse').forEach(function (d) {
      wireIfNeeded(d, stopProp);
    });

    // (b) The image element itself. We want the open-in-new-tab AND
    //     stopPropagation. Doing it directly on the <img> means we
    //     don't depend on event order with the .img-collapse listener.
    scope.querySelectorAll('.bugfix-attachment-image').forEach(function (img) {
      wireIfNeeded(img, onImageClick);
    });

    // (c) Other rich attachments (download link chips, link previews)
    //     inside the Question cell of All Questions / Review tables —
    //     they're <a> tags that should follow the link, not open the row.
    scope.querySelectorAll(
      '.td-q a, .td-q .bugfix-attachment-link, .td-q .rich-attachment-link, ' +
      '.td-q .rich-link-preview, .td-q .rich-image-attachment'
    ).forEach(function (a) {
      wireIfNeeded(a, stopProp);
    });

    // (d) Defensive: any raw image-wrap that the collapse script hasn't
    //     wrapped yet (race during first paint).
    scope.querySelectorAll('.bugfix-attachment-image-wrap, .rich-image-attachment').forEach(function (w) {
      wireIfNeeded(w, stopProp);
    });
  }

  // Initial pass, then watch for dynamically-rendered rows / cards /
  // messages. We coalesce mutations with a short timeout so we don't
  // re-sweep on every keystroke / reaction toggle.
  var pending;
  function scheduleSweep() {
    clearTimeout(pending);
    pending = setTimeout(function () { sweep(document); }, 60);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { sweep(document); });
  } else {
    sweep(document);
  }

  new MutationObserver(scheduleSweep).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // ─────────────────────────────────────────────────────────────────
  // FIX #3 — Apply a body class while Team Chat is the active page so
  // the body-level scroll lock in CSS only kicks in there.
  // We hook showPage() so we don't have to patch every call site.
  // ─────────────────────────────────────────────────────────────────
  function applyCollabBodyClass() {
    var active = document.querySelector('.page.active');
    var isCollab = active && active.id === 'page-collab';
    document.body.classList.toggle('collab-active', !!isCollab);
  }

  // Wrap showPage if it exists; otherwise wait for it (it's defined
  // higher up in the same script context). The check is defensive.
  function hookShowPage() {
    if (typeof window.showPage !== 'function' || window.showPage.__bfx20260527) return;
    var original = window.showPage;
    window.showPage = function () {
      var r = original.apply(this, arguments);
      // applyCollabBodyClass after the page swap; showPage is sync.
      applyCollabBodyClass();
      return r;
    };
    window.showPage.__bfx20260527 = true;
    // Initial sync in case a page is already active by the time we run.
    applyCollabBodyClass();
  }

  // showPage may be defined after this script runs in some load orders;
  // try a few times.
  hookShowPage();
  if (!window.showPage || !window.showPage.__bfx20260527) {
    var tries = 0;
    var iv = setInterval(function () {
      hookShowPage();
      if ((window.showPage && window.showPage.__bfx20260527) || ++tries > 40) {
        clearInterval(iv);
      }
    }, 100);
  }

  // ─────────────────────────────────────────────────────────────────
  // Polish — when Team Chat messages re-render, the existing code
  // already scrolls the messages list to the bottom. We just make sure
  // smooth-scroll doesn't fight the instant jump-to-bottom on first
  // load, by allowing `scrollTop = scrollHeight` to be instant.
  // (CSS `scroll-behavior: smooth` makes programmatic scrollTop
  // animate; we override per-call when needed by setting `behavior:
  // 'auto'` via scrollTo. Touch only if we observe jank in QA.)
  // ─────────────────────────────────────────────────────────────────

})();

// ---- extracted script block 8 ----
(function uiUpdatePatch20260527Rev2() {
  'use strict';

  // After the tabbar is created by setupAdminTabs(), scroll the
  // currently-active tab into view on narrow screens. Idempotent.
  function ensureActiveTabVisible() {
    var bar = document.getElementById('admin-tabbar');
    if (!bar) return;
    var active = bar.querySelector('.admin-tab.active');
    if (!active) return;
    // Only do this where horizontal-scroll is actually in play.
    if (bar.scrollWidth <= bar.clientWidth) return;
    try {
      active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
    } catch (_err) {
      // older browsers: ignore.
    }
  }

  // Hook switchAdminTab to keep the active tab visible after switching.
  function hookSwitchAdminTab() {
    if (typeof window.switchAdminTab !== 'function' || window.switchAdminTab.__rev2) return;
    var original = window.switchAdminTab;
    window.switchAdminTab = function () {
      var r = original.apply(this, arguments);
      // Defer to next frame so the .active class is in place.
      requestAnimationFrame(ensureActiveTabVisible);
      return r;
    };
    window.switchAdminTab.__rev2 = true;
  }

  // switchAdminTab is itself wrapped multiple times by other patches
  // (customization, user-info). Retry a few times to land last.
  hookSwitchAdminTab();
  var tries = 0;
  var iv = setInterval(function () {
    hookSwitchAdminTab();
    // We don't insist on being last — once wrapped, we're done.
    if (++tries > 40) clearInterval(iv);
  }, 120);

  // Also call once when the Admin page becomes active, in case the
  // active tab was restored from localStorage before scrollWidth was
  // measurable.
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#nav-admin')) {
      setTimeout(ensureActiveTabVisible, 250);
    }
  });
})();

// ---- extracted script block 9 ----
/* ════════════════════════════════════════════════════════════════════════════
   FINAL FIX BUNDLE — DE QnA Tracker (Issues 1A, 1C, 1D, 1E, 1F display,
   2E profile pictures, 5B-3 read-only channel UI, and shared helpers).
   This block runs after all earlier scripts and must remain idempotent.
════════════════════════════════════════════════════════════════════════════ */
(function finalFixBundle() {
  'use strict';

  // ─── Small helpers ─────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fileExt(name) { const m = String(name || '').match(/\.([a-zA-Z0-9]+)$/); return m ? m[1].toLowerCase() : ''; }
  function isImageMime(t) { return /^image\//i.test(String(t || '')); }
  function isImageByExt(name) { return /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(String(name || '')); }

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1C — Image compression before upload.
  // Resize to max 1280px wide, JPEG quality 0.80. Falls back to original on error.
  // Skips SVG (resizing breaks it) and very small files (<200KB).
  // ═══════════════════════════════════════════════════════════════════════════
  async function compressImageFile(file) {
    if (!file) return file;
    const type = String(file.type || '').toLowerCase();
    if (!isImageMime(type) && !isImageByExt(file.name)) return file;
    if (/svg/.test(type) || /\.svg$/i.test(file.name)) return file;
    if (file.size && file.size < 200 * 1024) return file; // already small
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read fail'));
        r.readAsDataURL(file);
      });
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('decode fail'));
        i.src = dataUrl;
      });
      const MAX_W = 1280;
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) return file;
      if (w > MAX_W) {
        h = Math.round(h * (MAX_W / w));
        w = MAX_W;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.80));
      if (!blob || blob.size >= file.size) return file; // no gain
      const baseName = String(file.name || 'image').replace(/\.[a-zA-Z0-9]+$/, '');
      return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } catch (_e) {
      return file;
    }
  }
  window.__compressImageFile = compressImageFile;

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1A + 1C + 1D — wrap processAttachmentFiles to:
  //  - Show upload progress on the Upload button.
  //  - Compress images before passing through.
  //  - Retry once silently on first-attempt failure (session warmup).
  // ═══════════════════════════════════════════════════════════════════════════
  function setUploadButtonsBusy(busy, label) {
    document.querySelectorAll('.attachment-upload-btn, .attachment-upload-btn-bulk, button[data-upload-textarea-id]').forEach(btn => {
      if (busy) {
        if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = label || 'Uploading…';
      } else {
        btn.disabled = false;
        if (btn.dataset.origText) { btn.textContent = btn.dataset.origText; delete btn.dataset.origText; }
      }
    });
  }

  // Wait for the session to be ready before allowing the very first upload to fire.
  async function waitForSessionReady(maxMs) {
    const start = Date.now();
    while (!window._sessionReady && (Date.now() - start) < (maxMs || 3000)) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  function tryWrapProcessAttachments() {
    if (typeof window.processAttachmentFiles !== 'function' || window.__procAttPatched) return;
    const prev = window.processAttachmentFiles;
    window.processAttachmentFiles = async function(files, target) {
      try {
        // Issue 1A: ensure the auth session has settled before attempting upload.
        await waitForSessionReady(3000);
        // Issue 1C: compress images (best-effort) before pass-through.
        let list = Array.from(files || []).filter(Boolean);
        setUploadButtonsBusy(true, 'Processing…');
        const processed = [];
        for (const f of list) {
          try { processed.push(await compressImageFile(f)); }
          catch (_e) { processed.push(f); }
        }
        setUploadButtonsBusy(true, 'Uploading…');
        // Issue 1A: retry once on failure (covers Supabase cold-start / first-token race).
        try {
          return await prev.call(this, processed, target);
        } catch (err) {
          await new Promise(r => setTimeout(r, 1500));
          try { return await prev.call(this, processed, target); }
          catch (err2) {
            if (typeof toast === 'function') toast('Upload failed: ' + (err2.message || err2), 'error');
            throw err2;
          }
        }
      } finally {
        setUploadButtonsBusy(false);
      }
    };
    window.__procAttPatched = true;
  }
  // processAttachmentFiles is defined inside an earlier IIFE and exposed on window
  // only after DOMContentLoaded. Retry the wrap until it appears.
  let __procAttTries = 0;
  const __procAttIv = setInterval(() => {
    tryWrapProcessAttachments();
    if (window.__procAttPatched || ++__procAttTries > 60) clearInterval(__procAttIv);
  }, 250);
  tryWrapProcessAttachments();

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1D + 1E — Larger image preview ABOVE the Submit Question textarea,
  // with instant local objectURL and a Remove button. Replaces the small
  // thumbnail card for the Submit page specifically (other contexts keep the
  // original chip layout).
  // ═══════════════════════════════════════════════════════════════════════════
  const SUBMIT_PREVIEW_ID = 'submit-attachment-preview-large';
  function ensureSubmitPreviewContainer() {
    const ta = document.getElementById('f-question');
    if (!ta) return null;
    let box = document.getElementById(SUBMIT_PREVIEW_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = SUBMIT_PREVIEW_ID;
      box.className = 'submit-attachment-preview-large';
      box.style.cssText = 'display:none;margin:0 0 10px 0;';
      ta.parentNode.insertBefore(box, ta);
    }
    return box;
  }
  function localUrlMap() {
    if (!window.__localPreviewUrls) window.__localPreviewUrls = new Map();
    return window.__localPreviewUrls;
  }
  function renderLargeSubmitPreview() {
    const box = ensureSubmitPreviewContainer();
    if (!box) return;
    const ta = document.getElementById('f-question');
    if (!ta) return;
    const id = ta.dataset.attachmentId;
    const items = (window.__ATTACHMENT_STATE_READ && window.__ATTACHMENT_STATE_READ(id)) || [];
    if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const html = items.map((item, idx) => {
      const isImg = isImageMime(item.type) || isImageByExt(item.name);
      const src = (item.localUrl || item.url || '');
      const displayName = String(item.name || '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const thumb = isImg
        ? `<img src="${esc(src)}" alt="" style="max-width:100%;max-height:280px;border-radius:8px;display:block;margin:0 auto;">`
        : `<div style="padding:24px;background:var(--surface2,#f3f4f6);border-radius:8px;text-align:center;font-size:14px;color:var(--text2,#666)">📎 ${esc(displayName || 'Attachment')}</div>`;
      return `<div class="submit-att-card" data-att-idx="${idx}" data-att-id="${esc(item.id || '')}" style="position:relative;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--surface,#fff);margin-bottom:8px;">
        ${thumb}
        <button type="button" class="submit-att-remove-btn" data-att-id="${esc(item.id || '')}" title="Remove image"
          style="position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(0,0,0,0.15);background:rgba(255,255,255,0.95);cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.15);">✕</button>
        ${item.uploading ? `<div style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.6);color:#fff;padding:3px 8px;border-radius:12px;font-size:11px">Uploading…</div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = html;
    box.style.display = 'block';
    // Wire remove buttons.
    box.querySelectorAll('.submit-att-remove-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        const aid = btn.dataset.attId;
        if (typeof window.removeAttachmentFromState === 'function') {
          window.removeAttachmentFromState(ta.dataset.attachmentId, aid);
        }
        renderLargeSubmitPreview();
      };
    });
  }
  window.renderLargeSubmitPreview = renderLargeSubmitPreview;

  // Hide the small chip strip on the Submit page (1E: replaced by the large preview above).
  const submitPreviewStyle = document.createElement('style');
  submitPreviewStyle.textContent = `
    #page-submit #single-mode-wrap .attachment-preview-strip { display: none !important; }
    .submit-attachment-preview-large { animation: fadeIn 0.15s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    /* Nav avatar with photo */
    #nav-avatar.has-photo { background: transparent !important; padding: 0 !important; overflow: hidden; }
    /* Profile picture in chat */
    .collab-msg-avatar.has-photo,
    .mention-suggestion-avatar.has-photo { background: transparent !important; overflow: hidden; }
    /* Access denied panel */
    #review-table-wrap .empty .empty-icon { font-size: 36px; opacity: 0.6; }
    /* Read-only channel notice */
    .channel-readonly-notice { padding: 14px 18px; background: var(--surface2, #f3f4f6); border-top: 1px solid var(--border, #e5e7eb); color: var(--text2, #666); font-size: 13px; text-align: center; }
    .channel-readonly-notice strong { color: var(--text, #111); }
    /* Attachment indicator on question table cells */
    .td-q-att-hint { display:inline-block;font-size:11px;color:var(--accent2,#457b9d);background:rgba(69,123,157,0.1);padding:2px 6px;border-radius:10px;margin-right:6px;font-weight:600; }
  `;
  document.head.appendChild(submitPreviewStyle);

  // ═══════════════════════════════════════════════════════════════════════════
  // Bridge into ATTACHMENT_STATE (defined inside an earlier IIFE).
  // We re-expose minimal helpers so finalFixBundle can read/remove pending items.
  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENT_STATE is a Map captured inside an earlier IIFE. We hook via the
  // public API: renderAttachmentPreview reads the map and DOM-renders, so we
  // can mirror its data by re-reading the DOM strip. But cleaner: expose tiny
  // bridge functions from the earlier IIFE via window injection. We rely on
  // window.processAttachmentFiles already existing; the state map can be
  // accessed via the attachment-preview-strip DOM if needed. For a clean API,
  // we also patch ensureAttachmentPreview to mirror state into a window getter.
  if (typeof window.__ATTACHMENT_STATE_READ !== 'function') {
    // Mirror state via DOM as a fallback.
    window.__ATTACHMENT_STATE_READ = function(id) {
      const strip = document.getElementById(`attachment-preview-${id}`);
      if (!strip) return [];
      return Array.from(strip.querySelectorAll('[data-attachment-id]')).map(el => ({
        id: el.dataset.attachmentId,
        name: (el.querySelector('.attachment-preview-name') || {}).textContent || el.getAttribute('data-name') || '',
        url: el.getAttribute('data-url') || '',
        type: el.getAttribute('data-type') || '',
        uploading: el.classList.contains('is-uploading'),
        localUrl: el.getAttribute('data-local-url') || ''
      }));
    };
  }
  if (typeof window.removeAttachmentFromState !== 'function') {
    window.removeAttachmentFromState = function(textareaId, attId) {
      // Simulate a click on the small strip's remove button to reuse existing logic.
      const strip = document.getElementById(`attachment-preview-${textareaId}`);
      if (!strip) return;
      const node = strip.querySelector(`[data-attachment-id="${CSS.escape(attId)}"] .attachment-remove`);
      if (node) node.click();
    };
  }

  // Mirror renderAttachmentPreview into our large preview for the submit textarea.
  function patchSubmitRenderer() {
    if (window.__submitRendererPatched) return;
    const origRender = window.renderAttachmentPreview;
    if (typeof origRender !== 'function') return;
    window.renderAttachmentPreview = function(textarea) {
      const result = origRender.apply(this, arguments);
      try {
        if (textarea && textarea.id === 'f-question') {
          renderLargeSubmitPreview();
        }
      } catch (_e) {}
      return result;
    };
    window.__submitRendererPatched = true;
  }
  let __submitRTries = 0;
  const __submitRIv = setInterval(() => {
    patchSubmitRenderer();
    if (window.__submitRendererPatched || ++__submitRTries > 60) clearInterval(__submitRIv);
  }, 250);
  patchSubmitRenderer();

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1F (display) — renderQuestionAttachmentsBlock for review modal,
  // and post-render hint for All Questions / Review table .td-q cells.
  // ═══════════════════════════════════════════════════════════════════════════
  window.renderQuestionAttachmentsBlock = function(q) {
    const atts = Array.isArray(q && q.attachments) ? q.attachments : [];
    if (!atts.length) {
      // Legacy: question text may still contain [Attachment: name](url) tokens
      // for older rows from before migration 0003 was applied. Render those
      // inline (existing enhanceAll / renderMentionedText handle that path).
      return '';
    }
    const items = atts.map(a => {
      const url = String(a.url || '');
      const name = String(a.name || 'Attachment');
      const isImg = isImageMime(a.type) || isImageByExt(name);
      if (isImg) {
        return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;margin:6px 8px 0 0;border-radius:8px;overflow:hidden;border:1px solid var(--border,#e5e7eb);max-width:280px"><img src="${esc(url)}" alt="${esc(name)}" style="max-width:100%;max-height:200px;display:block"></a>`;
      }
      return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;margin:6px 8px 0 0;border-radius:8px;border:1px solid var(--border,#e5e7eb);text-decoration:none;color:var(--text,#111);background:var(--surface,#fff)">📎 ${esc(name)}</a>`;
    }).join('');
    return `<div class="detail-block"><div class="detail-label">Attachments</div><div style="display:flex;flex-wrap:wrap;align-items:flex-start">${items}</div></div>`;
  };

  // Post-render attachment hint for table cells. Watches the active page only
  // (works alongside the page-scoped enhanceAll fix in 3B/4B).
  function paintTableAttachmentHints() {
    try {
      const active = document.querySelector('.page.active');
      if (!active) return;
      // For All Questions
      if (active.id === 'page-allq' && Array.isArray(window.allQData)) {
        active.querySelectorAll('#allq-table-wrap tr[data-task-id]').forEach(tr => {
          const taskId = tr.dataset.taskId;
          const q = window.allQData.find(x => x.task_id === taskId);
          paintHintForRow(tr, q);
        });
      } else if (active.id === 'page-review' && Array.isArray(window.allQuestions)) {
        active.querySelectorAll('#review-table-wrap tbody tr').forEach(tr => {
          const idMatch = (tr.getAttribute('onclick') || '').match(/openModal\('([^']+)'\)/);
          if (!idMatch) return;
          const q = window.allQuestions.find(x => x.id === idMatch[1]);
          paintHintForRow(tr, q);
        });
      }
    } catch (_e) {}
  }
  function paintHintForRow(tr, q) {
    if (!tr || !q) return;
    const cell = tr.querySelector('.td-q');
    if (!cell || cell.querySelector('.td-q-att-hint')) return;
    const n = Array.isArray(q.attachments) ? q.attachments.length : 0;
    if (!n) return;
    const hint = document.createElement('span');
    hint.className = 'td-q-att-hint';
    hint.textContent = `📎 ${n}`;
    cell.insertBefore(hint, cell.firstChild);
  }
  // Run after each render via setTimeout chained off renderAllQ/renderReviewTable wrappers.
  ['renderAllQ', 'renderReviewTable'].forEach(fnName => {
    const fn = window[fnName];
    if (typeof fn !== 'function') return;
    window[fnName] = function() {
      const result = fn.apply(this, arguments);
      setTimeout(paintTableAttachmentHints, 60);
      return result;
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 2E — Profile picture upload UI in the profile settings modal,
  // plus display in Team Chat messages and @mention dropdown.
  // ═══════════════════════════════════════════════════════════════════════════
  const PROFILE_BUCKET = 'profile-pictures';
  const PROFILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  const PROFILE_ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

  async function compressForAvatar(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read fail'));
        r.readAsDataURL(file);
      });
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('decode fail'));
        i.src = dataUrl;
      });
      const SIZE = 256;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      // Center-crop square.
      const min = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - min) / 2;
      const sy = (img.naturalHeight - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
      if (!blob) return file;
      return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
    } catch (_e) {
      return file;
    }
  }

  window.uploadProfilePicture = async function(fileInput) {
    if (!currentUser) { toast && toast('Please sign in first', 'error'); return; }
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > PROFILE_MAX_BYTES) { toast && toast('Profile picture must be 2 MB or less', 'error'); return; }
    if (!PROFILE_ALLOWED.includes(String(file.type).toLowerCase())) {
      toast && toast('Use JPG, PNG, or WEBP', 'error'); return;
    }
    const btn = document.getElementById('profile-pic-upload-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      const compressed = await compressForAvatar(file);
      const ext = (compressed.type === 'image/jpeg' || /\.jpe?g$/i.test(compressed.name)) ? 'jpg'
                : (compressed.type === 'image/png' || /\.png$/i.test(compressed.name)) ? 'png'
                : 'webp';
      const path = `${currentUser.id}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from(PROFILE_BUCKET).upload(path, compressed, {
        cacheControl: '3600', upsert: true, contentType: compressed.type
      });
      if (upErr) throw upErr;
      const { data: pub } = sb.storage.from(PROFILE_BUCKET).getPublicUrl(path);
      const publicUrl = pub && pub.publicUrl;
      if (!publicUrl) throw new Error('Could not resolve public URL');
      // Cache-bust so the new picture is visible immediately.
      const finalUrl = publicUrl + '?t=' + Date.now();
      const { error: dbErr } = await sb.from('collab_profiles')
        .update({ profile_picture_url: finalUrl, updated_at: new Date().toISOString() })
        .eq('email', currentUser.email);
      if (dbErr) throw dbErr;
      // Refresh cached profile and nav.
      if (typeof loadCollabUsers === 'function') await loadCollabUsers(true);
      if (typeof refreshCurrentIdentityUI === 'function') refreshCurrentIdentityUI();
      toast && toast('✓ Profile picture updated', 'success');
      const preview = document.getElementById('profile-pic-current-preview');
      if (preview) preview.innerHTML = `<img src="${esc(finalUrl)}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--border,#e5e7eb)">`;
    } catch (err) {
      toast && toast('Could not upload profile picture: ' + (err.message || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload picture'; }
      if (fileInput) fileInput.value = '';
    }
  };

  window.removeProfilePicture = async function() {
    if (!currentUser) return;
    if (!confirm('Remove your profile picture?')) return;
    try {
      const { error } = await sb.from('collab_profiles')
        .update({ profile_picture_url: null, updated_at: new Date().toISOString() })
        .eq('email', currentUser.email);
      if (error) throw error;
      if (typeof loadCollabUsers === 'function') await loadCollabUsers(true);
      if (typeof refreshCurrentIdentityUI === 'function') refreshCurrentIdentityUI();
      const preview = document.getElementById('profile-pic-current-preview');
      if (preview) {
        const initials = (typeof collabInitials === 'function')
          ? collabInitials(collabCurrentName())
          : (currentUser.email || 'U').slice(0,1).toUpperCase();
        preview.innerHTML = `<div style="width:96px;height:96px;border-radius:50%;background:var(--accent,#e63946);color:#fff;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:600;border:2px solid var(--border,#e5e7eb)">${esc(initials)}</div>`;
      }
      toast && toast('✓ Profile picture removed', 'success');
    } catch (err) {
      toast && toast('Could not remove profile picture: ' + (err.message || err), 'error');
    }
  };

  // Restructure the profile settings modal: Username primary, Full Name read-only, picture upload.
  function patchOpenProfileSettings() {
    if (window.__profileModalPatched) return;
    if (typeof window.openProfileSettings !== 'function') return;
    const prev = window.openProfileSettings;
    window.openProfileSettings = async function() {
      // Call previous to populate the modal scaffolding (loads existing values).
      const result = await prev.apply(this, arguments);
      try {
        injectProfileModalEnhancements();
      } catch (_e) {}
      return result;
    };
    window.__profileModalPatched = true;
  }

  function injectProfileModalEnhancements() {
    const body = document.getElementById('modal-body');
    if (!body) return;
    // Guard: only run if we're in the profile settings modal (it contains the username field).
    const usernameField = body.querySelector('#profile-custom-username, [data-profile-field="custom_username"], input[name="custom_username"]');
    const fullNameField = body.querySelector('#profile-display-name, [data-profile-field="display_name"], input[name="display_name"]');
    // If our enhancement is already there, skip.
    if (body.querySelector('#profile-pic-upload-section')) return;
    // Resolve current picture from cached COLLAB.
    const myEmail = currentUser && String(currentUser.email).toLowerCase();
    const me = (window.COLLAB && COLLAB.usersByEmail && COLLAB.usersByEmail[myEmail]) || null;
    const picUrl = me && me.profile_picture_url;
    const initials = (typeof collabInitials === 'function' && me)
      ? collabInitials(me.display_name || collabCurrentName())
      : '?';
    const picHtml = picUrl
      ? `<img src="${esc(picUrl)}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--border,#e5e7eb)">`
      : `<div style="width:96px;height:96px;border-radius:50%;background:var(--accent,#e63946);color:#fff;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:600;border:2px solid var(--border,#e5e7eb)">${esc(initials)}</div>`;

    const section = document.createElement('div');
    section.id = 'profile-pic-upload-section';
    section.className = 'detail-block';
    section.style.cssText = 'margin-bottom:18px;padding-bottom:18px;border-bottom:1px dashed var(--border,#e5e7eb);';
    section.innerHTML = `
      <div class="detail-label">Profile Picture</div>
      <div style="display:flex;align-items:center;gap:18px;margin-top:10px;flex-wrap:wrap">
        <div id="profile-pic-current-preview">${picHtml}</div>
        <div style="flex:1;min-width:200px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <label class="btn btn-primary btn-sm" style="cursor:pointer;margin:0">
              <span id="profile-pic-upload-btn-label">Upload picture</span>
              <input type="file" id="profile-pic-upload-input" accept="image/jpeg,image/jpg,image/png,image/webp" style="display:none" onchange="uploadProfilePicture(this)">
            </label>
            ${picUrl ? `<button type="button" class="btn btn-outline btn-sm" onclick="removeProfilePicture()">Remove</button>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text3,#888);margin-top:8px">JPG, PNG, or WEBP. Max 2 MB. Auto-cropped to a square.</div>
        </div>
      </div>
    `;
    body.insertBefore(section, body.firstChild);

    // Reorder: put Username first, Full Name (read-only) second.
    if (usernameField && fullNameField) {
      const uGroup = usernameField.closest('.form-group, .detail-block');
      const fGroup = fullNameField.closest('.form-group, .detail-block');
      if (uGroup && fGroup && uGroup.parentNode === fGroup.parentNode) {
        // Swap order so uGroup comes first.
        const parent = uGroup.parentNode;
        if (uGroup.nextSibling !== fGroup) {
          parent.insertBefore(uGroup, fGroup);
        }
      }
      // Mark Full Name as read-only sourced from Google.
      try {
        fullNameField.readOnly = true;
        fullNameField.disabled = true;
        fullNameField.title = 'Full name comes from your Google account';
        const flabel = fGroup && fGroup.querySelector('.form-label, .detail-label');
        if (flabel && !/google/i.test(flabel.textContent)) flabel.innerHTML = flabel.innerHTML + ' <span style="color:var(--text3,#888);font-weight:400;font-size:11px">(from Google)</span>';
      } catch (_e) {}
    }
  }
  let __profileTries = 0;
  const __profileIv = setInterval(() => {
    patchOpenProfileSettings();
    if (window.__profileModalPatched || ++__profileTries > 60) clearInterval(__profileIv);
  }, 250);
  patchOpenProfileSettings();

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 2E — Team Chat message avatars + @mention dropdown use profile_picture_url.
  // Hooks via the existing enhanceAll cycle: after each render, find every
  // .collab-msg-avatar / .mention-suggestion-avatar that should have a photo and inject one.
  // ═══════════════════════════════════════════════════════════════════════════
  function paintCollabAvatars() {
    try {
      if (!window.COLLAB || !COLLAB.usersByEmail) return;
      // Chat message avatars
      document.querySelectorAll('.collab-msg').forEach(el => {
        const author = el.getAttribute('data-author') || el.getAttribute('data-author-email') || '';
        const u = COLLAB.usersByEmail[String(author).toLowerCase()];
        if (!u || !u.profile_picture_url) return;
        const av = el.querySelector('.collab-msg-avatar');
        if (!av || av.classList.contains('has-photo')) return;
        av.classList.add('has-photo');
        av.innerHTML = `<img src="${esc(u.profile_picture_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
      });
      // @mention dropdown
      document.querySelectorAll('.mention-suggestion').forEach(el => {
        const email = el.getAttribute('data-email') || '';
        const u = COLLAB.usersByEmail[String(email).toLowerCase()];
        if (!u || !u.profile_picture_url) return;
        const av = el.querySelector('.mention-suggestion-avatar');
        if (!av || av.classList.contains('has-photo')) return;
        av.classList.add('has-photo');
        av.innerHTML = `<img src="${esc(u.profile_picture_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
      });
    } catch (_e) {}
  }
  // Wrap renderCollabMessages and related render fns.
  ['renderCollabMessages', 'loadCollabMessages', 'renderMentionSuggestions'].forEach(fnName => {
    const fn = window[fnName];
    if (typeof fn !== 'function') return;
    window[fnName] = function() {
      const r = fn.apply(this, arguments);
      if (r && typeof r.then === 'function') {
        r.then(() => setTimeout(paintCollabAvatars, 30));
      } else {
        setTimeout(paintCollabAvatars, 30);
      }
      return r;
    };
  });
  // Periodic sweep for any avatars missed by the wrappers.
  setInterval(paintCollabAvatars, 2500);

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 5B-3 — Read-only #admin-announcement channel for non-admin users.
  // ═══════════════════════════════════════════════════════════════════════════
  function applyAnnouncementChannelReadonly() {
    const composer = document.querySelector('#page-collab .collab-composer');
    if (!composer) return;
    const currentCh = (typeof collabCurrentChannel === 'function') ? collabCurrentChannel() : null;
    const isAnnouncement = currentCh && String(currentCh.slug || currentCh.name || '').toLowerCase() === 'admin-announcement';
    const userIsAdmin = (typeof isAdmin === 'function') ? isAdmin() : false;
    let notice = document.getElementById('channel-readonly-notice');
    if (isAnnouncement && !userIsAdmin) {
      // Hide composer message input + send button (but keep admin announcement tools visible to admins, which they aren't here).
      const composeRow = composer.querySelector('.collab-compose-row');
      if (composeRow) composeRow.style.display = 'none';
      const hint = composer.querySelector('.form-hint');
      if (hint) hint.style.display = 'none';
      if (!notice) {
        notice = document.createElement('div');
        notice.id = 'channel-readonly-notice';
        notice.className = 'channel-readonly-notice';
        notice.innerHTML = '📢 <strong>This channel is read-only.</strong> Only admins can post announcements. Discuss in <a href="#" onclick="(function(){var g=(window.COLLAB&&COLLAB.channels||[]).find(c=>String(c.slug||c.name||\'\').toLowerCase()===\'general\');if(g&&typeof selectCollabChannel===\'function\')selectCollabChannel(g.id);})();return false;">#general</a>.';
        composer.appendChild(notice);
      }
    } else {
      // Restore composer for any other channel.
      const composeRow = composer.querySelector('.collab-compose-row');
      if (composeRow) composeRow.style.display = '';
      const hint = composer.querySelector('.form-hint');
      if (hint) hint.style.display = '';
      if (notice) notice.remove();
    }
  }
  // Wrap selectCollabChannel to re-evaluate after each channel switch.
  (function wrapSelectCollabChannel() {
    if (typeof window.selectCollabChannel !== 'function' || window.__selectChWrappedFinal) return;
    const prev = window.selectCollabChannel;
    window.selectCollabChannel = async function(id) {
      const r = await prev.apply(this, arguments);
      setTimeout(applyAnnouncementChannelReadonly, 60);
      return r;
    };
    window.__selectChWrappedFinal = true;
  })();
  // Also evaluate when collab page is shown.
  document.addEventListener('DOMContentLoaded', () => setTimeout(applyAnnouncementChannelReadonly, 600));
  setInterval(applyAnnouncementChannelReadonly, 3000);

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1F (legacy fallback) — if old questions still hold [Attachment:](url)
  // tokens in their question text (rows created before 0003 migration applied),
  // the existing renderMentionedText + enhanceAll path already renders them
  // inline. After 0003 migration runs, q.attachments is populated and
  // renderQuestionAttachmentsBlock takes over.
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // ISSUE 1B — Save on tab close / hidden as a safety net.
  // ═══════════════════════════════════════════════════════════════════════════
  window.addEventListener('beforeunload', () => { try { saveDraft && saveDraft(); } catch (_e) {} });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { try { saveDraft && saveDraft(); } catch (_e) {} } });

  // ═══════════════════════════════════════════════════════════════════════════
  // Defensive: ensure Profile button stays removed, even if buildNav is called
  // by some other override that re-adds it.
  // ═══════════════════════════════════════════════════════════════════════════
  setInterval(() => {
    const btn = document.getElementById('nav-profile-settings');
    if (btn) btn.remove();
  }, 2000);

})();

// ---- extracted script block 10 ----
(function disableUploadsOutsideTeamChatAndProfile(){
  'use strict';

  function targetTextarea(target) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    try { return document.getElementById(String(target)); } catch (_e) { return null; }
  }

  function isTeamChatTextarea(textarea) {
    if (!textarea) return false;
    var id = String(textarea.id || '');
    return id === 'collab-message-input' ||
           id === 'collab-announcement-text' ||
           id.indexOf('collab-reply-textarea-') === 0 ||
           id.indexOf('collab-edit-textarea-') === 0 ||
           !!textarea.closest('#page-collab');
  }

  function isBlockedTextarea(textarea) {
    if (!textarea) return true;
    if (isTeamChatTextarea(textarea)) return false;
    var id = String(textarea.id || '');
    return id === 'f-question' ||
           id.indexOf('br-q-') === 0 ||
           id === 'm-answer' ||
           id.indexOf('comment-textarea-') === 0 ||
           !!textarea.closest('#page-submit, #page-allq, #page-review, #page-faq, #modal-overlay');
  }

  function safeToast(message) {
    try {
      if (typeof window.toast === 'function') window.toast(message, 'error');
    } catch (_e) {}
  }

  function removeBlockedUploadControls(root) {
    root = root || document;
    var selectors = [
      '.attachment-upload-btn',
      '.attachment-upload-btn-bulk',
      'button[data-upload-textarea-id]',
      'button[onclick*="openAttachmentPicker"]'
    ].join(',');

    root.querySelectorAll(selectors).forEach(function(btn) {
      var targetId = btn.getAttribute('data-upload-textarea-id') || '';
      var onclick = btn.getAttribute('onclick') || '';
      if (!targetId) {
        var m = onclick.match(/openAttachmentPicker\(['\"]([^'\"]+)['\"]\)/);
        if (m) targetId = m[1];
      }
      var ta = targetTextarea(targetId);
      var insideTeamChat = !!btn.closest('#page-collab');
      if (!insideTeamChat && (!ta || isBlockedTextarea(ta))) {
        btn.remove();
      }
    });

    root.querySelectorAll('#page-submit .submit-attachment-preview-large, #page-submit .attachment-preview-strip').forEach(function(el) {
      el.remove();
    });
  }

  function installGuards() {
    if (typeof window.openAttachmentPicker === 'function' && !window.__openAttachmentPickerRestricted) {
      var previousOpenAttachmentPicker = window.openAttachmentPicker;
      window.openAttachmentPicker = function(targetId) {
        var textarea = targetTextarea(targetId);
        if (isBlockedTextarea(textarea)) {
          safeToast('Photo upload is disabled on this page. Uploads are still available in Team Chat and profile picture settings.');
          return;
        }
        return previousOpenAttachmentPicker.apply(this, arguments);
      };
      window.__openAttachmentPickerRestricted = true;
    }

    if (typeof window.processAttachmentFiles === 'function' && !window.__processAttachmentFilesRestricted) {
      var previousProcessAttachmentFiles = window.processAttachmentFiles;
      window.processAttachmentFiles = function(files, target) {
        var textarea = targetTextarea(target);
        if (isBlockedTextarea(textarea)) {
          safeToast('Photo upload is disabled on this page.');
          return;
        }
        return previousProcessAttachmentFiles.apply(this, arguments);
      };
      window.__processAttachmentFilesRestricted = true;
    }

    if (typeof window.takeAttachmentsForTextarea === 'function' && !window.__takeAttachmentsRestricted) {
      var previousTakeAttachmentsForTextarea = window.takeAttachmentsForTextarea;
      window.takeAttachmentsForTextarea = function(textarea) {
        if (isBlockedTextarea(targetTextarea(textarea))) return [];
        return previousTakeAttachmentsForTextarea.apply(this, arguments);
      };
      window.__takeAttachmentsRestricted = true;
    }
  }

  function run() {
    installGuards();
    removeBlockedUploadControls(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  var guardTries = 0;
  var guardInterval = setInterval(function(){
    run();
    guardTries += 1;
    if (guardTries > 80) clearInterval(guardInterval);
  }, 250);

  new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes && Array.prototype.forEach.call(m.addedNodes, function(node) {
        if (node && node.nodeType === 1) removeBlockedUploadControls(node);
      });
    });
    installGuards();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

// Production hardening: browser-level error reporting
window.addEventListener('error', function(event){ console.error('Unhandled app error:', event.error || event.message); if (typeof toast === 'function') toast('Something went wrong. Please refresh or try again.', 'error'); });
window.addEventListener('unhandledrejection', function(event){ console.error('Unhandled async error:', event.reason); if (typeof toast === 'function') toast('Network or app error. Please try again.', 'error'); });
