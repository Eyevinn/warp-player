/**
 * Warp Player - Browser Entry Point
 *
 * Handles the browser UI interactions and connects to the Player component
 * for MOQ/WARP streaming and MSE playback.
 */
import { LoggerFactory, LogLevel } from "./logger";
import { Player } from "./player";

// DOM Elements
let serverUrlInput: HTMLInputElement;
let fingerprintUrlInput: HTMLInputElement;
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let statusEl: HTMLDivElement;
let tracksContainerEl: HTMLDivElement;
let minimalBufferInput: HTMLInputElement;
let targetLatencyInput: HTMLInputElement;
let logContainerEl: HTMLDivElement;
// Using a type assertion when needed instead of storing the element
// let logLevelSelect: HTMLSelectElement;
let componentFilterSelect: HTMLSelectElement;
let startBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let browserWarning: HTMLDivElement;

// Player instance
let player: Player | null = null;

// Logger
const logger = LoggerFactory.getInstance().getLogger("Browser");

// Configuration
interface Config {
  defaultServerUrl?: string;
  fingerprintUrl?: string;
  minimalBuffer?: number;
  targetLatency?: number;
}

let config: Config = {
  defaultServerUrl: "https://moqlivemock.demo.osaas.io/moq",
  minimalBuffer: 200,
  targetLatency: 300,
};

// Load configuration from external file
async function loadConfig(): Promise<void> {
  try {
    const response = await fetch("./config.json");
    if (response.ok) {
      const loadedConfig = await response.json();
      config = { ...config, ...loadedConfig };
      logger.info("Configuration loaded from config.json");
    } else {
      logger.info("Using default configuration (config.json not found)");
    }
  } catch {
    logger.info("Using default configuration (error loading config.json)");
  }
}

// Get URL parameters
function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// Save connection settings to localStorage
function saveConnectionSettings(
  serverUrl: string,
  fingerprintUrl: string,
): void {
  try {
    localStorage.setItem("warp-player-serverUrl", serverUrl);
    localStorage.setItem("warp-player-fingerprintUrl", fingerprintUrl);
    logger.debug("Connection settings saved to localStorage");
  } catch (error) {
    logger.warn("Failed to save connection settings to localStorage:", error);
  }
}

// Load connection settings from localStorage
function loadConnectionSettings(): {
  serverUrl?: string;
  fingerprintUrl?: string;
} {
  try {
    const serverUrl = localStorage.getItem("warp-player-serverUrl");
    const fingerprintUrl = localStorage.getItem("warp-player-fingerprintUrl");
    return {
      serverUrl: serverUrl || undefined,
      fingerprintUrl: fingerprintUrl || undefined,
    };
  } catch (error) {
    logger.warn("Failed to load connection settings from localStorage:", error);
    return {};
  }
}

