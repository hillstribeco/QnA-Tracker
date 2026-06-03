(function () {
  'use strict';

  function skeletonRows(count = 5) {
    return `<div class="skeleton-list">${Array.from({ length: count }).map(() => '<div class="skeleton-row"><div></div><div></div><div></div></div>').join('')}</div>`;
  }

  function emptyState(icon, title, message, actionHtml = '') {
    return `<div class="empty"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${message}</p>${actionHtml}</div>`;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner" style="width:14px;height:14px"></span>${label || 'Working...'}`;
    } else {
      button.disabled = false;
      if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
    }
  }

  window.AppUI = { skeletonRows, emptyState, setBusy };
})();
