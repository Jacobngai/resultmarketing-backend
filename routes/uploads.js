/**
 * Uploads Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { supabase, uploadFile } = require('../services/supabase');
const { analyzeSpreadsheetData, extractNamecardText } = require('../services/ai');
const { authenticateToken, checkContactLimit } = require('../middleware/auth');
const { uploadRateLimit } = require('../middleware/rateLimit');

// Configure multer for memory storage
const storage = multer.memoryStorage();

const spreadsheetUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/csv',
    ];
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];

    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only Excel and CSV files are allowed.'));
    }
  },
});

const namecardUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'));
    }
  },
});

// In-memory job storage (use Redis in production)
const processingJobs = new Map();

/**
 * POST /api/uploads/spreadsheet
 * Upload and process Excel/CSV file
 */
router.post(
  '/spreadsheet',
  authenticateToken,
  uploadRateLimit,
  checkContactLimit(),
  spreadsheetUpload.single('file'),
  async (req, res) => {
    try {
      const userId = req.user.id;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded',
          },
        });
      }

      // Create job ID for tracking
      const jobId = uuidv4();

      // Initialize job status
      processingJobs.set(jobId, {
        status: 'processing',
        progress: 0,
        message: 'Starting file processing...',
        createdAt: new Date().toISOString(),
      });

      // Process file asynchronously
      processSpreadsheet(jobId, userId, req.file, req.contactLimit);

      return res.status(202).json({
        success: true,
        data: {
          jobId,
          message: 'File upload accepted. Processing started.',
          statusUrl: `/api/uploads/status/${jobId}`,
        },
        error: null,
      });
    } catch (err) {
      console.error('Spreadsheet upload error:', err);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'UPLOAD_ERROR',
          message: err.message || 'Failed to upload file',
        },
      });
    }
  }
);

/**
 * POST /api/uploads/spreadsheet/preview
 * Preview spreadsheet data before import
 */
router.post(
  '/spreadsheet/preview',
  authenticateToken,
  spreadsheetUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded',
          },
        });
      }

      // Parse spreadsheet
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      if (data.length < 2) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'EMPTY_FILE',
            message: 'File contains no data',
          },
        });
      }

      const headers = data[0];
      const rows = data.slice(1, 11); // First 10 rows for preview

      // Use AI to analyze and suggest column mappings
      const analysis = await analyzeSpreadsheetData(rows, headers);

      return res.status(200).json({
        success: true,
        data: {
          fileName: req.file.originalname,
          totalRows: data.length - 1,
          headers,
          sampleRows: rows,
          columnMappings: analysis.success ? analysis.analysis.columnMappings : null,
          dataQuality: analysis.success
            ? {
                issues: analysis.analysis.dataQualityIssues,
                suggestions: analysis.analysis.suggestedCleanups,
                confidence: analysis.analysis.confidence,
              }
            : null,
          sheets: workbook.SheetNames,
        },
        error: null,
      });
    } catch (err) {
      console.error('Spreadsheet preview error:', err);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'PREVIEW_ERROR',
          message: 'Failed to preview file',
        },
      });
    }
  }
);

/**
 * POST /api/uploads/spreadsheet/import
 * Import contacts from spreadsheet with custom mappings
 */
