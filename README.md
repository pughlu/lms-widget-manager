# LMS Widget Manager

A standalone, framework-agnostic TypeScript orchestrator that safely coordinates data synchronization between a Host LMS (such as a Moodle quiz or assignment page) and Embedded Widgets (e.g., code editors, interactive math components, or simulation blocks).

---

## 🏗 Project Structure

```
.
├── package.json                   # Build scripts and dependencies
├── tsconfig.json                  # Strict TypeScript configuration
├── vite.config.ts                 # Standalone script (IIFE, ESM, CJS) builder
├── deno.json                      # Task runner and test config
├── src/
│   ├── interfaces/
│   │   └── contracts.ts           # Strict interfaces: IWidgetConfig, IStorageAdapter, IMessengerAdapter, IContextAdapter
│   ├── adapters/
│   │   ├── storage/
│   │   │   └── moodle-textarea.ts # Moodle DOM manipulation, autosave trigger, localStorage crash recovery
│   │   ├── messenger/
│   │   │   ├── iframe.ts          # window.postMessage with strict origin & source validation
│   │   │   └── web-component.ts   # CustomEvent transport for Web Components
│   │   └── context/
│   │       └── moodle.ts          # Moodle URL & DOM sniffing to deduce RunMode ('edit'|'attempt'|'grade'|'review')
│   ├── core/
│   │   └── widget-controller.ts   # The Maestro: sync routing, ACKs, blur & fail-fast error lockdown
│   └── index.ts                   # Bootstrapper: DOM scanning, duplicate collision lock, dependency injection
└── tests/
    └── widget_manager.test.ts     # Full automated test suite
```

---

## 🚀 Getting Started

### Building the Standalone Script
To bundle the library for browser and LMS injection:
```bash
deno task bundle
# or (with node installed):
npm run build
```
This generates:
- `dist/lms-widget-manager.iife.js`: Standalone script for direct injection into Moodle via `<script>` tags.
- `dist/lms-widget-manager.es.js`: ES module for modern frontend builds.
- `dist/lms-widget-manager.cjs.js`: CommonJS module.

### Running Tests
To run the automated test suite covering crash recovery, fail-fast collision prevention, and sync ACK:
```bash
deno task test
# or (with node installed):
npm test
```

---

## 💡 How It Works

### Phase 1: Boot & Fail-Fast Collision Prevention
1. The bootstrapper scans for `.widget-mount-point:not([data-widget-initialized])`.
2. Locates the target Moodle `<textarea>`.
3. Verifies that no other widget is already bound to that textarea (`data-widget-bound="true"`). If duplicate is detected, it aborts and renders a clear red error banner to prevent silent data corruption.
4. Auto-detects transport (`<iframe>` vs Web Component with hyphen) and injects the corresponding messenger.
5. Hides the textarea off-screen (`position: absolute; left: -9999px;`) while keeping it inside the form for standard submission.
6. Pushes existing or crash-recovered content to the widget.

### Phase 2: Active Synchronization
1. When the student edits the widget, it emits a sync message/event.
2. `WidgetController` receives the event and writes to the Moodle textarea.
3. Native `input` and `change` events are triggered for Moodle's native autosave.
4. Content is mirrored to `localStorage` for offline / crash safety.
5. The written value is verified. If verified, an ACK with content hash is sent back to the widget.

### Phase 3: Fatal Error Lockdown
If the host DOM rejects the write or storage verification fails:
1. Messenger is locked down immediately.
2. The widget is blurred (`filter: blur(2px); opacity: 0.3; pointer-events: none;`) to prevent further student typing.
3. A prominent red alert banner warns the student that connection has been lost.


# Widget API Contract (Host-to-Guest Protocol)

To successfully embed a widget (like PyNote, a Math editor, or a simple text area) into a Host environment using the generic LMS Widget Manager, the widget must adhere to this standard messaging protocol.

The Widget Manager acts as the **Host**. The Embedded Application acts as the **Guest**.

## 1. Transport Layer

The widget must be prepared to communicate via one of two transport layers, depending on how it is embedded:

*   **Iframe Embedding:** Use `window.postMessage` and `window.addEventListener('message', ...)`.
*   **Web Component / Native DOM:** Use `element.dispatchEvent(new CustomEvent(...))` and `element.addEventListener(...)`.

## 2. Mandatory Behaviors

To prevent data loss and ensure basic functionality, every widget **MUST** implement the following:

### A. Request Initial Content on Boot
When the widget initializes, it must ask the Host for any existing saved data (e.g., resuming a quiz).
*   **Widget Emits:** `REQUEST_CONTENT` (No payload required).
*   *Note: The Host will respond with `LOAD_CONTENT`.*

### B. Handle Incoming Content
The widget must listen for data sent by the Host and populate its UI accordingly.
*   **Host Emits:** `LOAD_CONTENT`
*   **Payload:** `{ payload: string, config: IWidgetConfig }`
*   **Widget Action:** Replace current editor state with `payload`. Configure UI based on `config.isReadOnly` and `config.runMode`.

### C. Sync Content on Change
Whenever the user modifies the widget's data, it must push the new state to the Host for saving (e.g., Moodle autosave).
*   **Widget Emits:** `SYNC_CONTENT`
*   **Payload:** `{ payload: string, msgId: string }`
*   **Widget Action:** Send the full, serialized string representation of the widget's state. Generate a unique `msgId` (e.g., a timestamp or UUID) for this specific save attempt.