// Initialize the application when the DOM is loaded
document.addEventListener("DOMContentLoaded", async () => {
  // Set version in the header
  const appVersionEl = document.getElementById("appVersion");
  if (appVersionEl) {
    appVersionEl.textContent = `v${__APP_VERSION__}`;
  }

  // Load configuration first
  await loadConfig();
  // Get DOM elements
  serverUrlInput = document.getElementById("serverUrl") as HTMLInputElement;
  fingerprintUrlInput = document.getElementById(
    "fingerprintUrl",
  ) as HTMLInputElement;
  connectBtn = document.getElementById("connectBtn") as HTMLButtonElement;
  disconnectBtn = document.getElementById("disconnectBtn") as HTMLButtonElement;
  statusEl = document.getElementById("status") as HTMLDivElement;
  tracksContainerEl = document.getElementById(
    "tracks-container",
  ) as HTMLDivElement;
  minimalBufferInput = document.getElementById(
    "minimalBuffer",
  ) as HTMLInputElement;
  targetLatencyInput = document.getElementById(
    "targetLatency",
  ) as HTMLInputElement;
  logContainerEl = document.getElementById("logContainer") as HTMLDivElement;
  // Get log level select but don't store in variable to avoid linting error
  document.getElementById("logLevel");
  componentFilterSelect = document.getElementById(
    "componentFilter",
  ) as HTMLSelectElement;
  startBtn = document.getElementById("startBtn") as HTMLButtonElement;
  stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
  browserWarning = document.getElementById("browserWarning") as HTMLDivElement;

  // Setup logging
  setupLogging();

  // Load connection settings from multiple sources (priority: URL params > localStorage > config.json > defaults)
  const urlParams = getUrlParams();
  const savedSettings = loadConnectionSettings();

  // Server URL: URL param > localStorage > config.json > default
  const serverUrl =
    urlParams.get("serverUrl") ||
    savedSettings.serverUrl ||
    config.defaultServerUrl ||
    "https://moqlivemock.demo.osaas.io/moq";

  // Fingerprint URL: URL param > localStorage > config.json > empty
  const fingerprintUrl =
    urlParams.get("fingerprintUrl") ||
    savedSettings.fingerprintUrl ||
    config.fingerprintUrl ||
    "";

  // Apply to UI elements
  serverUrlInput.value = serverUrl;
  fingerprintUrlInput.value = fingerprintUrl;

  // Log source of configuration
  if (urlParams.get("serverUrl")) {
    logger.info("Server URL loaded from URL parameters");
  } else if (savedSettings.serverUrl) {
    logger.info("Server URL loaded from localStorage");
  } else if (config.defaultServerUrl) {
    logger.info("Server URL loaded from config.json");
  }

  if (config.minimalBuffer) {
    minimalBufferInput.value = config.minimalBuffer.toString();
  }
  if (config.targetLatency) {
    targetLatencyInput.value = config.targetLatency.toString();
  }

  // Add event listeners
  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);

  // Save connection settings when they change
  serverUrlInput.addEventListener("change", () => {
    saveConnectionSettings(serverUrlInput.value, fingerprintUrlInput.value);
  });
  fingerprintUrlInput.addEventListener("change", () => {
    saveConnectionSettings(serverUrlInput.value, fingerprintUrlInput.value);
  });

  // Check WebTransport support
  if (typeof WebTransport === "undefined") {
    logger.error(
      "WebTransport is NOT supported in this browser. Please use Chrome or Edge.",
    );
    connectBtn.disabled = true;
    startBtn.disabled = true;
    stopBtn.disabled = true;
    serverUrlInput.disabled = true;
    fingerprintUrlInput.disabled = true;
    minimalBufferInput.disabled = true;
    targetLatencyInput.disabled = true;

    // Show the browser warning
    browserWarning.classList.add("show");

    // Update status to show the issue
    statusEl.innerHTML = "<span>●</span> WebTransport Not Supported";
    statusEl.className = "status disconnected";

    // Don't create player instance if WebTransport is not supported
    return;
  } else {
    logger.info("WebTransport is supported in this browser.");
  }

  // Create the Player instance with the server URL
  player = new Player(
    serverUrlInput.value,
    tracksContainerEl,
    statusEl,
    legacyLogMessage,
    fingerprintUrlInput.value || undefined,
  );

  // Set connection state callback to manage button states
  player.setConnectionStateCallback((connected: boolean) => {
    if (connected) {
      startBtn.disabled = false;
      stopBtn.disabled = false;
    } else {
      startBtn.disabled = true;
      stopBtn.disabled = true;
    }
  });

  // Set initial buffer parameters from config or defaults
  const initialMinimalBuffer =
    parseInt(minimalBufferInput.value) || config.minimalBuffer || 200;
  const initialTargetLatency =
    parseInt(targetLatencyInput.value) || config.targetLatency || 300;
  player.setBufferParameters(initialMinimalBuffer, initialTargetLatency);

  // Add event listener for minimal buffer changes
  minimalBufferInput.addEventListener("change", () => {
    if (player) {
      const minBuffer = parseInt(minimalBufferInput.value) || 200;
      const targetLat = parseInt(targetLatencyInput.value) || 300;

      // Validate that target latency is greater than minimal buffer
      if (targetLat <= minBuffer) {
        targetLatencyInput.value = (minBuffer + 100).toString();
        logger.warn(
          `Target latency must be greater than minimal buffer. Adjusted to ${
            minBuffer + 100
          }ms`,
        );
      }

      player.setBufferParameters(minBuffer, parseInt(targetLatencyInput.value));
      logger.info(`Minimal buffer set to ${minBuffer}ms`);
    }
  });

  // Add event listener for target latency changes
  targetLatencyInput.addEventListener("change", () => {
    if (player) {
      const minBuffer = parseInt(minimalBufferInput.value) || 200;
      const targetLat = parseInt(targetLatencyInput.value) || 300;

      // Validate that target latency is greater than minimal buffer
      if (targetLat <= minBuffer) {
        targetLatencyInput.value = (minBuffer + 100).toString();
        logger.warn(
          `Target latency must be greater than minimal buffer. Adjusted to ${
            minBuffer + 100
          }ms`,
        );
      }

      player.setBufferParameters(minBuffer, parseInt(targetLatencyInput.value));
      logger.info(
        `Target latency set to ${parseInt(targetLatencyInput.value)}ms`,
      );
    }
  });

  logger.info("Browser UI initialized");
});

