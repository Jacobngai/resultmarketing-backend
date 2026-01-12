/**
 * Authentication Middleware
 * ResultMarketing CRM
 */

const jwt = require('jsonwebtoken');
const { getUserByToken, getUserProfile } = require('../services/supabase');

/**
 * Verify JWT token and attach user to request
 */
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        data: null,
        error: {
          code: 'NO_TOKEN',
          message: 'Authentication token required',
        },
      });
    }

    // Extract token from "Bearer <token>"
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_TOKEN_FORMAT',
          message: 'Invalid token format',
        },
      });
    }

    // Verify with Supabase
    const result = await getUserByToken(token);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_TOKEN',
          message: result.error || 'Invalid or expired token',
        },
      });
    }

    // Attach user to request
    req.user = result.user;
    req.token = token;

    // Optionally load user profile
    const profileResult = await getUserProfile(result.user.id);
    if (profileResult.success && profileResult.profile) {
      req.userProfile = profileResult.profile;
    }

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'AUTH_ERROR',
        message: 'Authentication error',
      },
    });
  }
}

/**
 * Optional authentication - doesn't fail if no token
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      req.user = null;
      return next();
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      req.user = null;
      return next();
    }

    const result = await getUserByToken(token);

    if (result.success) {
      req.user = result.user;
      req.token = token;

      const profileResult = await getUserProfile(result.user.id);
      if (profileResult.success && profileResult.profile) {
        req.userProfile = profileResult.profile;
      }
    } else {
      req.user = null;
    }

    next();
  } catch (err) {
    console.error('Optional auth error:', err);
    req.user = null;
    next();
  }
}

/**
 * Check if user has active subscription
 */
async function requireSubscription(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        data: null,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      });
    }

    const profile = req.userProfile;

    if (!profile) {
      return res.status(403).json({
        success: false,
        data: null,
        error: {
          code: 'NO_PROFILE',
          message: 'User profile not found',
        },
      });
    }

    // Check subscription status
    const validStatuses = ['active', 'trialing'];
    if (!validStatuses.includes(profile.subscription_status)) {
      return res.status(403).json({
        success: false,
        data: null,
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'Active subscription required',
          subscriptionStatus: profile.subscription_status || 'none',
        },
      });
    }

    // Check if subscription has expired
    if (profile.subscription_end_date) {
      const endDate = new Date(profile.subscription_end_date);
      if (endDate < new Date()) {
        return res.status(403).json({
          success: false,
          data: null,
          error: {
            code: 'SUBSCRIPTION_EXPIRED',
            message: 'Subscription has expired',
          },
        });
      }
    }

    next();
  } catch (err) {
    console.error('Subscription check error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'SUBSCRIPTION_CHECK_ERROR',
        message: 'Error checking subscription status',
      },
    });
  }
}

/**
 * Check contact limit based on subscription plan
 */
function checkContactLimit(limit) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          data: null,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
      }

      const profile = req.userProfile;
      const planLimits = {
        free: 50,
        trial: 50,
        base: 250000,
        enterprise: 1000000,
      };

      const userPlan = profile?.subscription_plan || 'free';
      const maxContacts = planLimits[userPlan] || planLimits.free;

      // Get current contact count from profile
      const currentCount = profile?.contact_count || 0;

      if (currentCount >= maxContacts) {
        return res.status(403).json({
          success: false,
          data: null,
          error: {
            code: 'CONTACT_LIMIT_REACHED',
            message: `Contact limit reached (${maxContacts} contacts)`,
            currentCount,
            limit: maxContacts,
            plan: userPlan,
          },
        });
      }

      req.contactLimit = {
        current: currentCount,
        max: maxContacts,
        remaining: maxContacts - currentCount,
      };

      next();
    } catch (err) {
      console.error('Contact limit check error:', err);
      next(err);
    }
  };
}

/**
 * Verify request is from allowed origin
 */
function verifyOrigin(req, res, next) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:5173'];

  const origin = req.headers.origin;

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({
      success: false,
      data: null,
      error: {
        code: 'FORBIDDEN_ORIGIN',
        message: 'Request from unauthorized origin',
      },
    });
  }

  next();
}

/**
 * Extract user ID from request (helper for routes)
 */
function getUserId(req) {
  return req.user?.id || null;
}

/**
 * Check if user owns resource
 */
function checkOwnership(resourceUserIdField = 'user_id') {
  return (req, res, next) => {
    const userId = getUserId(req);
    const resourceUserId = req.body?.[resourceUserIdField] || req.params?.userId;

    if (resourceUserId && resourceUserId !== userId) {
      return res.status(403).json({
        success: false,
        data: null,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied to this resource',
        },
      });
    }

    next();
  };
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireSubscription,
  checkContactLimit,
  verifyOrigin,
  getUserId,
  checkOwnership,
};
