const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const requestData = JSON.parse(event.body);
    const { 
      items, 
      customerInfo, 
      deliveryMethod, 
      deliveryDate,
      deliveryAddress,
      totalAmount,
      subtotal,
      deliveryFee,
      rushFee
    } = requestData;

    console.log('Creating checkout session for manual approval');
    console.log(`Customer: ${customerInfo.name}, Total: $${totalAmount}`);

    // Create line items for Stripe
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: item.description || '',
        },
        unit_amount: Math.round(item.price * 100), // Convert to cents
      },
      quantity: item.quantity,
    }));

    // Add delivery fee if applicable
    if (deliveryFee && deliveryFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Delivery Fee',
            description: deliveryMethod === 'delivery' ? 'White glove delivery service' : 'Delivery service',
          },
          unit_amount: Math.round(deliveryFee * 100),
        },
        quantity: 1,
      });
    }

    // Add rush fee if applicable
    if (rushFee && rushFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Rush Order Fee',
            description: 'Expedited processing for orders within 24 hours',
          },
          unit_amount: Math.round(rushFee * 100),
        },
        quantity: 1,
      });
    }

    // Create the checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      
      // CRITICAL: ALL orders use manual capture for approval workflow
      payment_intent_data: {
        capture_method: 'manual',  // ← ALWAYS manual for ALL orders
        metadata: {
          orderType: 'rental',
          servicingBusiness: 'Kraus Tables & Chairs',
        },
      },
      
      // Session metadata for webhook to use
      metadata: {
        eventDate: deliveryDate,
        serviceType: deliveryMethod,
        customerName: customerInfo.name,
        customerEmail: customerInfo.email,
        customerPhone: customerInfo.phone,
        deliveryAddress: deliveryAddress ? JSON.stringify(deliveryAddress) : '',
        orderTotal: totalAmount.toString(),
        subtotal: subtotal.toString(),
        deliveryFee: deliveryFee ? deliveryFee.toString() : '0',
        rushFee: rushFee ? rushFee.toString() : '0',
      },
      
      line_items: lineItems,
      
      customer_email: customerInfo.email,
      
      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/full`,
      
      // Optional: Add customer phone if available
      ...(customerInfo.phone && {
        phone_number_collection: {
          enabled: false, // We already have it from the form
        }
      }),
    });

    console.log(`Checkout session created: ${session.id}`);
    console.log(`Payment Intent: ${session.payment_intent}`);
    console.log('Capture method: MANUAL (requires approval)');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        url: session.url,
        sessionId: session.id
      })
    };

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to create checkout session',
        details: error.message 
      })
    };
  }
};