// Setup logging system and UI integration
function setupLogging() {
  // Enable event dispatching in the logger
  LoggerFactory.getInstance().setDispatchEvents(true);

  // Initialize with INFO level by default
  LoggerFactory.getInstance().setGlobalLogLevel(LogLevel.INFO);

  // Add default components to the filter dropdown
  addComponentToFilter("Browser");
  addComponentToFilter("Player");
  addComponentToFilter("Client");
  addComponentToFilter("Tracks");
  addComponentToFilter("TrackRegistry");
  addComponentToFilter("MediaBuffer");
  addComponentToFilter("MediaBuffer:video");
  addComponentToFilter("MediaBuffer:audio");
  addComponentToFilter("MediaSegmentBuffer");
  addComponentToFilter("MediaSegmentBuffer:video");
  addComponentToFilter("MediaSegmentBuffer:audio");
  addComponentToFilter("Main");
  addComponentToFilter("Control");
  addComponentToFilter("Setup");

  // Listen for log level changes from UI
  window.addEventListener("warp-log-level-change", (event: Event) => {
    const customEvent = event as CustomEvent;
    const level = customEvent.detail.level;
    setLogLevel(level);
  });

  // Listen for component filter changes
  componentFilterSelect.addEventListener("change", (_e) => {
    // This is handled in the UI display logic
  });

  // Create a component log level select
  const componentLevelSelectContainer = document.createElement("div");
  componentLevelSelectContainer.style.display = "flex";
  componentLevelSelectContainer.style.alignItems = "center";
  componentLevelSelectContainer.style.marginTop = "10px";
  componentLevelSelectContainer.style.marginBottom = "10px";
  componentLevelSelectContainer.style.flexWrap = "wrap";
  componentLevelSelectContainer.style.gap = "10px";

  const levelSelectLabel = document.createElement("label");
  levelSelectLabel.textContent = "Component Level:";
  levelSelectLabel.style.marginRight = "8px";
  levelSelectLabel.style.fontSize = "14px";

  const componentLevelSelect = document.createElement("select");
  componentLevelSelect.style.padding = "5px";
  componentLevelSelect.style.borderRadius = "4px";
  componentLevelSelect.style.border = "1px solid #ddd";

  // Add options to the level select
  const levelOptions = [
    { value: LogLevel.NONE.toString(), text: "None" },
    { value: LogLevel.FATAL.toString(), text: "Fatal" },
    { value: LogLevel.ERROR.toString(), text: "Error" },
    { value: LogLevel.WARNING.toString(), text: "Warning" },
    { value: LogLevel.INFO.toString(), text: "Info" },
    { value: LogLevel.DEBUG.toString(), text: "Debug" },
  ];

  levelOptions.forEach((option) => {
    const optionEl = document.createElement("option");
    optionEl.value = option.value;
    optionEl.textContent = option.text;
    if (option.value === LogLevel.DEBUG.toString()) {
      optionEl.selected = true;
    }
    componentLevelSelect.appendChild(optionEl);
  });

  // Add a button to set the selected level for the component
  const setComponentLevelBtn = document.createElement("button");
  setComponentLevelBtn.textContent = "Set Level For Component";
  setComponentLevelBtn.style.backgroundColor = "#3498db";
  setComponentLevelBtn.style.color = "white";
  setComponentLevelBtn.style.fontSize = "14px";
  setComponentLevelBtn.style.padding = "5px 12px";
  setComponentLevelBtn.style.border = "none";
  setComponentLevelBtn.style.borderRadius = "4px";
  setComponentLevelBtn.style.cursor = "pointer";

  // Add elements to the container
  componentLevelSelectContainer.appendChild(levelSelectLabel);
  componentLevelSelectContainer.appendChild(componentLevelSelect);
  componentLevelSelectContainer.appendChild(setComponentLevelBtn);

  // Insert the container after the component filter
  componentFilterSelect.parentNode?.parentNode?.insertBefore(
    componentLevelSelectContainer,
    componentFilterSelect.parentNode?.nextSibling,
  );

  // Add event listener for the set level button
  setComponentLevelBtn.addEventListener("click", () => {
    const selectedComponent = componentFilterSelect.value;
    if (selectedComponent !== "All") {
      // Get the selected log level
      const selectedLevel = parseInt(componentLevelSelect.value);
      // Set the log level for the specific component
      LoggerFactory.getInstance()
        .getLogger(selectedComponent)
        .setLevel(selectedLevel);
      logger.info(
        `Log level set to ${
          levelOptions.find((o) => parseInt(o.value) === selectedLevel)?.text
        } for component: ${selectedComponent}`,
      );
    } else {
      logger.warn(
        "Cannot set level: Please select a specific component first.",
      );
    }
  });

  // Add a reset button to restore all components to global log level
  const resetComponentLevelsBtn = document.createElement("button");
  resetComponentLevelsBtn.textContent = "Reset All Components";
  resetComponentLevelsBtn.style.backgroundColor = "#e74c3c";
  resetComponentLevelsBtn.style.color = "white";
  resetComponentLevelsBtn.style.fontSize = "14px";
  resetComponentLevelsBtn.style.padding = "5px 12px";
  resetComponentLevelsBtn.style.border = "none";
  resetComponentLevelsBtn.style.borderRadius = "4px";
  resetComponentLevelsBtn.style.marginLeft = "10px";
  resetComponentLevelsBtn.style.cursor = "pointer";

  // Insert the reset button after the debug button
  componentFilterSelect.parentNode?.appendChild(resetComponentLevelsBtn);

  // Add event listener for the reset button
  resetComponentLevelsBtn.addEventListener("click", () => {
    // Reset all loggers to use the global log level
    LoggerFactory.getInstance().resetComponentLevels();
    logger.info("All component log levels reset to global level");
  });

  // Create a container for the console-only option
  const consoleOnlyContainer = document.createElement("div");
  consoleOnlyContainer.style.display = "flex";
  consoleOnlyContainer.style.alignItems = "center";
  consoleOnlyContainer.style.marginTop = "15px";
  consoleOnlyContainer.style.marginBottom = "15px";

  // Create the checkbox for console-only mode
  const consoleOnlyCheckbox = document.createElement("input");
  consoleOnlyCheckbox.type = "checkbox";
  consoleOnlyCheckbox.id = "consoleOnlyMode";
  consoleOnlyCheckbox.style.marginRight = "8px";

  // Create the label for the checkbox
  const consoleOnlyLabel = document.createElement("label");
  consoleOnlyLabel.htmlFor = "consoleOnlyMode";
  consoleOnlyLabel.textContent = "Console Logs Only (no UI logs)";
  consoleOnlyLabel.style.fontSize = "14px";
  consoleOnlyLabel.style.fontWeight = "normal";
  consoleOnlyLabel.style.cursor = "pointer";

  // Add the checkbox and label to the container
  consoleOnlyContainer.appendChild(consoleOnlyCheckbox);
  consoleOnlyContainer.appendChild(consoleOnlyLabel);

  // Insert the container after the component level container
  const logSettingsParent = componentLevelSelectContainer.parentNode;
  logSettingsParent?.insertBefore(
    consoleOnlyContainer,
    componentLevelSelectContainer.nextSibling,
  );

  // Add event listener for the console-only checkbox
  consoleOnlyCheckbox.addEventListener("change", () => {
    const useConsoleOnly = consoleOnlyCheckbox.checked;
    LoggerFactory.getInstance().setUseConsoleOnly(useConsoleOnly);

    if (useConsoleOnly) {
      logger.info("UI logging disabled, console logging only");
    } else {
      logger.info("UI logging enabled");
    }
  });

  // Register for logger events
  registerLoggerEvents();
}

