/**
 * Redis/Bull Queue Service
 * ResultMarketing CRM - Background Job Processing
 */

const Queue = require('bull');
const Redis = require('ioredis');

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
};

// Create Redis client for general caching
let redisClient = null;

/**
 * Initialize Redis client
 */
function getRedisClient() {
  if (!redisClient) {
    try {
      redisClient = new Redis(redisConfig);

      redisClient.on('connect', () => {
        console.log('Redis client connected');
      });

      redisClient.on('error', (err) => {
        console.error('Redis client error:', err);
      });

      redisClient.on('close', () => {
        console.log('Redis client disconnected');
      });
    } catch (err) {
      console.error('Failed to create Redis client:', err);
      return null;
    }
  }
  return redisClient;
}

// Queue instances
const queues = {};

/**
 * Create or get a queue instance
 * @param {string} queueName - Name of the queue
 * @returns {Queue} Bull queue instance
 */
function getQueue(queueName) {
  if (!queues[queueName]) {
    queues[queueName] = new Queue(queueName, {
      redis: redisConfig,
      defaultJobOptions: {
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 50, // Keep last 50 failed jobs
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });

    // Queue event listeners
    queues[queueName].on('completed', (job, result) => {
      console.log(`Job ${job.id} in ${queueName} completed`);
    });

    queues[queueName].on('failed', (job, err) => {
      console.error(`Job ${job.id} in ${queueName} failed:`, err.message);
    });

    queues[queueName].on('stalled', (job) => {
      console.warn(`Job ${job.id} in ${queueName} stalled`);
    });

    queues[queueName].on('error', (err) => {
      console.error(`Queue ${queueName} error:`, err);
    });
  }

  return queues[queueName];
}

// ===========================================
// QUEUE DEFINITIONS
// ===========================================

// Spreadsheet processing queue
const spreadsheetQueue = getQueue('spreadsheet-processing');

// Namecard OCR queue
const namecardQueue = getQueue('namecard-ocr');

// Email notification queue
const emailQueue = getQueue('email-notifications');

// Push notification queue
const pushNotificationQueue = getQueue('push-notifications');

// Reminder processing queue
const reminderQueue = getQueue('reminders');

// Analytics processing queue
const analyticsQueue = getQueue('analytics');

// ===========================================
// JOB PROCESSORS
// ===========================================

/**
 * Process spreadsheet import job
 */
spreadsheetQueue.process(async (job) => {
  const { userId, fileData, columnMapping, fileName } = job.data;

  try {
    console.log(`Processing spreadsheet for user ${userId}: ${fileName}`);

    // Update progress
    await job.progress(10);

    // Parse spreadsheet (implement actual parsing logic)
    const rows = fileData.rows || [];
    const totalRows = rows.length;

    // Process rows in batches
    const batchSize = 100;
    let processedCount = 0;
    const results = {
      total: totalRows,
      successful: 0,
      duplicates: 0,
      errors: 0,
      errorDetails: [],
    };

    for (let i = 0; i < totalRows; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      for (const row of batch) {
        try {
          // Process each row (implement actual import logic)
          results.successful++;
        } catch (err) {
          results.errors++;
          results.errorDetails.push({
            row: i + batch.indexOf(row),
            error: err.message,
          });
        }
        processedCount++;
      }

      // Update progress
      const progress = Math.floor((processedCount / totalRows) * 90) + 10;
      await job.progress(progress);
    }

    await job.progress(100);

    return {
      success: true,
      results,
    };
  } catch (err) {
    console.error(`Spreadsheet processing error for user ${userId}:`, err);
    throw err;
  }
});

/**
 * Process namecard OCR job
 */
namecardQueue.process(async (job) => {
  const { userId, imageData, imageName } = job.data;

  try {
    console.log(`Processing namecard for user ${userId}: ${imageName}`);

    await job.progress(20);

    // OCR processing would happen here
    // For now, return placeholder result
    const ocrResult = {
      text: '',
      confidence: 0,
      extractedFields: {},
    };

    await job.progress(100);

    return {
      success: true,
      result: ocrResult,
    };
  } catch (err) {
    console.error(`Namecard OCR error for user ${userId}:`, err);
    throw err;
  }
});

/**
 * Process email notification job
 */
emailQueue.process(async (job) => {
  const { to, subject, template, data } = job.data;

  try {
    console.log(`Sending email to ${to}: ${subject}`);

    // Email sending logic would go here
    // Using Resend or other email service

    return {
      success: true,
      sentTo: to,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Email sending error to ${to}:`, err);
    throw err;
  }
});

/**
 * Process push notification job
 */
pushNotificationQueue.process(async (job) => {
  const { userId, title, message, data } = job.data;

  try {
    console.log(`Sending push notification to user ${userId}: ${title}`);

    // OneSignal push notification logic would go here

    return {
      success: true,
      userId,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Push notification error for user ${userId}:`, err);
    throw err;
  }
});

/**
 * Process reminder job
 */
reminderQueue.process(async (job) => {
  const { reminderId, userId, contactId, type, message } = job.data;

  try {
    console.log(`Processing reminder ${reminderId} for user ${userId}`);

    // Send notification about reminder
    await pushNotificationQueue.add({
      userId,
      title: 'Follow-up Reminder',
      message,
      data: { type: 'reminder', reminderId, contactId },
    });

    return {
      success: true,
      reminderId,
      notified: true,
    };
  } catch (err) {
    console.error(`Reminder processing error ${reminderId}:`, err);
    throw err;
  }
});

/**
 * Process analytics job
 */
analyticsQueue.process(async (job) => {
  const { userId, type, startDate, endDate } = job.data;

  try {
    console.log(`Processing ${type} analytics for user ${userId}`);

    // Analytics calculation would go here

    return {
      success: true,
      type,
      processedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Analytics processing error for user ${userId}:`, err);
    throw err;
  }
});

// ===========================================
// JOB SCHEDULING FUNCTIONS
// ===========================================

/**
 * Add spreadsheet processing job
 */
async function addSpreadsheetJob(userId, fileData, columnMapping, fileName) {
  const job = await spreadsheetQueue.add(
    { userId, fileData, columnMapping, fileName },
    {
      priority: 2,
      delay: 0,
    }
  );
  return { jobId: job.id, queue: 'spreadsheet-processing' };
}

/**
 * Add namecard OCR job
 */
async function addNamecardJob(userId, imageData, imageName) {
  const job = await namecardQueue.add(
    { userId, imageData, imageName },
    {
      priority: 1,
      delay: 0,
    }
  );
  return { jobId: job.id, queue: 'namecard-ocr' };
}

/**
 * Add email notification job
 */
async function addEmailJob(to, subject, template, data, options = {}) {
  const job = await emailQueue.add(
    { to, subject, template, data },
    {
      priority: options.priority || 3,
      delay: options.delay || 0,
    }
  );
  return { jobId: job.id, queue: 'email-notifications' };
}

/**
 * Add push notification job
 */
async function addPushNotificationJob(userId, title, message, data = {}, options = {}) {
  const job = await pushNotificationQueue.add(
    { userId, title, message, data },
    {
      priority: options.priority || 2,
      delay: options.delay || 0,
    }
  );
  return { jobId: job.id, queue: 'push-notifications' };
}

/**
 * Schedule reminder job
 */
async function scheduleReminder(reminderId, userId, contactId, type, message, dueDate) {
  const delay = new Date(dueDate).getTime() - Date.now();

  if (delay < 0) {
    // If due date has passed, process immediately
    const job = await reminderQueue.add(
      { reminderId, userId, contactId, type, message },
      { priority: 1, delay: 0 }
    );
    return { jobId: job.id, queue: 'reminders', immediate: true };
  }

  const job = await reminderQueue.add(
    { reminderId, userId, contactId, type, message },
    {
      priority: 3,
      delay,
      jobId: `reminder-${reminderId}`, // Allow cancellation by ID
    }
  );
  return { jobId: job.id, queue: 'reminders', scheduledFor: dueDate };
}

/**
 * Cancel scheduled reminder
 */
async function cancelScheduledReminder(reminderId) {
  try {
    const job = await reminderQueue.getJob(`reminder-${reminderId}`);
    if (job) {
      await job.remove();
      return { success: true, message: 'Reminder cancelled' };
    }
    return { success: false, message: 'Reminder not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Add analytics job
 */
async function addAnalyticsJob(userId, type, startDate, endDate) {
  const job = await analyticsQueue.add(
    { userId, type, startDate, endDate },
    {
      priority: 5,
      delay: 0,
    }
  );
  return { jobId: job.id, queue: 'analytics' };
}

// ===========================================
// JOB STATUS FUNCTIONS
// ===========================================

/**
 * Get job status by ID and queue name
 */
async function getJobStatus(queueName, jobId) {
  try {
    const queue = getQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    const state = await job.getState();
    const progress = job.progress();

    return {
      success: true,
      job: {
        id: job.id,
        state,
        progress,
        data: job.data,
        result: job.returnvalue,
        failedReason: job.failedReason,
        createdAt: new Date(job.timestamp).toISOString(),
        processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get queue statistics
 */
async function getQueueStats(queueName) {
  try {
    const queue = getQueue(queueName);

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      success: true,
      stats: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===========================================
// CACHING FUNCTIONS
// ===========================================

/**
 * Set cache value
 */
async function setCache(key, value, ttlSeconds = 3600) {
  const client = getRedisClient();
  if (!client) return { success: false, error: 'Redis not available' };

  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get cache value
 */
async function getCache(key) {
  const client = getRedisClient();
  if (!client) return { success: false, error: 'Redis not available' };

  try {
    const value = await client.get(key);
    if (value) {
      return { success: true, value: JSON.parse(value) };
    }
    return { success: true, value: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete cache value
 */
async function deleteCache(key) {
  const client = getRedisClient();
  if (!client) return { success: false, error: 'Redis not available' };

  try {
    await client.del(key);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Clear cache by pattern
 */
async function clearCachePattern(pattern) {
  const client = getRedisClient();
  if (!client) return { success: false, error: 'Redis not available' };

  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    return { success: true, cleared: keys.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===========================================
// CLEANUP AND SHUTDOWN
// ===========================================

/**
 * Graceful shutdown of queues
 */
async function closeQueues() {
  console.log('Closing queue connections...');

  for (const [name, queue] of Object.entries(queues)) {
    try {
      await queue.close();
      console.log(`Queue ${name} closed`);
    } catch (err) {
      console.error(`Error closing queue ${name}:`, err);
    }
  }

  if (redisClient) {
    await redisClient.quit();
    console.log('Redis client closed');
  }
}

/**
 * Check Redis connection health
 */
async function checkRedisHealth() {
  const client = getRedisClient();
  if (!client) return { success: false, error: 'Redis not initialized' };

  try {
    const pong = await client.ping();
    return { success: pong === 'PONG', status: 'connected' };
  } catch (err) {
    return { success: false, error: err.message, status: 'disconnected' };
  }
}

module.exports = {
  // Queue management
  getQueue,
  getRedisClient,
  closeQueues,
  checkRedisHealth,

  // Job scheduling
  addSpreadsheetJob,
  addNamecardJob,
  addEmailJob,
  addPushNotificationJob,
  scheduleReminder,
  cancelScheduledReminder,
  addAnalyticsJob,

  // Job status
  getJobStatus,
  getQueueStats,

  // Caching
  setCache,
  getCache,
  deleteCache,
  clearCachePattern,

  // Queue instances (for direct access if needed)
  queues: {
    spreadsheet: spreadsheetQueue,
    namecard: namecardQueue,
    email: emailQueue,
    pushNotification: pushNotificationQueue,
    reminder: reminderQueue,
    analytics: analyticsQueue,
  },
};
