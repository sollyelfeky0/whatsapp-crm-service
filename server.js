const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

// Store active WhatsApp clients
const clients = new Map();

/**
 * Initialize WhatsApp client for a user
 */
async function initializeClient(userId) {
    try {
        // Create client with LocalAuth strategy
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `user_${userId}`,
                dataPath: process.env.SESSION_PATH || './sessions'
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        let qrCodeData = null;
        let isReady = false;

        // QR Code event
        client.on('qr', async (qr) => {
            console.log(`QR Code generated for user ${userId}`);
            qrCodeData = qr;
            
            // Generate QR code as base64 image
            const qrImage = await QRCode.toDataURL(qr);
            
            // Save to database
            await pool.execute(
                'UPDATE whatsapp_sessions SET qr_code = ?, status = ?, updated_at = NOW() WHERE user_id = ?',
                [qrImage, 'pending', userId]
            );
        });

        // Ready event
        client.on('ready', async () => {
            console.log(`WhatsApp client ready for user ${userId}`);
            isReady = true;
            
            const number = client.info.wid.user;
            
            // Update database
            await pool.execute(
                'UPDATE whatsapp_sessions SET status = ?, phone_number = ?, qr_code = NULL, last_activity = NOW(), updated_at = NOW() WHERE user_id = ?',
                ['connected', number, userId]
            );
        });

        // Authenticated event
        client.on('authenticated', () => {
            console.log(`User ${userId} authenticated successfully`);
        });

        // Disconnected event
        client.on('disconnected', async (reason) => {
            console.log(`User ${userId} disconnected: ${reason}`);
            
            await pool.execute(
                'UPDATE whatsapp_sessions SET status = ?, qr_code = NULL, updated_at = NOW() WHERE user_id = ?',
                ['disconnected', userId]
            );
            
            clients.delete(userId);
        });

        // Auth failure event
        client.on('auth_failure', async (msg) => {
            console.error(`Authentication failed for user ${userId}:`, msg);
            
            await pool.execute(
                'UPDATE whatsapp_sessions SET status = ?, qr_code = NULL, updated_at = NOW() WHERE user_id = ?',
                ['disconnected', userId]
            );
        });

        // Initialize the client
        await client.initialize();
        
        // Store client
        clients.set(userId, {
            client: client,
            isReady: () => isReady,
            getQR: () => qrCodeData
        });

        return { success: true, message: 'Client initialized' };
    } catch (error) {
        console.error(`Error initializing client for user ${userId}:`, error);
        return { success: false, message: error.message };
    }
}

/**
 * Get or create client for user
 */
function getClient(userId) {
    return clients.get(userId);
}

// ==================== API ENDPOINTS ====================

/**
 * POST /api/whatsapp/init-session
 * Initialize a new WhatsApp session for a user
 */
