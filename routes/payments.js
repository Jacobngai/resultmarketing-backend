/**
 * Payments Routes
 * ResultMarketing CRM - Stripe Integration
 */

const express = require('express');
const router = express.Router();

const {
  stripe,
  getPricing,
  createCheckoutSession,
  getSubscriptionStatus,
  cancelSubscription,
  resumeSubscription,
  updateSubscriptionPlan,
  createPortalSession,
  handleWebhookEvent,
  verifyWebhookSignature,
} = require('../services/stripe');

const { authenticateToken } = require('../middleware/auth');
const { paymentRateLimit } = require('../middleware/rateLimit');
const { updateUserProfile } = require('../services/supabase');

// ===========================================
// PUBLIC ROUTES
// ===========================================

/**
 * GET /api/payments/pricing
 * Get available pricing plans
 */
router.get('/pricing', (req, res) => {
  try {
    const pricing = getPricing();

    res.json({
      success: true,
      data: {
        plans: Object.values(pricing),
        currency: 'MYR',
        paymentMethods: ['card', 'fpx', 'grabpay'],
      },
      error: null,
    });
  } catch (err) {
    console.error('Get pricing error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'PRICING_ERROR',
        message: 'Failed to get pricing information',
      },
    });
  }
});

/**
 * POST /api/payments/webhook
 * Handle Stripe webhook events
 * Note: This route must use raw body parser for signature verification
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_SIGNATURE',
          message: 'Missing Stripe signature',
        },
      });
    }

    // Verify signature
    const verification = verifyWebhookSignature(req.body, signature);

    if (!verification.success) {
      console.error('Webhook signature verification failed:', verification.error);
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Invalid webhook signature',
        },
      });
    }

    // Process event
    const result = await handleWebhookEvent(verification.event);

    if (!result.success) {
      console.error('Webhook handling failed:', result.error);
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'WEBHOOK_ERROR',
          message: result.error,
        },
      });
    }

    // Handle different actions
    try {
      switch (result.action) {
        case 'subscription_created':
          await updateUserProfile(result.data.userId, {
            subscription_status: 'active',
            subscription_plan: result.data.planId,
            stripe_customer_id: result.data.customerId,
            stripe_subscription_id: result.data.subscriptionId,
          });
          console.log(`Subscription created for user ${result.data.userId}`);
          break;

        case 'subscription_updated':
          // Find user by subscription ID and update
          console.log(`Subscription updated: ${result.data.subscriptionId}`);
          break;

        case 'subscription_cancelled':
          await updateUserProfile(result.data.userId, {
            subscription_status: 'cancelled',
            subscription_end_date: new Date().toISOString(),
          });
          console.log(`Subscription cancelled for user ${result.data.userId}`);
          break;

        case 'payment_succeeded':
          console.log(`Payment succeeded for customer ${result.data.customerId}: ${result.data.amountPaid} ${result.data.currency}`);
          break;

        case 'payment_failed':
          console.log(`Payment failed for subscription ${result.data.subscriptionId}`);
          // TODO: Send notification to user
          break;

        default:
          console.log(`Unhandled webhook action: ${result.action}`);
      }
    } catch (updateError) {
      console.error('Error processing webhook action:', updateError);
    }

    // Always return 200 to acknowledge receipt
    res.json({ received: true, action: result.action });
  }
);

// ===========================================
// AUTHENTICATED ROUTES
// ===========================================

/**
 * POST /api/payments/checkout
 * Create a checkout session for subscription
 */
router.post('/checkout', authenticateToken, paymentRateLimit, async (req, res) => {
  try {
    const { planId, successUrl, cancelUrl } = req.body;
    const userId = req.user.id;
    const email = req.user.email || req.userProfile?.email;

    if (!planId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_PLAN',
          message: 'Plan ID is required',
        },
      });
    }

    if (!['base', 'enterprise'].includes(planId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_PLAN',
          message: 'Invalid plan selected',
        },
      });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const finalSuccessUrl = successUrl || `${baseUrl}/settings?payment=success`;
    const finalCancelUrl = cancelUrl || `${baseUrl}/settings?payment=cancelled`;

    const result = await createCheckoutSession(
      userId,
      planId,
      email,
      finalSuccessUrl,
      finalCancelUrl
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'CHECKOUT_FAILED',
          message: result.error,
        },
      });
    }

    res.json({
      success: true,
      data: {
        sessionId: result.sessionId,
        sessionUrl: result.sessionUrl,
      },
      error: null,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'CHECKOUT_ERROR',
        message: 'Failed to create checkout session',
      },
    });
  }
});

