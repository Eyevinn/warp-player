import { Client } from './transport/client.js';

// Default server URL - can be changed via command line arguments
const DEFAULT_SERVER_URL = 'https://localhost:4443';

async function main() {
  console.log('MoQ Player 2 - WebTransport Client');
  
  // Get server URL from command line arguments or use default
  const serverUrl = process.argv[2] || DEFAULT_SERVER_URL;
  console.log(`Using server URL: ${serverUrl}`);
  
  try {
    // Create and connect the client
    const client = new Client({
      url: serverUrl,
      // You can add fingerprint URL here if needed for self-signed certificates
      // fingerprint: 'https://localhost:4443/fingerprint',
    });
    
    console.log('Connecting to MoQ server...');
    const connection = await client.connect();
    console.log('Connected to MoQ server successfully!');
    
    // Handle connection closure
    connection.closed().then((error) => {
      console.log('Connection closed:', error.message);
      process.exit(0);
    }).catch((error) => {
      console.error('Connection error:', error);
      process.exit(1);
    });
    
    // Keep the process running
    console.log('Press Ctrl+C to exit');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down...');
  process.exit(0);
});

// Start the application
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