app.post('/api/whatsapp/init-session', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }

        // Check if session exists in database
        const [rows] = await pool.execute(
            'SELECT * FROM whatsapp_sessions WHERE user_id = ?',
            [userId]
        );

        if (rows.length === 0) {
            // Create new session record
            await pool.execute(
                'INSERT INTO whatsapp_sessions (user_id, status) VALUES (?, ?)',
                [userId, 'pending']
            );
        } else {
            // Update existing session
            await pool.execute(
                'UPDATE whatsapp_sessions SET status = ?, qr_code = NULL, updated_at = NOW() WHERE user_id = ?',
                ['pending', userId]
            );
        }

        // Check if client already exists
        if (clients.has(userId)) {
            const clientData = clients.get(userId);
            if (clientData.client && clientData.isReady()) {
                return res.json({ 
                    success: true, 
                    message: 'Already connected',
                    status: 'connected'
                });
            }
        }

        // Initialize new client
        const result = await initializeClient(userId);
        
        res.json(result);
    } catch (error) {
        console.error('Error in init-session:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/whatsapp/session-status/:userId
 * Get the current session status for a user
 */
app.get('/api/whatsapp/session-status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const [rows] = await pool.execute(
            'SELECT status, phone_number, qr_code, last_activity FROM whatsapp_sessions WHERE user_id = ?',
            [userId]
        );

        if (rows.length === 0) {
            return res.json({ 
                success: true, 
                status: 'not_initialized',
                message: 'No session found'
            });
        }

        const session = rows[0];
        
        res.json({
            success: true,
            status: session.status,
            phone_number: session.phone_number,
            qr_code: session.qr_code,
            last_activity: session.last_activity
        });
    } catch (error) {
        console.error('Error in session-status:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/whatsapp/send-message
 * Send a WhatsApp message
 */
app.post('/api/whatsapp/send-message', async (req, res) => {
    try {
        const { userId, phone, message, orderId } = req.body;

        if (!userId || !phone || !message) {
            return res.status(400).json({ 
                success: false, 
                message: 'userId, phone, and message are required' 
            });
        }

        // Get client
        const clientData = getClient(userId);
        
        if (!clientData || !clientData.isReady()) {
            return res.status(400).json({ 
                success: false, 
                message: 'WhatsApp not connected. Please scan QR code first.' 
            });
        }

        // Format phone number (remove + and add country code if needed)
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        
        // Add Egypt country code if not present
        if (!formattedPhone.startsWith('20') && formattedPhone.startsWith('01')) {
            formattedPhone = '2' + formattedPhone;
        }
        
        const chatId = formattedPhone + '@c.us';

        // Log message to database
        if (orderId) {
            await pool.execute(
                'INSERT INTO whatsapp_messages (order_id, customer_phone, message_content, status, sent_by_user_id) VALUES (?, ?, ?, ?, ?)',
                [orderId, phone, message, 'pending', userId]
            );
        }

        // Send message
        await clientData.client.sendMessage(chatId, message);

        // Update message status
        if (orderId) {
            await pool.execute(
                'UPDATE whatsapp_messages SET status = ?, sent_at = NOW() WHERE order_id = ? AND sent_by_user_id = ? ORDER BY id DESC LIMIT 1',
                ['sent', orderId, userId]
            );
        }

        // Update last activity
        await pool.execute(
            'UPDATE whatsapp_sessions SET last_activity = NOW() WHERE user_id = ?',
            [userId]
        );

        res.json({ 
            success: true, 
            message: 'Message sent successfully' 
        });
    } catch (error) {
        console.error('Error sending message:', error);
        
        // Update message status to failed
        if (req.body.orderId) {
            await pool.execute(
                'UPDATE whatsapp_messages SET status = ?, error_message = ? WHERE order_id = ? AND sent_by_user_id = ? ORDER BY id DESC LIMIT 1',
                ['failed', error.message, req.body.orderId, req.body.userId]
            );
        }
        
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/whatsapp/disconnect/:userId
 * Disconnect WhatsApp session
 */
app.post('/api/whatsapp/disconnect/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const clientData = getClient(userId);
        
        if (clientData && clientData.client) {
            await clientData.client.destroy();
            clients.delete(userId);
        }

        await pool.execute(
            'UPDATE whatsapp_sessions SET status = ?, qr_code = NULL, phone_number = NULL, updated_at = NOW() WHERE user_id = ?',
            ['disconnected', userId]
        );

        res.json({ 
            success: true, 
            message: 'Disconnected successfully' 
        });
    } catch (error) {
        console.error('Error disconnecting:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'WhatsApp service is running',
        activeClients: clients.size 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Service running on port ${PORT}`);
    console.log(`📱 Ready to handle WhatsApp integrations`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    // Disconnect all clients
    for (const [userId, clientData] of clients.entries()) {
        try {
            if (clientData.client) {
                await clientData.client.destroy();
            }
        } catch (error) {
            console.error(`Error disconnecting user ${userId}:`, error);
        }
    }
    
    await pool.end();
    process.exit(0);
});
