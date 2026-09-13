import { RunMode } from '../interfaces/contracts';

/**
 * Custom Web Component for Question 2: Interactive Scratchpad & Math/Code Box.
 * Communicates via standard CustomEvents (widget:sync-content, widget:load-content, widget:sync-ack).
 */
export class CodeScratchpad extends HTMLElement {
  private textarea: HTMLTextAreaElement | null = null;
  private statusBadge: HTMLElement | null = null;
  private modePill: HTMLElement | null = null;
  private charCountEl: HTMLElement | null = null;
  private isLocked: boolean = false;
  private syncTimer: number | null = null;
  private currentMode: RunMode = 'attempt';

  connectedCallback() {
    if (this.shadowRoot) return;

    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          background: #1e1e2e;
          color: #cdd6f4;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
          border: 1px solid #313244;
          transition: all 0.3s ease;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 14px;
          background: #181825;
          border-bottom: 1px solid #313244;
          font-size: 12px;
        }
        .title-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .mode-pill {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 7px;
          border-radius: 4px;
          border: 1px solid currentColor;
        }
        .mode-attempt {
          color: #89b4fa;
          background: rgba(137, 180, 250, 0.12);
          border-color: #89b4fa;
        }
        .mode-edit {
          color: #f9e2af;
          background: rgba(249, 226, 175, 0.12);
          border-color: #f9e2af;
        }
        .mode-grade {
          color: #a6e3a1;
          background: rgba(166, 227, 161, 0.12);
          border-color: #a6e3a1;
        }
        .mode-review {
          color: #cba6f7;
          background: rgba(203, 166, 247, 0.12);
          border-color: #cba6f7;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 3px 8px;
          border-radius: 12px;
          font-weight: 500;
          font-size: 11px;
          background: #313244;
          color: #a6adc8;
        }
        .badge.synced {
          background: rgba(166, 227, 161, 0.15);
          color: #a6e3a1;
        }
        .badge.syncing {
          background: rgba(249, 226, 175, 0.15);
          color: #f9e2af;
        }
        .badge.locked {
          background: rgba(243, 139, 168, 0.2);
          color: #f38ba8;
        }
        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
        }

        .context-note {
          display: none;
          padding: 6px 14px;
          font-size: 11px;
          border-bottom: 1px solid #313244;
        }
        .note-edit {
          display: block;
          background: #28241c;
          color: #f9e2af;
        }
        .note-grade {
          display: block;
          background: #1b2923;
          color: #a6e3a1;
        }
        .note-review {
          display: block;
          background: #251e33;
          color: #cba6f7;
        }

        .editor-container {
          position: relative;
          display: flex;
        }
        .line-numbers {
          padding: 12px 10px;
          color: #585b70;
          user-select: none;
          text-align: right;
          font-size: 13px;
          line-height: 1.5;
          background: #181825;
          border-right: 1px solid #313244;
          min-width: 24px;
        }
        textarea {
          flex: 1;
          padding: 12px 14px;
          background: transparent;
          border: none;
          color: #cdd6f4;
          font-family: inherit;
          font-size: 13px;
          line-height: 1.5;
          resize: vertical;
          min-height: 160px;
          outline: none;
        }
        textarea:focus {
          outline: none;
        }
        textarea:read-only {
          background: rgba(24, 24, 37, 0.5);
          cursor: not-allowed;
        }
        .footer {
          display: flex;
          justify-content: space-between;
          padding: 6px 14px;
          background: #181825;
          border-top: 1px solid #313244;
          font-size: 11px;
          color: #6c7086;
        }
      </style>

      <div class="header">
        <div class="title-group">
          <span style="font-weight: 600; color: #89b4fa;">✨ &lt;code-scratchpad&gt;</span>
          <span class="mode-pill mode-attempt" id="mode-pill">ATTEMPT</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" id="btn-use-template" style="display: none; background: #313244; color: #89b4fa; border: 1px solid #45475a; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; font-family: inherit; transition: background 0.2s;">✨ Use Starter Code</button>
          <span class="badge synced" id="status-badge">
            <span class="dot"></span>
            <span id="status-text">Connected</span>
          </span>
        </div>
      </div>

      <div class="context-note" id="context-note"></div>

      <div class="editor-container">
        <div class="line-numbers" id="line-numbers">1<br>2<br>3<br>4<br>5</div>
        <textarea id="code-input" spellcheck="false" placeholder="// Enter your solution here..."></textarea>
      </div>

      <div class="footer">
        <span id="transport-label">Transport: DOM CustomEvents (bubbling)</span>
        <span id="char-count">0 characters</span>
      </div>
    `;

    this.textarea = shadow.getElementById('code-input') as HTMLTextAreaElement;
    this.statusBadge = shadow.getElementById('status-badge');
    this.modePill = shadow.getElementById('mode-pill');
    this.charCountEl = shadow.getElementById('char-count');

    this.setupListeners();
  }

  private setupListeners() {
    if (!this.textarea) return;

    // Student typing in editor
    this.textarea.addEventListener('input', () => {
      if (this.isLocked || this.textarea?.readOnly) return;

      this.updateStatus('syncing', 'Syncing...');
      this.updateFooter();

      // Debounce sync event slightly to simulate realistic typing
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        const msgId = 'msg-' + Math.random().toString(36).slice(2, 9);
        this.dispatchEvent(
          new CustomEvent('widget:sync-content', {
            bubbles: true,
            composed: true,
            detail: {
              content: this.textarea?.value || '',
              msgId,
            },
          })
        );
      }, 150) as unknown as number;
    });

    // Inbound: load-content event from WidgetController
    this.addEventListener('widget:load-content', (e: Event) => {
      const customEvt = e as CustomEvent;
      const { content, config } = customEvt.detail || {};
      if (this.textarea && content !== undefined) {
        this.textarea.value = content;
        this.updateFooter();
      }

      if (config) {
        this.applyRunMode(config.runMode, config.isReadOnly);
      }
    });

    // Inbound: insert-content event from WidgetController
    this.addEventListener('widget:insert-content', (e: Event) => {
      if (this.isLocked || this.textarea?.readOnly) return;
      
      const customEvt = e as CustomEvent;
      const { content } = customEvt.detail || {};
      
      if (this.textarea && content) {
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const text = this.textarea.value;
        const before = text.substring(0, start);
        const after = text.substring(end, text.length);
        
        this.textarea.value = before + content + after;
        this.textarea.selectionStart = this.textarea.selectionEnd = start + content.length;
        this.textarea.focus();
        
        this.updateFooter();
        // Trigger a fake input event so the sync timer fires
        this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // Inbound: sync acknowledgement from WidgetController
    this.addEventListener('widget:sync-ack', (_e: Event) => {
      if (!this.isLocked && !this.textarea?.readOnly) {
        this.updateStatus('synced', 'Synced to LMS');
      }
    });

    // Inbound: fatal lockdown
    this.addEventListener('widget:lockdown', (_e: Event) => {
      this.isLocked = true;
      if (this.textarea) {
        this.textarea.disabled = true;
      }
      this.updateStatus('locked', 'Locked Down');
    });

    // Wire internal starter template button if a starter pre block is present in the question
    const templateBtn = this.shadowRoot?.getElementById('btn-use-template') as HTMLButtonElement | null;
    const parentQuestion = this.closest('.que, .form-item, form');
    const templatePre = parentQuestion?.querySelector<HTMLElement>('[data-lms-template-code], [data-lms-template-content], .starter-code');

    if (templateBtn && templatePre) {
      templateBtn.style.display = 'inline-block';
      templateBtn.addEventListener('click', () => {
        if (this.isLocked || this.textarea?.readOnly) return;
        const rawText = templatePre.innerText !== undefined ? templatePre.innerText : (templatePre.textContent || '');
        const textToInsert = rawText.endsWith('\n') ? rawText : rawText + '\n';
        
        this.dispatchEvent(
          new CustomEvent('widget:insert-content', {
            detail: { content: textToInsert },
          })
        );
        
        const origText = templateBtn.innerHTML;
        templateBtn.innerHTML = '✅ Inserted!';
        setTimeout(() => templateBtn.innerHTML = origText, 1500);
      });
    }

    // Notify host that we are ready to receive initial content
    this.dispatchEvent(
      new CustomEvent('widget:request-content', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private applyRunMode(mode: RunMode, isReadOnly?: boolean) {
    this.currentMode = mode || 'attempt';

    if (this.modePill) {
      this.modePill.textContent = this.currentMode.toUpperCase();
      this.modePill.className = `mode-pill mode-${this.currentMode}`;
    }

    const noteEl = this.shadowRoot?.getElementById('context-note');
    if (noteEl) {
      noteEl.className = 'context-note';
      noteEl.style.display = 'none';

      if (this.currentMode === 'edit') {
        noteEl.style.display = 'block';
        noteEl.className = 'context-note note-edit';
        noteEl.innerHTML = '🛠️ <strong>Authoring Mode:</strong> Teacher scratchpad & metadata unconstrained.';
      } else if (this.currentMode === 'grade') {
        noteEl.style.display = 'block';
        noteEl.className = 'context-note note-grade';
        noteEl.innerHTML = '⚖️ <strong>Grading Mode:</strong> Student answer preserved. Teacher scratchpad active.';
      } else if (this.currentMode === 'review') {
        noteEl.style.display = 'block';
        noteEl.className = 'context-note note-review';
        noteEl.innerHTML = '🔍 <strong>Review Mode:</strong> Final submitted attempt. Editing is locked.';
      }
    }

    if (this.textarea) {
      if (this.currentMode === 'review' || this.currentMode === 'grade') {
        this.textarea.readOnly = true;
        this.updateStatus('locked', this.currentMode === 'grade' ? 'Locked (Grading)' : 'Read-Only');
      } else if (isReadOnly) {
        this.textarea.readOnly = true;
        this.updateStatus('locked', 'Read-Only');
      } else {
        this.textarea.readOnly = false;
        this.updateStatus('synced', 'Connected');
      }
    }
  }

  private updateStatus(type: 'synced' | 'syncing' | 'locked', label: string) {
    if (!this.statusBadge) return;
    this.statusBadge.className = `badge ${type}`;
    const textEl = this.statusBadge.querySelector('#status-text');
    if (textEl) textEl.textContent = label;
  }

  private updateFooter() {
    if (!this.textarea || !this.charCountEl) return;
    const len = this.textarea.value.length;
    const lines = this.textarea.value.split('\n').length;
    this.charCountEl.textContent = `${len} chars | ${lines} lines`;

    const lineNumbersEl = this.shadowRoot?.getElementById('line-numbers');
    if (lineNumbersEl) {
      let nums = '';
      for (let i = 1; i <= Math.max(lines, 5); i++) {
        nums += `${i}<br>`;
      }
      lineNumbersEl.innerHTML = nums;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('code-scratchpad')) {
  customElements.define('code-scratchpad', CodeScratchpad);
}
