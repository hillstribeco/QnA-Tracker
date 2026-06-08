(function () {
  'use strict';

  const CDN = {
    chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
  };

  const loadedScripts = new Map();
  const QUESTION_FIELDS = [
    'id','question_id','task_id','question','issue_field','priority','status','answer',
    'submitter_name','submitter_email','submitted_at','answered_by','answered_date',
    'due_at','is_archived','archived_at','attachments'
  ].join(',');

  const PAGE_SIZE = 500;

  const READ_RETRY_MS = [250, 750, 1500];

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function isRetryable(error) {
    const msg = String(error?.message || error?.hint || error || '').toLowerCase();
    const status = Number(error?.status || error?.code || 0);
    return !status || status === 408 || status === 425 || status === 429 || status >= 500 ||
      msg.includes('fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('temporarily');
  }

  async function withRetry(operation, options = {}) {
    const attempts = Math.max(1, options.attempts || 3);
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await operation();
        if (result?.error && isRetryable(result.error) && attempt < attempts - 1) {
          lastError = result.error;
          await sleep(READ_RETRY_MS[attempt] || READ_RETRY_MS[READ_RETRY_MS.length - 1]);
          continue;
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt >= attempts - 1) throw err;
        await sleep(READ_RETRY_MS[attempt] || READ_RETRY_MS[READ_RETRY_MS.length - 1]);
      }
    }
    return { data: null, error: lastError };
  }

  function patchBuilderRetries(builder) {
    if (!builder || builder.__qnaRetryPatched || typeof builder.then !== 'function') return builder;
    const originalThen = builder.then.bind(builder);
    builder.then = function (onFulfilled, onRejected) {
      return withRetry(() => new Promise((resolve, reject) => originalThen(resolve, reject)), { attempts: 3 }).then(onFulfilled, onRejected);
    };
    builder.__qnaRetryPatched = true;
    return builder;
  }

  function createSupabaseClient(url, anonKey) {
    const client = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const originalFrom = client.from.bind(client);
    client.from = function patchedFrom(...args) {
      const table = originalFrom(...args);
      const methods = ['select','insert','update','upsert','delete'];
      for (const method of methods) {
        if (typeof table[method] !== 'function' || table[`__patched_${method}`]) continue;
        const original = table[method].bind(table);
        table[method] = function (...methodArgs) {
          return patchBuilderRetries(original(...methodArgs));
        };
        table[`__patched_${method}`] = true;
      }
      return table;
    };
    return client;
  }

  function loadScriptOnce(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (loadedScripts.has(src)) return loadedScripts.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve(globalName ? window[globalName] : true);
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
    loadedScripts.set(src, promise);
    return promise;
  }

  async function ensureChart() { return loadScriptOnce(CDN.chart, 'Chart'); }
  async function ensureXLSX() { return loadScriptOnce(CDN.xlsx, 'XLSX'); }

  function debounce(fn, wait = 250) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  window.AppAPI = { QUESTION_FIELDS, PAGE_SIZE, withRetry, createSupabaseClient, ensureChart, ensureXLSX, debounce };
})();
