import { ILogger, LoggerFactory } from '../logger';

import { Client } from './client';
import { Location, CtrlStream, Msg, Subscribe, FilterType, GroupOrder, Message } from './control';
import { Reader, KeyValuePair } from './stream';
import { TrackAliasRegistry } from './trackaliasregistry';

// Bigint versions of stream types for comparison
const FETCH_HEADER_BIGINT = 0x05n;
const SUBGROUP_HEADER_START_BIGINT = 0x08n;
const SUBGROUP_HEADER_END_BIGINT = 0x0Dn;

// Object received in a data stream
export interface MoQObject {
  trackAlias: bigint;
  location: Location;
  data: Uint8Array;
}

// Callback for receiving objects
export type ObjectCallback = (obj: MoQObject) => void;

// Tracks manager to handle incoming data streams
export class TracksManager {
  private wt: WebTransport;
  private objectCallbacks: Map<string, ObjectCallback[]> = new Map();
  private trackRegistry: TrackAliasRegistry = new TrackAliasRegistry();
  private controlStream: CtrlStream | null = null;
  private nextRequestId: bigint = 0n;
  private client: Client | null = null;
  private logger: ILogger;
  
  constructor(wt: WebTransport, controlStream?: CtrlStream, client?: Client) {
    this.wt = wt;
    this.controlStream = controlStream || null;
    this.client = client || null;
    this.logger = LoggerFactory.getInstance().getLogger('Tracks');
    this.startListeningForStreams();
  }
  
  /**
   * Set the control stream for sending control messages
   */
  public setControlStream(controlStream: CtrlStream): void {
    this.controlStream = controlStream;
    this.logger.debug('Control stream set for tracks manager');
  }
  
  /**
   * Set the client for message handling
   */
  public setClient(client: Client): void {
    this.client = client;
    this.logger.debug('Client set for tracks manager');
  }
  
  /**
   * Get the next request ID (even numbers for client requests)
   */
  private getNextRequestId(): bigint {
    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;
    return requestId;
  }
  
  /**
   * Start listening for incoming unidirectional streams
   */
  private async startListeningForStreams() {
    this.logger.info('Starting to listen for incoming unidirectional streams');
    
    try {
      const reader = this.wt.incomingUnidirectionalStreams.getReader();
      
      while (true) {
        const { value: stream, done } = await reader.read();
        
        if (done) {
          this.logger.debug('Incoming stream reader is done');
          break;
        }
        
        // Handle the stream in a separate task
        this.handleIncomingStream(stream).catch(error => {
          this.logger.error('Error handling incoming stream:', error);
        });
      }
    } catch (error) {
      this.logger.error('Error listening for incoming streams:', error);
    }
  }
  
  /**
   * Handle an incoming unidirectional stream
   */
  private async handleIncomingStream(stream: ReadableStream<Uint8Array>) {
    this.logger.debug('Received new incoming unidirectional stream');
    
    const reader = new Reader(new Uint8Array(), stream);
    
    try {
      // Read the stream type
      const streamType = await reader.u62();
      this.logger.debug(`Incoming Unidirectional Stream. Type: ${streamType}`);
      
      // Check if this is a SUBGROUP_HEADER stream
      if (streamType >= SUBGROUP_HEADER_START_BIGINT && streamType <= SUBGROUP_HEADER_END_BIGINT) {
        await this.handleSubgroupStream(reader, streamType);
      } else if (streamType === FETCH_HEADER_BIGINT) {
        // Handle FETCH_HEADER streams if needed
        this.logger.debug('Received FETCH_HEADER stream (not implemented yet)');
      } else {
        this.logger.warn(`Unknown stream type: ${streamType}`);
      }
    } catch (error) {
      this.logger.error('Error processing incoming stream:', error);
    } finally {
      reader.close();
    }
  }
  