router.post(
  '/spreadsheet/import',
  authenticateToken,
  checkContactLimit(),
  spreadsheetUpload.single('file'),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { mappings, skipDuplicates = true, defaultCategory = 'Lead' } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded',
          },
        });
      }

      // Parse mappings from JSON string if needed
      const columnMappings = typeof mappings === 'string' ? JSON.parse(mappings) : mappings;

      // Parse spreadsheet
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      // Check contact limit
      const remaining = req.contactLimit?.remaining || 0;
      if (data.length > remaining) {
        return res.status(403).json({
          success: false,
          data: null,
          error: {
            code: 'CONTACT_LIMIT_EXCEEDED',
            message: `Can only import ${remaining} contacts. File contains ${data.length} rows.`,
          },
        });
      }

      // Transform data using mappings
      const contacts = [];
      const errors = [];
      const duplicates = [];

      for (let i = 0; i < data.length; i++) {
        const row = data[i];

        try {
          const contact = {
            user_id: userId,
            name: extractField(row, columnMappings.name) || 'Unknown',
            email: normalizeEmail(extractField(row, columnMappings.email)),
            phone: normalizePhone(extractField(row, columnMappings.phone)),
            company: extractField(row, columnMappings.company),
            position: extractField(row, columnMappings.position),
            industry: extractField(row, columnMappings.industry),
            category: defaultCategory,
            notes: extractField(row, columnMappings.notes),
            source: 'spreadsheet_import',
            status: 'active',
          };

          // Skip if no name
          if (contact.name === 'Unknown' && !contact.email && !contact.phone) {
            errors.push({ row: i + 2, reason: 'No identifiable information' });
            continue;
          }

          contacts.push(contact);
        } catch (err) {
          errors.push({ row: i + 2, reason: err.message });
        }
      }

      // Check for duplicates if requested
      if (skipDuplicates && contacts.length > 0) {
        const emails = contacts.filter((c) => c.email).map((c) => c.email);
        const phones = contacts.filter((c) => c.phone).map((c) => c.phone);

        const { data: existingContacts } = await supabase
          .from('contacts')
          .select('email, phone')
          .eq('user_id', userId)
          .or(
            `email.in.(${emails.join(',')}),phone.in.(${phones.join(',')})`
          );

        const existingEmails = new Set(existingContacts?.map((c) => c.email) || []);
        const existingPhones = new Set(existingContacts?.map((c) => c.phone) || []);

        const uniqueContacts = contacts.filter((c) => {
          const isDupe =
            (c.email && existingEmails.has(c.email)) ||
            (c.phone && existingPhones.has(c.phone));

          if (isDupe) {
            duplicates.push({ name: c.name, email: c.email, phone: c.phone });
          }

          return !isDupe;
        });

        contacts.length = 0;
        contacts.push(...uniqueContacts);
      }

      // Insert contacts
      let inserted = 0;
      if (contacts.length > 0) {
        const { data: insertedData, error: insertError } = await supabase
          .from('contacts')
          .insert(contacts)
          .select();

        if (insertError) {
          throw insertError;
        }

        inserted = insertedData.length;

        // Update contact count
        await supabase.rpc('increment_contact_count', {
          user_id: userId,
          amount: inserted,
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          imported: inserted,
          total: data.length,
          skipped: data.length - contacts.length - errors.length,
          duplicates: duplicates.length,
          errors: errors.length,
          errorDetails: errors.slice(0, 10),
          duplicateDetails: duplicates.slice(0, 10),
        },
        error: null,
      });
    } catch (err) {
      console.error('Spreadsheet import error:', err);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'IMPORT_ERROR',
          message: 'Failed to import contacts',
        },
      });
    }
  }
);

/**
 * POST /api/uploads/namecard
 * Upload and process business card image
 */
router.post(
  '/namecard',
  authenticateToken,
  uploadRateLimit,
  namecardUpload.single('image'),
  async (req, res) => {
    try {
      const userId = req.user.id;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'NO_FILE',
            message: 'No image uploaded',
          },
        });
      }

      // Create job ID
      const jobId = uuidv4();

      // Initialize job status
      processingJobs.set(jobId, {
        status: 'processing',
        progress: 0,
        message: 'Processing business card...',
        createdAt: new Date().toISOString(),
      });

      // Process namecard asynchronously
      processNamecard(jobId, userId, req.file);

      return res.status(202).json({
        success: true,
        data: {
          jobId,
          message: 'Image accepted. Processing started.',
          statusUrl: `/api/uploads/status/${jobId}`,
        },
        error: null,
      });
    } catch (err) {
      console.error('Namecard upload error:', err);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'UPLOAD_ERROR',
          message: 'Failed to upload image',
        },
      });
    }
  }
);

