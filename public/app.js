// Core State
let links = [];
let appSettings = {
  baseDomain: '',
  hasGcpKey: false,
  gcpEmail: null
};
let selectedIds = new Set();

// Demo links matching the user's uploaded image!
const DEMO_LINKS = [
  'https://www.linkedin.com/posts/jesper-nissen-9508794_linkedin-live-med-christopher-hofman-distribueret-activity-7422566134152990721-okfJ/',
  'https://www.instagram.com/p/DUFsFKdDSL1/',
  'https://www.threads.com/@jespernissenseo/post/DUFsSlujToF/',
  'https://www.facebook.com/jespernissenseo/posts/pfbid0QEVDiM7wsfpf1hHKedaqa4UmZCLuXexyDzc1qbo1Ad6HCkFJG6n33MtJgEwtuGV1',
  'https://x.com/JespernissenSEO/status/2016801032135655630',
  'https://www.youtube.com/post/UgkxtmJROkhL3nlOcj0qtNYqZmBp53H3WdVv',
  'https://www.pinterest.com/pin/1042161170037564976/'
];

// Elements
const urlInput = document.getElementById('url-input');
const urlForm = document.getElementById('url-submit-form');
const btnSubmitUrls = document.getElementById('btn-submit-urls');
const btnLoadDemo = document.getElementById('btn-load-demo');
const btnTriggerIndexing = document.getElementById('btn-trigger-indexing');
const btnCheckStatus = document.getElementById('btn-check-status');
const searchInput = document.getElementById('search-input');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const linksTbody = document.getElementById('links-tbody');

// Stats Elements
const statTotal = document.getElementById('stat-total');
const statPending = document.getElementById('stat-pending');
const statSubmitted = document.getElementById('stat-submitted');
const statIndexed = document.getElementById('stat-indexed');

// Modal Elements
const settingsModal = document.getElementById('settings-modal');
const btnOpenSettings = document.getElementById('open-settings-btn');
const btnCloseSettings = document.getElementById('close-settings-btn');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const settingsForm = document.getElementById('settings-form');
const inputBaseDomain = document.getElementById('settings-base-domain');
const textareaGcpKey = document.getElementById('settings-gcp-key');
const keyStatusBox = document.getElementById('key-status-box');
const keyEmailDisplay = document.getElementById('key-email-display');
const btnDeleteKey = document.getElementById('btn-delete-key');

// Status Badge Elements
const apiStatusBadge = document.getElementById('api-status-badge');
const apiDot = document.getElementById('api-dot');
const apiStatusText = document.getElementById('api-status-text');

// Init
window.addEventListener('DOMContentLoaded', async () => {
  await fetchSettings();
  await fetchLinks();
  
  // Setup events
  setupEventListeners();
});

// Event Bindings
function setupEventListeners() {
  // Submission
  urlForm.addEventListener('submit', handleUrlSubmit);
  btnLoadDemo.addEventListener('click', () => {
    urlInput.value = DEMO_LINKS.join('\n');
    showToast('Demo URLs loaded. Click "Add to Queue" to map redirects.', 'info');
  });

  // Settings Modal
  btnOpenSettings.addEventListener('click', openModal);
  btnCloseSettings.addEventListener('click', closeModal);
  btnCancelSettings.addEventListener('click', closeModal);
  settingsForm.addEventListener('submit', handleSettingsSave);
  btnDeleteKey.addEventListener('click', handleDeleteKey);

  // Close modal on click outside content
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeModal();
  });

  // Search/Filter
  searchInput.addEventListener('input', renderLinksTable);

  // Selection
  selectAllCheckbox.addEventListener('change', toggleSelectAll);
  btnDeleteSelected.addEventListener('click', handleDeleteSelected);

  // Actions
  btnTriggerIndexing.addEventListener('click', handleTriggerIndexing);
  btnCheckStatus.addEventListener('click', handleCheckStatus);
}

// ----------------------------------------------------
// DATA CONFLICTS & FETCHERS
// ----------------------------------------------------

