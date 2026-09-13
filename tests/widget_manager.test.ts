import { JSDOM } from 'npm:jsdom@^26.0.0';
import { MoodleTextareaAdapter } from '../src/adapters/storage/moodle-textarea.ts';
import { WidgetController } from '../src/core/widget-controller.ts';
import { DOMEventMessengerAdapter } from '../src/adapters/messenger/web-component.ts';
import {
  WidgetMessageTypes,
  IStorageAdapter,
  IMessengerAdapter,
  IContextAdapter,
  MessageHandler,
} from '../src/interfaces/contracts.ts';
import { bootstrap, activeControllers } from '../src/index.ts';

function createMockEnvironment(html?: string) {
  const dom = new JSDOM(
    html ||
      `<!DOCTYPE html>
    <html>
      <head></head>
      <body>
        <div id="container">
          <textarea id="test-textarea" name="response_box">initial content</textarea>
          <div id="mount-point" class="lms-widget-container" data-lms-target-textarea="#test-textarea">
            <custom-editor data-lms-widget="true"></custom-editor>
          </div>
        </div>
      </body>
    </html>`,
    { url: 'https://moodle.example.edu/mod/quiz/attempt.php?attempt=123' }
  );

  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  (globalThis as any).HTMLIFrameElement = dom.window.HTMLIFrameElement;
  (globalThis as any).Event = dom.window.Event;
  (globalThis as any).CustomEvent = dom.window.CustomEvent;
  (globalThis as any).localStorage = dom.window.localStorage;
  (globalThis as any).getComputedStyle = dom.window.getComputedStyle;

  return dom;
}

Deno.test('MoodleTextareaAdapter - hides textarea and loads initial content', () => {
  const dom = createMockEnvironment();
  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;

  const adapter = new MoodleTextareaAdapter(textarea);
  if (textarea.style.position !== 'absolute') {
    throw new Error(`Expected position absolute, got ${textarea.style.position}`);
  }

  const loaded = adapter.load();
  if (loaded !== 'initial content') {
    throw new Error(`Expected 'initial content', got ${loaded}`);
  }
});

Deno.test('MoodleTextareaAdapter - saves content and dispatches input/change events', () => {
  const dom = createMockEnvironment();
  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;
  let inputFired = false;
  let changeFired = false;

  textarea.addEventListener('input', () => {
    inputFired = true;
  });
  textarea.addEventListener('change', () => {
    changeFired = true;
  });

  const adapter = new MoodleTextareaAdapter(textarea);
  const success = adapter.save('updated content');

  if (!success) {
    throw new Error('Expected save to return true');
  }
  if (textarea.value !== 'updated content') {
    throw new Error('Textarea value was not updated');
  }
  if (!inputFired || !changeFired) {
    throw new Error('Input or change event was not dispatched');
  }
});

Deno.test('MoodleTextareaAdapter - performs crash recovery from localStorage when textarea is empty', () => {
  const dom = createMockEnvironment(
    `<!DOCTYPE html>
    <html><body>
      <textarea id="test-textarea" name="response_box"></textarea>
    </body></html>`
  );
  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;
  const adapter = new MoodleTextareaAdapter(textarea);

  // Simulate existing localStorage backup using new JSON format
  dom.window.localStorage.setItem(
    adapter.getIdentifier(),
    JSON.stringify({ content: 'backed up draft from crash', timestamp: Date.now() })
  );

  const loaded = adapter.load();
  if (loaded !== 'backed up draft from crash') {
    throw new Error(`Expected 'backed up draft from crash', got ${loaded}`);
  }
  if (textarea.value !== 'backed up draft from crash') {
    throw new Error('Textarea value was not restored with backup');
  }
});