## 3. Optional (But Recommended) Behaviors

### A. Handle Save Acknowledgements (ACK)
The Host will confirm when data has been successfully written to the database (or Moodle's DOM).
*   **Host Emits:** `ACK_CONTENT`
*   **Payload:** `{ msgId: string, hash: string }`
*   **Widget Action:** Match the `msgId` to clear any "Saving..." UI indicators.

### B. Dynamic Resizing
If the widget's height changes dynamically (e.g., expanding an output box), it can ask the Host to resize the iframe/container so scrollbars don't appear.
*   **Widget Emits:** `SYNC_HEIGHT`
*   **Payload:** `{ height: number }` (Height in pixels).

### C. Reacting to Context (`runMode`)
The Host will sniff the LMS environment and pass a `runMode` string inside the `LOAD_CONTENT` config payload. The widget should gracefully adapt its UI.

| `runMode` | Expected Widget Behavior |
| :--- | :--- |
| `edit` | Authoring mode. Reveal all metadata tools, hidden tests, and settings. |
| `attempt` | Student mode. Hide tests and settings. Allow standard interaction. |
| `grade` | Manual marking mode. Lock student input, but reveal hidden test outputs and enable grading scratchpads. |
| `review` | Post-assessment. Globally lock the widget (`isReadOnly: true`). Display teacher feedback. |

## 4. Example: A Native DOM "SDK" Wrapper

If you want to turn a simple <textarea> embedded directly in the question into a compliant widget (bypassing the need for an external iframe), you use CustomEvents instead of postMessage:

```javascript
class NativeWidgetWrapper {
    constructor(widgetElement) {
        this.el = widgetElement;
        
        // 1. Listen for Host Messages
        this.el.addEventListener('host:load-content', (e) => {
            this.el.value = e.detail.payload;
            
            // Optional: React to context
            if (e.detail.config.isReadOnly || e.detail.config.runMode === 'review') {
                this.el.disabled = true;
            }
        });

        // 2. Emit changes to Host
        this.el.addEventListener('input', () => {
            this.el.dispatchEvent(new CustomEvent('widget:sync-content', {
                detail: {
                    payload: this.el.value,
                    msgId: Date.now().toString()
                },
                bubbles: true
            }));
        });

        // 3. Request initial data on boot
        // (Timeout ensures the Manager has had a microsecond to attach listeners)
        setTimeout(() => {
            this.el.dispatchEvent(new CustomEvent('widget:request-content', { bubbles: true }));
        }, 50);
    }
}
```

## 5. Standard Embed Code (Inline Native Widget)

This is the HTML boilerplate to place in the Moodle Question text for an inline widget. It includes the synchronous FOUC script to instantly hide the default Moodle UI before the browser paints.

```html
<!-- 1. The fallback / initial state data -->
<pre class="widget-initial-state" style="display: none;">{{INITIAL_CONTENT}}</pre>

<!-- 2. The Mount Point -->
<div id="widget-wrapper-{{UNIQUE_ID}}" class="widget-mount-point" style="position: relative; background: #f8fafc; border-radius: 4px; border: 2px dashed #cbd5e1; padding: 1rem;">

    <!-- Widget Configuration -->
    <script type="application/json" class="widget-config">
        { "theme": "light" }
    </script>
    
    <!-- The Inline Widget Element (Marked with data-widget-component) -->
    <textarea id="inline-editor-{{UNIQUE_ID}}" data-widget-component="true" style="width: 100%; min-height: 150px; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 4px;" placeholder="Type your answer here..."></textarea>

    <!-- Initialize the Guest Widget -->
    <script>
        (function() {
            const el = document.getElementById('inline-editor-{{UNIQUE_ID}}');
            
            el.addEventListener('host:load-content', (e) => {
                el.value = e.detail.payload;
                if (e.detail.config.isReadOnly || e.detail.config.runMode === 'review') {
                    el.disabled = true;
                }
            });

            el.addEventListener('input', () => {
                el.dispatchEvent(new CustomEvent('widget:sync-content', {
                    detail: { payload: el.value, msgId: Date.now().toString() },
                    bubbles: true
                }));
            });

            setTimeout(() => {
                el.dispatchEvent(new CustomEvent('widget:request-content', { bubbles: true }));
            }, 50);
        })();
    </script>

    <!-- 3. FOUC Prevention Script (Synchronous) -->
    <script>
        (function(script) {
            if (!script) return;
            const que = script.closest('.que');
            if (que && que.id) {
                const style = document.createElement('style');
                style.textContent = '#' + que.id + ' .widget-initial-state, ' +
                                    '#' + que.id + ' textarea.qtype_essay_response, ' +
                                    '#' + que.id + ' textarea.form-control, ' +
                                    '#' + que.id + ' textarea.qtype_coderunner_answer ' +
                                    '{ position: absolute !important; left: -9999px !important; visibility: hidden !important; height: 1px !important; }';
                document.head.appendChild(style);
            }
        })(document.currentScript);
    </script>
</div>

<!-- 4. Load the generic LMS Widget Manager -->
<script type="module" src="https://your-server.com/lms-widget-manager.js"></script>
```