/**
 * POST /api/uploads/namecard/instant
 * Process namecard immediately (for smaller images)
 */
router.post(
  '/namecard/instant',
  authenticateToken,
  namecardUpload.single('image'),
  async (req, res) => {
    try {
      const userId = req.user.id;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'NO_FILE',
            message: 'No image uploaded',
          },
        });
      }

      // Convert to base64
      const imageBase64 = req.file.buffer.toString('base64');

      // Extract text using AI
      const result = await extractNamecardText(imageBase64);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'EXTRACTION_FAILED',
            message: result.error || 'Failed to extract text from image',
          },
        });
      }

      // Upload image to storage
      const imagePath = `namecards/${userId}/${uuidv4()}.jpg`;
      await uploadFile('namecards', imagePath, req.file.buffer, 'image/jpeg');

      return res.status(200).json({
        success: true,
        data: {
          extracted: result.structured,
          rawText: result.text,
          imagePath,
          confidence: result.structured?.confidence || 0,
        },
        error: null,
      });
    } catch (err) {
      console.error('Instant namecard error:', err);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Failed to process business card',
        },
      });
    }
  }
);

/**
 * GET /api/uploads/status/:jobId
 * Get processing job status
 */
router.get('/status/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = processingJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'JOB_NOT_FOUND',
          message: 'Processing job not found or expired',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        jobId,
        ...job,
      },
      error: null,
    });
  } catch (err) {
    console.error('Job status error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get job status',
      },
    });
  }
});

/**
 * Process spreadsheet in background
 */
async function processSpreadsheet(jobId, userId, file, contactLimit) {
  try {
    processingJobs.set(jobId, {
      status: 'processing',
      progress: 10,
      message: 'Reading file...',
      createdAt: new Date().toISOString(),
    });

    // Parse spreadsheet
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    processingJobs.set(jobId, {
      status: 'processing',
      progress: 30,
      message: `Found ${data.length} rows. Analyzing...`,
      createdAt: processingJobs.get(jobId).createdAt,
    });

    // Analyze with AI
    const headers = Object.keys(data[0] || {});
    const analysis = await analyzeSpreadsheetData(data.slice(0, 10), headers);

    if (!analysis.success) {
      processingJobs.set(jobId, {
        status: 'failed',
        progress: 100,
        message: 'Failed to analyze spreadsheet',
        error: analysis.error,
        createdAt: processingJobs.get(jobId).createdAt,
      });
      return;
    }

    processingJobs.set(jobId, {
      status: 'processing',
      progress: 50,
      message: 'Importing contacts...',
      createdAt: processingJobs.get(jobId).createdAt,
    });

    // Import contacts
    const mappings = analysis.analysis.columnMappings;
    const contacts = data.map((row) => ({
      user_id: userId,
      name: extractField(row, mappings.name) || 'Unknown',
      email: normalizeEmail(extractField(row, mappings.email)),
      phone: normalizePhone(extractField(row, mappings.phone)),
      company: extractField(row, mappings.company),
      position: extractField(row, mappings.position),
      industry: extractField(row, mappings.industry),
      category: 'Lead',
      source: 'spreadsheet_import',
      status: 'active',
    })).filter((c) => c.name !== 'Unknown' || c.email || c.phone);

    // Check limit
    const remaining = contactLimit?.remaining || Infinity;
    const toInsert = contacts.slice(0, remaining);

    if (toInsert.length > 0) {
      const { data: inserted } = await supabase
        .from('contacts')
        .insert(toInsert)
        .select();

      await supabase.rpc('increment_contact_count', {
        user_id: userId,
        amount: inserted.length,
      });

      processingJobs.set(jobId, {
        status: 'completed',
        progress: 100,
        message: `Successfully imported ${inserted.length} contacts`,
        result: {
          imported: inserted.length,
          total: data.length,
          skipped: data.length - toInsert.length,
        },
        createdAt: processingJobs.get(jobId).createdAt,
      });
    } else {
      processingJobs.set(jobId, {
        status: 'completed',
        progress: 100,
        message: 'No valid contacts found to import',
        result: { imported: 0, total: data.length },
        createdAt: processingJobs.get(jobId).createdAt,
      });
    }
  } catch (err) {
    console.error('Spreadsheet processing error:', err);
    processingJobs.set(jobId, {
      status: 'failed',
      progress: 100,
      message: 'Processing failed',
      error: err.message,
      createdAt: processingJobs.get(jobId)?.createdAt,
    });
  }
}