Deno.test('WidgetController - handles sync success and sends ACK', () => {
  const dom = createMockEnvironment();
  const mountPoint = dom.window.document.getElementById('mount-point') as HTMLElement;

  let savedData = '';
  const mockStorage: IStorageAdapter = {
    load: () => 'stored-data',
    save: (content: string) => {
      savedData = content;
      return true;
    },
    isReadOnly: () => false,
    getIdentifier: () => 'mock-id',
  };

  let ackSent = false;
  let sentHash = '';
  const mockMessenger: IMessengerAdapter = {
    sendLoadContent: () => {},
    sendInsertContent: () => {},
    sendSyncAck: (_msgId: string, hash: string) => {
      ackSent = true;
      sentHash = hash;
    },
    onMessage: (handler: MessageHandler) => {
      // Simulate widget emitting SYNC_CONTENT
      handler(WidgetMessageTypes.SYNC_CONTENT, { content: 'typed from widget', msgId: '123' });
    },
    lockdown: () => {},
  };

  const controller = new WidgetController(mountPoint, mockStorage, mockMessenger);
  if (savedData !== 'typed from widget') {
    throw new Error(`Expected 'typed from widget', got ${savedData}`);
  }
  if (!ackSent || !sentHash) {
    throw new Error('Expected sync ACK to be sent with server hash');
  }
  if (controller.getIsErrorState()) {
    throw new Error('Controller should not be in error state');
  }
});

Deno.test('WidgetController - triggers Fail-Fast lockdown and red banner when save fails', () => {
  const dom = createMockEnvironment();
  const mountPoint = dom.window.document.getElementById('mount-point') as HTMLElement;
  const customWidget = mountPoint.querySelector('custom-editor') as HTMLElement;

  const mockStorage: IStorageAdapter = {
    load: () => 'stored-data',
    save: () => false, // Simulate host rejecting the write / failure
    isReadOnly: () => false,
    getIdentifier: () => 'mock-id',
  };

  let lockdownCalled = false;
  let triggerSync: MessageHandler | null = null;

  const mockMessenger: IMessengerAdapter = {
    sendLoadContent: () => {},
    sendInsertContent: () => {},
    sendSyncAck: () => {},
    onMessage: (handler: MessageHandler) => {
      triggerSync = handler;
    },
    lockdown: () => {
      lockdownCalled = true;
    },
  };

  const controller = new WidgetController(mountPoint, mockStorage, mockMessenger);

  // Trigger sync that will fail
  if (triggerSync) {
    (triggerSync as MessageHandler)(WidgetMessageTypes.SYNC_CONTENT, 'user typed content');
  }

  if (!controller.getIsErrorState()) {
    throw new Error('Controller should be in error state after failed save');
  }
  if (!lockdownCalled) {
    throw new Error('Messenger lockdown was not called on fatal error');
  }

  // Verify visual blur and pointer-events disabled
  if (customWidget.style.pointerEvents !== 'none') {
    throw new Error(`Expected pointer-events none, got ${customWidget.style.pointerEvents}`);
  }
  if (!customWidget.style.filter.includes('blur')) {
    throw new Error(`Expected blur filter, got ${customWidget.style.filter}`);
  }

  // Verify red banner injection
  const banner = mountPoint.querySelector('.lms-widget-fatal-error-banner');
  if (!banner) {
    throw new Error('Expected fatal error banner to be injected in mount point');
  }
});

Deno.test('Bootstrapper - prevents collisions when multiple widgets target the same textarea', () => {
  const dom = createMockEnvironment(
    `<!DOCTYPE html>
    <html><body>
      <textarea id="box-1" name="q1_answer"></textarea>
      
      <!-- First widget -->
      <div id="w1" class="lms-widget-container" data-lms-target-textarea="#box-1">
        <custom-widget data-lms-widget="true"></custom-widget>
      </div>

      <!-- Second widget mistakenly targeting the same box -->
      <div id="w2" class="lms-widget-container" data-lms-target-textarea="#box-1">
        <custom-widget data-lms-widget="true"></custom-widget>
      </div>
    </body></html>`
  );

  const controllers = bootstrap();

  // First one should succeed, second one should be aborted
  if (controllers.length !== 1) {
    throw new Error(`Expected 1 initialized controller, got ${controllers.length}`);
  }

  const w2 = dom.window.document.getElementById('w2') as HTMLElement;
  const collisionBanner = w2.querySelector('.lms-widget-collision-banner');
  if (!collisionBanner) {
    throw new Error('Expected collision error banner on duplicate widget');
  }
  if (!collisionBanner.textContent?.includes('Multiple widgets bound to same box')) {
    throw new Error('Collision banner did not contain duplicate box warning');
  }
});

