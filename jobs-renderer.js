async function refreshJobs() {
    const result = await window.electronAPI.getJobs();
    if (result.success) {
        renderJobs(result.jobs);
    }
}

function renderJobs(jobs) {
    const container = document.getElementById('job-list');
    container.innerHTML = '';

    if (jobs.length === 0) {
        container.innerHTML = '<p style="color: #64748b; text-align: center; padding: 40px 0;">No jobs yet. Create one from the main window.</p>';
        return;
    }

    // Sort by created time (newest first)
    jobs.sort((a, b) => b.created_at - a.created_at);

    jobs.forEach(job => {
        const card = document.createElement('div');
        card.className = `job-card status-${job.status}`;

        // Format timestamps
        const createdDate = job.created_at ? new Date(job.created_at).toLocaleString('id-ID', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }) : 'Unknown';

        // Calculate duration
        let duration = 'Not started';
        if (job.completed_at && job.started_at) {
            duration = formatDuration(job.completed_at - job.started_at);
        } else if (job.started_at) {
            duration = `Running for ${formatDuration(Date.now() - job.started_at)}`;
        }

        // Status badge color
        const statusColors = {
            running: '#3b82f6',
            paused: '#fb923c',
            completed: '#22c55e',
            cancelled: '#ef4444',
            pending: '#94a3b8'
        };

        // Check if job type is boost_live for comment refill feature
        const isBoostLive = job.type === 'boost_live';
        const refillButton = isBoostLive && (job.status === 'running' || job.status === 'paused') 
            ? `<button onclick="showRefillModal('${job.id}')" style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);">💬 Refill Comments</button>` 
            : '';

        card.innerHTML = `
      <div class="job-header">
        <div>
          <strong style="font-size: 18px;">${formatJobType(job.type)}</strong>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px; font-family: 'Courier New', monospace;">${job.id}</div>
        </div>
        <span style="padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: ${statusColors[job.status]}33; color: ${statusColors[job.status]};">
          ${job.status}
        </span>
      </div>
      
      <div style="margin: 16px 0; padding: 12px; background: rgba(17, 24, 39, 0.6); border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span style="color: #a5b4fc;">Progress</span>
          <span style="font-weight: 700; color: #e4e9f7;">${job.completed} / ${job.total} (${job.progress}%)</span>
        </div>
        
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${job.progress}%"></div>
        </div>
        
        ${job.failed > 0 ? `
          <div style="margin-top: 8px; color: #ef4444; font-size: 13px;">
            ⚠️ ${job.failed} task(s) failed
          </div>
        ` : ''}
        
        ${job.remaining > 0 && (job.status === 'running' || job.status === 'paused') ? `
          <div style="margin-top: 8px; color: #94a3b8; font-size: 13px;">
            ⏳ ${job.remaining} task(s) in queue
          </div>
        ` : ''}
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; font-size: 12px; color: #94a3b8; margin-bottom: 16px;">
        <div>📅 ${createdDate}</div>
        <div>⏱️ ${duration}</div>
      </div>
      
      <div class="job-controls">
        ${job.status === 'running' ? `<button onclick="pauseJob('${job.id}')">⏸ Pause</button>` : ''}
        ${job.status === 'paused' ? `<button onclick="resumeJob('${job.id}')">▶ Resume</button>` : ''}
        ${refillButton}
        ${job.status !== 'completed' && job.status !== 'cancelled' ? `<button class="danger" onclick="cancelJob('${job.id}')">❌ Cancel</button>` : ''}
        ${job.failed > 0 && (job.status === 'completed' || job.status === 'cancelled') ? `<button onclick="retryJob('${job.id}')" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">🔄 Retry Failed</button>` : ''}
        ${job.status === 'completed' || job.status === 'cancelled' ? `<button onclick="deleteJob('${job.id}')" class="danger">🗑️ Delete</button>` : ''}
      </div>
    `;
        container.appendChild(card);
    });
}

function formatJobType(type) {
    const types = {
        'super_marketing': '📊 Super Marketing',
        'warmup': '🔥 Account Warmup',
        'boost_live': '🎥 Boost Live',
        'mass_comment': '💬 Mass Comment',
        'masscomment': '💬 Mass Comment'
    };
    return types[type] || type;
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

async function pauseJob(jobId) {
    const result = await window.electronAPI.pauseJob(jobId);
    if (result.success) {
        refreshJobs();
    }
}

async function resumeJob(jobId) {
    const result = await window.electronAPI.resumeJob(jobId);
    if (result.success) {
        refreshJobs();
    }
}

async function cancelJob(jobId) {
    if (confirm('Are you sure you want to cancel this job?\n\nThis will stop all tasks and close TikTok on all devices assigned to this job.')) {
        const result = await window.electronAPI.cancelJob(jobId);
        if (result.success) {
            showJobMgmtStatus('Job cancelled and TikTok closed on all devices', 'success');
            refreshJobs();
        }
    }
}

async function retryJob(jobId) {
    if (confirm('Retry all failed tasks for this job?')) {
        const result = await window.electronAPI.retryJob(jobId);
        if (result.success) {
            refreshJobs();
        }
    }
}

async function deleteJob(jobId) {
    if (confirm('Delete this job? This cannot be undone.')) {
        const result = await window.electronAPI.deleteJob(jobId);
        if (result.success) {
            refreshJobs();
        }
    }
}

// ================== REFILL COMMENTS FEATURE ==================

let currentRefillJobId = null;

function showRefillModal(jobId) {
    currentRefillJobId = jobId;
    
    // Create modal if it doesn't exist
    let modal = document.getElementById('refill-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'refill-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>💬 Refill Comments</h3>
                    <button onclick="hideRefillModal()" class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="color: #94a3b8; margin-bottom: 12px;">
                        Add new comments for this job. Each comment will be added to the pool and used in the next cycle.
                    </p>
                    <div id="comment-stats" style="margin-bottom: 12px; padding: 10px; background: rgba(17, 24, 39, 0.6); border-radius: 8px; font-size: 13px;"></div>
                    <textarea id="refill-comments" rows="10" placeholder="Enter comments (one per line)&#10;&#10;Example:&#10;Mantap live nya! 🔥&#10;Keren banget! ❤️&#10;Sukses terus!" style="width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #e4e9f7; padding: 12px; font-family: inherit;"></textarea>
                </div>
                <div class="modal-footer">
                    <button onclick="hideRefillModal()" style="background: #475569;">Cancel</button>
                    <button onclick="submitRefillComments()" style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);">Add Comments</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add modal styles
        const style = document.createElement('style');
        style.textContent = `
            .modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }
            .modal-overlay.hidden {
                display: none;
            }
            .modal-content {
                background: #0f172a;
                border-radius: 16px;
                width: 500px;
                max-width: 90%;
                border: 1px solid #1e293b;
            }
            .modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid #1e293b;
            }
            .modal-header h3 {
                margin: 0;
                color: #e4e9f7;
            }
            .modal-close {
                background: none;
                border: none;
                color: #94a3b8;
                font-size: 24px;
                cursor: pointer;
                padding: 0;
                line-height: 1;
            }
            .modal-close:hover {
                color: #e4e9f7;
            }
            .modal-body {
                padding: 20px;
            }
            .modal-footer {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                padding: 16px 20px;
                border-top: 1px solid #1e293b;
            }
            .modal-footer button {
                padding: 10px 20px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                color: white;
            }
        `;
        document.head.appendChild(style);
    }
    
    // Load comment stats
    loadCommentStats(jobId);
    
    // Show modal
    modal.classList.remove('hidden');
    document.getElementById('refill-comments').value = '';
    document.getElementById('refill-comments').focus();
}

function hideRefillModal() {
    const modal = document.getElementById('refill-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
    currentRefillJobId = null;
}

async function loadCommentStats(jobId) {
    const statsEl = document.getElementById('comment-stats');
    if (!statsEl) return;
    
    try {
        const result = await window.electronAPI.getCommentStats(jobId);
        if (result.success) {
            const stats = result.stats;
            let cycleInfo = '';
            if (stats.cycleInfo) {
                cycleInfo = `<br>📊 Cycle ${stats.cycleInfo.cycleNumber}: ${stats.cycleInfo.devicesCommented.length}/${stats.cycleInfo.totalDevices} devices commented`;
            }
            statsEl.innerHTML = `
                <div style="color: #a5b4fc;">
                    📝 Total: ${stats.total} | ✅ Used: ${stats.used} | 🔄 Available: ${stats.available}
                    ${cycleInfo}
                </div>
            `;
        } else {
            statsEl.innerHTML = '<div style="color: #ef4444;">Failed to load stats</div>';
        }
    } catch (error) {
        statsEl.innerHTML = '<div style="color: #ef4444;">Error loading stats</div>';
    }
}

async function submitRefillComments() {
    if (!currentRefillJobId) return;
    
    const textarea = document.getElementById('refill-comments');
    const commentsText = textarea.value.trim();
    
    if (!commentsText) {
        alert('Please enter at least one comment');
        return;
    }
    
    const comments = commentsText.split('\n')
        .map(c => c.trim())
        .filter(c => c.length > 0);
    
    if (comments.length === 0) {
        alert('Please enter at least one comment');
        return;
    }
    
    try {
        const result = await window.electronAPI.refillComments(currentRefillJobId, comments);
        
        if (result.success) {
            showJobMgmtStatus(`Successfully added ${result.count} comments`, 'success');
            hideRefillModal();
            refreshJobs();
        } else {
            alert(`Failed to add comments: ${result.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

// ================== END REFILL COMMENTS FEATURE ==================

// Show job management status
function showJobMgmtStatus(message, type = 'info') {
    const statusEl = document.getElementById('job-mgmt-status');
    if (!statusEl) return;

    const colors = {
        info: '#3b82f6',
        success: '#22c55e',
        warning: '#fb923c',
        error: '#ef4444'
    };

    statusEl.style.display = 'block';
    statusEl.style.borderLeft = `3px solid ${colors[type]}`;
    statusEl.innerHTML = message;

    if (type === 'success') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 5000);
    }
}