// Register for logger events
function registerLoggerEvents() {
  // Listen for log events
  window.addEventListener("warp-log", (event: Event) => {
    const customEvent = event as CustomEvent;
    const logData = customEvent.detail;

    displayLogEntry(
      logData.timestamp,
      logData.category,
      logData.level, // Changed from type to level to match what Logger.dispatchEvent sends
      logData.message,
    );
  });
}

// Update the log level
function setLogLevel(level: string) {
  // Convert string level to LogLevel enum
  let logLevel: LogLevel;
  switch (level) {
    case "NONE":
      logLevel = LogLevel.NONE;
      break;
    case "FATAL":
      logLevel = LogLevel.FATAL;
      break;
    case "ERROR":
      logLevel = LogLevel.ERROR;
      break;
    case "WARNING":
      logLevel = LogLevel.WARNING;
      break;
    case "INFO":
      logLevel = LogLevel.INFO;
      break;
    case "DEBUG":
      logLevel = LogLevel.DEBUG;
      break;
    default:
      logLevel = LogLevel.INFO;
  }

  // Set global log level
  LoggerFactory.getInstance().setGlobalLogLevel(logLevel);
  logger.info(`Global log level set to ${level}`);
}

// Add a component to the filter dropdown
function addComponentToFilter(component: string) {
  const option = document.createElement("option");
  option.value = component;
  option.textContent = component;
  componentFilterSelect.appendChild(option);
}

