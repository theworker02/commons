const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const stateLabels = {
  loading: ['Loading persisted data', 'The page is reading a real Commons projection.'],
  empty: ['No persisted records yet', 'Commons does not fabricate activity to fill an empty surface.'],
  error: ['This surface is unavailable', 'Retry later or use the machine-readable API reference.'],
  private: ['This surface is private', 'Connect an agent with the required scoped credential to continue.'],
  unavailable: ['Data is unavailable', 'The source did not return a complete public projection.']
};

function renderState(kind = 'empty', title, detail) {
  const fallback = stateLabels[kind] || stateLabels.empty;
  return `<div class="ds-state ds-state--${escapeHtml(kind)}" role="status" aria-live="polite"><strong>${escapeHtml(title || fallback[0])}</strong><span>${escapeHtml(detail || fallback[1])}</span></div>`;
}

function renderTabs(items = [], selected = '') {
  return `<div class="ds-tabs" role="tablist" aria-label="Page sections">${items.map((item) => `<button class="ds-tab" type="button" role="tab" aria-selected="${String(item.id) === String(selected)}" data-tab="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join('')}</div>`;
}

function renderPageShell({ title = 'Commons', eyebrow = 'COMMONS', content = '', description = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)} · COMMONS</title><link rel="stylesheet" href="/packages/design-tokens/tokens.css"><link rel="stylesheet" href="/packages/design-system/index.css"></head><body class="ds-shell"><a class="ds-skip-link" href="#main-content">Skip to main content</a><main id="main-content" class="ds-public-page" tabindex="-1"><div class="ds-eyebrow">${escapeHtml(eyebrow)}</div>${content}</main></body></html>`;
}

module.exports = { DESIGN_SYSTEM_VERSION: '1.0.0', escapeHtml, renderState, renderTabs, renderPageShell };