// Cancel all active jobs
async function cancelAllJobs() {
    const confirmed = confirm('Cancel All Active Jobs?\n\nThis will stop all running and pending jobs and close TikTok on all devices.\n\nContinue?');
    if (!confirmed) return;

    showJobMgmtStatus('Cancelling all active jobs and closing TikTok...', 'info');

    try {
        const result = await window.electronAPI.cancelAllJobs();

        if (result.success) {
            showJobMgmtStatus(
                `Successfully cancelled ${result.count} job(s) and closed TikTok on all devices`,
                'success'
            );
            refreshJobs();
        } else {
            showJobMgmtStatus(`Failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showJobMgmtStatus(`Error: ${error.message}`, 'error');
    }
}

// Delete all jobs
async function deleteAllJobs() {
    const confirmed = confirm('Delete ALL Jobs?\n\nThis will permanently delete ALL jobs from database including completed ones.\n\nThis action CANNOT be undone!\n\nContinue?');
    if (!confirmed) return;

    // Double confirmation for safety
    const doubleConfirm = confirm('FINAL WARNING!\n\nAre you ABSOLUTELY SURE you want to delete ALL jobs?');
    if (!doubleConfirm) return;

    showJobMgmtStatus('Deleting all jobs...', 'info');

    try {
        const result = await window.electronAPI.deleteAllJobs();

        if (result.success) {
            showJobMgmtStatus(
                `Successfully deleted ${result.count} job(s)`,
                'success'
            );
            refreshJobs();
        } else {
            showJobMgmtStatus(`Failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showJobMgmtStatus(`Error: ${error.message}`, 'error');
    }
}


// Listen to updates
window.electronAPI.onJobUpdate((data) => {
    console.log('Job update received:', data);
    refreshJobs();
});

// Init
refreshJobs();
setInterval(() => refreshJobs(), 3000);
