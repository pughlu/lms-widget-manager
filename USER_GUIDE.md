# LMS Widget Manager — Comprehensive User & Widget Author Guide

The **LMS Widget Manager** is a lightweight, framework-agnostic TypeScript library designed to orchestrate data synchronization between a host Learning Management System (currently optimized for **Moodle**) and embedded interactive widgets (such as code editors, math tools, chemistry sketchers, or simulations).

---

## 📑 Table of Contents
1. [Architecture & Philosophy](#1-architecture--philosophy)
2. [Guide for LMS Users & Question Authors (Teachers & Admins)](#2-guide-for-lms-users--question-authors-teachers--admins)
   - [Basic HTML Structure](#basic-html-structure)
   - [Targeting Moodle Textareas](#targeting-moodle-textareas)
   - [Fail-Fast Collision Prevention](#fail-fast-collision-prevention)
   - [Contextual Run Modes & Teacher Overrides](#contextual-run-modes--teacher-overrides)
   - [Debugging: Keeping Answer Boxes Visible](#debugging-keeping-answer-boxes-visible)
   - [Starter Code & Host Insertion Buttons](#starter-code--host-insertion-buttons)
   - [Styling & Custom Error Displays](#styling--custom-error-displays)
   - [Crash Recovery & Offline Backups](#crash-recovery--offline-backups)
3. [Guide for Widget Authors (Developers)](#3-guide-for-widget-authors-developers)
   - [Supported Widget Types (Iframe vs Web Component)](#supported-widget-types-iframe-vs-web-component)
   - [Communication Protocol & Message Types](#communication-protocol--message-types)
   - [The `IWidgetConfig` Object](#the-iwidgetconfig-object)
   - [Active Synchronization & Debouncing](#active-synchronization--debouncing)
   - [Two-Way Height & Width Synchronization](#two-way-height--width-synchronization)
   - [Starter Code & Cursor Content Insertion](#starter-code--cursor-content-insertion)
   - [Handling Run Modes in Widgets](#handling-run-modes-in-widgets)
   - [Custom Error Slots (`data-lms-error-slot`)](#custom-error-slots-data-lms-error-slot)
   - [Full Minimal Iframe Widget Example](#full-minimal-iframe-widget-example)
   - [Full Minimal Web Component Widget Example](#full-minimal-web-component-widget-example)
4. [Quick Reference Cheat Sheets](#4-quick-reference-cheat-sheets)
   - [HTML Data Attributes](#html-data-attributes)
   - [CSS Custom Properties (Variables)](#css-custom-properties-variables)
   - [Message & Event Contract](#message--event-contract)
   - [Moodle RunMode Deduction Rules](#moodle-runmode-deduction-rules)

---

## 1. Architecture & Philosophy

The LMS Widget Manager solves the common risks associated with embedding custom interactive JavaScript tools into LMS environments:
- **Zero Destructive Overwrites**: The manager never empties teacher-authored HTML or wipes container markup.
- **Fail-Fast Data Safety**: If a storage save fails, the target answerbox is deleted, or two widgets target the same answerbox, the manager **immediately locks down** the widget. This prevents students from spending hours typing into an unsaved, broken widget.
- **Strict Decoupling**: Widgets do not need to know they are running in Moodle, and Moodle does not need to know the inner workings of the widget.
- **Dual Transport Support**: Works seamlessly with cross-origin or same-origin `<iframe>` elements (via `window.postMessage`) and Native Web Components / custom elements (via DOM `CustomEvent`).

```
┌─────────────────────────────────────────────────────────────┐
│                       HOST LMS PAGE                         │
│                                                             │
│  ┌────────────────────────┐        ┌─────────────────────┐  │
│  │  Moodle <textarea>     │◀───────│ MoodleStorageAdapter│  │
│  │  (offscreen or visible)│        └──────────┬──────────┘  │
│  └────────────────────────┘                   │             │
│                                      ┌────────┴──────────┐  │
│  ┌────────────────────────┐          │ WidgetController  │  │
│  │  MoodleContextAdapter  │─────────▶│   (The Maestro)   │  │
│  │  (URLs, DOM, RunMode)  │          └────────┬──────────┘  │
│  └────────────────────────┘                   │             │
│                                    ┌──────────┴──────────┐  │
│                                    │  MessengerAdapter   │  │
│                                    └──────────┬──────────┘  │
└───────────────────────────────────────────────┼─────────────┘
                                                │
                       postMessage / CustomEvent│
                                                ▼
                   ┌─────────────────────────────────────────┐
                   │             EMBEDDED WIDGET             │
                   │  (<iframe> or Custom Web Component)     │
                   └─────────────────────────────────────────┘
```

---

## 2. Guide for LMS Users & Question Authors (Teachers & Admins)

As a teacher or course administrator authoring questions in Moodle (e.g. Essay questions or custom quiz question types), you can embed widgets directly into question text.

### Basic HTML Structure

To embed a widget, wrap your widget element inside a container with the class `.lms-widget-container`:

#### Embedding an IFrame Widget
```html
<div class="lms-widget-container">
  <iframe 
    data-lms-widget="true" 
    src="https://widgets.example.edu/code-editor.html" 
    style="width: 100%; height: 350px; border: none;">
  </iframe>
</div>
```

#### Embedding a Web Component Widget
```html
<div class="lms-widget-container">
  <code-scratchpad data-lms-widget="true"></code-scratchpad>
</div>
```

> **Note**: The manager automatically scans for `.lms-widget-container` elements. If the widget element inside (`[data-lms-widget]`) is rendered asynchronously or loaded via JavaScript, a patient `MutationObserver` will wait for it to mount and wire it up automatically.

---

### Targeting Moodle Textareas

The manager automatically discovers the associated Moodle answer `<textarea>`. It uses the following resolution hierarchy:

1. **Explicit CSS Selector** via `data-lms-target-textarea`:
   ```html
   <div class="lms-widget-container" data-lms-target-textarea="#q12_answer">
     <iframe data-lms-widget="true" src="..."></iframe>
   </div>
   ```
2. **Explicit Input Name** via `data-lms-textarea-name`:
   ```html
   <div class="lms-widget-container" data-lms-textarea-name="q123:1_answer">
     <iframe data-lms-widget="true" src="..."></iframe>
   </div>
   ```
3. **Automatic Question Proximity (Recommended)**:
   If no attribute is provided, the manager automatically looks up the parent Moodle question container (`.que`, `.form-item`, `.fitem`, or `.felement`) and finds the nearest textarea not contained inside the widget itself.

---

### Fail-Fast Collision Prevention

To eliminate silent grading and data corruption:
- **Each Moodle textarea can only be bound to one widget.**
- If two `.lms-widget-container` elements resolve to the same `<textarea>`, the second widget will **abort immediately** and display a red collision alert banner:
  > ⛔ **LMS Widget Fail-Fast Collision Error**: Multiple widgets bound to same box. Initialization aborted to prevent data corruption.
- The original HTML content inside your container is **not deleted**; the collision banner is safely overlaid on top.

---

### Contextual Run Modes & Teacher Overrides

The manager inspects Moodle's environment (URL structure and DOM cues) to automatically establish the current **Run Mode**:

| Run Mode | When Detected in Moodle | Default Interaction State |
| :--- | :--- | :--- |
| `attempt` | Student taking active quiz (`/mod/quiz/attempt.php`) | **Interactive**: Full editing allowed |
| `edit` | Teacher editing question bank (`/question/bank/editquestion/` or `question.php`) | **Authoring**: Teacher can configure starter code |
| `grade` | Teacher manually grading quiz (`/mod/quiz/report.php?mode=grading` or comment box present) | **Grading**: Student code read-only, grading tools visible |
| `review` | Student reviewing submitted quiz (`/mod/quiz/review.php` or locked textarea) | **Read-Only**: Student response locked |

#### Manual Overrides
You can manually force a specific run mode or read-only state for testing or specialized scenarios using namespaced HTML attributes on the container:
```html
<!-- Force authoring mode -->
<div class="lms-widget-container" data-lms-run-mode="edit">
  ...
</div>

<!-- Force read-only view -->
<div class="lms-widget-container" data-lms-readonly="true">
  ...
</div>
```

---

### Debugging: Keeping Answer Boxes Visible

By default, the manager hides Moodle's native `<textarea>` off-screen (`left: -9999px; opacity: 0`) while keeping it fully functional for form submission and native autosave.

To inspect the native Moodle textarea side-by-side with your widget during testing, add `data-lms-widget-show-answerbox="true"` to the container:

```html
<div class="lms-widget-container" data-lms-widget-show-answerbox="true">
  <iframe data-lms-widget="true" src="..."></iframe>
</div>
```

---

### Starter Code & Host Insertion Buttons

You can place "Starter Code" or "Insert Template" buttons outside the widget in your question text.

#### 1. Internal Widget Starter Code (Recommended)
Widget authors can build a "Use Starter Code" button directly inside the widget header or toolbar. When clicked, the widget inserts the code and emits a `SYNC_CONTENT` message.

#### 2. Host Page Starter Buttons
If you provide an external button in Moodle question text:
```html
<button type="button" id="insert-starter-btn">Insert Template</button>
<pre id="template-text">def solve():
    # Write your solution here
    pass
</pre>

<div class="lms-widget-container" id="my-widget">
  <iframe data-lms-widget="true" src="..."></iframe>
</div>

<script>
  document.getElementById('insert-starter-btn').addEventListener('click', () => {
    const code = document.getElementById('template-text').textContent;
    // Append trailing newline so subsequent typing starts on a fresh line
    const textToInsert = code.endsWith('\n') ? code : code + '\n';

    // Fully decoupled: dispatch event and let LMSWidgetManager route it
    document.dispatchEvent(new CustomEvent('lms-widget:insert-content', {
      detail: { content: textToInsert }
    }));
  });
</script>
```

> **Best Practice**: The host button or sender should format text (such as adding a trailing newline `\n`) before calling `insertContent()`. The manager's transport layer passes string payloads directly without modifying whitespace.

---

### Styling & Custom Error Displays

When an error occurs (such as Moodle session expiration, network failure, or an invalid answerbox), the manager locks the widget and presents an alert. You can customize the look and feel using CSS variables:

```css
:root {
  --lms-widget-overlay-bg: rgba(15, 23, 42, 0.85); /* Backdrop overlay */
  --lms-widget-error-bg: #991b1b;                  /* Alert card background */
  --lms-widget-error-text: #ffffff;                /* Title and text color */
  --lms-widget-error-border: #f87171;              /* Alert card border */
  --lms-widget-error-subtext: #fecaca;             /* Detail explanation text */
}
```

#### Dedicated In-Widget Error Slot
If you prefer error messages to render inside a specific designated box rather than a floating banner overlay, include a container with `data-lms-error-slot`:
```html
<div class="lms-widget-container">
  <div data-lms-error-slot style="display: none; padding: 12px; background: #fee2e2; color: #991b1b;"></div>
  <iframe data-lms-widget="true" src="..."></iframe>
</div>
```

---

### Crash Recovery & Offline Backups

The manager provides a transparent safety net against browser crashes, tab reloads, and temporary disconnections:
1. Every successful write to the Moodle textarea is mirrored to `localStorage` with a timestamped JSON record.
2. If the student refreshes the quiz before Moodle's native autosave completes, the manager detects the empty textarea and restores the backup.
3. To prevent storage clutter, `WidgetBootstrapper` automatically runs a garbage collection routine on load, clearing backups older than **14 days**.

---

## 3. Guide for Widget Authors (Developers)

If you are developing an interactive widget (e.g. Monaco editor, Blockly workspace, GeoGebra frame, or custom web component), this section details how your widget communicates with the host manager.

### Supported Widget Types (Iframe vs Web Component)

The manager supports two integration patterns:
1. **`<iframe>` Widgets**: Communicate via standard browser `window.postMessage`. The manager validates `event.source` strictly to prevent cross-frame message pollution.
2. **Web Components & Custom DOM Elements**: Communicate via DOM `CustomEvents` dispatched on the widget element (`host:*` and `widget:*` event names).

---

### Communication Protocol & Message Types

All communication between host and widget follows this standardized contract:

```
HOST (Manager)                                        WIDGET
      │                                                  │
      │─── LOAD_CONTENT (initial content & config) ─────▶│
      │                                                  │
      │◀── REQUEST_CONTENT (optional reload request) ────│
      │                                                  │
      │◀── SYNC_CONTENT ({ content, msgId }) ────────────│
      │─── SYNC_ACK ({ msgId, serverHash, success }) ───▶│
      │                                                  │
      │─── INSERT_CONTENT ({ content }) ────────────────▶│
      │                                                  │
      │◀── SYNC_HEIGHT ({ height }) ─────────────────────│
      │                                                  │
      │─── ERROR_LOCKDOWN (on critical save failure) ───▶│
```

#### Message Reference:

| Message Type | Direction | Payload Structure | Purpose |
| :--- | :--- | :--- | :--- |
| `LOAD_CONTENT` | Host ➔ Widget | `{ content: string, config: IWidgetConfig }` | Pushes initial code/content and environment settings on boot. |
| `REQUEST_CONTENT` | Widget ➔ Host | `undefined` or `{}` | Asks the host to re-send current storage state and config. |
| `SYNC_CONTENT` | Widget ➔ Host | `{ content: string, msgId?: string }` or `string` | Widget submits new user content to be saved to Moodle. |
| `SYNC_ACK` | Host ➔ Widget | `{ msgId: string, serverHash: string, success: true }` | Host acknowledges that content was saved to Moodle. |
| `INSERT_CONTENT` | Host ➔ Widget | `{ content: string }` | Host asks widget to insert snippet at current cursor position. |
| `SYNC_HEIGHT` | Widget ➔ Host | `{ height: number }` or `number` | Widget requests container height change to eliminate scrollbars. |
| `ERROR_LOCKDOWN`| Host ➔ Widget | `{ message: string }` | Host notifies widget that fatal error occurred; widget must lock. |

---

### The `IWidgetConfig` Object

Sent during `LOAD_CONTENT`. Contains:
```typescript
interface IWidgetConfig {
  /** True if the student should NOT be allowed to edit. */
  isReadOnly: boolean;
  /** Environment mode: 'attempt' | 'edit' | 'grade' | 'review' */
  runMode: 'attempt' | 'edit' | 'grade' | 'review';
  /** Optional cell/block configuration */
  defaultCellType?: string;
  /** UI flag indicating whether mass insertion actions should be hidden */
  disableInsertAll?: boolean;
  /** Any custom JSON attributes passed via container attributes */
  [key: string]: unknown;
}
```

---

### Active Synchronization & Debouncing

When the user types or alters state within the widget:
1. **Debounce**: Wait **150ms–300ms** after the last keystroke before sending `SYNC_CONTENT`.
2. **Assign a `msgId`**: Include a unique message ID (e.g. `msg-` + random string) so you can correlate the `SYNC_ACK`.
3. **Show Sync Status**:
   - Change UI indicator to **"Syncing..."** on input.
   - When `SYNC_ACK` arrives matching the latest `msgId`, change indicator to **"Saved / Synced"**.

---

### Two-Way Height & Width Synchronization

To deliver an integrated look without double scrollbars:
1. **Width Responsibility**: The host page controls widget width. Set your widget style to `width: 100%`.
2. **Height Responsibility**: The widget should observe its own content height and emit `SYNC_HEIGHT`.
   **CRITICAL**: Do NOT use `window.addEventListener('resize')` to trigger height sync. Because the host changes the iframe's height, this will create an infinite feedback doom loop where the widget continuously shrinks.
   Instead, use a `ResizeObserver` on your main content container:
   ```javascript
   let lastHeight = 0;
   const container = document.querySelector('.widget-container'); // Your main wrapper
   const resizeObserver = new ResizeObserver((entries) => {
     for (let entry of entries) {
       const height = entry.target.offsetHeight;
       if (height !== lastHeight) {
         lastHeight = height;
         window.parent.postMessage({
           type: 'SYNC_HEIGHT',
           payload: { height }
         }, '*');
       }
     }
   });
   resizeObserver.observe(container);
   ```

---

### Starter Code & Cursor Content Insertion

#### Handling External Host Insertions (`INSERT_CONTENT`)
When an `INSERT_CONTENT` message is received from the host page (e.g. from an external button placed by the teacher in the question HTML):
1. If your widget has an active cursor/selection, replace the selected range or insert the snippet at the cursor.
2. If no cursor is active, append the snippet to the end of the document.
3. Automatically trigger your internal `input` or change handler so that the merged content is debounced and synchronized back to the host.
4. **Native Web Component Fallback**: For Web Components, if your component does not call `event.preventDefault()` on `host:insert-content` or `widget:insert-content`, the manager automatically searches for an internal `<textarea>` or `<input>`, inserts the text at its selection cursor, and fires an `input` event.

#### Self-Contained Widgets (Internal Question Text, Editable Area & Internal Buttons)
Many widgets are designed as complete, self-contained interactive applets—incorporating the question instructions, an editable code or math workspace, and internal buttons such as **"Insert Starter Code"**, **"Reset to Template"**, or **"Insert Snippet"**.

##### How should the widget act when the user clicks an internal button?
It should act with the **exact same user-facing semantics as an external element**, but **without** making a redundant roundtrip out to the host manager:

1. **Do NOT roundtrip through the host**: The widget should not message the host just to ask the host to send an `INSERT_CONTENT` message back to itself. That introduces unnecessary asynchronous latency.
2. **Format text with newline**: Ensure the inserted template has appropriate trailing whitespace/newlines (`\n`) so subsequent student input appears cleanly below.
3. **Cursor & Selection Awareness**: If the student has placed their cursor or highlighted text in the editable area, insert at that location. If not focused, append to the end or replace initial empty state.
4. **Focus & UI Stats**: Re-focus the editor and refresh line/character count counters.
5. **Emit `SYNC_CONTENT` (Debounced)**: Trigger the widget's standard debounced synchronization logic. This persists the newly inserted text to Moodle's textarea and local storage backup immediately.
6. **Respect Read-Only State**: If `config.isReadOnly` is `true` (e.g., during `review` mode or past submission deadlines), disable internal insertion buttons or ignore clicks.

##### Best-Practice Unified Architecture (DRY):
The most robust approach is to write a single internal insertion function inside your widget. Both internal button clicks and host `INSERT_CONTENT` events delegate to this same function:

```javascript
// Inside your widget script:
function insertSnippetIntoEditor(text) {
  if (isLocked || editor.readOnly) return;

  // 1. Ensure trailing newline formatting
  const formatted = text.endsWith('\n') ? text : text + '\n';

  // 2. Insert at selection or cursor
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? editor.value.length;
  const current = editor.value;

  editor.value = current.substring(0, start) + formatted + current.substring(end);
  editor.selectionStart = editor.selectionEnd = start + formatted.length;

  // 3. Focus editor and update statistics/line numbers
  editor.focus();
  updateEditorStats();

  // 4. Trigger standard sync to Moodle (via input event or direct debounced sync)
  triggerSync();
}

// Case A: User clicks an INTERNAL button inside the widget
document.getElementById('internal-insert-template-btn')?.addEventListener('click', () => {
  const templateCode = document.getElementById('internal-question-starter').textContent;
  insertSnippetIntoEditor(templateCode);
});

// Case B: Host manager sends an EXTERNAL INSERT_CONTENT message
window.addEventListener('message', (event) => {
  const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  if (msg?.type === 'INSERT_CONTENT') {
    insertSnippetIntoEditor(msg.payload?.content || '');
  }
});
```

---

### Handling Run Modes in Widgets

Your widget should inspect `config.runMode` received in `LOAD_CONTENT`:

```javascript
function applyRunMode(runMode, isReadOnly) {
  switch (runMode) {
    case 'edit':
      // Teacher Authoring Mode:
      // Show starter code authoring tools, test cell editors, or solution inputs.
      editor.setReadOnly(false);
      break;

    case 'grade':
      // Teacher Grading Mode:
      // Student submission is read-only.
      // Display automated grading feedback, test run outputs, or rubric scoring.
      editor.setReadOnly(true);
      break;

    case 'review':
      // Post-Submission Student Review Mode:
      // Display submitted answer in read-only mode with diffs or feedback.
      editor.setReadOnly(true);
      break;

    case 'attempt':
    default:
      // Student Attempt Mode:
      // Normal interactive mode unless isReadOnly flag is explicitly true.
      editor.setReadOnly(Boolean(isReadOnly));
      break;
  }
}
```

---

### Custom Error Slots (`data-lms-error-slot`)

If a save failure occurs, the manager automatically blurs the widget and displays an alert overlay. If your widget design includes a dedicated status bar or notification banner where you want these messages to appear:
- Place an element with attribute `data-lms-error-slot` inside your container.
- When an error occurs, the manager writes the error text into this element and sets `display: block`, skipping the generic floating banner overlay.

---

### Full Minimal Iframe Widget Example

Here is a complete, copy-pasteable implementation of an `<iframe>` widget:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; font-family: monospace; }
    #toolbar { display: flex; justify-content: space-between; padding: 6px 10px; background: #222; color: #fff; }
    #editor { width: 100%; height: 200px; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; font-family: inherit; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="mode-label">ATTEMPT</span>
    <span id="sync-status">Synced</span>
  </div>
  <textarea id="editor" placeholder="Type your answer here..."></textarea>

  <script>
    const editor = document.getElementById('editor');
    const syncStatus = document.getElementById('sync-status');
    const modeLabel = document.getElementById('mode-label');
    let debounceTimer = null;
    let isLocked = false;

    // 1. Listen for messages from Host LMS Manager
    window.addEventListener('message', (event) => {
      let msg = event.data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return; }
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'LOAD_CONTENT': {
          const { content, config } = msg.payload || {};
          if (content !== undefined) editor.value = content;
          if (config) {
            modeLabel.textContent = config.runMode.toUpperCase();
            if (config.isReadOnly || config.runMode === 'review') {
              editor.readOnly = true;
              syncStatus.textContent = 'Read-Only';
            }
          }
          notifyHeight();
          break;
        }

        case 'SYNC_ACK': {
          if (!isLocked && !editor.readOnly) {
            syncStatus.textContent = 'Saved to LMS';
          }
          break;
        }

        case 'INSERT_CONTENT': {
          if (isLocked || editor.readOnly) return;
          const { content } = msg.payload || {};
          if (typeof content === 'string') {
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + content + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + content.length;
            editor.focus();
            triggerSync();
          }
          break;
        }

        case 'ERROR_LOCKDOWN': {
          isLocked = true;
          editor.disabled = true;
          syncStatus.textContent = 'Save Failed / Locked';
          break;
        }
      }
    });

    // 2. Debounced sync to host
    function triggerSync() {
      if (isLocked || editor.readOnly) return;
      syncStatus.textContent = 'Syncing...';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const msgId = 'msg-' + Math.random().toString(36).substr(2, 9);
        window.parent.postMessage({
          type: 'SYNC_CONTENT',
          payload: { content: editor.value, msgId }
        }, '*');
      }, 200);
      notifyHeight();
    }

    editor.addEventListener('input', triggerSync);

    // 3. Dynamic Height Sync (using ResizeObserver to avoid feedback loops)
    let lastHeight = 0;
    const container = document.getElementById('toolbar').parentElement; // body or wrapper
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const height = entry.target.offsetHeight || entry.target.scrollHeight;
        if (height !== lastHeight) {
          lastHeight = height;
          window.parent.postMessage({
            type: 'SYNC_HEIGHT',
            payload: { height }
          }, '*');
        }
      }
    });
    // Assuming you wrap the body content in a container, or observe body
    resizeObserver.observe(document.body);

    // 4. Request content once ready
    window.parent.postMessage({ type: 'REQUEST_CONTENT' }, '*');
  </script>
</body>
</html>
```

---

### Full Minimal Web Component Widget Example

Here is a complete, copy-pasteable implementation using a native Web Component:

```javascript
class SimpleCodeWidget extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div style="border: 1px solid #ddd; border-radius: 4px; overflow: hidden;">
        <div style="background: #f1f5f9; padding: 6px 10px; display: flex; justify-content: space-between; font-size: 12px;">
          <span id="status">Connecting...</span>
        </div>
        <textarea style="width: 100%; height: 160px; border: none; padding: 8px; font-family: monospace;"></textarea>
      </div>
    `;

    const textarea = this.querySelector('textarea');
    const status = this.querySelector('#status');
    let debounceTimer = null;

    // 1. Listen for host events
    this.addEventListener('host:load-content', (e) => {
      const { content, config } = e.detail;
      if (content !== undefined) textarea.value = content;
      if (config?.isReadOnly) {
        textarea.readOnly = true;
        status.textContent = 'Read-Only';
      } else {
        status.textContent = 'Ready';
      }
    });

    this.addEventListener('host:sync-ack', () => {
      status.textContent = 'Saved to Moodle';
    });

    this.addEventListener('host:insert-content', (e) => {
      e.preventDefault(); // Take manual ownership of insertion
      const { content } = e.detail;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + content + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + content.length;
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this.addEventListener('host:lockdown', () => {
      textarea.disabled = true;
      status.textContent = 'Connection Error: Locked';
    });

    // 2. Dispatch sync event on typing
    textarea.addEventListener('input', () => {
      status.textContent = 'Syncing...';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.dispatchEvent(new CustomEvent('widget:sync-content', {
          detail: { content: textarea.value, msgId: 'wc-' + Date.now() },
          bubbles: true,
          composed: true
        }));
      }, 200);
    });

    // 3. Request initial content
    this.dispatchEvent(new CustomEvent('widget:request-content', {
      bubbles: true,
      composed: true
    }));
  }
}

customElements.define('simple-code-widget', SimpleCodeWidget);
```

---

## 4. Quick Reference Cheat Sheets

### HTML Data Attributes

| Attribute | Location | Values | Purpose |
| :--- | :--- | :--- | :--- |
| `class="lms-widget-container"` | Container Element | N/A | Marks the boundary for manager discovery and initialization. |
| `data-lms-widget="true"` | Widget element (`iframe` or custom tag) | `"true"` | Identifies the interactive guest widget element. |
| `data-lms-target-textarea` | Container Element | CSS selector (e.g. `"#q1_answer"`) | Explicitly binds widget to a specific textarea by selector. |
| `data-lms-textarea-name` | Container Element | Textarea name attribute | Explicitly binds widget to a textarea by its `name` attribute. |
| `data-lms-widget-show-answerbox`| Container Element | `"true"` | **Debug flag**: keeps Moodle answer box visible on screen. |
| `data-lms-run-mode` | Container Element | `'attempt'` \| `'edit'` \| `'grade'` \| `'review'` | Overrides automatic Moodle environment detection. |
| `data-lms-readonly` | Container Element | `"true"` \| `"false"` | Overrides read-only state for testing. |
| `data-lms-default-cell-type` | Container Element | String (e.g. `'code'`) | Configures default cell or input block type. |
| `data-lms-disable-insert-all` | Container Element | `"true"` \| `"false"` | UI flag toggling mass insertion actions. |
| `data-lms-widget-origin` | Container Element | Origin URL (e.g. `https://domain.edu`) | Configures strict `targetOrigin` for iframe `postMessage`. |
| `data-lms-error-slot` | Element inside container | N/A | Custom DOM slot where fatal error messages are written. |
| `data-lms-template-code` | Host question element | N/A | Marks starter template code snippets for auto-wiring. |
| `data-lms-template-label` | Host question element | Text string | Custom button label for starter code injection button. |

---

### CSS Custom Properties (Variables)

| CSS Variable | Default Value | Usage |
| :--- | :--- | :--- |
| `--lms-widget-overlay-bg` | `rgba(255, 255, 255, 0.9)` | Full-container backdrop behind error messages. |
| `--lms-widget-error-bg` | `#b71c1c` | Background color for fatal error and collision alert banners. |
| `--lms-widget-error-text` | `#ffffff` | Primary text and heading color inside alert banners. |
| `--lms-widget-error-border` | `#ef5350` | Border color for alert banners. |
| `--lms-widget-error-subtext`| `#ffebee` | Secondary explanation and technical detail text color. |

---

### Message & Event Contract

| Action | Iframe `postMessage` Type | Web Component CustomEvent Name |
| :--- | :--- | :--- |
| Initialize content & config | `LOAD_CONTENT` | `host:load-content` or `widget:load-content` |
| Request current content | `REQUEST_CONTENT` | `widget:request-content` or `lms-widget:request-content` |
| Sync user edit to LMS | `SYNC_CONTENT` | `widget:sync-content` or `lms-widget:sync-content` |
| Confirm successful save | `SYNC_ACK` | `host:sync-ack` or `widget:sync-ack` |
| Insert text snippet at cursor| `INSERT_CONTENT` | `host:insert-content` or `widget:insert-content` |
| Resize container height | `SYNC_HEIGHT` | `widget:sync-height` or `lms-widget:sync-height` |
| Fatal error lockdown | `ERROR_LOCKDOWN` | `host:lockdown` or `widget:lockdown` |

---

### Moodle RunMode Deduction Rules

The manager sniffs the following Moodle signals (via `MoodleContextAdapter`) to automatically determine `runMode`:

1. **Explicit Attribute**: `data-lms-run-mode` on mount point container.
2. **Edit / Authoring (`'edit'`)**: URL contains `/question/question.php` or `/question/bank/editquestion/`.
3. **Grading (`'grade'`)**: URL contains `/mod/quiz/report.php?mode=grading`, or the DOM contains a visible grading comment box (`.comment-area`, `.gradingform`, `.qtype_essay_response_form`, `.commenttext`).
4. **Review (`'review'`)**: URL contains `/mod/quiz/review.php`, or the Moodle textarea has `disabled` or `readonly` set (and is not in grading mode).
5. **Attempt (`'attempt'`)**: Default active student test attempt.
