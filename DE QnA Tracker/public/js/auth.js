(function () {
  'use strict';
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
  function isValidEmail(email) { return emailPattern.test(normalizeEmail(email)); }
  window.AppAuth = { normalizeEmail, isValidEmail };
})();
