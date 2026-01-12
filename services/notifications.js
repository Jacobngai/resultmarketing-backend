/**
 * Notifications Service
 * ResultMarketing CRM - OneSignal Push Notifications
 */

const axios = require('axios');

// OneSignal configuration
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ONESIGNAL_API_URL = 'https://onesignal.com/api/v1';

// Check if OneSignal is configured
const isConfigured = () => {
  return !!(ONESIGNAL_APP_ID && ONESIGNAL_API_KEY);
};

// OneSignal API client
const oneSignalClient = axios.create({
  baseURL: ONESIGNAL_API_URL,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Basic ${ONESIGNAL_API_KEY}`,
  },
});

// ===========================================
// NOTIFICATION TEMPLATES
// ===========================================

const NOTIFICATION_TEMPLATES = {
  // Daily follow-up reminder
  dailyFollowUp: {
    title: 'Daily Follow-up Reminder',
    icon: 'calendar',
    priority: 'high',
    buildMessage: (data) =>
      `You have ${data.count} follow-ups scheduled for today. Start your day strong!`,
  },

  // Individual contact follow-up
  contactFollowUp: {
    title: 'Follow-up Reminder',
    icon: 'user',
    priority: 'high',
    buildMessage: (data) =>
      `Time to follow up with ${data.contactName}${data.company ? ` from ${data.company}` : ''}`,
  },

  // Data quality tip
  dataQualityTip: {
    title: 'Data Quality Tip',
    icon: 'lightbulb',
    priority: 'normal',
    buildMessage: (data) =>
      data.tip || 'Keep your contacts updated for better AI insights!',
  },

  // Missing contact info
  missingInfo: {
    title: 'Complete Your Contacts',
    icon: 'alert',
    priority: 'normal',
    buildMessage: (data) =>
      `${data.count} contacts are missing ${data.field}. Complete them for better engagement tracking.`,
  },

  // Success celebration
  successCelebration: {
    title: 'Great Job!',
    icon: 'trophy',
    priority: 'normal',
    buildMessage: (data) =>
      data.message || 'You\'re doing amazing! Keep up the great work!',
  },

  // New contact imported
  importComplete: {
    title: 'Import Complete',
    icon: 'check',
    priority: 'normal',
    buildMessage: (data) =>
      `Successfully imported ${data.count} contacts${data.duplicates ? ` (${data.duplicates} duplicates skipped)` : ''}.`,
  },

  // Payment success
  paymentSuccess: {
    title: 'Payment Successful',
    icon: 'credit-card',
    priority: 'high',
    buildMessage: (data) =>
      `Thank you! Your ${data.plan} subscription is now active.`,
  },

  // Subscription expiring
  subscriptionExpiring: {
    title: 'Subscription Expiring Soon',
    icon: 'alert',
    priority: 'high',
    buildMessage: (data) =>
      `Your subscription expires in ${data.daysLeft} days. Renew now to keep your data safe.`,
  },

  // Weekly summary
  weeklySummary: {
    title: 'Your Weekly Summary',
    icon: 'chart',
    priority: 'normal',
    buildMessage: (data) =>
      `This week: ${data.newContacts} new contacts, ${data.followUps} follow-ups completed. ${data.message || ''}`,
  },
};

// ===========================================
// CORE NOTIFICATION FUNCTIONS
// ===========================================

/**
 * Send push notification to specific user
 * @param {string} userId - External user ID in OneSignal
 * @param {string} title - Notification title
 * @param {string} message - Notification body
 * @param {object} data - Additional data to send with notification
 * @param {object} options - Additional options
 */
async function sendToUser(userId, title, message, data = {}, options = {}) {
  if (!isConfigured()) {
    console.log('[Notifications] OneSignal not configured, skipping notification');
    return { success: false, error: 'OneSignal not configured', skipped: true };
  }

  try {
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      include_external_user_ids: [userId],
      headings: { en: title },
      contents: { en: message },
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
      // PWA-specific settings
      web_push_topic: data.topic || 'general',
      priority: options.priority === 'high' ? 10 : 5,
      // TTL: 24 hours
      ttl: options.ttl || 86400,
    };

    // Add URL if provided
    if (options.url) {
      payload.url = options.url;
    }

    // Add action buttons if provided
    if (options.buttons && options.buttons.length > 0) {
      payload.web_buttons = options.buttons.map((btn) => ({
        id: btn.id,
        text: btn.text,
        url: btn.url,
      }));
    }

    const response = await oneSignalClient.post('/notifications', payload);

    return {
      success: true,
      notificationId: response.data.id,
      recipients: response.data.recipients,
    };
  } catch (err) {
    console.error('[Notifications] Send error:', err.response?.data || err.message);
    return {
      success: false,
      error: err.response?.data?.errors?.[0] || err.message,
    };
  }
}

/**
 * Send notification to multiple users
 */
async function sendToUsers(userIds, title, message, data = {}, options = {}) {
  if (!isConfigured()) {
    return { success: false, error: 'OneSignal not configured', skipped: true };
  }

  try {
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      include_external_user_ids: userIds,
      headings: { en: title },
      contents: { en: message },
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
      web_push_topic: data.topic || 'general',
      priority: options.priority === 'high' ? 10 : 5,
      ttl: options.ttl || 86400,
    };

    if (options.url) {
      payload.url = options.url;
    }

    const response = await oneSignalClient.post('/notifications', payload);

    return {
      success: true,
      notificationId: response.data.id,
      recipients: response.data.recipients,
    };
  } catch (err) {
    console.error('[Notifications] Send to users error:', err.response?.data || err.message);
    return {
      success: false,
      error: err.response?.data?.errors?.[0] || err.message,
    };
  }
}

/**
 * Send notification using template
 */
async function sendTemplateNotification(userId, templateName, templateData = {}, options = {}) {
  const template = NOTIFICATION_TEMPLATES[templateName];

  if (!template) {
    return { success: false, error: `Template '${templateName}' not found` };
  }

  const title = options.title || template.title;
  const message = template.buildMessage(templateData);

  return sendToUser(userId, title, message, {
    template: templateName,
    ...templateData,
  }, {
    priority: template.priority,
    ...options,
  });
}

// ===========================================
// SCHEDULED NOTIFICATION FUNCTIONS
// ===========================================

/**
 * Send daily follow-up reminders (call at 9 AM)
 */
async function sendDailyFollowUpReminders(userFollowUps) {
  const results = [];

  for (const { userId, followUps } of userFollowUps) {
    if (followUps.length === 0) continue;

    const result = await sendTemplateNotification(userId, 'dailyFollowUp', {
      count: followUps.length,
      contacts: followUps.slice(0, 3).map((f) => f.contactName),
    }, {
      url: '/contacts?filter=follow-up',
      buttons: [
        { id: 'view', text: 'View All', url: '/contacts?filter=follow-up' },
        { id: 'chat', text: 'Ask AI', url: '/chat' },
      ],
    });

    results.push({ userId, ...result });
  }

  return results;
}

/**
 * Send individual contact follow-up reminder
 */
async function sendContactFollowUpReminder(userId, contact, reminder) {
  return sendTemplateNotification(userId, 'contactFollowUp', {
    contactName: contact.name,
    company: contact.company,
    contactId: contact.id,
    reminderId: reminder.id,
    reason: reminder.notes,
  }, {
    url: `/contacts/${contact.id}`,
    buttons: [
      { id: 'call', text: 'Call Now', url: `tel:${contact.phone}` },
      { id: 'view', text: 'View Contact', url: `/contacts/${contact.id}` },
    ],
  });
}

/**
 * Send weekly summary notification
 */
async function sendWeeklySummary(userId, stats) {
  let message = '';

  if (stats.followUpRate >= 80) {
    message = 'Excellent follow-up rate this week!';
  } else if (stats.followUpRate >= 60) {
    message = 'Good progress! Keep it up!';
  } else {
    message = 'Try to complete more follow-ups next week.';
  }

  return sendTemplateNotification(userId, 'weeklySummary', {
    newContacts: stats.newContacts,
    followUps: stats.completedFollowUps,
    message,
  }, {
    url: '/dashboard',
  });
}

/**
 * Send import completion notification
 */
async function sendImportComplete(userId, importStats) {
  return sendTemplateNotification(userId, 'importComplete', {
    count: importStats.successful,
    duplicates: importStats.duplicates,
    errors: importStats.errors,
  }, {
    url: '/contacts',
  });
}

/**
 * Send data quality tip
 */
async function sendDataQualityTip(userId, tip) {
  return sendTemplateNotification(userId, 'dataQualityTip', {
    tip,
  });
}

/**
 * Send missing info nudge
 */
async function sendMissingInfoNudge(userId, field, count) {
  return sendTemplateNotification(userId, 'missingInfo', {
    field,
    count,
  }, {
    url: `/contacts?filter=missing-${field}`,
  });
}

/**
 * Send success celebration
 */
async function sendSuccessCelebration(userId, achievement) {
  const messages = {
    first_contact: 'You added your first contact! Great start!',
    ten_contacts: 'You\'ve reached 10 contacts! Keep growing your network!',
    hundred_contacts: 'Amazing! 100 contacts in your network!',
    first_followup: 'You completed your first follow-up!',
    streak_week: '7-day streak! You\'re on fire!',
    streak_month: '30-day streak! You\'re a networking champion!',
  };

  return sendTemplateNotification(userId, 'successCelebration', {
    achievement,
    message: messages[achievement] || 'Great job! Keep up the excellent work!',
  });
}

/**
 * Send subscription expiring warning
 */
async function sendSubscriptionExpiringWarning(userId, daysLeft) {
  return sendTemplateNotification(userId, 'subscriptionExpiring', {
    daysLeft,
  }, {
    priority: 'high',
    url: '/settings?tab=subscription',
    buttons: [
      { id: 'renew', text: 'Renew Now', url: '/settings?tab=subscription&action=renew' },
    ],
  });
}

/**
 * Send payment success notification
 */
async function sendPaymentSuccess(userId, plan) {
  return sendTemplateNotification(userId, 'paymentSuccess', {
    plan,
  }, {
    url: '/settings?tab=subscription',
  });
}

// ===========================================
// USER MANAGEMENT
// ===========================================

/**
 * Register user device with OneSignal
 */
async function registerUserDevice(userId, deviceInfo) {
  if (!isConfigured()) {
    return { success: false, error: 'OneSignal not configured', skipped: true };
  }

  // Note: Device registration is typically handled client-side
  // This function is for server-side tracking if needed
  console.log(`[Notifications] User ${userId} registered device:`, deviceInfo);

  return {
    success: true,
    message: 'Device registration tracked',
  };
}

/**
 * Update user notification preferences
 */
async function updateUserTags(userId, tags) {
  if (!isConfigured()) {
    return { success: false, error: 'OneSignal not configured', skipped: true };
  }

  try {
    // OneSignal uses external_user_id to identify users
    const response = await oneSignalClient.put(`/apps/${ONESIGNAL_APP_ID}/users/by/external_id/${userId}`, {
      tags,
    });

    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Notifications] Update tags error:', err.response?.data || err.message);
    return {
      success: false,
      error: err.response?.data?.errors?.[0] || err.message,
    };
  }
}

/**
 * Get notification history for user
 */
async function getNotificationHistory(limit = 10) {
  if (!isConfigured()) {
    return { success: false, error: 'OneSignal not configured', skipped: true };
  }

  try {
    const response = await oneSignalClient.get('/notifications', {
      params: {
        app_id: ONESIGNAL_APP_ID,
        limit,
      },
    });

    return {
      success: true,
      notifications: response.data.notifications,
      total: response.data.total_count,
    };
  } catch (err) {
    console.error('[Notifications] Get history error:', err.response?.data || err.message);
    return {
      success: false,
      error: err.response?.data?.errors?.[0] || err.message,
    };
  }
}

// ===========================================
// HEALTH CHECK
// ===========================================

/**
 * Check OneSignal connection health
 */
async function checkHealth() {
  if (!isConfigured()) {
    return { success: false, status: 'not_configured' };
  }

  try {
    const response = await oneSignalClient.get(`/apps/${ONESIGNAL_APP_ID}`);
    return {
      success: true,
      status: 'connected',
      appName: response.data.name,
      players: response.data.players,
    };
  } catch (err) {
    return {
      success: false,
      status: 'error',
      error: err.response?.data?.errors?.[0] || err.message,
    };
  }
}

module.exports = {
  // Core functions
  sendToUser,
  sendToUsers,
  sendTemplateNotification,
  isConfigured,

  // Scheduled notifications
  sendDailyFollowUpReminders,
  sendContactFollowUpReminder,
  sendWeeklySummary,
  sendImportComplete,
  sendDataQualityTip,
  sendMissingInfoNudge,
  sendSuccessCelebration,
  sendSubscriptionExpiringWarning,
  sendPaymentSuccess,

  // User management
  registerUserDevice,
  updateUserTags,
  getNotificationHistory,

  // Health check
  checkHealth,

  // Templates (for reference)
  NOTIFICATION_TEMPLATES,
};
