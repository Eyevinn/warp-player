import { Client } from './transport/client';

// DOM Elements
let serverUrlInput: HTMLInputElement;
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let statusEl: HTMLDivElement;
let logEl: HTMLDivElement;

// Client instance
let client: Client | null = null;
let connection: any = null;

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
  connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
  statusEl = document.getElementById('status') as HTMLDivElement;
  logEl = document.getElementById('log') as HTMLDivElement;

  // Add event listeners
  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);

  // Listen for custom log events from the MoQ modules
  window.addEventListener('moq-log', ((event: CustomEvent) => {
    const { type, message } = event.detail;
    logMessage(message, type);
  }) as EventListener);

  // Log WebTransport support
  if (typeof WebTransport !== 'undefined') {
    logMessage('WebTransport is supported in this browser.', 'info');
  } else {
    logMessage('WebTransport is NOT supported in this browser. Please use Chrome or Edge.', 'error');
    connectBtn.disabled = true;
  }
});

// Connect to the MoQ server
async function connect() {
  const serverUrl = serverUrlInput.value.trim();
  
  if (!serverUrl) {
    logMessage('Please enter a server URL', 'error');
    return;
  }

  try {
    // Disable connect button and enable disconnect button
    connectBtn.disabled = true;
    
    logMessage(`Connecting to ${serverUrl}...`, 'info');
    
    // Create and connect the client
    client = new Client({
      url: serverUrl,
    });
    
    connection = await client.connect();
    
    // Update UI
    disconnectBtn.disabled = false;
    statusEl.className = 'status connected';
    statusEl.textContent = 'Status: Connected';
    
    logMessage('Connected to MoQ server successfully!', 'success');
    
    // Handle connection closure
    connection.closed().then((error: Error) => {
      logMessage(`Connection closed: ${error.message}`, 'info');
      resetUI();
    }).catch((error: Error) => {
      logMessage(`Connection error: ${error.message}`, 'error');
      resetUI();
    });
    
  } catch (error) {
    logMessage(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error');
    resetUI();
  }
}

// Disconnect from the MoQ server
function disconnect() {
  if (connection) {
    logMessage('Disconnecting from server...', 'info');
    connection.close();
    connection = null;
    client = null;
    resetUI();
  }
}

// Reset the UI to its initial state
function resetUI() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  statusEl.className = 'status disconnected';
  statusEl.textContent = 'Status: Disconnected';
}

// Log a message to the UI
function logMessage(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'warn' ? 'error' : type}`; // Map 'warn' to 'error' class for styling
  
  // Add timestamp
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `${timestamp} - ${message}`;
  
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}