  /**
   * Handle a SUBGROUP_HEADER stream according to section 9.4.2 of the MoQ transport draft
   */
  private async handleSubgroupStream(reader: Reader, streamType: bigint) {
    try {
      // Read the track alias
      const trackAlias = await reader.u62();
      
      // Read the group ID
      const groupId = await reader.u62();
      this.logger.debug(`Track alias: ${trackAlias} Group ID: ${groupId}`);
      
      // Determine subgroup ID based on the stream type
      // According to section 9.4.2, there are 6 defined Type values for SUBGROUP_HEADER (0x08-0x0D)
      let subgroupId: bigint | null = null;
      const hasExtensions = (streamType === 0x09n || streamType === 0x0Bn || streamType === 0x0Dn);
      
      if (streamType === 0x08n || streamType === 0x09n) {
        // Type 0x08-0x09: Subgroup ID is implicitly 0
        subgroupId = 0n;
        this.logger.debug(`Subgroup ID: ${subgroupId} (implicit)`); 
      } else if (streamType === 0x0An || streamType === 0x0Bn) {
        // Type 0x0A-0x0B: Subgroup ID is the first Object ID (will be set when first object is read)
        this.logger.debug('Subgroup ID will be set to the first Object ID');
      } else if (streamType === 0x0Cn || streamType === 0x0Dn) {
        // Type 0x0C-0x0D: Subgroup ID is explicitly provided
        subgroupId = await reader.u62();
        this.logger.debug(`Subgroup ID: ${subgroupId} (explicit)`);
      }
      
      // Read the Publisher Priority (as specified in the SUBGROUP_HEADER format)
      const publisherPriority = await reader.u8();
      this.logger.debug(`Publisher Priority: ${publisherPriority}`);
      
      // Process objects in the stream
      let isFirstObject = true;
      while (!(await reader.done())) {
        // Read the object ID
        const objectId = await reader.u62();
        this.logger.debug(`Object ID: ${objectId}`);
        
        // If this is the first object and subgroupId is null (types 0x0A-0x0B),
        // set the subgroupId to the objectId
        if (isFirstObject && subgroupId === null) {
          subgroupId = objectId;
          this.logger.debug(`Subgroup ID set to first Object ID: ${subgroupId}`);
        }
        isFirstObject = false;
        
        // Handle extension headers if present
        let extensions: Uint8Array | null = null;
        if (hasExtensions) {
          const extensionHeadersLength = await reader.u62();
          if (extensionHeadersLength > 0n) {
            // Convert bigint to number for reading bytes
            const extensionLength = Number(extensionHeadersLength);
            extensions = await reader.read(extensionLength);
            this.logger.debug(`Read ${extensionLength} bytes of extension headers`);
          }
        }
        
        // Read the object payload length
        const payloadLength = await reader.u62();
        this.logger.debug(`Object payload length: ${payloadLength}`);
        
        // Read object status if payload length is zero
        let objectStatus: bigint | null = null;
        if (payloadLength === 0n) {
          objectStatus = await reader.u62();
          this.logger.debug(`Object status: ${objectStatus}`);
        }
        
        // Read the object data
        const data = payloadLength > 0n ? await reader.read(Number(payloadLength)) : new Uint8Array();
        if (payloadLength > 0n) {
          this.logger.debug(`Read ${data.byteLength} bytes of object data`);
        }
        
        // Create the MoQObject with additional properties from the improved parsing
        const obj: MoQObject = {
          trackAlias,
          location: {
            group: groupId,
            object: objectId,
            // Include subgroup if available
            ...(subgroupId !== null && { subgroup: subgroupId })
          },
          data,
          // Include extensions if available
          ...(extensions !== null && { extensions }),
          // Include object status if available
          ...(objectStatus !== null && { status: objectStatus })
        };
        
        // Notify callbacks
        this.notifyObjectCallbacks(trackAlias, obj);
      }
      
      this.logger.debug(`Finished processing SUBGROUP_HEADER stream for track ${trackAlias}`);
    } catch (error) {
      this.logger.error('Error processing SUBGROUP_HEADER stream:', error);
    }
  }
  
  /**
   * Register a callback for receiving objects for a specific track
   */
  public registerObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    const key = trackAlias.toString();
    this.logger.info(`Registering object callback for track ${trackAlias} (key: ${key})`);
    