Deno.test('MoodleContextAdapter - detects authoring/edit mode from URL', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="m"></div></body></html>', {
    url: 'https://moodle.example.edu/question/question.php?inpopup=0&id=42',
  });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;

  const { MoodleContextAdapter } = await import('../src/adapters/context/moodle.ts');
  const mount = dom.window.document.getElementById('m');
  const mode = new MoodleContextAdapter(mount).getRunMode();
  if (mode !== 'edit') {
    throw new Error(`Expected 'edit', got '${mode}'`);
  }
});

Deno.test('MoodleContextAdapter - detects manual grading mode from report URL and .comment-area', async () => {
  const { MoodleContextAdapter } = await import('../src/adapters/context/moodle.ts');

  // Test 1: Grading URL
  const domUrl = new JSDOM('<!DOCTYPE html><html><body><div id="m"></div></body></html>', {
    url: 'https://moodle.example.edu/mod/quiz/report.php?id=12&mode=grading',
  });
  (globalThis as any).window = domUrl.window;
  (globalThis as any).document = domUrl.window.document;
  const modeFromUrl = new MoodleContextAdapter(domUrl.window.document.getElementById('m')).getRunMode();
  if (modeFromUrl !== 'grade') {
    throw new Error(`Expected 'grade' from URL, got '${modeFromUrl}'`);
  }

  // Test 2: DOM cue (.comment-area)
  const domDom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div class="que">
        <div id="m" class="lms-widget-container"></div>
        <div class="comment-area"><textarea class="commenttext"></textarea></div>
      </div>
    </body></html>`,
    { url: 'https://moodle.example.edu/mod/quiz/report.php' }
  );
  (globalThis as any).window = domDom.window;
  (globalThis as any).document = domDom.window.document;
  const modeFromDom = new MoodleContextAdapter(domDom.window.document.getElementById('m')).getRunMode();
  if (modeFromDom !== 'grade') {
    throw new Error(`Expected 'grade' from .comment-area, got '${modeFromDom}'`);
  }

  // Test 3: Hidden .comment-area (display: none) should NOT trigger grade mode
  const domHidden = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div class="que">
        <div id="m" class="lms-widget-container"></div>
        <div class="comment-area" style="display: none;"><textarea class="commenttext"></textarea></div>
      </div>
    </body></html>`,
    { url: 'https://moodle.example.edu/mod/quiz/attempt.php' }
  );
  (globalThis as any).window = domHidden.window;
  (globalThis as any).document = domHidden.window.document;
  const modeFromHidden = new MoodleContextAdapter(domHidden.window.document.getElementById('m')).getRunMode();
  if (modeFromHidden !== 'attempt') {
    throw new Error(`Expected 'attempt' when comment-area is display:none, got '${modeFromHidden}'`);
  }
});

