(function () {
  'use strict';

  function normalizePreference(value) {
    return value === 'gemini' || value === 'sonnet' ? value : 'default';
  }

  function modelName(model) {
    if (typeof model !== 'string' || !model) return 'Model not recorded';
    const gemini = model.match(/^gemini-(\d+\.\d+)/);
    if (gemini) return `Gemini ${gemini[1]}`;
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('haiku')) return 'Haiku';
    if (model.includes('opus')) return 'Opus';
    return model.slice(0, 80);
  }

  function appendInfo(container, info) {
    if (!info) return;
    const badge = document.createElement('div');
    badge.className = 'message-model';
    const actual = info.source === 'local' ? 'System response' : modelName(info.model);
    const requested = info.selected === 'gemini' ? 'Gemini 3.7' : modelName(info.requested_model);
    let label = info.fallback && requested !== actual ? `${requested} → ${actual}` : actual;
    if (Number.isFinite(info.latency_ms) && info.latency_ms >= 0) {
      label += ` · ${(info.latency_ms / 1000).toFixed(1)}s`;
    }
    badge.textContent = label;
    badge.title = `Selected: ${normalizePreference(info.selected)}. ${info.model || actual}`;
    container.insertBefore(badge, container.querySelector('.message-feedback'));
  }

  window.AddieChatModels = { normalizePreference, appendInfo };
})();
