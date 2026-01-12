/**
 * Stripe Payment Service
 * ResultMarketing CRM
 */

const Stripe = require('stripe');

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

// Pricing configuration
const PRICING = {
  base: {
    id: 'base',
    name: 'Base Plan',
    priceRM: 299,
    interval: 'year',
    contactLimit: 250000,
    features: [
      'Up to 250,000 contacts',
      'AI-powered chat assistant',
      'Namecard scanning',
      'Spreadsheet import',
      'Push notifications',
      'Basic analytics',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise Plan',
    priceRM: 498,
    interval: 'year',
    contactLimit: 1000000,
    features: [
      'Up to 1,000,000 contacts',
      'Everything in Base plan',
      'Priority AI processing',
      'Advanced analytics',
      'API access',
      'Priority support',
    ],
  },
};

/**
 * Get pricing information
 * @returns {object} Pricing configuration
 */
function getPricing() {
  return PRICING;
}

/**
 * Create Stripe checkout session
 * @param {string} userId - User ID
 * @param {string} planId - Plan ID (base or enterprise)
 * @param {string} email - User email
 * @param {string} successUrl - Success redirect URL
 * @param {string} cancelUrl - Cancel redirect URL
 * @returns {Promise<{success: boolean, sessionUrl?: string, sessionId?: string, error?: string}>}
 */
async function createCheckoutSession(userId, planId, email, successUrl, cancelUrl) {
  try {
    const plan = PRICING[planId];
    if (!plan) {
      return { success: false, error: 'Invalid plan selected' };
    }

    // Get or create Stripe price
    const priceId = await getOrCreatePrice(plan);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card', 'fpx', 'grabpay'], // Malaysian payment methods
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId: userId,
        planId: planId,
      },
      subscription_data: {
        metadata: {
          userId: userId,
          planId: planId,
        },
      },
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      currency: 'myr',
    });

    return {
      success: true,
      sessionUrl: session.url,
      sessionId: session.id,
    };
  } catch (err) {
    console.error('Checkout session error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get or create Stripe price for plan
 * @param {object} plan - Plan configuration
 * @returns {Promise<string>} Price ID
 */
async function getOrCreatePrice(plan) {
  // Check environment for existing price IDs
  const envKey = `STRIPE_PRICE_${plan.id.toUpperCase()}`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }

  // Search for existing price
  const prices = await stripe.prices.search({
    query: `metadata['plan_id']:'${plan.id}' active:'true'`,
  });

  if (prices.data.length > 0) {
    return prices.data[0].id;
  }

  // Create product first
  const product = await stripe.products.create({
    name: `ResultMarketing ${plan.name}`,
    description: plan.features.join(', '),
    metadata: {
      plan_id: plan.id,
      contact_limit: plan.contactLimit.toString(),
    },
  });

  // Create price
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.priceRM * 100, // Convert to cents
    currency: 'myr',
    recurring: {
      interval: plan.interval,
    },
    metadata: {
      plan_id: plan.id,
    },
  });

  return price.id;
}

/**
 * Get subscription status for user
 * @param {string} userId - User ID
 * @returns {Promise<{success: boolean, subscription?: object, error?: string}>}
 */
