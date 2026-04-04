(function(window, document) {
  'use strict';

  // === Helpers ===
  function fieldValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function fieldChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function slugify(text) {
    return text.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // === Auth check ===
  const config = window.__APP_CONFIG__ || {};
  if (!config.user) {
    window.location.href = '/auth/login?return_to=/community/profile/edit';
  }

  // === State ===
  let profileData = null;
  let memberProfileData = null;
  let memberBillingData = null;
  let isPersonalAccount = false;
  let userData = null;
  let expertiseTags = [];
  let interestsTags = [];
  let pendingPortraitId = null;
  let toastTimeout = null;
  const portraitOrgParam = new URLSearchParams(window.location.search).get('org');

  // === Init ===
  document.addEventListener('DOMContentLoaded', function() {
    loadProfile();
    document.getElementById('profile-form').addEventListener('submit', handleSubmit);
    document.getElementById('field-slug').addEventListener('input', updateSlugPreview);
    document.getElementById('field-headline').addEventListener('input', updateCharCount);
    setupTagInput('expertise');
    setupTagInput('interests');
    document.getElementById('field-linkedin-url').addEventListener('change', suggestSlugFromLinkedIn);
  });

  // === LinkedIn slug suggestion ===
  function suggestSlugFromLinkedIn() {
    const linkedinUrl = document.getElementById('field-linkedin-url').value.trim();
    const slugField = document.getElementById('field-slug');
    const currentSlug = slugField.value.trim();

    const match = linkedinUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/);
    if (!match) return;

    const linkedinSlug = match[1].toLowerCase();

    const autoSlug = userData
      ? slugify([userData.first_name, userData.last_name].filter(Boolean).join(' '))
      : '';
    if (!currentSlug || currentSlug === autoSlug) {
      slugField.value = linkedinSlug;
      updateSlugPreview();
    }
  }

  // === Billing fetch ===
  async function fetchBillingData(orgId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(function() { controller.abort(); }, 10000);
      const billingResp = await fetch('/api/organizations/' + encodeURIComponent(orgId) + '/billing', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (billingResp.ok) {
        memberBillingData = await billingResp.json();
        if (isPersonalAccount) {
          populateMemberFields(memberProfileData, memberBillingData, false);
        }
      }
    } catch (e) {
      console.warn('Could not load billing info:', e);
    }
  }

  // === Adapt UI for new vs returning members ===
  function adaptForMemberState() {
    const isNew = !profileData || (!profileData.headline && !profileData.bio);
    if (isNew) {
      document.getElementById('new-member-header').style.display = '';
      document.getElementById('returning-member-header').style.display = 'none';
      document.getElementById('addie-setup-section').style.display = '';
      document.getElementById('slug-group').style.display = 'none';
      const about = document.getElementById('section-about');
      if (about) about.open = true;
    } else {
      document.getElementById('new-member-header').style.display = 'none';
      document.getElementById('returning-member-header').style.display = '';
      document.getElementById('addie-setup-section').style.display = 'none';
      document.getElementById('slug-group').style.display = '';
    }
  }

  // === Data fetching ===
  async function loadProfile() {
    try {
      const orgParam = new URLSearchParams(window.location.search).get('org');
      const memberProfileUrl = orgParam
        ? '/api/me/member-profile?org=' + encodeURIComponent(orgParam)
        : '/api/me/member-profile';

      const responses = await Promise.all([
        fetch('/api/me/community/hub'),
        fetch('/api/me'),
        fetch(memberProfileUrl).catch(function() { return null; }),
      ]);
      const hubResponse = responses[0];
      const meResponse = responses[1];
      const memberResponse = responses[2];

      if (!hubResponse.ok) {
        if (hubResponse.status === 401) {
          window.location.href = '/auth/login?return_to=/community/profile/edit';
          return;
        }
        throw new Error('Failed to load profile');
      }

      const data = await hubResponse.json();
      profileData = data.profile || {};

      let billingOrgId = null;
      if (meResponse.ok) {
        const meData = await meResponse.json();
        userData = meData.user || null;
        const orgs = meData.organizations || [];
        if (memberResponse && memberResponse.ok) {
          const memberData = await memberResponse.json();
          memberProfileData = memberData.profile || null;
          const targetOrg = orgs.find(function(o) { return o.id === memberData.organization_id; });
          isPersonalAccount = targetOrg?.is_personal || false;
          billingOrgId = memberData.organization_id || null;
        } else if (orgParam) {
          const targetOrg2 = orgs.find(function(o) { return o.id === orgParam; });
          isPersonalAccount = targetOrg2?.is_personal || false;
          billingOrgId = targetOrg2 ? targetOrg2.id : null;
        }
      }

      populateForm(profileData);
      adaptForMemberState();

      if (isPersonalAccount) {
        document.getElementById('member-directory-section').style.display = 'block';
        populateMemberFields(memberProfileData, memberBillingData, true);
        restructureForIndividual();
      }

      document.getElementById('edit-loading').style.display = 'none';
      document.getElementById('edit-content').style.display = 'block';

      if (billingOrgId) {
        fetchBillingData(billingOrgId);
      }

      initPortraitWidget();
    } catch (error) {
      console.error('Load profile error:', error);
      document.getElementById('edit-loading').innerHTML =
        '<p>Failed to load profile. <a href="/community/profile/edit">Try again</a></p>';
    }
  }

  // === Member fields ===
  function populateMemberFields(memberProfile, billingData, populateFormValues) {
    const isSubscribed = billingData?.subscription?.status === 'active';

    document.getElementById('offering-consulting').disabled = false;
    document.getElementById('offering-other').disabled = false;
    const offeringsHint = document.getElementById('offerings-hint');
    if (offeringsHint) {
      offeringsHint.textContent = '';
      offeringsHint.style.display = 'none';
    }

    if (!memberProfile) {
      const statusEl = document.getElementById('member-directory-status');
      statusEl.style.display = 'block';
      statusEl.style.background = 'var(--color-gray-50)';
      statusEl.style.color = 'var(--color-text-secondary)';
      statusEl.style.border = 'var(--border-1) solid var(--color-gray-200)';

      if (isSubscribed) {
        statusEl.innerHTML = 'Save your profile to create your member directory listing.';
      } else {
        statusEl.innerHTML = 'You don\'t have a member directory listing yet. <a href="/organization#membership" style="color: var(--color-brand); font-weight: var(--font-medium);">Manage organization membership</a> to create one and appear in the directory.';

        document.getElementById('offering-consulting').disabled = true;
        document.getElementById('offering-other').disabled = true;
        if (offeringsHint) {
          offeringsHint.textContent = 'Subscribe to a membership to set your offerings.';
          offeringsHint.style.display = '';
        }
      }
      return;
    }
    if (populateFormValues) {
      const offerings = memberProfile.offerings || [];
      document.getElementById('offering-consulting').checked = offerings.includes('consulting');
      document.getElementById('offering-other').checked = offerings.includes('other');
      document.getElementById('field-contact-email').value = memberProfile.contact_email || '';
      document.getElementById('field-contact-phone').value = memberProfile.contact_phone || '';
      document.getElementById('field-contact-website').value = memberProfile.contact_website || '';
    }

    const statusEl2 = document.getElementById('member-directory-status');
    statusEl2.style.display = 'block';
    if (memberProfile.is_public && isSubscribed) {
      statusEl2.style.background = 'var(--color-success-50)';
      statusEl2.style.color = 'var(--color-success-700)';
      statusEl2.style.border = 'var(--border-1) solid var(--color-success-200)';
      statusEl2.innerHTML = 'Your listing is live at <a href="/members/' + encodeURIComponent(memberProfile.slug) + '" style="color: var(--color-success-700); font-weight: var(--font-medium);">/members/' + escapeHtml(memberProfile.slug) + '</a>';
    } else {
      statusEl2.style.background = 'var(--color-warning-50)';
      statusEl2.style.color = 'var(--color-warning-700)';
      statusEl2.style.border = 'var(--border-1) solid var(--color-warning-200)';
      statusEl2.innerHTML = 'Your listing is not yet visible in the member directory. <a href="/organization#membership" style="color: var(--color-warning-700); font-weight: var(--font-medium);">Manage organization membership</a>.';
    }
  }

  // === Form population ===
  function populateForm(profile) {
    document.getElementById('field-is-public').checked = !!profile.is_public;
    let slug = profile.slug || '';
    if (!slug && userData && userData.first_name) {
      slug = slugify([userData.first_name, userData.last_name].filter(Boolean).join(' '));
    }
    document.getElementById('field-slug').value = slug;
    updateSlugPreview();
    document.getElementById('field-headline').value = profile.headline || '';
    updateCharCount();
    document.getElementById('field-bio').value = profile.bio || '';
    const avatarPreview = document.getElementById('avatar-preview');
    const avatarInfo = document.getElementById('avatar-info');
    if (profile.avatar_url) {
      avatarPreview.innerHTML = '<img src="' + escapeHtml(profile.avatar_url) + '" alt="Profile photo" style="width: 100%; height: 100%; object-fit: cover;">';
      avatarInfo.textContent = '';
    } else {
      avatarPreview.innerHTML = '<span style="font-size: var(--text-xl); color: var(--color-text-muted);">?</span>';
      avatarInfo.textContent = 'No profile photo yet.';
    }

    expertiseTags = (profile.expertise || []).slice();
    interestsTags = (profile.interests || []).slice();
    renderTags('expertise');
    renderTags('interests');

    document.getElementById('field-city').value = profile.city || '';
    document.getElementById('field-linkedin-url').value = profile.linkedin_url || '';
    document.getElementById('field-twitter-url').value = profile.twitter_url || '';
    document.getElementById('field-github-username').value = profile.github_username || '';
    document.getElementById('field-coffee-chat').checked = !!profile.open_to_coffee_chat;
    document.getElementById('field-intros').checked = !!profile.open_to_intros;
  }

  // === Portrait widget ===
  function portraitUrl(path) {
    const base = path ? '/api/me/portrait/' + path : '/api/me/portrait';
    return portraitOrgParam ? base + '?org=' + encodeURIComponent(portraitOrgParam) : base;
  }

  async function initPortraitWidget() {
    const generateEl = document.getElementById('portrait-generate');
    const ineligibleEl = document.getElementById('portrait-ineligible');
    const ineligibleMsg = document.getElementById('portrait-ineligible-msg');
    if (!generateEl) return;

    const url = portraitUrl();

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 402 || resp.status === 404) {
          if (ineligibleEl) ineligibleEl.style.display = '';
          if (ineligibleMsg) ineligibleMsg.textContent =
            'Paid members can generate an illustrated portrait.';
        }
        return;
      }

      const data = await resp.json();
      if (!data.canGenerate) {
        if (ineligibleEl) ineligibleEl.style.display = '';
        if (ineligibleMsg) ineligibleMsg.textContent =
          'Active membership required to generate an illustrated portrait.';
        return;
      }

      const remaining = data.maxMonthlyGenerations - data.generationsThisMonth;

      generateEl.style.display = '';
      const genCountEl = document.getElementById('portrait-gen-count');
      if (genCountEl) {
        genCountEl.textContent = remaining + ' of ' + data.maxMonthlyGenerations + ' generations left this month';
      }

      if (remaining <= 0) {
        const genBtn = document.getElementById('portrait-generate-btn');
        if (genBtn) {
          genBtn.disabled = true;
          genBtn.style.opacity = '0.5';
          genBtn.style.cursor = 'not-allowed';
        }
      }

      initPortraitEvents();

      if (data.pending && data.pending.status === 'generated') {
        showPendingPortrait(data.pending.id, '/api/portraits/' + data.pending.id + '.png');
      }
    } catch (err) {
      console.warn('Portrait widget load failed:', err);
    }
  }

  function initPortraitEvents() {
    const uploadArea = document.getElementById('portrait-upload-area');
    const fileInput = document.getElementById('portrait-photo-input');
    const generateBtn = document.getElementById('portrait-generate-btn');
    const clearLink = document.getElementById('portrait-clear-photo');

    uploadArea.addEventListener('click', function() { fileInput.click(); });
    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      uploadArea.style.borderColor = 'var(--color-brand)';
    });
    uploadArea.addEventListener('dragleave', function() {
      uploadArea.style.borderColor = 'var(--color-border)';
    });
    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      uploadArea.style.borderColor = 'var(--color-border)';
      const file = e.dataTransfer.files[0];
      if (file) {
        fileInput.files = e.dataTransfer.files;
        showPhotoPreview(file);
      }
    });

    fileInput.addEventListener('change', function() {
      if (fileInput.files.length) showPhotoPreview(fileInput.files[0]);
    });

    clearLink.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      fileInput.value = '';
      document.getElementById('portrait-upload-label').style.display = '';
      document.getElementById('portrait-upload-preview').style.display = 'none';
    });

    generateBtn.addEventListener('click', handleGenerate);

    document.getElementById('portrait-approve-btn').addEventListener('click', handleApprove);
    document.getElementById('portrait-retry-btn').addEventListener('click', function() {
      document.getElementById('portrait-pending').style.display = 'none';
      showGeneratePanel();
    });
  }

  function showPhotoPreview(file) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      showToast('Please upload a JPEG or PNG image', 'error');
      document.getElementById('portrait-photo-input').value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('Photo must be under 5MB', 'error');
      document.getElementById('portrait-photo-input').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById('portrait-upload-thumb').src = e.target.result;
      document.getElementById('portrait-upload-label').style.display = 'none';
      document.getElementById('portrait-upload-preview').style.display = '';
    };
    reader.readAsDataURL(file);
  }

  async function handleGenerate() {
    const btn = document.getElementById('portrait-generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    document.getElementById('portrait-generate').style.display = 'none';
    document.getElementById('portrait-generating').style.display = '';

    const url = portraitUrl('generate');

    const formData = new FormData();
    formData.append('vibe', document.getElementById('portrait-vibe-select').value);
    const fileInput = document.getElementById('portrait-photo-input');
    if (fileInput.files.length) {
      formData.append('photo', fileInput.files[0]);
    }

    try {
      const resp = await fetch(url, { method: 'POST', body: formData });
      if (!resp.ok) {
        const err = await resp.json().catch(function() { return {}; });
        throw new Error(err.error || 'Generation failed');
      }
      const data = await resp.json();
      document.getElementById('portrait-generating').style.display = 'none';
      showPendingPortrait(data.id, data.image_url);

      const countEl = document.getElementById('portrait-gen-count');
      const match = countEl.textContent.match(/(\d+) of (\d+)/);
      if (match) {
        const newRemaining = Math.max(0, parseInt(match[1]) - 1);
        countEl.textContent = newRemaining + ' of ' + match[2] + ' generations left this month';
      }
    } catch (err) {
      document.getElementById('portrait-generating').style.display = 'none';
      showGeneratePanel();
      showToast(err.message, 'error');
    }
  }

  function showGeneratePanel() {
    const btn = document.getElementById('portrait-generate-btn');
    btn.disabled = false;
    btn.textContent = 'Generate portrait';
    document.getElementById('portrait-generate').style.display = '';
  }

  function showPendingPortrait(id, imageUrl) {
    if (!imageUrl.startsWith('/api/portraits/')) {
      console.warn('Unexpected portrait URL:', imageUrl);
      return;
    }
    pendingPortraitId = id;
    document.getElementById('portrait-pending-img').src = imageUrl;
    document.getElementById('portrait-pending').style.display = '';
  }

  async function handleApprove() {
    if (!pendingPortraitId) return;
    const approveBtn = document.getElementById('portrait-approve-btn');
    approveBtn.disabled = true;
    approveBtn.textContent = 'Saving...';

    const url = portraitUrl('approve');

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portraitId: pendingPortraitId }),
      });
      if (!resp.ok) throw new Error('Failed to approve');

      const avatarPreview = document.getElementById('avatar-preview');
      const img = document.createElement('img');
      img.src = '/api/portraits/' + encodeURIComponent(pendingPortraitId) + '.png';
      img.alt = 'Profile photo';
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      avatarPreview.textContent = '';
      avatarPreview.appendChild(img);
      document.getElementById('avatar-info').textContent = '';

      document.getElementById('portrait-pending').style.display = 'none';
      showGeneratePanel();
      showToast('Portrait saved', 'success');
    } catch (err) {
      approveBtn.disabled = false;
      approveBtn.textContent = 'Use this';
      showToast('Failed to save portrait', 'error');
    }
  }

  // === Tag management ===
  function getTagState(type) {
    if (type === 'expertise') return { tags: expertiseTags, cssClass: 'tag--expertise' };
    return { tags: interestsTags, cssClass: 'tag--interest' };
  }

  function renderTags(type) {
    const state = getTagState(type);
    const container = document.getElementById(type + '-container');
    const input = document.getElementById(type + '-input');

    container.querySelectorAll('.tag').forEach(function(el) { el.remove(); });

    state.tags.forEach(function(tag, index) {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag ' + state.cssClass;
      tagEl.innerHTML = escapeHtml(tag) +
        '<button type="button" class="tag-remove" aria-label="Remove ' + escapeHtml(tag) + '">&times;</button>';

      tagEl.querySelector('.tag-remove').addEventListener('click', function() {
        removeTag(type, index);
      });

      container.insertBefore(tagEl, input);
    });
  }

  function addTag(type, value) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return;

    const state = getTagState(type);
    if (state.tags.includes(trimmed)) return;

    state.tags.push(trimmed);
    renderTags(type);
  }

  function removeTag(type, index) {
    const state = getTagState(type);
    state.tags.splice(index, 1);
    renderTags(type);
  }

  function setupTagInput(type) {
    const input = document.getElementById(type + '-input');
    const container = document.getElementById(type + '-container');

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = input.value.replace(/,/g, '');
        addTag(type, val);
        input.value = '';
      }
      if (e.key === 'Backspace' && input.value === '') {
        const state = getTagState(type);
        if (state.tags.length > 0) {
          removeTag(type, state.tags.length - 1);
        }
      }
    });

    input.addEventListener('paste', function(e) {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      text.split(',').forEach(function(item) { addTag(type, item); });
    });

    container.addEventListener('click', function() { input.focus(); });
  }

  // === Slug preview ===
  function updateSlugPreview() {
    const value = document.getElementById('field-slug').value.trim();
    document.getElementById('slug-preview-value').textContent = value || '...';
  }

  // === Character count ===
  function updateCharCount() {
    const input = document.getElementById('field-headline');
    const counter = document.getElementById('headline-char-count');
    const len = input.value.length;
    counter.textContent = len + ' / 255';
    counter.className = len > 255 ? 'form-char-count form-char-count--over' : 'form-char-count';
  }

  // === Form submission ===
  async function handleSubmit(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const requiredEls = ['field-is-public', 'field-slug'];
      const missingEls = requiredEls.filter(function(id) { return !document.getElementById(id); });
      if (missingEls.length > 0) {
        throw new Error('Page error: missing form fields. Please reload and try again.');
      }

      const payload = {
        is_public: fieldChecked('field-is-public'),
        slug: fieldValue('field-slug') || undefined,
        headline: fieldValue('field-headline') || undefined,
        bio: fieldValue('field-bio') || undefined,
        expertise: expertiseTags,
        interests: interestsTags,
        city: fieldValue('field-city') || undefined,
        linkedin_url: fieldValue('field-linkedin-url') || undefined,
        twitter_url: fieldValue('field-twitter-url') || undefined,
        github_username: fieldValue('field-github-username') || undefined,
        open_to_coffee_chat: fieldChecked('field-coffee-chat'),
        open_to_intros: fieldChecked('field-intros'),
      };

      if (isPersonalAccount) {
        const offerings = [];
        if (fieldChecked('offering-consulting')) offerings.push('consulting');
        if (fieldChecked('offering-other')) offerings.push('other');
        payload.offerings = offerings;
        payload.contact_email = fieldValue('field-contact-email') || undefined;
        payload.contact_phone = fieldValue('field-contact-phone') || undefined;
        payload.contact_website = fieldValue('field-contact-website') || undefined;
      }

      const response = await fetch('/api/me/community-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(function() { return null; });
        throw new Error(errorData?.error || 'Failed to save profile');
      }

      showToast('Profile saved', 'success');
    } catch (error) {
      console.error('Save error:', error);
      showToast(error?.message || 'Failed to save profile', 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    }
  }

  // === Toast ===
  function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast toast--' + type;
    void toast.offsetWidth;
    toast.classList.add('toast--visible');

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function() {
      toast.classList.remove('toast--visible');
    }, 3000);
  }

  // === DOM restructure for individual accounts ===
  function restructureForIndividual() {
    const form = document.getElementById('profile-form');
    const saveBar = form.querySelector('.save-bar');

    document.querySelector('.edit-title').textContent = 'Your profile';
    const orgParam = new URLSearchParams(window.location.search).get('org');
    if (orgParam) {
      const dashboardUrl = '/organization?org=' + encodeURIComponent(orgParam);
      const backLink = document.getElementById('back-link');
      if (backLink) {
        backLink.href = dashboardUrl;
        backLink.lastChild.textContent = ' Back to organization';
      }
      const cancelLink = document.getElementById('cancel-link');
      if (cancelLink) cancelLink.href = dashboardUrl;
    }

    const visibilitySection = document.getElementById('section-visibility');
    const aboutSection = document.getElementById('section-about');
    const socialSection = document.getElementById('section-social');
    const prefsSection = document.getElementById('section-preferences');
    const memberDirSection = document.getElementById('member-directory-section');
    if (!visibilitySection || !aboutSection || !socialSection || !prefsSection || !memberDirSection) {
      console.warn('restructureForIndividual: missing section element, skipping');
      return;
    }

    const slugField = document.getElementById('field-slug');
    if (!slugField) return;
    const slugGroup = slugField.closest('.form-group');
    const slugPreview = slugGroup.querySelector('.slug-preview');

    const expertiseEl = document.getElementById('expertise-container');
    const interestsEl = document.getElementById('interests-container');
    const cityEl = document.getElementById('field-city');
    if (!expertiseEl || !interestsEl || !cityEl) return;
    const expertiseGroup = expertiseEl.closest('.form-group');
    const interestsGroup = interestsEl.closest('.form-group');
    const cityGroup = cityEl.closest('.form-group');

    const offeringsGroup = document.getElementById('offering-consulting')?.closest('.form-group');

    const contactEmail = document.getElementById('field-contact-email')?.closest('.form-group');
    const contactPhone = document.getElementById('field-contact-phone')?.closest('.form-group');
    const contactWebsite = document.getElementById('field-contact-website')?.closest('.form-group');

    const visibilityToggle = visibilitySection.querySelector('.toggle-row');
    if (visibilityToggle) {
      const toggleLabel = visibilityToggle.querySelector('.toggle-label');
      const toggleDesc = visibilityToggle.querySelector('.toggle-description');
      if (toggleLabel) toggleLabel.textContent = 'Show in directories';
      if (toggleDesc) toggleDesc.innerHTML = 'Make your profile visible in the <a href="/community/people">community directory</a> and, with an active <a href="/organization#membership">membership</a>, the <a href="/members">member directory</a>.';
    }

    const statusEl = document.getElementById('member-directory-status');

    // Section 1: About you
    slugGroup.remove();
    expertiseGroup.remove();
    interestsGroup.remove();
    cityGroup.remove();
    aboutSection.appendChild(cityGroup);

    // Section 2: Expertise and interests
    const expertiseSection = document.createElement('div');
    expertiseSection.className = 'edit-section';
    const expertiseTitle = document.createElement('h2');
    expertiseTitle.className = 'edit-section-title';
    expertiseTitle.textContent = 'Expertise and interests';
    expertiseSection.appendChild(expertiseTitle);
    expertiseSection.appendChild(expertiseGroup);
    expertiseSection.appendChild(interestsGroup);
    if (offeringsGroup) {
      offeringsGroup.querySelector('.form-label').textContent = 'What do you offer?';
      expertiseSection.appendChild(offeringsGroup);
    }

    // Section 3: Public listing
    const publicListingSection = document.createElement('div');
    publicListingSection.className = 'edit-section';
    const listingTitle = document.createElement('h2');
    listingTitle.className = 'edit-section-title';
    listingTitle.textContent = 'Public listing';
    publicListingSection.appendChild(listingTitle);

    const listingDesc = document.createElement('p');
    listingDesc.className = 'edit-section-description';
    listingDesc.innerHTML = 'Your name, photo, and bio appear in both the <a href="/members">member directory</a> and <a href="/community/people">community directory</a>. Contact details and offerings are shown only in the member directory.';
    publicListingSection.appendChild(listingDesc);

    if (statusEl) publicListingSection.appendChild(statusEl);

    if (visibilityToggle) {
      const toggleGroup = document.createElement('div');
      toggleGroup.className = 'form-group';
      toggleGroup.appendChild(visibilityToggle);
      publicListingSection.appendChild(toggleGroup);
    }

    if (contactEmail) publicListingSection.appendChild(contactEmail);
    if (contactWebsite) publicListingSection.appendChild(contactWebsite);
    if (contactPhone) publicListingSection.appendChild(contactPhone);

    slugGroup.querySelector('.form-label').textContent = 'URL slug';
    if (slugPreview) {
      slugPreview.innerHTML = 'agenticadvertising.org/members/<strong id="slug-preview-value">' + escapeHtml(slugField.value || '...') + '</strong>';
    }
    publicListingSection.appendChild(slugGroup);

    const previewLink = document.createElement('p');
    previewLink.id = 'listing-preview-link';
    previewLink.className = 'edit-section-description';
    previewLink.style.marginTop = 'var(--space-4)';
    previewLink.style.marginBottom = '0';
    publicListingSection.appendChild(previewLink);

    function updatePreviewLink() {
      const slug = slugField.value.trim();
      if (slug) {
        previewLink.innerHTML = '<a href="/members/' + encodeURIComponent(slug) + '">Preview your listing &rarr;</a>';
        previewLink.style.display = '';
      } else {
        previewLink.style.display = 'none';
      }
    }
    slugField.addEventListener('input', updatePreviewLink);
    updatePreviewLink();

    // Section 4: Networking
    prefsSection.querySelector('.edit-section-title').textContent = 'Networking';

    // Remove old sections and reassemble
    visibilitySection.remove();
    memberDirSection.remove();

    const portraitSection = document.getElementById('section-portrait-and-addie');
    const addieSection = document.getElementById('addie-setup-section');

    Array.from(form.querySelectorAll('.edit-section')).forEach(function(s) { s.remove(); });

    const newOrder = [portraitSection, addieSection, aboutSection, expertiseSection, publicListingSection, socialSection, prefsSection].filter(Boolean);
    newOrder.forEach(function(section) {
      form.insertBefore(section, saveBar);
    });

    // Verify all form fields survived the restructure
    const expectedIds = [
      'field-is-public', 'field-slug', 'field-headline', 'field-bio',
      'field-city', 'field-linkedin-url', 'field-twitter-url',
      'field-github-username', 'field-coffee-chat', 'field-intros',
      'field-contact-email', 'field-contact-phone', 'field-contact-website',
      'portrait-generate', 'offering-consulting', 'offering-other',
    ];
    const missing = expectedIds.filter(function(id) { return !document.getElementById(id); });
    if (missing.length > 0) {
      console.error('restructureForIndividual: fields lost during DOM restructure:', missing);
    }
  }

  // === Test harness ===
  window.ProfileEdit = {
    slugify: slugify,
    escapeHtml: escapeHtml,
    fieldValue: fieldValue,
    fieldChecked: fieldChecked,
    populateForm: populateForm,
    populateMemberFields: populateMemberFields,
    handleSubmit: handleSubmit,
    restructureForIndividual: restructureForIndividual,
    initPortraitWidget: initPortraitWidget,
    adaptForMemberState: adaptForMemberState,
    showToast: showToast,
    // Toggle for testing personal account branching in handleSubmit.
    // Cannot be set via public API without a full loadProfile mock.
    setPersonalAccount: function(val) { isPersonalAccount = val; },
  };
})(window, document);