    // Register the callback in the track registry
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo) {
      this.trackRegistry.registerCallback(trackAlias, callback);
      this.logger.info(`Registered callback in track registry for ${trackInfo.namespace}:${trackInfo.trackName} (alias: ${trackAlias})`);
    }
    
    // Also register in the legacy objectCallbacks map for backward compatibility
    if (!this.objectCallbacks.has(key)) {
      this.logger.info(`Creating new callback array for track ${trackAlias}`);
      this.objectCallbacks.set(key, []);
    } else {
      const callbacks = this.objectCallbacks.get(key);
      if (callbacks) {
        this.logger.info(`Adding to existing callback array for track ${trackAlias}, current count: ${callbacks.length}`);
      }
    }
    
    const callbacksAfterAdd = this.objectCallbacks.get(key);
    if (!callbacksAfterAdd) {
      throw new Error(`Callback array for track ${trackAlias} not found despite being created`);
    }
    
    callbacksAfterAdd.push(callback);
    this.logger.info(`Successfully registered object callback for track ${trackAlias}, new count: ${callbacksAfterAdd.length}`);
    
    // Log all current callback keys for debugging
    const keys = Array.from(this.objectCallbacks.keys());
    this.logger.debug(`Current registered callback keys: ${keys.join(', ')}`);
  }
  
  /**
   * Unregister a callback for a specific track
   */
  public unregisterObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    const key = trackAlias.toString();
    
    // Unregister from the track registry
    this.trackRegistry.unregisterCallback(trackAlias, callback);
    
    // Also unregister from the legacy objectCallbacks map for backward compatibility
    if (this.objectCallbacks.has(key)) {
      const callbacks = this.objectCallbacks.get(key);
      if (!callbacks) {
        this.logger.warn(`Callback array for track ${trackAlias} was null despite being registered`);
        return;
      }
      const index = callbacks.indexOf(callback);
      
      if (index !== -1) {
        callbacks.splice(index, 1);
        this.logger.warn(`Unregistered object callback for track ${trackAlias} from legacy map`);
      }
      
      if (callbacks.length === 0) {
        this.objectCallbacks.delete(key);
      }
    }
    
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo) {
      this.logger.warn(`Unregistered callback for ${trackInfo.namespace}:${trackInfo.trackName} (alias: ${trackAlias})`);
    }
  }
  
  /**
   * Notify all callbacks registered for a track
   */
  private notifyObjectCallbacks(trackAlias: bigint, obj: MoQObject) {
    const key = trackAlias.toString();
    this.logger.debug(`Notifying callbacks for track ${trackAlias} (key: ${key}), object ID: ${obj.location.object}`);
    
    // First check the track registry for callbacks
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo && trackInfo.callbacks.length > 0) {
      this.logger.debug(`Found ${trackInfo.callbacks.length} callbacks in registry for track ${trackAlias}`);
      
      for (let i = 0; i < trackInfo.callbacks.length; i++) {
        try {
          this.logger.debug(`Executing registry callback #${i+1} for track ${trackAlias}`);
          trackInfo.callbacks[i](obj);
          this.logger.debug(`Successfully executed registry callback #${i+1} for track ${trackAlias}`);
        } catch (error) {
          this.logger.error(`Error in registry object callback #${i+1} for track ${trackAlias}:`, error);
        }
      }
    }
    
    // Also check the legacy objectCallbacks map for backward compatibility
    if (this.objectCallbacks.has(key)) {
      const callbacks = this.objectCallbacks.get(key);
      if (!callbacks) {
        this.logger.warn(`Callback array for track ${trackAlias} was null despite being registered`);
        return;
      }
      this.logger.debug(`Found ${callbacks.length} callbacks in legacy map for track ${trackAlias}`);
      
      for (let i = 0; i < callbacks.length; i++) {
        try {
          this.logger.debug(`Executing legacy callback #${i+1} for track ${trackAlias}`);
          callbacks[i](obj);
          this.logger.debug(`Successfully executed legacy callback #${i+1} for track ${trackAlias}`);
        } catch (error) {
          this.logger.error(`Error in legacy object callback #${i+1} for track ${trackAlias}:`, error);
        }
      }
    } else if (!trackInfo || trackInfo.callbacks.length === 0) {
      this.logger.warn(`No callbacks found for track ${trackAlias} (key: ${key})`);
      
      // Log all current callback keys for debugging
      const keys = Array.from(this.objectCallbacks.keys());
      this.logger.debug(`Current registered callback keys: ${keys.join(', ')}`);
    }
  }
  
  /**
   * Close the tracks manager and clean up resources
   */
  public close(): void {
    this.logger.debug('Closing tracks manager');
    // Clear all callbacks
    this.objectCallbacks.clear();
    this.trackRegistry.clear();
  }
  
  /**
   * Subscribe to a track by namespace and track name
   * Returns the track alias that can be used to unsubscribe later
   * @throws Error if control stream is not set
   */
  public async subscribeTrack(namespace: string, trackName: string, callback: ObjectCallback): Promise<bigint> {
    this.logger.info(`Subscribing to track ${namespace}:${trackName}`);
    
    if (!this.controlStream) {
      throw new Error('Cannot subscribe: Control stream not set');
    }
    
    if (!this.client) {
      throw new Error('Cannot subscribe: Client not set');
    }
    
    // Generate a request ID for this subscription
    const requestId = this.getNextRequestId();
    
    // Register the track in the registry and get its alias
    const trackAlias = this.trackRegistry.registerTrack(namespace, trackName, requestId);
    
    // Register the callback for this track alias
    this.trackRegistry.registerCallback(trackAlias, callback);
    
    // Create the subscribe message
    const subscribeMsg: Subscribe = {
      kind: Msg.Subscribe,
      requestId,
      trackAlias, // Include the track alias
      namespace: [namespace], // Namespace is an array of strings in the Subscribe interface
      name: trackName,
      subscriber_priority: 0, // Default priority
      group_order: GroupOrder.Publisher, // Use publisher's order by default
      forward: true, // Forward mode by default
      filterType: FilterType.NextGroupStart, // No filtering by default
      params: [] as KeyValuePair[]
    };
    
    this.logger.info(`Sending subscribe message for ${namespace}:${trackName} with alias ${trackAlias} and requestId ${requestId}`);
    
    try {
      // Create a Promise that will be resolved when we receive the SubscribeOk response
      const subscribePromise = new Promise<void>((resolve, reject) => {
        if (!this.client) {
          throw new Error('Cannot subscribe: Client not set');
        }
        
        // Register a handler for the SubscribeOk message with this request ID
        const unregisterHandler = this.client.registerMessageHandler(Msg.SubscribeOk, requestId, (_response: Message) => {
          this.logger.info(`Received SubscribeOk for ${namespace}:${trackName} with requestId ${requestId}`);
          resolve();
        });
        
        // Set a timeout to reject the promise if we don't receive a response in time
        const timeoutId = setTimeout(() => {
          unregisterHandler(); // Clean up the handler
          reject(new Error(`Subscribe timeout for ${namespace}:${trackName} with requestId ${requestId}`));
        }, 10000); // 10 second timeout
        
        // Also register a handler for SubscribeError
        if (this.client) {
          this.client.registerMessageHandler(Msg.SubscribeError, requestId, (response: Message) => {
            clearTimeout(timeoutId); // Clear the timeout
            unregisterHandler(); // Clean up the success handler
            this.logger.error(`Received SubscribeError for ${namespace}:${trackName}: ${JSON.stringify(response)}`);
            reject(new Error(`Subscribe failed: ${JSON.stringify(response)}`));
          });
        }
      });
      
      // Send the subscribe message
      await this.controlStream.send(subscribeMsg);
      
      // Wait for the subscribe response
      await subscribePromise;
      
      this.logger.info(`Successfully subscribed to track ${namespace}:${trackName} with alias ${trackAlias}`);
    } catch (error) {
      this.logger.error(`Error subscribing to track ${namespace}:${trackName}:`, error);
      // We'll keep the registration in the registry even if the subscription fails
      // This allows for retry attempts without creating new aliases
      throw error;
    }
    
    return trackAlias;
  }
  
  /**
   * Unsubscribe from a track by track alias
   * @param trackAlias The track alias to unsubscribe from
   * @throws Error if control stream is not set
   */
  public async unsubscribeTrack(trackAlias: bigint): Promise<void> {
    this.logger.info(`Unsubscribing from track with alias ${trackAlias}`);
    
    if (!this.controlStream) {
      throw new Error('Cannot unsubscribe: Control stream not set');
    }
    
    if (!this.client) {
      throw new Error('Cannot unsubscribe: Client not set');
    }
    
    // Get track info from registry if available
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (!trackInfo) {
      throw new Error(`Cannot unsubscribe: No track info found for alias ${trackAlias}`);
    }
    
    const trackDescription = `${trackInfo.namespace}:${trackInfo.trackName}`;
    
    // According to MoQ Transport draft 11, the unsubscribe message must use the same
    // request ID that was used in the original subscribe message
    const requestId = trackInfo.requestId;
    
    // Need to cast to Message type to satisfy the CtrlStream.send() parameter type
    const unsubscribeMsg = {
      kind: Msg.Unsubscribe,
      requestId
    } as Message;
    
    this.logger.info(`Sending unsubscribe message for track ${trackDescription} with original requestId ${requestId}`);
    
    try {
      // Create a Promise that will be resolved after a short delay
      // Note: The MoQ spec doesn't require an acknowledgment for unsubscribe messages,
      // so we'll just wait a short time to allow the message to be sent
      const unsubscribePromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 500); // 500ms delay to allow the message to be sent
      });
      
      // Send the unsubscribe message
      await this.controlStream.send(unsubscribeMsg);
      
      // Wait for the unsubscribe to complete (or timeout)
      await unsubscribePromise;
      
      // Unregister all callbacks for this track
      this.trackRegistry.unregisterAllCallbacks(trackAlias);
      
      this.logger.info(`Successfully unsubscribed from track ${trackDescription}`);
    } catch (error) {
      this.logger.error(`Error unsubscribing from track ${trackDescription}:`, error);
      throw error;
    }
  }
  
  /**
   * Get track information from track alias
   */
  public getTrackInfo(trackAlias: bigint): { namespace: string; trackName: string; trackAlias: bigint; callbacks: ObjectCallback[] } | undefined {
    return this.trackRegistry.getTrackInfoFromAlias(trackAlias);
  }
}