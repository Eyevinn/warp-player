/**
 * Warp Player - Browser Entry Point
 * 
 * Handles the browser UI interactions and connects to the Player component
 * for MoQ/WARP streaming and MSE playback.
 */
import { Player } from './player';

// DOM Elements
let serverUrlInput: HTMLInputElement;
let connectBtn: HTMLButtonElement;
let disconnectBtn: HTMLButtonElement;
let statusEl: HTMLDivElement;
let tracksContainerEl: HTMLDivElement;
let bufferDurationInput: HTMLInputElement;

// Player instance
let player: Player | null = null;

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
  connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
  disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
  statusEl = document.getElementById('status') as HTMLDivElement;
  tracksContainerEl = document.getElementById('tracks-container') as HTMLDivElement;
  bufferDurationInput = document.getElementById('bufferDuration') as HTMLInputElement;

  // Add event listeners
  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);
  // UI logging disabled for performance
  
  // Check WebTransport support without logging
  if (typeof WebTransport === 'undefined') {
    // Only disable the connect button if WebTransport is not supported
    // No UI logging
    console.error('[Player] WebTransport is NOT supported in this browser. Please use Chrome or Edge.');
    connectBtn.disabled = true;
  }
  
  // Create the Player instance with the default server URL
  player = new Player(
    serverUrlInput.value,
    tracksContainerEl,
    statusEl,
    logMessage
  );
  
  // Set initial buffer duration from input field
  const initialBufferDuration = parseInt(bufferDurationInput.value) || 200;
  player.setTargetBufferDuration(initialBufferDuration);
  
  // Add event listener for buffer duration changes
  bufferDurationInput.addEventListener('change', () => {
    if (player) {
      const newDuration = parseInt(bufferDurationInput.value) || 200;
      player.setTargetBufferDuration(newDuration);
    }
  });
});

// Connect to the MoQ server
async function connect() {
  if (!player) {
    logMessage('Player not initialized', 'error');
    return;
  }
  
  // Update the server URL from the input field
  player = new Player(
    serverUrlInput.value,
    tracksContainerEl,
    statusEl,
    logMessage
  );
  
  // Set buffer duration from input field
  const bufferDuration = parseInt(bufferDurationInput.value) || 200;
  player.setTargetBufferDuration(bufferDuration);
  
  // Disable connect button and enable disconnect button
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  
  // Clear previous tracks display
  tracksContainerEl.innerHTML = '';
  
  try {
    // Connect to the server
    await player.connect();
  } catch (error) {
    logMessage(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error');
    resetUI();
  }
}

// Disconnect from the MoQ server
function disconnect() {
  if (player) {
    player.disconnect();
    resetUI();
  }
}

// Reset the UI to its initial state
function resetUI() {
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
}

// Logger function for debugging and UI feedback
function logMessage(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  switch (type) {
    case 'error':
      console.error(`[Player] ${message}`);
      break;
    case 'warn':
      console.warn(`[Player] ${message}`);
      break;
    case 'success':
      console.log(`[Player][SUCCESS] ${message}`);
      break;
    default:
      console.log(`[Player] ${message}`);
  }
}