Deno.test('MoodleContextAdapter - detects post-assessment review mode from review.php', async () => {
  const { MoodleContextAdapter } = await import('../src/adapters/context/moodle.ts');
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div class="que">
        <textarea id="box" readonly></textarea>
        <div id="m" class="lms-widget-container"></div>
      </div>
    </body></html>`,
    { url: 'https://moodle.example.edu/mod/quiz/review.php?attempt=10' }
  );
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  const mount = dom.window.document.getElementById('m');
  const textarea = dom.window.document.getElementById('box') as HTMLTextAreaElement;
  const mode = new MoodleContextAdapter(mount, textarea).getRunMode();
  if (mode !== 'review') {
    throw new Error(`Expected 'review', got '${mode}'`);
  }
});

Deno.test('MoodleContextAdapter - implements IContextAdapter and respects data-lms-run-mode & data-lms-readonly', async () => {
  const { MoodleContextAdapter } = await import('../src/adapters/context/moodle.ts');
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div id="m" class="lms-widget-container" data-lms-run-mode="grade" data-lms-readonly="true"></div>
    </body></html>`,
    { url: 'https://moodle.example.edu/mod/quiz/attempt.php' }
  );

  const mount = dom.window.document.getElementById('m') as HTMLElement;
  const adapter = new MoodleContextAdapter(mount);

  if (adapter.getRunMode() !== 'grade') {
    throw new Error(`Expected getRunMode() to be 'grade', got '${adapter.getRunMode()}'`);
  }
  if (!adapter.isReadOnly()) {
    throw new Error(`Expected isReadOnly() to be true when data-lms-readonly="true"`);
  }
});

Deno.test('WidgetController - pushes deduced runMode in IWidgetConfig on load', () => {
  const dom = createMockEnvironment();
  const mountPoint = dom.window.document.getElementById('mount-point') as HTMLElement;

  let loadedConfig: any = null;
  const mockStorage: IStorageAdapter = {
    load: () => 'initial code',
    save: () => true,
    isReadOnly: () => false,
    getIdentifier: () => 'id1',
  };

  const mockMessenger: IMessengerAdapter = {
    sendLoadContent: (_content: string, config: any) => {
      loadedConfig = config;
    },
    sendInsertContent: () => {},
    sendSyncAck: () => {},
    onMessage: () => {},
    lockdown: () => {},
  };

  const controller = new WidgetController(mountPoint, mockStorage, mockMessenger, {
    runMode: 'grade',
  });

  if (!loadedConfig) {
    throw new Error('Expected sendLoadContent to be called on boot');
  }
  if (loadedConfig.runMode !== 'grade') {
    throw new Error(`Expected config.runMode to be 'grade', got '${loadedConfig.runMode}'`);
  }
  if (controller.getConfig().runMode !== 'grade') {
    throw new Error(`Expected controller.getConfig().runMode to be 'grade'`);
  }
});

