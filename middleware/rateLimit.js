/**
 * Rate Limiting Middleware
 * ResultMarketing CRM
 */

const rateLimit = require('express-rate-limit');

/**
 * Global rate limit - applies to all routes
 */
const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
    },
  },
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise use IP
    return req.user?.id || req.ip;
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/api/health';
  },
});

/**
 * Strict rate limit for auth endpoints
 */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 OTP requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'AUTH_RATE_LIMIT',
      message: 'Too many authentication attempts. Please try again in 15 minutes.',
    },
  },
  keyGenerator: (req) => {
    // Rate limit by phone number or IP
    return req.body?.phone || req.ip;
  },
});

/**
 * Rate limit for OTP verification
 */
const otpVerifyRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // 5 verification attempts per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'OTP_RATE_LIMIT',
      message: 'Too many verification attempts. Please try again in 5 minutes.',
    },
  },
  keyGenerator: (req) => {
    return req.body?.phone || req.ip;
  },
});

/**
 * Rate limit for AI chat
 */
const chatRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 messages per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'CHAT_RATE_LIMIT',
      message: 'Too many chat messages. Please wait a moment.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Rate limit for file uploads
 */
const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 uploads per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'UPLOAD_RATE_LIMIT',
      message: 'Too many uploads. Please try again later.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Rate limit for contact creation
 */
const contactCreationRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 contacts per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'CONTACT_RATE_LIMIT',
      message: 'Too many contacts created. Please wait a moment.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Rate limit for search operations
 */
const searchRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 searches per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'SEARCH_RATE_LIMIT',
      message: 'Too many search requests. Please wait a moment.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Rate limit for payment endpoints
 */
const paymentRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 payment attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'PAYMENT_RATE_LIMIT',
      message: 'Too many payment attempts. Please try again later.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Rate limit for export operations
 */
const exportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 exports per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'EXPORT_RATE_LIMIT',
      message: 'Too many export requests. Please try again later.',
    },
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

/**
 * Dynamic rate limiter based on subscription plan
 */
function dynamicRateLimit(baseLimit = 100) {
  return (req, res, next) => {
    const plan = req.userProfile?.subscription_plan || 'free';
    const multipliers = {
      free: 1,
      trial: 1,
      base: 5,
      enterprise: 20,
    };

    const multiplier = multipliers[plan] || 1;
    const limit = baseLimit * multiplier;

    const limiter = rateLimit({
      windowMs: 1 * 60 * 1000,
      max: limit,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        data: null,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. ${plan === 'free' ? 'Upgrade for higher limits.' : 'Please wait.'}`,
        },
      },
      keyGenerator: () => req.user?.id || req.ip,
    });

    return limiter(req, res, next);
  };
}

/**
 * Sliding window rate limiter using Redis (if available)
 */
class SlidingWindowRateLimiter {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.windowMs = options.windowMs || 60000;
    this.max = options.max || 100;
    this.keyPrefix = options.keyPrefix || 'ratelimit:';
  }

  async isAllowed(key) {
    if (!this.redis) {
      return { allowed: true, remaining: this.max };
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;
    const redisKey = `${this.keyPrefix}${key}`;

    try {
      // Remove old entries
      await this.redis.zremrangebyscore(redisKey, 0, windowStart);

      // Count current entries
      const count = await this.redis.zcard(redisKey);

      if (count >= this.max) {
        return { allowed: false, remaining: 0 };
      }

      // Add new entry
      await this.redis.zadd(redisKey, now, `${now}-${Math.random()}`);
      await this.redis.expire(redisKey, Math.ceil(this.windowMs / 1000));

      return { allowed: true, remaining: this.max - count - 1 };
    } catch (err) {
      console.error('Rate limit error:', err);
      return { allowed: true, remaining: this.max };
    }
  }

  middleware() {
    return async (req, res, next) => {
      const key = req.user?.id || req.ip;
      const result = await this.isAllowed(key);

      res.setHeader('X-RateLimit-Limit', this.max);
      res.setHeader('X-RateLimit-Remaining', result.remaining);

      if (!result.allowed) {
        return res.status(429).json({
          success: false,
          data: null,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
          },
        });
      }

      next();
    };
  }
}

module.exports = {
  globalRateLimit,
  authRateLimit,
  otpVerifyRateLimit,
  chatRateLimit,
  uploadRateLimit,
  contactCreationRateLimit,
  searchRateLimit,
  paymentRateLimit,
  exportRateLimit,
  dynamicRateLimit,
  SlidingWindowRateLimiter,
};