async function fetchLinks() {
  try {
    const res = await fetch('/api/links');
    if (!res.ok) throw new Error('Failed to load queue.');
    const apiLinks = await res.json();
    
    // Auto-Heal: retrieve local copy to sync with server if it was wiped
    let localLinks = [];
    try {
      localLinks = JSON.parse(localStorage.getItem('indexer_links')) || [];
    } catch (e) {
      localLinks = [];
    }

    // Identify URLs in local storage that aren't on the server
    const apiUrls = new Set(apiLinks.map(l => l.original_url));
    const missingUrls = [];
    
    localLinks.forEach(localLink => {
      if (localLink && localLink.original_url && !apiUrls.has(localLink.original_url)) {
        missingUrls.push(localLink.original_url);
      }
    });

    if (missingUrls.length > 0) {
      console.log(`[Auto-Heal] Wiped database detected. Restoring ${missingUrls.length} link(s) from browser cache...`);
      // Restore them silently in the background
      try {
        await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: missingUrls })
        });
        
        // Refetch to populate the full links state
        const refetchRes = await fetch('/api/links');
        if (refetchRes.ok) {
          links = await refetchRes.json();
        } else {
          links = apiLinks;
        }
      } catch (err) {
        console.error('[Auto-Heal] Restore failed:', err);
        links = apiLinks;
      }
    } else {
      links = apiLinks;
    }

    // Keep localStorage in sync
    localStorage.setItem('indexer_links', JSON.stringify(links));
    
    renderLinksTable();
    updateStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to load configurations.');
    appSettings = await res.json();
    
    // Update API Badge
    if (appSettings.hasGcpKey) {
      apiDot.className = 'indicator-dot green';
      apiStatusText.textContent = 'GCP Key Loaded';
      
      keyStatusBox.style.display = 'flex';
      keyEmailDisplay.textContent = `Key email: ${appSettings.gcpEmail}`;
      textareaGcpKey.placeholder = 'Google service account key loaded. Paste new JSON to replace it.';
    } else {
      apiDot.className = 'indicator-dot red';
      apiStatusText.textContent = 'GCP Key Missing';
      
      keyStatusBox.style.display = 'none';
      textareaGcpKey.placeholder = '{ "type": "service_account", ... }';
    }

    inputBaseDomain.value = appSettings.baseDomain;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// UI RENDERING
// ----------------------------------------------------

function updateStats() {
  const total = links.length;
  const pending = links.filter(l => l.status === 'Pending').length;
  const submitted = links.filter(l => l.status === 'Submitted' || l.status === 'Crawled').length;
  const indexed = links.filter(l => l.status === 'Indexed').length;

  statTotal.textContent = total;
  statPending.textContent = pending;
  statSubmitted.textContent = submitted;
  statIndexed.textContent = indexed;
}

function renderLinksTable() {
  const query = searchInput.value.toLowerCase().trim();
  const filteredLinks = links.filter(link => {
    return link.original_url.toLowerCase().includes(query) || 
           link.id.toLowerCase().includes(query);
  });

  if (filteredLinks.length === 0) {
    linksTbody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">
          ${query ? 'No matching links found.' : 'Your indexing queue is empty. Submit some links above!'}
        </td>
      </tr>
    `;
    return;
  }

  linksTbody.innerHTML = filteredLinks.map(link => {
    const isChecked = selectedIds.has(link.id);
    const redirectUrl = `${appSettings.baseDomain || 'http://localhost:3000'}/go/${link.id}`;
    const formattedDate = new Date(link.created_at).toLocaleString();
    
    // Determine status badge class
    let badgeClass = 'badge-pending';
    if (link.status === 'Submitted') badgeClass = 'badge-submitted';
    if (link.status === 'Crawled') badgeClass = 'badge-crawled';
    if (link.status === 'Indexed') badgeClass = 'badge-indexed';
    if (link.status === 'Failed') badgeClass = 'badge-failed';

    return `
      <tr data-id="${link.id}">
        <td>
          <input type="checkbox" class="link-select-checkbox" data-id="${link.id}" ${isChecked ? 'checked' : ''}>
        </td>
        <td>
          <span class="badge ${badgeClass}">${link.status}</span>
        </td>
        <td>
          <div class="link-display">
            <a href="${redirectUrl}" target="_blank" class="link-url">${redirectUrl}</a>
            <button class="btn-copy" onclick="copyToClipboard('${redirectUrl}')" title="Copy Shortlink">📋</button>
          </div>
        </td>
        <td>
          <div class="link-target" title="${link.original_url}">
            ${link.original_url}
          </div>
        </td>
        <td style="color: var(--text-secondary); font-size: 0.8rem;">
          ${formattedDate}
        </td>
        <td>
          <button class="btn btn-secondary btn-xs" onclick="deleteSingleLink('${link.id}')" title="Delete Link">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');

  // Re-bind row checkboxes
  document.querySelectorAll('.link-select-checkbox').forEach(cb => {
    cb.addEventListener('change', handleRowSelect);
  });

  updateDeleteButtonState();
}

// ----------------------------------------------------
// ACTIONS & HANDLERS
// ----------------------------------------------------

async function handleUrlSubmit(e) {
  e.preventDefault();
  const text = urlInput.value.trim();
  if (!text) return;

  const urls = text.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return;

  btnSubmitUrls.disabled = true;
  btnSubmitUrls.textContent = 'Processing...';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit URLs.');

    const successes = data.results.filter(r => r.success);
    const failures = data.results.filter(r => !r.success);

    urlInput.value = '';
    showToast(`Successfully registered ${successes.length} redirect URL(s).`, 'success');
    if (failures.length > 0) {
      showToast(`${failures.length} URL(s) failed validation.`, 'error');
    }

    await fetchLinks();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btnSubmitUrls.disabled = false;
    btnSubmitUrls.textContent = 'Add to Queue';
  }
}

