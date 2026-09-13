/lms-widget-manager
│
├── package.json               # Build scripts (Vite/Rollup) for generating a standalone script
├── tsconfig.json              # Strict TypeScript configuration
│
└── /src
    │
    ├── /interfaces
    │   └── contracts.ts       # Defines IWidgetConfig, IStorageAdapter, IMessengerAdapter.
    │                          # (The strict rules that all adapters must follow).
    │
    ├── /adapters
    │   ├── /storage
    │   │   └── moodle-textarea.ts # Implements IStorageAdapter. 
    │   │                          # Knows how to hide Moodle boxes, trigger autosave, and do LocalStorage backups.
    │   │
    │   ├── /messenger
    │   │   ├── iframe.ts          # Implements IMessengerAdapter using window.postMessage.
    │   │   └── web-component.ts   # Implements IMessengerAdapter using DOM CustomEvents.
    │   │
    │   └── /context
    │       └── moodle.ts          # Implements IContextAdapter.
    │                              # Deduces RunMode ('edit'|'attempt'|'grade'|'review') from Moodle URLs & DOM.
    │
    ├── /core
    │   └── widget-controller.ts   # The Maestro. Glues Storage, Messenger, and Context together.
    │                              # Handles the Fail-Fast error UI and visual blurring.
    │
    └── index.ts               # The Bootstrapper. 
                               # Scans the DOM for `.lms-widget-container`, 
                               # instantiates the correct adapters, and starts the Controller.


Module Responsibilities

1. The Interfaces (/interfaces/contracts.ts)

This is the most important file in the manager. It defines the API boundaries. The WidgetController only ever talks to these interfaces; it never directly references Moodle or an iframe.

2. The Storage Adapters (/adapters/storage/)

These files are the only places where LMS-specific DOM manipulation happens.

If you move to Canvas LMS tomorrow, you write canvas-storage.ts and implement the IStorageAdapter methods (load(), save(), isReadOnly()). The rest of the application remains untouched.

3. The Messenger Adapters (/adapters/messenger/)

These files handle the transport layer.

iframe.ts handles the complexities of cross-origin postMessage security.

web-component.ts handles standard browser event bubbling (addEventListener, dispatchEvent).

4. The Core Controller (/core/widget-controller.ts)

This class contains the actual business logic:

"When the widget asks for content, load it from storage and send it."

"When the widget sends new content, save it. If the save fails, lock down the widget and show a red error banner."

5. The Bootstrapper (index.ts)

The entry point. It runs on DOMContentLoaded. It acts as the Dependency Injector, looking at the HTML to decide which adapters to build:

Found an iframe? -> Inject iframe.ts.

Found a custom tag with a hyphen? -> Inject web-component.ts.

Found a duplicate assignment? -> Fail fast and abort.


LMS Widget Manager: Technical Specification

1. Overview & Core Principles

The LMS Widget Manager is a standalone, framework-agnostic TypeScript library. Its sole purpose is to safely orchestrate data between a Host Environment (like a Moodle quiz page) and an Embedded Widget (like a code editor or math tool).

Design Principles:

Strict Orthogonality: The manager knows nothing about the internal logic of the widget, nor does the widget know it's in Moodle.

Fail-Fast Data Safety: If the manager detects a configuration error (e.g., two widgets mapped to the same box) or a save failure, it immediately aborts, locks down the widget, and alerts the user to prevent data loss.

Adapter Pattern: Interactions with the DOM (Storage) and the Widget (Messenger) are abstracted behind strict interfaces.

2. Interface Definitions (/interfaces/contracts.ts)

These contracts dictate how the core controller interacts with the outside world. All implementations must adhere strictly to these types.

IWidgetConfig

Defines the generic configuration passed down to the widget.

isReadOnly: boolean - Prevents the widget from allowing user input.

defaultCellType?: string - Optional default state.

disableInsertAll?: boolean - UI flag for the widget.

[key: string]: any - Allows arbitrary JSON config overriding.

IStorageAdapter

Handles reading and writing strings to the host's database/DOM.

load(): string - Retrieves the current state (must implement crash recovery / LocalStorage checks).