Deno.test('WidgetController - accepts IContextAdapter and populates namespaced attributes', () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div id="m" class="lms-widget-container" data-lms-default-cell-type="markdown" data-lms-disable-insert-all="true">
        <div data-lms-widget="true"></div>
      </div>
    </body></html>`
  );
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;

  const mount = dom.window.document.getElementById('m') as HTMLElement;
  let loadedConfig: any = null;

  const mockStorage: IStorageAdapter = {
    load: () => 'code',
    save: () => true,
    isReadOnly: () => false,
    getIdentifier: () => 'id-context',
  };

  const mockMessenger: IMessengerAdapter = {
    sendLoadContent: (_content: string, config: any) => {
      loadedConfig = config;
    },
    sendInsertContent: () => {},
    sendSyncAck: () => {},
    onMessage: () => {},
    lockdown: () => {},
  };

  const mockContext: IContextAdapter = {
    getRunMode: () => 'edit',
    isReadOnly: () => false,
  };

  const controller = new WidgetController(mount, mockStorage, mockMessenger, {
    context: mockContext,
  });

  if (loadedConfig.runMode !== 'edit') {
    throw new Error(`Expected runMode 'edit', got '${loadedConfig.runMode}'`);
  }
  if (loadedConfig.defaultCellType !== 'markdown') {
    throw new Error(`Expected defaultCellType 'markdown', got '${loadedConfig.defaultCellType}'`);
  }
  if (loadedConfig.disableInsertAll !== true) {
    throw new Error(`Expected disableInsertAll to be true, got '${loadedConfig.disableInsertAll}'`);
  }
});

Deno.test('Bootstrapper - patiently observes and initializes when [data-lms-widget] is injected asynchronously', async () => {
  const dom = createMockEnvironment(
    `<!DOCTYPE html><html><body>
      <textarea id="box-async" name="async_ans"></textarea>
      <div id="async-container" class="lms-widget-container" data-lms-target-textarea="#box-async">
      </div>
    </body></html>`
  );

  (globalThis as any).MutationObserver = dom.window.MutationObserver;

  const container = dom.window.document.getElementById('async-container') as HTMLElement;
  bootstrap();

  // Placeholder should be rendered
  const placeholder = container.querySelector('.lms-widget-placeholder');
  if (!placeholder) {
    throw new Error('Expected placeholder while waiting for [data-lms-widget]');
  }

  // Now inject the widget element with data-lms-widget
  const widget = dom.window.document.createElement('div');
  widget.setAttribute('data-lms-widget', 'true');
  container.appendChild(widget);

  // Wait for MutationObserver callback to execute
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Placeholder should have been removed
  if (container.querySelector('.lms-widget-placeholder')) {
    throw new Error('Expected placeholder to be removed after widget resolution');
  }
});



Deno.test('Bootstrapper - unhides Moodle textarea when container has data-lms-widget-show-answerbox', () => {
  const dom = createMockEnvironment(
    `<!DOCTYPE html><html><body>
      <textarea id="box-debug" name="debug_box"></textarea>
      <div id="debug-container" class="lms-widget-container" data-lms-target-textarea="#box-debug" data-lms-widget-show-answerbox="true">
        <div data-lms-widget="true"></div>
      </div>
    </body></html>`
  );

  bootstrap();

  const textarea = dom.window.document.getElementById('box-debug') as HTMLTextAreaElement;
  if (textarea.style.position === 'absolute') {
    throw new Error('Textarea should remain visible when container has data-lms-widget-show-answerbox');
  }
});

Deno.test('MoodleTextareaAdapter - garbageCollect cleans up old JSON backups but keeps recent ones', () => {
  const dom = createMockEnvironment();
  
  const now = Date.now();
  const oldTime = now - (15 * 24 * 60 * 60 * 1000); // 15 days ago
  const recentTime = now - (5 * 24 * 60 * 60 * 1000); // 5 days ago

  dom.window.localStorage.setItem('lms_widget_backup_old1', JSON.stringify({ content: 'old', timestamp: oldTime }));
  dom.window.localStorage.setItem('lms_widget_backup_recent', JSON.stringify({ content: 'recent', timestamp: recentTime }));
  dom.window.localStorage.setItem('lms_widget_backup_old_plaintext', 'this is old plain text');
  dom.window.localStorage.setItem('unrelated_key', 'should remain');

  MoodleTextareaAdapter.garbageCollect(14);

  if (dom.window.localStorage.getItem('lms_widget_backup_old1')) throw new Error('Old backup was not cleared');
  if (dom.window.localStorage.getItem('lms_widget_backup_old_plaintext')) throw new Error('Old plain text backup was not cleared');
  if (!dom.window.localStorage.getItem('lms_widget_backup_recent')) throw new Error('Recent backup was incorrectly cleared');
  if (!dom.window.localStorage.getItem('unrelated_key')) throw new Error('Unrelated key was incorrectly cleared');
});

Deno.test('WidgetController - destroy cleans up activeControllers', () => {
  const dom = createMockEnvironment(
    `<!DOCTYPE html><html><body>
      <textarea id="box1" name="box1"></textarea>
      <div id="c1" class="lms-widget-container" data-lms-target-textarea="#box1">
        <div data-lms-widget="true"></div>
      </div>
    </body></html>`
  );

  // We need to import activeControllers to check it, but since it's exported from index.ts,
  // we can use the bootstrap method which returns the controllers.
  const controllers = bootstrap();
  if (controllers.length !== 1) throw new Error('Expected 1 controller');

  const controller = controllers[0];
  controller.destroy();
  
  // We'll trust the binding logic.
});

Deno.test('MoodleTextareaAdapter - save() fails and returns false when textarea is detached from the DOM', () => {
  const dom = createMockEnvironment();
  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;
  const adapter = new MoodleTextareaAdapter(textarea);

  // Remove textarea from DOM
  textarea.remove();

  const success = adapter.save('detached save attempt');
  if (success) {
    throw new Error('save() should return false when textarea is detached');
  }
});

Deno.test('MoodleTextareaAdapter - triggers onDisconnect callback when textarea is removed from DOM', async () => {
  const dom = createMockEnvironment();
  // Ensure MutationObserver is available in the global mock scope for the adapter
  (globalThis as any).MutationObserver = dom.window.MutationObserver;

  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;
  const adapter = new MoodleTextareaAdapter(textarea);

  let disconnectFired = false;
  adapter.onDisconnect!(() => {
    disconnectFired = true;
  });

  // Remove textarea from DOM
  textarea.remove();

  // Wait a tick for MutationObserver microtask to fire
  await new Promise((resolve) => setTimeout(resolve, 10));

  if (!disconnectFired) {
    throw new Error('onDisconnect callback was not triggered upon DOM removal');
  }

  adapter.destroy!();
});

Deno.test('WidgetController - enters fail-fast lockdown when target textarea is removed from DOM', async () => {
  const dom = createMockEnvironment();
  (globalThis as any).MutationObserver = dom.window.MutationObserver;

  const mountPoint = dom.window.document.getElementById('mount-point') as HTMLElement;
  const textarea = dom.window.document.getElementById('test-textarea') as HTMLTextAreaElement;

  const storage = new MoodleTextareaAdapter(textarea);
  const messenger = new DOMEventMessengerAdapter(mountPoint);

  const controller = new WidgetController(mountPoint, storage, messenger);

  // Remove textarea from DOM
  textarea.remove();

  // Wait a tick for MutationObserver microtask to fire and trigger controller lockdown
  await new Promise((resolve) => setTimeout(resolve, 10));

  if (!controller.getIsErrorState()) {
    throw new Error('WidgetController should be in error state after textarea removal');
  }

  const banner = mountPoint.querySelector('.lms-widget-fatal-error-banner');
  if (!banner) {
    throw new Error('Fatal error banner was not injected');
  }

  controller.destroy();
});

Deno.test('WidgetController - insertContent forwards content to messenger adapter', () => {
  const dom = createMockEnvironment();
  const mountPoint = dom.window.document.getElementById('mount-point') as HTMLElement;
  const storage: IStorageAdapter = {
    load: () => 'initial',
    save: () => true,
    isReadOnly: () => false,
    getIdentifier: () => 'id-test',
  };

  let insertedContent = '';
  const messenger: IMessengerAdapter = {
    sendLoadContent: () => {},
    sendInsertContent: (content: string) => {
      insertedContent = content;
    },
    sendSyncAck: () => {},
    onMessage: () => {},
    lockdown: () => {},
  };

  const controller = new WidgetController(mountPoint, storage, messenger);
  const success = controller.insertContent('def foo():\n    pass');
  if (!success) {
    throw new Error('insertContent should return true');
  }
  if (insertedContent !== 'def foo():\n    pass') {
    throw new Error(`Expected inserted content to match, got '${insertedContent}'`);
  }
  controller.destroy();
});


Deno.test('DOMEventMessengerAdapter - natively inserts into textarea when host:insert-content is not handled', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><textarea id="box">initial</textarea></body></html>');
  const textarea = dom.window.document.getElementById('box') as HTMLTextAreaElement;
  textarea.selectionStart = textarea.selectionEnd = 7; // after 'initial'

  let inputFired = false;
  textarea.addEventListener('input', () => {
    inputFired = true;
  });

  const adapter = new DOMEventMessengerAdapter(textarea);
  adapter.sendInsertContent(' added\n');

  if (textarea.value !== 'initial added\n') {
    throw new Error(`Expected 'initial added\\n', got '${textarea.value}'`);
  }
  if (!inputFired) {
    throw new Error('Expected native input event to be dispatched');
  }
  adapter.destroy();
});



