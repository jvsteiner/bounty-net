import type { BugReport } from "../../types/reports.js";
import type { Response as BugResponse } from "../../storage/repositories/responses.js";

type TabType = "outbound" | "inbound";

interface DashboardData {
  reports: BugReport[];
  repos: string[];
  counts: Record<string, number>;
  currentStatus: string;
  currentRepo?: string;
  tab: TabType;
  nametagMap?: Record<string, string>; // pubkey -> nametag
}

interface ReportDetailData {
  report: BugReport;
  responses: BugResponse[];
  ideProtocol: string;
  tab: TabType;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    date.toLocaleDateString() +
    " " +
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    pending: "badge-pending",
    accepted: "badge-accepted",
    rejected: "badge-rejected",
    completed: "badge-completed",
  };
  return `<span class="badge ${colors[status] || ""}">${status}</span>`;
}

function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Bounty-Net</title>
  <script src="/public/htmx.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.5;
      font-size: 14px;
    }

    .app {
      display: flex;
      height: 100vh;
    }

    /* Left Panel - Report List */
    .panel-left {
      width: 420px;
      min-width: 420px;
      background: #fff;
      border-right: 1px solid #e0e0e0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    .panel-header {
      padding: 16px;
      border-bottom: 1px solid #e0e0e0;
      background: #fafafa;
    }

    .panel-header h1 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #111;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 12px;
      border-bottom: 1px solid #e0e0e0;
    }

    .tab {
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      color: #666;
      text-decoration: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.1s, border-color 0.1s;
    }

    .tab:hover {
      color: #333;
    }

    .tab.active {
      color: #0066cc;
      border-bottom-color: #0066cc;
    }

    .tab-count {
      font-size: 11px;
      background: #e5e5e5;
      padding: 1px 6px;
      border-radius: 10px;
      margin-left: 6px;
    }

    .tab.active .tab-count {
      background: #dbeafe;
      color: #1e40af;
    }

    .filters {
      display: flex;
      gap: 8px;
    }

    select {
      padding: 6px 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #fff;
      font-size: 13px;
      color: #333;
      cursor: pointer;
    }

    select:focus {
      outline: none;
      border-color: #0066cc;
    }

    .stats {
      display: flex;
      gap: 12px;
      margin-top: 12px;
      font-size: 12px;
      color: #666;
    }

    .stat-pending {
      color: #b45309;
      font-weight: 500;
    }

    /* Report List */
    .report-list {
      flex: 1;
      overflow-y: auto;
    }

    .report-item {
      display: flex;
      align-items: flex-start;
      padding: 12px 16px;
      border-bottom: 1px solid #eee;
      cursor: pointer;
      transition: background 0.1s;
    }

    .report-item:hover {
      background: #f8f8f8;
    }

    .report-item.selected {
      background: #e8f4fc;
      border-left: 3px solid #0099ff;
      padding-left: 13px;
    }

    .report-item.active {
      background: #e0f0ff;
      border-left: 3px solid #0066cc;
      padding-left: 13px;
    }

    .report-item.selected.active {
      background: #d4e8f8;
      border-left: 3px solid #0066cc;
    }

    .report-content {
      flex: 1;
      min-width: 0;
    }

    .report-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .report-repo {
      font-size: 12px;
      color: #666;
    }

    .report-desc {
      font-size: 13px;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .report-footer {
      display: flex;
      justify-content: space-between;
      margin-top: 4px;
      font-size: 11px;
      color: #888;
    }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .badge-pending {
      background: #fef3c7;
      color: #92400e;
    }

    .badge-acknowledged {
      background: #dbeafe;
      color: #1e40af;
    }

    .badge-accepted {
      background: #d1fae5;
      color: #065f46;
    }

    .badge-rejected {
      background: #fee2e2;
      color: #991b1b;
    }

    .badge-completed {
      background: #e5e5e5;
      color: #666;
    }

    /* Action Bar */
    .action-bar {
      padding: 12px 16px;
      border-top: 1px solid #e0e0e0;
      background: #fafafa;
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .btn {
      padding: 8px 14px;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.1s;
    }

    .btn:hover {
      opacity: 0.85;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: #0066cc;
      color: #fff;
    }

    .btn-success {
      background: #059669;
      color: #fff;
    }

    .btn-danger {
      background: #dc2626;
      color: #fff;
    }

    .btn-secondary {
      background: #e5e5e5;
      color: #333;
    }

    .selection-count {
      font-size: 12px;
      color: #666;
      margin-left: auto;
    }

    /* Right Panel - Detail */
    .panel-right {
      flex: 1;
      overflow-y: auto;
      background: #fff;
    }

    .detail-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #999;
      font-size: 14px;
    }

    .detail-content {
      padding: 24px;
      max-width: 800px;
    }

    .detail-header {
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #eee;
    }

    .detail-header h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #111;
    }

    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
      color: #666;
    }

    .detail-meta-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .detail-meta-label {
      color: #999;
    }

    .section {
      margin-bottom: 20px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #999;
      margin-bottom: 8px;
    }

    .section-content {
      background: #f9f9f9;
      border: 1px solid #eee;
      border-radius: 4px;
      padding: 12px;
      font-size: 13px;
      white-space: pre-wrap;
      font-family: "SF Mono", Monaco, "Cascadia Code", monospace;
      line-height: 1.6;
    }

    .files-list {
      list-style: none;
    }

    .files-list li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
    }

    .files-list a {
      color: #0066cc;
      text-decoration: none;
      font-size: 12px;
    }

    .files-list a:hover {
      text-decoration: underline;
    }

    .detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid #eee;
    }

    .detail-actions .action-row {
      display: flex;
      width: 100%;
      gap: 8px;
      align-items: center;
    }

    .detail-actions input[type="text"] {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 13px;
    }

    .detail-actions input[type="number"] {
      width: 100px;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 13px;
    }

    .detail-actions input:focus {
      outline: none;
      border-color: #0066cc;
    }

    .detail-actions label {
      font-size: 12px;
      color: #666;
    }

    .reward-hint {
      font-size: 11px;
      color: #888;
      margin-left: 4px;
    }

    .responses-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .response-item {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 4px;
      padding: 10px;
      font-size: 13px;
    }

    .response-type {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: #0369a1;
    }

    /* Toast notification */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: #fff;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
    }

    .htmx-request {
      opacity: 0.6;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-overlay.show {
      display: flex;
    }

    .modal {
      background: #fff;
      border-radius: 8px;
      padding: 24px;
      width: 400px;
      max-width: 90vw;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    }

    .modal h3 {
      margin: 0 0 16px 0;
      font-size: 16px;
      font-weight: 600;
      color: #111;
    }

    .modal input[type="text"],
    .modal textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      margin-bottom: 16px;
      font-family: inherit;
    }

    .modal textarea {
      min-height: 80px;
      resize: vertical;
    }

    .modal input:focus,
    .modal textarea:focus {
      outline: none;
      border-color: #0066cc;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  </style>
</head>
<body>
  ${content}
  <div id="toast" class="toast"></div>

  <!-- Confirm Modal -->
  <div id="confirm-modal" class="modal-overlay" onclick="if(event.target === this) closeConfirmModal()">
    <div class="modal">
      <h3 id="confirm-title">Confirm</h3>
      <p id="confirm-message"></p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeConfirmModal()">Cancel</button>
        <button class="btn" id="confirm-btn" onclick="executeConfirm()">Confirm</button>
      </div>
    </div>
  </div>

  <!-- Reject Modal -->
  <div id="reject-modal" class="modal-overlay" onclick="if(event.target === this) closeRejectModal()">
    <div class="modal">
      <h3>Reject Report</h3>
      <textarea id="reject-reason" placeholder="Reason for rejection..."></textarea>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeRejectModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmReject()">Reject</button>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function renderDashboard(data: DashboardData): string {
  const {
    reports,
    repos,
    counts,
    currentStatus,
    currentRepo,
    tab,
    nametagMap = {},
  } = data;

  const isOutbound = tab === "outbound";
  const tabTitle = isOutbound ? "Outbound Reports" : "Inbound Reports";
  const tabDescription = isOutbound
    ? "Reports you've submitted"
    : "Reports you've received";

  const statusOptions = ["active", "accepted", "rejected", "completed"]
    .map(
      (s) =>
        `<option value="${s}" ${s === currentStatus ? "selected" : ""}>${s} (${counts[s] || 0})</option>`,
    )
    .join("");

  const repoOptions = ["", ...repos]
    .map(
      (r) =>
        `<option value="${r}" ${r === currentRepo ? "selected" : ""}>${r || "All repositories"}</option>`,
    )
    .join("");

  const reportItems =
    reports.length > 0
      ? reports.map((r) => renderReportItem(r, tab, nametagMap)).join("\n")
      : `<div class="detail-empty">No reports found</div>`;

  const content = `
    <div class="app">
      <div class="panel-left">
        <div class="panel-header">
          <h1>Bounty-Net</h1>
          <div class="tabs">
            <a href="/outbound" class="tab ${tab === "outbound" ? "active" : ""}">
              Outbound
            </a>
            <a href="/inbound" class="tab ${tab === "inbound" ? "active" : ""}">
              Inbound
            </a>
          </div>
          <div class="filters">
            <select name="status" onchange="filterReports()">
              ${statusOptions}
            </select>
            <select name="repo" onchange="filterReports()">
              ${repoOptions}
            </select>
          </div>
          <div class="stats">
            <span class="stat-pending">Pending: ${counts.pending || 0}</span>
          </div>
        </div>

        <div class="report-list" id="report-list">
          ${reportItems}
        </div>

        <div class="action-bar">
          <button class="btn btn-primary" onclick="copySelected()">Copy to Clipboard</button>
          ${
            tab === "inbound"
              ? `
          <button class="btn btn-success" onclick="acceptSelected()">Accept</button>
          <button class="btn btn-danger" onclick="rejectSelected()">Reject</button>
          `
              : ""
          }
          <button class="btn btn-secondary" onclick="archiveSelected()">Archive</button>
          <span class="selection-count" id="selection-count">0 selected</span>
        </div>
      </div>

      <div class="panel-right">
        <div id="detail-panel" class="detail-empty">
          Select a report to view details
        </div>
      </div>
    </div>

    <script>
      let selectedIds = new Set();
      let activeId = null;
      let lastClickedIndex = -1;

      // Get all report IDs in order
      function getReportIds() {
        return Array.from(document.querySelectorAll('.report-item')).map(el => {
          const id = el.id.replace('item-', '').replace(/_/g, '-');
          // Fix the ID format (underscores back to hyphens, but preserve the -received suffix)
          return el.getAttribute('data-id') || id;
        });
      }

      function updateSelectionCount() {
        document.getElementById('selection-count').textContent = selectedIds.size + ' selected';
      }

      function updateSelectionUI() {
        document.querySelectorAll('.report-item').forEach(el => {
          const id = el.getAttribute('data-id');
          el.classList.toggle('selected', selectedIds.has(id));
        });
        updateSelectionCount();
      }

      function selectReport(id, event) {
        const items = document.querySelectorAll('.report-item');
        const ids = Array.from(items).map(el => el.getAttribute('data-id'));
        const clickedIndex = ids.indexOf(id);

        if (event && event.shiftKey && lastClickedIndex >= 0) {
          // Shift-click: select range
          const start = Math.min(lastClickedIndex, clickedIndex);
          const end = Math.max(lastClickedIndex, clickedIndex);
          for (let i = start; i <= end; i++) {
            selectedIds.add(ids[i]);
          }
        } else if (event && (event.metaKey || event.ctrlKey)) {
          // Cmd/Ctrl-click: toggle selection
          if (selectedIds.has(id)) {
            selectedIds.delete(id);
          } else {
            selectedIds.add(id);
          }
          lastClickedIndex = clickedIndex;
        } else {
          // Regular click: select only this, deselect others
          selectedIds.clear();
          selectedIds.add(id);
          lastClickedIndex = clickedIndex;
        }

        updateSelectionUI();

        // Update active state and load detail
        document.querySelectorAll('.report-item').forEach(el => el.classList.remove('active'));
        const itemEl = document.getElementById('item-' + id.replace(/[^a-zA-Z0-9]/g, '_'));
        if (itemEl) itemEl.classList.add('active');
        activeId = id;

        // Load detail
        fetch('/reports/' + encodeURIComponent(id))
          .then(r => r.text())
          .then(html => {
            document.getElementById('detail-panel').innerHTML = html;
          });
      }

      const currentTab = '${tab}';

      function filterReports() {
        const status = document.querySelector('select[name="status"]').value;
        const repo = document.querySelector('select[name="repo"]').value;
        window.location.href = '/' + currentTab + '?status=' + status + (repo ? '&repo=' + encodeURIComponent(repo) : '');
      }

      function copySelected() {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) {
          showToast('No reports selected');
          return;
        }

        const lines = ['Attached bounty-net reports:'];
        ids.forEach(id => lines.push('- ' + id));
        const text = lines.join('\\n');
        navigator.clipboard.writeText(text).then(() => {
          showToast('Copied ' + ids.length + ' report ID(s) to clipboard');
        });
      }

      async function acceptSelected() {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) {
          showToast('No reports selected');
          return;
        }
        openConfirmModal(
          'Accept Reports',
          'Accept ' + ids.length + ' report(s)? This will refund deposits and pay bounties.',
          'Accept',
          'btn-success',
          async () => {
            const response = await fetch('/api/batch/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids })
            });

            if (response.ok) {
              showToast('Accepted ' + ids.length + ' report(s)');
              setTimeout(() => location.reload(), 500);
            } else {
              showToast('Failed: ' + await response.text());
            }
          }
        );
      }

      async function rejectSelected() {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) {
          showToast('No reports selected');
          return;
        }
        openRejectModal('batch', ids);
      }

      async function submitBatchReject(ids, reason) {
        const response = await fetch('/api/batch/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, reason })
        });

        if (response.ok) {
          showToast('Rejected ' + ids.length + ' report(s)');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast('Failed: ' + await response.text());
        }
      }

      async function archiveSelected() {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) {
          showToast('No reports selected');
          return;
        }
        openConfirmModal(
          'Archive Reports',
          'Archive ' + ids.length + ' report(s)? They will be hidden from the default view.',
          'Archive',
          'btn-secondary',
          async () => {
            const response = await fetch('/api/batch/archive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids })
            });

            if (response.ok) {
              showToast('Archived ' + ids.length + ' report(s)');
              setTimeout(() => location.reload(), 500);
            } else {
              showToast('Failed: ' + await response.text());
            }
          }
        );
      }

      async function acceptReport(id) {
        const message = document.getElementById('action-message')?.value || '';
        const rewardInput = document.getElementById('action-reward')?.value;
        const payload = { message };
        if (rewardInput && rewardInput.trim() !== '') {
          payload.reward = rewardInput;
        }
        const response = await fetch('/api/accept/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          showToast('Report accepted');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast('Failed: ' + await response.text());
        }
      }

      function rejectReport(id) {
        const message = document.getElementById('action-message')?.value;
        if (message) {
          submitSingleReject(id, message);
        } else {
          openRejectModal('single', id);
        }
      }

      async function submitSingleReject(id, reason) {
        const response = await fetch('/api/reject/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        if (response.ok) {
          showToast('Report rejected');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast('Failed: ' + await response.text());
        }
      }

      // Confirm modal functions
      let confirmCallback = null;

      function openConfirmModal(title, message, btnText, btnClass, callback) {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        const btn = document.getElementById('confirm-btn');
        btn.textContent = btnText;
        btn.className = 'btn ' + btnClass;
        confirmCallback = callback;
        document.getElementById('confirm-modal').classList.add('show');
      }

      function closeConfirmModal() {
        document.getElementById('confirm-modal').classList.remove('show');
        confirmCallback = null;
      }

      async function executeConfirm() {
        const callback = confirmCallback;
        closeConfirmModal();
        if (callback) await callback();
      }

      // Reject modal functions
      let rejectMode = null;
      let rejectTarget = null;

      function openRejectModal(mode, target) {
        rejectMode = mode;
        rejectTarget = target;
        document.getElementById('reject-reason').value = '';
        document.getElementById('reject-modal').classList.add('show');
        document.getElementById('reject-reason').focus();
      }

      function closeRejectModal() {
        document.getElementById('reject-modal').classList.remove('show');
        rejectMode = null;
        rejectTarget = null;
      }

      async function confirmReject() {
        const reason = document.getElementById('reject-reason').value.trim();
        if (!reason) {
          showToast('Please enter a reason');
          return;
        }

        // Save values before closeRejectModal nulls them
        const mode = rejectMode;
        const target = rejectTarget;
        closeRejectModal();

        if (mode === 'single') {
          await submitSingleReject(target, reason);
        } else if (mode === 'batch') {
          await submitBatchReject(target, reason);
        }
      }

      async function archiveReport(id) {
        const response = await fetch('/api/archive/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
          showToast('Report archived');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast('Failed: ' + await response.text());
        }
      }

      function showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
      }
    </script>
  `;

  return layout("Dashboard", content);
}