save(content: string): boolean - Writes the state. Must return false if the write was rejected or failed verification.

isReadOnly(): boolean - Returns true if the host environment is locked (e.g., past due date).

getIdentifier(): string - Returns a unique hash for this specific storage instance (used for LocalStorage keys).

IMessengerAdapter

Handles the transport layer to the widget.

sendLoadContent(content: string, config: IWidgetConfig): void - Pushes initial data to the widget.

sendSyncAck(msgId: string, serverHash: string): void - Confirms a successful save back to the widget.

onMessage(handler: (type: string, payload: any, msgId?: string) => void): void - Subscribes to widget events (REQUEST_CONTENT, SYNC_CONTENT, SYNC_HEIGHT).

lockdown(): void - Severs the connection permanently (used during fatal errors).

3. Component Specifications

3.1 Storage: MoodleTextareaAdapter (/adapters/storage/moodle-textarea.ts)

Responsibility: The only file allowed to interact with Moodle's specific DOM classes.

Initialization: Accepts an HTMLTextAreaElement. Immediately hides it via CSS (position: absolute; left: -9999px;). Generates a unique storageKey hashing the page URL and textarea name.

load() logic: Reads textarea.value. If empty, checks localStorage for the unique key. If a backup is found, injects it back into Moodle and returns it.

save(content) logic: Writes to textarea.value. Dispatches input and change events so Moodle's native autosave catches it. Writes to localStorage as a backup. Crucially, compares textarea.value to content after writing and returns the boolean result.

3.2 Messengers (/adapters/messenger/)

Responsibility: Bridging the gap between the Controller and the Widget.

IframeMessengerAdapter: Wraps window.postMessage. Validates event.source === iframe.contentWindow to prevent cross-site scripting (XSS) leaks.

DOMEventMessengerAdapter: Wraps standard CustomEvent dispatching. Listens on the <custom-widget> DOM node for bubbling events (e.g., widget:sync-content).

3.3 The Maestro: WidgetController (/core/widget-controller.ts)

Responsibility: Business logic, event routing, and visual error management.

Constructor: Accepts a mount point HTMLElement, an IStorageAdapter, and an IMessengerAdapter. Instantiates listeners.

Sync Flow: When the messenger emits SYNC_CONTENT, it calls storage.save(payload).

If true: Calculates a hash of the payload and calls messenger.sendSyncAck().

If false: Calls this.triggerErrorState().

Error State (triggerErrorState):

Calls messenger.lockdown().

Applies pointer-events: none; filter: blur(2px); opacity: 0.3; to the widget container.

Injects a highly visible, absolute-positioned red banner warning the user that the connection is lost.

3.4 The Bootstrapper (/index.ts)

Responsibility: Dependency injection and fail-fast collision prevention.

Runs on DOMContentLoaded.

Finds all .lms-widget-container:not([data-lms-widget-initialized]).

Collision Lock: Finds the target textarea. Checks if it has data-lms-widget-bound="true".

If YES: Aborts initialization entirely and overlays a red HTML error banner ("Multiple widgets bound to same box").

If NO: Adds data-lms-widget-bound="true".

Determines Messenger type: If <iframe> exists, instantiate IframeMessengerAdapter. If a custom element (tag with hyphen) exists, instantiate DOMEventMessengerAdapter.

Instantiates the WidgetController with the resolved dependencies.

4. Lifecycle & Data Flow

Phase 1: Boot & Mount

Page loads. Bootstrapper finds mount points.

Bootstrapper claims the Moodle textarea (Fail-Fast check).

Bootstrapper instantiates Storage, Messenger, and Controller.

Controller cleans up placeholder UI and pushes load() data to Messenger.

Phase 2: Active Syncing

Student types in widget.

Widget emits sync event.

Messenger intercepts, passes to Controller.

Controller passes to Storage.

Storage writes to Moodle DOM and LocalStorage backup.

Controller reads boolean result, sends ACK back to Widget.

Phase 3: Fatal Error

Student types, Widget emits sync event.

Moodle DOM rejects the write (e.g., script error, or Moodle locked the box).

Storage returns false.

Controller instantly blurs the widget, preventing further typing, and shows the red banner.