/**
 * Authentication Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const {
  sendOTP,
  verifyOTP,
  signOut,
  upsertUserProfile,
  getUserProfile,
} = require('../services/supabase');
const { authenticateToken } = require('../middleware/auth');
const { authRateLimit, otpVerifyRateLimit } = require('../middleware/rateLimit');

/**
 * Validate Malaysian phone number
 */
function validateMalaysianPhone(phone) {
  // Remove all non-digit characters except +
  const cleaned = phone.replace(/[^\d+]/g, '');

  // Malaysian phone patterns
  const patterns = [
    /^\+60\d{9,10}$/, // +60 format
    /^60\d{9,10}$/, // 60 format (without +)
    /^0\d{9,10}$/, // Local format (01x-xxx xxxx)
  ];

  return patterns.some((p) => p.test(cleaned));
}

/**
 * Normalize phone to E.164 format
 */
function normalizePhone(phone) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Convert local format to +60
  if (cleaned.startsWith('0')) {
    cleaned = '+60' + cleaned.slice(1);
  }
  // Add + if starting with 60
  else if (cleaned.startsWith('60') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  // Ensure + prefix
  else if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

/**
 * POST /api/auth/send-otp
 * Send OTP to phone number
 */
router.post('/send-otp', authRateLimit, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_PHONE',
          message: 'Phone number is required',
        },
      });
    }

    // Validate phone format
    if (!validateMalaysianPhone(phone)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_PHONE',
          message: 'Invalid Malaysian phone number format',
        },
      });
    }

    // Normalize to E.164
    const normalizedPhone = normalizePhone(phone);

    // Send OTP via Supabase
    const result = await sendOTP(normalizedPhone);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'OTP_SEND_FAILED',
          message: result.error || 'Failed to send OTP',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'OTP sent successfully',
        phone: normalizedPhone,
        expiresIn: 60, // seconds
      },
      error: null,
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to send OTP',
      },
    });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify OTP and create session
 */
router.post('/verify-otp', otpVerifyRateLimit, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Phone number and OTP code are required',
        },
      });
    }

    // Validate OTP format (6 digits)
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_OTP',
          message: 'OTP must be 6 digits',
        },
      });
    }

    const normalizedPhone = normalizePhone(phone);

    // Verify OTP
    const result = await verifyOTP(normalizedPhone, code);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'VERIFICATION_FAILED',
          message: result.error || 'Invalid or expired OTP',
        },
      });
    }

    // Create or update user profile
    const profileResult = await upsertUserProfile(result.user.id, {
      phone: normalizedPhone,
      last_login: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: result.user.id,
          phone: normalizedPhone,
          createdAt: result.user.created_at,
        },
        session: {
          accessToken: result.session.access_token,
          refreshToken: result.session.refresh_token,
          expiresAt: result.session.expires_at,
          expiresIn: result.session.expires_in,
        },
        profile: profileResult.profile,
        isNewUser: !profileResult.profile?.name,
      },
      error: null,
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to verify OTP',
      },
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user profile
    const profileResult = await getUserProfile(userId);

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: req.user.id,
          phone: req.user.phone,
          email: req.user.email,
          createdAt: req.user.created_at,
        },
        profile: profileResult.profile || null,
        subscription: {
          status: profileResult.profile?.subscription_status || 'none',
          plan: profileResult.profile?.subscription_plan || null,
          expiresAt: profileResult.profile?.subscription_end_date || null,
        },
      },
      error: null,
    });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get user data',
      },
    });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, email, company, position, avatar_url, preferences } = req.body;

    // Validate email if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_EMAIL',
          message: 'Invalid email format',
        },
      });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (company !== undefined) updateData.company = company;
    if (position !== undefined) updateData.position = position;
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url;
    if (preferences !== undefined) updateData.preferences = preferences;

    const result = await upsertUserProfile(userId, updateData);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'UPDATE_FAILED',
          message: result.error || 'Failed to update profile',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        profile: result.profile,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update profile',
      },
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout current user
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const result = await signOut(req.token);

    if (!result.success) {
      // Still return success - token might already be invalid
      console.warn('Logout warning:', result.error);
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Logged out successfully',
      },
      error: null,
    });
  } catch (err) {
    console.error('Logout error:', err);
    // Return success anyway - user wants to logout
    return res.status(200).json({
      success: true,
      data: {
        message: 'Logged out',
      },
      error: null,
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_TOKEN',
          message: 'Refresh token is required',
        },
      });
    }

    // Use Supabase to refresh the session
    const { supabase } = require('../services/supabase');
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      return res.status(401).json({
        success: false,
        data: null,
        error: {
          code: 'REFRESH_FAILED',
          message: error.message || 'Failed to refresh session',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        session: {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt: data.session.expires_at,
          expiresIn: data.session.expires_in,
        },
      },
      error: null,
    });
  } catch (err) {
    console.error('Refresh token error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to refresh session',
      },
    });
  }
});

/**
 * DELETE /api/auth/account
 * Delete user account (GDPR compliance)
 */
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { confirmation } = req.body;

    if (confirmation !== 'DELETE') {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Please confirm deletion by sending { confirmation: "DELETE" }',
        },
      });
    }

    const { supabase } = require('../services/supabase');

    // Delete user data (contacts, interactions, etc.)
    await supabase.from('contacts').delete().eq('user_id', userId);
    await supabase.from('interactions').delete().eq('user_id', userId);
    await supabase.from('opportunities').delete().eq('user_id', userId);
    await supabase.from('reminders').delete().eq('user_id', userId);
    await supabase.from('chat_history').delete().eq('user_id', userId);
    await supabase.from('profiles').delete().eq('id', userId);

    // Delete user from auth
    const { error } = await supabase.auth.admin.deleteUser(userId);

    if (error) {
      console.error('Delete user error:', error);
      // Still return success - data was deleted
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Account deleted successfully',
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete account',
      },
    });
  }
});

module.exports = router;