export function renderReportItem(
  report: BugReport,
  tab: TabType = "inbound",
  nametagMap: Record<string, string> = {},
): string {
  const repoShort = report.repo_url
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "");
  const safeId = report.id.replace(/[^a-zA-Z0-9]/g, "_");

  // For outbound, show recipient; for inbound, show sender
  const isOutbound = tab === "outbound";
  const otherParty = isOutbound
    ? report.recipient_pubkey
    : report.sender_pubkey;
  // Show verified nametag from report, fallback to nametagMap, then truncated pubkey
  let otherPartyDisplay = "";
  if (otherParty) {
    if (!isOutbound && report.sender_nametag) {
      // For inbound reports, use the verified sender_nametag
      otherPartyDisplay = report.sender_nametag;
    } else if (nametagMap[otherParty]) {
      // Fallback to known identities map
      otherPartyDisplay = nametagMap[otherParty];
    } else {
      otherPartyDisplay = otherParty.slice(0, 8) + "...";
    }
  }
  const otherPartyLabel = isOutbound ? "To" : "From";

  return `
    <div class="report-item" id="item-${safeId}" data-id="${escapeHtml(report.id)}" onclick="selectReport('${escapeHtml(report.id)}', event)">
      <div class="report-content">
        <div class="report-meta">
          ${statusBadge(report.status)}
          <span class="report-repo">${escapeHtml(repoShort)}</span>
        </div>
        <div class="report-desc">${escapeHtml(truncate(report.description, 80))}</div>
        <div class="report-footer">
          <span>${report.deposit_amount || 0} ALPHA</span>
          <span>${otherPartyLabel}: ${escapeHtml(otherPartyDisplay)}</span>
          <span>${formatDate(report.created_at)}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderReportRow(
  report: BugReport,
  tab: TabType = "inbound",
): string {
  // Keep for API compatibility - returns item format
  return renderReportItem(report, tab);
}

export function renderReportDetail(data: ReportDetailData): string {
  const { report, responses, ideProtocol, tab } = data;

  const isOutbound = tab === "outbound";
  const repoShort = report.repo_url
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "");

  // Show the other party based on view
  const otherPartyPubkey = isOutbound
    ? report.recipient_pubkey
    : report.sender_pubkey;
  const otherPartyPubkeyShort = otherPartyPubkey
    ? otherPartyPubkey.slice(0, 12) + "..." + otherPartyPubkey.slice(-6)
    : "unknown";
  // For inbound, prefer verified nametag
  const otherPartyDisplay =
    !isOutbound && report.sender_nametag
      ? report.sender_nametag
      : otherPartyPubkeyShort;
  const otherPartyLabel = isOutbound ? "To" : "From";

  // Parse files and create IDE links
  const files = report.file_path ? report.file_path.split(", ") : [];
  const fileLinks = files
    .map((f) => {
      const [filePath, lineRange] = f.split(":");
      const line = lineRange ? lineRange.split("-")[0] : "1";
      const ideUrl = generateIdeUrl(ideProtocol, filePath, line);
      return `<li><span>📄 ${escapeHtml(f)}</span> <a href="${ideUrl}" target="_blank">Open in IDE</a></li>`;
    })
    .join("");

  const responsesHtml =
    responses.length > 0
      ? responses
          .map(
            (r) => `
        <div class="response-item">
          <span class="response-type">${escapeHtml(r.response_type)}</span>
          ${r.message ? ` — ${escapeHtml(r.message)}` : ""}
        </div>
      `,
          )
          .join("")
      : `<div style="color: #999; font-size: 13px;">No responses yet</div>`;

  const isPending = report.status === "pending";
  const canArchive =
    report.status === "accepted" || report.status === "rejected";

  // Only show accept/reject actions for inbound (maintainer) view
  const canTakeAction = !isOutbound && isPending;

  return `
    <div class="detail-content">
      <div class="detail-header">
        <h2>${isOutbound ? "Sent Report" : "Received Report"}</h2>
        <div class="detail-meta">
          <div class="detail-meta-item">
            ${statusBadge(report.status)}
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-label">Repo:</span>
            <span>${escapeHtml(repoShort)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-label">Deposit:</span>
            <span>${report.deposit_amount || 0} ALPHA</span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-label">${otherPartyLabel}:</span>
            <span>${escapeHtml(otherPartyDisplay)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="detail-meta-label">Date:</span>
            <span>${formatDate(report.created_at)}</span>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Report ID</div>
        <div class="section-content" style="font-size: 12px; background: #fff; user-select: all;">${escapeHtml(report.id)}</div>
      </div>

      ${
        files.length > 0
          ? `
        <div class="section">
          <div class="section-title">Files</div>
          <ul class="files-list">
            ${fileLinks}
          </ul>
        </div>
      `
          : ""
      }

      <div class="section">
        <div class="section-title">Description</div>
        <div class="section-content">${escapeHtml(report.description)}</div>
      </div>

      ${
        report.suggested_fix
          ? `
        <div class="section">
          <div class="section-title">Suggested Fix</div>
          <div class="section-content">${escapeHtml(report.suggested_fix)}</div>
        </div>
      `
          : ""
      }

      <div class="section">
        <div class="section-title">Responses</div>
        <div class="responses-list">
          ${responsesHtml}
        </div>
      </div>

      ${
        canTakeAction
          ? `
        <div class="detail-actions">
          <div class="action-row">
            <input type="text" id="action-message" placeholder="Optional message...">
          </div>
          <div class="action-row">
            <label>Reward:</label>
            <input type="number" id="action-reward" placeholder="default" min="0" step="1">
            <span class="reward-hint">ALPHA (leave blank for repo default)</span>
          </div>
          <div class="action-row">
            <button class="btn btn-success" onclick="acceptReport('${escapeHtml(report.id)}')">Accept</button>
            <button class="btn btn-danger" onclick="rejectReport('${escapeHtml(report.id)}')">Reject</button>
          </div>
        </div>
      `
          : ""
      }
      ${
        !isOutbound && canArchive
          ? `
        <div class="detail-actions">
          <div class="action-row">
            <button class="btn btn-secondary" onclick="archiveReport('${escapeHtml(report.id)}')">Archive (mark as completed)</button>
          </div>
        </div>
      `
          : ""
      }
      ${
        isOutbound && isPending
          ? `
        <div class="detail-actions">
          <div class="action-row" style="color: #666; font-size: 13px;">
            Awaiting response from maintainer...
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function generateIdeUrl(
  protocol: string,
  filePath: string,
  line: string,
): string {
  const absPath = filePath.startsWith("/")
    ? filePath
    : `\${workspaceFolder}/${filePath}`;

  switch (protocol) {
    case "zed":
      return `zed://file${absPath}:${line}`;
    case "vscode":
      return `vscode://file${absPath}:${line}:1`;
    case "cursor":
      return `cursor://file${absPath}:${line}:1`;
    case "jetbrains":
      return `jetbrains://open?file=${encodeURIComponent(absPath)}&line=${line}`;
    default:
      return `vscode://file${absPath}:${line}:1`;
  }
}
