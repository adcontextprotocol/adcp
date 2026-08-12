(function (global) {
  'use strict';

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]);

  function normalizeHttpUrl(value, label) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`${label} must be an absolute http:// or https:// URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${label} must be an absolute http:// or https:// URL.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${label} must not include credentials.`);
    }
    return parsed.href;
  }

  function escapeAltText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/([\[\]])/g, '\\$1');
  }

  function normalizeLinkUrl(value) {
    const normalized = normalizeHttpUrl(value, 'Link URL');
    if (normalized && !normalized.startsWith('https:')) {
      throw new Error('Link URL must use https://.');
    }
    return normalized;
  }

  function buildImageMarkdown(imageUrl, altText, linkUrl) {
    const normalizedImageUrl = normalizeHttpUrl(imageUrl, 'Image URL');
    const escapedAlt = escapeAltText(altText);
    if (!escapedAlt) throw new Error('Alt text is required.');

    const image = `![${escapedAlt}](<${normalizedImageUrl}>)`;
    const normalizedLinkUrl = normalizeLinkUrl(linkUrl);
    return normalizedLinkUrl ? `[${image}](<${normalizedLinkUrl}>)` : image;
  }

  function createUploadFilename(originalName, randomUUID) {
    const name = String(originalName || 'image').trim();
    const dot = name.lastIndexOf('.');
    const rawStem = dot > 0 ? name.slice(0, dot) : name;
    const rawExtension = dot > 0 ? name.slice(dot).toLowerCase() : '';
    const stem = rawStem.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
    const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : '';
    const suffix = String(randomUUID()).replace(/[^a-z0-9-]/gi, '').slice(0, 64);
    return `${stem}-${suffix}${extension}`;
  }

  function secureRandomId() {
    if (typeof global.crypto?.randomUUID === 'function') return global.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function insertMarkdown(textarea, markdown, selection) {
    const start = selection?.start ?? textarea.selectionStart ?? textarea.value.length;
    const end = selection?.end ?? textarea.selectionEnd ?? start;
    textarea.value = `${textarea.value.slice(0, start)}${markdown}${textarea.value.slice(end)}`;
    const caret = start + markdown.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    return caret;
  }

  async function uploadImage({
    file,
    slug,
    altText,
    linkUrl,
    fetchImpl = global.fetch,
    FormDataImpl = global.FormData,
    randomUUID = secureRandomId,
    signal,
  }) {
    if (!slug) throw new Error('Save this article as a draft before adding images.');
    if (!file) throw new Error('Choose an image to upload.');
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      throw new Error('Choose a JPEG, PNG, WebP, or GIF image.');
    }
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Image files must be under 10MB.');
    if (!escapeAltText(altText)) throw new Error('Alt text is required.');
    const normalizedLinkUrl = normalizeLinkUrl(linkUrl);

    const formData = new FormDataImpl();
    formData.append('file', file, createUploadFilename(file.name, randomUUID));
    formData.append('asset_type', 'attachment');
    const requestOptions = {
      method: 'POST',
      credentials: 'include',
      body: formData,
    };
    if (signal) requestOptions.signal = signal;
    const response = await fetchImpl(`/api/content/${encodeURIComponent(slug)}/assets`, requestOptions);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your session expired. Sign in and try again.');
      if (response.status === 403) throw new Error('You do not have permission to add images to this article.');
      if (response.status === 404) throw new Error('This article no longer exists. Refresh and try again.');
      throw new Error(body.message || body.error || 'Image upload failed.');
    }
    if (!body.asset?.url) throw new Error('The upload succeeded but did not return an image URL.');
    return {
      markdown: buildImageMarkdown(body.asset.url, altText, normalizedLinkUrl),
      asset: body.asset,
    };
  }

  function mount(options) {
    const trigger = document.getElementById(options.triggerButtonId);
    const panel = document.getElementById(options.panelId);
    const fileInput = document.getElementById(options.fileInputId);
    const altInput = document.getElementById(options.altInputId);
    const linkInput = document.getElementById(options.linkInputId);
    const submit = document.getElementById(options.submitButtonId);
    const cancel = document.getElementById(options.cancelButtonId);
    const status = document.getElementById(options.statusId);
    const hint = document.getElementById(options.hintId);
    const textarea = document.getElementById(options.textareaId);
    let insertionPoint = null;
    let uploadGeneration = 0;
    let activeController = null;

    function refresh() {
      const enabled = Boolean(options.getSlug());
      trigger.disabled = !enabled;
      trigger.title = enabled ? 'Upload an image and insert it at the cursor' : 'Save as a draft before adding images';
      hint.textContent = enabled
        ? 'Images are inserted at the current cursor position.'
        : 'Save as a draft before adding images.';
    }

    function close() {
      uploadGeneration += 1;
      activeController?.abort();
      activeController = null;
      insertionPoint = null;
      fileInput.value = '';
      altInput.value = '';
      linkInput.value = '';
      submit.disabled = false;
      submit.textContent = 'Upload and insert';
      panel.classList.add('hidden');
      status.textContent = '';
      status.classList.remove('error');
    }

    trigger.addEventListener('click', () => {
      refresh();
      if (trigger.disabled) return;
      insertionPoint = { start: textarea.selectionStart, end: textarea.selectionEnd };
      status.textContent = '';
      panel.classList.remove('hidden');
      fileInput.focus();
    });
    cancel.addEventListener('click', close);
    submit.addEventListener('click', async () => {
      const generation = ++uploadGeneration;
      const slug = options.getSlug();
      const controller = new global.AbortController();
      activeController?.abort();
      activeController = controller;
      submit.disabled = true;
      submit.textContent = 'Uploading…';
      status.textContent = '';
      try {
        const result = await uploadImage({
          file: fileInput.files?.[0],
          slug,
          altText: altInput.value,
          linkUrl: linkInput.value,
          signal: controller.signal,
        });
        if (generation !== uploadGeneration || slug !== options.getSlug()) return;
        insertMarkdown(textarea, result.markdown, insertionPoint);
        insertionPoint = { start: textarea.selectionStart, end: textarea.selectionEnd };
        fileInput.value = '';
        altInput.value = '';
        linkInput.value = '';
        status.textContent = 'Image inserted. Save changes to keep it in the article.';
        status.classList.remove('error');
      } catch (error) {
        if (generation !== uploadGeneration || error?.name === 'AbortError') return;
        status.textContent = error instanceof Error ? error.message : 'Image upload failed.';
        status.classList.add('error');
      } finally {
        if (generation === uploadGeneration) {
          activeController = null;
          submit.disabled = false;
          submit.textContent = 'Upload and insert';
        }
      }
    });

    refresh();
    return { refresh, close };
  }

  global.ContentImageUpload = {
    MAX_IMAGE_BYTES,
    buildImageMarkdown,
    createUploadFilename,
    insertMarkdown,
    mount,
    normalizeHttpUrl,
    uploadImage,
  };
})(typeof window !== 'undefined' ? window : globalThis);
