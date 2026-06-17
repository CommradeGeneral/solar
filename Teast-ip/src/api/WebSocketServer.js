/**
 * WebSocket Server
 * Provides real-time alarm updates to connected clients
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { getLogger } = require('../utils/Logger');

class WebSocketServer {
    constructor(options = {}) {
        this.options = {
            path: options.path || '/ws',
            heartbeatInterval: options.heartbeatInterval || 30000,
            clientTimeout: options.clientTimeout || 60000,
            maxClients: options.maxClients || 0, // 0 = unlimited
        };

        this.wss = null;
        this.clients = new Map(); // clientId -> client info
        this.logger = getLogger().getServiceLogger('WebSocketServer');
        this.heartbeatTimer = null;
        
        // Services (injected)
        this.alarmService = null;
    }

    /**
     * Initialize WebSocket server
     */
    initialize(httpServer, alarmService) {
        this.alarmService = alarmService;

        this.wss = new WebSocket.Server({
            server: httpServer,
            path: this.options.path,
        });

        this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));
        this.wss.on('error', (error) => {
            this.logger.error('WebSocket server error', { error: error.message });
        });

        // Subscribe to alarm events
        if (this.alarmService) {
            this.alarmService.on('alarmTriggered', (data) => this._broadcastAlarmEvent('ALARM_TRIGGERED', data));
            this.alarmService.on('alarmEnded', (data) => this._broadcastAlarmEvent('ALARM_ENDED', data));
            this.alarmService.on('alarmAcknowledged', (data) => this._broadcastAlarmEvent('ALARM_ACKNOWLEDGED', data));
        }

        // Start heartbeat
        this._startHeartbeat();

        this.logger.info('WebSocket server initialized', { path: this.options.path });
    }

    /**
     * Handle new WebSocket connection
     */
    _handleConnection(ws, req) {
        // Check max clients
        if (this.options.maxClients > 0 && this.clients.size >= this.options.maxClients) {
            this.logger.warn('Max WebSocket clients reached, rejecting connection');
            ws.close(1013, 'Maximum clients reached');
            return;
        }

        const clientId = uuidv4();
        const clientIp = req.socket.remoteAddress;
        
        const clientInfo = {
            id: clientId,
            ws: ws,
            ip: clientIp,
            connectedAt: new Date(),
            lastPing: Date.now(),
            subscriptions: new Set(['alarms']), // Default subscription
        };

        this.clients.set(clientId, clientInfo);
        ws.clientId = clientId;

        this.logger.info('WebSocket client connected', { clientId, ip: clientIp });

        // Setup event handlers
        ws.on('message', (data) => this._handleMessage(clientId, data));
        ws.on('close', (code, reason) => this._handleDisconnect(clientId, code, reason));
        ws.on('error', (error) => this._handleError(clientId, error));
        ws.on('pong', () => {
            const client = this.clients.get(clientId);
            if (client) client.lastPing = Date.now();
        });

        // Send welcome message with current active alarms
        this._sendToClient(clientId, {
            type: 'CONNECTED',
            clientId: clientId,
            timestamp: new Date().toISOString(),
            activeAlarms: this.alarmService?.getActiveAlarms() || [],
        });
    }

    /**
     * Handle incoming message from client
     */
    _handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;

        try {
            const message = JSON.parse(data.toString());
            this.logger.debug('WebSocket message received', { clientId, type: message.type });

            switch (message.type) {
                case 'PING':
                    this._sendToClient(clientId, { type: 'PONG', timestamp: Date.now() });
                    break;

                case 'SUBSCRIBE':
                    if (message.channels && Array.isArray(message.channels)) {
                        message.channels.forEach(ch => client.subscriptions.add(ch));
                        this._sendToClient(clientId, {
                            type: 'SUBSCRIBED',
                            channels: Array.from(client.subscriptions),
                        });
                    }
                    break;

                case 'UNSUBSCRIBE':
                    if (message.channels && Array.isArray(message.channels)) {
                        message.channels.forEach(ch => client.subscriptions.delete(ch));
                        this._sendToClient(clientId, {
                            type: 'UNSUBSCRIBED',
                            channels: Array.from(client.subscriptions),
                        });
                    }
                    break;

                case 'GET_ACTIVE_ALARMS':
                    this._sendToClient(clientId, {
                        type: 'ACTIVE_ALARMS',
                        alarms: this.alarmService?.getActiveAlarms() || [],
                        timestamp: new Date().toISOString(),
                    });
                    break;

                case 'ACKNOWLEDGE_ALARM':
                    this._handleAcknowledge(clientId, message);
                    break;

                default:
                    this.logger.debug('Unknown message type', { clientId, type: message.type });
            }
        } catch (error) {
            this.logger.warn('Failed to parse WebSocket message', { clientId, error: error.message });
            this._sendToClient(clientId, { type: 'ERROR', message: 'Invalid message format' });
        }
    }

    /**
     * Handle acknowledge alarm request
     */
    async _handleAcknowledge(clientId, message) {
        try {
            const { alarmType, tagId, user } = message;
            
            if (!alarmType || !tagId || !user) {
                this._sendToClient(clientId, {
                    type: 'ERROR',
                    message: 'alarmType, tagId, and user are required',
                });
                return;
            }

            const success = await this.alarmService?.acknowledgeAlarm(alarmType, tagId, user);
            
            this._sendToClient(clientId, {
                type: 'ACKNOWLEDGE_RESULT',
                success: success,
                alarmType,
                tagId,
            });
        } catch (error) {
            this._sendToClient(clientId, {
                type: 'ERROR',
                message: error.message,
            });
        }
    }

    /**
     * Handle client disconnect
     */
    _handleDisconnect(clientId, code, reason) {
        this.clients.delete(clientId);
        this.logger.info('WebSocket client disconnected', { clientId, code, reason: reason?.toString() });
    }

    /**
     * Handle client error
     */
    _handleError(clientId, error) {
        this.logger.error('WebSocket client error', { clientId, error: error.message });
    }

    /**
     * Send message to specific client
     */
    _sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;

        try {
            client.ws.send(JSON.stringify(data));
        } catch (error) {
            this.logger.warn('Failed to send message to client', { clientId, error: error.message });
        }
    }

    /**
     * Broadcast message to all clients
     */
    broadcast(data, channel = 'alarms') {
        const message = JSON.stringify(data);
        
        for (const [clientId, client] of this.clients) {
            if (client.ws.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) {
                try {
                    client.ws.send(message);
                } catch (error) {
                    this.logger.warn('Failed to broadcast to client', { clientId, error: error.message });
                }
            }
        }
    }

    /**
     * Broadcast alarm event
     */
    _broadcastAlarmEvent(eventType, data) {
        this.broadcast({
            type: eventType,
            timestamp: new Date().toISOString(),
            ...data,
        }, 'alarms');
    }

    /**
     * Start heartbeat check
     */
    _startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            
            for (const [clientId, client] of this.clients) {
                // Check for timeout
                if (now - client.lastPing > this.options.clientTimeout) {
                    this.logger.warn('WebSocket client timed out', { clientId });
                    client.ws.terminate();
                    this.clients.delete(clientId);
                    continue;
                }

                // Send ping
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            }
        }, this.options.heartbeatInterval);
    }

    /**
     * Stop heartbeat check
     */
    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Get connected clients info
     */
    getClientsInfo() {
        const info = [];
        for (const [clientId, client] of this.clients) {
            info.push({
                id: clientId,
                ip: client.ip,
                connectedAt: client.connectedAt,
                subscriptions: Array.from(client.subscriptions),
            });
        }
        return info;
    }

    /**
     * Get connected clients count
     */
    getClientCount() {
        return this.clients.size;
    }

    /**
     * Close all connections and stop server
     */
    close() {
        this._stopHeartbeat();

        // Close all client connections
        for (const [clientId, client] of this.clients) {
            client.ws.close(1001, 'Server shutting down');
        }
        this.clients.clear();

        // Close server
        if (this.wss) {
            this.wss.close(() => {
                this.logger.info('WebSocket server closed');
            });
        }
    }
}

module.exports = WebSocketServer;
