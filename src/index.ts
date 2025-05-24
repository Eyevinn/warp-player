import { LoggerFactory, LogLevel } from './logger';
import { Client } from './transport/client.js';

// Default server URL - can be changed via command line arguments
const DEFAULT_SERVER_URL = 'https://localhost:4443';

// Initialize logger
const logger = LoggerFactory.getInstance().getLogger('Main');
LoggerFactory.getInstance().setGlobalLogLevel(LogLevel.INFO);

async function main() {
  logger.info('WARP Player - Eyevinn MoQ WARP CMAF player');
  
  // Get server URL from command line arguments or use default
  const serverUrl = process.argv[2] || DEFAULT_SERVER_URL;
  logger.info(`Using server URL: ${serverUrl}`);
  
  try {
    // Create and connect the client
    const client = new Client({
      url: serverUrl,
      // You can add fingerprint URL here if needed for self-signed certificates
      // fingerprint: 'https://localhost:4443/fingerprint',
    });
    
    logger.info('Connecting to MoQ server...');
    const connection = await client.connect();
    logger.info('Connected to MoQ server successfully!');
    
    // Handle connection closure
    connection.closed().then((error) => {
      logger.info(`Connection closed: ${error.message}`);
      process.exit(0);
    }).catch((error) => {
      logger.error(`Connection error: ${error}`);
      process.exit(1);
    });
    
    // Keep the process running
    logger.info('Press Ctrl+C to exit');
    
  } catch (error) {
    logger.error(`Error: ${error}`);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  logger.info('Received SIGINT. Shutting down...');
  process.exit(0);
});

// Start the application
main().catch(error => {
  logger.error(`Unhandled error: ${error}`);
  process.exit(1);
});