/**
 * Process namecard in background
 */
async function processNamecard(jobId, userId, file) {
  try {
    processingJobs.set(jobId, {
      status: 'processing',
      progress: 30,
      message: 'Extracting text from image...',
      createdAt: processingJobs.get(jobId).createdAt,
    });

    // Convert to base64
    const imageBase64 = file.buffer.toString('base64');

    // Extract text
    const result = await extractNamecardText(imageBase64);

    if (!result.success) {
      processingJobs.set(jobId, {
        status: 'failed',
        progress: 100,
        message: 'Failed to extract text',
        error: result.error,
        createdAt: processingJobs.get(jobId).createdAt,
      });
      return;
    }

    processingJobs.set(jobId, {
      status: 'processing',
      progress: 70,
      message: 'Saving contact...',
      createdAt: processingJobs.get(jobId).createdAt,
    });

    // Upload image
    const imagePath = `namecards/${userId}/${jobId}.jpg`;
    await uploadFile('namecards', imagePath, file.buffer, 'image/jpeg');

    // Create contact
    const extracted = result.structured;
    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({
        user_id: userId,
        name: extracted.name || 'Unknown',
        email: normalizeEmail(extracted.email),
        phone: normalizePhone(extracted.phone),
        company: extracted.company,
        position: extracted.position,
        address: extracted.address,
        notes: extracted.raw_text,
        source: 'namecard_scan',
        namecard_image: imagePath,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    await supabase.rpc('increment_contact_count', { user_id: userId });

    processingJobs.set(jobId, {
      status: 'completed',
      progress: 100,
      message: 'Contact created successfully',
      result: {
        contact,
        extracted,
        confidence: extracted.confidence,
      },
      createdAt: processingJobs.get(jobId).createdAt,
    });
  } catch (err) {
    console.error('Namecard processing error:', err);
    processingJobs.set(jobId, {
      status: 'failed',
      progress: 100,
      message: 'Processing failed',
      error: err.message,
      createdAt: processingJobs.get(jobId)?.createdAt,
    });
  }
}

/**
 * Helper to extract field from row
 */
function extractField(row, columnName) {
  if (!columnName) return null;
  const value = row[columnName];
  return value !== undefined ? String(value).trim() : null;
}

/**
 * Normalize email
 */
function normalizeEmail(email) {
  if (!email) return null;
  const cleaned = email.toLowerCase().trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : null;
}

/**
 * Normalize phone (Malaysian format)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/[^\d+]/g, '');

  // Convert local format to +60
  if (cleaned.startsWith('0')) {
    cleaned = '+60' + cleaned.slice(1);
  } else if (cleaned.startsWith('60') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  } else if (!cleaned.startsWith('+') && cleaned.length >= 9) {
    cleaned = '+60' + cleaned;
  }

  return cleaned.length >= 10 ? cleaned : null;
}

// Clean up old jobs periodically
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [jobId, job] of processingJobs) {
    if (new Date(job.createdAt) < oneHourAgo) {
      processingJobs.delete(jobId);
    }
  }
}, 15 * 60 * 1000); // Every 15 minutes

module.exports = router;
