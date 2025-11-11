const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event, context) => {
  // CORS headers for all responses
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const requestData = JSON.parse(event.body);
    console.log('Received checkout request:', JSON.stringify(requestData, null, 2));

    const { 
      customer,
      location,
      schedule,
      items,
      pricing,
      success_url,
      cancel_url
    } = requestData;

    // Validate required fields
    if (!customer || !customer.name) {
      throw new Error('Customer name is required');
    }
    if (!customer.email) {
      throw new Error('Customer email is required');
    }
    if (!items || items.length === 0) {
      throw new Error('At least one item is required');
    }
    if (!schedule || !schedule.dropoff_date) {
      throw new Error('Dropoff date is required');
    }

    console.log(`Creating checkout for: ${customer.name}`);
    console.log(`Dropoff: ${schedule.dropoff_date}, Pickup: ${schedule.pickup_date}`);

    // Create line items from the form items
    // Your items are: { sku: 'dark', qty: 25 }
    const lineItems = items.map(item => {
      // You'll need to add your actual pricing logic here
      // For now, using pricing from the payload
      const price = pricing?.subtotal ? Math.round((pricing.subtotal / items.length) * 100) : 1000; // fallback to $10
      
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.sku,
            description: `Quantity: ${item.qty}`,
          },
          unit_amount: price,
        },
        quantity: 1,
      };
    });

    // Add delivery/window fees if present
    if (pricing?.deliveryFee && pricing.deliveryFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Delivery & Service Fee',
            description: 'White glove delivery and setup',
          },
          unit_amount: Math.round(pricing.deliveryFee * 100),
        },
        quantity: 1,
      });
    }

    // Add window fees if present
    if (pricing?.windowFees && pricing.windowFees > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Delivery Window Fee',
            description: 'Scheduled delivery window',
          },
          unit_amount: Math.round(pricing.windowFees * 100),
        },
        quantity: 1,
      });
    }

    // Add extended rental fees if present
    if (pricing?.extendedFee && pricing.extendedFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Extended Rental Fee',
            description: 'Additional days beyond standard rental period',
          },
          unit_amount: Math.round(pricing.extendedFee * 100),
        },
        quantity: 1,
      });
    }

    // Add tax if present
    if (pricing?.tax && pricing.tax > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Tax',
            description: 'Sales tax',
          },
          unit_amount: Math.round(pricing.tax * 100),
        },
        quantity: 1,
      });
    }

    // Build delivery address string
    const deliveryAddressString = location ? 
      `${location.street}${location.address2 ? ', ' + location.address2 : ''}, ${location.city}, ${location.state} ${location.zip}` : 
      'Not provided';

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
        // Customer info
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone || '',
        
        // Location
        deliveryAddress: deliveryAddressString,
        deliveryNotes: location?.notes || '',
        
        // Schedule
        eventDate: schedule.dropoff_date,
        pickupDate: schedule.pickup_date,
        dropoffWindowType: schedule.dropoff_window_type || 'flex',
        dropoffWindowValue: schedule.dropoff_window_value || '',
        pickupWindowType: schedule.pickup_window_type || 'flex',
        pickupWindowValue: schedule.pickup_window_value || '',
        
        // Pricing
        orderTotal: pricing?.total ? pricing.total.toString() : '0',
        subtotal: pricing?.subtotal ? pricing.subtotal.toString() : '0',
        deliveryFee: pricing?.deliveryFee ? pricing.deliveryFee.toString() : '0',
        windowFees: pricing?.windowFees ? pricing.windowFees.toString() : '0',
        extendedFee: pricing?.extendedFee ? pricing.extendedFee.toString() : '0',
        tax: pricing?.tax ? pricing.tax.toString() : '0',
        
        // Items summary
        itemsSummary: JSON.stringify(items),
      },
      
      line_items: lineItems,
      
      customer_email: customer.email,
      
      success_url: success_url || `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${process.env.SITE_URL}/full`,
    });

    console.log(`Checkout session created: ${session.id}`);
    console.log(`Payment Intent: ${session.payment_intent}`);
    console.log('Capture method: MANUAL (requires approval)');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        url: session.url,
        sessionId: session.id
      })
    };

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to create checkout session',
        details: error.message 
      })
    };
  }
};