/**
 * GET /api/payments/subscription
 * Get current subscription status
 */
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await getSubscriptionStatus(userId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'SUBSCRIPTION_ERROR',
          message: result.error,
        },
      });
    }

    res.json({
      success: true,
      data: result.subscription,
      error: null,
    });
  } catch (err) {
    console.error('Get subscription error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to get subscription status',
      },
    });
  }
});

/**
 * POST /api/payments/cancel
 * Cancel subscription
 */
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const { immediately = false } = req.body;
    const subscriptionId = req.userProfile?.stripe_subscription_id;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'No active subscription found',
        },
      });
    }

    const result = await cancelSubscription(subscriptionId, immediately);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'CANCEL_FAILED',
          message: result.error,
        },
      });
    }

    // Update user profile
    await updateUserProfile(req.user.id, {
      subscription_status: immediately ? 'cancelled' : 'cancelling',
    });

    res.json({
      success: true,
      data: {
        message: immediately
          ? 'Subscription cancelled immediately'
          : 'Subscription will cancel at period end',
        ...result.subscription,
      },
      error: null,
    });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'CANCEL_ERROR',
        message: 'Failed to cancel subscription',
      },
    });
  }
});

/**
 * POST /api/payments/resume
 * Resume cancelled subscription
 */
router.post('/resume', authenticateToken, async (req, res) => {
  try {
    const subscriptionId = req.userProfile?.stripe_subscription_id;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'No subscription found',
        },
      });
    }

    const result = await resumeSubscription(subscriptionId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'RESUME_FAILED',
          message: result.error,
        },
      });
    }

    // Update user profile
    await updateUserProfile(req.user.id, {
      subscription_status: 'active',
    });

    res.json({
      success: true,
      data: {
        message: 'Subscription resumed successfully',
        ...result.subscription,
      },
      error: null,
    });
  } catch (err) {
    console.error('Resume subscription error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'RESUME_ERROR',
        message: 'Failed to resume subscription',
      },
    });
  }
});

/**
 * POST /api/payments/upgrade
 * Upgrade or downgrade subscription plan
 */
router.post('/upgrade', authenticateToken, paymentRateLimit, async (req, res) => {
  try {
    const { planId } = req.body;
    const subscriptionId = req.userProfile?.stripe_subscription_id;

    if (!planId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_PLAN',
          message: 'Plan ID is required',
        },
      });
    }

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'No active subscription to upgrade',
        },
      });
    }

    const result = await updateSubscriptionPlan(subscriptionId, planId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'UPGRADE_FAILED',
          message: result.error,
        },
      });
    }

    // Update user profile
    await updateUserProfile(req.user.id, {
      subscription_plan: planId,
    });

    res.json({
      success: true,
      data: {
        message: `Successfully changed to ${planId} plan`,
        ...result.subscription,
      },
      error: null,
    });
  } catch (err) {
    console.error('Upgrade error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'UPGRADE_ERROR',
        message: 'Failed to upgrade subscription',
      },
    });
  }
});

/**
 * POST /api/payments/portal
 * Create customer portal session for managing billing
 */
router.post('/portal', authenticateToken, async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const customerId = req.userProfile?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'NO_CUSTOMER',
          message: 'No Stripe customer found. Please subscribe first.',
        },
      });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const finalReturnUrl = returnUrl || `${baseUrl}/settings`;

    const result = await createPortalSession(customerId, finalReturnUrl);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'PORTAL_FAILED',
          message: result.error,
        },
      });
    }

    res.json({
      success: true,
      data: {
        portalUrl: result.portalUrl,
      },
      error: null,
    });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'PORTAL_ERROR',
        message: 'Failed to create billing portal session',
      },
    });
  }
});

/**
 * GET /api/payments/invoices
 * Get user's invoice history
 */
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    const customerId = req.userProfile?.stripe_customer_id;

    if (!customerId) {
      return res.json({
        success: true,
        data: {
          invoices: [],
        },
        error: null,
      });
    }

    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 10,
    });

    const formattedInvoices = invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      amount: invoice.amount_paid / 100,
      currency: invoice.currency.toUpperCase(),
      status: invoice.status,
      date: new Date(invoice.created * 1000).toISOString(),
      pdfUrl: invoice.invoice_pdf,
      hostedUrl: invoice.hosted_invoice_url,
    }));

    res.json({
      success: true,
      data: {
        invoices: formattedInvoices,
      },
      error: null,
    });
  } catch (err) {
    console.error('Get invoices error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INVOICES_ERROR',
        message: 'Failed to get invoice history',
      },
    });
  }
});

module.exports = router;