async function handleTriggerIndexing() {
  // Submit selected links, or fallback to all pending links
  const idsToTrigger = Array.from(selectedIds);
  const isAll = idsToTrigger.length === 0;

  if (isAll && !confirm('No rows selected. Trigger Google Indexing API for ALL pending/failed links in queue?')) {
    return;
  }

  btnTriggerIndexing.disabled = true;
  const originalText = btnTriggerIndexing.innerHTML;
  btnTriggerIndexing.innerHTML = `<span class="btn-icon">⏳</span><div><strong>Submitting...</strong><small>Calling Google APIs</small></div>`;

  try {
    const res = await fetch('/api/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsToTrigger })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Trigger failed.');

    showToast(`Submissions complete. Google APIs returned code 200 for ${data.processedCount} link(s).`, 'success');
    
    // Clear selection
    selectedIds.clear();
    selectAllCheckbox.checked = false;

    await fetchLinks();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btnTriggerIndexing.disabled = false;
    btnTriggerIndexing.innerHTML = originalText;
  }
}

async function handleCheckStatus() {
  const idsToCheck = Array.from(selectedIds);
  btnCheckStatus.disabled = true;
  const originalText = btnCheckStatus.innerHTML;
  btnCheckStatus.innerHTML = `<span class="btn-icon">⏳</span><div><strong>Verifying...</strong><small>Checking indexes</small></div>`;

  try {
    const res = await fetch('/api/check-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsToCheck })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification check failed.');

    showToast(`Verification complete. Updated crawl status for link queue.`, 'success');
    
    // Clear selection
    selectedIds.clear();
    selectAllCheckbox.checked = false;

    await fetchLinks();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btnCheckStatus.disabled = false;
    btnCheckStatus.innerHTML = originalText;
  }
}

// ----------------------------------------------------
// SETTINGS
// ----------------------------------------------------

function openModal() {
  settingsModal.style.display = 'flex';
  textareaGcpKey.value = ''; // Reset input text area
}

function closeModal() {
  settingsModal.style.display = 'none';
}

async function handleSettingsSave(e) {
  e.preventDefault();
  
  const baseDomain = inputBaseDomain.value.trim();
  const gcpKeyJson = textareaGcpKey.value.trim();

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseDomain, gcpKeyJson })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save settings.');

    showToast('Configuration saved successfully.', 'success');
    closeModal();
    await fetchSettings();
    await fetchLinks(); // Refresh table since base domain changed
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDeleteKey() {
  if (!confirm('Are you sure you want to delete the Google service account key? Submissions will stop working.')) {
    return;
  }

  try {
    const res = await fetch('/api/settings/gcp-key', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove key.');

    showToast('GCP key removed.', 'success');
    await fetchSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// ROW SELECTION & DELETING
// ----------------------------------------------------

function handleRowSelect(e) {
  const checkbox = e.target;
  const id = checkbox.dataset.id;
  
  if (checkbox.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }

  updateDeleteButtonState();
}

function toggleSelectAll(e) {
  const isChecked = e.target.checked;
  const visibleCheckboxes = document.querySelectorAll('.link-select-checkbox');
  
  visibleCheckboxes.forEach(cb => {
    cb.checked = isChecked;
    const id = cb.dataset.id;
    if (isChecked) {
      selectedIds.add(id);
    } else {
      selectedIds.delete(id);
    }
  });

  updateDeleteButtonState();
}

function updateDeleteButtonState() {
  btnDeleteSelected.disabled = selectedIds.size === 0;
  btnDeleteSelected.textContent = selectedIds.size > 0 
    ? `Delete Selected (${selectedIds.size})` 
    : 'Delete Selected';
}

async function handleDeleteSelected() {
  const idsToDelete = Array.from(selectedIds);
  if (idsToDelete.length === 0) return;

  if (!confirm(`Are you sure you want to delete ${idsToDelete.length} selected link(s)?`)) {
    return;
  }

  try {
    const res = await fetch('/api/links/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsToDelete })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete selected links.');

    showToast(`Deleted ${idsToDelete.length} link(s).`, 'success');
    selectedIds.clear();
    selectAllCheckbox.checked = false;
    
    await fetchLinks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSingleLink(id) {
  if (!confirm('Delete this redirect link from the queue?')) return;
  
  try {
    const res = await fetch('/api/links/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete link.');

    showToast('Link deleted from queue.', 'success');
    selectedIds.delete(id);
    
    await fetchLinks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// UTILITIES (TOAST / COPY)
// ----------------------------------------------------

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Shortlink copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link.', 'error');
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  let emoji = 'ℹ️';
  let typeClass = 'toast-info';
  
  if (type === 'success') {
    emoji = '✅';
    typeClass = 'toast-success';
  } else if (type === 'error') {
    emoji = '🚨';
    typeClass = 'toast-error';
  }
  
  toast.className = `toast ${typeClass}`;
  toast.innerHTML = `<span>${emoji}</span><span>${message}</span>`;
  
  container.appendChild(toast);
  
  // Slide out after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s reverse forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}