async function getSubscriptionStatus(userId) {
  try {
    // Search for customer by metadata
    const customers = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
    });

    if (customers.data.length === 0) {
      return {
        success: true,
        subscription: {
          status: 'none',
          plan: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      };
    }

    const customer = customers.data[0];

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      // Check for past due or trialing
      const allSubs = await stripe.subscriptions.list({
        customer: customer.id,
        limit: 1,
      });

      if (allSubs.data.length > 0) {
        const sub = allSubs.data[0];
        return {
          success: true,
          subscription: {
            status: sub.status,
            plan: sub.metadata.planId || null,
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            subscriptionId: sub.id,
          },
        };
      }

      return {
        success: true,
        subscription: {
          status: 'none',
          plan: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      };
    }

    const subscription = subscriptions.data[0];
    const planId = subscription.metadata.planId || 'base';

    return {
      success: true,
      subscription: {
        status: subscription.status,
        plan: planId,
        planDetails: PRICING[planId],
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        subscriptionId: subscription.id,
        customerId: customer.id,
      },
    };
  } catch (err) {
    console.error('Get subscription error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Cancel subscription
 * @param {string} subscriptionId - Stripe subscription ID
 * @param {boolean} immediately - Cancel immediately or at period end
 * @returns {Promise<{success: boolean, subscription?: object, error?: string}>}
 */
async function cancelSubscription(subscriptionId, immediately = false) {
  try {
    let subscription;

    if (immediately) {
      subscription = await stripe.subscriptions.cancel(subscriptionId);
    } else {
      subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    }

    return {
      success: true,
      subscription: {
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        cancelAt: subscription.cancel_at
          ? new Date(subscription.cancel_at * 1000).toISOString()
          : null,
      },
    };
  } catch (err) {
    console.error('Cancel subscription error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Resume cancelled subscription
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<{success: boolean, subscription?: object, error?: string}>}
 */
async function resumeSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    return {
      success: true,
      subscription: {
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    };
  } catch (err) {
    console.error('Resume subscription error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Update subscription to different plan
 * @param {string} subscriptionId - Stripe subscription ID
 * @param {string} newPlanId - New plan ID
 * @returns {Promise<{success: boolean, subscription?: object, error?: string}>}
 */
async function updateSubscriptionPlan(subscriptionId, newPlanId) {
  try {
    const plan = PRICING[newPlanId];
    if (!plan) {
      return { success: false, error: 'Invalid plan' };
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = await getOrCreatePrice(plan);

    const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
      items: [
        {
          id: subscription.items.data[0].id,
          price: priceId,
        },
      ],
      metadata: {
        planId: newPlanId,
      },
      proration_behavior: 'create_prorations',
    });

    return {
      success: true,
      subscription: {
        status: updatedSubscription.status,
        plan: newPlanId,
        planDetails: plan,
        currentPeriodEnd: new Date(updatedSubscription.current_period_end * 1000).toISOString(),
      },
    };
  } catch (err) {
    console.error('Update subscription error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Create customer portal session
 * @param {string} customerId - Stripe customer ID
 * @param {string} returnUrl - Return URL after portal
 * @returns {Promise<{success: boolean, portalUrl?: string, error?: string}>}
 */
async function createPortalSession(customerId, returnUrl) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return { success: true, portalUrl: session.url };
  } catch (err) {
    console.error('Portal session error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Handle Stripe webhook event
 * @param {object} event - Stripe event object
 * @returns {Promise<{success: boolean, action?: string, data?: object, error?: string}>}
 */
async function handleWebhookEvent(event) {
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        return {
          success: true,
          action: 'subscription_created',
          data: {
            userId: session.metadata.userId,
            planId: session.metadata.planId,
            customerId: session.customer,
            subscriptionId: session.subscription,
          },
        };
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        return {
          success: true,
          action: 'subscription_updated',
          data: {
            subscriptionId: subscription.id,
            status: subscription.status,
            planId: subscription.metadata.planId,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          },
        };
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        return {
          success: true,
          action: 'subscription_cancelled',
          data: {
            subscriptionId: subscription.id,
            userId: subscription.metadata.userId,
          },
        };
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        return {
          success: true,
          action: 'payment_succeeded',
          data: {
            customerId: invoice.customer,
            amountPaid: invoice.amount_paid / 100,
            currency: invoice.currency.toUpperCase(),
          },
        };
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        return {
          success: true,
          action: 'payment_failed',
          data: {
            customerId: invoice.customer,
            subscriptionId: invoice.subscription,
          },
        };
      }

      default:
        return {
          success: true,
          action: 'unhandled',
          data: { type: event.type },
        };
    }
  } catch (err) {
    console.error('Webhook handling error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Verify webhook signature
 * @param {Buffer} payload - Raw request body
 * @param {string} signature - Stripe signature header
 * @returns {{success: boolean, event?: object, error?: string}}
 */
function verifyWebhookSignature(payload, signature) {
  try {
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    return { success: true, event };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
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
  PRICING,
};
