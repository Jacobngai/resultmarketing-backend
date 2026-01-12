/**
 * Supabase Client Configuration
 * ResultMarketing CRM
 */

const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables
if (!process.env.SUPABASE_URL) {
  console.warn('Warning: SUPABASE_URL not set');
}
if (!process.env.SUPABASE_SERVICE_KEY) {
  console.warn('Warning: SUPABASE_SERVICE_KEY not set');
}

// Create Supabase client with service role key (for server-side operations)
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: 'public',
    },
  }
);

// Create Supabase client with anon key (for client-side style operations)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || '',
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
    },
  }
);

/**
 * Send OTP to phone number via Supabase Auth
 * @param {string} phone - Phone number in E.164 format (e.g., +60123456789)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendOTP(phone) {
  try {
    const { data, error } = await supabase.auth.signInWithOtp({
      phone: phone,
      options: {
        channel: 'sms',
      },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Verify OTP code
 * @param {string} phone - Phone number in E.164 format
 * @param {string} token - OTP code
 * @returns {Promise<{success: boolean, session?: object, user?: object, error?: string}>}
 */
async function verifyOTP(phone, token) {
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      phone: phone,
      token: token,
      type: 'sms',
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      session: data.session,
      user: data.user,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get user by ID
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
async function getUserById(userId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get user by JWT token
 * @param {string} token - JWT access token
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
async function getUserByToken(token) {
  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sign out user
 * @param {string} token - JWT access token
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function signOut(token) {
  try {
    // Set the session first
    await supabase.auth.setSession({
      access_token: token,
      refresh_token: '',
    });

    const { error } = await supabase.auth.signOut();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Create or update user profile
 * @param {string} userId - User ID
 * @param {object} profileData - Profile data to upsert
 * @returns {Promise<{success: boolean, profile?: object, error?: string}>}
 */
async function upsertUserProfile(userId, profileData) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        ...profileData,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, profile: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get user profile
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, profile?: object, error?: string}>}
 */
async function getUserProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return { success: false, error: error.message };
    }

    return { success: true, profile: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Upload file to Supabase Storage
 * @param {string} bucket - Storage bucket name
 * @param {string} path - File path in bucket
 * @param {Buffer} file - File buffer
 * @param {string} contentType - MIME type
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function uploadFile(bucket, path, file, contentType) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        contentType,
        upsert: true,
      });

    if (error) {
      return { success: false, error: error.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(path);

    return { success: true, url: urlData.publicUrl, path: data.path };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete file from Supabase Storage
 * @param {string} bucket - Storage bucket name
 * @param {string} path - File path in bucket
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteFile(bucket, path) {
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([path]);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Update user profile (partial update)
 * @param {string} userId - User ID
 * @param {object} updates - Fields to update
 * @returns {Promise<{success: boolean, profile?: object, error?: string}>}
 */
async function updateUserProfile(userId, updates) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, profile: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Increment contact count for user
 * @param {string} userId - User ID
 * @param {number} count - Number to increment by (default 1)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function incrementContactCount(userId, count = 1) {
  try {
    const { error } = await supabase.rpc('increment_contact_count', {
      user_id: userId,
      increment_by: count,
    });

    if (error) {
      // Fallback to manual update if RPC doesn't exist
      const profile = await getUserProfile(userId);
      if (profile.success && profile.profile) {
        const newCount = (profile.profile.contact_count || 0) + count;
        return updateUserProfile(userId, { contact_count: newCount });
      }
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Decrement contact count for user
 * @param {string} userId - User ID
 * @param {number} count - Number to decrement by (default 1)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function decrementContactCount(userId, count = 1) {
  try {
    const { error } = await supabase.rpc('decrement_contact_count', {
      user_id: userId,
      decrement_by: count,
    });

    if (error) {
      // Fallback to manual update if RPC doesn't exist
      const profile = await getUserProfile(userId);
      if (profile.success && profile.profile) {
        const newCount = Math.max(0, (profile.profile.contact_count || 0) - count);
        return updateUserProfile(userId, { contact_count: newCount });
      }
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  supabase,
  supabaseAnon,
  sendOTP,
  verifyOTP,
  getUserById,
  getUserByToken,
  signOut,
  upsertUserProfile,
  getUserProfile,
  updateUserProfile,
  incrementContactCount,
  decrementContactCount,
  uploadFile,
  deleteFile,
};