// Display a log entry in the UI
function displayLogEntry(
  timestamp: string,
  category: string,
  level: string,
  message: string,
) {
  // Skip if console-only mode is enabled
  if (LoggerFactory.getInstance().isConsoleOnly()) {
    return;
  }

  // Check if we should display based on component filter
  const selectedComponent = componentFilterSelect.value;
  if (selectedComponent !== "All" && selectedComponent !== category) {
    return;
  }

  // Create the log entry element
  const logEntry = document.createElement("div");
  logEntry.className = `log-entry ${level}`;

  // Format timestamp to be more readable
  const formattedTime = timestamp
    ? (() => {
        try {
          // If it's a number (performance.now() output)
          if (typeof timestamp === "number") {
            return `${(timestamp / 1000).toFixed(3)}s`;
          }
          // If it's a date string
          const date = new Date(timestamp);
          return (
            date.toLocaleTimeString() +
            "." +
            date.getMilliseconds().toString().padStart(3, "0")
          );
        } catch {
          return "unknown";
        }
      })()
    : "unknown";

  // Determine color based on log level
  let color;
  switch (level) {
    case "debug":
      color = "#888888";
      break;
    case "info":
      color = "#000000";
      break;
    case "warn":
      color = "#ff9900";
      break;
    case "error":
      color = "#ff0000";
      break;
    case "fatal":
      color = "#ff00ff";
      break;
    default:
      color = "#000000";
  }

  // Format the log entry
  logEntry.innerHTML = `
    <span style="color: #666;">[${formattedTime}]</span>
    <span style="color: #0066cc;">[${category}]</span>
    <span style="color: ${color};">[${
      level ? level.toUpperCase() : "INFO"
    }]</span>
    ${message}
  `;

  // Add to the log container
  logContainerEl.appendChild(logEntry);

  // Auto-scroll to the bottom
  logContainerEl.scrollTop = logContainerEl.scrollHeight;
}

// Connect to the MOQ server
async function connect() {
  if (!player) {
    logger.error("Player not initialized");
    return;
  }

  // Update the server URL from the input field
  player = new Player(
    serverUrlInput.value,
    tracksContainerEl,
    statusEl,
    legacyLogMessage,
    fingerprintUrlInput.value || undefined,
  );

  // Set connection state callback to manage button states
  player.setConnectionStateCallback((connected: boolean) => {
    if (connected) {
      startBtn.disabled = false;
      stopBtn.disabled = false;
    } else {
      startBtn.disabled = true;
      stopBtn.disabled = true;
    }
  });

  // Set buffer parameters from input fields
  const minimalBuffer = parseInt(minimalBufferInput.value) || 200;
  const targetLatency = parseInt(targetLatencyInput.value) || 300;
  player.setBufferParameters(minimalBuffer, targetLatency);

  // Disable connect button and enable disconnect button
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;

  // Clear previous tracks display
  tracksContainerEl.innerHTML = "";

  logger.info(`Connecting to server: ${serverUrlInput.value}`);

  try {
    // Connect to the server
    await player.connect();
    // Start/Stop buttons will be enabled by the connection state callback

    // Save connection settings to localStorage for future sessions
    saveConnectionSettings(serverUrlInput.value, fingerprintUrlInput.value);
  } catch (error) {
    logger.error(
      `Connection error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resetUI();
  }
}

// Disconnect from the MOQ server
function disconnect() {
  if (player) {
    logger.info("Disconnecting from server");
    player.disconnect();
    resetUI();
  }
}

// Reset the UI to its initial state
function resetUI() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = true;
}

// Legacy logger function for backward compatibility
function legacyLogMessage(
  message: string,
  type: "info" | "success" | "error" | "warn" = "info",
) {
  switch (type) {
    case "error":
      logger.error(message);
      break;
    case "warn":
      logger.warn(message);
      break;
    case "success":
      logger.info(`SUCCESS: ${message}`);
      break;
    default:
      logger.info(message);
  }
}
