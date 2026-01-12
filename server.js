/**
 * ResultMarketing CRM - Main Express Server
 * Backend API for Malaysian Sales Professional PWA
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Import routes
const authRoutes = require('./routes/auth');
const contactsRoutes = require('./routes/contacts');
const interactionsRoutes = require('./routes/interactions');
const opportunitiesRoutes = require('./routes/opportunities');
const remindersRoutes = require('./routes/reminders');
const uploadsRoutes = require('./routes/uploads');
const chatRoutes = require('./routes/chat');
const paymentsRoutes = require('./routes/payments');

// Import middleware
const { globalRateLimit } = require('./middleware/rateLimit');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// ===========================================
// MIDDLEWARE SETUP
// ===========================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};
app.use(cors(corsOptions));

// Request logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global rate limiting
app.use(globalRateLimit);

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// ===========================================
// HEALTH CHECK ENDPOINTS
// ===========================================

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
    },
    error: null,
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'healthy',
      service: 'ResultMarketing API',
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
});

// ===========================================
// API ROUTES
// ===========================================

app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/interactions', interactionsRoutes);
app.use('/api/opportunities', opportunitiesRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/payments', paymentsRoutes);

// ===========================================
// 404 HANDLER
// ===========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    data: null,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// ===========================================
// GLOBAL ERROR HANDLER
// ===========================================

app.use((err, req, res, next) => {
  // Log error details
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      data: null,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message,
        details: err.details || null,
      },
    });
  }

  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({
      success: false,
      data: null,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
  }

  if (err.name === 'ForbiddenError' || err.status === 403) {
    return res.status(403).json({
      success: false,
      data: null,
      error: {
        code: 'FORBIDDEN',
        message: 'Access denied',
      },
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      data: null,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large',
      },
    });
  }

  // Stripe errors
  if (err.type === 'StripeError' || err.type?.startsWith('Stripe')) {
    return res.status(400).json({
      success: false,
      data: null,
      error: {
        code: 'PAYMENT_ERROR',
        message: err.message,
      },
    });
  }

  // Default error response
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    data: null,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
});

// ===========================================
// GRACEFUL SHUTDOWN
// ===========================================

const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// ===========================================
// START SERVER
// ===========================================

const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ResultMarketing CRM API Server                      ║
║   ─────────────────────────────────────────────────   ║
║                                                       ║
║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(38)}║
║   Port: ${String(PORT).padEnd(45)}║
║   Health: http://localhost:${PORT}/health${' '.repeat(20)}║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;
